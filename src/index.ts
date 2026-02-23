import fs from 'fs';
import path from 'path';

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
  TRIGGER_PATTERN,
  WA2_ENABLED,
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
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getChatName,
  getMessagesSince,
  getNewMentions,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { startDashboard } from './dashboard.js';
import { GroupQueue } from './group-queue.js';
import { HitlGate } from './hitl.js';
import { startIpcWatcher } from './ipc.js';
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
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();
const hitlGate = new HitlGate();

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

  const prompt = formatMessages(missedMessages);

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

  // INSTANT FEEDBACK: React to the last user message with 👀
  // Using sendReaction (emoji on the message) rather than a standalone text
  // message — reactions are visible even when bot and user share a phone number.
  if (INSTANT_ACK) {
    const lastMsg = missedMessages[missedMessages.length - 1];
    if (channel.sendReaction) {
      await channel.sendReaction(chatJid, lastMsg.id, lastMsg.sender, '👀').catch(() => {});
    } else {
      await channel.sendMessage(chatJid, '👀').catch(() => {});
    }
  }
  await channel.setTyping?.(chatJid, true);

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

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result

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
    // Handle final result — suppress if streaming already delivered the content
    // (the success result text is the same accumulated response, just repeated)
    else if (result.result && !streamingChunksSent) {
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
      streamingChunksSent = false;
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

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

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
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
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
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
              if (channel.sendReaction) {
                channel.sendReaction(chatJid, lastMsg.id, lastMsg.sender, '👀').catch(() => {});
              }
            }
            channel.setTyping?.(chatJid, true)?.catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
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

          // ACK with 👀 so the user knows we saw it
          const channel = findChannel(channels, chatJid);
          if (channel && INSTANT_ACK) {
            const last = msgs[msgs.length - 1];
            channel.sendReaction?.(chatJid, last.id, last.sender, '👀').catch(() => {});
          }

          queue.enqueueMessageCheck(chatJid);
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

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  whatsapp = new WhatsAppChannel(channelOpts);
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
    await wa2.connect().catch((err: Error) => {
      logger.warn({ err: err.message }, 'Second WhatsApp channel not connected — authenticate first: npm run auth -- --slot 2');
      channels.splice(channels.indexOf(wa2), 1);
    });
  }

  // Start subsystems (independently of connection handler)
  startDashboard(queue);
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    hitlGate,
    getMainGroupJid: () =>
      Object.entries(registeredGroups).find(
        ([, g]) => g.folder === MAIN_GROUP_FOLDER,
      )?.[0],
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

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
