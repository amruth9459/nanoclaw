/**
 * Experiment Engine — Core autoresearch loop.
 *
 * Orchestrates the create → mutate → measure → decide cycle:
 * 1. Create an experiment with a fitness metric and mutation strategy
 * 2. Run iterations: apply mutation, measure fitness, decide keep/revert
 * 3. Track progress via the evidence chain for full auditability
 */
import { logger } from '../logger.js';
import { createEvidence, getChain } from '../identity/index.js';
import { logAction } from '../agent-monitoring-system.js';
import type { ActionType, EvidenceOutcome } from '../identity/types.js';

import {
  createExperiment as dbCreateExperiment,
  getExperiment as dbGetExperiment,
  updateExperiment as dbUpdateExperiment,
  listExperiments as dbListExperiments,
  createRun as dbCreateRun,
  getRun as dbGetRun,
  updateRun as dbUpdateRun,
  listRuns as dbListRuns,
  getMetrics as dbGetMetrics,
  getLeaderboard as dbGetLeaderboard,
} from './persistence.js';
import { measureFitness, type FitnessContext } from './fitness-library.js';
import { applyMutation, type MutationContext, type MutationHistoryEntry } from './mutation-strategies.js';
import type {
  ExperimentConfig,
  ExperimentRun,
  ExperimentStatus,
  FitnessMetric,
  MutationStrategy,
  AutoresearchMetrics,
  LeaderboardEntry,
  RunEvidence,
} from './types.js';

// ---------------------------------------------------------------------------
// Experiment Lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new experiment and optionally set its baseline.
 */
export async function createExperiment(
  name: string,
  description: string,
  fitnessMetric: FitnessMetric,
  mutationStrategy: MutationStrategy,
  agentId?: string,
): Promise<ExperimentConfig> {
  const experiment = dbCreateExperiment(name, description, fitnessMetric, mutationStrategy);

  logger.info({
    experimentId: experiment.id,
    name: experiment.name,
    metric: fitnessMetric.name,
    strategy: mutationStrategy.type,
  }, 'Autoresearch experiment created');

  // Record in evidence chain if we have an agent identity
  if (agentId) {
    await recordEvidenceSafe(agentId, 'task_created', {
      experiment_id: experiment.id,
      experiment_name: name,
      fitness_metric: fitnessMetric.name,
      mutation_strategy: mutationStrategy.type,
    }, 'Create autoresearch experiment', { success: true });
  }

  return experiment;
}

/**
 * Set or update the baseline score for an experiment.
 */
export async function setBaseline(
  experimentId: string,
  score: number,
  agentId?: string,
): Promise<ExperimentConfig | null> {
  const experiment = dbGetExperiment(experimentId);
  if (!experiment) return null;

  const updated = dbUpdateExperiment(experimentId, {
    baseline_score: score,
    current_best_score: experiment.current_best_score ?? score,
  });

  logger.info({ experimentId, baseline: score }, 'Experiment baseline set');

  if (agentId) {
    await recordEvidenceSafe(agentId, 'task_updated' as ActionType, {
      experiment_id: experimentId,
      baseline_score: score,
    }, 'Set experiment baseline', { success: true });
  }

  return updated;
}

/**
 * Run one iteration of an experiment:
 * 1. Create a run record
 * 2. Apply the mutation
 * 3. Return the run ID for subsequent fitness evaluation
 */
export async function startRun(
  experimentId: string,
  agentId: string,
  variantDescription: string,
  currentContent: string,
  target: string,
): Promise<{ run: ExperimentRun; mutation: Awaited<ReturnType<typeof applyMutation>> }> {
  const experiment = dbGetExperiment(experimentId);
  if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
  if (experiment.status !== 'active') throw new Error(`Experiment is ${experiment.status}, not active`);

  const baselineScore = experiment.current_best_score ?? experiment.baseline_score ?? 0;

  // Build mutation history from past runs
  const pastRuns = dbListRuns(experimentId);
  const history: MutationHistoryEntry[] = pastRuns
    .filter(r => r.decision !== 'pending')
    .map(r => ({
      mutation_description: r.mutation_applied,
      score: r.fitness_score,
      decision: r.decision as 'keep' | 'revert',
    }));

  // Apply mutation strategy
  const mutationContext: MutationContext = {
    current_content: currentContent,
    target,
    previous_score: baselineScore,
    history,
  };

  const mutation = await applyMutation(experiment.mutation_strategy, mutationContext);

  // Create run record
  const run = dbCreateRun(
    experimentId,
    agentId,
    variantDescription,
    mutation.description,
    baselineScore,
  );

  // Log the action for monitoring
  logAction({
    timestamp: new Date().toISOString(),
    action_type: 'mcp_call',
    tool_name: 'autoresearch_run',
    risk_score: 20,
    flagged: false,
    group_folder: 'system',
    task_id: run.id,
  });

  logger.info({
    experimentId,
    runId: run.id,
    mutation: mutation.description,
  }, 'Autoresearch run started');

  return { run, mutation };
}

