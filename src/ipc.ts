import crypto, { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { CronExpressionParser } from 'cron-parser';

import {
  BRAIN_VAULT_PATH,
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import { getIntegrations } from './integration-loader.js';
import { AvailableGroup, writeTasksSnapshot } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getNewSharedItemCount,
  getSharedItemById,
  getSharedItems,
  getTaskById,
  getTasksForGroup,
  saveLearn,
  updateSharedItemStatus,
  updateTask,
} from './db.js';
import { CleanupGate } from './cleanup-gate.js';
import { DeliverableGate } from './deliverable-gate.js';
import { learnFact } from './context/index.js';
import { readEnvFile } from './env.js';
import { HitlGate } from './hitl.js';
import { getIntegration } from './integration-loader.js';
import { logger } from './logger.js';
import { indexDocument, semanticSearch } from './semantic-index.js';
import { ragQuery } from './rag-chain.js';
import { sanitizeWebContent, detectPromptInjection } from './content-filter.js';
import { spawnGate } from './spawn-gate.js';
import { RegisteredGroup, UIMetadata } from './types.js';
import { processIdentityIpc, signOutgoingMessage, recordUnsignedMessage } from './identity/ipc-handlers.js';
import { handleCompetitiveIntelIpc } from './competitive-intel/ipc-handler.js';
import { handleAutoresearchIpc } from './autoresearch/ipc-handler.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string, senderName?: string) => Promise<void>;
  /** Like sendMessage but returns the WhatsApp message ID. Used for IPC responseFile. */
  sendMessageGetId?: (jid: string, text: string, senderName?: string) => Promise<string | undefined>;
  sendReaction?: (jid: string, messageId: string, senderJid: string, emoji: string) => Promise<void>;
  sendFile?: (jid: string, buffer: Buffer, mimetype: string, filename: string, caption?: string) => Promise<void>;
  sendInteractiveMessage?: (jid: string, ui: UIMetadata, senderName?: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  /** HITL gate — intercepts sends to unregistered JIDs */
  hitlGate?: HitlGate;
  /** Cleanup gate — HITL approval for Gmail cleanup operations */
  cleanupGate?: CleanupGate;
  /** Deliverable gate — HITL approval for freelance deliverables */
  deliverableGate?: DeliverableGate;
  /** Implementation gate — HITL approval for branch merges */
  implementationGate?: import('./implementation-gate.js').ImplementationGate;
  /** Returns the JID of the main group (used for HITL notifications) */
  getMainGroupJid?: () => string | undefined;
  /**
   * Called when the agent explicitly sends a message via the send_message MCP tool.
   * Used by the host to suppress the redundant final streaming output.
   */
  onAgentSendMessage?: (chatJid: string) => void;
}

// Outgoing message dedup: skip identical content sent to same JID within 30s
const outgoingDedup = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000;

function isDuplicateOutgoing(jid: string, text: string): boolean {
  const hash = createHash('md5').update(`${jid}:${text}`).digest('hex');
  const now = Date.now();
  const lastSent = outgoingDedup.get(hash);
  if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
    logger.info({ jid, hash, agoMs: now - lastSent }, 'Duplicate outgoing message suppressed');
    return true;
  }
  outgoingDedup.set(hash, now);
  // Prune old entries every 100 inserts
  if (outgoingDedup.size > 200) {
    for (const [k, ts] of outgoingDedup) {
      if (now - ts > DEDUP_WINDOW_MS) outgoingDedup.delete(k);
    }
  }
  return false;
}

let ipcWatcherRunning = false;

// ── Desktop Claude completion tracker ─────────────────────────────────
// Tracks which groups had successful desktop_claude runs so failed containers
// can still be marked as done (the work was committed even if the container timed out).
const desktopClaudeCompletions = new Map<string, number>(); // groupFolder → count

export function recordDesktopCompletion(groupFolder: string): void {
  desktopClaudeCompletions.set(groupFolder, (desktopClaudeCompletions.get(groupFolder) || 0) + 1);
}

export function consumeDesktopCompletions(groupFolder: string): number {
  const count = desktopClaudeCompletions.get(groupFolder) || 0;
  if (count > 0) desktopClaudeCompletions.delete(groupFolder);
  return count;
}

// ── Desktop Claude concurrency semaphore ──────────────────────────────
// Serialize desktop_claude spawns to prevent FD exhaustion from parallel claude -p
let activeDesktopClaude = 0;
const MAX_CONCURRENT_DESKTOP = 2;
const DESKTOP_QUEUE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max wait in queue
const desktopQueue: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

function acquireDesktopSlot(): Promise<void> {
  if (activeDesktopClaude < MAX_CONCURRENT_DESKTOP) {
    activeDesktopClaude++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = desktopQueue.findIndex(e => e.resolve === resolve);
      if (idx >= 0) desktopQueue.splice(idx, 1);
      reject(new Error('desktop_claude queue timeout — waited 30 minutes'));
    }, DESKTOP_QUEUE_TIMEOUT_MS);
    desktopQueue.push({ resolve, reject, timer });
  });
}

