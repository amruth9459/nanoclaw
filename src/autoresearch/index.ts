/**
 * Autoresearch System — Public API.
 *
 * Autonomous improvement loops: create experiments, apply mutations,
 * measure fitness, and keep/revert based on measured improvement.
 */

// Types
export type {
  ExperimentConfig,
  ExperimentRun,
  FitnessMetric,
  MutationStrategy,
  MutationType,
  MutationResult,
  MutationChange,
  ExperimentStatus,
  RunDecision,
  RunEvidence,
  AutoresearchMetrics,
  LeaderboardEntry,
} from './types.js';

// Persistence
export { initAutoresearchSchema } from './persistence.js';

// Experiment Engine
export {
  createExperiment,
  setBaseline,
  startRun,
  evaluateRun,
  decideKeepOrRevert,
  pauseExperiment,
  resumeExperiment,
  completeExperiment,
  getExperiment,
  listExperiments,
  getRun,
  listRuns,
  getMetrics,
  getLeaderboard,
  analyzeExperiment,
  type ExperimentAnalysis,
} from './experiment-engine.js';

// Fitness Library
export {
  registerFitnessFn,
  getFitnessFn,
  listFitnessFns,
  measureFitness,
  type FitnessFn,
  type FitnessContext,
} from './fitness-library.js';

// Mutation Strategies
export {
  registerMutationStrategy,
  getMutationStrategy,
  listMutationStrategies,
  applyMutation,
  type MutationContext,
  type MutationHistoryEntry,
} from './mutation-strategies.js';

// Orchestrator
export {
  AutoresearchOrchestrator,
  type OrchestratorConfig,
  type RunResult,
  type OrchestratorStatus,
} from './autoresearch-orchestrator.js';

// IPC Handler
export {
  handleAutoresearchIpc,
  AUTORESEARCH_IPC_TYPE,
  type AutoresearchIpcMessage,
} from './ipc-handler.js';
