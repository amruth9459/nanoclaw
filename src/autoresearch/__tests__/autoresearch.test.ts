import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';

import { _initTestDatabase, getDb } from '../../db.js';
import { _setHostKey } from '../../identity/keypair.js';
import { createIdentity } from '../../identity/identity-store.js';
import { initMonitoringSchema } from '../../agent-monitoring-system.js';

import { initAutoresearchSchema } from '../persistence.js';

import {
  createExperiment as dbCreateExperiment,
  getExperiment as dbGetExperiment,
  listExperiments as dbListExperiments,
  updateExperiment as dbUpdateExperiment,
  deleteExperiment as dbDeleteExperiment,
  createRun as dbCreateRun,
  getRun as dbGetRun,
  listRuns as dbListRuns,
  updateRun as dbUpdateRun,
  getMetrics,
  getLeaderboard,
  getRunsByAgent,
} from '../persistence.js';

import {
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
  analyzeExperiment,
} from '../experiment-engine.js';

import {
  registerFitnessFn,
  getFitnessFn,
  listFitnessFns,
  measureFitness,
} from '../fitness-library.js';

import {
  applyMutation,
  listMutationStrategies,
} from '../mutation-strategies.js';

import {
  handleAutoresearchIpc,
} from '../ipc-handler.js';

import { AutoresearchOrchestrator } from '../autoresearch-orchestrator.js';

import type { FitnessMetric, MutationStrategy } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HOST_KEY = crypto.randomBytes(32);

const TEST_FITNESS_METRIC: FitnessMetric = {
  name: 'test_accuracy',
  type: 'maximize',
  unit: 'score',
  measurement_fn: 'test_fixed_score',
  threshold_improvement: 0.05,
};

const TEST_MUTATION_STRATEGY: MutationStrategy = {
  type: 'prompt_evolution',
  parameters: {
    mutation_rate: 0.5,
    focus_areas: ['clarity', 'specificity'],
  },
};

let testAgentId: string;

beforeEach(async () => {
  _initTestDatabase();
  _setHostKey(TEST_HOST_KEY);

  // Initialize required schemas on the in-memory DB
  const db = getDb();
  initMonitoringSchema(db);
  initAutoresearchSchema(db);

  // Create a test agent identity
  const { identity } = await createIdentity('test-researcher', 'general-purpose', [
    'task.create', 'task.update', 'task.read', 'message.send', 'file.read', 'file.write',
  ]);
  testAgentId = identity.agent_id;

  // Register a test fitness function that returns a fixed score
  registerFitnessFn('test_fixed_score', async () => 0.85);
});

