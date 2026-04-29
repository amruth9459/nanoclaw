/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  STORE_DIR,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { CONTAINER_RUNTIME_BIN, readonlyMountArgs, removeContainer, stopContainer } from './container-runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { getIntegrations } from './integration-loader.js';
import type { NanoClawIntegration } from './integration-types.js';
import { RegisteredGroup } from './types.js';
import { checkResourceUsage } from './agent-monitoring-system.js';
import { ensureAgentIdentity } from './identity/ipc-handlers.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const HEARTBEAT_MARKER = '---NANOCLAW_HEARTBEAT---';

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  designation?: string;  // e.g. 'conversation', 'task', 'guest', 'bounty', 'warmup'
  secrets?: Record<string, string>;
  routingHint?: {
    suggestedModel: string;
    tier: string;
    confidence: number;
    reasoning: string;
  };
  /** Limit agentic turns (API round-trips). Used for warmup to keep it fast. */
  maxTurns?: number;
  /** Persona ID for agent dispatch (maps to ~/.claude/agents/ persona file) */
  personaId?: string;
  /** Full persona markdown content (read from ~/.claude/agents/ on host, passed via stdin) */
  personaContent?: string;
  /** Kanban task ID for dispatch status tracking */
  dispatchTaskId?: string;
  /** Personality tuning params (Phase 2 Karpathy). Injected into system prompt. */
  personalityParams?: {
    tone: 'concise' | 'balanced' | 'verbose';
    verbosity: number;
    creativity: number;
    formality: 'casual' | 'professional' | 'formal';
  };
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'streaming';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isPartial?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Stage integration scripts into a single directory for bind-mounting.
 * Apple Container only supports directory mounts, not individual file mounts.
 * Returns the staging directory path, or null if no scripts to stage.
 */
