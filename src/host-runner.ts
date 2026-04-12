/**
 * Host-Mode Claude Code Runner
 *
 * Runs agent work through the official `claude` CLI on the host instead of
 * the Agent SDK in a container. Claude Code CLI is explicitly covered by
 * the Max subscription — it's Anthropic's own first-party tool.
 *
 * Safety:
 *   - PreToolUse hook (safety-gate.sh) blocks destructive Bash commands
 *   - Per-group trust: main → host runner, guests → container (sandboxed)
 *   - No --dangerously-skip-permissions — uses permission model + safety hook
 *
 * Architecture:
 *   Message → formatPrompt → claude -p (host CLI) → safety gate → output
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR, DATA_DIR, STORE_DIR, MAIN_GROUP_FOLDER } from './config.js';
import { logger } from './logger.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude';
const HOST_RUNNER_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const MAX_OUTPUT_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Run agent work through the host's Claude Code CLI.
 * Drop-in replacement for runContainerAgent().
 */
export async function runHostClaudeAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Ensure IPC directories exist (host-runner writes directly, no container mount)
  const ipcBase = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(ipcBase, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcBase, 'tasks'), { recursive: true });

  // Build CLI args
  // Safety is enforced by the PreToolUse hook (safety-gate.sh) in ~/.claude/settings.json
  // (prompt placeholder — replaced below after toolPath is defined)
  const cliArgs = [
    '-p', '',  // placeholder
    '--output-format', 'text',
    '--dangerously-skip-permissions',  // Required for non-interactive; safety-gate.sh blocks destructive commands
    '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'Bash', 'WebFetch', 'WebSearch', 'Agent',
  ];

  // Session persistence — enables prompt caching (key for subscription compliance)
  if (input.sessionId) {
    cliArgs.push('--session-id', input.sessionId);
  }

  // Max turns
  if (input.maxTurns) {
    cliArgs.push('--max-turns', String(input.maxTurns));
  }

  // Build clean env (prevent nesting detection)
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;
  cleanEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  cleanEnv.PATH = `/opt/homebrew/bin:${cleanEnv.PATH || '/usr/bin:/bin'}`;

  // Pass group context as env vars (accessible via Bash in Claude Code)
  cleanEnv.NANOCLAW_GROUP_FOLDER = group.folder;
  cleanEnv.NANOCLAW_CHAT_JID = input.chatJid;
  cleanEnv.NANOCLAW_IS_MAIN = input.isMain ? '1' : '0';
  cleanEnv.NANOCLAW_IPC_DIR = ipcBase;
  cleanEnv.NANOCLAW_STORE_DIR = STORE_DIR;

  // IPC tool path — the Claude Code session can call this via Bash
  const toolPath = path.resolve(process.cwd(), 'scripts', 'nanoclaw-tool');
  cleanEnv.NANOCLAW_TOOL_PATH = toolPath;

  // Now build the full prompt with IPC tool docs prepended
  const ipcToolDocs = buildIpcToolDocs(toolPath, ipcBase, input.chatJid, group.folder, input.isMain);
  cliArgs[1] = `${ipcToolDocs}\n\n${input.prompt}`;

  const runName = `host-claude-${group.folder}-${Date.now()}`;

  logger.info(
    { group: group.name, runName, sessionId: input.sessionId, maxTurns: input.maxTurns },
    'Spawning host Claude Code agent',
  );

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, cliArgs, {
      cwd: groupDir,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    onProcess(child, runName);

    let stdout = '';
    let stderr = '';
    let outputSize = 0;
    let sessionId: string | undefined;

    const killTimer = setTimeout(() => {
      logger.warn({ pid: child.pid, group: group.name }, 'Host Claude Code timeout — killing');
      child.kill('SIGTERM');
    }, HOST_RUNNER_TIMEOUT_MS);

    child.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (outputSize < MAX_OUTPUT_SIZE) {
        stdout += text;
        outputSize += chunk.length;
      }

      // Stream partial output to caller
      if (onOutput && text.trim()) {
        onOutput({
          status: 'streaming',
          result: text,
          isPartial: true,
        }).catch(() => {});
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (outputSize < MAX_OUTPUT_SIZE) {
        stderr += text;
        outputSize += chunk.length;
      }

      // Extract session ID from stderr (Claude Code prints it there)
      const sessionMatch = text.match(/Session ID: ([a-f0-9-]+)/);
      if (sessionMatch) {
        sessionId = sessionMatch[1];
      }
    });

    child.on('close', async (code, signal) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - startTime;

      logger.info(
        { group: group.name, code, signal, durationMs, outputLength: stdout.length },
        'Host Claude Code agent finished',
      );

      const result = stdout.trim();

      if (code === 0 && result) {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result,
            newSessionId: sessionId,
            isPartial: false,
          }).catch(() => {});
        }

        resolve({
          status: 'success',
          result,
          newSessionId: sessionId,
        });
      } else {
        const errorMsg = signal === 'SIGTERM'
          ? `Host Claude Code timed out after ${HOST_RUNNER_TIMEOUT_MS / 1000}s`
          : `Host Claude Code exited with code ${code}: ${stderr.slice(0, 500)}`;

        if (onOutput) {
          await onOutput({
            status: 'error',
            result: null,
            error: errorMsg,
          }).catch(() => {});
        }

        resolve({
          status: 'error',
          result: result || null,
          error: errorMsg,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(killTimer);
      logger.error({ err, group: group.name }, 'Host Claude Code spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Failed to spawn claude CLI: ${err.message}`,
      });
    });
  });
}