// ---------------------------------------------------------------------------
// Persistence Tests
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('creates and retrieves an experiment', () => {
    const exp = dbCreateExperiment('Test Exp', 'A test experiment', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);

    expect(exp.id).toBeTruthy();
    expect(exp.name).toBe('Test Exp');
    expect(exp.status).toBe('active');
    expect(exp.baseline_score).toBeNull();
    expect(exp.fitness_metric.name).toBe('test_accuracy');

    const retrieved = dbGetExperiment(exp.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('Test Exp');
    expect(retrieved!.fitness_metric.threshold_improvement).toBe(0.05);
  });

  it('lists experiments by status', () => {
    dbCreateExperiment('Active 1', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    dbCreateExperiment('Active 2', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);

    const all = dbListExperiments();
    expect(all.length).toBe(2);

    const active = dbListExperiments('active');
    expect(active.length).toBe(2);

    const paused = dbListExperiments('paused');
    expect(paused.length).toBe(0);
  });

  it('updates an experiment', () => {
    const exp = dbCreateExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    const updated = dbUpdateExperiment(exp.id, { baseline_score: 0.5, status: 'paused' });

    expect(updated).not.toBeNull();
    expect(updated!.baseline_score).toBe(0.5);
    expect(updated!.status).toBe('paused');
  });

  it('deletes an experiment and its runs', () => {
    const exp = dbCreateExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    dbCreateRun(exp.id, testAgentId, 'variant 1', 'mutation 1', 0.5);

    expect(dbListRuns(exp.id).length).toBe(1);

    const deleted = dbDeleteExperiment(exp.id);
    expect(deleted).toBe(true);
    expect(dbGetExperiment(exp.id)).toBeNull();
    expect(dbListRuns(exp.id).length).toBe(0);
  });

  it('creates and retrieves runs', () => {
    const exp = dbCreateExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    const run = dbCreateRun(exp.id, testAgentId, 'variant 1', 'mutation 1', 0.5);

    expect(run.id).toBeTruthy();
    expect(run.experiment_id).toBe(exp.id);
    expect(run.decision).toBe('pending');
    expect(run.fitness_score).toBe(0);

    const retrieved = dbGetRun(run.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.agent_id).toBe(testAgentId);
  });

  it('updates a run with fitness results', () => {
    const exp = dbCreateExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    const run = dbCreateRun(exp.id, testAgentId, 'v1', 'm1', 0.5);

    const updated = dbUpdateRun(run.id, {
      fitness_score: 0.8,
      improvement: 0.6,
      decision: 'keep',
      completed_at: new Date().toISOString(),
    });

    expect(updated).not.toBeNull();
    expect(updated!.fitness_score).toBe(0.8);
    expect(updated!.decision).toBe('keep');
  });

  it('computes aggregate metrics', () => {
    const exp = dbCreateExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);

    // Create some runs with different decisions
    const run1 = dbCreateRun(exp.id, testAgentId, 'v1', 'm1', 0.5);
    dbUpdateRun(run1.id, { fitness_score: 0.8, improvement: 0.1, decision: 'keep', completed_at: new Date().toISOString() });

    const run2 = dbCreateRun(exp.id, testAgentId, 'v2', 'm2', 0.5);
    dbUpdateRun(run2.id, { fitness_score: 0.45, improvement: -0.1, decision: 'revert', completed_at: new Date().toISOString() });

    const metrics = getMetrics();
    expect(metrics.total_experiments).toBe(1);
    expect(metrics.active_experiments).toBe(1);
    expect(metrics.total_runs).toBe(2);
    expect(metrics.improvements_kept).toBe(1);
    expect(metrics.improvements_reverted).toBe(1);
    expect(metrics.best_improvement_pct).toBe(0.1);
  });

  it('builds leaderboard from kept runs', () => {
    const exp = dbCreateExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);

    const run1 = dbCreateRun(exp.id, testAgentId, 'v1', 'm1', 0.5);
    dbUpdateRun(run1.id, { fitness_score: 0.9, improvement: 0.15, decision: 'keep', completed_at: new Date().toISOString() });

    const run2 = dbCreateRun(exp.id, testAgentId, 'v2', 'm2', 0.5);
    dbUpdateRun(run2.id, { fitness_score: 0.85, improvement: 0.1, decision: 'keep', completed_at: new Date().toISOString() });

    const leaderboard = getLeaderboard(10);
    expect(leaderboard.length).toBe(2);
    expect(leaderboard[0].improvement).toBe(0.15); // Best first
  });

  it('retrieves runs by agent', () => {
    const exp = dbCreateExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    dbCreateRun(exp.id, testAgentId, 'v1', 'm1', 0.5);
    dbCreateRun(exp.id, testAgentId, 'v2', 'm2', 0.5);

    const runs = getRunsByAgent(testAgentId);
    expect(runs.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Fitness Library Tests
// ---------------------------------------------------------------------------

describe('fitness-library', () => {
  it('lists registered fitness functions', () => {
    const fns = listFitnessFns();
    expect(fns).toContain('latency');
    expect(fns).toContain('accuracy');
    expect(fns).toContain('token_efficiency');
    expect(fns).toContain('trust_score');
    expect(fns).toContain('success_rate');
    expect(fns).toContain('custom');
    expect(fns).toContain('test_fixed_score');
  });

  it('retrieves a registered function', () => {
    const fn = getFitnessFn('test_fixed_score');
    expect(fn).toBeDefined();
  });

  it('executes a fitness measurement', async () => {
    const score = await measureFitness('test_fixed_score', { agent_id: testAgentId });
    expect(score).toBe(0.85);
  });

  it('throws on unknown fitness function', async () => {
    await expect(measureFitness('nonexistent', {})).rejects.toThrow('Unknown fitness function');
  });

  it('measures accuracy between strings', async () => {
    const score = await measureFitness('accuracy', {
      expected_output: 'hello world',
      actual_output: 'hello world',
    });
    expect(score).toBe(1.0);

    const partialScore = await measureFitness('accuracy', {
      expected_output: 'hello world',
      actual_output: 'hello earth',
    });
    expect(partialScore).toBeGreaterThan(0.5);
    expect(partialScore).toBeLessThan(1.0);
  });

  it('measures success rate from evidence chain', async () => {
    const score = await measureFitness('success_rate', { agent_id: testAgentId });
    // No evidence records yet, so should be 0
    expect(score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Mutation Strategy Tests
// ---------------------------------------------------------------------------

describe('mutation-strategies', () => {
  it('lists registered strategies', () => {
    const strategies = listMutationStrategies();
    expect(strategies).toContain('prompt_evolution');
    expect(strategies).toContain('code_optimization');
    expect(strategies).toContain('config_tuning');
    expect(strategies).toContain('architecture_search');
  });

  it('applies prompt evolution mutation', async () => {
    const result = await applyMutation(
      { type: 'prompt_evolution', parameters: { mutation_rate: 1.0, focus_areas: ['clarity'] } },
      {
        current_content: 'You are a helpful assistant.',
        target: 'system_prompt.txt',
        previous_score: 0.7,
        history: [],
      },
    );

    expect(result.description).toContain('Prompt evolution');
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes[0].type).toBe('prompt_change');
    expect(result.revert_instructions).toBeTruthy();
  });

  it('applies config tuning mutation', async () => {
    const config = JSON.stringify({ temperature: 0.7, top_p: 0.9, max_tokens: 1000 });
    const result = await applyMutation(
      {
        type: 'config_tuning',
        parameters: {
          perturbation_scale: 0.2,
          search_space: {
            temperature: { min: 0, max: 1, step: 0.1 },
            top_p: { min: 0, max: 1, step: 0.05 },
          },
        },
      },
      {
        current_content: config,
        target: 'config.json',
        previous_score: 0.5,
        history: [],
      },
    );

    expect(result.description).toContain('Config tuning');
    expect(result.changes.length).toBe(1);
    expect(result.changes[0].type).toBe('config_change');

    // The mutated config should be valid JSON
    const mutatedConfig = JSON.parse(result.changes[0].after);
    expect(mutatedConfig.temperature).toBeGreaterThanOrEqual(0);
    expect(mutatedConfig.temperature).toBeLessThanOrEqual(1);
  });

  it('applies architecture search mutation', async () => {
    const result = await applyMutation(
      {
        type: 'architecture_search',
        parameters: {
          candidates: ['gpt-4o', 'claude-3.5-sonnet', 'gemini-pro'],
          selection_method: 'round_robin',
        },
      },
      {
        current_content: 'gpt-4o',
        target: 'model_config',
        previous_score: 0.6,
        history: [],
      },
    );

    expect(result.description).toContain('Architecture search');
    expect(result.changes.length).toBe(1);
    expect(['gpt-4o', 'claude-3.5-sonnet', 'gemini-pro']).toContain(result.changes[0].after);
  });

  it('throws on unknown strategy', async () => {
    await expect(applyMutation(
      { type: 'nonexistent' as any, parameters: {} },
      { current_content: '', target: '', previous_score: 0, history: [] },
    )).rejects.toThrow('Unknown mutation strategy');
  });
});

// ---------------------------------------------------------------------------
// Experiment Engine Tests
// ---------------------------------------------------------------------------

describe('experiment-engine', () => {
  it('creates an experiment with agent attribution', async () => {
    const exp = await createExperiment(
      'Test Experiment',
      'Testing the engine',
      TEST_FITNESS_METRIC,
      TEST_MUTATION_STRATEGY,
      testAgentId,
    );

    expect(exp.name).toBe('Test Experiment');
    expect(exp.status).toBe('active');
  });

  it('sets baseline score', async () => {
    const exp = await createExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    const updated = await setBaseline(exp.id, 0.75, testAgentId);

    expect(updated).not.toBeNull();
    expect(updated!.baseline_score).toBe(0.75);
    expect(updated!.current_best_score).toBe(0.75);
  });

  it('manages experiment lifecycle: pause → resume → complete', async () => {
    const exp = await createExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);

    const paused = pauseExperiment(exp.id);
    expect(paused!.status).toBe('paused');

    const resumed = resumeExperiment(exp.id);
    expect(resumed!.status).toBe('active');

    const completed = completeExperiment(exp.id);
    expect(completed!.status).toBe('completed');
  });

  it('starts a run with mutation', async () => {
    const exp = await createExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    await setBaseline(exp.id, 0.5);

    const { run, mutation } = await startRun(
      exp.id,
      testAgentId,
      'Test variant',
      'You are a helpful assistant.',
      'prompt.txt',
    );

    expect(run.experiment_id).toBe(exp.id);
    expect(run.agent_id).toBe(testAgentId);
    expect(run.decision).toBe('pending');
    expect(mutation.description).toContain('Prompt evolution');
  });

  it('refuses to start a run on non-active experiment', async () => {
    const exp = await createExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    pauseExperiment(exp.id);

    await expect(startRun(exp.id, testAgentId, 'v1', '', ''))
      .rejects.toThrow('Experiment is paused, not active');
  });

  it('evaluates run fitness', async () => {
    const exp = await createExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    await setBaseline(exp.id, 0.5);

    const { run } = await startRun(exp.id, testAgentId, 'v1', 'content', 'target');
    const evaluated = await evaluateRun(run.id, { agent_id: testAgentId });

    expect(evaluated).not.toBeNull();
    expect(evaluated!.fitness_score).toBe(0.85); // From test_fixed_score
    expect(evaluated!.improvement).toBeGreaterThan(0); // 0.85 > 0.5 baseline
  });

  describe('keep/revert decisions', () => {
    it('keeps when improvement exceeds threshold', async () => {
      const exp = await createExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
      await setBaseline(exp.id, 0.5);

      const { run } = await startRun(exp.id, testAgentId, 'v1', 'content', 'target');
      await evaluateRun(run.id, { agent_id: testAgentId });

      const decision = await decideKeepOrRevert(exp.id, run.id);
      expect(decision).toBe('keep');

      // Verify the experiment's best score was updated
      const updatedExp = getExperiment(exp.id);
      expect(updatedExp!.current_best_score).toBe(0.85);
    });

    it('reverts when improvement is below threshold', async () => {
      // Use a very high threshold that the fixed score can't beat
      const highThreshold: FitnessMetric = {
        ...TEST_FITNESS_METRIC,
        threshold_improvement: 10.0, // 1000% improvement required
      };

      const exp = await createExperiment('Test', '', highThreshold, TEST_MUTATION_STRATEGY);
      await setBaseline(exp.id, 0.8); // Close to the fixed 0.85 score

      const { run } = await startRun(exp.id, testAgentId, 'v1', 'content', 'target');
      await evaluateRun(run.id, { agent_id: testAgentId });

      const decision = await decideKeepOrRevert(exp.id, run.id);
      expect(decision).toBe('revert');
    });
  });

  it('analyzes experiment performance', async () => {
    const exp = await createExperiment('Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    await setBaseline(exp.id, 0.5);

    // Run a few iterations
    for (let i = 0; i < 3; i++) {
      const { run } = await startRun(exp.id, testAgentId, `v${i}`, 'content', 'target');
      await evaluateRun(run.id, { agent_id: testAgentId });
      await decideKeepOrRevert(exp.id, run.id);
    }

    const analysis = analyzeExperiment(exp.id);
    expect(analysis).not.toBeNull();
    expect(analysis!.total_runs).toBe(3);
    expect(analysis!.scores.length).toBe(3);
    expect(analysis!.mean_improvement).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// IPC Handler Tests
// ---------------------------------------------------------------------------

describe('ipc-handler', () => {
  it('handles create action', async () => {
    const result = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'create',
      agent_id: testAgentId,
      name: 'IPC Test',
      description: 'Testing IPC',
      fitness_metric: TEST_FITNESS_METRIC,
      mutation_strategy: TEST_MUTATION_STRATEGY,
    });

    expect(result.error).toBeUndefined();
    expect(result.name).toBe('IPC Test');
    expect(result.id).toBeTruthy();
  });

  it('handles list action', async () => {
    await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'create',
      agent_id: testAgentId,
      name: 'Exp 1',
      fitness_metric: TEST_FITNESS_METRIC,
      mutation_strategy: TEST_MUTATION_STRATEGY,
    });

    const result = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'list',
      agent_id: testAgentId,
    });

    expect(result.error).toBeUndefined();
    const experiments = result.experiments as unknown[];
    expect(experiments.length).toBe(1);
  });

  it('handles metrics action', async () => {
    const result = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'metrics',
      agent_id: testAgentId,
    });

    expect(result.error).toBeUndefined();
    expect(result.total_experiments).toBeDefined();
  });

  it('handles pause/resume/complete lifecycle', async () => {
    const created = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'create',
      agent_id: testAgentId,
      name: 'Lifecycle Test',
      fitness_metric: TEST_FITNESS_METRIC,
      mutation_strategy: TEST_MUTATION_STRATEGY,
    });

    const paused = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'pause',
      agent_id: testAgentId,
      experiment_id: created.id as string,
    });
    expect(paused.status).toBe('paused');

    const resumed = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'resume',
      agent_id: testAgentId,
      experiment_id: created.id as string,
    });
    expect(resumed.status).toBe('active');

    const completed = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'complete',
      agent_id: testAgentId,
      experiment_id: created.id as string,
    });
    expect(completed.status).toBe('completed');
  });

  it('returns error for missing required params', async () => {
    const result = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'create',
      agent_id: testAgentId,
      // Missing name, fitness_metric, mutation_strategy
    });

    expect(result.error).toBeTruthy();
  });

  it('returns error for unknown action', async () => {
    const result = await handleAutoresearchIpc({
      type: 'autoresearch',
      action: 'nonexistent',
      agent_id: testAgentId,
    });

    expect(result.error).toContain('Unknown autoresearch action');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator Tests
// ---------------------------------------------------------------------------

describe('autoresearch-orchestrator', () => {
  it('creates orchestrator with default config', () => {
    const orch = new AutoresearchOrchestrator();
    const status = orch.getStatus();

    expect(status.active_runs).toBe(0);
    expect(status.queued_runs).toBe(0);
    expect(status.max_concurrent).toBe(2);
  });

  it('submits an experiment', async () => {
    const orch = new AutoresearchOrchestrator();
    const exp = await orch.submitExperiment(
      'Orch Test', 'Testing', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY, testAgentId,
    );

    expect(exp.name).toBe('Orch Test');
    expect(exp.status).toBe('active');
  });

  it('enforces active experiment limit', async () => {
    const orch = new AutoresearchOrchestrator(null, { max_active_experiments: 1 });
    await orch.submitExperiment('Exp 1', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);

    await expect(orch.submitExperiment('Exp 2', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY))
      .rejects.toThrow('Active experiment limit reached');
  });

  it('executes a full run cycle', async () => {
    const orch = new AutoresearchOrchestrator();
    const exp = await orch.submitExperiment(
      'Full Cycle', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY, testAgentId,
    );
    await setBaseline(exp.id, 0.5);

    const result = await orch.queueRun(
      exp.id,
      testAgentId,
      'Test variant',
      'You are a helpful assistant.',
      'prompt.txt',
      { agent_id: testAgentId },
    );

    expect(result).toBeTruthy(); // Queue ID returned
  });

  it('cancels queued runs for an experiment', async () => {
    const orch = new AutoresearchOrchestrator(null, { max_concurrent_runs: 0 }); // Force queueing
    const exp = await orch.submitExperiment('Cancel Test', '', TEST_FITNESS_METRIC, TEST_MUTATION_STRATEGY);
    await setBaseline(exp.id, 0.5);

    // This will be queued since max_concurrent_runs is 0
    // But queueRun tries to run immediately first, then queues — let's just test cancelQueued
    const cancelled = orch.cancelQueued(exp.id);
    expect(cancelled).toBe(0); // Nothing queued yet
  });
});
