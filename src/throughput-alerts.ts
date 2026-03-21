/**
 * Throughput Alert Rules — monitors token velocity and cost trends,
 * sends WhatsApp notifications for anomalies.
 *
 * Alert thresholds:
 * - WARN: tokens/hour < 50% of historical avg for 2+ consecutive hours
 * - CRITICAL: no tokens in 30 minutes
 * - INFO: cost/day trending >20% above daily budget
 */

import { getDb } from './db.js';
import { logger } from './logger.js';
import { routeNotification } from './notification-router.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ThroughputSnapshot {
  timestamp: number;
  intervalMs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestsCount: number;
  tokensPerSecond: number;
  costUsd: number;
  purposeBreakdown: Record<string, { tokens: number; cost: number }>;
}

export interface ThroughputAlert {
  id: number;
  alert_type: string;
  severity: string;
  message: string;
  metric_value: number;
  threshold: number;
  triggered_at: string;
  acknowledged: number;
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Daily cost budget (USD) — alert if trending above this */
const DAILY_BUDGET_USD = parseFloat(process.env.NANOCLAW_DAILY_BUDGET || '10');

/** Minimum hours of data before low-throughput alerts fire */
const MIN_HISTORY_HOURS = 6;

/** Cooldown between duplicate alerts of the same type (ms) */
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

const lastAlertTimes = new Map<string, number>();

// ── Alert Checks ─────────────────────────────────────────────────────────────

/**
 * Check all alert conditions against the current snapshot.
 * Called by throughput-monitor after each sample.
 */
export function checkThroughputAlerts(snap: ThroughputSnapshot): void {
  try {
    checkNoActivity(snap);
    checkLowThroughput(snap);
    checkCostTrend(snap);
  } catch (err) {
    logger.error({ err }, 'Throughput alert check failed');
  }
}

/**
 * CRITICAL: No tokens processed in the last 30 minutes.
 */
function checkNoActivity(snap: ThroughputSnapshot): void {
  const db = getDb();
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM usage_logs
    WHERE run_at >= ?
  `).get(thirtyMinAgo) as { cnt: number };

  if (row.cnt === 0) {
    fireAlert(
      'no_activity',
      'critical',
      'No token activity in the last 30 minutes. All agents may be idle.',
      0,
      1, // threshold: at least 1 request expected
    );
  }
}

/**
 * WARN: tokens/hour below 50% of historical average for 2+ hours.
 */
function checkLowThroughput(snap: ThroughputSnapshot): void {
  const db = getDb();

  // Get historical avg tokens/hour (last 7 days, excluding last 2 hours)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const hist = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
      COUNT(DISTINCT strftime('%Y-%m-%d %H', run_at)) as hours_active
    FROM usage_logs
    WHERE run_at >= ? AND run_at < ?
  `).get(weekAgo, twoHoursAgo) as { total_tokens: number; hours_active: number };

  if (hist.hours_active < MIN_HISTORY_HOURS) return; // Not enough history

  const avgTokensPerHour = hist.total_tokens / hist.hours_active;
  const threshold = avgTokensPerHour * 0.5;

  // Get tokens in the last 2 hours
  const recent = db.prepare(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
    FROM usage_logs
    WHERE run_at >= ?
  `).get(twoHoursAgo) as { total_tokens: number };

  const recentPerHour = recent.total_tokens / 2;

  if (recentPerHour < threshold && avgTokensPerHour > 0) {
    const pct = Math.round((recentPerHour / avgTokensPerHour) * 100);
    fireAlert(
      'low_throughput',
      'warn',
      `Token throughput at ${pct}% of historical average (${Math.round(recentPerHour)}/hr vs ${Math.round(avgTokensPerHour)}/hr avg). Under-utilizing API quota.`,
      recentPerHour,
      threshold,
    );
  }
}

/**
 * INFO: Daily cost trending >20% above budget.
 */
function checkCostTrend(snap: ThroughputSnapshot): void {
  const db = getDb();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as today_cost
    FROM usage_logs
    WHERE run_at >= ?
  `).get(todayIso) as { today_cost: number };

  // Project full-day cost from current rate
  const hoursElapsed = (Date.now() - todayStart.getTime()) / (60 * 60 * 1000);
  if (hoursElapsed < 1) return; // Too early in the day to project

  const projectedDailyCost = (row.today_cost / hoursElapsed) * 24;
  const threshold = DAILY_BUDGET_USD * 1.2; // 20% above budget

  if (projectedDailyCost > threshold) {
    fireAlert(
      'cost_overrun',
      'info',
      `Daily cost trending at $${projectedDailyCost.toFixed(2)} (budget: $${DAILY_BUDGET_USD.toFixed(2)}). Current spend: $${row.today_cost.toFixed(2)} in ${hoursElapsed.toFixed(1)}h.`,
      projectedDailyCost,
      threshold,
    );
  }
}

// ── Alert Storage & Notification ─────────────────────────────────────────────

function fireAlert(
  alertType: string,
  severity: string,
  message: string,
  metricValue: number,
  threshold: number,
): void {
  // Cooldown check
  const lastFired = lastAlertTimes.get(alertType) || 0;
  if (Date.now() - lastFired < ALERT_COOLDOWN_MS) return;
  lastAlertTimes.set(alertType, Date.now());

  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO throughput_alerts (alert_type, severity, message, metric_value, threshold, triggered_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(alertType, severity, message, metricValue, threshold, now);

  logger.warn({ alertType, severity, metricValue, threshold }, `Throughput alert: ${message}`);

  // Send WhatsApp notification for warn and critical
  if (severity === 'critical' || severity === 'warn') {
    const icon = severity === 'critical' ? '[CRITICAL]' : '[WARN]';
    routeNotification({
      title: `${icon} Throughput Alert`,
      body: message,
      source: 'throughput-monitor',
    });
  }
}

// ── Query Functions ──────────────────────────────────────────────────────────

/**
 * Get active (unacknowledged) alerts.
 */
export function getActiveAlerts(limit = 50): ThroughputAlert[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM throughput_alerts
    WHERE acknowledged = 0
    ORDER BY triggered_at DESC
    LIMIT ?
  `).all(limit) as ThroughputAlert[];
}

/**
 * Acknowledge an alert by ID.
 */
export function acknowledgeAlert(alertId: number): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE throughput_alerts SET acknowledged = 1 WHERE id = ?
  `).run(alertId);
  return result.changes > 0;
}