/**
 * Determine which runner to use for a group.
 *
 * - Main group (trusted, you) → host runner (subscription-safe, fast)
 * - Guest/external groups → container runner (sandboxed, isolated)
 * - Override: USE_HOST_RUNNER=1 forces host, =0 forces container
 */
export function shouldUseHostRunner(groupFolder?: string): boolean {
  // Explicit override
  if (process.env.USE_HOST_RUNNER === '1') return true;
  if (process.env.USE_HOST_RUNNER === '0') return false;

  // Check claude CLI exists
  try {
    if (!fs.existsSync(CLAUDE_BIN)) return false;
  } catch {
    return false;
  }

  // Per-group trust: main → host, guests → container
  if (groupFolder && groupFolder !== MAIN_GROUP_FOLDER) {
    // Non-main groups use container for isolation (if available)
    return false;
  }

  // Main group or no group specified: use host runner
  return true;
}

/**
 * Build IPC tool documentation to prepend to the prompt.
 * This teaches the Claude Code session how to use nanoclaw-tool.
 */
function buildIpcToolDocs(
  toolPath: string,
  ipcDir: string,
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
): string {
  return `## NanoClaw IPC Tools

You are running as a host-mode Claude Code agent for NanoClaw. You have access to IPC tools
via the \`nanoclaw-tool\` script. These let you send WhatsApp messages, manage tasks, learn
facts, search knowledge, schedule recurring jobs, and more.

**Tool path:** \`${toolPath}\`

**Environment:** group=${groupFolder}, jid=${chatJid}, main=${isMain}

### Available Commands

**Send a message to the chat:**
\`\`\`bash
${toolPath} send "Your message here"
${toolPath} send --jid "1234@s.whatsapp.net" "Message to specific JID"
\`\`\`

**React to a message:**
\`\`\`bash
${toolPath} react "👍" --message-id "BAE5..."
\`\`\`

**Learn a fact (persists across sessions):**
\`\`\`bash
${toolPath} learn "topic-name" "Detailed knowledge content (min 50 chars)..."
${toolPath} learn --domain lexios "extraction" "IFC files need key normalization..."
\`\`\`

**Manage tasks:**
\`\`\`bash
${toolPath} task list
${toolPath} task create "Do something important" --priority 50
${toolPath} task update --task-id "abc123" --status completed
${toolPath} task get --task-id "abc123"
\`\`\`

**Semantic search across knowledge:**
\`\`\`bash
${toolPath} search "how does the router select models"
\`\`\`

**Schedule a recurring task:**
\`\`\`bash
${toolPath} schedule "Check system health" --cron "0 9 * * *"
${toolPath} schedule "Quick status check" --interval 3600000
\`\`\`

**Send a file:**
\`\`\`bash
${toolPath} file /path/to/report.pdf --caption "Here's the report"
\`\`\`

**List WhatsApp groups:**
\`\`\`bash
${toolPath} groups
\`\`\`

**Manage shared items:**
\`\`\`bash
${toolPath} items list
${toolPath} items triage --item-id "id123" "notes about this item"
\`\`\`

### Safety Limits
- Messages: max 5/minute per JID, 20/minute total, 8KB max
- Files: 25MB max
- Learn: 200KB max, min 50 chars
- Schedule: min 5-minute interval, max 10 active tasks per group${isMain ? '' : '\n- Non-main group: can only send to own JID'}

### Important
- Always use \`nanoclaw-tool send\` to communicate back to the user via WhatsApp
- The PreToolUse safety hook blocks destructive Bash commands (rm -rf, git push, etc.)
- Your working directory is the group folder: groups/${groupFolder}/
`;
}
