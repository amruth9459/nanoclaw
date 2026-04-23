/**
 * Autoresearch System — Type definitions.
 *
 * Autonomous improvement loops inspired by awesome-autoresearch:
 * experiments measure a fitness metric, apply mutations, and keep/revert
 * based on measured improvement.
 */

// ---------------------------------------------------------------------------
// Fitness Metrics
// ---------------------------------------------------------------------------

export interface FitnessMetric {
  name: string;
  type: 'maximize' | 'minimize';
  unit: string;
  /** Name of a function in fitness-library.ts or a custom measurement function. */
  measurement_fn: string;
  /** Minimum improvement to keep a variant (e.g., 0.01 = 1%). */
  threshold_improvement: number;
}

// ---------------------------------------------------------------------------
// Mutation Strategies
// ---------------------------------------------------------------------------

export type MutationType =
  | 'prompt_evolution'
  | 'code_optimization'
  | 'config_tuning'
  | 'architecture_search';

export interface MutationStrategy {
  type: MutationType;
  parameters: Record<string, unknown>;
}

export interface MutationResult {
  description: string;
  changes: MutationChange[];
  revert_instructions: string;
}

export interface MutationChange {
  type: 'file_edit' | 'config_change' | 'prompt_change';
  target: string;
  before: string;
  after: string;
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

export type ExperimentStatus = 'active' | 'paused' | 'completed';

export interface ExperimentConfig {
  id: string;
  name: string;
  description: string;
  fitness_metric: FitnessMetric;
  baseline_score: number | null;
  current_best_score: number | null;
  mutation_strategy: MutationStrategy;
  created_at: string;
  updated_at: string;
  status: ExperimentStatus;
}

// ---------------------------------------------------------------------------
// Experiment Runs
// ---------------------------------------------------------------------------

export type RunDecision = 'keep' | 'revert' | 'pending';

export interface RunEvidence {
  measurements: Record<string, number>;
  logs?: string;
  artifacts?: string[];
}

export interface ExperimentRun {
  id: string;
  experiment_id: string;
  variant_description: string;
  mutation_applied: string;
  fitness_score: number;
  baseline_score: number;
  improvement: number;
  decision: RunDecision;
  evidence: RunEvidence;
  started_at: string;
  completed_at: string | null;
  agent_id: string;
}

// ---------------------------------------------------------------------------
// Aggregate Metrics
// ---------------------------------------------------------------------------

export interface AutoresearchMetrics {
  total_experiments: number;
  active_experiments: number;
  total_runs: number;
  improvements_kept: number;
  improvements_reverted: number;
  best_improvement_pct: number;
  avg_improvement_pct: number;
}

// ---------------------------------------------------------------------------
// Leaderboard Entry
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  experiment_id: string;
  experiment_name: string;
  run_id: string;
  fitness_score: number;
  improvement: number;
  agent_id: string;
  completed_at: string;
}

// ---------------------------------------------------------------------------
// Database Row Types
// ---------------------------------------------------------------------------

export interface ExperimentRow {
  id: string;
  name: string;
  description: string;
  fitness_metric: string;   // JSON
  baseline_score: number | null;
  current_best_score: number | null;
  mutation_strategy: string; // JSON
  created_at: string;
  updated_at: string;
  status: string;
}

export interface ExperimentRunRow {
  id: string;
  experiment_id: string;
  variant_description: string;
  mutation_applied: string;
  fitness_score: number;
  baseline_score: number;
  improvement: number;
  decision: string;
  evidence: string;          // JSON
  started_at: string;
  completed_at: string | null;
  agent_id: string;
}
