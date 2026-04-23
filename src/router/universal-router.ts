/**
 * Universal AI Router
 * Routes ANY task to the optimal model based on complexity, cost, and quality needs
 */

import type {
  RoutingContext,
  RoutingDecision,
  TaskFeatures,
  RouterConfig,
  ModelTier,
} from './types.js';
import { TaskClassifier } from './task-classifier.js';
import { ModelRegistry, ModelSelector } from './model-selector.js';
import { RoutingRulesEngine } from './routing-rules.js';
import { FallbackHandler } from './fallback-handler.js';
import { PerformanceTracker } from './performance-tracker.js';

/**
 * Main Universal AI Router
 */
export class UniversalRouter {
  private classifier: TaskClassifier;
  private registry: ModelRegistry;
  private selector: ModelSelector;
  private rules: RoutingRulesEngine;
  private fallbackHandler: FallbackHandler;
  private tracker: PerformanceTracker;

  constructor(private config: RouterConfig) {
    this.classifier = new TaskClassifier();
    this.registry = new ModelRegistry();
    this.selector = new ModelSelector(this.registry, config);
    this.rules = new RoutingRulesEngine();
    this.fallbackHandler = new FallbackHandler(
      this.registry,
      config.fallbackStrategy,
    );
    this.tracker = new PerformanceTracker();
  }

  /**
   * Route a task to the optimal model
   */
  async route(context: RoutingContext): Promise<RoutingDecision> {
    const startTime = Date.now();

    // Step 1: Classify task to extract features
    const features = await this.classifyTask(context);

    // Step 2: Apply routing rules (if any match)
    const ruleMatch = this.rules.applyRules(context, features);

    // Step 3: Select model based on features and context
    let decision: RoutingDecision;

    if (ruleMatch.modelId) {
      // Rule specified exact model
      decision = this.createDecisionFromRule(
        ruleMatch.modelId,
        ruleMatch.tier!,
        ruleMatch.matchedRule!,
        context,
        features,
      );
    } else if (ruleMatch.tier) {
      // Rule specified tier, select model within tier
      decision = this.selector.select(
        { ...context, qualityNeeds: this.tierToQuality(ruleMatch.tier) },
        features,
      );
    } else {
      // No rule match, use standard selection
      decision = this.selector.select(context, features);
    }

    // Step 4: Check confidence and consider fallback
    if (
      this.fallbackHandler.shouldFallbackOnConfidence(decision.confidence)
    ) {
      // Low confidence, escalate tier if possible
      decision = this.escalateTier(decision, context, features);
    }

    return decision;
  }

  /**
   * Execute a task with routing and fallback
   */
  async execute<T>(
    context: RoutingContext,
    executor: (modelId: string) => Promise<T>,
  ): Promise<{ result: T; decision: RoutingDecision }> {
    // Route to optimal model
    const decision = await this.route(context);

    const executionStart = Date.now();

    try {
      // Execute with fallback support
      const { result, fallbackInfo } =
        await this.fallbackHandler.executeWithFallback(decision, executor);

      // Record performance
      if (this.config.metricsEnabled) {
        this.tracker.record(decision, context.taskType, context.source, {
          success: fallbackInfo.success,
          actualModelUsed: fallbackInfo.finalModelId,
          latencyMs: Date.now() - executionStart,
          fallbackInfo,
        });
      }

      if (!fallbackInfo.success) {
        throw new Error(
          fallbackInfo.errorMessage || 'Execution failed after all fallbacks',
        );
      }

      return { result, decision };
    } catch (error) {
      // Record failure
      if (this.config.metricsEnabled) {
        this.tracker.record(decision, context.taskType, context.source, {
          success: false,
          actualModelUsed: decision.modelId,
          latencyMs: Date.now() - executionStart,
          error: error as Error,
        });
      }

      throw error;
    }
  }

  /**
   * Get routing decision without executing
   */
  async plan(context: RoutingContext): Promise<{
    decision: RoutingDecision;
    features: TaskFeatures;
  }> {
    const features = await this.classifyTask(context);
    const decision = await this.route(context);
    return { decision, features };
  }

  /**
   * Get performance metrics
   */
  getMetrics(period: '1h' | '24h' | '7d' | '30d' = '24h') {
    return this.tracker.getMetrics(period);
  }

  /**
   * Get model performance
   */
  getModelPerformance(modelId: string, period: string = '24h') {
    return this.tracker.getModelPerformance(modelId, period);
  }

  /**
   * Get efficiency report
   */
  getEfficiencyReport() {
    return this.tracker.getEfficiencyReport();
  }

  /**
   * Get top models by usage
   */
  getTopModels(limit: number = 10) {
    return this.tracker.getTopModels(limit);
  }