/**
 * Evaluate fitness for a completed run and record the score.
 */
export async function evaluateRun(
  runId: string,
  fitnessContext: FitnessContext,
  additionalEvidence?: Partial<RunEvidence>,
): Promise<ExperimentRun | null> {
  const run = dbGetRun(runId);
  if (!run) return null;

  const experiment = dbGetExperiment(run.experiment_id);
  if (!experiment) return null;

  // Measure fitness
  const score = await measureFitness(experiment.fitness_metric.measurement_fn, fitnessContext);

  // Calculate improvement
  const baseline = run.baseline_score || 1; // Avoid division by zero
  let improvement: number;
  if (experiment.fitness_metric.type === 'maximize') {
    improvement = baseline !== 0 ? (score - baseline) / Math.abs(baseline) : 0;
  } else {
    // For minimize metrics, lower is better
    improvement = baseline !== 0 ? (baseline - score) / Math.abs(baseline) : 0;
  }

  // Merge evidence
  const evidence: RunEvidence = {
    measurements: {
      ...additionalEvidence?.measurements,
      [experiment.fitness_metric.name]: score,
    },
    logs: additionalEvidence?.logs,
    artifacts: additionalEvidence?.artifacts,
  };

  const updated = dbUpdateRun(runId, {
    fitness_score: score,
    improvement,
    evidence,
  });

  logger.info({
    runId,
    experimentId: run.experiment_id,
    score,
    improvement: `${(improvement * 100).toFixed(2)}%`,
  }, 'Autoresearch run evaluated');

  return updated;
}

/**
 * Decide whether to keep or revert a run based on improvement threshold.
 * This is the core autoresearch decision: keep only if improvement exceeds threshold.
 */
export async function decideKeepOrRevert(
  experimentId: string,
  runId: string,
): Promise<'keep' | 'revert'> {
  const run = dbGetRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const experiment = dbGetExperiment(experimentId);
  if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);

  const threshold = experiment.fitness_metric.threshold_improvement;
  const decision = run.improvement >= threshold ? 'keep' : 'revert';

  // Update run with decision
  dbUpdateRun(runId, {
    decision,
    completed_at: new Date().toISOString(),
  });

  // If keeping, update the experiment's current best score
  if (decision === 'keep') {
    dbUpdateExperiment(experimentId, {
      current_best_score: run.fitness_score,
    });
  }

  // Record in evidence chain
  await recordEvidenceSafe(run.agent_id, 'task_updated' as ActionType, {
    experiment_id: experimentId,
    run_id: runId,
    improvement: run.improvement,
    threshold,
    decision,
    fitness_score: run.fitness_score,
    baseline_score: run.baseline_score,
  }, `Autoresearch ${decision}: improvement=${(run.improvement * 100).toFixed(2)}% (threshold=${(threshold * 100).toFixed(2)}%)`, {
    success: true,
    result: { decision, improvement: run.improvement },
  });

  logger.info({
    experimentId,
    runId,
    decision,
    improvement: `${(run.improvement * 100).toFixed(2)}%`,
    threshold: `${(threshold * 100).toFixed(2)}%`,
  }, `Autoresearch decision: ${decision}`);

  return decision;
}

// ---------------------------------------------------------------------------
// Experiment State Management
// ---------------------------------------------------------------------------

export function pauseExperiment(experimentId: string): ExperimentConfig | null {
  return dbUpdateExperiment(experimentId, { status: 'paused' });
}

export function resumeExperiment(experimentId: string): ExperimentConfig | null {
  return dbUpdateExperiment(experimentId, { status: 'active' });
}

export function completeExperiment(experimentId: string): ExperimentConfig | null {
  return dbUpdateExperiment(experimentId, { status: 'completed' });
}

