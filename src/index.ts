import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  AUTO_CLAWWORK,
  BOUNTY_HUNT_INTERVAL_MS,
  COST_FOOTER,
  DATA_DIR,
  EARNING_GOAL,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  INSTANT_ACK,
  MAIN_GROUP_FOLDER,
  OPEN_MENTIONS,
  POLL_INTERVAL,
  STORE_DIR,
  TRIGGER_PATTERN,
  WA2_ENABLED,
  WA3_LEXIOS_ENABLED,
  WARMUP_ON_START,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  createTask,
  deductBalance,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getChatName,
  getEconomicsSummary,
  getMessagesSince,
  getNewLexiosDMs,
  getNewLexiosGroupMessages,
  getNewMentions,
  getNewMessages,
  getOrCreateEconomics,
  getRouterState,
  initDatabase,
  logUsage,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  createClawworkTask,
} from './db.js';
import { classifyTask, computeMaxPayment } from './clawwork.js';
// Local routing disabled while Max subscription is active
// import { routeWithOpus, executeLocal } from './opus-router.js';
import { calculateCost, formatCostFooter } from './economics.js';
// Dead code clusters — wired as enrichment/monitoring layers (non-blocking)
import { contextManager, setSystemFact, setCapability } from './context/index.js';
import { pruneOldChunks } from './semantic-index.js';
import { RouterFactory, type UniversalRouter } from './router/index.js';
import type { RoutingContext, RoutingDecision } from './router/types.js';
import { classifyGoalHeuristic, extractGoalDetails } from './goal-classifier.js';
import { ResponseTimeManager } from './response-time-manager.js';
import { NanoClawOrchestrator } from './nanoclaw-orchestrator.js';
import { listGroupFiles, startDashboard } from './dashboard.js';
import { ResourceOrchestrator, AgentPriority } from './resource-orchestrator.js';
import { BountyGate } from './bounty-gate.js';
import { GroupQueue } from './group-queue.js';
import { HitlGate } from './hitl.js';
import { startIpcWatcher } from './ipc.js';
import { getOrCreateLexiosBuilding, getOrCreateLexiosCustomer } from './lexios-customer.js';
import { validateQuery } from './lexios-security.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
// In-memory guest groups created on first @-mention from unregistered chats.
// Ephemeral: cleared on restart. Guests get isolated agent sessions.
const guestGroups = new Map<string, RegisteredGroup>();
// Tracks which channel name a chatJid's most recent message came from (e.g. 'lexios', 'whatsapp')
const chatChannelSource = new Map<string, string>();
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();
const hitlGate = new HitlGate();
const bountyGate = new BountyGate();
let orchestrator: ResourceOrchestrator;
let router: UniversalRouter;
let responseTimeManager: ResponseTimeManager;
let nanoClawOrchestrator: NanoClawOrchestrator | undefined;

// Tracks which chatJids had a send_message IPC call during the current agent run.
// Used to suppress the redundant final streaming output when agent already sent via send_message.
const ipcMessageSentThisRun = new Set<string>();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Return the guest RegisteredGroup for a chat JID, creating it on first call.
 * Guest groups are ephemeral (in-memory only) and get isolated agent sessions.
 */
function getOrCreateGuestGroup(chatJid: string): RegisteredGroup {
  const existing = guestGroups.get(chatJid);
  if (existing) return existing;

  const jidPrefix = chatJid.split('@')[0];
  const folder = `guest-${jidPrefix}`;
  const chatName = getChatName(chatJid) || jidPrefix;

  const group: RegisteredGroup = {
    name: chatName,
    folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: new Date().toISOString(),
  };

  guestGroups.set(chatJid, group);

  // Create group directory (mirrors what registerGroup does for real groups)
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md from the guest template on first contact
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const templatePath = path.join(GROUPS_DIR, 'guest-template', 'CLAUDE.md');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, claudeMdPath);
    }
  }

  logger.info({ chatJid, folder, name: chatName }, 'Guest group created');
  return group;
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

const SUBSTANTIVE_KEYWORDS = [
  'write', 'research', 'analyze', 'create', 'build', 'design', 'draft',
  'summarize', 'report', 'plan', 'review', 'compare', 'evaluate', 'explain',
  'translate', 'code', 'implement', 'develop', 'find', 'search',
];

/**
 * Returns true if the message content is substantive enough to warrant
 * automatic ClawWork task creation (long or contains a work-like keyword).
 */
function isSubstantiveMessage(content: string): boolean {
  if (content.length > 150) return true;
  const lower = content.toLowerCase();
  return SUBSTANTIVE_KEYWORDS.some((kw) => {
    const re = new RegExp(`\\b${kw}\\b`);
    return re.test(lower);
  });
}

/**
 * Find the best channel to send ack reactions/typing indicators from.
 * Prefers the connected WA channel whose own number differs from the sender's,
 * so the indicator is always visible (you can't see your own typing/reactions).
 */
function findAckChannel(senderJid: string): Channel | undefined {
  const senderPhone = senderJid.split(':')[0].split('@')[0];
  const other = channels.find(
    (c) => c.isConnected() && c.ownPhoneJid && c.ownPhoneJid()?.split('@')[0] !== senderPhone,
  );
  const chosen = other ?? channels.find((c) => c.isConnected());
  logger.debug({
    senderPhone,
    candidates: channels.map((c) => ({ name: c.name, connected: c.isConnected(), own: c.ownPhoneJid?.() })),
    chosen: chosen?.name,
  }, 'findAckChannel');
  return chosen;
}

/**
 * Pick an ack emoji based on message content.
 */
