import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  INSTANT_ACK,
  MAIN_GROUP_FOLDER,
  OPEN_MENTIONS,
  POLL_INTERVAL,
  STORE_DIR,
  TIMEZONE,
  TRIGGER_PATTERN,
  WA2_ENABLED,
  WARMUP_ON_START,
  DESKTOP_NOTIFY_JID,
  FREELANCE_AGENT_JID,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  isOAuthError,
  readOAuthFromKeychain,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import { readEnvFile } from './env.js';
import { generateFallbackResponse, isFallbackWorthy } from './host-fallback.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  createTask,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getChatName,
  getMessagesSince,
  getNewMentions,
  getNewMessages,
  getNewSharedItemCount,
  getRouterState,
  initDatabase,
  logUsage,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  createTaskRecord,
  detectSharedItems,
  storeSharedItem,
  getChatChannel,
  updateTask,
  getDb,
} from './db.js';
// Local routing disabled while Max subscription is active
// import { routeWithOpus, executeLocal } from './opus-router.js';
import { calculateCost } from './economics.js';
// Dead code clusters — wired as enrichment/monitoring layers (non-blocking)
import { contextManager, codedContext, setSystemFact, setCapability } from './context/index.js';
import { pruneOldChunks } from './semantic-index.js';
import { RouterFactory, type UniversalRouter } from './router/index.js';
import type { RoutingContext, RoutingDecision } from './router/types.js';
import { classifyGoalHeuristic, extractGoalDetails } from './goal-classifier.js';
import { ResponseTimeManager } from './response-time-manager.js';
import { NanoClawOrchestrator } from './nanoclaw-orchestrator.js';
import { listGroupFiles, startDashboard } from './dashboard.js';
import { startThroughputMonitor } from './throughput-monitor.js';
import { initNotificationRouter } from './notification-router.js';
import { ResourceOrchestrator, AgentPriority } from './resource-orchestrator.js';
import { CleanupGate } from './cleanup-gate.js';
import { ImplementationGate } from './implementation-gate.js';
import { DeliverableGate } from './deliverable-gate.js';
import { GroupQueue } from './group-queue.js';
import { HitlGate } from './hitl.js';
import { startIpcWatcher } from './ipc.js';
import { getIntegrations, loadIntegrations } from './integration-loader.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { PersonaRegistry } from './persona-registry.js';
import { AutoDispatcher } from './auto-dispatch.js';
import { startDailyDigest } from './daily-digest.js';
import { getPersonalityParams } from './personality-tuner.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
// In-memory guest groups created on first @-mention from unregistered chats.
// Ephemeral: cleared on restart. Guests get isolated agent sessions.
const guestGroups = new Map<string, RegisteredGroup>();
// Tracks which channel name a chatJid's most recent message came from (e.g. 'whatsapp')
const chatChannelSource = new Map<string, string>();
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();
const hitlGate = new HitlGate();
const cleanupGate = new CleanupGate();
const deliverableGate = new DeliverableGate();
const implementationGate = new ImplementationGate();
let orchestrator: ResourceOrchestrator;
let router: UniversalRouter;
let responseTimeManager: ResponseTimeManager;
let nanoClawOrchestrator: NanoClawOrchestrator | undefined;
let personaRegistry: PersonaRegistry | undefined;
let autoDispatcher: AutoDispatcher | undefined;

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

  // Auto-register notification-only group
  if (DESKTOP_NOTIFY_JID && !registeredGroups[DESKTOP_NOTIFY_JID]) {
    registerGroup(DESKTOP_NOTIFY_JID, {
      name: 'claw-desktop',
      folder: 'claw-desktop',
      trigger: '@__notify_only__',
      added_at: new Date().toISOString(),
      requiresTrigger: true,
    });
  }
  // Auto-register freelance agent group
  if (FREELANCE_AGENT_JID && !registeredGroups[FREELANCE_AGENT_JID]) {
    registerGroup(FREELANCE_AGENT_JID, {
      name: 'ishita-freelance',
      folder: 'ishita-freelance',
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
  }
  // Auto-register integration groups
  for (const integration of getIntegrations()) {
    if (integration.autoRegisterGroups) {
      for (const g of integration.autoRegisterGroups()) {
        if (!registeredGroups[g.jid]) {
          registerGroup(g.jid, {
            name: g.name,
            folder: g.folder,
            trigger: g.trigger,
            added_at: new Date().toISOString(),
            requiresTrigger: g.requiresTrigger,
            displayName: g.displayName,
            containerConfig: g.containerConfig,
          });
        }
      }
    }
  }

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

/**
 * Detect if a user message is a task/request that should be auto-captured
 * to the kanban board. Uses lightweight heuristics — no LLM call.
 */
const TASK_PATTERNS = [
  /^(i want|i need|help me|set up|build|create|add|implement|fix|make|configure|link|connect|integrate|research|schedule|deploy|write|design|plan)\b/i,
  /\b(set up|build|create|add|implement|fix|make|configure|link|connect|integrate)\b.{10,}/i,
  /\b(can you|could you|please)\b.{10,}/i,
  /\bi want\b.{10,}/i,
  /\b(research|investigate|find out|look into)\b.{10,}/i,
];

function isUserTask(content: string): boolean {
  // Strip @trigger prefix before checking
  const cleaned = content.replace(/@\w+\s*/g, '').trim();
  // Skip very short messages, questions without action, and quoted replies
  if (cleaned.length < 15) return false;
  if (cleaned.startsWith('>')) return false;
  if (/^(what|how|why|when|where|who|is|are|do|does|did|can|could|should)\b/i.test(cleaned) &&
      !/(set up|build|create|help|implement|fix)/i.test(cleaned)) return false;
  return TASK_PATTERNS.some(p => p.test(cleaned));
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
 * Get the set of owner phone prefixes from connected WA channels.
 * Used to gate guest session creation — only the owner can invoke Claw in unregistered chats.
 */
function getOwnerPhones(): Set<string> {
  const phones = new Set<string>();
  for (const c of channels) {
    const jid = c.ownPhoneJid?.();
    if (jid) phones.add(jid.split('@')[0]);
  }
  return phones;
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
  { pattern: /\b(test|check|verify|validate)/i, emojis: ['🧪', '✅'] },
  { pattern: /\b(deploy|push|ship|launch|release)/i, emojis: ['🚀'] },
  { pattern: /\b(schedule|remind|later|timer|cron)/i, emojis: ['⏰', '📅'] },
  { pattern: /\b(delete|remove|clean|drop)/i, emojis: ['🗑️'] },
  { pattern: /\b(read|summary|summarize|review|analyze)/i, emojis: ['📖', '🔬'] },
];
const DEFAULT_EMOJIS = ['👀', '👍', '⚡', '🫡'];

// Append integration-provided emoji rules
for (const integration of getIntegrations()) {
  if (integration.emojiRules) {
    EMOJI_RULES.push(...integration.emojiRules);
  }
}

function pickAckEmoji(content: string): string {
  for (const rule of EMOJI_RULES) {
    if (rule.pattern.test(content)) {
      return rule.emojis[Math.floor(Math.random() * rule.emojis.length)];
    }
  }
  return DEFAULT_EMOJIS[Math.floor(Math.random() * DEFAULT_EMOJIS.length)];
}

/** Determine the purpose of an agent run for cost tracking. */
function determinePurpose(groupFolder: string, chatJid: string): string {
  if (guestGroups.has(chatJid)) return 'guest';
  for (const integration of getIntegrations()) {
    const p = integration.determinePurpose?.(groupFolder);
    if (p) return p;
  }
  return 'conversation';
}

/** Determine the designation for container/orchestrator tracking. */
function determineDesignation(groupFolder: string, chatJid: string): string {
  if (guestGroups.has(chatJid)) return 'guest';
  for (const integration of getIntegrations()) {
    const d = integration.determineDesignation?.(groupFolder);
    if (d) return d;
  }
  return 'conversation';
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

  const lastMsg = missedMessages[missedMessages.length - 1];

  let prompt = formatMessages(missedMessages);

  // --- Enrichment layers (all non-blocking) ---

  // Context enrichment: prepend codified facts + active work to prompt (main group only —
  // guest sessions must not see personal facts from the main group)
  let contextBlock = '';
  if (isMainGroup) {
    try {
      contextBlock = await contextManager.getPromptContext();

      // Inject "Active Work" section from shared MEMORY.md so Claw knows
      // what the last desktop Claude Code session touched (memory bridge)
      let activeWork = '';
      try {
        const memoryPath = path.join(GROUPS_DIR, MAIN_GROUP_FOLDER, 'MEMORY.md');
        const memoryContent = fs.readFileSync(memoryPath, 'utf-8');
        const match = memoryContent.match(/## Active Work\n([\s\S]*?)(?=\n## |\Z)/);
        if (match && match[1].trim()) {
          activeWork = `### Desktop Session (Memory Bridge)\n${match[1].trim()}`;
        }
      } catch { /* MEMORY.md may not exist */ }

      // Inject kanban summary so Claw always sees the task board
      let kanbanSummary = '';
      try {
        const kanbanPath = path.join(GROUPS_DIR, MAIN_GROUP_FOLDER, 'KANBAN.md');
        if (fs.existsSync(kanbanPath)) {
          const kanbanContent = fs.readFileSync(kanbanPath, 'utf-8');
          // Extract just the in-progress and todo counts + in-progress items
          const ncMatch = kanbanContent.match(/## NanoClaw \(([^)]+)\)/);
          const inProgress = kanbanContent.match(/### In Progress\n([\s\S]*?)(?=\n### |\n## |\Z)/g);
          const parts = [];
          if (ncMatch) parts.push(`NanoClaw: ${ncMatch[1]}`);
          // Collect kanban summaries from integrations
          for (const integration of getIntegrations()) {
            const summary = integration.getKanbanSummary?.(kanbanContent);
            if (summary) parts.push(summary);
          }
          if (inProgress) {
            parts.push('Active tasks:');
            for (const section of inProgress) {
              const items = section.split('\n').filter(l => l.startsWith('- [>]'));
              parts.push(...items.map(l => l.replace('[>]', '🔄')));
            }
          }
          if (parts.length) {
            kanbanSummary = `### Kanban Board\n${parts.join('\n')}`;
          }
        }
      } catch { /* KANBAN.md may not exist yet */ }

      // Shared items inbox count
      let sharedInboxNote = '';
      try {
        const newCount = getNewSharedItemCount();
        if (newCount > 0) {
          sharedInboxNote = `### Shared Inbox\n${newCount} unreviewed item${newCount !== 1 ? 's' : ''} (use \`shared_items\` tool to review and act on them)`;
        }
      } catch { /* table may not exist yet */ }

      const combined = [activeWork, kanbanSummary, sharedInboxNote, contextBlock].filter(Boolean).join('\n\n');
      if (combined) {
        prompt = `<context>\n${combined}\n</context>\n\n${prompt}`;
      }
    } catch (err) {
      logger.warn({ err }, 'Context enrichment failed');
    }
  } else {
    // Integration-provided context enrichment for non-main groups
    for (const integration of getIntegrations()) {
      try {
        const enriched = integration.enrichPromptContext?.(group.folder, GROUPS_DIR);
        if (enriched) {
          prompt = `<context>\n${enriched}\n</context>\n\n${prompt}`;
          break;
        }
      } catch (err) {
        logger.warn({ err, integration: integration.name }, 'Integration context enrichment failed');
      }
    }
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
      source: (chatChannelSource.get(chatJid) || 'whatsapp') as import('./router/types.js').TaskSource,
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

  // Auto-capture user tasks to kanban board
  // Detects imperative/request messages and creates tracked task records
  if (!lastMsg.is_from_me) {
    const taskContent = lastMsg.content.replace(TRIGGER_PATTERN, '').trim();
    if (isUserTask(taskContent)) {
      try {
        let project = 'nanoclaw';
        for (const integration of getIntegrations()) {
          const p = integration.determineProject?.(group.folder);
          if (p) { project = p; break; }
        }
        createTaskRecord({
          description: taskContent.slice(0, 200),
          project,
          source: 'user',
          priority: 3,
        });
        logger.info({ groupFolder: group.folder, preview: taskContent.slice(0, 80) }, 'Auto-captured user task to kanban');
      } catch (err) {
        logger.warn({ err }, 'Failed to auto-capture user task');
      }
    }
  }

  // Auto-capture shared items (links, media, strategic thinking)
  for (const msg of missedMessages) {
    if (msg.is_from_me) continue;
    try {
      const items = detectSharedItems(msg);
      for (const item of items) {
        if (storeSharedItem(item)) {
          logger.info({ itemId: item.id, type: item.item_type, category: item.category }, 'Auto-captured shared item');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to auto-capture shared item');
    }
  }

  // INSTANT FEEDBACK: React with a context-aware emoji
  // Prefer the channel whose number differs from sender (so reaction is visible).
  // If that channel fails (e.g. not in this group), fall back to the receiving channel.
  const preferredAckChannel = findAckChannel(lastMsg.sender) ?? channel;
  const ackChannel = preferredAckChannel;
  if (INSTANT_ACK) {
    const ackEmoji = pickAckEmoji(lastMsg.content);
    const tryReact = async (ch: typeof channel) => {
      if (ch.sendReaction) {
        await ch.sendReaction(chatJid, lastMsg.id, lastMsg.sender, ackEmoji);
      } else {
        await ch.sendMessage(chatJid, ackEmoji);
      }
    };
    try {
      await tryReact(preferredAckChannel);
    } catch {
      if (preferredAckChannel !== channel) {
        await tryReact(channel).catch(() => {});
      }
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

  // Log usage (cost tracking for daily digest)
  if (finalUsage) {
    const costUsd = calculateCost(finalUsage);
    const durationMs = Date.now() - runStartTime;
    logUsage(group.folder, chatJid, finalUsage, durationMs, false, costUsd, determinePurpose(group.folder, chatJid));
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
  designationOverride?: string,
  maxTurns?: number,
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
  const designation = designationOverride || determineDesignation(group.folder, chatJid);
  let orchType = 'nanoclaw';
  for (const integration of getIntegrations()) {
    const t = integration.determineOrchestratorType?.(group.folder);
    if (t) { orchType = t; break; }
  }
  const agentId = `nanoclaw-${group.folder}-${Date.now()}`;
  await orchestrator.requestAgent({
    id: agentId,
    type: orchType,
    priority: AgentPriority.HIGH,
    estimatedRamGB: 2,
  });

  // Host-side retry: only retries if the .env token actually changed (avoids wasting a
  // 30s+ container restart with the same expired token). The container-side IPC retry
  // (requestTokenRefresh in agent-runner) is the primary mechanism — this is the fallback
  // for cases where the container crashed before IPC could fire.
  const OAUTH_HOST_RETRY_DELAY_MS = 5000;

  try {
    // Snapshot the current token so we can detect if .env was updated between attempts
    let lastTokenPrefix = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']).CLAUDE_CODE_OAUTH_TOKEN?.slice(0, 20);

    // Resolve personality params for this group (Phase 2 Karpathy tuning)
    const personalityParams = getPersonalityParams(group.folder) ?? undefined;

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        designation,
        routingHint: routingDecisionHint ? {
          suggestedModel: routingDecisionHint.modelId,
          tier: routingDecisionHint.modelTier,
          confidence: routingDecisionHint.confidence,
          reasoning: routingDecisionHint.reasoning,
        } : undefined,
        maxTurns,
        personalityParams,
      },
      (proc, containerName) => {
        queue.registerProcess(chatJid, proc, containerName, group.folder);
        queue.setDesignation(chatJid, designation);
      },
      wrappedOnOutput,
    );

    // If OAuth error: check if .env token was updated, retry once if so
    if (output.status === 'error' && isOAuthError(output.error)) {
      logger.warn(
        { group: group.name, error: output.error },
        'OAuth error detected — checking if .env token was refreshed',
      );

      // Wait briefly for potential background token refresh
      await new Promise((r) => setTimeout(r, OAUTH_HOST_RETRY_DELAY_MS));

      // Check both .env and Keychain for a fresh token
      const envToken = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']).CLAUDE_CODE_OAUTH_TOKEN;
      const keychainToken = process.platform === 'darwin' ? readOAuthFromKeychain() : null;
      const freshToken = keychainToken || envToken;
      const freshPrefix = freshToken?.slice(0, 20);

      if (freshPrefix && freshPrefix !== lastTokenPrefix) {
        // Token changed — worth retrying with a new container
        logger.info({ group: group.name, source: keychainToken ? 'keychain' : 'env' }, 'Token changed — retrying with fresh token');
        lastTokenPrefix = freshPrefix;

        const retryOutput = await runContainerAgent(
          group,
          {
            prompt,
            sessionId, // Same session = conversation context preserved
            groupFolder: group.folder,
            chatJid,
            isMain,
            designation,
            routingHint: routingDecisionHint ? {
              suggestedModel: routingDecisionHint.modelId,
              tier: routingDecisionHint.modelTier,
              confidence: routingDecisionHint.confidence,
              reasoning: routingDecisionHint.reasoning,
            } : undefined,
            maxTurns,
          },
          (proc, containerName) => {
            queue.registerProcess(chatJid, proc, containerName, group.folder);
            queue.setDesignation(chatJid, designation);
          },
          wrappedOnOutput,
        );

        // Use retry result regardless of outcome
        if (retryOutput.newSessionId) {
          sessions[group.folder] = retryOutput.newSessionId;
          setSession(group.folder, retryOutput.newSessionId);
        }

        if (retryOutput.status === 'error') {
          logger.error({ group: group.name, error: retryOutput.error }, 'Container agent error (after OAuth retry)');
          await orchestrator.releaseAgent(agentId, 'error');
          return 'error';
        }

        await orchestrator.releaseAgent(agentId, 'completed');
        return 'success';
      }

      // Token unchanged — notify user with actionable instructions
      logger.error(
        { group: group.name, error: output.error },
        'OAuth token expired and unchanged in .env — cannot retry',
      );
      const ch = findChannel(channels, chatJid);
      if (ch?.isConnected()) {
        ch.sendMessage(chatJid,
          `⚠️ *OAuth token expired*\n\n` +
          `The agent couldn't authenticate with Claude. To fix:\n` +
          `1. Generate a new token at console.anthropic.com\n` +
          `2. Update \`CLAUDE_CODE_OAUTH_TOKEN\` in .env\n` +
          `3. Send your message again (session will resume automatically)`,
        ).catch(() => {});
      }
    }

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );

      // Host-side fallback: if the error looks like an API outage (not OAuth),
      // try generating a response via an alternative model directly from the host
      if (!isOAuthError(output.error) && isFallbackWorthy(output.error)) {
        const fallback = await generateFallbackResponse(prompt, group.name);
        if (fallback) {
          const ch = findChannel(channels, chatJid);
          if (ch?.isConnected()) {
            const footer = `\n\n_[fallback: ${fallback.model}, ${Math.round(fallback.latencyMs / 1000)}s]_`;
            await ch.sendMessage(chatJid, fallback.text + footer).catch(() => {});
            logger.info(
              { group: group.name, model: fallback.model, latencyMs: fallback.latencyMs },
              'Sent fallback response to user',
            );
            await orchestrator.releaseAgent(agentId, 'completed');
            return 'success';
          }
        }
      }

      await orchestrator.releaseAgent(agentId, 'error');
      return 'error';
    }

    await orchestrator.releaseAgent(agentId, 'completed');
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');

    // Try host-side fallback for caught exceptions too
    const errMsg = err instanceof Error ? err.message : String(err);
    if (isFallbackWorthy(errMsg)) {
      const fallback = await generateFallbackResponse(prompt, group.name);
      if (fallback) {
        const ch = findChannel(channels, chatJid);
        if (ch?.isConnected()) {
          const footer = `\n\n_[fallback: ${fallback.model}, ${Math.round(fallback.latencyMs / 1000)}s]_`;
          await ch.sendMessage(chatJid, fallback.text + footer).catch(() => {});
          logger.info(
            { group: group.name, model: fallback.model },
            'Sent fallback response after caught exception',
          );
          await orchestrator.releaseAgent(agentId, 'completed');
          return 'success';
        }
      }
    }

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
              // CleanupGate: handle approve-cleanup / reject-cleanup tokens
              cleanupGate.tryHandleApproval(
                msg.content,
                (text) => channel.sendMessage(chatJid, text),
              ).catch((err) =>
                logger.warn({ err }, 'CleanupGate approval handling error'),
              );
              // ImplementationGate: handle approve/reject {task-id} for branch merges
              implementationGate.tryHandleApproval(
                msg.content,
                (text) => channel.sendMessage(chatJid, text),
              ).catch((err) =>
                logger.warn({ err }, 'ImplementationGate approval handling error'),
              );
              // Integration gates (e.g. SandboxGate)
              for (const integ of getIntegrations()) {
                if (integ.tryHandleApproval) {
                  integ.tryHandleApproval(
                    msg.content,
                    (text) => channel.sendMessage(chatJid, text),
                  ).catch((err) =>
                    logger.warn({ err, integration: integ.name }, 'Integration approval handling error'),
                  );
                }
              }
            }
          }
          // DeliverableGate: handle approve-delivery / reject-delivery from any group
          for (const msg of groupMessages) {
            if (msg.sender === ASSISTANT_NAME) continue;
            deliverableGate.tryHandleApproval(
              msg.content,
              (_token, deliverable) => {
                channel.sendMessage(chatJid, `✅ Delivery approved: ${deliverable.gigTitle}\nProceeding to deliver to client.`).catch(() => {});
              },
              (_token, deliverable) => {
                channel.sendMessage(chatJid, `❌ Delivery rejected: ${deliverable.gigTitle}`).catch(() => {});
              },
            ).catch((err) =>
              logger.warn({ err }, 'DeliverableGate approval handling error'),
            );
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
              const preferredCh = findAckChannel(lastMsg.sender) ?? channel;
              if (preferredCh.sendReaction) {
                preferredCh.sendReaction(chatJid, lastMsg.id, lastMsg.sender, '👀').catch(() => {
                  // Preferred channel not in group — fall back to receiving channel
                  if (preferredCh !== channel && channel.sendReaction) {
                    channel.sendReaction(chatJid, lastMsg.id, lastMsg.sender, '👀').catch(() => {});
                  }
                });
              }
              preferredCh.setTyping?.(chatJid, true)?.catch(() => {
                channel.setTyping?.(chatJid, true)?.catch((err) =>
                  logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
                );
              });
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
      // Security: only the owner (your WA numbers) can CREATE a guest session.
      // Once a session exists, anyone in that chat can @Claw to continue it.
      // "@Claw done" from the owner kills the session.
      if (OPEN_MENTIONS && openMentionMsgs.length > 0) {
        // Advance the global cursor to cover mention timestamps
        const maxMentionTs = openMentionMsgs[openMentionMsgs.length - 1].timestamp;
        if (maxMentionTs > lastTimestamp) {
          lastTimestamp = maxMentionTs;
          saveState();
        }

        const ownerPhones = getOwnerPhones();

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
          const hasSession = guestGroups.has(chatJid);
          const senderPhone = (jid: string) => jid.split(':')[0].split('@')[0];
          const isOwnerMsg = (msg: NewMessage) => ownerPhones.has(senderPhone(msg.sender));

          // Check for "@Claw done" from owner — kill the session
          const donePattern = new RegExp(`@${ASSISTANT_NAME}\\s+done\\b`, 'i');
          const doneMsg = msgs.find((m) => isOwnerMsg(m) && donePattern.test(m.content));
          if (doneMsg && hasSession) {
            guestGroups.delete(chatJid);
            delete lastAgentTimestamp[chatJid];
            saveState();
            logger.info({ chatJid }, 'Guest session ended by owner');
            const channel = findChannel(channels, chatJid);
            channel?.sendMessage(chatJid, `Session ended.`).catch(() => {});
            continue;
          }

          // Gate: only owner can create new sessions
          if (!hasSession) {
            const ownerInitiated = msgs.some(isOwnerMsg);
            if (!ownerInitiated) {
              logger.debug({ chatJid }, 'Guest mention ignored — not owner-initiated');
              continue;
            }
          }

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

          // ACK with context-aware emoji + typing — mirror main group path
          const channel = findChannel(channels, chatJid);
          if (INSTANT_ACK && channel) {
            const last = msgs[msgs.length - 1];
            const preferredCh = findAckChannel(last.sender) ?? channel;
            const ackEmoji = pickAckEmoji(last.content);
            const doReact = async (ch: typeof channel) => {
              if (ch.sendReaction) {
                await ch.sendReaction(chatJid, last.id, last.sender, ackEmoji);
              } else {
                await ch.sendMessage(chatJid, ackEmoji);
              }
            };
            doReact(preferredCh).catch(() => {
              if (preferredCh !== channel) doReact(channel).catch(() => {});
            });
            preferredCh.setTyping?.(chatJid, true)?.catch(() => {
              channel.setTyping?.(chatJid, true)?.catch(() => {});
            });
          } else if (channel) {
            channel.setTyping?.(chatJid, true)?.catch(() => {});
          }

          queue.enqueueMessageCheck(chatJid);
        }
      }

      // --- Integration message loop ticks (auto-registration, etc.) ---
      for (const integration of getIntegrations()) {
        if (integration.onMessageLoopTick) {
          try {
            const integrationCtx = {
              registeredGroups: () => registeredGroups,
              registerGroup,
              channels,
              queue,
              sendMessage: async (jid: string, text: string) => {
                const ch = findChannel(channels, jid);
                if (ch) await ch.sendMessage(jid, text);
              },
            };
            const jidsToEnqueue = await integration.onMessageLoopTick(
              oldTimestamp,
              Array.from(jids),
              integrationCtx,
            );
            for (const chatJid of jidsToEnqueue) {
              if (!lastAgentTimestamp[chatJid]) {
                lastAgentTimestamp[chatJid] = oldTimestamp;
                saveState();
              }
              queue.enqueueMessageCheck(chatJid);
            }
          } catch (err) {
            logger.error({ err, integration: integration.name }, 'Integration message loop tick failed');
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

  await runAgent(group, '[system: warming up — reply with a single period]', chatJid, async (result) => {
    // Suppress all output — this is a silent warmup run
    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }
    if (result.status === 'error') {
      logger.warn({ group: group.name }, 'Warmup run errored (non-fatal)');
    }
  }, undefined, 'warmup', 1);

  return true;
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

/**
 * Ensure a freelance agent scheduled task exists for the ishita-freelance group.
 * Runs 3x daily to hunt, apply, execute, and report on freelance gigs.
 */
function ensureFreelanceAgentTask(): void {
  if (!FREELANCE_AGENT_JID) return;

  const freelanceFolder = 'ishita-freelance';
  const existingTasks = getAllTasks();
  const alreadyExists = existingTasks.some(
    (t) =>
      t.group_folder === freelanceFolder &&
      t.status === 'active' &&
      t.prompt.includes('FREELANCE_AGENT_TASK'),
  );
  if (alreadyExists) {
    logger.info('Freelance agent scheduled task already exists');
    return;
  }

  const prompt = `FREELANCE_AGENT_TASK — Do not remove this tag.

You are a freelance agent for Ishita. Your mission: find freelance work, apply, complete it, and earn $3,000/month.

═══════════════════════════════════════════════════════════════════
WORKFLOW
═══════════════════════════════════════════════════════════════════

1. HUNT (40% of session time)
   - Call find_freelance_gigs to scan Reddit r/forhire, Freelancer.com, Algora, GitHub
   - Also call find_bounties for open-source bounties
   - Filter for: software development, writing, data/research tasks
   - Prioritize by: reward amount, feasibility, time-to-complete

2. APPLY (30% of session time)
   - For Reddit gigs: draft a reply via agent-browser (be professional, specific about skills)
   - For GitHub bounties: fork the repo, start working, comment on the issue
   - For Freelancer.com gigs: draft application text (account setup needed first)
   - Send Ishita a summary of all applications via send_message

3. EXECUTE (20% of session time)
   - Work on any accepted/in-progress gigs
   - Create deliverables in /workspace/group/deliverables/
   - When work is complete, call propose_deliverable — NEVER deliver without approval

4. REPORT (10% of session time)
   - send_message with: gigs found, applications sent, work status, earnings update

═══════════════════════════════════════════════════════════════════
SAFETY RULES
═══════════════════════════════════════════════════════════════════

- NEVER share personal information (address, phone, SSN, bank details)
- NEVER deliver work without going through propose_deliverable approval gate
- NEVER spend money or commit to paid services
- NEVER misrepresent capabilities — be honest about being an AI assistant
- NEVER accept gigs that involve illegal activity, academic fraud, or deception

═══════════════════════════════════════════════════════════════════
BOOTSTRAP (NO ACCOUNTS YET)
═══════════════════════════════════════════════════════════════════

Focus on platforms that don't require accounts first:
- Reddit r/forhire (browsing is public)
- GitHub bounties (existing token available)
- Open-source contributions

Send Ishita a prioritized list of platforms needing account setup:
1. GitHub (for bounties and open-source work)
2. Freelancer.com (largest freelance marketplace)
3. Upwork (highest quality gigs)

As accounts are created, expand your reach.

TOOLS: find_freelance_gigs, find_bounties, propose_bounty, propose_deliverable, submit_bounty, send_message, agent-browser, Bash`;

  const taskId = `freelance-agent-${Date.now()}`;
  createTask({
    id: taskId,
    group_folder: freelanceFolder,
    chat_jid: FREELANCE_AGENT_JID,
    prompt,
    schedule_type: 'cron',
    schedule_value: '0 7,12,18 * * *', // 3x daily: 7 AM, noon, 6 PM
    context_mode: 'group',
    next_run: new Date(Date.now() + 120000).toISOString(), // first run in 2 minutes
    status: 'active',
    created_at: new Date().toISOString(),
  });

  logger.info(
    { taskId, cron: '0 7,12,18 * * *', jid: FREELANCE_AGENT_JID },
    'Freelance agent scheduled task created (3x daily)',
  );
}

async function main(): Promise<void> {
  // Startup: verify native modules are compatible with current Node version.
  // require('better-sqlite3') only loads the JS wrapper; the native .node binary
  // isn't loaded until new Database() is called. So we must instantiate one.
  {
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    try {
      const Database = req('better-sqlite3');
      const testDb = new Database(':memory:');
      testDb.close();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NODE_MODULE_VERSION')) {
        logger.error({ nodeVersion: process.version, error: msg },
          'Native module mismatch — running npm rebuild');
        try {
          const { execSync: execSyncLocal } = await import('child_process');
          execSyncLocal('npm rebuild better-sqlite3', {
            cwd: process.cwd(),
            stdio: 'pipe',
            timeout: 60000,
          });
          logger.info('better-sqlite3 rebuilt successfully — restarting');
          // After rebuild, the cached module is stale. Restart cleanly.
          process.exit(0);
        } catch (rebuildErr) {
          logger.error({ err: rebuildErr }, 'FATAL: Failed to rebuild better-sqlite3');
          process.exit(1);
        }
      } else {
        // Some other error (not version mismatch) — let it proceed and fail naturally
        logger.warn({ error: msg }, 'better-sqlite3 startup check failed (non-version issue)');
      }
    }
  }

  ensureContainerSystemRunning();

  // Startup: verify OAuth token exists and is valid
  {
    const envToken = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']).CLAUDE_CODE_OAUTH_TOKEN;
    const keychainToken = process.platform === 'darwin' ? readOAuthFromKeychain() : null;
    if (keychainToken && keychainToken !== envToken) {
      // Keychain has a fresher token — sync to .env
      const envPath = path.join(process.cwd(), '.env');
      const envContent = fs.readFileSync(envPath, 'utf-8');
      fs.writeFileSync(envPath, envContent.replace(/CLAUDE_CODE_OAUTH_TOKEN=.*/, `CLAUDE_CODE_OAUTH_TOKEN=${keychainToken}`));
      logger.info('Startup: synced fresh Keychain OAuth token to .env');
    }
    const token = keychainToken || envToken;
    if (!token) {
      logger.error('STARTUP WARNING: No OAuth token found in Keychain or .env — containers will fail');
    } else {
      logger.info('Startup: OAuth token verified');
    }
  }

  initDatabase();
  logger.info('Database initialized');

  // Deactivate any bounty hunter tasks from the old ClawWork system
  {
    const existingTasks = getAllTasks();
    for (const t of existingTasks) {
      if (t.status !== 'active') continue;
      const isBountyHunter = t.prompt?.includes('BOUNTY_HUNTER_TASK');
      const isBizOpps = t.prompt?.includes('biz-opps') || t.prompt?.includes('business opportunities');
      if (isBountyHunter || isBizOpps) {
        updateTask(t.id, { status: 'paused' });
        logger.info({ taskId: t.id }, 'Deactivated old bounty/biz-opps task');
      }
    }
  }

  // Load integrations and initialize their DB schemas
  await loadIntegrations();
  {
    const { getDb } = await import('./db.js');
    const mainDb = getDb();
    for (const integration of getIntegrations()) {
      integration.initDatabase(mainDb);
      logger.info({ name: integration.name }, 'Integration DB initialized');
    }
  }

  // Load integration learnings into hot cache
  for (const integration of getIntegrations()) {
    const learningsPath = integration.getLearningsPath?.();
    if (learningsPath) codedContext.loadLearningsFromFile(learningsPath);
  }

  // Initialize persona registry (scans ~/.claude/agents/)
  try {
    const { getDb } = await import('./db.js');
    personaRegistry = new PersonaRegistry(getDb());
    personaRegistry.initSchema();
    const count = await personaRegistry.scan();
    const embedded = await personaRegistry.embedPersonas();
    logger.info({ count, embedded }, 'Persona registry loaded with embeddings');
  } catch (err) {
    logger.warn({ err }, 'Persona registry init failed — auto-dispatch disabled');
  }

  // Sync kanban board to file for cross-agent visibility
  try { const { syncKanbanFile } = await import('./db.js'); syncKanbanFile(); } catch { /* best-effort */ }
  orchestrator = new ResourceOrchestrator(path.join(STORE_DIR, 'resources.db'));
  logger.info('ResourceOrchestrator initialized');
  loadState();

  // Auto-create shared-items-triage scheduled task if it doesn't exist
  {
    const existingTasks = getAllTasks();
    const hasTriageTask = existingTasks.some(
      t => t.status === 'active' && t.prompt.includes('SHARED_ITEMS_TRIAGE'),
    );
    if (!hasTriageTask) {
      const mainEntry = Object.entries(registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      );
      if (mainEntry) {
        const [mainJid] = mainEntry;
        createTask({
          id: `shared-items-triage-${Date.now()}`,
          group_folder: MAIN_GROUP_FOLDER,
          chat_jid: mainJid,
          prompt: `SHARED_ITEMS_TRIAGE — Do not remove this tag.

Review your shared items inbox. Use the \`shared_items\` tool to list new items, triage each one (add notes on what it is and what action to take), then work on the highest-priority items.

Steps:
1. shared_items action=list status=new — see all unreviewed items
2. For each item, shared_items action=triage with notes describing what it is and recommended action
3. Work on the most important triaged items (research links, act on requests, etc.)
4. Mark completed items with shared_items action=act
5. Archive items that don't need action with shared_items action=archive
6. Send a brief summary of what you reviewed and acted on via send_message`,
          schedule_type: 'cron',
          schedule_value: '0 9 * * *',
          context_mode: 'group',
          next_run: CronExpressionParser.parse('0 9 * * *', { tz: TIMEZONE }).next().toISOString(),
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info('Created shared-items-triage scheduled task');
      }
    }
  }

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
    try { autoDispatcher?.stop(); } catch { /* non-blocking */ }
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
      // Dispatch quote-replies to integrations (reactions handled separately)
      if (msg.quoted_message_id && !msg.is_bot_message) {
        (async () => {
          for (const integration of getIntegrations()) {
            if (integration.handleQuoteReply) {
              const handled = await integration.handleQuoteReply(msg.chat_jid, msg.quoted_message_id!, msg);
              if (handled) break;
            }
          }
        })().catch((err) => logger.warn({ err, chatJid: msg.chat_jid }, 'Error in quote-reply handler'));
      }
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    onReaction: (chatJid: string, messageId: string, senderJid: string, emoji: string) => {
      // Dispatch reactions to integrations
      (async () => {
        for (const integration of getIntegrations()) {
          if (integration.handleReaction) {
            await integration.handleReaction(chatJid, messageId, senderJid, emoji);
          }
        }
      })().catch((err) => logger.warn({ err, chatJid }, 'Error in reaction handler'));
    },
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
        clawSend(DESKTOP_NOTIFY_JID || mainJid, `📶 Back online (was unreachable for ${duration})`).catch(() => {});
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

  // Integration-provided WhatsApp channels
  for (const integration of getIntegrations()) {
    if (integration.channels) {
      for (const chConfig of integration.channels) {
        const authDir = path.join(STORE_DIR, chConfig.authDir);
        const hasCreds = fs.existsSync(path.join(authDir, 'creds.json'));
        if (!hasCreds) {
          logger.info({ channel: chConfig.name }, `Integration channel ${chConfig.name} enabled but ${chConfig.authDir}/creds.json missing — skipping`);
          continue;
        }
        const waCh = new WhatsAppChannel({
          ...channelOpts,
          name: chConfig.name,
          authDir,
          primary: false,
        });
        channels.push(waCh);
        await Promise.race([
          waCh.connect(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`${chConfig.name} connect timeout after 30s`)), 30000),
          ),
        ]).catch((err: Error) => {
          logger.warn({ err: err.message, channel: chConfig.name }, `Integration channel not connected`);
          channels.splice(channels.indexOf(waCh), 1);
        });
      }
    }
  }

  // Integration-provided custom channels (non-Baileys, e.g. Twilio)
  for (const integration of getIntegrations()) {
    if (integration.createChannels) {
      const customChannels = integration.createChannels(channelOpts);
      for (const ch of customChannels) {
        channels.push(ch);
        await ch.connect().catch((err: Error) => {
          logger.warn({ err: err.message, channel: ch.name }, 'Custom channel connect failed');
          channels.splice(channels.indexOf(ch), 1);
        });
      }
    }
  }

  // Start subsystems (independently of connection handler)
  startDashboard(queue, (jid, text) => clawSend(jid, text), orchestrator, router);
  startThroughputMonitor();
  // Helper: find WA2 channel (the secondary number, used as Claw's outbound identity)
  const findWa2 = () => channels.find((c) => c.name === 'whatsapp2' && c.isConnected());

  // Claw's outbound messages (IPC-originated) go through WA2 when available so
  // they trigger notifications — sending from the same number as the user gets
  // silenced by WhatsApp as "your own message". Falls back to WA1 if WA2 not in group.
  const clawSend = async (jid: string, text: string, senderName?: string): Promise<void> => {
    // First, use ownsJid-based routing — respects registered group context
    // and prevents cross-channel contamination when a JID appears on multiple channels.
    const owned = findChannel(channels, jid);
    if (owned?.isConnected()) { await owned.sendMessage(jid, text, senderName); return; }

    // For unregistered/guest JIDs, fall back to in-memory source then DB.
    const channelName = chatChannelSource.get(jid) || getChatChannel(jid);
    if (channelName) {
      const ch = channels.find((c) => c.name === channelName && c.isConnected());
      if (ch) { await ch.sendMessage(jid, text, senderName); return; }
    }
    // Fallback: prefer WA2 for notifications, then any channel
    const wa2 = findWa2();
    if (wa2) {
      try { await wa2.sendMessage(jid, text, senderName); return; } catch { /* WA2 not in group, fall through */ }
    }
    if (owned) { await owned.sendMessage(jid, text, senderName); return; } // owned but was disconnected earlier — retry
    // Last resort: try any connected channel (handles disconnected preferred channel)
    const anyConnected = channels.find((c) => c.isConnected());
    if (!anyConnected) throw new Error(`No connected channel for JID: ${jid}`);
    await anyConnected.sendMessage(jid, text, senderName);
  };

  // Like clawSend but returns the WhatsApp message ID (for IPC responseFile)
  const clawSendGetId = async (jid: string, text: string, senderName?: string): Promise<string | undefined> => {
    const owned = findChannel(channels, jid);
    const ch = owned?.isConnected() ? owned : findWa2() ?? channels.find((c) => c.isConnected());
    if (!ch) throw new Error(`No connected channel for JID: ${jid}`);
    await ch.sendMessage(jid, text, senderName);
    return ch.getLastSentMessageId?.();
  };

  const clawSendFile = async (jid: string, buffer: Buffer, mimetype: string, filename: string, caption?: string): Promise<void> => {
    // First, use ownsJid-based routing — respects registered group context.
    const owned = findChannel(channels, jid);
    if (owned?.isConnected() && owned.sendFile) return owned.sendFile(jid, buffer, mimetype, filename, caption);

    // For unregistered/guest JIDs, fall back to in-memory source then DB.
    const channelName = chatChannelSource.get(jid) || getChatChannel(jid);
    if (channelName) {
      const ch = channels.find((c) => c.name === channelName && c.isConnected());
      if (ch?.sendFile) return ch.sendFile(jid, buffer, mimetype, filename, caption);
    }
    // Fallback: prefer WA2 for notifications, then any channel
    const wa2 = findWa2();
    if (wa2?.sendFile) {
      try { return await wa2.sendFile(jid, buffer, mimetype, filename, caption); } catch { /* fall through */ }
    }
    const ch = owned || findChannel(channels, jid);
    if (!ch) throw new Error(`No channel for JID: ${jid}`);
    if (!ch.sendFile) throw new Error(`Channel ${ch.name} does not support file sending`);
    return ch.sendFile(jid, buffer, mimetype, filename, caption);
  };

  // Start scheduler (after clawSendGetId is defined)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    orchestrator,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText, senderName?) => {
      const text = formatOutbound(rawText);
      if (text) await clawSend(jid, text, senderName).catch((err) =>
        logger.warn({ jid, err }, 'Scheduler sendMessage failed'),
      );
    },
    sendMessageGetId: clawSendGetId,
  });

  // Initialize notification router so /api/notify can send to WhatsApp
  initNotificationRouter(clawSend);

  // Daily digest: morning brief (9 AM) + evening report (9 PM)
  startDailyDigest(
    clawSend,
    () =>
      Object.entries(registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      )?.[0],
    () => implementationGate.getPending().length,
  );

  startIpcWatcher({
    sendMessage: clawSend,
    sendMessageGetId: clawSendGetId,
    sendReaction: (jid, msgId, senderJid, emoji) => {
      // Respect the channel the chat arrived on (critical for guest DMs)
      const dbChannel = getChatChannel(jid);
      const dbCh = dbChannel ? channels.find((c) => c.name === dbChannel && c.isConnected()) : undefined;
      const ch = dbCh ?? findWa2() ?? whatsapp;
      if (!ch?.sendReaction) return Promise.resolve();
      return ch.sendReaction(jid, msgId, senderJid, emoji);
    },
    sendFile: clawSendFile,
    registeredGroups: () => {
      // Merge guest groups so IPC auth allows guest agents to reply to their own chat
      const merged = { ...registeredGroups };
      for (const [jid, group] of guestGroups) merged[jid] = group;
      return merged;
    },
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    hitlGate,
    cleanupGate,
    deliverableGate,
    implementationGate,
    getMainGroupJid: () =>
      Object.entries(registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      )?.[0],
    onAgentSendMessage: (chatJid) => { ipcMessageSentThisRun.add(chatJid); },
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.startReaper();
  recoverPendingMessages();
  ensureFreelanceAgentTask();

  // Initialize auto-dispatcher (requires persona registry + queue + container spawning)
  if (personaRegistry) {
    try {
      const { getDb } = await import('./db.js');
      autoDispatcher = new AutoDispatcher({
        db: getDb(),
        registry: personaRegistry,
        queue,
        getRegisteredGroups: () => registeredGroups,
        spawnTaskFn: async (groupJid, group, input) => {
          const output = await runContainerAgent(
            group,
            input,
            (proc, containerName) => {
              queue.registerProcess(groupJid, proc, containerName, group.folder);
              queue.setDesignation(groupJid, 'dispatch', true);
              queue.setSpawnReason(groupJid, `Persona: ${input.personaId}`, true);
              // Mark dispatch as running now that container actually started
              if (input.dispatchTaskId) {
                try {
                  getDb().prepare('UPDATE dispatch_log SET status = ? WHERE task_id = ? AND status = ?')
                    .run('running', input.dispatchTaskId, 'queued');
                } catch { /* best effort */ }
              }
            },
          );
          // Update dispatch + kanban task status based on result
          const taskId = input.dispatchTaskId || '';
          if (taskId) {
            const success = output.status === 'success';
            autoDispatcher?.updateDispatchStatus(taskId, success ? 'completed' : 'failed');

            // Look up task description for the report
            const taskRow = getDb().prepare('SELECT description, project FROM tasks WHERE id = ?').get(taskId) as any;
            const taskDesc = taskRow?.description?.slice(0, 120) || taskId;
            const project = taskRow?.project || 'unknown';
            const persona = input.personaId || 'unknown';

            if (success) {
              // Mark kanban task as completed
              try {
                getDb().prepare(
                  'UPDATE tasks SET status = ?, completed_at = ? WHERE id = ? AND status = ?',
                ).run('completed', Date.now(), taskId, 'in_progress');
                logger.info({ taskId }, 'Task completed by dispatch agent');
              } catch { /* best effort */ }

              // Send completion report to desktop notify group
              try {
                const { getNotifyJid } = await import('./notify.js');
                const mainJid = Object.entries(registeredGroups)
                  .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
                if (mainJid) {
                  const notifyJid = getNotifyJid(project !== 'nanoclaw' ? project : 'desktop', mainJid);
                  // Count remaining tasks
                  const stats = getDb().prepare(`
                    SELECT
                      SUM(CASE WHEN status IN ('completed','done') THEN 1 ELSE 0 END) as done,
                      COUNT(*) as total
                    FROM tasks WHERE project = ?
                  `).get(project) as any;
                  const progress = stats ? `${stats.done}/${stats.total}` : '';

                  await clawSend(notifyJid,
                    `🤖 ✅ *Agent Task Completed* [${progress}]\n` +
                    `*${taskId}*: ${taskDesc}\n` +
                    `Agent: ${persona}\n` +
                    `Result: ${output.result?.slice(0, 200) || 'completed successfully'}`,
                  );
                }
              } catch { /* notification best effort */ }
            } else {
              // Check if desktop_claude completed work even though the container failed/timed out.
              // The agent may have done real work (committed code) but the container died before
              // calling task_tool. In that case, mark as done instead of resetting to pending.
              const { consumeDesktopCompletions } = await import('./ipc.js');
              const desktopCompletions = consumeDesktopCompletions(group.folder);

              if (desktopCompletions > 0) {
                // Desktop Claude completed work — treat as success despite container failure
                try {
                  getDb().prepare(
                    'UPDATE tasks SET status = ?, completed_at = ? WHERE id = ? AND status = ?',
                  ).run('done', Date.now(), taskId, 'in_progress');
                  autoDispatcher?.updateDispatchStatus(taskId, 'completed');
                  logger.info({ taskId, desktopCompletions }, 'Task marked done (desktop_claude completed despite container failure)');
                } catch { /* best effort */ }

                try {
                  const { getNotifyJid } = await import('./notify.js');
                  const mainJid = Object.entries(registeredGroups)
                    .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
                  if (mainJid) {
                    const notifyJid = getNotifyJid(project !== 'nanoclaw' ? project : 'desktop', mainJid);
                    await clawSend(notifyJid,
                      `🤖 ✅ *Agent Task Done* (container timed out but work committed)\n` +
                      `*${taskId}*: ${taskDesc}\n` +
                      `Agent: ${persona} (${desktopCompletions} desktop runs)`,
                    );
                  }
                } catch { /* notification best effort */ }
              } else {
                // No desktop_claude work done — reset to pending for retry
                try {
                  getDb().prepare('UPDATE tasks SET status = ?, assigned_agent = NULL WHERE id = ?')
                    .run('pending', taskId);
                  logger.info({ taskId }, 'Reset failed dispatch task to pending');
                } catch { /* best effort */ }

                // Send failure report
                try {
                  const { getNotifyJid } = await import('./notify.js');
                  const mainJid = Object.entries(registeredGroups)
                    .find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];
                  if (mainJid) {
                    const notifyJid = getNotifyJid(project !== 'nanoclaw' ? project : 'desktop', mainJid);
                    await clawSend(notifyJid,
                      `🤖 ❌ *Agent Task Failed* — will retry\n` +
                      `*${taskId}*: ${taskDesc}\n` +
                      `Agent: ${persona}\n` +
                      `Error: ${output.error?.slice(0, 200) || 'container exited with error'}`,
                    );
                  }
                } catch { /* notification best effort */ }
              }
            }
          }
        },
      });
      autoDispatcher.start();
      logger.info('AutoDispatcher started');
    } catch (err) {
      logger.warn({ err }, 'AutoDispatcher init failed');
    }
  }

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
            const { getNotifyJid } = await import('./notify.js');
            const summary = breadcrumb.summary || 'Agent deployed code changes';
            // Match summary to integration notify topics
            let topic: string = 'desktop';
            const summaryLower = summary.toLowerCase();
            for (const integ of getIntegrations()) {
              if (integ.notifyTopics && summaryLower.includes(integ.name)) {
                topic = Object.keys(integ.notifyTopics)[0] || 'desktop';
                break;
              }
            }
            await clawSend(getNotifyJid(topic, mainJid), `🔄 *Restarted* — ${summary}`);
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
  // Staggered to avoid rate-limiting the Claude API with concurrent requests.
  if (WARMUP_ON_START) {
    setTimeout(async () => {
      const WARMUP_STAGGER_MS = 15_000; // 15s between each warmup
      const INACTIVE_DAYS = 7; // skip groups with no messages in 7+ days
      const cutoff = new Date(Date.now() - INACTIVE_DAYS * 86_400_000).toISOString();

      let delay = 0;
      for (const [chatJid, group] of Object.entries(registeredGroups)) {
        if (group.containerConfig?.noWarmup) continue;

        // Skip warmup for groups with no recent inbound messages
        try {
          const row = getDb().prepare(
            'SELECT MAX(timestamp) as last_msg FROM messages WHERE chat_jid = ? AND is_from_me = 0'
          ).get(chatJid) as { last_msg: string | null } | undefined;
          if (!row?.last_msg || row.last_msg < cutoff) {
            logger.info({ group: group.name, lastMsg: row?.last_msg ?? 'never' }, 'Skipping warmup (inactive group)');
            continue;
          }
        } catch { /* if DB check fails, warm up anyway */ }

        const jid = chatJid; // capture for closure
        setTimeout(() => {
          queue.warmup(jid, () => warmupGroupContainer(jid));
        }, delay);
        delay += WARMUP_STAGGER_MS;
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
