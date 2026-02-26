import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  WAMessage,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, OPEN_MENTIONS, STORE_DIR, MEDIA_DIR, MAX_MEDIA_SIZE_MB } from '../config.js';
import {
  getChatChannel,
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { validateFileType } from '../file-validation.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Shared across all channel instances to deduplicate messages received by
// multiple connections (e.g. multi-device sync delivering the same message
// to both WhatsApp accounts).  Cleared every 10 minutes; a message that
// genuinely arrives 10 minutes late would be processed twice, but that is
// an acceptable edge-case compared to the alternative of a memory leak.
const processedMessageIds = new Set<string>();
setInterval(() => processedMessageIds.clear(), 10 * 60 * 1000);

interface MediaInfo {
  type: 'image' | 'video' | 'audio' | 'document';
  path: string;
  mimetype: string;
  size: number;
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Channel identifier — used for routing replies. Default: 'whatsapp' */
  name?: string;
  /** Auth state directory. Default: store/auth */
  authDir?: string;
  /** If false, QR auth and logout don't crash the process. Default: true */
  primary?: boolean;
  /** Called when connection is restored after being down for > 30s */
  onReconnect?: (downMs: number) => void;
}

export class WhatsAppChannel implements Channel {
  name: string;

  private isPrimary: boolean;
  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

  private opts: WhatsAppChannelOpts;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly WATCHDOG_MS = 3 * 60 * 1000; // 3 minutes — catch silent dead connections faster
  // Stored so reconnect attempts can still resolve the original connect() Promise
  private connectResolve?: () => void;
  // Track when connection dropped to report downtime on reconnect
  private disconnectedAt: number | null = null;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
    this.name = opts.name ?? 'whatsapp';
    this.isPrimary = opts.primary !== false;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectInternal(resolve, reject).catch(reject);
    });
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      logger.warn({ channel: this.name }, 'Watchdog: no WhatsApp activity for 10 min, forcing reconnect');
      try { this.sock?.end(undefined); } catch {}
      this.connected = false;
      this.scheduleReconnect();
    }, WhatsAppChannel.WATCHDOG_MS);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // already scheduled
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
    const delayMs = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 60_000);
    this.reconnectAttempts++;
    logger.info({ attempt: this.reconnectAttempts, delayMs }, 'Reconnecting...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectInternal().catch((err) => {
        logger.error({ err }, 'Reconnect attempt failed');
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private async connectInternal(
    onFirstOpen?: () => void,
    onFirstFail?: (err: Error) => void,
  ): Promise<void> {
    const authDir = this.opts.authDir ?? path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await Promise.race([
      fetchLatestWaWebVersion(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fetchLatestWaWebVersion timeout')), 5000)),
    ]).catch(() => ({ version: [2, 3000, 1027934701] as [number, number, number] }));

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
      version,
      keepAliveIntervalMs: 15_000, // ping every 15s (default ~30s) — keeps NAT mappings alive
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (!this.isPrimary) {
          // Secondary channel: fail gracefully — don't crash the process
          logger.warn(
            { channel: this.name },
            'Secondary WhatsApp channel needs QR auth. Run: npm run auth -- --slot 2',
          );
          onFirstFail?.(new Error(`${this.name}: QR authentication required — run: npm run auth -- --slot 2`));
          onFirstFail = undefined;
          return;
        }
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        if (this.disconnectedAt === null) this.disconnectedAt = Date.now();
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info({ reason, shouldReconnect, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

        if (shouldReconnect) {
          this.scheduleReconnect();
        } else {
          logger.info({ channel: this.name }, 'Logged out. Run /setup to re-authenticate.');
          if (this.isPrimary) process.exit(0);
          // Secondary: just stop — don't bring down the whole process
        }
      } else if (connection === 'open') {
        this.connected = true;
        this.reconnectAttempts = 0; // reset backoff on successful connect
        this.resetWatchdog();
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch(() => {});

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller.
        // Use stored connectResolve so reconnect attempts (which don't receive onFirstOpen)
        // can still resolve the original connect() Promise.
        const resolver = onFirstOpen ?? this.connectResolve;
        if (resolver) {
          resolver();
          this.connectResolve = undefined;
          onFirstOpen = undefined;
        }

        // Notify caller if connection was restored after a meaningful outage
        if (this.disconnectedAt !== null) {
          const downMs = Date.now() - this.disconnectedAt;
          this.disconnectedAt = null;
          if (downMs > 30_000 && this.opts.onReconnect) {
            this.opts.onReconnect(downMs);
          }
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      this.resetWatchdog(); // any incoming traffic = connection is alive
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Skip messages already handled by another channel instance (multi-device
        // sync can deliver the same message to multiple connected accounts).
        const msgId = msg.key.id ?? '';
        if (msgId && processedMessageIds.has(msgId)) continue;
        if (msgId) processedMessageIds.add(msgId);

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(chatJid, timestamp, undefined, this.name, isGroup);

        // Deliver full message for registered groups, and for non-registered
        // chats when open mentions is enabled and the message contains a trigger.
        const groups = this.opts.registeredGroups();
        const inRegisteredGroup = Boolean(groups[chatJid]);

        // Extract text content for registered groups and for mention detection
        const content =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          msg.message?.documentMessage?.caption ||
          '';

        // For non-registered chats: only proceed if open mentions is on and
        // the message @-mentions the assistant (text-only, no media download)
        const isOpenMention =
          !inRegisteredGroup &&
          OPEN_MENTIONS &&
          content.toLowerCase().includes(`@${ASSISTANT_NAME.toLowerCase()}`);

        if (inRegisteredGroup || isOpenMention) {
          // Download media attached to this message
          const mediaInfo = await this.downloadAndSaveMedia(msg);

          // Extract quoted message context (when user replies to a message)
          const contextInfo =
            msg.message?.extendedTextMessage?.contextInfo ??
            msg.message?.imageMessage?.contextInfo ??
            msg.message?.videoMessage?.contextInfo ??
            msg.message?.audioMessage?.contextInfo ??
            msg.message?.documentMessage?.contextInfo;

          let quotedText = '';
          let quotedMediaInfo: MediaInfo | null = null;

          if (contextInfo?.quotedMessage) {
            const qm = contextInfo.quotedMessage;

            // Extract the quoted text
            quotedText =
              qm.conversation ||
              qm.extendedTextMessage?.text ||
              qm.imageMessage?.caption ||
              qm.videoMessage?.caption ||
              qm.documentMessage?.caption ||
              '';

            // Download quoted media if present
            const hasQuotedMedia = !!(
              qm.imageMessage || qm.videoMessage || qm.audioMessage || qm.documentMessage
            );
            if (hasQuotedMedia) {
              const qmType = qm.imageMessage ? 'image'
                : qm.videoMessage ? 'video'
                : qm.audioMessage ? 'audio'
                : 'document';
              const qmFileName = qm.documentMessage?.fileName ?? '';
              const quotedWAMsg: WAMessage = {
                key: {
                  id: contextInfo.stanzaId ?? `quoted-${Date.now()}`,
                  remoteJid: chatJid,
                  participant: contextInfo.participant ?? undefined,
                  fromMe: false,
                },
                message: qm,
              };
              logger.debug({
                messageId: msg.key.id,
                quotedId: contextInfo.stanzaId,
                qmType,
                qmFileName,
                hasUrl: !!(qm.documentMessage?.url ?? qm.imageMessage?.url ?? qm.videoMessage?.url ?? qm.audioMessage?.url),
              }, 'Attempting quoted media download');
              // downloadAndSaveMedia catches errors internally and returns null on failure.
              // If it returns null here, we know the download failed (hasQuotedMedia is true),
              // so notify the agent rather than silently omitting the quoted file.
              quotedMediaInfo = await this.downloadAndSaveMedia(quotedWAMsg);
              if (!quotedMediaInfo) {
                const fileDesc = qmFileName ? `${qmType}: ${qmFileName}` : qmType;
                logger.warn({ messageId: msg.key.id, qmType, qmFileName }, 'Failed to download quoted media');
                quotedText = `${quotedText ? quotedText + ' ' : ''}[quoted ${fileDesc} — could not download]`;
              }
            }
          }

          // Build full content — prefix with quoted context so the agent sees it
          let fullContent = content;
          if (quotedText || quotedMediaInfo) {
            const label = quotedText
              ? `> ${quotedText.slice(0, 300)}${quotedText.length > 300 ? '…' : ''}`
              : `> [${quotedMediaInfo!.type}]`;
            fullContent = `${label}\n${content}`;
          }

          // New message media takes priority; fall back to quoted media
          const effectiveMedia = mediaInfo ?? quotedMediaInfo;

          // Skip protocol messages with no content of any kind
          if (!fullContent && !effectiveMedia) continue;

          const rawSender = msg.key.participant || msg.key.remoteJid || '';
          // Translate LID participant JID to phone JID so reactions work correctly
          const sender = rawSender.endsWith('@lid')
            ? await this.translateJid(rawSender)
            : rawSender;
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content: fullContent || (effectiveMedia ? `[${effectiveMedia.type}]` : ''),
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
            media_type: effectiveMedia?.type ?? null,
            media_path: effectiveMedia?.path ?? null,
            media_mimetype: effectiveMedia?.mimetype ?? null,
            media_size: effectiveMedia?.size ?? null,
          });
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  async sendFile(jid: string, buffer: Buffer, mimetype: string, filename: string, caption?: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, filename }, 'WA disconnected, cannot send file');
      return;
    }
    try {
      if (mimetype.startsWith('image/')) {
        await this.sock.sendMessage(jid, { image: buffer, caption: caption ?? '', mimetype });
      } else if (mimetype.startsWith('video/')) {
        await this.sock.sendMessage(jid, { video: buffer, caption: caption ?? '', mimetype });
      } else {
        await this.sock.sendMessage(jid, { document: buffer, mimetype, fileName: filename, caption: caption ?? '' });
      }
      logger.info({ jid, filename, mimetype, bytes: buffer.length }, 'File sent');
    } catch (err) {
      logger.warn({ jid, filename, err }, 'Failed to send file');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    if (!jid.endsWith('@g.us') && !jid.endsWith('@s.whatsapp.net')) return false;
    const chatChannel = getChatChannel(jid);
    // Unknown chats (no DB entry yet) fall to the primary channel
    if (!chatChannel) return this.isPrimary;
    return chatChannel === this.name;
  }

  ownPhoneJid(): string | undefined {
    if (!this.sock?.user?.id) return undefined;
    const phone = this.sock.user.id.split(':')[0];
    return `${phone}@s.whatsapp.net`;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.info({ jid, status, channel: this.name }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to update typing status');
    }
  }

  async sendReaction(jid: string, messageId: string, senderJid: string, emoji: string): Promise<void> {
    try {
      // Translate LID sender JID before using in reaction key
      const resolvedSender = senderJid.endsWith('@lid')
        ? await this.translateJid(senderJid)
        : senderJid;
      logger.info({ jid, messageId, emoji, senderJid, resolvedSender, channel: this.name }, 'Sending reaction');
      await this.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            id: messageId,
            remoteJid: jid,
            participant: resolvedSender || undefined,
            fromMe: false,
          },
        },
      });
      logger.info({ jid, messageId, emoji }, 'Reaction sent');
    } catch (err) {
      logger.warn({ jid, messageId, senderJid, err }, 'Failed to send reaction');
    }
  }

  /**
   * Update WhatsApp group description.
   * Used to post DashClaw URL and status info into the group info pane.
   */
  async updateGroupDescription(jid: string, description: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid }, 'Cannot update group description: not connected');
      return;
    }
    try {
      await this.sock.groupUpdateDescription(jid, description);
      logger.info({ jid }, 'Updated group description');
    } catch (err) {
      logger.error({ err, jid }, 'Failed to update group description');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug({ lidJid: jid, phoneJid: cached }, 'Translated LID to phone JID (cached)');
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID (signalRepository)');
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  /**
   * Download media from a WhatsApp message and save it to disk.
   * Returns media metadata if successful, null otherwise.
   */
  private async downloadAndSaveMedia(msg: WAMessage): Promise<MediaInfo | null> {
    try {
      // Determine media type and get the message content
      const messageContent = msg.message;
      if (!messageContent) return null;

      let mediaType: 'image' | 'video' | 'audio' | 'document' | null = null;
      let mimetype: string | null = null;
      let extension = '';
      let fileSize = 0;

      if (messageContent.imageMessage) {
        mediaType = 'image';
        mimetype = messageContent.imageMessage.mimetype || 'image/jpeg';
        extension = mimetype.split('/')[1] || 'jpg';
        fileSize = Number(messageContent.imageMessage.fileLength || 0);
      } else if (messageContent.videoMessage) {
        mediaType = 'video';
        mimetype = messageContent.videoMessage.mimetype || 'video/mp4';
        extension = mimetype.split('/')[1] || 'mp4';
        fileSize = Number(messageContent.videoMessage.fileLength || 0);
      } else if (messageContent.audioMessage) {
        mediaType = 'audio';
        mimetype = messageContent.audioMessage.mimetype || 'audio/ogg';
        extension = mimetype.includes('ogg') ? 'ogg' : 'mp3';
        fileSize = Number(messageContent.audioMessage.fileLength || 0);
      } else if (messageContent.documentMessage) {
        mediaType = 'document';
        mimetype = messageContent.documentMessage.mimetype || 'application/octet-stream';
        const fileName = messageContent.documentMessage.fileName || '';
        extension = fileName.split('.').pop() || 'bin';
        fileSize = Number(messageContent.documentMessage.fileLength || 0);
      } else {
        return null; // No media to download
      }

      // Check file size limit
      const maxSizeBytes = MAX_MEDIA_SIZE_MB * 1024 * 1024;
      if (fileSize > maxSizeBytes) {
        logger.warn({
          messageId: msg.key.id,
          fileSize,
          maxSize: maxSizeBytes,
          fileSizeMB: (fileSize / 1024 / 1024).toFixed(2),
          maxSizeMB: MAX_MEDIA_SIZE_MB
        }, 'Media file exceeds size limit, skipping download');
        return null;
      }

      // Download the media. Baileys only auto-retries reupload for 404/410;
      // 403 is not in its list, so we catch it and refresh the URL manually.
      let buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: logger,
          reuploadRequest: this.sock.updateMediaMessage,
        },
      ).catch(async (err) => {
        if (err?.output?.statusCode === 403) {
          logger.debug({ messageId: msg.key.id }, 'Got 403 on media download, refreshing URL via reupload');
          const refreshed = await this.sock.updateMediaMessage(msg);
          return downloadMediaMessage(refreshed, 'buffer', {}, { logger, reuploadRequest: this.sock.updateMediaMessage }) as Promise<Buffer>;
        }
        throw err;
      }) as Buffer;

      if (!buffer || buffer.length === 0) {
        logger.warn({ messageId: msg.key.id }, 'Downloaded media buffer is empty');
        return null;
      }

      // Validate file type matches claimed MIME type (magic byte check)
      if (!validateFileType(buffer, mimetype)) {
        logger.warn({
          messageId: msg.key.id,
          claimedMimetype: mimetype,
          actualSize: buffer.length,
        }, 'File type validation failed - magic bytes do not match claimed MIME type');
        return null;
      }

      // Ensure media directory exists
      fs.mkdirSync(MEDIA_DIR, { recursive: true });

      // Save to disk with message ID as filename
      const messageId = msg.key.id || `${Date.now()}`;
      const sanitizedId = messageId.replace(/[^a-zA-Z0-9-_]/g, '_');
      const filename = `${sanitizedId}.${extension}`;
      const filePath = path.join(MEDIA_DIR, filename);

      fs.writeFileSync(filePath, buffer);

      logger.info({
        messageId,
        mediaType,
        mimetype,
        size: buffer.length,
        path: filePath
      }, 'Media downloaded and saved');

      return {
        type: mediaType,
        path: filePath,
        mimetype,
        size: buffer.length,
      };
    } catch (err) {
      logger.error({ err, messageId: msg.key.id }, 'Failed to download media');
      return null;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
