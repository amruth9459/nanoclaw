/**
 * Model Selector
 * Selects the optimal model based on task features and constraints
 */

import type {
  TaskFeatures,
  RoutingContext,
  RoutingDecision,
  ModelConfig,
  ModelTier,
  RouterConfig,
} from './types.js';

/**
 * Available models registry
 */
export class ModelRegistry {
  private models: Map<string, ModelConfig> = new Map();

  constructor() {
    this.registerDefaultModels();
  }

  private registerDefaultModels(): void {
    // Local SLMs (Small Language Models)
    this.register({
      id: 'qwen2.5-vl-7b',
      name: 'Qwen 2.5 VL 7B',
      tier: 'local-slm',
      provider: 'local-mlx',
      supportsVision: true,
      maxTokens: 8192,
      contextWindow: 32768,
      avgLatencyMs: 80,
      costPer1kTokens: 0,
      requiresGpu: true,
      memoryGb: 8,
    });

    this.register({
      id: 'qwen2.5-7b',
      name: 'Qwen 2.5 7B',
      tier: 'local-slm',
      provider: 'local-mlx',
      supportsVision: false,
      maxTokens: 8192,
      contextWindow: 32768,
      avgLatencyMs: 50,
      costPer1kTokens: 0,
      requiresGpu: true,
      memoryGb: 7,
    });

    // GGUF SLMs served via llama.cpp (Q4_K_M, CPU-friendly, $0 inference).
    // Per the "small-language-models-production" finding: <4B params reach
    // production reliability for summarization / classification / structured
    // output through engineering discipline (tolerant JSON parsing + fallback),
    // not scale. Download URLs are HITL-gated and env-overridable — see
    // LlamaCppBackend.planDownload(). Both models are Apache-2.0 (non-GPL).
    this.register({
      id: 'tiny-aya-3.35b',
      name: 'Tiny Aya 3.35B (Q4_K_M)',
      tier: 'local-slm',
      provider: 'local-llamacpp',
      supportsVision: false,
      maxTokens: 4096,
      contextWindow: 8192,
      avgLatencyMs: 120,
      costPer1kTokens: 0,
      requiresGpu: false,
      memoryGb: 4, // ~4GB RAM to serve
      paramCountB: 3.35,
      quantization: 'Q4_K_M',
      ggufFile: 'tiny-aya-3.35b-q4_k_m.gguf',
      // Operator-supplied: set TINY_AYA_GGUF_URL to the verified HF GGUF URL.
      downloadUrl: process.env.TINY_AYA_GGUF_URL,
      requiredRamGb: 4,
      license: 'Apache-2.0',
    });

    this.register({
      id: 'qwen2.5-0.5b',
      name: 'Qwen 2.5 0.5B Instruct (Q4_K_M)',
      tier: 'local-slm',
      provider: 'local-llamacpp',
      supportsVision: false,
      maxTokens: 4096,
      contextWindow: 32768,
      avgLatencyMs: 40,
      costPer1kTokens: 0,
      requiresGpu: false,
      memoryGb: 1, // ~1GB RAM to serve
      paramCountB: 0.5,
      quantization: 'Q4_K_M',
      ggufFile: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
      // Official Qwen GGUF (Apache-2.0). Env-overridable for mirrors/air-gapped hosts.
      downloadUrl:
        process.env.QWEN2_5_0_5B_GGUF_URL ||
        'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
      requiredRamGb: 1,
      license: 'Apache-2.0',
    });

    // Local LLMs (Large Language Models)
    this.register({
      id: 'qwen2.5-vl-72b',
      name: 'Qwen 2.5 VL 72B',
      tier: 'local-llm',
      provider: 'local-mlx',
      supportsVision: true,
      maxTokens: 8192,
      contextWindow: 32768,
      avgLatencyMs: 1200,
      costPer1kTokens: 0,
      requiresGpu: true,
      memoryGb: 80,
    });

    this.register({
      id: 'llama-3.3-70b',
      name: 'Llama 3.3 70B',
      tier: 'local-llm',
      provider: 'local-mlx',
      supportsVision: false,
      maxTokens: 8192,
      contextWindow: 131072,
      avgLatencyMs: 1000,
      costPer1kTokens: 0,
      requiresGpu: true,
      memoryGb: 75,
    });

    // Cloud Models
    this.register({
      id: 'claude-opus-4.6',
      name: 'Claude Opus 4.6',
      tier: 'cloud',
      provider: 'anthropic',
      supportsVision: true,
      maxTokens: 8192,
      contextWindow: 200000,
      avgLatencyMs: 3000,
      costPer1kTokens: 0.015, // $15 per 1M input tokens
    });

    this.register({
      id: 'claude-sonnet-4.6',
      name: 'Claude Sonnet 4.6',
      tier: 'cloud',
      provider: 'anthropic',
      supportsVision: true,
      maxTokens: 8192,
      contextWindow: 200000,
      avgLatencyMs: 2000,
      costPer1kTokens: 0.003, // $3 per 1M input tokens
    });

    this.register({
      id: 'gemini-3-flash',
      name: 'Gemini 3 Flash',
      tier: 'cloud',
      provider: 'google',
      supportsVision: true,
      maxTokens: 8192,
      contextWindow: 1000000,
      avgLatencyMs: 1500,
      costPer1kTokens: 0.001, // Approximate
    });

    this.register({
      id: 'gpt-4o',
      name: 'GPT-4o',
      tier: 'cloud',
      provider: 'openai',
      supportsVision: true,
      maxTokens: 4096,
      contextWindow: 128000,
      avgLatencyMs: 2500,
      costPer1kTokens: 0.005, // $5 per 1M input tokens
    });
  }

