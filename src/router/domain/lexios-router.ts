/**
 * Lexios-Specific Router
 * Specialized routing for construction document analysis
 */

import { UniversalRouter, RouterFactory } from '../universal-router.js';
import type {
  RoutingContext,
  RoutingDecision,
  TaskType,
} from '../types.js';

export type LexiosTaskType =
  | 'extraction'      // Extract structured data from blueprints
  | 'compliance'      // OSHA/safety compliance checking
  | 'full_analysis'   // Complete blueprint analysis
  | 'comparison'      // Compare multiple documents
  | 'qa';             // Quality assurance checks

/**
 * Lexios-specific routing context
 */
export interface LexiosRoutingContext extends Omit<RoutingContext, 'taskType'> {
  lexiosTaskType: LexiosTaskType;
  documentType?: 'blueprint' | 'spec' | 'contract' | 'inspection';
  pageCount?: number;
  customerId?: string;
  isPaidCustomer: boolean;
  batchSize?: number; // For bulk processing
}

/**
 * Lexios Router with domain-specific optimizations
 */
export class LexiosRouter extends UniversalRouter {
  /**
   * Route Lexios task to optimal model
   */
  async routeLexios(
    context: LexiosRoutingContext,
  ): Promise<RoutingDecision> {
    // Convert Lexios context to universal context
    const universalContext = this.convertContext(context);

    // Apply Lexios-specific logic
    const optimizedContext = this.applyLexiosOptimizations(
      universalContext,
      context,
    );

    // Route using parent class
    return await this.route(optimizedContext);
  }

  /**
   * Execute Lexios task with routing
   */
  async executeLexios<T>(
    context: LexiosRoutingContext,
    executor: (modelId: string) => Promise<T>,
  ): Promise<{ result: T; decision: RoutingDecision }> {
    const decision = await this.routeLexios(context);
    const universalContext = this.convertContext(context);

    return await this.execute(universalContext, executor);
  }

  /**
   * Convert Lexios context to universal routing context
   */
  private convertContext(
    lexiosContext: LexiosRoutingContext,
  ): RoutingContext {
    // Map Lexios task type to universal task type
    const taskType = this.mapLexiosTaskType(lexiosContext.lexiosTaskType);

    // Determine quality needs based on customer tier and task
    const qualityNeeds = this.determineQualityNeeds(lexiosContext);

    // Determine latency needs based on batch size
    const latencyNeeds = lexiosContext.batchSize && lexiosContext.batchSize > 10
      ? 'batch' as const
      : 'fast' as const;

    return {
      taskType,
      userTier: lexiosContext.isPaidCustomer ? 'paid_customer' : 'beta',
      costBudget: lexiosContext.costBudget,
      qualityNeeds,
      latencyNeeds,
      source: 'lexios',
      hasMedia: true,
      mediaType: 'document',
      isPaidCustomer: lexiosContext.isPaidCustomer,
      customerId: lexiosContext.customerId,
    };
  }

  /**
   * Apply Lexios-specific routing optimizations
   */
  private applyLexiosOptimizations(
    context: RoutingContext,
    lexiosContext: LexiosRoutingContext,
  ): RoutingContext {
    // Optimization 1: Simple extraction can use local models
    if (
      lexiosContext.lexiosTaskType === 'extraction' &&
      !lexiosContext.isPaidCustomer
    ) {
      return {
        ...context,
        qualityNeeds: 'good',
        costBudget: 'zero',
      };
    }

    // Optimization 2: Compliance checking needs highest accuracy
    if (lexiosContext.lexiosTaskType === 'compliance') {
      return {
        ...context,
        qualityNeeds: 'best',
        costBudget: lexiosContext.isPaidCustomer ? 'unlimited' : 'limited',
      };
    }

    // Optimization 3: Batch processing uses local models
    if (lexiosContext.batchSize && lexiosContext.batchSize > 10) {
      return {
        ...context,
        costBudget: 'zero',
        latencyNeeds: 'batch',
      };
    }

    // Optimization 4: Large documents (>50 pages) use cloud
    if (lexiosContext.pageCount && lexiosContext.pageCount > 50) {
      return {
        ...context,
        qualityNeeds: 'best',
      };
    }

    return context;
  }

  /**
   * Map Lexios task type to universal task type
   */
  private mapLexiosTaskType(lexiosType: LexiosTaskType): TaskType {
    switch (lexiosType) {
      case 'extraction':
        return 'data';
      case 'compliance':
        return 'reasoning';
      case 'full_analysis':
        return 'vision';
      case 'comparison':
        return 'reasoning';
      case 'qa':
        return 'data';
      default:
        return 'vision';
    }
  }

