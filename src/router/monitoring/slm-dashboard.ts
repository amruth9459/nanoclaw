/**
 * SLM Usage Dashboard
 *
 * Turns the raw {@link SlmUsageTracker} call log into a compact, serializable
 * dashboard: cost savings, fallback rate, and task / model distribution. This is
 * the SLM-first analogue of {@link ./router-metrics.ts RouterMetrics} (which
 * dashboards the router as a whole) and is exposed to agents over IPC via the
 * `slm_dashboard` handler + the `slm_savings` MCP tool.
 *
 * Optionally folds in a {@link HeterogeneousRouter} scoreboard so the dashboard
 * can show which specialist is winning each task. The scoreboard is hidden
 * routing state on the orchestrator — passing it here is the one sanctioned way
 * it leaves the router, and it is never fed back into a prompt.
 */

import type { SlmUsageTracker, SlmSavingsReport } from './router-metrics.js';
import type { ScoreboardRow } from '../heterogeneous-router.js';

/** A model's share of recorded SLM traffic. */
export interface SlmModelShare {
  modelId: string;
  calls: number;
  share: number; // 0..1 of total calls in window
}

/** A task's share of recorded SLM traffic. */
export interface SlmTaskShare {
  task: string;
  calls: number;
  share: number; // 0..1 of total calls in window
}

export interface SlmDashboardData {
  generatedAt: string;
  windowLabel: string;
  windowMs: number;

  savings: {
    slmCalls: number;
    apiCalls: number;
    totalCalls: number;
    /** USD saved by serving SLM-eligible work locally instead of via API. */
    savedUsd: number;
    /** USD the same work would have cost if every call hit the API. */
    wouldHaveCostUsd: number;
    /** 0..1 — share of calls that escalated to a paid fallback. */
    fallbackRate: number;
    /** 0..1 — share of calls served locally for $0. */
    localWinRate: number;
  };

  /** Per-task call distribution, busiest first. */
  taskDistribution: SlmTaskShare[];
  /** Per-model call distribution, busiest first. */
  modelDistribution: SlmModelShare[];
  /** Per-task specialist accuracy scoreboard (empty unless a router is supplied). */
  scoreboard: Record<string, ScoreboardRow[]>;

  /** One-line headline, e.g. "This week: 847 SLM calls, saved $25.41 vs API". */
  summary: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Builds dashboards from a shared {@link SlmUsageTracker}. Stateless beyond the
 * tracker reference — safe to construct per request.
 */
export class SlmDashboard {
  constructor(
    private readonly tracker: SlmUsageTracker,
    /** Optional source of the per-task specialist scoreboard. */
    private readonly scoreboardSource?: { scoreboard(): Record<string, ScoreboardRow[]> },
  ) {}

  /** Build the dashboard over the trailing window (default 7 days). */
  generate(windowMs: number = WEEK_MS, windowLabel = 'This week'): SlmDashboardData {
    const report: SlmSavingsReport = this.tracker.report(windowMs, windowLabel);
    const total = report.totalCalls;

    const taskDistribution: SlmTaskShare[] = Object.entries(report.byTask)
      .map(([task, calls]) => ({ task, calls, share: total > 0 ? calls / total : 0 }))
      .sort((a, b) => b.calls - a.calls);

    const modelDistribution: SlmModelShare[] = Object.entries(report.byModel)
      .map(([modelId, calls]) => ({ modelId, calls, share: total > 0 ? calls / total : 0 }))
      .sort((a, b) => b.calls - a.calls);

    return {
      generatedAt: new Date().toISOString(),
      windowLabel,
      windowMs,
      savings: {
        slmCalls: report.slmCalls,
        apiCalls: report.apiCalls,
        totalCalls: total,
        savedUsd: report.savedUsd,
        wouldHaveCostUsd: report.wouldHaveCostUsd,
        fallbackRate: report.fallbackRate,
        localWinRate: total > 0 ? report.slmCalls / total : 0,
      },
      taskDistribution,
      modelDistribution,
      scoreboard: this.scoreboardSource?.scoreboard() ?? {},
      summary: report.summary,
    };
  }

  /** WhatsApp/console-friendly multi-line report. */
  textSummary(windowMs?: number, windowLabel?: string): string {
    const d = this.generate(windowMs, windowLabel);
    const lines = [
      `*SLM Usage Dashboard (${d.windowLabel})*`,
      `• ${d.summary}`,
      `• Local wins: ${d.savings.slmCalls.toLocaleString()} (${pct(d.savings.localWinRate)}) | ` +
        `API fallbacks: ${d.savings.apiCalls.toLocaleString()} (${pct(d.savings.fallbackRate)})`,
      `• Saved $${d.savings.savedUsd.toFixed(2)} of $${d.savings.wouldHaveCostUsd.toFixed(2)} all-API cost`,
    ];
    if (d.taskDistribution.length > 0) {
      lines.push(
        '• By task: ' + d.taskDistribution.map((t) => `${t.task} ${t.calls} (${pct(t.share)})`).join(', '),
      );
    }
    if (d.modelDistribution.length > 0) {
      lines.push('• By model: ' + d.modelDistribution.map((m) => `${m.modelId} ${m.calls}`).join(', '));
    }
    for (const [task, rows] of Object.entries(d.scoreboard)) {
      if (rows.length > 0) {
        lines.push(
          `• ${task} scoreboard: ` +
            rows.map((r) => `${r.modelId} ${(r.accuracy * 100).toFixed(0)}% (${r.correct}/${r.total})`).join(', '),
        );
      }
    }
    return lines.join('\n');
  }

  /** JSON dashboard for storage / the IPC response. */
  toJSON(windowMs?: number, windowLabel?: string): string {
    return JSON.stringify(this.generate(windowMs, windowLabel), null, 2);
  }
}

/** Persist a dashboard snapshot (1h / 24h / 7d windows) to a file. */
export async function saveSlmDashboard(
  dashboard: SlmDashboard,
  filePath: string,
): Promise<void> {
  const fs = await import('fs/promises');
  const snapshot = {
    generatedAt: new Date().toISOString(),
    last_1h: dashboard.generate(60 * 60 * 1000, 'Last hour'),
    last_24h: dashboard.generate(24 * 60 * 60 * 1000, 'Last 24h'),
    last_7d: dashboard.generate(WEEK_MS, 'This week'),
  };
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