function stageIntegrationScripts(integrations: NanoClawIntegration[], all: boolean): string | null {
  const scripts: Array<{ hostPath: string; containerName: string }> = [];
  for (const integration of integrations) {
    if (integration.getContainerScripts) {
      for (const script of integration.getContainerScripts()) {
        if (fs.existsSync(script.hostPath)) {
          scripts.push(script);
        }
      }
    }
  }
  if (scripts.length === 0) return null;

  const stagingDir = path.join(DATA_DIR, 'container-scripts', all ? '_all' : '_group');
  fs.mkdirSync(stagingDir, { recursive: true });

  for (const script of scripts) {
    const dest = path.join(stagingDir, script.containerName);
    fs.copyFileSync(script.hostPath, dest);
    fs.chmodSync(dest, 0o755);
  }
  return stagingDir;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the project root mounted READ-ONLY for visibility.
    // SECURITY: Read-only prevents agent from modifying source code,
    // .env secrets, backup scripts, or package.json. This is the
    // single most important security control in the system.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Integration-provided container mounts
    for (const integration of getIntegrations()) {
      if (integration.getContainerMounts) {
        const integrationMounts = integration.getContainerMounts(isMain, homeDir, group.folder);
        for (const m of integrationMounts) {
          mounts.push(m);
        }
      }
    }

    // GWS OAuth tokens (read-only) — for Google Workspace integration
    const gwsTokenDir = path.join(homeDir, '.config', 'gws');
    if (fs.existsSync(gwsTokenDir)) {
      mounts.push({
        hostPath: gwsTokenDir,
        containerPath: '/workspace/gws/tokens',
        readonly: true,
      });
    }

    // Integration scripts: stage into a single directory and mount it
    // (Apple Container only supports directory mounts, not individual files)
    const scriptsDir = stageIntegrationScripts(getIntegrations(), true);
    if (scriptsDir) {
      mounts.push({
        hostPath: scriptsDir,
        containerPath: '/usr/local/bin/integration-scripts',
        readonly: true,
      });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Skip if isolatedPersona is set — the group uses its own persona exclusively
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir) && !group.containerConfig?.isolatedPersona) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    // Integration-provided container mounts for owned groups
    const owningIntegrations = getIntegrations().filter(i => i.ownsGroup?.(group.folder));
    for (const integration of owningIntegrations) {
      if (integration.getContainerMounts) {
        const integrationMounts = integration.getContainerMounts(isMain, homeDir, group.folder);
        for (const m of integrationMounts) {
          mounts.push(m);
        }
      }
    }

    // Integration scripts: stage owned integration scripts and mount the directory
    const scriptsDir = stageIntegrationScripts(owningIntegrations, false);
    if (scriptsDir) {
      mounts.push({
        hostPath: scriptsDir,
        containerPath: '/usr/local/bin/integration-scripts',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        // Enable agent swarms (subagent orchestration)
        // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        // Load CLAUDE.md from additional mounted directories
        // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        // Enable Claude's memory feature (persists user preferences between sessions)
        // https://code.claude.com/docs/en/memory#manage-auto-memory
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  // Integration-owned skill dirs are only synced to groups owned by that integration (+ main)
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    // Collect skill dirs claimed by integrations
    const claimedSkillDirs = new Set<string>();
    for (const integration of getIntegrations()) {
      if (integration.getSkillDirs) {
        for (const dir of integration.getSkillDirs()) {
          claimedSkillDirs.add(dir);
        }
      }
    }

    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;

      if (claimedSkillDirs.has(skillDir)) {
        // Integration-owned skill: only sync to owned groups + main
        const shouldSync = isMain || getIntegrations().some(
          i => i.getSkillDirs?.().includes(skillDir) && i.ownsGroup?.(group.folder),
        );
        if (!shouldSync) continue;
      }

      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Media directory (read-only): main sees all media, guests only see their own group's media
  const mediaBase = path.join(STORE_DIR, 'media');
  const mediaDir = isMain ? mediaBase : path.join(mediaBase, group.folder);
  fs.mkdirSync(mediaDir, { recursive: true });
  mounts.push({
    hostPath: mediaDir,
    containerPath: '/workspace/media',
    readonly: true,
  });

  // No runtime src mount — agent code is pre-compiled into the image during
  // docker build. To update agent-runner code, run ./deploy.sh (or ./container/build.sh).

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(): Record<string, string> {
  // NOTE: ANTHROPIC_API_KEY intentionally NOT passed to containers — use OAuth only
  // so container sessions are covered by the Pro subscription (no API billing).
  // API key is still used host-side by judge-system.ts and semantic-index.ts.
  const fromEnvFile = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'GOOGLE_API_KEY']);

  // Keychain-first: on macOS, always try reading the freshest token from Keychain
  // (maintained by Claude Code desktop). Falls back to .env if Keychain is unavailable.
  if (process.platform === 'darwin') {
    const keychainToken = readOAuthFromKeychain();
    if (keychainToken) {
      if (keychainToken !== fromEnvFile['CLAUDE_CODE_OAUTH_TOKEN']) {
        logger.debug('OAuth token refreshed from Keychain');
      }
      fromEnvFile['CLAUDE_CODE_OAUTH_TOKEN'] = keychainToken;
    }
  }

  return fromEnvFile;
}

/** Read Claude Code OAuth access token directly from macOS Keychain. */
export function readOAuthFromKeychain(): string | null {
  try {
    const creds = execSync(
      'security find-generic-password -s "Claude Code-credentials" -a "amrut" -w',
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const parsed = JSON.parse(creds);
    const token = parsed?.claudeAiOauth?.accessToken;
    const expiresAt = parsed?.claudeAiOauth?.expiresAt ?? 0;
    // Only use if token has >30 min remaining
    if (token && (expiresAt / 1000 - Date.now() / 1000) > 1800) {
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  group: RegisteredGroup,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Memory limit (default 4GB)
  const memLimit = group.containerConfig?.memoryLimit ?? '4G';
  args.push('-m', memLimit);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Network isolation: non-main containers default to restricted network (no external internet).
  // Main container keeps internet access for web browsing, API calls, etc.
  // Set networkRestricted=false explicitly to opt out for a non-main group.
  // Requires the nanoclaw-restricted Docker network to exist (run setup-egress.sh first).
  const isMainGroup = group.folder === 'main';
  const networkRestricted = group.containerConfig?.networkRestricted ?? !isMainGroup;
  if (networkRestricted) {
    args.push('--network', 'nanoclaw-restricted');
    args.push('-e', 'NANOCLAW_NETWORK_RESTRICTED=1');
    logger.info({ group: group.name }, 'Container spawned on restricted network (no external internet)');
  }

  // Extra env vars from containerConfig
  for (const [key, value] of Object.entries(group.containerConfig?.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }

  // Persona ID is passed via stdin (ContainerInput.personaId) and read by agent-runner.
  // No need for env var — the agent-runner reads it from the JSON input.

  // Tell the container which integration tool modules to load.
  // Collected from integrations that own this group (or all for main).
  const toolModules: string[] = [];
  for (const integration of getIntegrations()) {
    if (integration.getContainerToolModule) {
      const isOwned = integration.ownsGroup?.(group.folder);
      if (isOwned || group.folder === 'main') {
        toolModules.push(integration.getContainerToolModule());
      }
    }
  }
  // GWS tools for main group (when OAuth tokens are available)
  if (group.folder === 'main') {
    const gwsTokenDir = path.join(getHomeDir(), '.config', 'gws');
    if (fs.existsSync(gwsTokenDir)) {
      toolModules.push('gws-tools');
    }
  }

  if (toolModules.length > 0) {
    args.push('-e', `NANOCLAW_TOOL_MODULES=${toolModules.join(',')}`);
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

// CLAUDE.md size guard: cap at 400 lines to prevent unbounded growth.
// Keeps the first 300 lines (core instructions) and the last 80 lines (recent context).
// Logs a warning when trimming occurs.
const CLAUDE_MD_MAX_LINES = 400;
const CLAUDE_MD_HEAD_KEEP = 300;
const CLAUDE_MD_TAIL_KEEP = 80;

function trimClaudeMdIfNeeded(groupFolder: string): void {
  const claudeMdPath = path.join(GROUPS_DIR, groupFolder, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) return;

  const content = fs.readFileSync(claudeMdPath, 'utf8');
  const lines = content.split('\n');
  if (lines.length <= CLAUDE_MD_MAX_LINES) return;

  logger.warn(
    { groupFolder, lines: lines.length, max: CLAUDE_MD_MAX_LINES },
    'CLAUDE.md exceeded size limit — trimming to preserve core instructions',
  );

  const head = lines.slice(0, CLAUDE_MD_HEAD_KEEP);
  const tail = lines.slice(-CLAUDE_MD_TAIL_KEEP);
  const trimmed = [
    ...head,
    '',
    `<!-- [${lines.length - CLAUDE_MD_HEAD_KEEP - CLAUDE_MD_TAIL_KEEP} lines trimmed by size guard] -->`,
    '',
    ...tail,
  ].join('\n');

  fs.writeFileSync(claudeMdPath, trimmed, 'utf8');
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Trim CLAUDE.md if it has grown too large (prevents context overflow)
  trimClaudeMdIfNeeded(group.folder);

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const designation = input.designation || 'agent';
  const containerName = `nanoclaw-${safeName}-${designation}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, group);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Pre-flight: validate OAuth token before spawning container
  // Prevents 401 storms that trigger rate limits on the token endpoint
  const secrets = readSecrets();
  const oauthToken = secrets['CLAUDE_CODE_OAUTH_TOKEN'];
  if (!oauthToken) {
    logger.error({ group: group.name }, 'No CLAUDE_CODE_OAUTH_TOKEN in .env — cannot spawn container');
    return { status: 'error', error: 'OAuth token missing from .env', result: null };
  }

  // Pre-process PDFs: convert pages to resized images so Claude API doesn't hit
  // the 2000px multi-image limit. The media dir is mounted read-only in the container,
  // so we do this on the host before spawn.
  input.prompt = preprocessPdfMedia(input.prompt, path.join(STORE_DIR, 'media'));

  // Create or retrieve cryptographic identity for this agent
  let agentId: string | undefined;
  try {
    agentId = await ensureAgentIdentity(group.folder, designation);
  } catch (err) {
    // Non-fatal: agent runs without identity (migration mode)
    logger.warn({ err, group: group.name }, 'Identity: failed to create agent identity, continuing without');
  }

  // Inject agent_id into container args if identity was created
  if (agentId) {
    // Insert env var before the image name (last arg)
    const imageIdx = containerArgs.length - 1;
    containerArgs.splice(imageIdx, 0, '-e', `NANOCLAW_AGENT_ID=${agentId}`);
  }

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = secrets;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets from input so they don't appear in logs
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    // Resource tracking for agent monitoring
    let totalSpendUsd = 0;
    let outputCount = 0;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Heartbeat detection — reset timeout without treating it as output
      if (chunk.includes(HEARTBEAT_MARKER)) {
        resetTimeout();
      }

      // Stream-parse for output markers
      if (onOutput) {
        // Strip heartbeat lines from parse buffer to avoid polluting output parsing
        parseBuffer += chunk.replace(new RegExp(`\\s*${HEARTBEAT_MARKER}\\s*`, 'g'), '');
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));

            // Resource tracking: accumulate spend and check limits
            if (parsed.usage) {
              // Approximate cost: $3/MTok input, $15/MTok output (Sonnet pricing)
              const inputCost = (parsed.usage.inputTokens / 1_000_000) * 3;
              const outputCost = (parsed.usage.outputTokens / 1_000_000) * 15;
              totalSpendUsd += inputCost + outputCost;
            }
            outputCount++;
            const taskId = input.designation || 'agent';
            checkResourceUsage(taskId, {
              agentSpawnCount: outputCount,
              totalSpendUsd,
              apiCallCount: outputCount,
            });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, containerName }, 'Container timeout, stopping gracefully');
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ group: group.name, containerName, err }, 'Graceful stop failed, force killing');
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      // Remove stopped container immediately to free Apple Virtualization VM file descriptors.
      // Without this, stopped VMs leak FDs and eventually cause ENFILE system-wide.
      removeContainer(containerName);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Container Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Container: ${containerName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

/**
 * Convert PDF pages to resized PNG images so Claude API doesn't hit the
 * 2000px multi-image dimension limit. Rewrites prompt references from
 * [document: /workspace/media/X.pdf] to [image: /workspace/media/X-page-N.png].
 *
 * Uses `sips` (macOS built-in) for resizing. Skips if already converted.
 */
function preprocessPdfMedia(prompt: string, mediaDir: string): string {
  // Find all PDF references: [document: /workspace/media/something.pdf]
  const pdfPattern = /\[document:\s*\/workspace\/media\/([^\]]+\.pdf)\]/gi;
  const matches = [...prompt.matchAll(pdfPattern)];
  if (matches.length === 0) return prompt;

  for (const match of matches) {
    const pdfFilename = match[1];
    const pdfPath = path.join(mediaDir, pdfFilename);
    if (!fs.existsSync(pdfPath)) continue;

    const baseName = pdfFilename.replace(/\.pdf$/i, '');
    const pagesDir = path.join(mediaDir, `${baseName}-pages`);

    // Skip if already converted
    if (fs.existsSync(pagesDir) && fs.readdirSync(pagesDir).length > 0) {
      const pageFiles = fs.readdirSync(pagesDir)
        .filter((f) => f.endsWith('.png'))
        .sort();
      const imageRefs = pageFiles
        .map((f) => `[image: /workspace/media/${baseName}-pages/${f}]`)
        .join(' ');
      prompt = prompt.replace(match[0], imageRefs);
      continue;
    }

    try {
      fs.mkdirSync(pagesDir, { recursive: true });

      // Convert PDF pages to PNG using pdftoppm (poppler-utils) or sips fallback.
      // pdftoppm renders at specified DPI; sips resizes after.
      // Max 1568px on longest edge (Claude's recommended resolution).
      try {
        // pdftoppm: render at 150 DPI (good balance for most PDFs)
        execSync(
          `pdftoppm -png -r 150 "${pdfPath}" "${pagesDir}/page"`,
          { stdio: 'pipe', timeout: 120000 },
        );
      } catch {
        // Fallback: try macOS Preview via sips (can handle some PDFs)
        logger.debug({ pdfPath }, 'pdftoppm not available, skipping PDF preprocessing');
        continue;
      }

      // Resize any oversized pages
      const pageFiles = fs.readdirSync(pagesDir)
        .filter((f) => f.endsWith('.png') || f.endsWith('.ppm'))
        .sort();

      for (const pageFile of pageFiles) {
        const pagePath = path.join(pagesDir, pageFile);
        try {
          execSync(
            `sips --resampleHeightWidthMax 1568 "${pagePath}"`,
            { stdio: 'pipe', timeout: 15000 },
          );
        } catch {
          // sips failed on this page — leave as-is
        }
      }

      // Rebuild the file list (sips may have changed extensions)
      const finalFiles = fs.readdirSync(pagesDir)
        .filter((f) => f.endsWith('.png') || f.endsWith('.ppm'))
        .sort();

      if (finalFiles.length > 0) {
        const imageRefs = finalFiles
          .map((f) => `[image: /workspace/media/${baseName}-pages/${f}]`)
          .join(' ');
        prompt = prompt.replace(match[0], imageRefs);
        logger.info({ pdf: pdfFilename, pages: finalFiles.length }, 'PDF pre-processed to page images');
      }
    } catch (err) {
      logger.warn({ err, pdf: pdfFilename }, 'PDF preprocessing failed, using original');
    }
  }

  return prompt;
}

/**
 * Check if a container error looks like an OAuth/authentication failure.
 * Used to trigger targeted retry (re-read secrets) instead of failing immediately.
 */
export function isOAuthError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return /401|authentication|unauthorized|oauth|token expired|invalid.*token/.test(lower);
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
