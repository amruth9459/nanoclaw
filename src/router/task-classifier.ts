/**
 * Task Classifier
 * Analyzes tasks to extract features and determine routing needs
 */

import type {
  TaskType,
  TaskFeatures,
  RoutingContext,
} from './types.js';

/**
 * Fast metadata-based classification (no LLM call)
 */
export class MetadataClassifier {
  classifyFromContext(context: RoutingContext): Partial<TaskFeatures> {
    const features: Partial<TaskFeatures> = {
      requiresVision: context.hasMedia || context.taskType === 'vision',
      requiresCode: context.taskType === 'code',
      requiresReasoning: context.taskType === 'reasoning',
      requiresData: context.taskType === 'data',
    };

    // Estimate complexity from quality needs
    if (context.qualityNeeds === 'best') {
      features.complexity = 0.8;
      features.accuracyRequired = 0.9;
    } else if (context.qualityNeeds === 'good') {
      features.complexity = 0.5;
      features.accuracyRequired = 0.7;
    } else {
      features.complexity = 0.3;
      features.accuracyRequired = 0.5;
    }

    // Adjust for task type
    if (context.taskType === 'reasoning') {
      features.complexity = Math.max(features.complexity, 0.7);
      features.technicalDepth = 0.8;
    } else if (context.taskType === 'code') {
      features.technicalDepth = 0.9;
    } else if (context.taskType === 'conversation') {
      features.complexity = Math.min(features.complexity, 0.4);
    }

    // Estimate tokens
    features.estimatedTokens = context.estimatedTokens || 2000;

    return features;
  }