// ---------------------------------------------------------------------------
// Query Functions
// ---------------------------------------------------------------------------

export function getExperiment(experimentId: string): ExperimentConfig | null {
  return dbGetExperiment(experimentId);
}

export function listExperiments(status?: ExperimentStatus): ExperimentConfig[] {
  return dbListExperiments(status);
}

export function getRun(runId: string): ExperimentRun | null {
  return dbGetRun(runId);
}

export function listRuns(experimentId: string): ExperimentRun[] {
  return dbListRuns(experimentId);
}

export function getMetrics(): AutoresearchMetrics {
  return dbGetMetrics();
}

export function getLeaderboard(limit?: number): LeaderboardEntry[] {
  return dbGetLeaderboard(limit);
}

/**
 * Analyze an experiment's performance with statistical summary.
 */
export function analyzeExperiment(experimentId: string): ExperimentAnalysis | null {
  const experiment = dbGetExperiment(experimentId);
  if (!experiment) return null;

  const runs = dbListRuns(experimentId);
  if (runs.length === 0) {
    return {
      experiment,
      total_runs: 0,
      kept_runs: 0,
      reverted_runs: 0,
      pending_runs: 0,
      scores: [],
      improvements: [],
      mean_improvement: 0,
      std_improvement: 0,
      best_run: null,
      worst_run: null,
      trend: 'neutral',
    };
  }

  const keptRuns = runs.filter(r => r.decision === 'keep');
  const revertedRuns = runs.filter(r => r.decision === 'revert');
  const pendingRuns = runs.filter(r => r.decision === 'pending');
  const completedRuns = runs.filter(r => r.decision !== 'pending');

  const scores = completedRuns.map(r => r.fitness_score);
  const improvements = completedRuns.map(r => r.improvement);

  const meanImprovement = improvements.length > 0
    ? improvements.reduce((a, b) => a + b, 0) / improvements.length
    : 0;

  const stdImprovement = improvements.length > 1
    ? Math.sqrt(
      improvements.reduce((sum, val) => sum + (val - meanImprovement) ** 2, 0) / (improvements.length - 1)
    )
    : 0;

  const bestRun = completedRuns.length > 0
    ? completedRuns.reduce((best, run) => run.improvement > best.improvement ? run : best)
    : null;
  const worstRun = completedRuns.length > 0
    ? completedRuns.reduce((worst, run) => run.improvement < worst.improvement ? run : worst)
    : null;

  // Simple trend detection: compare first half to second half
  let trend: 'improving' | 'declining' | 'neutral' = 'neutral';
  if (completedRuns.length >= 4) {
    const mid = Math.floor(completedRuns.length / 2);
    const firstHalf = completedRuns.slice(0, mid).reduce((s, r) => s + r.improvement, 0) / mid;
    const secondHalf = completedRuns.slice(mid).reduce((s, r) => s + r.improvement, 0) / (completedRuns.length - mid);
    if (secondHalf > firstHalf + 0.01) trend = 'improving';
    else if (secondHalf < firstHalf - 0.01) trend = 'declining';
  }

  return {
    experiment,
    total_runs: runs.length,
    kept_runs: keptRuns.length,
    reverted_runs: revertedRuns.length,
    pending_runs: pendingRuns.length,
    scores,
    improvements,
    mean_improvement: meanImprovement,
    std_improvement: stdImprovement,
    best_run: bestRun,
    worst_run: worstRun,
    trend,
  };
}

export interface ExperimentAnalysis {
  experiment: ExperimentConfig;
  total_runs: number;
  kept_runs: number;
  reverted_runs: number;
  pending_runs: number;
  scores: number[];
  improvements: number[];
  mean_improvement: number;
  std_improvement: number;
  best_run: ExperimentRun | null;
  worst_run: ExperimentRun | null;
  trend: 'improving' | 'declining' | 'neutral';
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Record evidence safely — logs a warning if the agent identity is missing
 * rather than crashing the experiment engine.
 */
async function recordEvidenceSafe(
  agentId: string,
  actionType: ActionType,
  details: Record<string, unknown>,
  intent: string,
  outcome: EvidenceOutcome,
): Promise<void> {
  try {
    await createEvidence(agentId, actionType, details, intent, outcome);
  } catch (err) {
    logger.warn({ err, agentId, actionType }, 'Failed to record autoresearch evidence (agent identity may not exist)');
  }
}
