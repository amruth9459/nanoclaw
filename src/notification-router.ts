/**
 * Notification Router — routes desktop notifications to WhatsApp groups.
 *
 * Used by Claude Code hooks (via POST /api/notify) to forward desktop
 * notifications to the "claw desktop" WhatsApp group.
 *
 * Features:
 * - Deduplication: skips identical title+body within 30 seconds
 * - Rate limiting: max 10 notifications per minute
 * - Formatted WhatsApp output: *[source]* title\nbody
 */

import { DESKTOP_NOTIFY_JID } from './config.js';
import { logger } from './logger.js';

export interface Notification {
  title: string;
  body: string;
  source: string;
  timestamp?: number;
}

// ── Dedup ────────────────────────────────────────────────────────────────────

const DEDUP_WINDOW_MS = 30_000;
const recentNotifications = new Map<string, number>();

// Purge stale entries every 60 seconds
setInterval(() => {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  for (const [key, ts] of recentNotifications) {
    if (ts < cutoff) recentNotifications.delete(key);
  }
}, 60_000);

function isDuplicate(title: string, body: string): boolean {
  const key = `${title}\0${body}`;
  const lastSeen = recentNotifications.get(key);
  const now = Date.now();
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
    return true;
  }
  recentNotifications.set(key, now);
  return false;
}

// ── Rate Limiter ─────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateBucketTimestamps: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  // Remove expired entries
  while (rateBucketTimestamps.length > 0 && rateBucketTimestamps[0] < cutoff) {
    rateBucketTimestamps.shift();
  }
  if (rateBucketTimestamps.length >= RATE_LIMIT_MAX) {
    return true;
  }
  rateBucketTimestamps.push(now);
  return false;
}

// ── Send function (set by caller) ────────────────────────────────────────────

let sendFn: ((jid: string, text: string) => Promise<void>) | null = null;

/**
 * Initialize the notification router with a send function.
 * Called once from main() after clawSend is available.
 */
export function initNotificationRouter(
  send: (jid: string, text: string) => Promise<void>,
): void {
  sendFn = send;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Route a notification to the desktop WhatsApp group.
 *
 * Format: *[source]* title
 *         body
 *
 * Returns silently on dedup hit, rate limit, or missing config.
 */
export async function routeNotification(notification: Notification): Promise<void> {
  const { title, body, source } = notification;

  if (!title || !source) {
    logger.warn({ notification }, 'Notification missing title or source, skipping');
    return;
  }

  if (!DESKTOP_NOTIFY_JID) {
    logger.warn('DESKTOP_NOTIFY_JID not configured, skipping notification');
    return;
  }

  if (!sendFn) {
    logger.warn('Notification router not initialized (no sendFn), skipping');
    return;
  }

  // Dedup: skip if same title+body seen within 30s
  if (isDuplicate(title, body)) {
    logger.debug({ title, source }, 'Notification deduplicated, skipping');
    return;
  }

  // Rate limit: max 10 per minute
  if (isRateLimited()) {
    logger.warn({ title, source }, 'Notification rate limited, skipping');
    return;
  }

  // Format: *[source]* title\nbody
  const formatted = body
    ? `*[${source}]* ${title}\n${body}`
    : `*[${source}]* ${title}`;

  try {
    await sendFn(DESKTOP_NOTIFY_JID, formatted);
    logger.info({ title, source, jid: DESKTOP_NOTIFY_JID }, 'Notification routed');
  } catch (err) {
    logger.error({ err, title, source }, 'Failed to route notification');
  }
}