  /**
   * Export configuration
   */
  exportConfig(): RouterConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<RouterConfig>): void {
    this.config = { ...this.config, ...updates };
    // Recreate components with new config
    this.selector = new ModelSelector(this.registry, this.config);
    this.fallbackHandler = new FallbackHandler(
      this.registry,
      this.config.fallbackStrategy,
    );
  }

  /**
   * Add custom routing rule
   */
  addRule(rule: import('./types.js').RoutingRule): void {
    this.rules.addRule(rule);
  }

  /**
   * Get all routing rules
   */
  getRules() {
    return this.rules.getRules();
  }

  // Private helper methods

  private async classifyTask(context: RoutingContext): Promise<TaskFeatures> {
    const useLLM =
      this.config.enableAnalysisBasedRouting &&
      context.latencyNeeds !== 'instant';

    return await this.classifier.classify(context, useLLM);
  }

  private createDecisionFromRule(
    modelId: string,
    tier: ModelTier,
    ruleName: string,
    context: RoutingContext,
    features: TaskFeatures,
  ): RoutingDecision {
    const model = this.registry.get(modelId);
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    return {
      modelId,
      modelTier: tier,
      confidence: 0.9, // High confidence from rule match
      reasoning: `Matched routing rule: ${ruleName}`,
      estimatedLatencyMs: model.avgLatencyMs,
      estimatedCostUsd:
        (features.estimatedTokens / 1000) * model.costPer1kTokens,
      fallbackModelId: this.selector['selectFallback'](modelId, tier),
      decidedAt: new Date(),
      decisionTimeMs: 0,
    };
  }

  private tierToQuality(tier: ModelTier): 'best' | 'good' | 'acceptable' {
    if (tier === 'cloud') return 'best';
    if (tier === 'local-llm') return 'good';
    return 'acceptable';
  }

  private escalateTier(
    decision: RoutingDecision,
    context: RoutingContext,
    features: TaskFeatures,
  ): RoutingDecision {
    // Escalate to next tier if confidence is low
    let newTier: ModelTier;

    if (decision.modelTier === 'local-slm') {
      newTier = 'local-llm';
    } else if (decision.modelTier === 'local-llm') {
      newTier = 'cloud';
    } else {
      // Already at highest tier
      return decision;
    }

    // Re-select with new tier
    return this.selector.select(
      { ...context, qualityNeeds: this.tierToQuality(newTier) },
      features,
    );
  }
}

/**
 * Factory for creating router instances
 */
export class RouterFactory {
  static create(config?: Partial<RouterConfig>): UniversalRouter {
    const defaultConfig = RouterFactory.getDefaultConfig();
    const mergedConfig = { ...defaultConfig, ...config };
    return new UniversalRouter(mergedConfig);
  }

  static getDefaultConfig(): RouterConfig {
    return {
      defaultTier: 'local-slm',
      costOptimization: true,
      fallbackEnabled: true,

      models: {
        local: {
          slm: {
            vision: 'qwen3-vl:8b',
            text: 'glm-4.7-flash',
          },
          llm: {
            vision: 'gemma4:26b',
            reasoning: 'gemma4:26b',
            code: 'deepseek-coder-v2',
          },
        },
        cloud: {
          reasoning: 'claude-opus-4.6',
          code: 'claude-sonnet-4.6',
          vision: 'gemini-3-flash',
          fallback: 'gpt-4o',
        },
      },

      routingRules: {
        conversation: {
          simple: 'local-slm',
          complex: 'local-llm',
          critical: 'cloud',
        },
        vision: {
          simple: 'local-slm',
          complex: 'local-llm',
          critical: 'cloud',
        },
        code: {
          simple: 'local-llm',
          complex: 'cloud',
        },
        reasoning: {
          simple: 'local-llm',
          complex: 'cloud',
        },
      },

      fallbackStrategy: {
        maxRetries: 3,
        retryDelayMs: 1000,
        enableTierEscalation: true,
        fallbackOnError: true,
        fallbackOnTimeout: true,
        fallbackOnLowConfidence: true,
        lowConfidenceThreshold: 0.5,
      },

      enableAnalysisBasedRouting: false, // Fast path by default
      analysisTimeoutMs: 500,

      metricsEnabled: true,
      metricsRetentionDays: 30,
    };
  }

  /**
   * Create router optimized for cost
   */
  static createCostOptimized(): UniversalRouter {
    return RouterFactory.create({
      costOptimization: true,
      defaultTier: 'local-slm',
      enableAnalysisBasedRouting: false,
    });
  }

  /**
   * Create router optimized for quality
   */
  static createQualityOptimized(): UniversalRouter {
    return RouterFactory.create({
      costOptimization: false,
      defaultTier: 'cloud',
      enableAnalysisBasedRouting: true,
    });
  }

  /**
   * Create router for production (balanced)
   */
  static createProduction(): UniversalRouter {
    return RouterFactory.create({
      costOptimization: true,
      defaultTier: 'local-llm',
      enableAnalysisBasedRouting: true,
      metricsEnabled: true,
    });
  }
}
