/**
 * Autoresearch persistence layer.
 *
 * SQLite schema and CRUD operations for experiments and runs.
 * Uses the shared database from db.ts.
 */
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { getDb } from '../db.js';
import type {
  ExperimentConfig,
  ExperimentRun,
  ExperimentRow,
  ExperimentRunRow,
  ExperimentStatus,
  AutoresearchMetrics,
  LeaderboardEntry,
  FitnessMetric,
  MutationStrategy,
  RunDecision,
  RunEvidence,
} from './types.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initAutoresearchSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      fitness_metric TEXT NOT NULL,
      baseline_score REAL,
      current_best_score REAL,
      mutation_strategy TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS experiment_runs (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      variant_description TEXT,
      mutation_applied TEXT,
      fitness_score REAL NOT NULL,
      baseline_score REAL NOT NULL,
      improvement REAL NOT NULL,
      decision TEXT NOT NULL DEFAULT 'pending',
      evidence TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      agent_id TEXT NOT NULL,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_experiment_runs_score
      ON experiment_runs(experiment_id, fitness_score DESC);
    CREATE INDEX IF NOT EXISTS idx_experiment_runs_decision
      ON experiment_runs(decision, experiment_id);
    CREATE INDEX IF NOT EXISTS idx_experiment_runs_agent
      ON experiment_runs(agent_id);
  `);
}

// ---------------------------------------------------------------------------
// Row ↔ Object Conversion
// ---------------------------------------------------------------------------

function rowToExperiment(row: ExperimentRow): ExperimentConfig {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    fitness_metric: JSON.parse(row.fitness_metric) as FitnessMetric,
    baseline_score: row.baseline_score,
    current_best_score: row.current_best_score,
    mutation_strategy: JSON.parse(row.mutation_strategy) as MutationStrategy,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status as ExperimentStatus,
  };
}

function rowToRun(row: ExperimentRunRow): ExperimentRun {
  return {
    id: row.id,
    experiment_id: row.experiment_id,
    variant_description: row.variant_description,
    mutation_applied: row.mutation_applied,
    fitness_score: row.fitness_score,
    baseline_score: row.baseline_score,
    improvement: row.improvement,
    decision: row.decision as RunDecision,
    evidence: JSON.parse(row.evidence) as RunEvidence,
    started_at: row.started_at,
    completed_at: row.completed_at,
    agent_id: row.agent_id,
  };
}

// ---------------------------------------------------------------------------
// Experiment CRUD
// ---------------------------------------------------------------------------

export function createExperiment(
  name: string,
  description: string,
  fitnessMetric: FitnessMetric,
  mutationStrategy: MutationStrategy,
): ExperimentConfig {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const experiment: ExperimentConfig = {
    id,
    name,
    description,
    fitness_metric: fitnessMetric,
    baseline_score: null,
    current_best_score: null,
    mutation_strategy: mutationStrategy,
    created_at: now,
    updated_at: now,
    status: 'active',
  };

  db.prepare(`
    INSERT INTO experiments (id, name, description, fitness_metric, baseline_score,
      current_best_score, mutation_strategy, created_at, updated_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    experiment.id,
    experiment.name,
    experiment.description,
    JSON.stringify(experiment.fitness_metric),
    experiment.baseline_score,
    experiment.current_best_score,
    JSON.stringify(experiment.mutation_strategy),
    experiment.created_at,
    experiment.updated_at,
    experiment.status,
  );

  return experiment;
}

export function getExperiment(id: string): ExperimentConfig | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as ExperimentRow | undefined;
  return row ? rowToExperiment(row) : null;
}

export function listExperiments(status?: ExperimentStatus): ExperimentConfig[] {
  const db = getDb();
  if (status) {
    const rows = db.prepare('SELECT * FROM experiments WHERE status = ? ORDER BY updated_at DESC')
      .all(status) as ExperimentRow[];
    return rows.map(rowToExperiment);
  }
  const rows = db.prepare('SELECT * FROM experiments ORDER BY updated_at DESC')
    .all() as ExperimentRow[];
  return rows.map(rowToExperiment);
}