function releaseDesktopSlot(): void {
  activeDesktopClaude--;
  if (desktopQueue.length > 0) {
    const next = desktopQueue.shift()!;
    clearTimeout(next.timer);
    activeDesktopClaude++;
    next.resolve();
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // PERFORMANCE: Process groups in parallel for better throughput
    await Promise.allSettled(
      groupFolders.map(async (sourceGroup) => {
        const isMain = sourceGroup === MAIN_GROUP_FOLDER;
        const groupIpcDir = path.join(ipcBaseDir, sourceGroup);
        const messagesDir = path.join(groupIpcDir, 'messages');
        const tasksDir = path.join(groupIpcDir, 'tasks');

        // ── Semantic search / index requests ─────────────────────────────────
        try {
          const searchFiles = fs.readdirSync(groupIpcDir)
            .filter(f => f.endsWith('.search.json') || f.endsWith('.index.json') || f.endsWith('.jyotish.json'));
          for (const file of searchFiles) {
            const filePath = path.join(groupIpcDir, file);
            try {
              const req = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);

              if (req.type === 'semantic_search') {
                const results = await semanticSearch(req.query, req.topK ?? 5, req.groupFolder).catch(err => {
                  logger.warn({ err }, 'Semantic search failed');
                  return null;
                });
                const rawRF = req.responseFile as string;
                const responseFile = toHostIpcPath(rawRF, sourceGroup);

                // Content Sanitization: scrub RAG results before returning to agent
                let sanitizedResults = results;
                if (results) {
                  sanitizedResults = results.map(r => {
                    const result = sanitizeWebContent(r.content, { sourceUrl: r.source });
                    if (!result.safe) {
                      logger.warn({ source: r.source, riskScore: result.riskScore }, 'RAG result sanitized — high risk content');
                    }
                    return { ...r, content: result.sanitized };
                  });
                }

                const response = sanitizedResults
                  ? { results: sanitizedResults }
                  : { error: 'Search failed — check ANTHROPIC_API_KEY and index status' };
                fs.mkdirSync(path.dirname(responseFile), { recursive: true });
                fs.writeFileSync(responseFile + '.tmp', JSON.stringify(response));
                fs.renameSync(responseFile + '.tmp', responseFile);
              } else if (req.type === 'index_document') {
                indexDocument(req.source, req.groupFolder, req.content).catch(err =>
                  logger.warn({ source: req.source, err }, 'Background indexing failed'),
                );
              } else if (req.type === 'rag_query') {
                const rawRF = req.responseFile as string;
                const responseFile = toHostIpcPath(rawRF, sourceGroup);
                ragQuery(req.query, req.threadId, req.topK ?? 5, req.groupFolder)
                  .then(result => {
                    const response = { answer: result.answer, sources: result.sources, contextualizedQuery: result.contextualizedQuery };
                    fs.mkdirSync(path.dirname(responseFile), { recursive: true });
                    fs.writeFileSync(responseFile + '.tmp', JSON.stringify(response));
                    fs.renameSync(responseFile + '.tmp', responseFile);
                  })
                  .catch(err => {
                    logger.warn({ err, query: req.query }, 'RAG query failed');
                    fs.mkdirSync(path.dirname(responseFile), { recursive: true });
                    fs.writeFileSync(responseFile + '.tmp', JSON.stringify({ error: 'RAG query failed' }));
                    fs.renameSync(responseFile + '.tmp', responseFile);
                  });
              } else if (req.type === 'jyotish_calculate') {
                const rawRF = req.responseFile as string;
                const responseFile = toHostIpcPath(rawRF, sourceGroup);
                const { spawn } = await import('child_process');
                const venvPython = path.join(process.env.HOME ?? '', 'nanoclaw/services/jyotish/.venv/bin/python3');
                const enginePath = path.join(process.env.HOME ?? '', 'nanoclaw/services/jyotish/engine.py');
                const input = JSON.stringify({
                  year: req.year, month: req.month, day: req.day,
                  hour: req.hour, minute: req.minute, second: req.second ?? 0,
                  place_name: req.place_name ?? '', latitude: req.latitude, longitude: req.longitude,
                  timezone_offset: req.timezone_offset, ayanamsa: req.ayanamsa ?? 'LAHIRI',
                  divisional_charts: req.divisional_charts,
                  analyses: req.analyses,
                });
                const proc = spawn(venvPython, [enginePath, '--ipc'], { timeout: 60000 });
                let stdout = '';
                let stderr = '';
                proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
                proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
                proc.stdin.write(input);
                proc.stdin.end();
                proc.on('close', (code: number | null) => {
                  try {
                    if (code === 0 && stdout) {
                      // Find the JSON object in stdout (skip PyJHora path spam)
                      const jsonStart = stdout.indexOf('{');
                      const json = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
                      const result = JSON.parse(json);
                      fs.mkdirSync(path.dirname(responseFile), { recursive: true });
                      fs.writeFileSync(responseFile + '.tmp', JSON.stringify(result));
                      fs.renameSync(responseFile + '.tmp', responseFile);
                    } else {
                      logger.warn({ code, stderr: stderr.slice(0, 500) }, 'Jyotish calculation failed');
                      fs.mkdirSync(path.dirname(responseFile), { recursive: true });
                      fs.writeFileSync(responseFile + '.tmp', JSON.stringify({ error: `Jyotish failed (code ${code}): ${stderr.slice(0, 200)}` }));
                      fs.renameSync(responseFile + '.tmp', responseFile);
                    }
                  } catch (err) {
                    logger.warn({ err, stdout: stdout.slice(0, 200) }, 'Jyotish parse error');
                    fs.mkdirSync(path.dirname(responseFile), { recursive: true });
                    fs.writeFileSync(responseFile + '.tmp', JSON.stringify({ error: 'Failed to parse jyotish output' }));
                    fs.renameSync(responseFile + '.tmp', responseFile);
                  }
                });
              }
            } catch (err) {
              logger.warn({ file, sourceGroup, err }, 'Error processing semantic IPC file');
            }
          }
        } catch { /* dir may not exist yet */ }

        // Process messages from this group's IPC directory
        try {
          if (fs.existsSync(messagesDir)) {
            const messageFiles = fs
              .readdirSync(messagesDir)
              .filter((f) => f.endsWith('.json') && !f.endsWith('.response.json'))
              .sort(); // Preserve order within group

            // Process messages sequentially within each group to maintain order
            for (const file of messageFiles) {
              const filePath = path.join(messagesDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

                // ── IPC handlers ────────────────────────────────────────────
                const IPC_TYPES = new Set([
                  'learn',
                  'propose_deliverable', 'propose_implementation',
                  'task_tool', 'gsd_tool', 'gmail_cleanup', 'shared_items',
                  'token_refresh',
                  'generate_safety_brief', 'monitoring_log',
                  'autoresearch',
                  'competitive_intel_check',
                ]);

                // ── Identity IPC handlers ─────────────────────────────────
                const IDENTITY_IPC_TYPES = new Set([
                  'identity_create', 'identity_verify_agent',
                  'identity_audit_evidence', 'identity_trust_report',
                  'identity_record_evidence',
                ]);
                if (data.type && IDENTITY_IPC_TYPES.has(data.type)) {
                  const rawResponseFile = data.responseFile as string | undefined;
                  const identityResponseFile = rawResponseFile ? toHostIpcPath(rawResponseFile, sourceGroup) : undefined;
                  await processIdentityIpc(data, sourceGroup, identityResponseFile);
                  fs.unlinkSync(filePath);
                  continue;
                }
                if (data.type && IPC_TYPES.has(data.type)) {
                  await processIpcMessage(data, sourceGroup, messagesDir, deps);
                  fs.unlinkSync(filePath);
                  continue;
                }

                // ── Integration IPC handlers ──────────────────────────────
                let handledByIntegration = false;
                for (const integration of getIntegrations()) {
                  if (integration.ipcMessageTypes?.has(data.type as string) && integration.handleIpcMessage) {
                    await integration.handleIpcMessage(data, sourceGroup, {
                      sendMessage: deps.sendMessage,
                      registeredGroups: deps.registeredGroups,
                      registerGroup: deps.registerGroup,
                    });
                    handledByIntegration = true;
                    break;
                  }
                }
                if (handledByIntegration) {
                  fs.unlinkSync(filePath);
                  continue;
                }

                // ── Desktop Claude Code remote control ────────────────────
                if (data.type === 'desktop_claude') {
                  // Check authorization: main group always allowed, integrations provide config
                  const home = process.env.HOME || '/Users/amrut';
                  let desktopConfig: { workdir: string; allowedRoots: string[]; notifyTopic: string } | undefined;

                  if (isMain) {
                    desktopConfig = {
                      workdir: path.join(home, 'nanoclaw'),
                      allowedRoots: [path.join(home, 'nanoclaw')],
                      notifyTopic: 'desktop',
                    };
                  } else {
                    for (const integ of getIntegrations()) {
                      desktopConfig = integ.getDesktopClaudeConfig?.(sourceGroup);
                      if (desktopConfig) break;
                    }
                  }

                  if (!desktopConfig) {
                    logger.warn({ sourceGroup }, 'Unauthorized desktop_claude attempt blocked');
                    fs.unlinkSync(filePath);
                    continue;
                  }

                  const rawResponseFile = data.responseFile as string | undefined;
                  const responseFile = rawResponseFile ? toHostIpcPath(rawResponseFile, sourceGroup) : undefined;
                  const capturedConfig = desktopConfig;
                  // Spawn in background so IPC loop isn't blocked
                  (async () => {
                    // Acquire semaphore slot (serialize desktop_claude to prevent FD exhaustion)
                    try {
                      await acquireDesktopSlot();
                    } catch (err) {
                      logger.warn({ err }, 'desktop_claude semaphore timeout');
                      if (responseFile) {
                        writeIpcResponse(responseFile, { error: 'desktop_claude queue timeout — all slots busy for 5 minutes' });
                      }
                      return;
                    }
                    try {
                      const { spawn } = await import('child_process');
                      const prompt = data.prompt as string;
                      const rawWorkdir = (data.workdir as string) || capturedConfig.workdir;
                      // Expand ~ to home directory (container sends ~/Lexios which path.resolve won't expand)
                      const workdir = rawWorkdir.startsWith('~/') ? path.join(home, rawWorkdir.slice(2)) : rawWorkdir;
                      const maxBudget = (data.max_budget_usd as number) || 0; // 0 = no limit

                      // ── Safety: lock workdir to allowed roots ──
                      const allAllowedRoots = [path.join(home, 'nanoclaw'), ...capturedConfig.allowedRoots];
                      const resolved = path.resolve(workdir);
                      if (!allAllowedRoots.some(r => resolved === r || resolved.startsWith(r + '/'))) {
                        throw new Error(`Workdir "${workdir}" outside allowed roots: ${allAllowedRoots.join(', ')}`);
                      }

                      // Build CLI args
                      const cliArgs = [
                        '-p', prompt,
                        '--output-format', 'text',
                        '--dangerously-skip-permissions',  // Non-interactive: prevent permission prompt stalls
                        '--no-session-persistence',        // Prevent lock file contention in ~/.claude/tasks/
                        // Full tool access — same as interactive Claude Code
                        '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
                          'Bash', 'WebFetch', 'WebSearch', 'Agent',
                      ];
                      if (maxBudget > 0) {
                        cliArgs.push('--max-budget-usd', String(maxBudget));
                      }

                      const claudeBin = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude';
                      const cleanEnv = (() => {
                        const e = { ...process.env };
                        delete e.CLAUDECODE;              // Must delete — even '' blocks nested sessions
                        delete e.CLAUDE_CODE_ENTRYPOINT;  // Also blocks nesting detection
                        e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
                        e.PATH = `/opt/homebrew/bin:${e.PATH || '/usr/bin:/bin'}`;
                        return e;
                      })();

                      logger.info({ prompt: prompt.slice(0, 200), workdir: resolved, maxBudget: maxBudget || 'unlimited' }, 'Spawning desktop Claude Code');

                      const OVERALL_TIMEOUT_MS = 20 * 60 * 1000; // 20 min

                      // ── Spawn with stdin closed ──
                      // CRITICAL: stdin must be 'ignore' (not pipe). Claude Code CLI stalls
                      // indefinitely when stdin is a pipe from Node.js execFile/spawn.
                      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
                        const child = spawn(claudeBin, cliArgs, {
                          cwd: resolved,
                          env: cleanEnv,
                          stdio: ['ignore', 'pipe', 'pipe'],  // stdin=closed, stdout/stderr=captured
                        });

                        let stdoutBuf = '';
                        let stderrBuf = '';
                        let outputSize = 0;
                        const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB cap

                        child.stdout!.on('data', (chunk: Buffer) => {
                          if (outputSize < MAX_OUTPUT) {
                            stdoutBuf += chunk.toString();
                            outputSize += chunk.length;
                          }
                        });
                        child.stderr!.on('data', (chunk: Buffer) => {
                          if (outputSize < MAX_OUTPUT) {
                            stderrBuf += chunk.toString();
                            outputSize += chunk.length;
                          }
                        });

                        const killTimer = setTimeout(() => {
                          logger.warn({ pid: child.pid }, 'desktop_claude overall timeout — killing');
                          child.kill('SIGTERM');
                        }, OVERALL_TIMEOUT_MS);

                        child.on('close', (code, signal) => {
                          clearTimeout(killTimer);
                          if (code === 0) {
                            resolve({ stdout: stdoutBuf, stderr: stderrBuf });
                          } else {
                            const err: any = new Error(`claude -p exited with code ${code}${signal ? ` (${signal})` : ''}`);
                            err.code = code;
                            err.signal = signal;
                            err.killed = signal === 'SIGTERM' || signal === 'SIGKILL';
                            err.stdout = stdoutBuf;
                            err.stderr = stderrBuf;
                            reject(err);
                          }
                        });

                        child.on('error', (err: any) => {
                          clearTimeout(killTimer);
                          err.stdout = stdoutBuf;
                          err.stderr = stderrBuf;
                          reject(err);
                        });
                      });

                      const output = stdout || stderr || 'Completed with no output.';
                      logger.info({ outputLen: output.length, sourceGroup }, 'Desktop Claude Code completed');
                      recordDesktopCompletion(sourceGroup);

                      // ── Notify user via WhatsApp if git push detected ──
                      if (/git\s+push|pushed\s+to|->/.test(output)) {
                        const mainJid = deps.getMainGroupJid?.();
                        if (mainJid) {
                          const { getNotifyJid } = await import('./notify.js');
                          const summary = prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '');
                          await deps.sendMessage(getNotifyJid(capturedConfig.notifyTopic, mainJid), `🤖 Agent pushed code via Desktop Claude.\nSource: ${sourceGroup}\nTask: ${summary}`);
                        }
                      }

                      if (responseFile) {
                        writeIpcResponse(responseFile, { output });
                      }
                    } catch (err: unknown) {
                      // Extract stderr/stdout from execFile errors (contains actual failure reason)
                      const execErr = err as { message?: string; stderr?: string; stdout?: string; code?: number; killed?: boolean; signal?: string };
                      const stderr = execErr.stderr?.slice(-1000) || '';
                      const stdout = execErr.stdout || '';
                      const exitCode = execErr.code;
                      const reason = stderr || stdout.slice(-500) || execErr.message || String(err);
                      logger.error({ err: reason.slice(0, 500), exitCode, signal: execErr.signal, stdoutLen: stdout.length }, 'Desktop Claude Code failed');
                      if (responseFile) {
                        // If killed (SIGTERM/SIGKILL) but had stdout, send output — work may be done
                        if (stdout.length > 100 && (exitCode === 143 || exitCode === 137 || execErr.killed)) {
                          writeIpcResponse(responseFile, { output: stdout.slice(-8000), partial: true });
                        } else {
                          writeIpcResponse(responseFile, { error: reason.slice(0, 2000) });
                        }
                      } else {
                        // No responseFile = fire-and-forget call, notify user
                        const mainJid = deps.getMainGroupJid?.();
                        if (mainJid) {
                          const { getNotifyJid } = await import('./notify.js');
                          await deps.sendMessage(getNotifyJid(capturedConfig.notifyTopic, mainJid), `🖥️ Desktop Claude failed: ${reason.slice(0, 200)}`);
                        }
                      }
                    } finally {
                      releaseDesktopSlot();
                    }
                  })();
                  fs.unlinkSync(filePath);
                  continue;
                }

                // ── Streaming Messages (from integration layer) ────────────
                if (data.type === 'streaming_message' && data.chatJid && data.text) {
                  try {
                    await deps.sendMessage(data.chatJid as string, data.text as string);
                    logger.debug({ chatJid: data.chatJid, preview: (data.text as string).slice(0, 50) }, 'Sent streaming message');
                  } catch (err) {
                    logger.error({ err, chatJid: data.chatJid }, 'Failed to send streaming message');
                  }
                  fs.unlinkSync(filePath);
                  continue;
                }

                if (data.type === 'remote_shell' && data.command) {
                  // Only main group can execute remote shell commands
                  if (!isMain) {
                    logger.warn({ sourceGroup }, 'Unauthorized remote_shell attempt blocked');
                    const responseFile = filePath.replace('.json', '.response.json');
                    fs.writeFileSync(responseFile, JSON.stringify({ error: 'Unauthorized: only main group can execute remote shell commands' }));
                    fs.unlinkSync(filePath);
                    continue;
                  }

                  const { executeRemoteCommand, formatRemoteShellResult, PRESET_COMMANDS } = await import('./remote-shell.js');

                  // Resolve preset commands — expand key name to actual command
                  const presetMap = PRESET_COMMANDS as Record<string, string>;
                  const command = presetMap[data.command as string] || (data.command as string);

                  const result = await executeRemoteCommand({
                    command,
                    workingDir: data.working_dir as string | undefined,
                    timeout: data.timeout as number | undefined,
                    requester: sourceGroup,
                    isPreset: (data.command as string) in presetMap,
                  });

                  const formatted = formatRemoteShellResult({ command, requester: sourceGroup }, result);

                  const responseFile = filePath.replace('.json', '.response.json');
                  fs.writeFileSync(responseFile, JSON.stringify({
                    success: result.success,
                    output: result.output,
                    formatted_output: formatted,
                    exit_code: result.exitCode,
                    duration: result.duration,
                  }));

                  fs.unlinkSync(filePath);
                  continue;
                }

                if (data.type === 'send_file' && data.chatJid && data.filePath) {
                  // Authorization: non-main groups can only send files to their own JID
                  const fileTargetGroup = registeredGroups[data.chatJid as string];
                  if (!isMain && (!fileTargetGroup || fileTargetGroup.folder !== sourceGroup)) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'SECURITY: send_file to unauthorized JID blocked',
                    );
                    fs.unlinkSync(filePath);
                    continue;
                  }
                  const rawRF = data.responseFile as string | undefined;
                  const rfPath = rawRF ? toHostIpcPath(rawRF, sourceGroup) : undefined;
                  const hostPath = toHostWorkspacePath(data.filePath as string, sourceGroup);
                  if (!fs.existsSync(hostPath)) {
                    logger.warn({ hostPath, sourceGroup }, 'send_file: file not found on host');
                    if (rfPath) writeIpcResponse(rfPath, { success: false, error: `File not found: ${data.filePath}` });
                  } else if (!deps.sendFile) {
                    logger.warn({ hostPath }, 'send_file: channel does not support file sending');
                    if (rfPath) writeIpcResponse(rfPath, { success: false, error: 'Channel does not support file sending' });
                  } else {
                    try {
                      const buffer = fs.readFileSync(hostPath);
                      const mimetype = (data.mimetype as string) || 'application/octet-stream';
                      const filename = (data.filename as string) || path.basename(hostPath);
                      const caption = (data.caption as string) || undefined;
                      const targetJid = (data.chatJid as string);
                      await deps.sendFile(targetJid, buffer, mimetype, filename, caption);
                      logger.info({ targetJid, filename, bytes: buffer.length, sourceGroup }, 'File sent via IPC');
                      if (rfPath) writeIpcResponse(rfPath, { success: true, filename, bytes: buffer.length });
                    } catch (err) {
                      const errMsg = err instanceof Error ? err.message : String(err);
                      logger.warn({ hostPath, sourceGroup, err: errMsg }, 'send_file failed');
                      if (rfPath) writeIpcResponse(rfPath, { success: false, error: errMsg });
                    }
                  }
                  fs.unlinkSync(filePath);
                  continue;
                }

                // ── Ollama Query ───────────────────────────────────────────
                if (data.type === 'ollama_query' && data.model && data.prompt) {
                  const responseFile = data.responseFile ? toHostIpcPath(data.responseFile as string, sourceGroup) : undefined;
                  const model = data.model as string;
                  const prompt = data.prompt as string;
                  const images = data.images as string[] | undefined; // base64-encoded images
                  const systemPrompt = data.system as string | undefined;

                  try {
                    const messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [];
                    if (systemPrompt) {
                      messages.push({ role: 'system', content: systemPrompt });
                    }
                    if (images && images.length > 0) {
                      // Multimodal: interleave images + text
                      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
                      for (const img of images) {
                        content.push({ type: 'image_url', image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}` } });
                      }
                      content.push({ type: 'text', text: prompt });
                      messages.push({ role: 'user', content });
                    } else {
                      messages.push({ role: 'user', content: prompt });
                    }

                    const res = await fetch('http://127.0.0.1:11434/api/chat', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ model, messages, stream: false }),
                    });

                    if (!res.ok) {
                      const errText = await res.text();
                      if (responseFile) writeIpcResponse(responseFile, { error: `Ollama error ${res.status}: ${errText.slice(0, 500)}` });
                    } else {
                      const result = await res.json() as { message?: { content?: string }; error?: string };
                      const text = result.message?.content ?? result.error ?? 'No response';
                      if (responseFile) writeIpcResponse(responseFile, { response: text, model });
                    }
                  } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    logger.error({ model, sourceGroup, err: errMsg }, 'Ollama query failed');
                    if (responseFile) writeIpcResponse(responseFile, { error: `Ollama unavailable: ${errMsg}` });
                  }

                  fs.unlinkSync(filePath);
                  continue;
                }

                // ── Spawn Gate Approval (HITL for Task/TeamCreate after web content) ──
                if (data.type === 'spawn_gate_approval' && data.responseFile) {
                  const responseFile = toHostIpcPath(data.responseFile as string, sourceGroup);
                  const mainJid = deps.getMainGroupJid?.();
                  if (!mainJid) {
                    logger.warn({ sourceGroup }, 'spawn_gate_approval: no main JID, auto-denying');
                    writeIpcResponse(responseFile, { approved: false, reason: 'Main group JID not configured' });
                    fs.unlinkSync(filePath);
                    continue;
                  }

                  const toolName = data.toolName as string || 'Unknown';
                  const description = data.description as string || '';
                  const lowTrust = data.lowTrustSource as { url?: string; domain?: string; trustScore?: number } | undefined;
                  const domain = lowTrust?.domain || 'unknown';
                  const trustScore = lowTrust?.trustScore ?? 0;

                  // Register with the spawn gate's own approval mechanism
                  // (can't use HitlGate because rejection also needs to write a response)
                  const token = crypto.randomBytes(4).toString('hex');
                  spawnGateApprovals.set(token, { responseFile, toolName, sourceGroup, expiresAt: Date.now() + 120_000 });

                  const preview = description.length > 200 ? description.slice(0, 200) + '...' : description;
                  const msg = [
                    '\u{1F6E1}\uFE0F *Spawn Gate — Approval Required*',
                    '',
                    `Agent wants to spawn *${toolName}* after fetching from a low-trust source.`,
                    '',
                    `*Source:* \`${domain}\` (Trust: ${trustScore}%)`,
                    `*Agent:* ${sourceGroup}`,
                    `*Action:* ${preview}`,
                    '',
                    `Reply *approve-spawn ${token}* to allow, or *reject-spawn ${token}* to block.`,
                    `_(expires in 2 minutes)_`,
                  ].join('\n');

                  await deps.sendMessage(mainJid, msg);
                  logger.info({ sourceGroup, toolName, domain, token }, 'Spawn gate: approval requested');

                  fs.unlinkSync(filePath);
                  continue;
                }

                if (data.type === 'react' && data.chatJid && data.messageId && data.emoji) {
                  // Authorization: non-main groups can only react in their own JID
                  const reactTargetGroup = registeredGroups[data.chatJid as string];
                  if (!isMain && (!reactTargetGroup || reactTargetGroup.folder !== sourceGroup)) {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'SECURITY: react to unauthorized JID blocked',
                    );
                    fs.unlinkSync(filePath);
                    continue;
                  }
                  if (deps.sendReaction) {
                    await deps.sendReaction(
                      data.chatJid as string,
                      data.messageId as string,
                      data.senderJid as string || '',
                      data.emoji as string,
                    ).catch((err) => logger.warn({ err }, 'IPC react failed'));
                    logger.info({ chatJid: data.chatJid, emoji: data.emoji, sourceGroup }, 'IPC reaction sent');
                  } else {
                    logger.warn({ sourceGroup }, 'react: channel does not support reactions');
                  }
                  fs.unlinkSync(filePath);
                  continue;
                }

                if (data.type === 'message' && data.chatJid && data.text) {
                  // Authorization: verify this group can send to this chatJid
                  const targetGroup = registeredGroups[data.chatJid];
                  // Look up displayName for the source group (for custom bot prefix)
                  const sourceGroupEntry = Object.values(registeredGroups).find(g => g.folder === sourceGroup);
                  const senderName = sourceGroupEntry?.displayName;
                  // Translate responseFile if present (for returning messageId)
                  const rawRF = data.responseFile as string | undefined;
                  const msgResponseFile = rawRF ? toHostIpcPath(rawRF, sourceGroup) : undefined;

                  if (isMain && !targetGroup) {
                    // HITL gate: main agent targeting an unregistered JID.
                    // This is the prompt-injection exfiltration vector — hold for approval.
                    const mainJid = deps.getMainGroupJid?.();
                    if (deps.hitlGate && mainJid) {
                      await deps.hitlGate.requestApproval(
                        data.chatJid,
                        data.text,
                        sourceGroup,
                        (msg) => deps.sendMessage(mainJid, msg),
                        () => deps.sendMessage(data.chatJid, data.text, senderName),
                      );
                    } else {
                      logger.warn(
                        { chatJid: data.chatJid, sourceGroup },
                        'HITL: unregistered JID blocked (gate not configured)',
                      );
                    }
                  } else if (
                    isMain ||
                    (targetGroup && targetGroup.folder === sourceGroup)
                  ) {
                    if (isDuplicateOutgoing(data.chatJid as string, data.text as string)) {
                      fs.unlinkSync(filePath);
                      continue;
                    }

                    // Identity layer: sign outgoing message if agent_id present
                    const agentId = data.agent_id as string | undefined;
                    if (agentId) {
                      try {
                        await signOutgoingMessage(agentId, data.text as string, data.chatJid as string);
                      } catch (err) {
                        logger.warn({ err, agentId, sourceGroup }, 'Identity: failed to sign outgoing message');
                      }
                    } else {
                      // Migration mode: record unsigned message
                      recordUnsignedMessage(sourceGroup, data.text as string, data.chatJid as string).catch(() => {});
                    }

                    // Route: interactive message (buttons) or plain text
                    const uiData = data.ui as UIMetadata | undefined;
                    let messageId: string | undefined;
                    if (uiData && deps.sendInteractiveMessage) {
                      await deps.sendInteractiveMessage(data.chatJid, uiData, senderName);
                    } else if (msgResponseFile && deps.sendMessageGetId) {
                      messageId = await deps.sendMessageGetId(data.chatJid, data.text, senderName);
                    } else {
                      await deps.sendMessage(data.chatJid, data.text, senderName);
                    }
                    deps.onAgentSendMessage?.(data.chatJid);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup, signed: !!agentId, messageId, hasUi: !!uiData },
                      'IPC message sent',
                    );
                    // Write messageId to responseFile so container can track it
                    if (msgResponseFile) {
                      writeIpcResponse(msgResponseFile, { success: true, messageId: messageId ?? null });
                    }
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'Unauthorized IPC message attempt blocked',
                    );
                  }
                }
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error(
                  { file, sourceGroup, err },
                  'Error processing IPC message',
                );
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC messages directory',
          );
        }

        // Process tasks from this group's IPC directory
        try {
          if (fs.existsSync(tasksDir)) {
            const taskFiles = fs
              .readdirSync(tasksDir)
              .filter((f) => f.endsWith('.json'))
              .sort(); // Preserve order

            for (const file of taskFiles) {
              const filePath = path.join(tasksDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                // Pass source group identity to processTaskIpc for authorization
                await processTaskIpc(data, sourceGroup, isMain, deps);
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error(
                  { file, sourceGroup, err },
                  'Error processing IPC task',
                );
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              }
            }
          }
        } catch (err) {
          logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
        }
      })
    );

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/**
 * Translate a container-relative IPC path to the host filesystem path.
 * Container sees: /workspace/ipc/messages/foo.json
 * Host maps to:   data/ipc/{groupFolder}/messages/foo.json
 */
