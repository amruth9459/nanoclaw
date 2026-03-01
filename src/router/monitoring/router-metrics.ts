/**
 * Router Metrics
 * Real-time monitoring and dashboards for routing decisions
 */

import type { RoutingMetrics, ModelPerformance } from '../types.js';
import type { PerformanceTracker } from '../performance-tracker.js';

export interface MetricsDashboard {
  timestamp: Date;
  period: string;

  // Overview
  summary: {
    totalRequests: number;
    successRate: number;
    avgLatencyMs: number;
    totalCostUsd: number;
    costSavedUsd: number;
    savingsPercentage: number;
  };

  // Distribution
  distribution: {
    byTier: Record<string, number>;
    byTaskType: Record<string, number>;
    bySource: Record<string, number>;
  };

  // Performance
  performance: {
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    fallbackRate: number;
    errorRate: number;
  };

  // Efficiency
  efficiency: {
    localSlmPercentage: number;
    localLlmPercentage: number;
    cloudPercentage: number;
  };

  // Top models
  topModels: Array<{
    modelId: string;
    requestCount: number;
    avgLatencyMs: number;
    successRate: number;
  }>;
}

/**
 * Metrics collection and dashboard generation
 */
export class RouterMetrics {
  constructor(private tracker: PerformanceTracker) {}

  /**
   * Generate dashboard for a time period
   */
  generateDashboard(period: '1h' | '24h' | '7d' | '30d'): MetricsDashboard {
    const metrics = this.tracker.getMetrics(period);
    const efficiency = this.tracker.getEfficiencyReport();
    const topModels = this.tracker.getTopModels(5);

    // Build model details
    const modelDetails = topModels.map((tm) => {
      const perf = this.tracker.getModelPerformance(tm.modelId, period);
      return {
        modelId: tm.modelId,
        requestCount: perf.requestCount,
        avgLatencyMs: perf.avgLatencyMs,
        successRate: perf.successCount / perf.requestCount,
      };
    });

    return {
      timestamp: new Date(),
      period,

      summary: {
        totalRequests: metrics.totalRequests,
        successRate: metrics.successRate,
        avgLatencyMs: metrics.avgLatencyMs,
        totalCostUsd: metrics.totalCostUsd,
        costSavedUsd: metrics.costSavedUsd,
        savingsPercentage: efficiency.savingsPercentage,
      },

      distribution: {
        byTier: metrics.byTier as any,
        byTaskType: metrics.byTaskType as any,
        bySource: metrics.bySource as any,
      },

      performance: {
        p50LatencyMs: metrics.p50LatencyMs,
        p95LatencyMs: metrics.p95LatencyMs,
        p99LatencyMs: metrics.p99LatencyMs,
        fallbackRate: metrics.fallbackRate,
        errorRate: metrics.errorRate,
      },

      efficiency: {
        localSlmPercentage: metrics.localSlmPercentage,
        localLlmPercentage: metrics.localLlmPercentage,
        cloudPercentage: metrics.cloudPercentage,
      },

      topModels: modelDetails,
    };
  }

  /**
   * Generate text summary for WhatsApp/console
   */
  generateTextSummary(period: '1h' | '24h' | '7d' | '30d'): string {
    const dashboard = this.generateDashboard(period);
    const lines: string[] = [];

    lines.push(`*Router Performance (${period})*\n`);

    // Summary
    lines.push('*Summary:*');
    lines.push(`• Total Requests: ${dashboard.summary.totalRequests.toLocaleString()}`);
    lines.push(`• Success Rate: ${(dashboard.summary.successRate * 100).toFixed(1)}%`);
    lines.push(`• Avg Latency: ${dashboard.summary.avgLatencyMs.toFixed(0)}ms`);
    lines.push(`• Total Cost: $${dashboard.summary.totalCostUsd.toFixed(2)}`);
    lines.push(`• Cost Saved: $${dashboard.summary.costSavedUsd.toFixed(2)} (${dashboard.summary.savingsPercentage.toFixed(1)}%)`);
    lines.push('');

    // Efficiency
    lines.push('*Efficiency:*');
    lines.push(`• Local SLM: ${dashboard.efficiency.localSlmPercentage.toFixed(1)}%`);
    lines.push(`• Local LLM: ${dashboard.efficiency.localLlmPercentage.toFixed(1)}%`);
    lines.push(`• Cloud: ${dashboard.efficiency.cloudPercentage.toFixed(1)}%`);
    lines.push('');

    // Performance
    lines.push('*Latency:*');
    lines.push(`• p50: ${dashboard.performance.p50LatencyMs.toFixed(0)}ms`);
    lines.push(`• p95: ${dashboard.performance.p95LatencyMs.toFixed(0)}ms`);
    lines.push(`• p99: ${dashboard.performance.p99LatencyMs.toFixed(0)}ms`);
    lines.push('');

    // Top models
    if (dashboard.topModels.length > 0) {
      lines.push('*Top Models:*');
      dashboard.topModels.forEach((model, idx) => {
        lines.push(
          `${idx + 1}. ${model.modelId}: ${model.requestCount} reqs, ${model.avgLatencyMs.toFixed(0)}ms avg`,
        );
      });
    }

    return lines.join('\n');
  }

