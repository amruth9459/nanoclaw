/**
 * Daily Digest — replaces per-message cost footer spam with two daily summaries.
 *
 * 9 AM: Morning brief (overnight activity, today's queue)
 * 9 PM: Full report (all-day summary with costs, dispatch results, errors)
 */

import { getDb } from './db.js';
import { getUsageSince } from './db.js';
import { MAIN_GROUP_FOLDER } from './config.js';
import { logger } from './logger.js';

interface DispatchResult {
  task_id: string;
  description: string;
  status: string;
  persona_id: string;
}

interface UsageByGroup {
  group_id: string;
  total_cost: number;
  run_count: number;
}

function todayAt(hour: number): Date {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d;
}

function yesterdayAt(hour: number): Date {
  const d = todayAt(hour);
  d.setDate(d.getDate() - 1);
  return d;
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getUsageByGroup(since: string): UsageByGroup[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      group_id,
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COUNT(*) as run_count
    FROM usage_logs
    WHERE run_at >= ?
    GROUP BY group_id
    ORDER BY total_cost DESC
  `).all(since) as UsageByGroup[];
}

function getDispatchResults(since: string): DispatchResult[] {
  const db = getDb();
  try {
    return db.prepare(`
      SELECT
        d.task_id,
        COALESCE(t.description, d.task_id) as description,
        d.status,
        d.persona_id
      FROM dispatch_log d
      LEFT JOIN tasks t ON t.id = d.task_id
      WHERE d.dispatched_at >= ?
      ORDER BY d.dispatched_at DESC
    `).all(since) as DispatchResult[];
  } catch {
    return [];
  }
}

function getMessageCount(since: string): { total: number; groups: number } {
  const db = getDb();
  const result = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(DISTINCT chat_jid) as groups
    FROM messages
    WHERE timestamp >= ? AND is_from_me = 0
  `).get(since) as { total: number; groups: number };
  return result;
}

function getContainerErrors(since: string): number {
  const db = getDb();
  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count
      FROM usage_logs
      WHERE run_at >= ? AND is_error = 1
    `).get(since) as { count: number };
    return result.count;
  } catch {
    return 0;
  }
}

export function generateMorningBrief(): string {
  const since = yesterdayAt(21).toISOString(); // Since last 9 PM
  const dispatches = getDispatchResults(since);
  const completed = dispatches.filter(d => d.status === 'completed').length;
  const failed = dispatches.filter(d => d.status === 'failed').length;
  const queued = dispatches.filter(d => d.status === 'queued').length;
  const pending = dispatches.filter(d => d.status === 'running').length;

  const db = getDb();
  let todayTasks = 0;
  try {
    const result = db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE status IN ('pending', 'in_progress')
    `).get() as { count: number };
    todayTasks = result.count;
  } catch { /* table may not exist */ }

  const lines = [`*Morning Brief — ${formatDate()}*`];

  if (completed + failed > 0) {
    lines.push(`*Overnight:* ${completed} task${completed !== 1 ? 's' : ''} completed${failed > 0 ? `, ${failed} failed` : ''}`);
  } else {
    lines.push('*Overnight:* No tasks ran');
  }

  if (todayTasks > 0 || queued > 0 || pending > 0) {
    const parts = [];
    if (todayTasks > 0) parts.push(`${todayTasks} pending tasks`);
    if (queued > 0) parts.push(`${queued} queued dispatches`);
    if (pending > 0) parts.push(`${pending} running`);
    lines.push(`*Queued:* ${parts.join(', ')}`);
  }

  return lines.join('\n');
}

export function generateEveningReport(): string {
  const since = todayAt(0).toISOString(); // Since midnight
  const date = formatDate();
  const usage = getUsageSince(since);
  const usageByGroup = getUsageByGroup(since);
  const messages = getMessageCount(since);
  const dispatches = getDispatchResults(since);
  const errors = getContainerErrors(since);

  const lines = [`*Daily Report — ${date}*`, ''];

  // Conversations
  lines.push(`*Conversations:* ${messages.total} messages across ${messages.groups} group${messages.groups !== 1 ? 's' : ''}`);

  // Cost breakdown
  if (usage.total_cost > 0) {
    const costParts = usageByGroup
      .filter(g => g.total_cost > 0.01)
      .map(g => `${g.group_id} $${g.total_cost.toFixed(2)}`);
    lines.push(`*Cost:* $${usage.total_cost.toFixed(2)}${costParts.length > 0 ? ` (${costParts.join(', ')})` : ''}`);
  } else {
    lines.push('*Cost:* $0.00');
  }

  // Dispatch results
  if (dispatches.length > 0) {
    const completed = dispatches.filter(d => d.status === 'completed');
    const failed = dispatches.filter(d => d.status === 'failed');
    const running = dispatches.filter(d => d.status === 'running');

    lines.push('');
    lines.push(`*Dispatch:* ${completed.length}/${dispatches.length} completed`);
    for (const d of completed.slice(0, 5)) {
      const desc = d.description.slice(0, 80);
      lines.push(`  ${desc}`);
    }
    for (const d of failed.slice(0, 3)) {
      const desc = d.description.slice(0, 80);
      lines.push(`  ${desc} (failed)`);
    }
    for (const d of running.slice(0, 2)) {
      const desc = d.description.slice(0, 80);
      lines.push(`  ${desc} (in progress)`);
    }
  }

  // Errors
  if (errors > 0) {
    lines.push('');
    lines.push(`*Errors:* ${errors} container failure${errors !== 1 ? 's' : ''}`);
  }

  return lines.join('\n');
}

/**
 * Start the daily digest scheduler.
 * Checks every minute whether it's time to send a digest.
 */
export function startDailyDigest(
  sendMessage: (jid: string, text: string) => Promise<void>,
  getMainJid: () => string | undefined,
): void {
  let lastMorningSent = '';
  let lastEveningSent = '';

  const CHECK_INTERVAL = 60_000; // 1 minute

  const check = async () => {
    const now = new Date();
    const hour = now.getHours();
    const dateKey = now.toISOString().slice(0, 10); // YYYY-MM-DD

    const mainJid = getMainJid();
    if (!mainJid) return;

    // 9 AM morning brief
    if (hour === 9 && lastMorningSent !== dateKey) {
      try {
        const brief = generateMorningBrief();
        await sendMessage(mainJid, brief);
        lastMorningSent = dateKey;
        logger.info('Daily digest: morning brief sent');
      } catch (err) {
        logger.warn({ err }, 'Daily digest: morning brief failed');
      }
    }

    // 9 PM evening report
    if (hour === 21 && lastEveningSent !== dateKey) {
      try {
        const report = generateEveningReport();
        await sendMessage(mainJid, report);
        lastEveningSent = dateKey;
        logger.info('Daily digest: evening report sent');
      } catch (err) {
        logger.warn({ err }, 'Daily digest: evening report failed');
      }
    }
  };

  setInterval(check, CHECK_INTERVAL);
  logger.info('Daily digest scheduler started (9 AM brief, 9 PM report)');
}