export function toHostIpcPath(containerPath: string, groupFolder: string): string {
  const containerPrefix = '/workspace/ipc/';
  if (containerPath.startsWith(containerPrefix)) {
    return path.join(DATA_DIR, 'ipc', groupFolder, containerPath.slice(containerPrefix.length));
  }
  return containerPath; // already a host-side path
}

/**
 * Translate a container workspace path to the host filesystem path.
 * Handles all mount points:
 *   /workspace/group/  → groups/{groupFolder}/
 *   /workspace/global/ → groups/global/
 *   /workspace/ipc/    → data/ipc/{groupFolder}/
 *   /workspace/media/  → store/media/
 */
function toHostWorkspacePath(containerPath: string, groupFolder: string): string {
  if (containerPath.startsWith('/workspace/group/')) {
    return path.join(GROUPS_DIR, groupFolder, containerPath.slice('/workspace/group/'.length));
  }
  if (containerPath.startsWith('/workspace/global/')) {
    return path.join(GROUPS_DIR, 'global', containerPath.slice('/workspace/global/'.length));
  }
  if (containerPath.startsWith('/workspace/ipc/')) {
    return toHostIpcPath(containerPath, groupFolder);
  }
  if (containerPath.startsWith('/workspace/media/')) {
    return path.join(STORE_DIR, 'media', containerPath.slice('/workspace/media/'.length));
  }
  return containerPath;
}