  /**
   * Generate JSON dashboard for storage
   */
  generateJSON(period: '1h' | '24h' | '7d' | '30d'): string {
    const dashboard = this.generateDashboard(period);
    return JSON.stringify(dashboard, null, 2);
  }

  /**
   * Get alert-worthy conditions
   */
  getAlerts(): Array<{
    severity: 'warning' | 'critical';
    message: string;
    metric: string;
    value: number;
    threshold: number;
  }> {
    const alerts: Array<{
      severity: 'warning' | 'critical';
      message: string;
      metric: string;
      value: number;
      threshold: number;
    }> = [];

    const metrics = this.tracker.getMetrics('1h');

    // Error rate too high
    if (metrics.errorRate > 0.1) {
      alerts.push({
        severity: 'critical',
        message: 'Error rate exceeds 10%',
        metric: 'errorRate',
        value: metrics.errorRate,
        threshold: 0.1,
      });
    } else if (metrics.errorRate > 0.05) {
      alerts.push({
        severity: 'warning',
        message: 'Error rate exceeds 5%',
        metric: 'errorRate',
        value: metrics.errorRate,
        threshold: 0.05,
      });
    }

    // Fallback rate too high
    if (metrics.fallbackRate > 0.2) {
      alerts.push({
        severity: 'warning',
        message: 'Fallback rate exceeds 20%',
        metric: 'fallbackRate',
        value: metrics.fallbackRate,
        threshold: 0.2,
      });
    }

    // Latency too high
    if (metrics.p95LatencyMs > 5000) {
      alerts.push({
        severity: 'warning',
        message: 'P95 latency exceeds 5s',
        metric: 'p95LatencyMs',
        value: metrics.p95LatencyMs,
        threshold: 5000,
      });
    }

    // Cloud usage too high (cost optimization)
    if (metrics.cloudPercentage > 30) {
      alerts.push({
        severity: 'warning',
        message: 'Cloud usage exceeds 30%',
        metric: 'cloudPercentage',
        value: metrics.cloudPercentage,
        threshold: 30,
      });
    }

    return alerts;
  }

  /**
   * Generate health score (0-100)
   */
  getHealthScore(): {
    score: number;
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    factors: Array<{ name: string; score: number; weight: number }>;
  } {
    const metrics = this.tracker.getMetrics('1h');

    const factors = [
      {
        name: 'Success Rate',
        score: metrics.successRate * 100,
        weight: 0.3,
      },
      {
        name: 'Latency',
        score: Math.max(0, 100 - metrics.p95LatencyMs / 50),
        weight: 0.2,
      },
      {
        name: 'Cost Efficiency',
        score: 100 - metrics.cloudPercentage,
        weight: 0.2,
      },
      {
        name: 'Reliability',
        score: (1 - metrics.fallbackRate) * 100,
        weight: 0.15,
      },
      {
        name: 'Error Rate',
        score: (1 - metrics.errorRate) * 100,
        weight: 0.15,
      },
    ];

    const totalScore = factors.reduce(
      (sum, f) => sum + f.score * f.weight,
      0,
    );

    let grade: 'A' | 'B' | 'C' | 'D' | 'F';
    if (totalScore >= 90) grade = 'A';
    else if (totalScore >= 80) grade = 'B';
    else if (totalScore >= 70) grade = 'C';
    else if (totalScore >= 60) grade = 'D';
    else grade = 'F';

    return {
      score: totalScore,
      grade,
      factors,
    };
  }

  /**
   * Compare periods
   */
  comparePeriods(
    period1: '1h' | '24h' | '7d' | '30d',
    period2: '1h' | '24h' | '7d' | '30d',
  ): {
    requestsChange: number;
    latencyChange: number;
    costChange: number;
    efficiencyChange: number;
  } {
    const m1 = this.tracker.getMetrics(period1);
    const m2 = this.tracker.getMetrics(period2);

    return {
      requestsChange:
        m2.totalRequests > 0
          ? ((m1.totalRequests - m2.totalRequests) / m2.totalRequests) * 100
          : 0,
      latencyChange:
        m2.avgLatencyMs > 0
          ? ((m1.avgLatencyMs - m2.avgLatencyMs) / m2.avgLatencyMs) * 100
          : 0,
      costChange:
        m2.totalCostUsd > 0
          ? ((m1.totalCostUsd - m2.totalCostUsd) / m2.totalCostUsd) * 100
          : 0,
      efficiencyChange:
        m2.localSlmPercentage + m2.localLlmPercentage > 0
          ? ((m1.localSlmPercentage +
              m1.localLlmPercentage -
              (m2.localSlmPercentage + m2.localLlmPercentage)) /
              (m2.localSlmPercentage + m2.localLlmPercentage)) *
            100
          : 0,
    };
  }
}

/**
 * Save dashboard to file
 */
export async function saveDashboard(
  metrics: RouterMetrics,
  filePath: string,
): Promise<void> {
  const fs = await import('fs/promises');
  const dashboard = {
    generatedAt: new Date().toISOString(),
    last_1h: metrics.generateDashboard('1h'),
    last_24h: metrics.generateDashboard('24h'),
    last_7d: metrics.generateDashboard('7d'),
    healthScore: metrics.getHealthScore(),
    alerts: metrics.getAlerts(),
  };

  await fs.writeFile(filePath, JSON.stringify(dashboard, null, 2), 'utf-8');
}
