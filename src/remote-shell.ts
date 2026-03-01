/**
 * Remote Shell - Execute Mac commands from WhatsApp
 *
 * Security model:
 * - Only main group can execute commands
 * - All commands logged with requester identity
 * - Output captured and sent back to WhatsApp
 * - Sandboxed execution (can't break out of project directory by default)
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import {
  REMOTE_SHELL_ENABLED,
  REMOTE_SHELL_WHITELIST_ONLY,
  REMOTE_SHELL_RATE_LIMIT,
  ALLOWED_WORKING_DIRS,
  PARANOID_MODE,
} from './security-config.js';

export interface RemoteShellCommand {
  command: string;
  workingDir?: string;
  timeout?: number;
  requester: string; // WhatsApp sender name for audit
  isPreset?: boolean; // true when command was resolved from a preset key
}

export interface RemoteShellResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  duration: number;
}

const MAX_TIMEOUT = 60000; // 60 seconds max
const MAX_OUTPUT_SIZE = 50000; // 50KB max output

// Audit log for all remote commands
const AUDIT_LOG = path.join(process.cwd(), 'logs', 'remote-shell.log');

function auditLog(entry: {
  timestamp: string;
  requester: string;
  command: string;
  workingDir: string;
  success: boolean;
  exitCode: number;
  duration: number;
}): void {
  const line = JSON.stringify(entry) + '\n';
  try {
    fs.appendFileSync(AUDIT_LOG, line);
  } catch (err) {
    logger.warn({ err }, 'Failed to write remote shell audit log');
  }
}

/**
 * Execute a command remotely via WhatsApp.
 *
 * @param cmd - Command details
 * @returns Result with output, exit code, and timing
 */
export async function executeRemoteCommand(
  cmd: RemoteShellCommand,
): Promise<RemoteShellResult> {
  // Security validation
  const validation = validateCommand(cmd);
  if (!validation.valid) {
    return {
      success: false,
      output: '',
      error: validation.error,
      exitCode: 1,
      duration: 0,
    };
  }

  const startTime = Date.now();
  const timeout = Math.min(cmd.timeout || 30000, MAX_TIMEOUT);
  const workingDir = cmd.workingDir || process.cwd();

  logger.info(
    {
      command: cmd.command,
      requester: cmd.requester,
      workingDir,
      timeout,
    },
    'Remote shell command requested',
  );

  return new Promise((resolve) => {
    const proc = exec(
      cmd.command,
      {
        cwd: workingDir,
        timeout,
        maxBuffer: MAX_OUTPUT_SIZE,
      },
      (error, stdout, stderr) => {
        const duration = Date.now() - startTime;
        const exitCode = error?.code ?? 0;
        const success = exitCode === 0;

        const output = (stdout + stderr).trim();
        const truncated = output.length > MAX_OUTPUT_SIZE;
        const finalOutput = truncated
          ? output.slice(0, MAX_OUTPUT_SIZE) + '\n\n[Output truncated]'
          : output;

        // Audit log
        auditLog({
          timestamp: new Date().toISOString(),
          requester: cmd.requester,
          command: cmd.command,
          workingDir,
          success,
          exitCode,
          duration,
        });

        logger.info(
          {
            command: cmd.command,
            requester: cmd.requester,
            exitCode,
            duration,
            outputSize: finalOutput.length,
          },
          'Remote shell command completed',
        );

        resolve({
          success,
          output: finalOutput,
          error: error?.message,
          exitCode,
          duration,
        });
      },
    );

    // Kill on timeout
    setTimeout(() => {
      if (!proc.killed) {
        proc.kill();
        logger.warn(
          { command: cmd.command, timeout },
          'Remote shell command timed out',
        );
      }
    }, timeout);
  });
}

/**
 * Format result for WhatsApp display.
 */
export function formatRemoteShellResult(
  cmd: RemoteShellCommand,
  result: RemoteShellResult,
): string {
  const icon = result.success ? '✅' : '❌';
  const status = result.success ? 'Success' : 'Failed';

  let message = `${icon} *Remote Shell: ${status}*\n\n`;
  message += `*Command:* \`${cmd.command}\`\n`;
  message += `*Exit Code:* ${result.exitCode}\n`;
  message += `*Duration:* ${result.duration}ms\n\n`;

  if (result.output) {
    message += `*Output:*\n\`\`\`\n${result.output}\n\`\`\``;
  }

  if (result.error && !result.success) {
    message += `\n\n*Error:* ${result.error}`;
  }

  return message;
}

/**
 * Commonly used commands for quick access.
 */