  /**
   * Determine quality needs based on context
   */
  private determineQualityNeeds(
    context: LexiosRoutingContext,
  ): 'best' | 'good' | 'acceptable' {
    // Paid customers get best quality
    if (context.isPaidCustomer) {
      return 'best';
    }

    // Compliance tasks need best quality
    if (context.lexiosTaskType === 'compliance') {
      return 'best';
    }

    // Full analysis needs good quality
    if (context.lexiosTaskType === 'full_analysis') {
      return 'good';
    }

    // Simple extraction is acceptable
    return 'acceptable';
  }

  /**
   * Get recommended model for Lexios task type
   */
  getRecommendedModel(
    taskType: LexiosTaskType,
    isPaidCustomer: boolean,
  ): string {
    if (isPaidCustomer) {
      // Paid customers always get cloud models
      switch (taskType) {
        case 'compliance':
          return 'claude-opus-4.6'; // Highest accuracy
        case 'full_analysis':
          return 'claude-sonnet-4.6'; // Fast + accurate
        default:
          return 'gemini-3-flash'; // Cost-effective
      }
    }

    // Free tier uses local models
    switch (taskType) {
      case 'compliance':
        return 'llama-3.3-70b'; // Best local reasoning
      case 'full_analysis':
      case 'extraction':
        return 'qwen2.5-vl-72b'; // Best local vision
      default:
        return 'qwen2.5-vl-7b'; // Fast local vision
    }
  }

  /**
   * Estimate cost for Lexios task
   */
  estimateCost(
    context: LexiosRoutingContext,
  ): { costUsd: number; breakdown: Record<string, number> } {
    const modelId = this.getRecommendedModel(
      context.lexiosTaskType,
      context.isPaidCustomer,
    );

    // Get model cost
    const isCloudModel = modelId.startsWith('claude') ||
                        modelId.startsWith('gemini') ||
                        modelId.startsWith('gpt');

    if (!isCloudModel) {
      return {
        costUsd: 0,
        breakdown: { inference: 0 },
      };
    }

    // Estimate tokens based on document size
    const baseTokens = 2000;
    const pageTokens = (context.pageCount || 1) * 1000;
    const totalTokens = baseTokens + pageTokens;

    // Model costs (per 1k tokens)
    const costs: Record<string, number> = {
      'claude-opus-4.6': 0.015,
      'claude-sonnet-4.6': 0.003,
      'gemini-3-flash': 0.001,
      'gpt-4o': 0.005,
    };

    const costPer1k = costs[modelId] || 0.003;
    const costUsd = (totalTokens / 1000) * costPer1k;

    return {
      costUsd,
      breakdown: {
        inference: costUsd,
      },
    };
  }

  /**
   * Get Lexios-specific metrics
   */
  getLexiosMetrics(period: '1h' | '24h' | '7d' | '30d' = '24h') {
    const baseMetrics = this.getMetrics(period);

    // Filter for Lexios source
    const lexiosRequests = baseMetrics.bySource['lexios'] || 0;
    const totalRequests = baseMetrics.totalRequests;
    const lexiosPercentage = totalRequests > 0
      ? (lexiosRequests / totalRequests) * 100
      : 0;

    return {
      ...baseMetrics,
      lexios: {
        requests: lexiosRequests,
        percentage: lexiosPercentage,
        avgCostPerRequest: lexiosRequests > 0
          ? baseMetrics.totalCostUsd / lexiosRequests
          : 0,
      },
    };
  }
}

/**
 * Factory for Lexios router
 */
export class LexiosRouterFactory {
  /**
   * Create Lexios router with optimized settings
   */
  static create(): LexiosRouter {
    const config = RouterFactory.getDefaultConfig();

    // Lexios-specific overrides
    const lexiosConfig: import('../types.js').RouterConfig = {
      ...config,
      costOptimization: true,
      enableAnalysisBasedRouting: true,

      // Prefer local models for high-volume extraction
      routingRules: {
        ...config.routingRules,
        vision: {
          simple: 'local-slm' as import('../types.js').ModelTier,
          complex: 'local-llm' as import('../types.js').ModelTier,
          critical: 'cloud' as import('../types.js').ModelTier,
        },
      },
    };

    return new LexiosRouter(lexiosConfig);
  }

  /**
   * Create for development/testing
   */
  static createDev(): LexiosRouter {
    const router = LexiosRouterFactory.create();

    // Add test rules
    router.addRule({
      name: 'lexios-dev-local-only',
      priority: 200,
      sources: ['lexios'],
      preferredTier: 'local-llm',
      enabled: true,
      description: 'Dev mode: use only local models',
    });

    return router;
  }

  /**
   * Create for production
   */
  static createProduction(): LexiosRouter {
    const router = LexiosRouterFactory.create();

    // Add production rules
    router.addRule({
      name: 'lexios-paid-customer',
      priority: 150,
      sources: ['lexios'],
      userTiers: ['paid_customer'],
      preferredTier: 'cloud',
      preferredModel: 'claude-sonnet-4.6',
      enabled: true,
      description: 'Paid Lexios customers get cloud models',
    });

    return router;
  }
}