  register(config: ModelConfig): void {
    this.models.set(config.id, config);
  }

  get(id: string): ModelConfig | undefined {
    return this.models.get(id);
  }

  getByTier(tier: ModelTier): ModelConfig[] {
    return Array.from(this.models.values()).filter((m) => m.tier === tier);
  }

  getAll(): ModelConfig[] {
    return Array.from(this.models.values());
  }
}

/**
 * Model selection engine
 */
export class ModelSelector {
  constructor(
    private registry: ModelRegistry,
    private config: RouterConfig,
  ) {}

  /**
   * Select optimal model based on task features and context
   */
  select(
    context: RoutingContext,
    features: TaskFeatures,
  ): RoutingDecision {
    const startTime = Date.now();

    // Determine target tier based on constraints
    const targetTier = this.determineTargetTier(context, features);

    // Select specific model within tier
    const modelId = this.selectModelInTier(targetTier, context, features);
    const model = this.registry.get(modelId);

    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    // Determine fallback
    const fallbackModelId = this.selectFallback(modelId, targetTier);

    // Calculate estimates
    const estimatedLatencyMs = model.avgLatencyMs;
    const estimatedCostUsd =
      (features.estimatedTokens / 1000) * model.costPer1kTokens;

    // Calculate confidence
    const confidence = this.calculateConfidence(model, features, context);

    // Build reasoning
    const reasoning = this.buildReasoning(model, targetTier, context, features);

    const decision: RoutingDecision = {
      modelId,
      modelTier: targetTier,
      confidence,
      reasoning,
      estimatedLatencyMs,
      estimatedCostUsd,
      fallbackModelId,
      decidedAt: new Date(),
      decisionTimeMs: Date.now() - startTime,
    };

    return decision;
  }

  /**
   * Determine target model tier based on context and features
   */
  private determineTargetTier(
    context: RoutingContext,
    features: TaskFeatures,
  ): ModelTier {
    // Budget constraints
    if (context.costBudget === 'zero') {
      // Must use local models
      if (features.complexity > 0.7 || features.technicalDepth > 0.7) {
        return 'local-llm';
      }
      return 'local-slm';
    }

    // Quality requirements
    if (context.qualityNeeds === 'best') {
      // Use cloud for best quality
      if (features.complexity > 0.6 || features.accuracyRequired > 0.8) {
        return 'cloud';
      }
      // Use local LLM for good enough quality
      return 'local-llm';
    }

    // Latency requirements
    if (context.latencyNeeds === 'instant') {
      return 'local-slm';
    }

    // SLM fast-path: summarization / simple classification / structured output.
    // These are the validated $0-inference candidates for small models. Quality
    // "best" was already handled (and returned) above, so here we only need the
    // accuracy gate. Structured output still routes to SLM but relies on the
    // tolerant-JSON + LLM fallback in the agent extension layer.
    if (features.accuracyRequired < 0.85) {
      if (
        (features.isSummarizable && features.complexity < 0.3) ||
        features.isSimpleClassification
      ) {
        return 'local-slm';
      }
    }

    // Cost optimization path (default for most tasks)
    if (this.config.costOptimization) {
      // Try SLM first for simple tasks
      if (
        features.complexity < 0.4 &&
        features.technicalDepth < 0.5 &&
        context.taskType === 'conversation'
      ) {
        return 'local-slm';
      }

      // Use local LLM for medium complexity
      if (features.complexity < 0.7 && context.costBudget !== 'unlimited') {
        return 'local-llm';
      }

      // Use cloud for complex tasks
      return 'cloud';
    }

    // Default: local LLM as balanced option
    return 'local-llm';
  }

