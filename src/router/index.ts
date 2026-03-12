/**
 * Universal AI Router - Main Export
 * Production-ready routing system for NanoClaw
 */

// Core Router
export {
  UniversalRouter,
  RouterFactory,
} from './universal-router.js';

// Task Classification
export {
  TaskClassifier,
  MetadataClassifier,
  LLMClassifier,
} from './task-classifier.js';

// Model Selection
export {
  ModelRegistry,
  ModelSelector,
} from './model-selector.js';

// Routing Rules
export {
  RoutingRulesEngine,
  RulePresets,
} from './routing-rules.js';

// Fallback Handling
export {
  FallbackHandler,
} from './fallback-handler.js';
export type {
  FallbackAttempt,
  FallbackResult,
} from './fallback-handler.js';

// Performance Tracking
export {
  PerformanceTracker,
} from './performance-tracker.js';

// Monitoring
export {
  RouterMetrics,
  saveDashboard,
} from './monitoring/router-metrics.js';
export type {
  MetricsDashboard,
} from './monitoring/router-metrics.js';

// MLX Backend
export {
  MLXBackend,
  MLXBackendFactory,
  formatMLXResponse,
} from './backends/mlx-backend.js';
export type {
  MLXModelConfig,
  MLXInferenceRequest,
  MLXInferenceResponse,
  MLXBackendConfig,
} from './backends/mlx-backend.js';

// Types
export type {
  TaskType,
  UserTier,
  CostBudget,
  QualityNeeds,
  LatencyNeeds,
  ModelTier,
  TaskSource,
  RoutingContext,
  ModelConfig,
  RoutingDecision,
  TaskFeatures,
  RoutingRule,
  RoutingMetrics,
  ModelPerformance,
  FallbackStrategy,
  RouterConfig,
} from './types.js';

/**
 * Quick Start Examples
 */

// Example 1: Simple usage with defaults
/*
import { RouterFactory } from './router/index.js';

const router = RouterFactory.create();

const context = {
  taskType: 'conversation',
  userTier: 'internal',
  costBudget: 'zero',
  qualityNeeds: 'good',
  latencyNeeds: 'fast',
  source: 'whatsapp',
};

const decision = await router.route(context);
console.log(`Route to: ${decision.modelId} (${decision.reasoning})`);
*/

// Example 2: Execute with fallback
/*
const { result, decision } = await router.execute(context, async (modelId) => {
  // Your inference code here
  return await runModel(modelId, prompt);
});
*/

// Example 3: Get metrics
/*
const metrics = router.getMetrics('24h');
console.log(`Cost saved: $${metrics.costSavedUsd}`);
console.log(`Local models: ${metrics.localSlmPercentage + metrics.localLlmPercentage}%`);
*/

// Example 4: Monitor performance
/*
import { RouterMetrics } from './router/index.js';

const monitoring = new RouterMetrics(router['tracker']);
const dashboard = monitoring.generateDashboard('24h');
console.log(monitoring.generateTextSummary('24h'));

const alerts = monitoring.getAlerts();
if (alerts.length > 0) {
  console.log('ALERTS:', alerts);
}
*/
