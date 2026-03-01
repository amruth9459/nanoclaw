/**
 * Performance Tracker
 * Monitors routing decisions and model performance over time
 */

import type {
  RoutingDecision,
  RoutingMetrics,
  ModelPerformance,
  TaskType,
  TaskSource,
  ModelTier,
} from './types.js';
import type { FallbackResult } from './fallback-handler.js';

interface PerformanceRecord {
  timestamp: Date;
  decision: RoutingDecision;
  actualModelUsed: string;
  actualLatencyMs: number;
  actualCostUsd: number;
  success: boolean;
  fallbackUsed: boolean;
  errorMessage?: string;
  taskType: TaskType;
  source: TaskSource;
}

/**
 * Tracks and analyzes routing performance
 */
export class PerformanceTracker {
  private records: PerformanceRecord[] = [];
  private maxRecords = 10000; // Keep last 10k records in memory

  /**
   * Record a routing execution
   */
  record(
    decision: RoutingDecision,
    taskType: TaskType,
    source: TaskSource,
    result: {
      success: boolean;
      actualModelUsed: string;
      latencyMs: number;
      fallbackInfo?: FallbackResult;
      error?: Error;
    },
  ): void {
    const record: PerformanceRecord = {
      timestamp: new Date(),
      decision,
      actualModelUsed: result.actualModelUsed,
      actualLatencyMs: result.latencyMs,
      actualCostUsd: this.calculateActualCost(
        result.actualModelUsed,
        result.latencyMs,
      ),
      success: result.success,
      fallbackUsed: result.fallbackInfo
        ? result.actualModelUsed !== decision.modelId
        : false,
      errorMessage: result.error?.message,
      taskType,
      source,
    };

    this.records.push(record);

    // Trim old records
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  /**
   * Get metrics for a time period
   */
  getMetrics(period: '1h' | '24h' | '7d' | '30d'): RoutingMetrics {
    const now = new Date();
    const startTime = new Date(now.getTime() - this.getPeriodMs(period));
    const records = this.records.filter((r) => r.timestamp >= startTime);

    if (records.length === 0) {
      return this.emptyMetrics(period, startTime, now);
    }

    // Count by tier
    const byTier: Record<ModelTier, number> = {
      'local-slm': 0,
      'local-llm': 0,
      cloud: 0,
    };
    records.forEach((r) => {
      byTier[r.decision.modelTier]++;
    });

    // Count by task type
    const byTaskType: Record<TaskType, number> = {
      conversation: 0,
      vision: 0,
      code: 0,
      reasoning: 0,
      data: 0,
      web: 0,
    };
    records.forEach((r) => {
      byTaskType[r.taskType]++;
    });

    // Count by source
    const bySource: Record<TaskSource, number> = {
      whatsapp: 0,
      lexios: 0,
      osha: 0,
      scheduled_task: 0,
      bounty: 0,
      internal: 0,
    };
    records.forEach((r) => {
      bySource[r.source]++;
    });

    // Calculate latencies
    const latencies = records.map((r) => r.actualLatencyMs).sort((a, b) => a - b);
    const avgLatencyMs =
      latencies.reduce((a, b) => a + b, 0) / latencies.length;

    // Calculate costs
    const totalCostUsd = records.reduce((sum, r) => sum + r.actualCostUsd, 0);
    const costSavedUsd = this.calculateCostSaved(records);

    // Calculate rates
    const successCount = records.filter((r) => r.success).length;
    const fallbackCount = records.filter((r) => r.fallbackUsed).length;
    const errorCount = records.filter((r) => !r.success).length;

    // Calculate efficiency
    const totalRequests = records.length;
    const localSlmPercentage = (byTier['local-slm'] / totalRequests) * 100;
    const localLlmPercentage = (byTier['local-llm'] / totalRequests) * 100;
    const cloudPercentage = (byTier.cloud / totalRequests) * 100;

    return {
      period,
      startTime,
      endTime: now,
      totalRequests,
      byTier,
      byTaskType,
      bySource,
      avgLatencyMs,
      p50LatencyMs: this.percentile(latencies, 0.5),
      p95LatencyMs: this.percentile(latencies, 0.95),
      p99LatencyMs: this.percentile(latencies, 0.99),
      totalCostUsd,
      costSavedUsd,
      successRate: successCount / totalRequests,
      fallbackRate: fallbackCount / totalRequests,
      errorRate: errorCount / totalRequests,
      localSlmPercentage,
      localLlmPercentage,
      cloudPercentage,
    };
  }

  /**
   * Get performance for specific model
   */
  getModelPerformance(modelId: string, period: string): ModelPerformance {
    const now = new Date();
    const periodMs = this.getPeriodMs(period as '1h' | '24h' | '7d' | '30d');
    const startTime = new Date(now.getTime() - periodMs);

    const records = this.records.filter(
      (r) =>
        r.actualModelUsed === modelId &&
        r.timestamp >= startTime,
    );

    if (records.length === 0) {
      return {
        modelId,
        period,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        fallbackCount: 0,
        avgLatencyMs: 0,
        totalCostUsd: 0,
        avgConfidence: 0,
        firstUsed: now,
        lastUsed: now,
      };
    }

    const successCount = records.filter((r) => r.success).length;
    const errorCount = records.filter((r) => !r.success).length;
    const fallbackCount = records.filter((r) => r.fallbackUsed).length;

    const latencies = records.map((r) => r.actualLatencyMs);
    const avgLatencyMs =
      latencies.reduce((a, b) => a + b, 0) / latencies.length;

    const totalCostUsd = records.reduce((sum, r) => sum + r.actualCostUsd, 0);

    const confidences = records.map((r) => r.decision.confidence);
    const avgConfidence =
      confidences.reduce((a, b) => a + b, 0) / confidences.length;

    const timestamps = records.map((r) => r.timestamp);
    const firstUsed = new Date(Math.min(...timestamps.map((t) => t.getTime())));
    const lastUsed = new Date(Math.max(...timestamps.map((t) => t.getTime())));

    return {
      modelId,
      period,
      requestCount: records.length,
      successCount,
      errorCount,
      fallbackCount,
      avgLatencyMs,
      totalCostUsd,
      avgConfidence,
      firstUsed,
      lastUsed,
    };
  }

  /**
   * Get top models by usage
   */
  getTopModels(limit: number = 10): Array<{ modelId: string; count: number }> {
    const counts = new Map<string, number>();

    this.records.forEach((r) => {
      const count = counts.get(r.actualModelUsed) || 0;
      counts.set(r.actualModelUsed, count + 1);
    });

    return Array.from(counts.entries())
      .map(([modelId, count]) => ({ modelId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Get routing efficiency report
   */
  getEfficiencyReport(): {
    totalCostUsd: number;
    costSavedUsd: number;
    savingsPercentage: number;
    localPercentage: number;
    avgLatencyMs: number;
    successRate: number;
  } {
    if (this.records.length === 0) {
      return {
        totalCostUsd: 0,
        costSavedUsd: 0,
        savingsPercentage: 0,
        localPercentage: 0,
        avgLatencyMs: 0,
        successRate: 0,
      };
    }

    const totalCostUsd = this.records.reduce(
      (sum, r) => sum + r.actualCostUsd,
      0,
    );
    const costSavedUsd = this.calculateCostSaved(this.records);
    const allCloudCost = totalCostUsd + costSavedUsd;
    const savingsPercentage =
      allCloudCost > 0 ? (costSavedUsd / allCloudCost) * 100 : 0;

    const localCount = this.records.filter(
      (r) =>
        r.decision.modelTier === 'local-slm' ||
        r.decision.modelTier === 'local-llm',
    ).length;
    const localPercentage = (localCount / this.records.length) * 100;

    const latencies = this.records.map((r) => r.actualLatencyMs);
    const avgLatencyMs =
      latencies.reduce((a, b) => a + b, 0) / latencies.length;

    const successCount = this.records.filter((r) => r.success).length;
    const successRate = successCount / this.records.length;

    return {
      totalCostUsd,
      costSavedUsd,
      savingsPercentage,
      localPercentage,
      avgLatencyMs,
      successRate,
    };
  }

  /**
   * Export records for analysis
   */
  exportRecords(): PerformanceRecord[] {
    return [...this.records];
  }

  /**
   * Clear old records
   */
  clearOldRecords(olderThanDays: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const originalLength = this.records.length;
    this.records = this.records.filter((r) => r.timestamp >= cutoff);
    return originalLength - this.records.length;
  }

  // Helper methods

  private getPeriodMs(
    period: '1h' | '24h' | '7d' | '30d',
  ): number {
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    switch (period) {
      case '1h':
        return hour;
      case '24h':
        return day;
      case '7d':
        return 7 * day;
      case '30d':
        return 30 * day;
      default:
        return day;
    }
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, index)];
  }

  private calculateActualCost(modelId: string, latencyMs: number): number {
    // Simplified cost calculation
    // In production, would track actual tokens used
    const cloudCosts: Record<string, number> = {
      'claude-opus-4.6': 0.015,
      'claude-sonnet-4.6': 0.003,
      'gemini-3-flash': 0.001,
      'gpt-4o': 0.005,
    };

    const costPer1k = cloudCosts[modelId] || 0;
    // Estimate ~2k tokens per request
    return (2000 / 1000) * costPer1k;
  }

  private calculateCostSaved(records: PerformanceRecord[]): number {
    // Calculate how much we saved by using local models
    // vs if everything used cloud
    let saved = 0;

    records.forEach((r) => {
      if (
        r.decision.modelTier === 'local-slm' ||
        r.decision.modelTier === 'local-llm'
      ) {
        // Would have cost this much with Claude Sonnet
        saved += this.calculateActualCost('claude-sonnet-4.6', r.actualLatencyMs);
      }
    });

    return saved;
  }

  private emptyMetrics(
    period: '1h' | '24h' | '7d' | '30d',
    startTime: Date,
    endTime: Date,
  ): RoutingMetrics {
    return {
      period,
      startTime,
      endTime,
      totalRequests: 0,
      byTier: { 'local-slm': 0, 'local-llm': 0, cloud: 0 },
      byTaskType: {
        conversation: 0,
        vision: 0,
        code: 0,
        reasoning: 0,
        data: 0,
        web: 0,
      },
      bySource: {
        whatsapp: 0,
        lexios: 0,
        osha: 0,
        scheduled_task: 0,
        bounty: 0,
        internal: 0,
      },
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
      totalCostUsd: 0,
      costSavedUsd: 0,
      successRate: 0,
      fallbackRate: 0,
      errorRate: 0,
      localSlmPercentage: 0,
      localLlmPercentage: 0,
      cloudPercentage: 0,
    };
  }
}
