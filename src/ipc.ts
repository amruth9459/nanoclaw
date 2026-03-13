import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  PAYPAL_EMAIL,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import { getIntegrations } from './integration-loader.js';
import { AvailableGroup } from './container-runner.js';
import {
  addEarnings,
  createBountyOpportunity,
  createTask,
  deleteTask,
  getActiveTask,
  getAllBounties,
  getOrCreateEconomics,
  getTaskById,
  saveLearn,
  updateBountyStatus,
  updateTask,
  updateTaskEvaluation,
  updateTaskSubmission,
} from './db.js';
import { evaluateWork } from './clawwork.js';
import { Bounty, findBounties } from './bounty-hunter.js';
import { BountyGate } from './bounty-gate.js';
import { CleanupGate } from './cleanup-gate.js';
import { learnFact } from './context/index.js';
import { readEnvFile } from './env.js';
import { getSurvivalTier } from './economics.js';
import { HitlGate } from './hitl.js';
import { getIntegration } from './integration-loader.js';
import { logger } from './logger.js';
import { indexDocument, semanticSearch } from './semantic-index.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendReaction?: (jid: string, messageId: string, senderJid: string, emoji: string) => Promise<void>;
  sendFile?: (jid: string, buffer: Buffer, mimetype: string, filename: string, caption?: string) => Promise<void>;
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
  /** Bounty gate — HITL approval for bounty proposals */
  bountyGate?: BountyGate;
  /** Cleanup gate — HITL approval for Gmail cleanup operations */
  cleanupGate?: CleanupGate;
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

