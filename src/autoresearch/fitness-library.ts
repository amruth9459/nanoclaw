/**
 * Fitness Library — Standard measurement functions for autoresearch experiments.
 *
 * Each fitness function measures a specific aspect of system performance,
 * returning a numeric score. Functions are registered by name so experiments
 * can reference them in their FitnessMetric.measurement_fn field.
 */
import { getDb } from '../db.js';
import { computeTrustScore } from '../identity/index.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Fitness Function Type
// ---------------------------------------------------------------------------

export type FitnessFn = (context: FitnessContext) => Promise<number>;

export interface FitnessContext {
  /** ID of the task being evaluated. */
  task_id?: string;
  /** ID of the agent running the experiment. */
  agent_id?: string;
  /** Expected output for accuracy comparisons. */
  expected_output?: string;
  /** Actual output produced. */
  actual_output?: string;
  /** Additional parameters for the measurement. */
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, FitnessFn>();

export function registerFitnessFn(name: string, fn: FitnessFn): void {
  registry.set(name, fn);
}

export function getFitnessFn(name: string): FitnessFn | undefined {
  return registry.get(name);
}

export function listFitnessFns(): string[] {
  return Array.from(registry.keys());
}

/**
 * Execute a named fitness function. Throws if the function is not registered.
 */
export async function measureFitness(name: string, context: FitnessContext): Promise<number> {
  const fn = registry.get(name);
  if (!fn) {
    throw new Error(`Unknown fitness function: ${name}. Available: ${listFitnessFns().join(', ')}`);
  }
  try {
    return await fn(context);
  } catch (err) {
    logger.error({ err, fitnessFn: name }, 'Fitness measurement failed');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Built-in Fitness Functions
// ---------------------------------------------------------------------------

/**
 * Measure agent task latency (average turn time in ms).
 * Queries the usage_logs table for the given task or agent.
 */
registerFitnessFn('latency', async (ctx: FitnessContext): Promise<number> => {
  const db = getDb();
  const agentId = ctx.agent_id;

  if (!agentId) {
    throw new Error('latency measurement requires agent_id');
  }

  // Get average response time from usage logs for this agent
  const row = db.prepare(`
    SELECT AVG(duration_ms) as avg_latency
    FROM usage_logs
    WHERE group_folder = ?
    AND timestamp >= datetime('now', '-1 hour')
  `).get(agentId) as { avg_latency: number | null } | undefined;

  return row?.avg_latency ?? 0;
});

/**
 * Measure accuracy: simple string similarity between expected and actual output.
 * Returns a score from 0.0 (no match) to 1.0 (exact match).
 */
registerFitnessFn('accuracy', async (ctx: FitnessContext): Promise<number> => {
  const { expected_output, actual_output } = ctx;
  if (!expected_output || !actual_output) {
    throw new Error('accuracy measurement requires expected_output and actual_output');
  }

  // Normalized Levenshtein distance as a simple accuracy metric
  const maxLen = Math.max(expected_output.length, actual_output.length);
  if (maxLen === 0) return 1.0;

  const distance = levenshteinDistance(expected_output, actual_output);
  return 1.0 - (distance / maxLen);
});

/**
 * Measure token efficiency: cost per task in terms of token usage.
 * Lower is better — returns total tokens used.
 */
registerFitnessFn('token_efficiency', async (ctx: FitnessContext): Promise<number> => {
  const db = getDb();
  const agentId = ctx.agent_id;

  if (!agentId) {
    throw new Error('token_efficiency measurement requires agent_id');
  }

  const row = db.prepare(`
    SELECT SUM(input_tokens + output_tokens) as total_tokens
    FROM usage_logs
    WHERE group_folder = ?
    AND timestamp >= datetime('now', '-1 hour')
  `).get(agentId) as { total_tokens: number | null } | undefined;

  return row?.total_tokens ?? 0;
});

/**
 * Measure trust score for an agent. Uses the existing identity trust scoring.
 * Returns score from 0.0 to 1.0.
 */
registerFitnessFn('trust_score', async (ctx: FitnessContext): Promise<number> => {
  const agentId = ctx.agent_id;
  if (!agentId) {
    throw new Error('trust_score measurement requires agent_id');
  }

  const trustScore = await computeTrustScore(agentId);
  return trustScore.score;
});

/**
 * Measure success rate from evidence chain outcomes.
 * Returns ratio of successful outcomes (0.0 to 1.0).
 */
registerFitnessFn('success_rate', async (ctx: FitnessContext): Promise<number> => {
  const db = getDb();
  const agentId = ctx.agent_id;

  if (!agentId) {
    throw new Error('success_rate measurement requires agent_id');
  }

  const total = (db.prepare(
    'SELECT COUNT(*) as cnt FROM evidence_chain WHERE agent_id = ?'
  ).get(agentId) as { cnt: number }).cnt;

  if (total === 0) return 0;

  const succeeded = (db.prepare(
    `SELECT COUNT(*) as cnt FROM evidence_chain WHERE agent_id = ? AND json_extract(outcome, '$.success') = 1`
  ).get(agentId) as { cnt: number }).cnt;

  return succeeded / total;
});

/**
 * Custom metric: delegates to a user-provided function name in params.
 * The params.eval_script should contain a function body that returns a number.
 */
registerFitnessFn('custom', async (ctx: FitnessContext): Promise<number> => {
  const evalScript = ctx.params?.eval_script as string | undefined;
  if (!evalScript) {
    throw new Error('custom measurement requires params.eval_script');
  }

  // Execute the eval script in a constrained context
  // The script receives `context` and must return a number
  const fn = new Function('context', evalScript) as (context: FitnessContext) => number;
  const result = fn(ctx);
  if (typeof result !== 'number' || isNaN(result)) {
    throw new Error('Custom fitness function must return a number');
  }
  return result;
});

// ---------------------------------------------------------------------------
// Helper: Levenshtein Distance
// ---------------------------------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use two-row optimization for memory efficiency
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}