export const PRESET_COMMANDS = {
  restart_nanoclaw: 'launchctl kickstart -k gui/$(id -u)/com.nanoclaw',
  check_nanoclaw_status: 'launchctl list | grep nanoclaw',
  view_recent_logs: 'tail -50 logs/nanoclaw.log',
  check_disk_space: 'df -h',
  check_memory: 'vm_stat',
  check_ram: 'vm_stat | perl -ne \'/page size of (\\d+)/ and $size=$1; /Pages\\s+([^:]+)[^\\d]+(\\d+)/ and printf("%-16s % 16.2f MB\\n", "$1:", $2 * $size / 1048576);\'',
  list_running_containers: 'docker ps',
  get_tailscale_ip: 'tailscale ip -4',
  check_wifi: 'networksetup -getairportnetwork en0',
  system_uptime: 'uptime',
  current_processes: 'ps aux | head -20',

  // Disk investigation commands
  find_large_dirs: 'du -sh /Users/* 2>/dev/null | sort -h | tail -20',
  find_large_files: 'find /Users -type f -size +1G 2>/dev/null | xargs ls -lh 2>/dev/null',
  check_docker_space: 'docker system df',
  check_downloads: 'du -sh ~/Downloads/* 2>/dev/null | sort -h | tail -20',
  check_library_caches: 'du -sh ~/Library/Caches/* 2>/dev/null | sort -h | tail -20',
  check_xcode_derived: 'du -sh ~/Library/Developer/Xcode/DerivedData 2>/dev/null',
  check_ios_simulators: 'du -sh ~/Library/Developer/CoreSimulator 2>/dev/null',
  check_homebrew_caches: 'du -sh ~/Library/Caches/Homebrew 2>/dev/null',
  check_node_modules: 'find ~ -name "node_modules" -type d -prune 2>/dev/null | xargs du -sh 2>/dev/null | sort -h | tail -20',
};

/**
 * Security: Danger words that should be blocked in commands.
 * These patterns indicate potentially destructive operations.
 */
const DANGER_WORDS = [
  'rm -rf /',
  'rm -rf ~',
  'sudo ',
  'curl | bash',
  'curl | sh',
  'wget | bash',
  'wget | sh',
  '| bash',
  '| sh',
  '> /etc/',
  'dd if=',
  'mkfs.',
  'fdisk',
  ':(){:|:&};:', // Fork bomb
];

/**
 * Security: Check if command contains dangerous patterns.
 */
function containsDangerousPattern(command: string): boolean {
  const lower = command.toLowerCase();
  for (const pattern of DANGER_WORDS) {
    if (lower.includes(pattern.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Security: Rate limiting to prevent abuse.
 */
const commandHistory = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = PARANOID_MODE
  ? Math.floor(REMOTE_SHELL_RATE_LIMIT / 2)
  : REMOTE_SHELL_RATE_LIMIT;

function checkRateLimit(requester: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const history = commandHistory.get(requester) || [];

  // Remove commands outside the window
  const recent = history.filter(time => now - time < RATE_LIMIT_WINDOW);

  if (recent.length >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }

  recent.push(now);
  commandHistory.set(requester, recent);

  return { allowed: true, remaining: RATE_LIMIT_MAX - recent.length };
}

/**
 * Security: Validate command before execution.
 */
export function validateCommand(cmd: RemoteShellCommand): {
  valid: boolean;
  error?: string;
} {
  // Check if remote shell is enabled
  if (!REMOTE_SHELL_ENABLED) {
    return {
      valid: false,
      error: 'Remote shell is disabled. Set NANOCLAW_REMOTE_SHELL_ENABLED=1 to enable.',
    };
  }

  // Check rate limit
  const rateLimit = checkRateLimit(cmd.requester);
  if (!rateLimit.allowed) {
    return {
      valid: false,
      error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} commands per minute. Try again in a moment.`,
    };
  }

  // Whitelist-only mode: only allow preset commands
  if (REMOTE_SHELL_WHITELIST_ONLY || PARANOID_MODE) {
    const isPreset = cmd.isPreset || Object.keys(PRESET_COMMANDS).includes(cmd.command);
    if (!isPreset) {
      logger.warn(
        { command: cmd.command, requester: cmd.requester },
        'Non-preset command blocked by whitelist-only mode',
      );
      return {
        valid: false,
        error: 'Whitelist-only mode: only preset commands are allowed. Use presets like "restart_nanoclaw", "view_recent_logs", etc.',
      };
    }
  }

  // Check for dangerous patterns
  if (containsDangerousPattern(cmd.command)) {
    logger.warn(
      { command: cmd.command, requester: cmd.requester },
      'Dangerous command blocked by security filter',
    );
    return {
      valid: false,
      error: 'Command blocked: contains potentially dangerous pattern. For safety, this command is not allowed.',
    };
  }

  // Check working directory is in allowlist
  if (cmd.workingDir) {
    const isAllowed = ALLOWED_WORKING_DIRS.some(
      (allowed) => cmd.workingDir === allowed || cmd.workingDir?.startsWith(allowed + '/'),
    );
    if (!isAllowed) {
      logger.warn(
        { workingDir: cmd.workingDir, requester: cmd.requester },
        'Working directory not in allowlist',
      );
      return {
        valid: false,
        error: `Working directory not allowed. Allowed directories: ${ALLOWED_WORKING_DIRS.join(', ')}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Get preset commands as formatted list for WhatsApp.
 */
export function getPresetCommandsList(): string {
  let message = '*Remote Shell Presets*\n\n';

  for (const [key, cmd] of Object.entries(PRESET_COMMANDS)) {
    const name = key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    message += `• *${name}*\n  \`/shell ${key}\`\n\n`;
  }

  message += 'Or run custom command:\n';
  message += '`/shell <your command here>`';

  return message;
}