export function writeIpcResponse(responseFile: string, data: object): void {
  const tmp = `${responseFile}.tmp`;
  fs.mkdirSync(path.dirname(responseFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, responseFile);
}

// ── Spawn Gate Approval (HITL for Task/TeamCreate after web content) ──────────

interface PendingSpawnApproval {
  responseFile: string;
  toolName: string;
  sourceGroup: string;
  expiresAt: number;
}

const spawnGateApprovals = new Map<string, PendingSpawnApproval>();
const SPAWN_APPROVAL_PATTERN = /\b(approve-spawn|reject-spawn)\s+([a-f0-9]{8})\b/i;

/**
 * Check if a message contains a spawn gate approval/rejection token.
 * Writes the IPC response file so the container's polling hook unblocks.
 * Returns true if the message was a spawn gate command (handled or not).
 */
export async function tryHandleSpawnApproval(
  message: string,
  notifyFn: (text: string) => Promise<void>,
): Promise<boolean> {
  // Cleanup expired approvals
  const now = Date.now();
  for (const [token, pending] of spawnGateApprovals) {
    if (pending.expiresAt < now) {
      spawnGateApprovals.delete(token);
      logger.info({ token, toolName: pending.toolName }, 'Spawn gate: approval expired');
    }
  }

  const match = message.match(SPAWN_APPROVAL_PATTERN);
  if (!match) return false;

  const [, action, token] = match;
  const pending = spawnGateApprovals.get(token.toLowerCase());

  if (!pending) {
    await notifyFn(`No pending spawn approval found for token *${token}*. It may have expired.`);
    return true;
  }

  spawnGateApprovals.delete(token.toLowerCase());

  if (action.toLowerCase() === 'approve-spawn') {
    writeIpcResponse(pending.responseFile, { approved: true });
    await notifyFn(`\u2705 Spawn approved: *${pending.toolName}* in ${pending.sourceGroup}`);
    logger.info({ token, toolName: pending.toolName, sourceGroup: pending.sourceGroup }, 'Spawn gate: approved');
  } else {
    writeIpcResponse(pending.responseFile, { approved: false, reason: 'User rejected' });
    await notifyFn(`\u274C Spawn rejected: *${pending.toolName}* in ${pending.sourceGroup}`);
    logger.info({ token, toolName: pending.toolName, sourceGroup: pending.sourceGroup }, 'Spawn gate: rejected');
  }

  return true;
}

async function processIpcMessage(
  data: Record<string, unknown>,
  groupFolder: string,
  messagesDir: string,
  deps: IpcDeps,
): Promise<void> {
  // Translate container IPC path → host path so we can write the response
  const rawResponseFile = data.responseFile as string | undefined;
  const responseFile = rawResponseFile ? toHostIpcPath(rawResponseFile, groupFolder) : undefined;

  switch (data.type) {
    case 'learn': {
      const topic = data.topic as string;
      const knowledge = data.knowledge as string;
      if (topic && knowledge) {
        // Spawn Gate: rate limit learns to prevent memory flooding
        const learnRateCheck = spawnGate.checkLearnRate(groupFolder);
        if (!learnRateCheck.allowed) {
          logger.warn({ groupFolder, reason: learnRateCheck.reason }, 'SpawnGate blocked learn');
          if (responseFile) writeIpcResponse(responseFile, { error: learnRateCheck.reason });
          break;
        }

        // Memory Poisoning Defense: validate learned facts for prompt injection
        const topicCheck = detectPromptInjection(topic);
        const knowledgeCheck = detectPromptInjection(knowledge);
        if (!topicCheck.safe || !knowledgeCheck.safe) {
          const riskSource = !topicCheck.safe ? 'topic' : 'knowledge';
          const riskScore = Math.max(topicCheck.riskScore, knowledgeCheck.riskScore);
          logger.warn({
            groupFolder,
            topic,
            riskSource,
            riskScore,
            threats: [...topicCheck.threats, ...knowledgeCheck.threats].map(t => t.type),
          }, 'Memory poisoning attempt blocked — learn rejected');
          if (responseFile) writeIpcResponse(responseFile, { error: 'Content blocked by security filter', riskScore });
          break;
        }

        const domain = (data.domain as string) || 'nanoclaw';
        saveLearn(domain, topic, knowledge);

        // Determine target file: integration learnings path, or group MEMORY.md
        let targetPath: string;
        const sectionHeading = '## Learned Facts';
        if (domain !== 'nanoclaw') {
          const integration = getIntegration(domain);
          targetPath = integration?.getLearningsPath?.()
            || path.join(GROUPS_DIR, groupFolder, 'MEMORY.md');
        } else {
          targetPath = path.join(GROUPS_DIR, groupFolder, 'MEMORY.md');
        }

        // Append as list item under "## Learned Facts" section
        const listItem = `- **${topic}:** ${knowledge}`;
        try {
          let content = '';
          try { content = fs.readFileSync(targetPath, 'utf-8'); } catch { /* file may not exist */ }

          const sectionIdx = content.indexOf(sectionHeading);
          if (sectionIdx !== -1) {
            // Find end of section (next ## heading or end of file)
            const afterHeader = content.indexOf('\n', sectionIdx);
            const nextSection = content.indexOf('\n## ', afterHeader + 1);
            const insertAt = nextSection === -1 ? content.length : nextSection;
            const updated = content.slice(0, insertAt).trimEnd() + '\n' + listItem + '\n' + content.slice(insertAt);
            const tmpPath = targetPath + '.tmp';
            fs.writeFileSync(tmpPath, updated);
            fs.renameSync(tmpPath, targetPath);
          } else {
            // Section doesn't exist — append it
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.appendFileSync(targetPath, `\n${sectionHeading}\n${listItem}\n`);
          }
        } catch (err) {
          logger.warn({ err, targetPath }, 'Failed to write learning to file');
        }

        // Update hot cache so learning is visible immediately (no restart needed)
        learnFact(topic, knowledge, 0.85, 'learn');

        // Write Obsidian Brain Vault note (non-blocking, fail-safe)
        try {
          const learnDir = path.join(BRAIN_VAULT_PATH, 'Learnings');
          if (fs.existsSync(BRAIN_VAULT_PATH)) {
            fs.mkdirSync(learnDir, { recursive: true });
            const slug = topic.replace(/[^a-zA-Z0-9\-_ ]/g, '').replace(/\s+/g, '-').toLowerCase().slice(0, 80);
            const date = new Date().toISOString().slice(0, 10);
            const notePath = path.join(learnDir, `${date}_${slug}.md`);
            const note = `---\ntags: [learning, ${domain}]\ndomain: ${domain}\ncreated: ${new Date().toISOString()}\nsource: ${groupFolder}\n---\n\n# ${topic}\n\n${knowledge}\n`;
            fs.writeFileSync(notePath, note);
          }
        } catch { /* vault may not exist — that's fine */ }

        if (responseFile) writeIpcResponse(responseFile, { success: true, topic, knowledge_length: knowledge.length });
        logger.info({ groupFolder, domain, topic, length: knowledge.length }, 'Learn: saved');
      } else {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Missing topic or knowledge' });
      }
      break;
    }

    case 'propose_deliverable': {
      const gigId = data.gig_id as string;
      const gigTitle = data.gig_title as string;
      const workSummary = data.work_summary as string;
      const clientInfo = data.client_info as string | undefined;
      const deliverablePath = data.deliverable_path as string | undefined;

      if (!gigId || !gigTitle || !workSummary) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Missing required fields: gig_id, gig_title, work_summary' });
        break;
      }

      if (!deps.deliverableGate) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'DeliverableGate not configured' });
        break;
      }

      // Find the freelance group's JID to send notification there
      const allGroups = deps.registeredGroups();
      const freelanceEntry = Object.entries(allGroups).find(([, g]) => g.folder === groupFolder);
      const notifyJid = freelanceEntry?.[0] || deps.getMainGroupJid?.();
      if (!notifyJid) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'No JID available for notifications' });
        break;
      }

      const token = deps.deliverableGate.proposeDeliverable(
        gigId,
        gigTitle,
        workSummary,
        groupFolder,
        () => { logger.info({ gigId }, 'Deliverable approved'); },
        () => { logger.info({ gigId }, 'Deliverable rejected'); },
        clientInfo,
        deliverablePath,
      );

      const msg = DeliverableGate.formatProposalMessage(gigId, gigTitle, workSummary, token, clientInfo, deliverablePath);
      await deps.sendMessage(notifyJid, msg);

      if (responseFile) writeIpcResponse(responseFile, { proposed: true, token });
      logger.info({ groupFolder, gigId, token }, 'Freelance: propose_deliverable processed');
      break;
    }

    // ── Implementation Gate (branch-based approval) ─────────────────
    case 'propose_implementation': {
      const taskId = data.task_id as string;
      const branch = data.branch as string;
      const summary = data.summary as string;
      const repoPath = data.repo_path as string;
      const filesChanged = data.files_changed as number | undefined;
      const insertions = data.insertions as number | undefined;
      const deletions = data.deletions as number | undefined;

      if (!taskId || !branch || !summary) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Missing task_id, branch, or summary' });
        break;
      }

      if (!deps.implementationGate) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'ImplementationGate not configured' });
        break;
      }

      const mainJid = deps.getMainGroupJid?.();
      if (!mainJid) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Main group JID not configured' });
        break;
      }

      const msg = deps.implementationGate.propose({
        taskId,
        branch,
        repoPath: repoPath || process.cwd(),
        summary,
        filesChanged,
        insertions,
        deletions,
      });

      const { getNotifyJid: _getNotifyJid } = await import('./notify.js');
      const notifyJid = _getNotifyJid('desktop', mainJid);
      await deps.sendMessage(notifyJid, msg);

      if (responseFile) writeIpcResponse(responseFile, { proposed: true, task_id: taskId });
      logger.info({ groupFolder, taskId, branch }, 'Implementation proposed for approval');
      break;
    }

    // ── Task System (evolved from TodoWrite) ────────────────────────
    case 'task_tool': {
      const { executeTaskTool } = await import('./mcp/tools/task-tool.js');
      const result = await executeTaskTool(data as any);
      if (responseFile) writeIpcResponse(responseFile, { result });
      // Sync kanban file after any task mutation
      if (['create', 'update', 'delete'].includes(data.action as string)) {
        const { syncKanbanFile } = await import('./db.js');
        syncKanbanFile();
      }
      logger.debug({ groupFolder, action: data.action }, 'TaskTool processed');
      break;
    }

    // ── GSD (Get Shit Done) — Spec-driven development ────────────
    case 'gsd_tool': {
      const { executeGsdTool } = await import('./mcp/tools/gsd-tool.js');
      const result = await executeGsdTool(data as any);
      if (responseFile) writeIpcResponse(responseFile, { result });
      logger.debug({ groupFolder, action: data.action }, 'GsdTool processed');
      break;
    }

    // ── Agent Monitoring ─────────────────────────────────────────
    case 'generate_safety_brief': {
      try {
        const { generateDailySafetyBrief } = await import('./agent-monitoring-system.js');
        const { getIdentitySafetyFindings } = await import('./identity/ipc-handlers.js');
        const brief = await generateDailySafetyBrief(data.date as string | undefined);

        // Append identity layer findings
        let identitySection = '';
        try {
          const findings = await getIdentitySafetyFindings();
          if (findings.length > 0) {
            identitySection = '\n\n## Agent Identity & Trust\n' + findings.map(f => `- ${f}`).join('\n');
          }
        } catch (err) {
          identitySection = '\n\n## Agent Identity & Trust\n- Error checking identity layer: ' + (err instanceof Error ? err.message : String(err));
        }

        if (responseFile) writeIpcResponse(responseFile, { brief: brief + identitySection });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder }, 'generate_safety_brief failed');
      }
      break;
    }

    case 'monitoring_log': {
      try {
        const { logAction, detectSelfModification, detectIntentDrift } = await import('./agent-monitoring-system.js');

        // Log the action to the database
        logAction({
          timestamp: data.timestamp as string || new Date().toISOString(),
          action_type: data.action_type as 'bash' | 'file_edit' | 'mcp_call' | 'agent_spawn' | 'api_call',
          command: data.command as string | undefined,
          file_path: data.file_path as string | undefined,
          risk_score: data.risk_score as number || 0,
          flagged: data.flagged as boolean || false,
          flag_reason: data.flag_reason as string | undefined,
          group_folder: groupFolder,
          task_id: data.task_id as string | undefined,
        });

        // Handle self-modification detection
        if (data.is_self_modification && data.file_path) {
          detectSelfModification(data.file_path as string, groupFolder, data.task_id as string | undefined);
        }

        // Handle intent drift signals embedded in monitoring logs
        if (data.command && (data.command as string).startsWith('[INTENT_DRIFT]') && data.task_id) {
          const observed = (data.command as string).replace('[INTENT_DRIFT] ', '');
          detectIntentDrift(data.task_id as string, observed);
        }
      } catch (err) {
        logger.error({ err, groupFolder }, 'monitoring_log handler failed');
      }
      break;
    }

    // ── Shared Items Inbox ─────────────────────────────────────────
    case 'shared_items': {
      const action = data.action as string;
      try {
        switch (action) {
          case 'list': {
            const status = (data.status as string) || 'new';
            const limit = typeof data.limit === 'number' ? data.limit : 20;
            const items = getSharedItems(status, limit);
            if (items.length === 0) {
              if (responseFile) writeIpcResponse(responseFile, { result: `No ${status} items in your shared inbox.` });
            } else {
              const formatted = items.map((item, i) =>
                `[${i + 1}] ${item.id}\n    Type: ${item.item_type} | Category: ${item.category} | Status: ${item.status}\n    Content: ${item.content.slice(0, 200)}${item.content.length > 200 ? '...' : ''}${item.url ? `\n    URL: ${item.url}` : ''}${item.notes ? `\n    Notes: ${item.notes}` : ''}\n    Created: ${item.created_at}`
              ).join('\n\n');
              if (responseFile) writeIpcResponse(responseFile, { result: `${items.length} ${status} item(s):\n\n${formatted}` });
            }
            break;
          }
          case 'get': {
            const id = data.id as string;
            if (!id) { if (responseFile) writeIpcResponse(responseFile, { error: 'Missing id' }); break; }
            const item = getSharedItemById(id);
            if (!item) { if (responseFile) writeIpcResponse(responseFile, { error: `Item not found: ${id}` }); break; }
            if (responseFile) writeIpcResponse(responseFile, { result: JSON.stringify(item, null, 2) });
            break;
          }
          case 'triage': {
            const id = data.id as string;
            const notes = data.notes as string | undefined;
            if (!id) { if (responseFile) writeIpcResponse(responseFile, { error: 'Missing id' }); break; }
            const ok = updateSharedItemStatus(id, 'triaged', notes);
            if (responseFile) writeIpcResponse(responseFile, { result: ok ? `Item ${id} triaged.` : `Item not found: ${id}` });
            break;
          }
          case 'act': {
            const id = data.id as string;
            const notes = data.notes as string | undefined;
            if (!id) { if (responseFile) writeIpcResponse(responseFile, { error: 'Missing id' }); break; }
            const ok = updateSharedItemStatus(id, 'acted_on', notes);
            if (responseFile) writeIpcResponse(responseFile, { result: ok ? `Item ${id} marked as acted_on.` : `Item not found: ${id}` });
            break;
          }
          case 'archive': {
            const id = data.id as string;
            if (!id) { if (responseFile) writeIpcResponse(responseFile, { error: 'Missing id' }); break; }
            const ok = updateSharedItemStatus(id, 'archived');
            if (responseFile) writeIpcResponse(responseFile, { result: ok ? `Item ${id} archived.` : `Item not found: ${id}` });
            break;
          }
          default:
            if (responseFile) writeIpcResponse(responseFile, { error: `Unknown action: ${action}` });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder, action }, 'shared_items handler failed');
      }
      logger.debug({ groupFolder, action }, 'shared_items processed');
      break;
    }

    // ── Gmail Cleanup (HITL-gated) ────────────────────────────────
    case 'gmail_cleanup': {
      const action = data.action as 'trash' | 'archive';
      const messageIds = data.message_ids as string[];
      const summary = data.summary as string;
      const breakdown = data.breakdown as string;

      if (!deps.cleanupGate) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'CleanupGate not configured' });
        break;
      }

      if (groupFolder !== MAIN_GROUP_FOLDER) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Gmail cleanup only allowed from main group' });
        break;
      }

      const mainJid = deps.getMainGroupJid?.();
      if (!mainJid) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Main group JID not configured' });
        break;
      }

      try {
        const token = deps.cleanupGate.propose({
          action,
          messageIds,
          summary,
          breakdown,
          groupFolder,
        });

        const msg = CleanupGate.formatProposalMessage(
          { action, messageIds, summary, breakdown, groupFolder },
          token,
        );
        const { getNotifyJid: _getNotifyJid3 } = await import('./notify.js');
        await deps.sendMessage(_getNotifyJid3('desktop', mainJid), msg);

        if (responseFile) writeIpcResponse(responseFile, { status: 'pending_approval', token });
        logger.info({ groupFolder, action, count: messageIds.length, token }, 'Gmail cleanup proposal sent');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder }, 'Gmail cleanup proposal failed');
      }
      break;
    }

    // ── Token Refresh (container-initiated) ─────────────────────────
    case 'token_refresh': {
      try {
        const fresh = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
        const token = fresh.CLAUDE_CODE_OAUTH_TOKEN;
        if (token) {
          const currentPrefix = data.currentTokenPrefix as string | undefined;
          const changed = !currentPrefix || !token.startsWith(currentPrefix);
          if (responseFile) writeIpcResponse(responseFile, { token });
          logger.info(
            { groupFolder, changed },
            `Token refresh: responded with ${changed ? 'new' : 'same'} token`,
          );
        } else {
          if (responseFile) writeIpcResponse(responseFile, { error: 'No CLAUDE_CODE_OAUTH_TOKEN in .env' });
          logger.warn({ groupFolder }, 'Token refresh: no token found in .env');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder }, 'Token refresh failed');
      }
      break;
    }

    // ── Competitive Intelligence (quarterly monitoring) ──────────
    case 'competitive_intel_check': {
      try {
        const result = await handleCompetitiveIntelIpc(data as any);
        if (responseFile) writeIpcResponse(responseFile, result);
      } catch (err) {
        logger.error({ err }, 'Competitive intel IPC handler error');
        if (responseFile) writeIpcResponse(responseFile, { error: String(err) });
      }
      break;
    }

    // ── Autoresearch (experiment engine) ──────────────────────────
    case 'autoresearch': {
      try {
        const result = await handleAutoresearchIpc(data as any);
        if (responseFile) writeIpcResponse(responseFile, result);
      } catch (err) {
        logger.error({ err }, 'Autoresearch IPC handler error');
        if (responseFile) writeIpcResponse(responseFile, { error: String(err) });
      }
      break;
    }

    default:
      logger.warn({ type: data.type, groupFolder }, 'Unknown ClawWork IPC type');
  }
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For spawn_team
    goal?: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    targetValue?: number;
    deadline?: string;
    // For restart_service
    summary?: string;
    // For dispatch_task
    description?: string;
    role?: string;
    responseFile?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Spawn Gate: rate limit + prompt injection check on scheduled tasks
        const spawnCheck = await spawnGate.checkTaskSchedule(sourceGroup, data.prompt as string);
        if (!spawnCheck.allowed) {
          logger.warn({ sourceGroup, reason: spawnCheck.reason }, 'SpawnGate blocked schedule_task');
          break;
        }

        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        // Security: max 10 active tasks per group
        const MAX_ACTIVE_TASKS_PER_GROUP = 10;
        const existingTasks = getTasksForGroup(targetFolder).filter(t => t.status === 'active');
        if (existingTasks.length >= MAX_ACTIVE_TASKS_PER_GROUP) {
          logger.warn(
            { sourceGroup, targetFolder, activeCount: existingTasks.length },
            'schedule_task blocked: max active tasks exceeded',
          );
          break;
        }

        // Security: minimum 5-minute interval for recurring tasks
        const MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
        if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (!isNaN(ms) && ms < MIN_INTERVAL_MS) {
            logger.warn(
              { sourceGroup, intervalMs: ms },
              'schedule_task blocked: interval below 5-minute minimum',
            );
            break;
          }
        }

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            const first = interval.next().toDate();
            const second = interval.next().toDate();
            const gapMs = second.getTime() - first.getTime();
            if (gapMs < MIN_INTERVAL_MS) {
              logger.warn(
                { sourceGroup, cron: data.schedule_value, gapMs },
                'schedule_task blocked: cron runs more frequently than 5-minute minimum',
              );
              break;
            }
            nextRun = first.toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );

        // Refresh the tasks snapshot so the container sees the new task
        const allTasks = getAllTasks();
        const isTargetMain = targetFolder === MAIN_GROUP_FOLDER;
        writeTasksSnapshot(
          targetFolder,
          isTargetMain,
          allTasks.map((t) => ({
            id: t.id,
            groupFolder: t.group_folder,
            prompt: t.prompt,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
          })),
        );
        // Also refresh source group's snapshot if different
        if (sourceGroup !== targetFolder) {
          const isSourceMain = sourceGroup === MAIN_GROUP_FOLDER;
          writeTasksSnapshot(
            sourceGroup,
            isSourceMain,
            allTasks.map((t) => ({
              id: t.id,
              groupFolder: t.group_folder,
              prompt: t.prompt,
              schedule_type: t.schedule_type,
              schedule_value: t.schedule_value,
              status: t.status,
              next_run: t.next_run,
            })),
          );
        }
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'restart_service':
      // Only main group can restart the service
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Service restart requested via IPC - initiating graceful shutdown',
        );
        // Write breadcrumb so next startup can notify the user
        try {
          const breadcrumb = {
            reason: 'agent_deploy',
            sourceGroup,
            timestamp: new Date().toISOString(),
            summary: data.summary || 'Code changes deployed',
          };
          fs.writeFileSync(
            path.join(DATA_DIR, 'restart-reason.json'),
            JSON.stringify(breadcrumb),
          );
        } catch { /* best-effort */ }
        // Graceful shutdown - launchd will restart automatically if KeepAlive is enabled
        setTimeout(() => {
          logger.info('Exiting for restart (exit code 0)');
          process.exit(0);
        }, 1000);
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized restart_service attempt blocked',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'spawn_team':
      // Only main group can spawn teams (requires elevated permissions)
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized spawn_team attempt blocked',
        );
        break;
      }

      if (data.goal && data.chatJid) {
        try {
          // Dynamically import the orchestrator (only loaded when needed)
          const { OrchestratorFactory } = await import('./nanoclaw-orchestrator.js');
          const orchestrator = OrchestratorFactory.create(path.join(STORE_DIR, 'nanoclaw.db'));

          const result = await orchestrator.processGoal({
            description: data.goal as string,
            targetValue: data.targetValue as number | undefined,
            deadline: data.deadline ? new Date(data.deadline as string) : undefined,
            priority: (data.priority as 'critical' | 'high' | 'medium' | 'low') || 'high',
            source: 'user',
          });

          // Send acknowledgment to user
          await deps.sendMessage(data.chatJid, result.acknowledgment);

          logger.info(
            { goal: data.goal, teamsFormed: result.teamsFormed, tasksCreated: result.tasksCreated },
            'Team spawned successfully',
          );
        } catch (err) {
          logger.error({ err, goal: data.goal }, 'Team spawn failed');
          await deps.sendMessage(
            data.chatJid,
            `❌ Team spawn failed: ${(err as Error).message}`,
          );
        }
      } else {
        logger.warn({ data }, 'Invalid spawn_team request - missing goal or chatJid');
      }
      break;

    case 'dispatch_task': {
      // Manual dispatch via WhatsApp: agent requests a specific persona for a task
      if (!isMain) break;
      const taskDesc = data.description as string;
      const preferredRole = data.role as string | undefined;
      if (!taskDesc) break;

      try {
        const { PersonaRegistry } = await import('./persona-registry.js');
        const { getDb } = await import('./db.js');
        const registry = new PersonaRegistry(getDb());
        registry.initSchema();
        await registry.scan();

        const match = registry.findBestPersona(taskDesc, preferredRole);
        if (match && match.confidence > 0.2) {
          const responseFile = data.responseFile as string | undefined;
          if (responseFile) {
            const result = {
              matched: true,
              persona: match.persona.name,
              department: match.persona.department,
              confidence: match.confidence,
              matchedKeywords: match.matchedKeywords,
            };
            fs.writeFileSync(responseFile, JSON.stringify(result, null, 2));
          }
        } else {
          const responseFile = data.responseFile as string | undefined;
          if (responseFile) {
            fs.writeFileSync(responseFile, JSON.stringify({ matched: false }));
          }
        }
      } catch (err) {
        logger.warn({ err }, 'dispatch_task IPC handler error');
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
