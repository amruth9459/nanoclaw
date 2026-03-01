/**
 * Routing Rules Engine
 * Applies configurable rules to override or influence routing decisions
 */

import type {
  RoutingRule,
  RoutingContext,
  TaskFeatures,
  ModelTier,
  TaskType,
  TaskSource,
} from './types.js';

/**
 * Rules engine for routing decisions
 */
export class RoutingRulesEngine {
  private rules: RoutingRule[] = [];

  constructor() {
    this.loadDefaultRules();
  }

  /**
   * Load default routing rules
   */
  private loadDefaultRules(): void {
    // Rule 1: Paid customers always get cloud models for vision tasks
    this.addRule({
      name: 'paid-customer-vision',
      priority: 100,
      taskTypes: ['vision'],
      preferredTier: 'cloud',
      preferredModel: 'claude-sonnet-4.6',
      enabled: true,
      description: 'Paid customers get cloud models for vision analysis',
    });

    // Rule 2: Internal tasks can use any tier
    this.addRule({
      name: 'internal-flexible',
      priority: 50,
      userTiers: ['internal'],
      preferredTier: 'local-llm',
      enabled: true,
      description: 'Internal users default to local LLM',
    });

    // Rule 3: Simple conversations always use SLM
    this.addRule({
      name: 'simple-conversation',
      priority: 80,
      taskTypes: ['conversation'],
      maxComplexity: 0.4,
      preferredTier: 'local-slm',
      preferredModel: 'qwen2.5-7b',
      enabled: true,
      description: 'Simple conversations use fast SLM',
    });

    // Rule 4: Complex reasoning needs cloud
    this.addRule({
      name: 'complex-reasoning',
      priority: 90,
      taskTypes: ['reasoning'],
      minComplexity: 0.7,
      preferredTier: 'cloud',
      preferredModel: 'claude-opus-4.6',
      enabled: true,
      description: 'Complex reasoning tasks use Claude Opus',
    });

    // Rule 5: Code generation uses Claude Sonnet
    this.addRule({
      name: 'code-generation',
      priority: 85,
      taskTypes: ['code'],
      preferredTier: 'cloud',
      preferredModel: 'claude-sonnet-4.6',
      enabled: true,
      description: 'Code tasks use Claude Sonnet',
    });

    // Rule 6: Lexios extraction (high volume) uses local models
    this.addRule({
      name: 'lexios-extraction',
      priority: 70,
      sources: ['lexios'],
      maxComplexity: 0.6,
      preferredTier: 'local-llm',
      preferredModel: 'qwen2.5-vl-72b',
      enabled: true,
      description: 'Lexios extraction uses local vision model',
    });

    // Rule 7: OSHA compliance (critical) uses cloud
    this.addRule({
      name: 'osha-compliance',
      priority: 95,
      sources: ['osha'],
      preferredTier: 'cloud',
      preferredModel: 'claude-opus-4.6',
      enabled: true,
      description: 'OSHA compliance needs highest accuracy',
    });

    // Rule 8: Scheduled tasks (batch) use local models
    this.addRule({
      name: 'scheduled-batch',
      priority: 60,
      sources: ['scheduled_task'],
      preferredTier: 'local-llm',
      enabled: true,
      description: 'Scheduled tasks use cost-free local models',
    });

    // Rule 9: Vision tasks without high accuracy needs use local
    this.addRule({
      name: 'simple-vision',
      priority: 65,
      taskTypes: ['vision'],
      requiresVision: true,
      maxComplexity: 0.5,
      preferredTier: 'local-slm',
      preferredModel: 'qwen2.5-vl-7b',
      enabled: true,
      description: 'Simple vision tasks use local SLM',
    });

    // Rule 10: Data extraction uses local models
    this.addRule({
      name: 'data-extraction',
      priority: 70,
      taskTypes: ['data'],
      preferredTier: 'local-llm',
      enabled: true,
      description: 'Data extraction uses local models',
    });
  }