export function updateExperiment(
  id: string,
  updates: Partial<Pick<ExperimentConfig, 'baseline_score' | 'current_best_score' | 'status' | 'name' | 'description'>>,
): ExperimentConfig | null {
  const db = getDb();
  const experiment = getExperiment(id);
  if (!experiment) return null;

  const setClauses: string[] = ['updated_at = ?'];
  const values: unknown[] = [new Date().toISOString()];

  if (updates.baseline_score !== undefined) {
    setClauses.push('baseline_score = ?');
    values.push(updates.baseline_score);
  }
  if (updates.current_best_score !== undefined) {
    setClauses.push('current_best_score = ?');
    values.push(updates.current_best_score);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    values.push(updates.status);
  }
  if (updates.name !== undefined) {
    setClauses.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    setClauses.push('description = ?');
    values.push(updates.description);
  }

  values.push(id);
  db.prepare(`UPDATE experiments SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  return getExperiment(id);
}

export function deleteExperiment(id: string): boolean {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM experiments WHERE id = ?').get(id);
  if (!exists) return false;

  // Delete runs first to satisfy FK constraint
  db.prepare('DELETE FROM experiment_runs WHERE experiment_id = ?').run(id);
  db.prepare('DELETE FROM experiments WHERE id = ?').run(id);
  return true;
}

// ---------------------------------------------------------------------------
// Run CRUD
// ---------------------------------------------------------------------------

export function createRun(
  experimentId: string,
  agentId: string,
  variantDescription: string,
  mutationApplied: string,
  baselineScore: number,
): ExperimentRun {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const run: ExperimentRun = {
    id,
    experiment_id: experimentId,
    variant_description: variantDescription,
    mutation_applied: mutationApplied,
    fitness_score: 0,
    baseline_score: baselineScore,
    improvement: 0,
    decision: 'pending',
    evidence: { measurements: {} },
    started_at: now,
    completed_at: null,
    agent_id: agentId,
  };

  db.prepare(`
    INSERT INTO experiment_runs (id, experiment_id, variant_description, mutation_applied,
      fitness_score, baseline_score, improvement, decision, evidence, started_at, completed_at, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.experiment_id,
    run.variant_description,
    run.mutation_applied,
    run.fitness_score,
    run.baseline_score,
    run.improvement,
    run.decision,
    JSON.stringify(run.evidence),
    run.started_at,
    run.completed_at,
    run.agent_id,
  );

  return run;
}

export function getRun(id: string): ExperimentRun | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM experiment_runs WHERE id = ?').get(id) as ExperimentRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function listRuns(experimentId: string, decision?: RunDecision): ExperimentRun[] {
  const db = getDb();
  if (decision) {
    const rows = db.prepare(
      'SELECT * FROM experiment_runs WHERE experiment_id = ? AND decision = ? ORDER BY fitness_score DESC'
    ).all(experimentId, decision) as ExperimentRunRow[];
    return rows.map(rowToRun);
  }
  const rows = db.prepare(
    'SELECT * FROM experiment_runs WHERE experiment_id = ? ORDER BY fitness_score DESC'
  ).all(experimentId) as ExperimentRunRow[];
  return rows.map(rowToRun);
}

export function updateRun(
  id: string,
  updates: Partial<Pick<ExperimentRun, 'fitness_score' | 'improvement' | 'decision' | 'evidence' | 'completed_at'>>,
): ExperimentRun | null {
  const db = getDb();
  const run = getRun(id);
  if (!run) return null;

  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.fitness_score !== undefined) {
    setClauses.push('fitness_score = ?');
    values.push(updates.fitness_score);
  }
  if (updates.improvement !== undefined) {
    setClauses.push('improvement = ?');
    values.push(updates.improvement);
  }
  if (updates.decision !== undefined) {
    setClauses.push('decision = ?');
    values.push(updates.decision);
  }
  if (updates.evidence !== undefined) {
    setClauses.push('evidence = ?');
    values.push(JSON.stringify(updates.evidence));
  }
  if (updates.completed_at !== undefined) {
    setClauses.push('completed_at = ?');
    values.push(updates.completed_at);
  }

  if (setClauses.length === 0) return run;

  values.push(id);
  db.prepare(`UPDATE experiment_runs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  return getRun(id);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function getMetrics(): AutoresearchMetrics {
  const db = getDb();

  const totalExperiments = (db.prepare('SELECT COUNT(*) as cnt FROM experiments').get() as { cnt: number }).cnt;
  const activeExperiments = (db.prepare(
    "SELECT COUNT(*) as cnt FROM experiments WHERE status = 'active'"
  ).get() as { cnt: number }).cnt;
  const totalRuns = (db.prepare('SELECT COUNT(*) as cnt FROM experiment_runs').get() as { cnt: number }).cnt;
  const kept = (db.prepare(
    "SELECT COUNT(*) as cnt FROM experiment_runs WHERE decision = 'keep'"
  ).get() as { cnt: number }).cnt;
  const reverted = (db.prepare(
    "SELECT COUNT(*) as cnt FROM experiment_runs WHERE decision = 'revert'"
  ).get() as { cnt: number }).cnt;

  const bestRow = db.prepare(
    "SELECT MAX(improvement) as best FROM experiment_runs WHERE decision = 'keep'"
  ).get() as { best: number | null };
  const avgRow = db.prepare(
    "SELECT AVG(improvement) as avg FROM experiment_runs WHERE decision = 'keep'"
  ).get() as { avg: number | null };

  return {
    total_experiments: totalExperiments,
    active_experiments: activeExperiments,
    total_runs: totalRuns,
    improvements_kept: kept,
    improvements_reverted: reverted,
    best_improvement_pct: bestRow.best ?? 0,
    avg_improvement_pct: avgRow.avg ?? 0,
  };
}

export function getLeaderboard(limit: number = 10): LeaderboardEntry[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT r.experiment_id, e.name as experiment_name, r.id as run_id,
           r.fitness_score, r.improvement, r.agent_id, r.completed_at
    FROM experiment_runs r
    JOIN experiments e ON r.experiment_id = e.id
    WHERE r.decision = 'keep'
    ORDER BY r.improvement DESC
    LIMIT ?
  `).all(limit) as LeaderboardEntry[];

  return rows;
}

export function getRunsByAgent(agentId: string): ExperimentRun[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM experiment_runs WHERE agent_id = ? ORDER BY started_at DESC'
  ).all(agentId) as ExperimentRunRow[];
  return rows.map(rowToRun);
}
