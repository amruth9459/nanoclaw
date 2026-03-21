/**
 * Token Throughput Monitor — Karpathy-inspired system.
 *
 * "Token throughput = new GPU utilization. Unused tokens = unmaxed leverage."
 *
 * Aggregates from the existing `usage_logs` table and stores time-series
 * snapshots in `throughput_metrics`. Runs on a configurable interval
 * (default: every 5 minutes) and exposes current/historical throughput data.
 */

import { getDb } from './db.js';
import { logger } from './logger.js';
import { checkThroughputAlerts, type ThroughputSnapshot } from './throughput-alerts.js';

// ── Configuration ────────────────────────────────────────────────────────────

/** How often to sample throughput (ms) */
const SAMPLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** How far back each sample looks for usage_logs entries */
const SAMPLE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum age of metrics rows to keep (30 days) */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ── Core Aggregation ─────────────────────────────────────────────────────────

/**
 * Query usage_logs for the given window and produce a throughput snapshot.
 */
function aggregateWindow(windowMs: number): ThroughputSnapshot {
  const db = getDb();
  const now = Date.now();
  const cutoffIso = new Date(now - windowMs).toISOString();

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd,
      COUNT(*) as requests_count
    FROM usage_logs
    WHERE run_at >= ?
  `).get(cutoffIso) as {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    requests_count: number;
  };

  // Purpose breakdown
  const purposes = db.prepare(`
    SELECT
      COALESCE(purpose, 'conversation') as purpose,
      COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
      COALESCE(SUM(cost_usd), 0) as cost
    FROM usage_logs
    WHERE run_at >= ?
    GROUP BY purpose
  `).all(cutoffIso) as Array<{ purpose: string; tokens: number; cost: number }>;

  const tokensPerSecond = row.total_tokens / (windowMs / 1000);

  return {
    timestamp: now,
    intervalMs: windowMs,
    totalTokens: row.total_tokens,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    requestsCount: row.requests_count,
    tokensPerSecond,
    costUsd: row.cost_usd,
    purposeBreakdown: purposes.reduce((acc, p) => {
      acc[p.purpose] = { tokens: p.tokens, cost: p.cost };
      return acc;
    }, {} as Record<string, { tokens: number; cost: number }>),
  };
}

/**
 * Store a snapshot in throughput_metrics.
 */
function storeSnapshot(snap: ThroughputSnapshot): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO throughput_metrics
      (timestamp, interval_ms, total_tokens, input_tokens, output_tokens,
       requests_count, tokens_per_second, cost_usd, quota_used_percent,
       models_used, purpose_breakdown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snap.timestamp,
    snap.intervalMs,
    snap.totalTokens,
    snap.inputTokens,
    snap.outputTokens,
    snap.requestsCount,
    snap.tokensPerSecond,
    snap.costUsd,
    null, // quota_used_percent: not available without API-level quota data
    null, // models_used: could be extended later
    JSON.stringify(snap.purposeBreakdown),
  );
}

/**
 * Prune old metrics beyond retention window.
 */
function pruneOldMetrics(): void {
  const db = getDb();
  const cutoff = Date.now() - RETENTION_MS;
  db.prepare('DELETE FROM throughput_metrics WHERE timestamp < ?').run(cutoff);
}

// ── Sampling Loop ────────────────────────────────────────────────────────────

function sample(): void {
  try {
    const snap = aggregateWindow(SAMPLE_WINDOW_MS);
    storeSnapshot(snap);
    checkThroughputAlerts(snap);
  } catch (err) {
    logger.error({ err }, 'Throughput monitor sample failed');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the throughput monitor. Call once from main().
 */
export function startThroughputMonitor(): void {
  if (intervalHandle) return;
  logger.info('Starting throughput monitor (interval=%dms)', SAMPLE_INTERVAL_MS);

  // Initial sample
  sample();

  // Periodic sampling
  intervalHandle = setInterval(sample, SAMPLE_INTERVAL_MS);

  // Prune daily
  setInterval(pruneOldMetrics, 24 * 60 * 60 * 1000);
}

/**
 * Stop the throughput monitor.
 */
export function stopThroughputMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Get current throughput (last 5 minutes).
 */
export function getCurrentThroughput(): ThroughputSnapshot {
  return aggregateWindow(SAMPLE_WINDOW_MS);
}

/**
 * Get hourly aggregates for the past 24 hours.
 */
export function getHourlyThroughput(): Array<{
  hour: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  requestsCount: number;
  tokensPerSecond: number;
  costUsd: number;
}> {
  const db = getDb();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoff).toISOString();

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00Z', run_at) as hour,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
      COUNT(*) as requests_count,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM usage_logs
    WHERE run_at >= ?
    GROUP BY hour
    ORDER BY hour ASC
  `).all(cutoffIso) as Array<{
    hour: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    requests_count: number;
    cost_usd: number;
  }>;

  return rows.map(r => ({
    hour: r.hour,
    totalTokens: r.total_tokens,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    requestsCount: r.requests_count,
    tokensPerSecond: r.total_tokens / 3600,
    costUsd: r.cost_usd,
  }));
}