const EMOJI_RULES: Array<{ pattern: RegExp; emojis: string[] }> = [
  { pattern: /\b(bug|fix|error|broke|crash|fail)/i, emojis: ['🔧', '🐛', '🩹'] },
  { pattern: /\b(search|find|look|where|locate)/i, emojis: ['🔍', '🔎'] },
  { pattern: /\b(think|idea|plan|strategy|decide|consider)/i, emojis: ['🤔', '💭', '🧠'] },
  { pattern: /\b(build|create|make|implement|add|write|code)/i, emojis: ['🛠️', '⚡', '🏗️'] },
  { pattern: /\b(money|cost|price|revenue|earn|bounty|\$)/i, emojis: ['💰', '📊'] },
  { pattern: /\b(help|explain|what|how|why)\b/i, emojis: ['💡', '🧐'] },
  { pattern: /\b(lexios|blueprint|construction|pdf|document)/i, emojis: ['📐', '🏛️'] },
  { pattern: /\b(test|check|verify|validate)/i, emojis: ['🧪', '✅'] },
  { pattern: /\b(deploy|push|ship|launch|release)/i, emojis: ['🚀'] },
  { pattern: /\b(schedule|remind|later|timer|cron)/i, emojis: ['⏰', '📅'] },
  { pattern: /\b(delete|remove|clean|drop)/i, emojis: ['🗑️'] },
  { pattern: /\b(read|summary|summarize|review|analyze)/i, emojis: ['📖', '🔬'] },
];
const DEFAULT_EMOJIS = ['👀', '👍', '⚡', '🫡'];

