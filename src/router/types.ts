/**
 * Universal AI Router Types
 * Defines interfaces for routing tasks to optimal AI models
 */

export type TaskType =
  | 'conversation'  // Chat with Claw (casual, planning, questions)
  | 'vision'        // Image analysis, OCR, document understanding
  | 'code'          // Generation, review, debugging
  | 'reasoning'     // Complex planning, multi-step tasks
  | 'data'          // Analysis, extraction, transformation
  | 'web';          // Research, browsing, data collection

export type UserTier =
  | 'internal'       // NanoClaw team/owner
  | 'beta'           // Beta testers
  | 'paid_customer'; // Paying customers (e.g., Lexios)

export type CostBudget =
  | 'unlimited'  // Quality first, cost no object
  | 'limited'    // Balance quality and cost
  | 'zero';      // Only free/local models

export type QualityNeeds =
  | 'best'       // Highest quality, use cloud if needed
  | 'good'       // High quality, prefer local LLM
  | 'acceptable'; // Basic quality, use SLM

export type LatencyNeeds =
  | 'instant'  // <100ms, SLM only
  | 'fast'     // <2s, local models
  | 'batch';   // No rush, can queue

export type ModelTier =
  | 'local-slm'   // Small language models (7B)
  | 'local-llm'   // Large language models (70B+)
  | 'cloud';      // API-based models

export type TaskSource =
  | 'whatsapp'
  | 'lexios'
  | 'osha'
  | 'scheduled_task'
  | 'bounty'
  | 'internal';

/**
 * Context provided to the router for decision-making
 */
export interface RoutingContext {
  taskType: TaskType;
  userTier: UserTier;
  costBudget: CostBudget;
  qualityNeeds: QualityNeeds;
  latencyNeeds: LatencyNeeds;
  source: TaskSource;

  // Optional metadata
  estimatedTokens?: number;
  hasMedia?: boolean;
  mediaType?: 'image' | 'video' | 'document';
  isPaidCustomer?: boolean;
  customerId?: string;

  // For analysis-based routing
  contentSample?: string;
}

/**
 * Model configuration
 */
export interface ModelConfig {
  id: string;
  name: string;
  tier: ModelTier;
  provider: 'local-mlx' | 'anthropic' | 'openai' | 'google';

  // Capabilities
  supportsVision: boolean;
  maxTokens: number;
  contextWindow: number;

  // Performance metrics
  avgLatencyMs: number;
  costPer1kTokens: number; // $0 for local

  // Availability
  requiresGpu?: boolean;
  memoryGb?: number;
}

/**
 * Routing decision with explanation
 */
export interface RoutingDecision {
  modelId: string;
  modelTier: ModelTier;
  confidence: number; // 0-1
  reasoning: string;

  // Metrics
  estimatedLatencyMs: number;
  estimatedCostUsd: number;

  // Fallback plan
  fallbackModelId?: string;

  // Metadata
  decidedAt: Date;
  decisionTimeMs: number;
}

/**
 * Task features extracted by classifier
 */
export interface TaskFeatures {
  complexity: number; // 0-1
  technicalDepth: number; // 0-1
  creativityNeeds: number; // 0-1
  accuracyRequired: number; // 0-1

  // Detected patterns
  requiresVision: boolean;
  requiresCode: boolean;
  requiresReasoning: boolean;
  requiresData: boolean;

  // Content analysis
  estimatedTokens: number;
  language?: string;
  domain?: string; // e.g., 'construction', 'legal', 'medical'
}

/**
 * Routing rule configuration
 */
export interface RoutingRule {
  name: string;
  priority: number;

  // Conditions
  taskTypes?: TaskType[];
  userTiers?: UserTier[];
  sources?: TaskSource[];

  // Constraints
  minComplexity?: number;
  maxComplexity?: number;
  requiresVision?: boolean;

  // Action
  preferredTier: ModelTier;
  preferredModel?: string;
  fallbackModel?: string;

  // Meta
  enabled: boolean;
  description: string;
}

/**
 * Performance metrics for monitoring
 */
export interface RoutingMetrics {
  period: '1h' | '24h' | '7d' | '30d';
  startTime: Date;
  endTime: Date;

  // Request distribution
  totalRequests: number;
  byTier: Record<ModelTier, number>;
  byTaskType: Record<TaskType, number>;
  bySource: Record<TaskSource, number>;

  // Performance
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;

  // Cost
  totalCostUsd: number;
  costSavedUsd: number; // vs all-cloud

  // Quality
  successRate: number;
  fallbackRate: number;
  errorRate: number;

  // Efficiency
  localSlmPercentage: number;
  localLlmPercentage: number;
  cloudPercentage: number;
}

/**
 * Model performance tracking
 */
export interface ModelPerformance {
  modelId: string;
  period: string;

  // Usage
  requestCount: number;
  successCount: number;
  errorCount: number;
  fallbackCount: number;

  // Performance
  avgLatencyMs: number;
  totalCostUsd: number;

  // Quality indicators
  avgConfidence: number;
  userSatisfaction?: number; // if feedback available

  // Timestamps
  firstUsed: Date;
  lastUsed: Date;
}

/**
 * Fallback strategy
 */
export interface FallbackStrategy {
  maxRetries: number;
  retryDelayMs: number;

  // Fallback chain: SLM -> LLM -> Cloud
  enableTierEscalation: boolean;

  // When to fallback
  fallbackOnError: boolean;
  fallbackOnTimeout: boolean;
  fallbackOnLowConfidence: boolean;
  lowConfidenceThreshold?: number;
}

/**
 * Router configuration
 */
export interface RouterConfig {
  defaultTier: ModelTier;
  costOptimization: boolean;
  fallbackEnabled: boolean;

  models: {
    local: {
      slm: {
        vision: string;
        text: string;
      };
      llm: {
        vision: string;
        reasoning: string;
        code?: string;
      };
    };
    cloud: {
      reasoning: string;
      code: string;
      vision: string;
      fallback?: string;
    };
  };

  routingRules: Record<string, Record<string, ModelTier>>;
  fallbackStrategy: FallbackStrategy;

  // Performance tuning
  enableAnalysisBasedRouting: boolean; // Use classifier vs metadata-only
  analysisTimeoutMs: number;

  // Monitoring
  metricsEnabled: boolean;
  metricsRetentionDays: number;
}
