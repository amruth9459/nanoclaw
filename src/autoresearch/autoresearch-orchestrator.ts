/**
 * Autoresearch Orchestrator — Multi-agent experiment coordination.
 *
 * Integrates with the existing TeamOrchestrator and ResourceOrchestrator to:
 * - Spawn specialist agents for experiment runs
 * - Coordinate parallel experiments with resource limits
 * - Schedule experiments based on priority
 * - Enforce safety constraints via the monitoring system
 */
import { logger } from '../logger.js';
import { AgentPriority, type ResourceOrchestrator, type AgentRequest } from '../resource-orchestrator.js';
import { logAction } from '../agent-monitoring-system.js';

import {
  createExperiment,
  startRun,
  evaluateRun,
  decideKeepOrRevert,
  listExperiments,
  getExperiment,
  pauseExperiment,
  completeExperiment,
  analyzeExperiment,
  getMetrics,
} from './experiment-engine.js';
import { listRuns as dbListRuns } from './persistence.js';
import type { FitnessContext } from './fitness-library.js';
import type {
  ExperimentConfig,
  ExperimentRun,
  FitnessMetric,
  MutationStrategy,
  AutoresearchMetrics,
} from './types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OrchestratorConfig {
  /** Maximum number of concurrent experiment runs. */
  max_concurrent_runs: number;
  /** Maximum number of active experiments. */
  max_active_experiments: number;
  /** Default priority for autoresearch agents. */
  default_priority: AgentPriority;
  /** RAM allocation per experiment run (GB). */
  ram_per_run_gb: number;
  /** Auto-complete experiments after this many consecutive reverts. */
  max_consecutive_reverts: number;
  /** Auto-pause experiments after this many total runs. */
  max_runs_per_experiment: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  max_concurrent_runs: 2,
  max_active_experiments: 5,
  default_priority: AgentPriority.LOW,
  ram_per_run_gb: 2,
  max_consecutive_reverts: 5,
  max_runs_per_experiment: 50,
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class AutoresearchOrchestrator {
  private config: OrchestratorConfig;
  private resourceOrchestrator: ResourceOrchestrator | null;
  private activeRuns: Map<string, ActiveRunState> = new Map();
  private runQueue: QueuedRun[] = [];

  constructor(
    resourceOrchestrator: ResourceOrchestrator | null = null,
    config: Partial<OrchestratorConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resourceOrchestrator = resourceOrchestrator;
  }

  /**
   * Submit a new experiment to the orchestrator.
   */
  async submitExperiment(
    name: string,
    description: string,
    fitnessMetric: FitnessMetric,
    mutationStrategy: MutationStrategy,
    agentId?: string,
  ): Promise<ExperimentConfig> {
    // Check active experiment limit
    const active = listExperiments('active');
    if (active.length >= this.config.max_active_experiments) {
      throw new Error(
        `Active experiment limit reached (${this.config.max_active_experiments}). ` +
        `Complete or pause existing experiments first.`
      );
    }

    const experiment = await createExperiment(
      name, description, fitnessMetric, mutationStrategy, agentId
    );

    logger.info({
      experimentId: experiment.id,
      activeCount: active.length + 1,
      limit: this.config.max_active_experiments,
    }, 'Experiment submitted to orchestrator');

    return experiment;
  }

  /**
   * Queue a run for an experiment. The orchestrator manages concurrency.
   */
  async queueRun(
    experimentId: string,
    agentId: string,
    variantDescription: string,
    currentContent: string,
    target: string,
    fitnessContext: FitnessContext,
    priority?: AgentPriority,
  ): Promise<string> {
    const experiment = getExperiment(experimentId);
    if (!experiment) throw new Error(`Experiment not found: ${experimentId}`);
    if (experiment.status !== 'active') throw new Error(`Experiment is ${experiment.status}`);

    const queuedRun: QueuedRun = {
      id: `qr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      experimentId,
      agentId,
      variantDescription,
      currentContent,
      target,
      fitnessContext,
      priority: priority ?? this.config.default_priority,
      queuedAt: Date.now(),
    };

    // Try to run immediately if under concurrency limit
    if (this.activeRuns.size < this.config.max_concurrent_runs) {
      await this.executeRun(queuedRun);
    } else {
      // Add to priority queue
      this.runQueue.push(queuedRun);
      this.runQueue.sort((a, b) => b.priority - a.priority);
      logger.info({
        queueId: queuedRun.id,
        position: this.runQueue.length,
        activeRuns: this.activeRuns.size,
      }, 'Run queued (concurrency limit reached)');
    }

    return queuedRun.id;
  }

  /**
   * Execute a full run cycle: start → evaluate → decide.
   */
  async executeRun(queuedRun: QueuedRun): Promise<RunResult> {
    const { experimentId, agentId, variantDescription, currentContent, target, fitnessContext } = queuedRun;

    // Check resource availability
    if (this.resourceOrchestrator) {
      const resourceRequest: AgentRequest = {
        id: `autoresearch_${queuedRun.id}`,
        type: 'autoresearch',
        priority: queuedRun.priority,
        estimatedRamGB: this.config.ram_per_run_gb,
        taskId: experimentId,
      };

      const resourceCheck = await this.resourceOrchestrator.requestResources(resourceRequest);
      if (!resourceCheck.allowed) {
        logger.warn({ queueId: queuedRun.id, wait: resourceCheck.estimatedWaitMs },
          'Insufficient resources for autoresearch run');
        // Re-queue
        this.runQueue.unshift(queuedRun);
        return { status: 'queued', reason: 'insufficient_resources' };
      }
    }

    const runState: ActiveRunState = {
      queuedRun,
      startedAt: Date.now(),
    };
    this.activeRuns.set(queuedRun.id, runState);

    try {
      // Start the run (applies mutation)
      const { run, mutation } = await startRun(experimentId, agentId, variantDescription, currentContent, target);

      // Evaluate fitness
      const evaluatedRun = await evaluateRun(run.id, fitnessContext);
      if (!evaluatedRun) {
        throw new Error(`Failed to evaluate run ${run.id}`);
      }

      // Decide keep or revert
      const decision = await decideKeepOrRevert(experimentId, run.id);

      // Check for auto-completion conditions
      await this.checkAutoCompletion(experimentId);

      logger.info({
        experimentId,
        runId: run.id,
        decision,
        improvement: `${(evaluatedRun.improvement * 100).toFixed(2)}%`,
        fitnessScore: evaluatedRun.fitness_score,
      }, 'Autoresearch run completed');

      return {
        status: 'completed',
        runId: run.id,
        decision,
        improvement: evaluatedRun.improvement,
        fitnessScore: evaluatedRun.fitness_score,
        mutation: mutation.description,
      };
    } catch (err) {
      logger.error({ err, queueId: queuedRun.id }, 'Autoresearch run failed');
      return { status: 'failed', reason: String(err) };
    } finally {
      this.activeRuns.delete(queuedRun.id);
      if (this.resourceOrchestrator) {
        this.resourceOrchestrator.releaseAgent(`autoresearch_${queuedRun.id}`);
      }
      // Process next queued run
      await this.processQueue();
    }
  }

  /**
   * Process the next run in the queue if capacity is available.
   */
  private async processQueue(): Promise<void> {
    while (this.runQueue.length > 0 && this.activeRuns.size < this.config.max_concurrent_runs) {
      const next = this.runQueue.shift();
      if (next) {
        // Fire and forget — errors are handled in executeRun
        this.executeRun(next).catch(err => {
          logger.error({ err, queueId: next.id }, 'Failed to process queued run');
        });
      }
    }
  }

  /**
   * Check if an experiment should be auto-completed or auto-paused.
   */
  private async checkAutoCompletion(experimentId: string): Promise<void> {
    const analysis = analyzeExperiment(experimentId);
    if (!analysis) return;

    // Auto-complete after max consecutive reverts (plateau detected)
    if (analysis.reverted_runs > 0) {
      const runs = dbListRuns(experimentId);
      const completedRuns = runs.filter(r => r.decision !== 'pending');
      let consecutiveReverts = 0;
      for (let i = completedRuns.length - 1; i >= 0; i--) {
        if (completedRuns[i].decision === 'revert') consecutiveReverts++;
        else break;
      }
      if (consecutiveReverts >= this.config.max_consecutive_reverts) {
        completeExperiment(experimentId);
        logger.info({ experimentId, consecutiveReverts },
          'Experiment auto-completed: plateau detected (max consecutive reverts)');
        return;
      }
    }

    // Auto-pause after max total runs
    if (analysis.total_runs >= this.config.max_runs_per_experiment) {
      pauseExperiment(experimentId);
      logger.info({ experimentId, totalRuns: analysis.total_runs },
        'Experiment auto-paused: max runs reached');
    }
  }

  /**
   * Get orchestrator status.
   */
  getStatus(): OrchestratorStatus {
    return {
      active_runs: this.activeRuns.size,
      queued_runs: this.runQueue.length,
      max_concurrent: this.config.max_concurrent_runs,
      metrics: getMetrics(),
    };
  }

  /**
   * Cancel all queued runs for an experiment.
   */
  cancelQueued(experimentId: string): number {
    const before = this.runQueue.length;
    this.runQueue = this.runQueue.filter(r => r.experimentId !== experimentId);
    return before - this.runQueue.length;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueuedRun {
  id: string;
  experimentId: string;
  agentId: string;
  variantDescription: string;
  currentContent: string;
  target: string;
  fitnessContext: FitnessContext;
  priority: AgentPriority;
  queuedAt: number;
}

interface ActiveRunState {
  queuedRun: QueuedRun;
  startedAt: number;
}

export interface RunResult {
  status: 'completed' | 'queued' | 'failed';
  runId?: string;
  decision?: 'keep' | 'revert';
  improvement?: number;
  fitnessScore?: number;
  mutation?: string;
  reason?: string;
}

export interface OrchestratorStatus {
  active_runs: number;
  queued_runs: number;
  max_concurrent: number;
  metrics: AutoresearchMetrics;
}
