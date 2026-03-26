/**
 * Fallback Handler
 * Manages failures and retries with intelligent tier escalation
 */

import type {
  RoutingDecision,
  FallbackStrategy,
  ModelTier,
} from './types.js';
import { ModelRegistry } from './model-selector.js';

export interface FallbackAttempt {
  attemptNumber: number;
  modelId: string;
  tier: ModelTier;
  error?: Error;
  timestamp: Date;
  latencyMs?: number;
}

export interface FallbackResult {
  success: boolean;
  finalModelId: string;
  attempts: FallbackAttempt[];
  totalTimeMs: number;
  errorMessage?: string;
}

/**
 * Handles model failures and executes fallback strategy
 */
export class FallbackHandler {
  constructor(
    private registry: ModelRegistry,
    private strategy: FallbackStrategy,
  ) {}

  /**
   * Execute a task with fallback support
   */
  async executeWithFallback<T>(
    decision: RoutingDecision,
    executor: (modelId: string) => Promise<T>,
  ): Promise<{ result: T; fallbackInfo: FallbackResult }> {
    const startTime = Date.now();
    const attempts: FallbackAttempt[] = [];

    let currentModelId = decision.modelId;
    let attemptNumber = 1;

    // Try primary model
    try {
      const attemptStart = Date.now();
      const result = await this.executeWithTimeout(
        executor,
        currentModelId,
        this.getTimeoutMs(decision.modelTier),
      );

      attempts.push({
        attemptNumber,
        modelId: currentModelId,
        tier: decision.modelTier,
        timestamp: new Date(),
        latencyMs: Date.now() - attemptStart,
      });

      return {
        result,
        fallbackInfo: {
          success: true,
          finalModelId: currentModelId,
          attempts,
          totalTimeMs: Date.now() - startTime,
        },
      };
    } catch (error) {
      attempts.push({
        attemptNumber,
        modelId: currentModelId,
        tier: decision.modelTier,
        error: error as Error,
        timestamp: new Date(),
      });

      // Try fallback if enabled
      if (!this.strategy.enableTierEscalation) {
        throw error;
      }
    }

    // Execute fallback chain
    const fallbackChain = this.buildFallbackChain(
      decision.modelId,
      decision.modelTier,
      decision.fallbackModelId,
    );

    for (const fallbackModel of fallbackChain) {
      if (attemptNumber >= this.strategy.maxRetries) {
        break;
      }

      attemptNumber++;
      currentModelId = fallbackModel.modelId;

      // Wait before retry
      if (this.strategy.retryDelayMs > 0) {
        await this.delay(this.strategy.retryDelayMs);
      }

      try {
        const attemptStart = Date.now();
        const result = await this.executeWithTimeout(
          executor,
          currentModelId,
          this.getTimeoutMs(fallbackModel.tier),
        );

        attempts.push({
          attemptNumber,
          modelId: currentModelId,
          tier: fallbackModel.tier,
          timestamp: new Date(),
          latencyMs: Date.now() - attemptStart,
        });

        return {
          result,
          fallbackInfo: {
            success: true,
            finalModelId: currentModelId,
            attempts,
            totalTimeMs: Date.now() - startTime,
          },
        };
      } catch (error) {
        attempts.push({
          attemptNumber,
          modelId: currentModelId,
          tier: fallbackModel.tier,
          error: error as Error,
          timestamp: new Date(),
        });
      }
    }

    // All attempts failed
    const lastError = attempts[attempts.length - 1]?.error;
    return {
      result: undefined as any,
      fallbackInfo: {
        success: false,
        finalModelId: currentModelId,
        attempts,
        totalTimeMs: Date.now() - startTime,
        errorMessage:
          lastError?.message || 'All fallback attempts failed',
      },
    };
  }

  /**
   * Build fallback chain with tier escalation
   */
  private buildFallbackChain(
    primaryModelId: string,
    primaryTier: ModelTier,
    explicitFallback?: string,
  ): Array<{ modelId: string; tier: ModelTier }> {
    const chain: Array<{ modelId: string; tier: ModelTier }> = [];

    // Add explicit fallback if provided
    if (explicitFallback) {
      const model = this.registry.get(explicitFallback);
      if (model) {
        chain.push({ modelId: explicitFallback, tier: model.tier });
      }
    }

    // Check if network is restricted (skip cloud tiers entirely)
    const networkRestricted = process.env.NANOCLAW_NETWORK_RESTRICTED === '1';

    // Add tier escalation chain
    if (primaryTier === 'local-slm') {
      // SLM -> LLM -> Cloud (if network allows)
      chain.push({ modelId: 'deepseek-coder-v2:latest', tier: 'local-llm' });
      if (!networkRestricted) {
        chain.push({ modelId: 'claude-sonnet-4.6', tier: 'cloud' });
      }
    } else if (primaryTier === 'local-llm') {
      // LLM -> Cloud (if network allows)
      if (!networkRestricted) {
        chain.push({ modelId: 'claude-sonnet-4.6', tier: 'cloud' });
        chain.push({ modelId: 'gemini-3-flash', tier: 'cloud' });
      }
    } else if (primaryTier === 'cloud' && !networkRestricted) {
      // Cloud -> different cloud providers
      if (primaryModelId.startsWith('claude')) {
        chain.push({ modelId: 'gemini-3-flash', tier: 'cloud' });
        chain.push({ modelId: 'gpt-4o', tier: 'cloud' });
      } else {
        chain.push({ modelId: 'claude-sonnet-4.6', tier: 'cloud' });
      }
    }

    // Remove duplicates and primary model
    return chain.filter(
      (item, index, self) =>
        item.modelId !== primaryModelId &&
        index === self.findIndex((t) => t.modelId === item.modelId),
    );
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout<T>(
    executor: (modelId: string) => Promise<T>,
    modelId: string,
    timeoutMs: number,
  ): Promise<T> {
    return Promise.race([
      executor(modelId),
      this.timeoutPromise(timeoutMs),
    ]) as Promise<T>;
  }

  /**
   * Create timeout promise
   */
  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout after ${ms}ms`));
      }, ms);
    });
  }

  /**
   * Get timeout for model tier
   */
  private getTimeoutMs(tier: ModelTier): number {
    switch (tier) {
      case 'local-slm':
        return 5000; // 5s
      case 'local-llm':
        return 30000; // 30s
      case 'cloud':
        return 60000; // 60s
      default:
        return 30000;
    }
  }

  /**
   * Delay utility
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Check if should fallback based on confidence
   */
  shouldFallbackOnConfidence(confidence: number): boolean {
    if (!this.strategy.fallbackOnLowConfidence) {
      return false;
    }

    const threshold = this.strategy.lowConfidenceThreshold || 0.5;
    return confidence < threshold;
  }

  /**
   * Get fallback statistics
   */
  getStats(attempts: FallbackAttempt[]): {
    totalAttempts: number;
    successAttempt?: number;
    tierEscalations: number;
    avgLatencyMs: number;
  } {
    const successAttempt = attempts.findIndex((a) => !a.error);

    let tierEscalations = 0;
    for (let i = 1; i < attempts.length; i++) {
      if (attempts[i].tier !== attempts[i - 1].tier) {
        tierEscalations++;
      }
    }

    const latencies = attempts
      .filter((a) => a.latencyMs !== undefined)
      .map((a) => a.latencyMs!);
    const avgLatencyMs =
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

    return {
      totalAttempts: attempts.length,
      successAttempt: successAttempt >= 0 ? successAttempt + 1 : undefined,
      tierEscalations,
      avgLatencyMs,
    };
  }
}