// ── Desktop Claude concurrency semaphore ──────────────────────────────
// Serialize desktop_claude spawns to prevent FD exhaustion from parallel claude -p
let activeDesktopClaude = 0;
const MAX_CONCURRENT_DESKTOP = 5;
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
            .filter(f => f.endsWith('.search.json') || f.endsWith('.index.json'));
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
                const response = results
                  ? { results }
                  : { error: 'Search failed — check ANTHROPIC_API_KEY and index status' };
                fs.mkdirSync(path.dirname(responseFile), { recursive: true });
                fs.writeFileSync(responseFile + '.tmp', JSON.stringify(response));
                fs.renameSync(responseFile + '.tmp', responseFile);
              } else if (req.type === 'index_document') {
                indexDocument(req.source, req.groupFolder, req.content).catch(err =>
                  logger.warn({ source: req.source, err }, 'Background indexing failed'),
                );
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

                // ── ClawWork + Bounty IPC handlers ─────────────────────────
                const CLAWWORK_BOUNTY_TYPES = new Set([
                  'clawwork_get_status', 'clawwork_decide_activity', 'clawwork_learn', 'learn', 'clawwork_submit_work',
                  'find_bounties', 'propose_bounty', 'submit_bounty',
                  'token_refresh',
                ]);
                if (data.type && CLAWWORK_BOUNTY_TYPES.has(data.type)) {
                  await processClawworkMessage(data, sourceGroup, messagesDir, deps);
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
                      const { execFile } = await import('child_process');
                      const { promisify } = await import('util');
                      const execFileAsync = promisify(execFile);
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

                      // Build CLI args — budget only if explicitly set
                      const cliArgs = [
                        '-p', prompt,
                        '--output-format', 'text',
                        // Full tool access — same as interactive Claude Code
                        '--allowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
                          'Bash', 'WebFetch', 'WebSearch', 'Agent',
                      ];
                      if (maxBudget > 0) {
                        cliArgs.push('--max-budget-usd', String(maxBudget));
                      }

                      // Resolve claude binary — launchd PATH may not include /opt/homebrew/bin
                      const claudeBin = process.env.CLAUDE_BIN || '/opt/homebrew/bin/claude';
                      logger.info({ prompt: prompt.slice(0, 200), workdir: resolved, maxBudget: maxBudget || 'unlimited' }, 'Spawning desktop Claude Code');
                      const { stdout, stderr } = await execFileAsync(
                        claudeBin,
                        cliArgs,
                        {
                          cwd: resolved,
                          timeout: 5_400_000, // 90 min — complex tasks need time
                          maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
                          env: {
                            ...process.env,
                            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                            PATH: `/opt/homebrew/bin:${process.env.PATH || '/usr/bin:/bin'}`,
                          },
                        },
                      );
                      const output = stdout || stderr || 'Completed with no output.';
                      logger.info({ outputLen: output.length }, 'Desktop Claude Code completed');

                      // ── Notify user via WhatsApp if git push detected ──
                      if (/git\s+push|pushed\s+to|->/.test(output)) {
                        const mainJid = deps.getMainGroupJid?.();
                        if (mainJid) {
                          const { getNotifyJid } = await import('./notify.js');
                          const summary = prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '');
                          await deps.sendMessage(getNotifyJid(capturedConfig.notifyTopic, mainJid), `🖥️ Desktop Claude pushed code.\nTask: ${summary}`);
                        }
                      }

                      if (responseFile) {
                        writeIpcResponse(responseFile, { output });
                      }
                    } catch (err: unknown) {
                      // Extract stderr/stdout from execFile errors (contains actual failure reason)
                      const execErr = err as { message?: string; stderr?: string; stdout?: string; code?: number };
                      const stderr = execErr.stderr?.slice(-1000) || '';
                      const stdout = execErr.stdout?.slice(-500) || '';
                      const exitCode = execErr.code;
                      const reason = stderr || stdout || execErr.message || String(err);
                      logger.error({ err: reason.slice(0, 500), exitCode }, 'Desktop Claude Code failed');
                      if (responseFile) {
                        // Error goes back to calling container — don't spam user
                        writeIpcResponse(responseFile, { error: reason.slice(0, 2000) });
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

                if (data.type === 'react' && data.chatJid && data.messageId && data.emoji) {
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
                        () => deps.sendMessage(data.chatJid, data.text),
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
                    await deps.sendMessage(data.chatJid, data.text);
                    deps.onAgentSendMessage?.(data.chatJid);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'IPC message sent',
                    );
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

async function processClawworkMessage(
  data: Record<string, unknown>,
  groupFolder: string,
  messagesDir: string,
  deps: IpcDeps,
): Promise<void> {
  // Translate container IPC path → host path so we can write the response
  const rawResponseFile = data.responseFile as string | undefined;
  const responseFile = rawResponseFile ? toHostIpcPath(rawResponseFile, groupFolder) : undefined;

  switch (data.type) {
    case 'clawwork_get_status': {
      const econ = getOrCreateEconomics(groupFolder);
      const activeTask = getActiveTask(groupFolder);
      const response = {
        balance: econ.balance,
        total_earned: econ.total_earned,
        total_spent: econ.total_spent,
        tier: getSurvivalTier(econ.balance),
        active_task: activeTask ? {
          id: activeTask.id,
          occupation: activeTask.occupation,
          prompt: activeTask.prompt,
          max_payment: activeTask.max_payment,
          status: activeTask.status,
        } : null,
      };
      if (responseFile) writeIpcResponse(responseFile, response);
      logger.debug({ groupFolder }, 'ClawWork: get_status processed');
      break;
    }

    case 'clawwork_decide_activity': {
      // Fire-and-forget: just log the decision
      logger.info(
        { groupFolder, activity: data.activity, reasoning: data.reasoning },
        'ClawWork: activity decision',
      );
      // No response needed for fire-and-forget
      break;
    }

    case 'learn':
    case 'clawwork_learn': {
      const topic = data.topic as string;
      const knowledge = data.knowledge as string;
      if (topic && knowledge) {
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

        if (responseFile) writeIpcResponse(responseFile, { success: true, topic, knowledge_length: knowledge.length });
        logger.info({ groupFolder, domain, topic, length: knowledge.length }, 'Learn: saved');
      } else {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Missing topic or knowledge' });
      }
      break;
    }

    case 'clawwork_submit_work': {
      const workOutput = data.work_output as string;
      const artifactPaths = (data.artifact_file_paths as string[]) ?? [];

      const task = getActiveTask(groupFolder);
      if (!task) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'No active task assigned' });
        break;
      }

      const { score, feedback } = await evaluateWork(task, workOutput, artifactPaths);
      const payment = score >= 0.6 ? Math.round(score * task.max_payment * 100) / 100 : 0;

      updateTaskSubmission(task.id, workOutput, artifactPaths);
      updateTaskEvaluation(task.id, score, payment);
      if (payment > 0) addEarnings(groupFolder, payment);

      if (responseFile) {
        writeIpcResponse(responseFile, {
          accepted: score >= 0.6,
          evaluation_score: score,
          payment,
          feedback,
          success: true,
        });
      }
      logger.info({ groupFolder, taskId: task.id, score, payment }, 'ClawWork: work evaluated');
      break;
    }

    case 'find_bounties': {
      const limit = typeof data.limit === 'number' ? data.limit : 20;
      const bounties = await findBounties(limit);
      // Store any new bounties in DB so they can be referenced by propose_bounty
      for (const b of bounties) {
        try {
          createBountyOpportunity({
            id: b.id,
            group_id: groupFolder,
            platform: b.platform,
            title: b.title,
            url: b.url,
            reward_usd: b.reward_usd,
            reward_raw: b.reward_raw,
            description: b.description ?? '',
          });
        } catch { /* already exists */ }
      }
      if (responseFile) {
        writeIpcResponse(responseFile, { bounties: bounties.map(b => ({
          id: b.id,
          platform: b.platform,
          title: b.title,
          url: b.url,
          reward_usd: b.reward_usd,
          reward_raw: b.reward_raw,
          repo: b.repo,
        })) });
      }
      logger.info({ groupFolder, count: bounties.length }, 'Bounty: find_bounties processed');
      break;
    }

    case 'propose_bounty': {
      const bountyId = data.bounty_id as string;
      const reason = data.reason as string | undefined;

      if (!bountyId) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Missing bounty_id' });
        break;
      }

      // Find the bounty in DB (must have been fetched via find_bounties first)
      const storedBounties = getAllBounties(100);
      const storedBounty = storedBounties.find(b => b.id === bountyId);
      if (!storedBounty) {
        if (responseFile) writeIpcResponse(responseFile, { error: `Bounty not found: ${bountyId}` });
        break;
      }

      const bountyObj: Bounty = {
        id: storedBounty.id,
        platform: storedBounty.platform as 'algora' | 'github',
        title: storedBounty.title,
        url: storedBounty.url,
        reward_usd: storedBounty.reward_usd,
        reward_raw: storedBounty.reward_raw ?? '',
        description: storedBounty.description ?? '',
      };

      if (!deps.bountyGate) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'BountyGate not configured' });
        break;
      }

      const mainJid = deps.getMainGroupJid?.();
      if (!mainJid) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Main group JID not configured' });
        break;
      }

      const token = deps.bountyGate.proposeBounty(
        bountyObj,
        groupFolder,
        () => { updateBountyStatus(bountyId, 'approved'); },
        () => { updateBountyStatus(bountyId, 'rejected'); },
      );

      const reasonLine = reason ? `\nReason: ${reason}` : '';
      const msg = BountyGate.formatProposalMessage(bountyObj, token) + reasonLine;
      await deps.sendMessage(mainJid, msg);

      if (responseFile) writeIpcResponse(responseFile, { proposed: true, token });
      logger.info({ groupFolder, bountyId, token }, 'Bounty: propose_bounty processed');
      break;
    }

    case 'submit_bounty': {
      const bountyId = data.bounty_id as string;
      const workSummary = data.work_summary as string | undefined;
      const prUrl = data.pr_url as string | undefined;
      const notes = data.submission_notes as string | undefined;

      if (!bountyId) {
        if (responseFile) writeIpcResponse(responseFile, { error: 'Missing bounty_id' });
        break;
      }

      updateBountyStatus(bountyId, 'submitted', notes);

      const mainJid = deps.getMainGroupJid?.();
      if (mainJid) {
        const prLine = prUrl ? `\nPR: ${prUrl}` : '';
        const summaryLine = workSummary ? `\nSummary: ${workSummary.slice(0, 200)}` : '';
        const paypalLine = PAYPAL_EMAIL ? `\nPayPal: ${PAYPAL_EMAIL}` : '';
        await deps.sendMessage(mainJid,
          `📤 *Bounty Submitted*\nID: ${bountyId}${prLine}${summaryLine}${paypalLine}`,
        ).catch(err => logger.warn({ err }, 'Failed to notify bounty submission'));
      }

      if (responseFile) {
        writeIpcResponse(responseFile, {
          submitted: true,
          paypal_email: PAYPAL_EMAIL || null,
        });
      }
      logger.info({ groupFolder, bountyId }, 'Bounty: submit_bounty processed');
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
        await deps.sendMessage(mainJid, msg);

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

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
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
