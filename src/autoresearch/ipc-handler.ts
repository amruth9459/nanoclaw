/**
 * Autoresearch IPC Handler — Host-side processing of autoresearch requests.
 *
 * Receives IPC messages from container agents and delegates to the experiment engine.
 * Returns results via response files.
 */
import { logger } from '../logger.js';

import {
  createExperiment,
  setBaseline,
  startRun,
  evaluateRun,
  decideKeepOrRevert,
  getExperiment,
  listExperiments,
  pauseExperiment,
  resumeExperiment,
  completeExperiment,
  analyzeExperiment,
  getMetrics,
  getLeaderboard,
} from './experiment-engine.js';
import type { FitnessMetric, MutationStrategy, ExperimentStatus } from './types.js';

// ---------------------------------------------------------------------------
// IPC Message Types
// ---------------------------------------------------------------------------

export const AUTORESEARCH_IPC_TYPE = 'autoresearch';

export interface AutoresearchIpcMessage {
  type: 'autoresearch';
  action: string;
  agent_id: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle an autoresearch IPC message from a container agent.
 * Returns the result as a plain object to be written to the response file.
 */
export async function handleAutoresearchIpc(
  data: AutoresearchIpcMessage,
): Promise<Record<string, unknown>> {
  const { action, agent_id: agentId } = data;

  try {
    switch (action) {
      case 'create': {
        const name = data.name as string;
        const description = (data.description as string) ?? '';
        const fitnessMetric = data.fitness_metric as FitnessMetric;
        const mutationStrategy = data.mutation_strategy as MutationStrategy;

        if (!name || !fitnessMetric || !mutationStrategy) {
          return { error: 'create requires name, fitness_metric, and mutation_strategy' };
        }

        const experiment = await createExperiment(
          name, description, fitnessMetric, mutationStrategy, agentId
        );
        return experiment as unknown as Record<string, unknown>;
      }

      case 'run': {
        const experimentId = data.experiment_id as string;
        const variantDescription = (data.variant_description as string) ?? 'Unnamed variant';
        const currentContent = (data.current_content as string) ?? '';
        const target = (data.target as string) ?? '';

        if (!experimentId) {
          return { error: 'run requires experiment_id' };
        }

        const { run, mutation } = await startRun(
          experimentId, agentId, variantDescription, currentContent, target
        );

        // Evaluate the run with the agent's context
        const evaluatedRun = await evaluateRun(run.id, {
          agent_id: agentId,
          task_id: experimentId,
        });

        if (!evaluatedRun) {
          return { error: 'Failed to evaluate run' };
        }

        // Decide keep or revert
        const decision = await decideKeepOrRevert(experimentId, run.id);

        return {
          status: 'completed',
          runId: run.id,
          decision,
          improvement: evaluatedRun.improvement,
          fitnessScore: evaluatedRun.fitness_score,
          mutation: mutation.description,
        };
      }

      case 'list': {
        const status = data.status as ExperimentStatus | undefined;
        const experiments = listExperiments(status);
        return { experiments };
      }

      case 'pause': {
        const experimentId = data.experiment_id as string;
        if (!experimentId) return { error: 'pause requires experiment_id' };
        const result = pauseExperiment(experimentId);
        return result ? (result as unknown as Record<string, unknown>) : { error: 'Experiment not found' };
      }

      case 'resume': {
        const experimentId = data.experiment_id as string;
        if (!experimentId) return { error: 'resume requires experiment_id' };
        const result = resumeExperiment(experimentId);
        return result ? (result as unknown as Record<string, unknown>) : { error: 'Experiment not found' };
      }

      case 'complete': {
        const experimentId = data.experiment_id as string;
        if (!experimentId) return { error: 'complete requires experiment_id' };
        const result = completeExperiment(experimentId);
        return result ? (result as unknown as Record<string, unknown>) : { error: 'Experiment not found' };
      }

      case 'baseline': {
        const experimentId = data.experiment_id as string;
        const score = data.score as number;
        if (!experimentId || score === undefined) {
          return { error: 'baseline requires experiment_id and score' };
        }
        const result = await setBaseline(experimentId, score, agentId);
        return result ? (result as unknown as Record<string, unknown>) : { error: 'Experiment not found' };
      }

      case 'leaderboard': {
        const limit = (data.limit as number) ?? 10;
        const entries = getLeaderboard(limit);
        return { entries };
      }

      case 'analyze': {
        const experimentId = data.experiment_id as string;
        if (!experimentId) return { error: 'analyze requires experiment_id' };
        const analysis = analyzeExperiment(experimentId);
        if (!analysis) return { error: 'Experiment not found' };
        return analysis as unknown as Record<string, unknown>;
      }

      case 'metrics': {
        return getMetrics() as unknown as Record<string, unknown>;
      }

      default:
        return { error: `Unknown autoresearch action: ${action}` };
    }
  } catch (err) {
    logger.error({ err, action, agentId }, 'Autoresearch IPC handler error');
    return { error: String(err instanceof Error ? err.message : err) };
  }
}