  /**
   * Add a custom rule
   */
  addRule(rule: RoutingRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority); // Higher priority first
  }

  /**
   * Remove a rule by name
   */
  removeRule(name: string): void {
    this.rules = this.rules.filter((r) => r.name !== name);
  }

  /**
   * Enable/disable a rule
   */
  setRuleEnabled(name: string, enabled: boolean): void {
    const rule = this.rules.find((r) => r.name === name);
    if (rule) {
      rule.enabled = enabled;
    }
  }

  /**
   * Get all rules
   */
  getRules(): RoutingRule[] {
    return [...this.rules];
  }

  /**
   * Apply rules to find matching tier preference
   */
  applyRules(
    context: RoutingContext,
    features: TaskFeatures,
  ): { tier?: ModelTier; modelId?: string; matchedRule?: string } {
    const enabledRules = this.rules.filter((r) => r.enabled);

    for (const rule of enabledRules) {
      if (this.matchesRule(rule, context, features)) {
        return {
          tier: rule.preferredTier,
          modelId: rule.preferredModel,
          matchedRule: rule.name,
        };
      }
    }

    return {};
  }

  /**
   * Check if context and features match a rule
   */
  private matchesRule(
    rule: RoutingRule,
    context: RoutingContext,
    features: TaskFeatures,
  ): boolean {
    // Check task types
    if (rule.taskTypes && !rule.taskTypes.includes(context.taskType)) {
      return false;
    }

    // Check user tiers
    if (rule.userTiers && !rule.userTiers.includes(context.userTier)) {
      return false;
    }

    // Check sources
    if (rule.sources && !rule.sources.includes(context.source)) {
      return false;
    }

    // Check complexity range
    if (
      rule.minComplexity !== undefined &&
      features.complexity < rule.minComplexity
    ) {
      return false;
    }
    if (
      rule.maxComplexity !== undefined &&
      features.complexity > rule.maxComplexity
    ) {
      return false;
    }

    // Check vision requirement
    if (
      rule.requiresVision !== undefined &&
      features.requiresVision !== rule.requiresVision
    ) {
      return false;
    }

    // All conditions matched
    return true;
  }

  /**
   * Export rules as JSON for configuration
   */
  exportRules(): string {
    return JSON.stringify(this.rules, null, 2);
  }

  /**
   * Import rules from JSON
   */
  importRules(json: string): void {
    const rules = JSON.parse(json) as RoutingRule[];
    this.rules = rules;
    this.rules.sort((a, b) => b.priority - a.priority);
  }
}

/**
 * Predefined rule sets for common scenarios
 */
export class RulePresets {
  /**
   * Cost-optimized preset: maximize local model usage
   */
  static costOptimized(): RoutingRule[] {
    return [
      {
        name: 'cost-opt-conversation',
        priority: 100,
        taskTypes: ['conversation'],
        preferredTier: 'local-slm',
        enabled: true,
        description: 'All conversations use SLM',
      },
      {
        name: 'cost-opt-vision',
        priority: 90,
        taskTypes: ['vision'],
        preferredTier: 'local-llm',
        preferredModel: 'qwen2.5-vl-72b',
        enabled: true,
        description: 'Vision uses local LLM',
      },
      {
        name: 'cost-opt-code',
        priority: 80,
        taskTypes: ['code'],
        maxComplexity: 0.7,
        preferredTier: 'local-llm',
        enabled: true,
        description: 'Simple code uses local LLM',
      },
    ];
  }

  /**
   * Quality-optimized preset: use cloud for everything important
   */
  static qualityOptimized(): RoutingRule[] {
    return [
      {
        name: 'quality-vision',
        priority: 100,
        taskTypes: ['vision'],
        preferredTier: 'cloud',
        preferredModel: 'claude-sonnet-4.6',
        enabled: true,
        description: 'Vision uses Claude Sonnet',
      },
      {
        name: 'quality-code',
        priority: 100,
        taskTypes: ['code'],
        preferredTier: 'cloud',
        preferredModel: 'claude-sonnet-4.6',
        enabled: true,
        description: 'Code uses Claude Sonnet',
      },
      {
        name: 'quality-reasoning',
        priority: 100,
        taskTypes: ['reasoning'],
        preferredTier: 'cloud',
        preferredModel: 'claude-opus-4.6',
        enabled: true,
        description: 'Reasoning uses Claude Opus',
      },
    ];
  }

  /**
   * Balanced preset: smart mix of local and cloud
   */
  static balanced(): RoutingRule[] {
    return [
      {
        name: 'balanced-simple',
        priority: 90,
        taskTypes: ['conversation', 'data'],
        maxComplexity: 0.5,
        preferredTier: 'local-slm',
        enabled: true,
        description: 'Simple tasks use SLM',
      },
      {
        name: 'balanced-medium',
        priority: 80,
        minComplexity: 0.5,
        maxComplexity: 0.7,
        preferredTier: 'local-llm',
        enabled: true,
        description: 'Medium tasks use local LLM',
      },
      {
        name: 'balanced-complex',
        priority: 70,
        minComplexity: 0.7,
        preferredTier: 'cloud',
        enabled: true,
        description: 'Complex tasks use cloud',
      },
    ];
  }
}