  /**
   * Quick pattern matching for task type detection
   */
  detectTaskType(content: string): TaskType {
    const lower = content.toLowerCase();

    // Vision indicators
    if (
      /image|photo|picture|screenshot|diagram|chart|blueprint/i.test(content) ||
      /what('s| is) (in|shown)/i.test(content) ||
      /analyze.*image|describe.*image/i.test(content)
    ) {
      return 'vision';
    }

    // Code indicators
    if (
      /\b(function|class|const|let|var|import|export|async|await)\b/.test(content) ||
      /```[\w]*\n/.test(content) ||
      /(write|create|build|implement|fix|debug).*code/i.test(content) ||
      /github|pull request|commit|merge/i.test(content)
    ) {
      return 'code';
    }

    // Reasoning indicators
    if (
      /(plan|strategy|analyze|evaluate|compare|design)/i.test(content) ||
      /(multi-step|complex|comprehensive|detailed analysis)/i.test(content) ||
      /(pros and cons|trade-?offs|implications)/i.test(content)
    ) {
      return 'reasoning';
    }

    // Data indicators
    if (
      /(extract|parse|transform|aggregate|analyze).*data/i.test(content) ||
      /(csv|json|xml|excel|sql|database)/i.test(content) ||
      /table|spreadsheet|dataset/i.test(content)
    ) {
      return 'data';
    }

    // Web indicators
    if (
      /(search|research|find|lookup|browse)/i.test(content) ||
      /(website|url|link|web page)/i.test(content) ||
      /what('s| is) the (latest|current|recent)/i.test(content)
    ) {
      return 'web';
    }

    // Default to conversation
    return 'conversation';
  }

  /**
   * Estimate complexity from content
   */
  estimateComplexity(content: string): number {
    let score = 0.3; // baseline

    // Length indicator
    const words = content.split(/\s+/).length;
    if (words > 200) score += 0.2;
    else if (words > 100) score += 0.1;

    // Complexity keywords
    const complexKeywords = [
      'complex',
      'comprehensive',
      'detailed',
      'multi-step',
      'analyze',
      'design',
      'architect',
      'optimize',
      'integrate',
    ];
    const complexCount = complexKeywords.filter((kw) =>
      content.toLowerCase().includes(kw)
    ).length;
    score += complexCount * 0.05;

    // Technical depth indicators
    if (/\b(algorithm|optimization|architecture|scalability)\b/i.test(content)) {
      score += 0.15;
    }

    // Multiple requirements
    const requirementCount = (content.match(/\d+\./g) || []).length;
    if (requirementCount > 3) score += 0.1;

    return Math.min(score, 1.0);
  }
}

/**
 * LLM-based classification (more accurate, but slower and costs tokens)
 */
export class LLMClassifier {
  /**
   * Use a local SLM to analyze task features
   * This would call Qwen-7B or similar for ~100ms overhead
   */
  async analyzeTask(content: string): Promise<TaskFeatures> {
    // In production, this would make an actual LLM call to Qwen-7B via MLX
    // For now, we'll simulate with intelligent heuristics

    const metadata = new MetadataClassifier();
    const taskType = metadata.detectTaskType(content);
    const complexity = metadata.estimateComplexity(content);

    const features: TaskFeatures = {
      complexity,
      technicalDepth: this.estimateTechnicalDepth(content),
      creativityNeeds: this.estimateCreativityNeeds(content, taskType),
      accuracyRequired: this.estimateAccuracyRequirement(content),

      requiresVision: taskType === 'vision',
      requiresCode: taskType === 'code',
      requiresReasoning: taskType === 'reasoning',
      requiresData: taskType === 'data',

      estimatedTokens: this.estimateTokens(content),
      language: this.detectLanguage(content),
      domain: this.detectDomain(content),
    };

    return features;
  }

  private estimateTechnicalDepth(content: string): number {
    const technicalTerms = [
      'api',
      'database',
      'architecture',
      'algorithm',
      'optimization',
      'integration',
      'deployment',
      'infrastructure',
      'scalability',
      'performance',
    ];

    const count = technicalTerms.filter((term) =>
      content.toLowerCase().includes(term)
    ).length;

    return Math.min(count * 0.15, 1.0);
  }

  private estimateCreativityNeeds(content: string, taskType: TaskType): number {
    if (taskType === 'data') return 0.2; // Mostly mechanical
    if (taskType === 'code') return 0.4; // Some creativity
    if (taskType === 'reasoning') return 0.7; // High creativity

    const creativeKeywords = [
      'design',
      'create',
      'innovative',
      'novel',
      'unique',
      'brainstorm',
      'idea',
    ];
    const count = creativeKeywords.filter((kw) =>
      content.toLowerCase().includes(kw)
    ).length;

    return Math.min(0.3 + count * 0.1, 1.0);
  }

  private estimateAccuracyRequirement(content: string): number {
    const highAccuracyKeywords = [
      'compliance',
      'legal',
      'safety',
      'critical',
      'production',
      'customer',
      'paid',
      'billing',
    ];

    const count = highAccuracyKeywords.filter((kw) =>
      content.toLowerCase().includes(kw)
    ).length;

    if (count > 0) return 0.9;

    // Default moderate accuracy
    return 0.6;
  }

  private estimateTokens(content: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(content.length / 4);
  }

  private detectLanguage(content: string): string {
    // Simple detection - in production would use a proper library
    if (/[\u0900-\u097F]/.test(content)) return 'hindi';
    if (/[\u0600-\u06FF]/.test(content)) return 'arabic';
    if (/[\u4E00-\u9FFF]/.test(content)) return 'chinese';
    return 'english';
  }

  private detectDomain(content: string): string | undefined {
    const lower = content.toLowerCase();

    if (/(blueprint|construction|osha|safety|building|contractor)/i.test(lower)) {
      return 'construction';
    }
    if (/(legal|law|contract|compliance|regulation)/i.test(lower)) {
      return 'legal';
    }
    if (/(medical|health|patient|diagnosis|clinical)/i.test(lower)) {
      return 'medical';
    }
    if (/(finance|accounting|revenue|expense|invoice)/i.test(lower)) {
      return 'finance';
    }

    return undefined;
  }
}

/**
 * Main classifier that chooses between metadata and LLM approaches
 */
export class TaskClassifier {
  private metadata = new MetadataClassifier();
  private llm = new LLMClassifier();

  /**
   * Classify task using the appropriate method based on speed requirements
   */
  async classify(
    context: RoutingContext,
    useLLM: boolean = false,
  ): Promise<TaskFeatures> {
    if (!useLLM || context.latencyNeeds === 'instant') {
      // Fast path: metadata only
      const partial = this.metadata.classifyFromContext(context);
      return this.fillDefaults(partial);
    }

    // Analyzed path: use LLM classifier
    if (context.contentSample) {
      return await this.llm.analyzeTask(context.contentSample);
    }

    // Fallback to metadata
    const partial = this.metadata.classifyFromContext(context);
    return this.fillDefaults(partial);
  }

  private fillDefaults(partial: Partial<TaskFeatures>): TaskFeatures {
    return {
      complexity: partial.complexity || 0.5,
      technicalDepth: partial.technicalDepth || 0.5,
      creativityNeeds: partial.creativityNeeds || 0.5,
      accuracyRequired: partial.accuracyRequired || 0.6,
      requiresVision: partial.requiresVision || false,
      requiresCode: partial.requiresCode || false,
      requiresReasoning: partial.requiresReasoning || false,
      requiresData: partial.requiresData || false,
      estimatedTokens: partial.estimatedTokens || 2000,
      language: partial.language,
      domain: partial.domain,
    };
  }
}