  /**
   * Select specific model within a tier
   */
  private selectModelInTier(
    tier: ModelTier,
    context: RoutingContext,
    features: TaskFeatures,
  ): string {
    const models = this.registry.getByTier(tier);

    // Filter by capabilities
    let candidates = models.filter((m) => {
      if (features.requiresVision && !m.supportsVision) return false;
      if (features.estimatedTokens > m.maxTokens) return false;
      return true;
    });

    if (candidates.length === 0) {
      // Fallback to any model in tier
      candidates = models;
    }

    // Task-specific selection
    if (tier === 'local-slm') {
      if (features.requiresVision) return 'qwen2.5-vl-7b';

      // Tiny classification with no structure → the lightest model (0.5B, ~40ms).
      if (
        features.isSimpleClassification &&
        !features.requiresStructuredOutput &&
        this.registry.get('qwen2.5-0.5b')
      ) {
        return 'qwen2.5-0.5b';
      }

      // Summarization / structured output / multilingual → Tiny Aya 3.35B (GGUF).
      if (
        (features.isSummarizable ||
          features.requiresStructuredOutput ||
          features.isSimpleClassification) &&
        this.registry.get('tiny-aya-3.35b')
      ) {
        return 'tiny-aya-3.35b';
      }

      return 'qwen2.5-7b';
    }

    if (tier === 'local-llm') {
      if (features.requiresVision) return 'qwen2.5-vl-72b';
      if (features.requiresCode || features.requiresReasoning) {
        return 'llama-3.3-70b';
      }
      return 'llama-3.3-70b';
    }

    if (tier === 'cloud') {
      // Reasoning tasks -> Claude Opus
      if (
        features.requiresReasoning ||
        features.complexity > 0.8 ||
        context.taskType === 'reasoning'
      ) {
        return 'claude-opus-4.6';
      }

      // Code tasks -> Claude Sonnet
      if (features.requiresCode || context.taskType === 'code') {
        return 'claude-sonnet-4.6';
      }

      // Vision tasks -> Gemini Flash (fast and cheap)
      if (features.requiresVision || context.taskType === 'vision') {
        // For paid customers, use better models
        if (context.isPaidCustomer) {
          return 'claude-sonnet-4.6';
        }
        return 'gemini-3-flash';
      }

      // Default cloud: Claude Sonnet (balanced)
      return 'claude-sonnet-4.6';
    }

    // Fallback
    return candidates[0]?.id || this.config.defaultTier;
  }

  /**
   * Select fallback model
   */
  private selectFallback(
    primaryModelId: string,
    tier: ModelTier,
  ): string | undefined {
    if (!this.config.fallbackEnabled) return undefined;

    // SLM -> LLM
    if (tier === 'local-slm') {
      return 'llama-3.3-70b';
    }

    // LLM -> Cloud
    if (tier === 'local-llm') {
      return 'claude-sonnet-4.6';
    }

    // Cloud -> different cloud provider
    if (primaryModelId.startsWith('claude')) {
      return 'gemini-3-flash';
    }
    if (primaryModelId.startsWith('gemini')) {
      return 'gpt-4o';
    }

    return undefined;
  }

  /**
   * Calculate confidence in the decision
   */
  private calculateConfidence(
    model: ModelConfig,
    features: TaskFeatures,
    context: RoutingContext,
  ): number {
    let confidence = 0.7; // Base confidence

    // Vision support match
    if (features.requiresVision === model.supportsVision) {
      confidence += 0.1;
    } else if (features.requiresVision && !model.supportsVision) {
      confidence -= 0.3;
    }

    // Complexity vs tier match
    if (features.complexity < 0.4 && model.tier === 'local-slm') {
      confidence += 0.1;
    } else if (features.complexity > 0.7 && model.tier === 'cloud') {
      confidence += 0.15;
    } else if (features.complexity > 0.7 && model.tier === 'local-slm') {
      confidence -= 0.2;
    }

    // Quality match
    if (context.qualityNeeds === 'best' && model.tier === 'cloud') {
      confidence += 0.1;
    }

    // Latency match
    if (
      context.latencyNeeds === 'instant' &&
      model.avgLatencyMs < 100
    ) {
      confidence += 0.1;
    }

    return Math.max(0.1, Math.min(1.0, confidence));
  }

  /**
   * Build human-readable reasoning
   */
  private buildReasoning(
    model: ModelConfig,
    tier: ModelTier,
    context: RoutingContext,
    features: TaskFeatures,
  ): string {
    const reasons: string[] = [];

    // Primary reason
    if (tier === 'local-slm') {
      reasons.push('Simple task suitable for fast local model');
    } else if (tier === 'local-llm') {
      reasons.push('Medium complexity requires larger local model');
    } else {
      reasons.push('Complex task needs cloud model for best quality');
    }

    // Supporting factors
    if (features.requiresVision) {
      reasons.push(`vision support required (${context.mediaType || 'image'})`);
    }
    if (features.requiresCode) {
      reasons.push('code generation/analysis needed');
    }
    if (features.complexity > 0.7) {
      reasons.push('high complexity detected');
    }
    if (context.isPaidCustomer) {
      reasons.push('paid customer - prioritizing quality');
    }
    if (context.costBudget === 'zero') {
      reasons.push('zero-cost budget constraint');
    }
    if (context.latencyNeeds === 'instant') {
      reasons.push('instant response required');
    }

    return reasons.join('; ');
  }
}