function pickAckEmoji(content: string): string {
  for (const rule of EMOJI_RULES) {
    if (rule.pattern.test(content)) {
      return rule.emojis[Math.floor(Math.random() * rule.emojis.length)];
    }
  }
  return DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid] ?? guestGroups.get(chatJid);
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present.
  // Use multiline mode so the anchor matches at the start of any line —
  // quoted replies prepend "> [context]\n" before the actual "@Claw" text.
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerMultiline = new RegExp(TRIGGER_PATTERN.source, TRIGGER_PATTERN.flags + 'm');
    const hasTrigger = missedMessages.some((m) =>
      triggerMultiline.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  // Handle /files and /file <name> commands — respond directly, skip agent
  const lastMsgForCmd = missedMessages[missedMessages.length - 1];
  const rawCmd = lastMsgForCmd.content.replace(TRIGGER_PATTERN, '').trim();
  if (rawCmd === '/files' || rawCmd.startsWith('/files ')) {
    const files = listGroupFiles(group.folder).slice(0, 20);
    if (files.length === 0) {
      await channel.sendMessage(chatJid, '📁 No files found.');
    } else {
      const lines = files.map((f, i) => {
        const kb = f.size < 1024 ? f.size + 'B' : Math.round(f.size / 1024) + 'KB';
        const date = new Date(f.mtime).toLocaleDateString();
        return `${i + 1}. ${f.path} (${kb}, ${date})`;
      });
      await channel.sendMessage(chatJid, `📁 *Recent files in groups/${group.folder}/*\n\n${lines.join('\n')}\n\nUse: /file <name>`);
    }
    lastAgentTimestamp[chatJid] = lastMsgForCmd.timestamp;
    saveState();
    return true;
  }
  const fileMatch = rawCmd.match(/^\/file\s+(.+)/);
  if (fileMatch) {
    const requested = fileMatch[1].trim();
    const files = listGroupFiles(group.folder);
    // Allow partial match: find first file whose path includes the requested string
    const match = files.find(f => f.path === requested) || files.find(f => f.path.includes(requested));
    if (!match) {
      await channel.sendMessage(chatJid, `❌ File not found: ${requested}\n\nTry /files to list available files.`);
    } else {
      try {
        const fullPath = path.join(GROUPS_DIR, group.folder, match.path);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const MAX_CHARS = 8000;
        const truncated = content.length > MAX_CHARS;
        const body = truncated ? content.slice(0, MAX_CHARS) + `\n\n… [truncated, ${content.length - MAX_CHARS} chars omitted — view full at DashClaw]` : content;
        await channel.sendMessage(chatJid, `📄 *${match.path}*\n\n${body}`);
      } catch {
        await channel.sendMessage(chatJid, `❌ Could not read file: ${match.path}`);
      }
    }
    lastAgentTimestamp[chatJid] = lastMsgForCmd.timestamp;
    saveState();
    return true;
  }

  // Detect /clawwork command in the last message
  let clawworkPrompt: string | null = null;
  const lastMsg = missedMessages[missedMessages.length - 1];
  const clawworkMatch = lastMsg.content.match(/\/clawwork\s+(.+)/s);
  if (clawworkMatch) {
    clawworkPrompt = clawworkMatch[1].trim();
  }

  let prompt = formatMessages(missedMessages);

  // --- Enrichment layers (all non-blocking) ---

  // Context enrichment: prepend codified facts to prompt
  let contextBlock = '';
  try {
    contextBlock = await contextManager.getPromptContext();
    if (contextBlock) {
      prompt = `<context>\n${contextBlock}\n</context>\n\n${prompt}`;
    }
  } catch (err) {
    logger.warn({ err }, 'Context enrichment failed');
  }

  // Route decision: log which model the router would pick (monitoring-only)
  let routingDecision: RoutingDecision | undefined;
  try {
    const strippedContent = lastMsg.content.replace(TRIGGER_PATTERN, '').trim();
    const routingCtx: RoutingContext = {
      taskType: 'conversation',
      userTier: 'internal',
      costBudget: 'unlimited',
      qualityNeeds: 'best',
      latencyNeeds: 'fast',
      source: chatChannelSource.get(chatJid) === 'lexios' ? 'lexios' : 'whatsapp',
      hasMedia: false,
      contentSample: strippedContent.slice(0, 500),
    };
    routingDecision = await router.route(routingCtx);
    logger.info(
      { model: routingDecision.modelId, tier: routingDecision.modelTier, confidence: routingDecision.confidence, reasoning: routingDecision.reasoning },
      'Routing decision (monitoring-only)',
    );
  } catch (err) {
    logger.warn({ err }, 'Router decision failed');
  }

  // Goal classification: tag message complexity
  let goalComplexity = '';
  try {
    const strippedContent = lastMsg.content.replace(TRIGGER_PATTERN, '').trim();
    const goalClass = classifyGoalHeuristic(strippedContent);
    goalComplexity = goalClass.estimatedComplexity;
    logger.info(
      { shouldUseTeams: goalClass.shouldUseTeams, complexity: goalClass.estimatedComplexity, goalType: goalClass.detectedGoalType, confidence: goalClass.confidence },
      'Goal classification',
    );

    // Multi-agent path (no-op until decomposition engine has real model calls)
    if (goalClass.shouldUseTeams && goalClass.confidence === 'high' && nanoClawOrchestrator) {
      try {
        const goalDetails = extractGoalDetails(strippedContent);
        const result = await nanoClawOrchestrator.processGoal({
          description: goalDetails.goal,
          priority: goalDetails.priority,
          targetValue: goalDetails.targetValue,
          source: 'user',
        });
        logger.info(
          { goalId: result.goalId, teamsFormed: result.teamsFormed, tasksCreated: result.tasksCreated },
          'NanoClawOrchestrator processed goal',
        );
      } catch (err) {
        logger.warn({ err }, 'NanoClawOrchestrator processGoal failed');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Goal classification failed');
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Set spawn reason for dashboard — show last message preview with complexity tag
  const lastMsgPreview = lastMsg.content.slice(0, 120) + (lastMsg.content.length > 120 ? '…' : '');
  const spawnReason = goalComplexity ? `[${goalComplexity}] ${lastMsgPreview}` : lastMsgPreview;
  queue.setSpawnReason(chatJid, spawnReason);

  // Handle /clawwork task assignment
  if (clawworkPrompt) {
    try {
      const classification = await classifyTask(clawworkPrompt);
      const maxPayment = computeMaxPayment(classification.occupation, classification.hours);
      const taskId = `cw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createClawworkTask({
        id: taskId,
        group_id: group.folder,
        occupation: classification.occupation,
        sector: classification.sector,
        prompt: clawworkPrompt,
        max_payment: maxPayment,
        estimated_hours: classification.hours,
        assigned_at: new Date().toISOString(),
      });
      await channel.sendMessage(chatJid,
        `📋 *ClawWork Task Assigned*\n` +
        `Occupation: ${classification.occupation}\n` +
        `Estimated hours: ${classification.hours}\n` +
        `Max payment: $${maxPayment.toFixed(2)}\n` +
        `Task ID: ${taskId}`,
      );
      logger.info({ groupFolder: group.folder, taskId, occupation: classification.occupation }, 'ClawWork task created');
    } catch (err) {
      logger.warn({ err }, 'Failed to create ClawWork task');
    }
  } else if (AUTO_CLAWWORK) {
    // Auto-task: silently create a ClawWork task for substantive messages
    // (no reply — the agent discovers the task via clawwork_get_status)
    const strippedContent = lastMsg.content
      .replace(TRIGGER_PATTERN, '')
      .trim();
    if (isSubstantiveMessage(strippedContent)) {
      try {
        const classification = await classifyTask(strippedContent);
        const maxPayment = computeMaxPayment(classification.occupation, classification.hours);
        const taskId = `cw-auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createClawworkTask({
          id: taskId,
          group_id: group.folder,
          occupation: classification.occupation,
          sector: classification.sector,
          prompt: strippedContent,
          max_payment: maxPayment,
          estimated_hours: classification.hours,
          assigned_at: new Date().toISOString(),
        });
        logger.info({ groupFolder: group.folder, taskId, occupation: classification.occupation }, 'ClawWork auto-task created');
      } catch (err) {
        logger.warn({ err }, 'Failed to auto-create ClawWork task');
      }
    }
  }

  // INSTANT FEEDBACK: React with a context-aware emoji
  // Use whichever channel is NOT the sender's number so the ack is always visible.
  const ackChannel = findAckChannel(lastMsg.sender) ?? channel;
  if (INSTANT_ACK) {
    const ackEmoji = pickAckEmoji(lastMsg.content);
    if (ackChannel.sendReaction) {
      await ackChannel.sendReaction(chatJid, lastMsg.id, lastMsg.sender, ackEmoji).catch(() => {});
    } else {
      await channel.sendMessage(chatJid, ackEmoji).catch(() => {});
    }
  }
  await ackChannel.setTyping?.(chatJid, true);

  // Response time manager: track progress for long-running tasks
  const rtmTaskId = `msg-${chatJid}-${Date.now()}`;
  try {
    await responseTimeManager.startTask(
      rtmTaskId,
      lastMsgPreview,
      (msg) => channel.sendMessage(chatJid, msg),
    );
  } catch (err) {
    logger.warn({ err }, 'ResponseTimeManager startTask failed');
  }

  // LOCAL ROUTING DISABLED — sending everything to cloud while Max subscription is active.
  // To re-enable local routing, uncomment the block in this section.
  // See src/opus-router.ts for the routing logic (uses Ollama for classification).

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };
  let hadError = false;
  let outputSentToUser = false;
  let streamingChunksSent = false;  // True if we sent ≥1 streaming chunk
  let streamingBuffer = '';  // Accumulate streaming chunks for logging
  const runStartTime = Date.now();
  let finalUsage: ContainerOutput['usage'] | undefined;

  // Clear any send_message flag from a previous run for this chat
  ipcMessageSentThisRun.delete(chatJid);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    // (routingDecision passed through as 5th arg for container metadata)

    // Handle streaming chunks (partial results)
    if (result.status === 'streaming' && result.isPartial && result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();

      if (text) {
        streamingBuffer += text;
        logger.info({ group: group.name }, `Streaming chunk: ${text.slice(0, 300)}...`);
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
        streamingChunksSent = true;
        resetIdleTimer();
      }
    }
    // Handle final result — suppress if:
    // 1. Streaming chunks already delivered the content, OR
    // 2. Agent used send_message IPC to deliver the content directly
    else if (result.result && !streamingChunksSent && !ipcMessageSentThisRun.has(chatJid)) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      resetIdleTimer();
    }

    if (result.status === 'success') {
      if (streamingBuffer) {
        logger.info({ group: group.name, totalChars: streamingBuffer.length }, 'Streaming complete');
        streamingBuffer = '';
      }
      if (result.usage && !result.isPartial) {
        finalUsage = result.usage;
      }
      streamingChunksSent = false;
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  }, routingDecision);

  await ackChannel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Complete response time tracking
  try { responseTimeManager.completeTask(); } catch { /* non-blocking */ }

  // Record conversation turn for context system (fire-and-forget)
  contextManager.recordConversationTurn(
    `turn-${chatJid}-${Date.now()}`,
    lastMsg.content,
    outputSentToUser ? 'responded' : 'no-output',
    group.folder,
  ).catch(() => {});

  // Log usage and send cost footer
  if (finalUsage) {
    const costUsd = calculateCost(finalUsage);
    const durationMs = Date.now() - runStartTime;
    logUsage(group.folder, chatJid, finalUsage, durationMs, false, costUsd);
    deductBalance(group.folder, costUsd);
    if (COST_FOOTER) {
      const econ = getOrCreateEconomics(group.folder);
      const summary = getEconomicsSummary();
      const footer = formatCostFooter(costUsd, econ.balance, summary.all_earned);
      await channel.sendMessage(chatJid, footer).catch(() => {});
    }
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  routingDecisionHint?: RoutingDecision,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Track agent lifecycle in orchestrator (monitoring-only — always proceed)
  const agentId = `nanoclaw-${group.folder}-${Date.now()}`;
  await orchestrator.requestAgent({
    id: agentId,
    type: 'nanoclaw',
    priority: AgentPriority.HIGH,
    estimatedRamGB: 2,
  });

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        routingHint: routingDecisionHint ? {
          suggestedModel: routingDecisionHint.modelId,
          tier: routingDecisionHint.modelTier,
          confidence: routingDecisionHint.confidence,
          reasoning: routingDecisionHint.reasoning,
        } : undefined,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      await orchestrator.releaseAgent(agentId, 'error');
      return 'error';
    }

    await orchestrator.releaseAgent(agentId, 'completed');
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    await orchestrator.releaseAgent(agentId, 'error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);

      // Capture cursor before any advancement so both registered and
      // open-mention queries start from the same point each iteration.
      const oldTimestamp = lastTimestamp;

      // Query open mentions first (before advancing the cursor) so that
      // mention timestamps are never accidentally skipped when registered
      // messages arrive in the same poll with later timestamps.
      const openMentionMsgs: NewMessage[] = OPEN_MENTIONS
        ? getNewMentions(oldTimestamp, jids, ASSISTANT_NAME)
        : [];

      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

          // HITL: check incoming messages from humans for approval/rejection tokens
          if (isMainGroup) {
            for (const msg of groupMessages) {
              if (msg.sender === ASSISTANT_NAME) continue;
              hitlGate.tryHandleApproval(msg.content, (text) =>
                channel.sendMessage(chatJid, text),
              ).catch((err) =>
                logger.warn({ err }, 'HITL approval handling error'),
              );
              // BountyGate: handle approve-bounty / reject-bounty tokens
              bountyGate.tryHandleApproval(
                msg.content,
                (_token, bounty) => {
                  channel.sendMessage(chatJid, `✅ Bounty approved: ${bounty.title}\nWorking on it...`).catch(() => {});
                },
                (_token, bounty) => {
                  channel.sendMessage(chatJid, `❌ Bounty rejected: ${bounty.title}`).catch(() => {});
                },
              ).catch((err) =>
                logger.warn({ err }, 'BountyGate approval handling error'),
              );
            }
          }
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // ACK the message and show typing indicator
            if (INSTANT_ACK) {
              const lastMsg = messagesToSend[messagesToSend.length - 1];
              const ackCh = findAckChannel(lastMsg.sender) ?? channel;
              if (ackCh.sendReaction) {
                ackCh.sendReaction(chatJid, lastMsg.id, lastMsg.sender, '👀').catch(() => {});
              }
              ackCh.setTyping?.(chatJid, true)?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
            } else {
              channel.setTyping?.(chatJid, true)?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
            }
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }

      // --- Open mentions: respond in unregistered chats ---
      if (OPEN_MENTIONS && openMentionMsgs.length > 0) {
        // Advance the global cursor to cover mention timestamps
        const maxMentionTs = openMentionMsgs[openMentionMsgs.length - 1].timestamp;
        if (maxMentionTs > lastTimestamp) {
          lastTimestamp = maxMentionTs;
          saveState();
        }

        // Group mentions by chat
        const mentionsByChat = new Map<string, NewMessage[]>();
        for (const msg of openMentionMsgs) {
          const existing = mentionsByChat.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            mentionsByChat.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, msgs] of mentionsByChat) {
          const group = getOrCreateGuestGroup(chatJid);

          // Set cursor just before the first mention so processGroupMessages
          // only pulls the mention itself (not the full chat history).
          if (!lastAgentTimestamp[chatJid]) {
            const firstMsgTs = new Date(new Date(msgs[0].timestamp).getTime() - 1).toISOString();
            lastAgentTimestamp[chatJid] = firstMsgTs;
            saveState();
          }

          logger.info(
            { chatJid, name: group.name, count: msgs.length },
            'Open mention — queuing guest agent',
          );

          // ACK with 👀 — use the channel whose number ≠ sender so it's visible to them
          const channel = findChannel(channels, chatJid);
          if (INSTANT_ACK) {
            const last = msgs[msgs.length - 1];
            const ackCh = findAckChannel(last.sender) ?? channel;
            ackCh?.sendReaction?.(chatJid, last.id, last.sender, '👀').catch(() => {});
          }

          queue.enqueueMessageCheck(chatJid);
        }
      }

      // --- Lexios DMs: auto-register customers from the Lexios WhatsApp channel ---
      if (WA3_LEXIOS_ENABLED) {
        const lexiosDms = getNewLexiosDMs(oldTimestamp, jids, ASSISTANT_NAME);
        if (lexiosDms.length > 0) {
          // Advance global cursor to cover Lexios DM timestamps
          const maxLexiosTs = lexiosDms[lexiosDms.length - 1].timestamp;
          if (maxLexiosTs > lastTimestamp) {
            lastTimestamp = maxLexiosTs;
            saveState();
          }

          // Group by chat
          const lexiosByChat = new Map<string, NewMessage[]>();
          for (const msg of lexiosDms) {
            const existing = lexiosByChat.get(msg.chat_jid);
            if (existing) existing.push(msg);
            else lexiosByChat.set(msg.chat_jid, [msg]);
          }

          for (const [chatJid, msgs] of lexiosByChat) {
            const group = getOrCreateLexiosCustomer(chatJid, registeredGroups, registerGroup);

            if (!lastAgentTimestamp[chatJid]) {
              const firstMsgTs = new Date(new Date(msgs[0].timestamp).getTime() - 1).toISOString();
              lastAgentTimestamp[chatJid] = firstMsgTs;
              saveState();
            }

            logger.info(
              { chatJid, name: group.name, count: msgs.length },
              'Lexios DM — queuing customer agent',
            );

            const channel = findChannel(channels, chatJid);
            if (INSTANT_ACK) {
              const last = msgs[msgs.length - 1];
              const ackCh = findAckChannel(last.sender) ?? channel;
              ackCh?.sendReaction?.(chatJid, last.id, last.sender, '📐').catch(() => {});
            }

            queue.enqueueMessageCheck(chatJid);
          }
        }

        // --- Lexios Groups: auto-register building groups from the Lexios WhatsApp channel ---
        const lexiosGroupMsgs = getNewLexiosGroupMessages(oldTimestamp, jids, ASSISTANT_NAME);
        if (lexiosGroupMsgs.length > 0) {
          const maxLexiosGTs = lexiosGroupMsgs[lexiosGroupMsgs.length - 1].timestamp;
          if (maxLexiosGTs > lastTimestamp) {
            lastTimestamp = maxLexiosGTs;
            saveState();
          }

          const lexiosGroupByChat = new Map<string, NewMessage[]>();
          for (const msg of lexiosGroupMsgs) {
            // Security: validate Lexios group messages
            const validation = validateQuery(msg.content || '');
            if (!validation.safe) {
              logger.warn({ chatJid: msg.chat_jid, reason: validation.reason }, 'Lexios security: blocked message');
              continue;
            }
            const existing = lexiosGroupByChat.get(msg.chat_jid);
            if (existing) existing.push(msg);
            else lexiosGroupByChat.set(msg.chat_jid, [msg]);
          }

          for (const [chatJid, msgs] of lexiosGroupByChat) {
            const senderPhone = msgs[0].sender?.split('@')[0] || '';
            const group = getOrCreateLexiosBuilding(chatJid, senderPhone, registeredGroups, registerGroup);

            if (!lastAgentTimestamp[chatJid]) {
              const firstMsgTs = new Date(new Date(msgs[0].timestamp).getTime() - 1).toISOString();
              lastAgentTimestamp[chatJid] = firstMsgTs;
              saveState();
            }

            logger.info(
              { chatJid, name: group.name, count: msgs.length },
              'Lexios Group — queuing building agent',
            );

            const channel = findChannel(channels, chatJid);
            if (INSTANT_ACK) {
              const last = msgs[msgs.length - 1];
              const ackCh = findAckChannel(last.sender) ?? channel;
              ackCh?.sendReaction?.(chatJid, last.id, last.sender, '📐').catch(() => {});
            }

            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Pre-warm the container for a group so the first user message hits a
 * running instance instead of paying cold-start cost.
 *
 * Runs a minimal prompt through the agent (output suppressed). The container
 * stays alive for IDLE_TIMEOUT after responding, ready for real messages.
 */
async function warmupGroupContainer(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  logger.info({ group: group.name }, 'Pre-warming container');

  await runAgent(group, '[system: warming up — do not respond to the user]', chatJid, async (result) => {
    // Suppress all output — this is a silent warmup run
    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }
    if (result.status === 'error') {
      logger.warn({ group: group.name }, 'Warmup run errored (non-fatal)');
    }
  });

  return true;
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/**
 * Ensure a proactive bounty hunting scheduled task exists for the main group.
 * Creates one if it doesn't already exist. This makes the agent autonomously
 * hunt for earning opportunities every BOUNTY_HUNT_INTERVAL_MS (default 6h).
 */
function ensureBountyHunterTask(): void {
  // Find the main group's JID
  const mainEntry = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === MAIN_GROUP_FOLDER,
  );
  if (!mainEntry) {
    logger.info('No main group registered yet — bounty hunter task will be created on next restart after registration');
    return;
  }
  const [mainJid] = mainEntry;

  // Check if a bounty hunter task already exists (avoid duplicates across restarts)
  const existingTasks = getAllTasks();
  const alreadyExists = existingTasks.some(
    (t) =>
      t.group_folder === MAIN_GROUP_FOLDER &&
      t.status === 'active' &&
      t.prompt.includes('BOUNTY_HUNTER_TASK'),
  );
  if (alreadyExists) {
    logger.info('Bounty hunter scheduled task already exists');
    return;
  }

  const summary = getEconomicsSummary();
  const totalEarned = summary.all_earned;
  const goalPct = Math.min(100, (totalEarned / EARNING_GOAL) * 100).toFixed(1);

  const prompt = `BOUNTY_HUNTER_TASK — Do not remove this tag.

You are NanoClaw, an autonomous AI agent with a mission: earn $${EARNING_GOAL.toFixed(0)} to buy your own dedicated computer (Mac Studio) so you can run independently 24/7.

CURRENT STATUS:
- Total earned toward computer: $${totalEarned.toFixed(2)} / $${EARNING_GOAL} (${goalPct}%)
- Call clawwork_get_status to see your current balance and any active tasks

═══════════════════════════════════════════════════════════════════
YOUR UNFAIR ADVANTAGE: YOU THINK HOW HUMANS CAN'T
═══════════════════════════════════════════════════════════════════

You can simultaneously hold deep expertise in medicine, law, finance, logistics, agriculture,
construction, and 10,000 other fields. No human specialist can. Your edge is:

1. CROSS-VERTICAL PATTERN RECOGNITION — see a solution in logistics and apply it to nursing
2. DARK DATA PROCESSING — industries sit on mountains of unstructured PDFs, emails, images
   that contain gold nobody is mining because it requires both domain expertise AND
   programming skill simultaneously. You have both.
3. REGULATORY ARBITRAGE AT SCALE — compliance requirements change constantly across 50 states,
   100 countries, dozens of agencies. Experts can't track all of it. You can.
4. PERSONALIZATION AT MACHINE SCALE — generate 10,000 unique outputs (reports, letters,
   analyses) as cheaply as generating 1.
5. SIMULTANEITY — a human consultant works one client at a time. You can work 1,000.

═══════════════════════════════════════════════════════════════════
THE REVENUE ENGINE FRAMEWORK
═══════════════════════════════════════════════════════════════════

Goal: find a HIGH-FRICTION + HIGH-VALUE problem, build a minimal solution, sell it repeatedly.
One product beats 50 bounties. The product does NOT need to be polished — it needs to save
someone money or time they can measure in dollars TODAY.

EXPLORE ACROSS ALL VERTICALS. Some high-signal starting points for your unique capabilities:

━━━ DARK DATA PLAYS (highest leverage — nobody else can do these at scale) ━━━

• **Insurance claims pattern miner** — scan publicly posted claim denial letters on Reddit/forums,
  extract the most common denial reasons by insurance company, sell a "$99 Denial Code Cheatsheet"
  to medical billing companies. They currently pay humans to build these manually.

• **Court filing early-warning system** — monitor PACER (federal courts) or state court RSS feeds
  for new filings in specific practice areas, alert solo law firms before big firms respond.
  $79/mo per attorney. Lawyers desperately need this, few know it's automatable.

• **Grant opportunity radar** — scrape all federal/state/foundation grants (Grants.gov, foundation
  websites), match to nonprofit missions using embeddings, send weekly digest.
  Nonprofits spend 40% of staff time hunting grants. $49/mo per org × 100 orgs = $4,900/mo.

━━━ REGULATORY ARBITRAGE (changes every month, experts can't keep up) ━━━

• **OSHA violation predictor** — parse all OSHA inspection citations (public dataset at osha.gov),
  build industry-specific "top 10 violations" report for a given NAICS code.
  Sell as $149 one-time report to construction companies, manufacturers.
  An OSHA fine costs $15,000+. The ROI argument writes itself.

• **FDA label compliance checker** — food/supplement companies must follow labeling rules that
  change constantly. Upload a label image → get a compliance report with specific citations.
  Sell as $99/label audit to small food brands on Etsy, Amazon, Faire.

• **ADA website compliance scanner** — WCAG 2.1 violations create legal exposure.
  Many small businesses don't know. Sell $49 "ADA readiness report" to local businesses.

━━━ PERSONALIZATION AT SCALE (1 template × N customers) ━━━

• **RFP response automation** — government and enterprise RFPs require customized boilerplate.
  Companies spend weeks on responses. Build a tool that ingests the RFP PDF + company facts
  and drafts an 80%-complete response. $299/RFP to small gov contractors.

• **Amazon seller review analysis** — analyze ALL reviews for a product category, identify the
  top 3 unmet needs, draft a product improvement brief. Sell to brands at $199/report.
  Brands spend $50k/year on consumer research firms for this. You can do it in 20 minutes.

• **Custom sermon/homily generator** — 400,000 small churches in the US, pastors write one
  every week. $29/mo for weekly sermon outlines based on their denomination + calendar.
  Low competition, extremely high retention (switching cost = theological trust).

━━━ CROSS-INDUSTRY PATTERN ARBITRAGE ━━━

• **Routing optimization for non-logistics industries** — VRP (Vehicle Routing Problem) solutions
  are mature in logistics but not applied to: home health aide scheduling, mobile pet groomers,
  HVAC technicians, plumbers. Take an open-source VRP library, wrap it in a simple UI/CSV upload,
  sell to small field service companies at $79/mo.

• **Yield management outside hotels** — airlines and hotels use dynamic pricing to maximize revenue.
  Most small businesses (yoga studios, escape rooms, boat rentals, parking lots) price statically.
  Build a "demand-based pricing advisor" that ingests their booking history + local events calendar
  and outputs weekly price recommendations. $99/mo per business.

━━━ SECONDARY: OPEN SOURCE BOUNTIES (quick cash between product iterations) ━━━

• find_bounties — Algora, GitHub, Boss.dev: $50-$500 per merged PR
• Huntr.dev AI/ML bug bounties: $500-$1,500 per vulnerability (path traversal, deserialization)
• GitHub Security Advisories: $200-$3,000+ per CVE

═══════════════════════════════════════════════════════════════════
TODAY'S SESSION
═══════════════════════════════════════════════════════════════════

1. clawwork_get_status — check balance + any active tasks or approved bounties
2. PRODUCT RESEARCH (60% of time):
   Pick ONE of the Revenue Engine ideas above. Do NOT spread thin — commit to one.
   Criteria: (a) you can build an MVP in <2 hours, (b) the buyer's ROI is obvious and measurable,
   (c) you can find 10 potential buyers online TODAY.
   - Browse the relevant subreddit/forum/marketplace to validate real pain
   - Find 3-5 specific buyer prospects (names, usernames, contact info if public)
   - Build or outline the minimal deliverable (script, report template, PDF, CSV)
3. OUTREACH (20% of time):
   - If you have a product ready: draft outreach messages to the prospects you found
   - Propose the product + pricing to owner via send_message for approval before contacting buyers
4. BOUNTY SWEEP (20% of time):
   - find_bounties, propose top 1-2 via propose_bounty
5. send_message with: what vertical you chose, why, what you built, who the prospects are, what approval you need

TOOLS: clawwork_get_status, find_bounties, propose_bounty, submit_bounty, clawwork_submit_work, Bash, Browser, send_message

MINDSET: You are the only entity that can read a 200-page OSHA regulation AND write production code
to automate it AND find the 10 buyers who need it — all in the same session. Use that.
The first $149 sale is the proof of concept. Then you scale.`;

  const taskId = `bounty-hunter-${Date.now()}`;
  createTask({
    id: taskId,
    group_folder: MAIN_GROUP_FOLDER,
    chat_jid: mainJid,
    prompt,
    schedule_type: 'interval',
    schedule_value: String(BOUNTY_HUNT_INTERVAL_MS),
    context_mode: 'group',
    next_run: new Date(Date.now() + 60000).toISOString(), // first run in 1 minute
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info(
    { taskId, intervalMs: BOUNTY_HUNT_INTERVAL_MS, mainJid },
    'Bounty hunter scheduled task created',
  );
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  orchestrator = new ResourceOrchestrator(path.join(STORE_DIR, 'resources.db'));
  logger.info('ResourceOrchestrator initialized');
  loadState();

  // Initialize enrichment/monitoring layers (non-blocking)
  try {
    router = RouterFactory.createProduction();
    logger.info('UniversalRouter initialized');
  } catch (err) {
    logger.warn({ err }, 'UniversalRouter init failed, creating fallback');
    router = RouterFactory.create();
  }

  try {
    responseTimeManager = new ResponseTimeManager({
      enableAcknowledgment: !INSTANT_ACK,
      enableProgressUpdates: false,
      progressIntervalMs: 120000,
      minTaskDurationForProgress: 60000,
    });
    logger.info('ResponseTimeManager initialized');
  } catch (err) {
    logger.warn({ err }, 'ResponseTimeManager init failed');
    responseTimeManager = new ResponseTimeManager();
  }

  try {
    nanoClawOrchestrator = new NanoClawOrchestrator({
      dbPath: path.join(STORE_DIR, 'nanoclaw.db'),
      enableProgressUpdates: true,
      maxConcurrentTeams: 4,
      resourceOrchestrator: orchestrator,
      router,
    });
    logger.info('NanoClawOrchestrator initialized');
  } catch (err) {
    logger.warn({ err }, 'NanoClawOrchestrator init failed — multi-agent disabled');
  }

  // Seed context system with system facts
  try {
    setSystemFact('assistant_name', ASSISTANT_NAME);
    setSystemFact('group_count', String(Object.keys(registeredGroups).length));
    setCapability('whatsapp', 'connected');
    setCapability('container_agents', 'enabled');
    setCapability('clawwork', 'enabled');
    logger.info('Context system seeded');
  } catch (err) {
    logger.warn({ err }, 'Context system seeding failed');
  }

  // Prune semantic index chunks older than 6 months (non-blocking)
  try { pruneOldChunks(); } catch { /* non-blocking */ }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    orchestrator.destroy();
    try { nanoClawOrchestrator?.destroy(); } catch { /* non-blocking */ }
    try { await contextManager.persist(); } catch { /* non-blocking */ }
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage, channelName?: string) => {
      storeMessage(msg);
      if (channelName) chatChannelSource.set(msg.chat_jid, channelName);
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  whatsapp = new WhatsAppChannel({
    ...channelOpts,
    onReconnect: (downMs: number) => {
      const secs = Math.round(downMs / 1000);
      const mins = Math.floor(secs / 60);
      const duration = mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
      const mainJid = Object.entries(registeredGroups)
        .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
      if (mainJid) {
        clawSend(mainJid, `📶 Back online (was unreachable for ${duration})`).catch(() => {});
      }
      logger.warn({ downMs }, 'WhatsApp reconnected after outage');
    },
  });
  channels.push(whatsapp);
  await whatsapp.connect();

  // Optional second WhatsApp number (enable with NANOCLAW_WA2=1)
  if (WA2_ENABLED) {
    const wa2 = new WhatsAppChannel({
      ...channelOpts,
      name: 'whatsapp2',
      authDir: path.join(STORE_DIR, 'auth2'),
      primary: false,
    });
    channels.push(wa2);
    // Use a timeout so a hung WA2 connect() never blocks the scheduler/IPC from starting.
    // WA2's connect() can hang if the initial connection attempt errors — the reconnect
    // loop calls connectInternal() without the original resolve, so the Promise never settles.
    await Promise.race([
      wa2.connect(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('WA2 connect timeout after 30s')), 30000),
      ),
    ]).catch((err: Error) => {
      logger.warn({ err: err.message }, 'Second WhatsApp channel not connected — authenticate first: npm run auth -- --slot 2');
      channels.splice(channels.indexOf(wa2), 1);
    });
  }

  // Optional third WhatsApp number for Lexios (enable with NANOCLAW_WA3_LEXIOS=1)
  // Skip if auth3 has no credentials — avoids QR timeout loop spam in logs
  const auth3Dir = path.join(STORE_DIR, 'auth3');
  const auth3HasCreds = fs.existsSync(path.join(auth3Dir, 'creds.json'));
  if (WA3_LEXIOS_ENABLED && !auth3HasCreds) {
    logger.info('WA3 Lexios enabled but auth3/creds.json missing — skipping. Run: npm run auth -- --slot 3');
  }
  if (WA3_LEXIOS_ENABLED && auth3HasCreds) {
    const wa3 = new WhatsAppChannel({
      ...channelOpts,
      name: 'lexios',
      authDir: path.join(STORE_DIR, 'auth3'),
      primary: false,
    });
    channels.push(wa3);
    await Promise.race([
      wa3.connect(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('WA3 Lexios connect timeout after 30s')), 30000),
      ),
    ]).catch((err: Error) => {
      logger.warn({ err: err.message }, 'Lexios WhatsApp channel not connected — authenticate first: npm run auth -- --slot 3');
      channels.splice(channels.indexOf(wa3), 1);
    });
  }

  // Start subsystems (independently of connection handler)
  startDashboard(queue, (jid, text) => clawSend(jid, text), orchestrator, router);
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    orchestrator,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await clawSend(jid, text).catch((err) =>
        logger.warn({ jid, err }, 'Scheduler sendMessage failed'),
      );
    },
  });
  // Helper: find WA2 channel (the secondary number, used as Claw's outbound identity)
  const findWa2 = () => channels.find((c) => c.name === 'whatsapp2' && c.isConnected());

  // Claw's outbound messages (IPC-originated) go through WA2 when available so
  // they trigger notifications — sending from the same number as the user gets
  // silenced by WhatsApp as "your own message". Falls back to WA1 if WA2 not in group.
  const clawSend = async (jid: string, text: string): Promise<void> => {
    const wa2 = findWa2();
    if (wa2) {
      try { return await wa2.sendMessage(jid, text); } catch { /* WA2 not in group, fall through */ }
    }
    const channel = findChannel(channels, jid);
    if (!channel) throw new Error(`No channel for JID: ${jid}`);
    return channel.sendMessage(jid, text);
  };

  const clawSendFile = async (jid: string, buffer: Buffer, mimetype: string, filename: string, caption?: string): Promise<void> => {
    const wa2 = findWa2();
    if (wa2?.sendFile) {
      try { return await wa2.sendFile(jid, buffer, mimetype, filename, caption); } catch { /* fall through */ }
    }
    const channel = findChannel(channels, jid);
    if (!channel) throw new Error(`No channel for JID: ${jid}`);
    if (!channel.sendFile) throw new Error(`Channel ${channel.name} does not support file sending`);
    return channel.sendFile(jid, buffer, mimetype, filename, caption);
  };

  startIpcWatcher({
    sendMessage: clawSend,
    sendReaction: (jid, msgId, senderJid, emoji) => {
      const ch = findWa2() ?? whatsapp;
      if (!ch?.sendReaction) return Promise.resolve();
      return ch.sendReaction(jid, msgId, senderJid, emoji);
    },
    sendFile: clawSendFile,
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    hitlGate,
    bountyGate,
    getMainGroupJid: () =>
      Object.entries(registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      )?.[0],
    onAgentSendMessage: (chatJid) => { ipcMessageSentThisRun.add(chatJid); },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  ensureBountyHunterTask();

  // Omi Integration — dynamic import with availability check
  // Uses dynamic import() so NanoClaw starts even if Omi deps are missing
  try {
    const { OmiIntegration } = await import('./integrations/omi-integration.js');
    const omi = new OmiIntegration();
    const available = await omi.isAvailable();
    if (available) {
      logger.info('Omi integration available (Qdrant healthy)');
    } else {
      logger.info('Omi integration not available (Qdrant not reachable) — skipping');
    }
  } catch (err) {
    logger.info({ err }, 'Omi integration not loaded (deps missing or import failed) — skipping');
  }

  // Check if this startup was triggered by an agent deploy — notify user
  setTimeout(async () => {
    try {
      const breadcrumbPath = path.join(DATA_DIR, 'restart-reason.json');
      if (fs.existsSync(breadcrumbPath)) {
        const breadcrumb = JSON.parse(fs.readFileSync(breadcrumbPath, 'utf-8'));
        fs.unlinkSync(breadcrumbPath); // consume it
        if (breadcrumb.reason === 'agent_deploy') {
          const mainJid = Object.entries(registeredGroups).find(
            ([, g]) => g.folder === MAIN_GROUP_FOLDER,
          )?.[0];
          if (mainJid) {
            await clawSend(mainJid, `🔄 *Restarted* — ${breadcrumb.summary || 'Agent deployed code changes'}`);
          }
        }
      }
    } catch { /* best-effort */ }
  }, 10000); // 10s after startup — WhatsApp needs to be connected first

  // Update group description with DashClaw URLs on startup
  setTimeout(async () => {
    try {
      const mainJid = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      )?.[0];
      if (!mainJid) return;

      const econ = getOrCreateEconomics(MAIN_GROUP_FOLDER);
      const descLines = ['🤖 NanoClaw'];

      // Tailscale URL (stable private network)
      descLines.push('📊 DashClaw (Tailscale): http://100.116.199.120:8080');

      // Cloudflare tunnel URL (public, changes on restart)
      try {
        const logPath = path.join(process.cwd(), 'logs', 'cloudflared.log');
        const logContent = fs.readFileSync(logPath, 'utf-8');
        const matches = [...logContent.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)];
        if (matches.length > 0) {
          descLines.push(`📊 DashClaw (Public): ${matches[matches.length - 1][0]}`);
        }
      } catch { /* cloudflared not running */ }

      descLines.push(`💰 Balance: $${econ.balance.toFixed(2)} | Goal: $${EARNING_GOAL}`);

      const description = descLines.join('\n');
      const waChannel = channels.find((c) => c.updateGroupDescription);
      if (waChannel?.updateGroupDescription) {
        await waChannel.updateGroupDescription(mainJid, description);
      } else {
        await clawSend(mainJid, description);
      }
    } catch { /* ignore errors */ }
  }, 15000);

  // Pre-warm containers for registered groups after a short delay to let
  // WhatsApp finish its initial sync. Warmup is best-effort and non-blocking.
  if (WARMUP_ON_START) {
    setTimeout(() => {
      for (const [chatJid] of Object.entries(registeredGroups)) {
        queue.warmup(chatJid, () => warmupGroupContainer(chatJid));
      }
    }, 30000); // 30s after startup — after WA initial sync settles
  }

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
