/**
 * GSD Database — Schema and CRUD operations
 *
 * Uses the existing better-sqlite3 db from src/db.ts.
 * Tables are created lazily on first access.
 */

import Database from 'better-sqlite3';
import { getDb } from '../db.js';
import type {
  GsdSpecRow,
  GsdCheckpointRow,
  GsdDriftAlertRow,
  Spec,
  Checkpoint,
  DriftAlert,
  DriftSeverity,
  SpecFrontmatter,
} from './types.js';

let initialized = false;

export function initGsdSchema(database?: Database.Database): void {
  const db = database ?? getDb();
  if (!db) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS gsd_specs (
      spec_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      goal TEXT NOT NULL,
      frontmatter_json TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gsd_specs_status ON gsd_specs(status);
    CREATE INDEX IF NOT EXISTS idx_gsd_specs_project ON gsd_specs(project_path);

    CREATE TABLE IF NOT EXISTS gsd_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'unknown',
      summary TEXT NOT NULL,
      completed_json TEXT NOT NULL DEFAULT '[]',
      next_json TEXT NOT NULL DEFAULT '[]',
      blockers_json TEXT NOT NULL DEFAULT '[]',
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (spec_id) REFERENCES gsd_specs(spec_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gsd_checkpoints_spec ON gsd_checkpoints(spec_id);
    CREATE INDEX IF NOT EXISTS idx_gsd_checkpoints_time ON gsd_checkpoints(timestamp);

    CREATE TABLE IF NOT EXISTS gsd_drift_alerts (
      alert_id TEXT PRIMARY KEY,
      spec_id TEXT NOT NULL,
      drift_description TEXT NOT NULL,
      task_description TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'medium',
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (spec_id) REFERENCES gsd_specs(spec_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gsd_drift_spec ON gsd_drift_alerts(spec_id);
  `);

  initialized = true;
}

function ensureInit(): Database.Database {
  const db = getDb();
  if (!initialized) initGsdSchema(db);
  return db;
}

// ── Spec CRUD ───────────────────────────────────────────────────────────────────

function rowToSpec(row: GsdSpecRow): Spec {
  const frontmatter: SpecFrontmatter = JSON.parse(row.frontmatter_json);
  // Parse phases from markdown body
  const phases = parsePhases(row.body);
  return {
    id: row.spec_id,
    projectPath: row.project_path,
    frontmatter,
    body: row.body,
    phases,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status as Spec['status'],
  };
}

export function createSpec(spec: {
  id: string;
  projectPath: string;
  frontmatter: SpecFrontmatter;
  body: string;
}): Spec {
  const db = ensureInit();
  const now = Date.now();
  db.prepare(`
    INSERT INTO gsd_specs (spec_id, project_path, goal, frontmatter_json, body, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(
    spec.id,
    spec.projectPath,
    spec.frontmatter.goal,
    JSON.stringify(spec.frontmatter),
    spec.body,
    now,
    now,
  );
  return getSpec(spec.id)!;
}

export function getSpec(specId: string): Spec | null {
  const db = ensureInit();
  const row = db.prepare('SELECT * FROM gsd_specs WHERE spec_id = ?').get(specId) as GsdSpecRow | undefined;
  return row ? rowToSpec(row) : null;
}

export function getSpecByProject(projectPath: string): Spec | null {
  const db = ensureInit();
  const row = db.prepare(
    'SELECT * FROM gsd_specs WHERE project_path = ? AND status = ? ORDER BY updated_at DESC LIMIT 1',
  ).get(projectPath, 'active') as GsdSpecRow | undefined;
  return row ? rowToSpec(row) : null;
}

export function listSpecs(status?: string): Spec[] {
  const db = ensureInit();
  const sql = status
    ? 'SELECT * FROM gsd_specs WHERE status = ? ORDER BY updated_at DESC'
    : 'SELECT * FROM gsd_specs ORDER BY updated_at DESC';
  const rows = (status ? db.prepare(sql).all(status) : db.prepare(sql).all()) as GsdSpecRow[];
  return rows.map(rowToSpec);
}

export function updateSpec(specId: string, updates: {
  frontmatter?: SpecFrontmatter;
  body?: string;
  status?: Spec['status'];
}): Spec | null {
  const db = ensureInit();
  const existing = getSpec(specId);
  if (!existing) return null;

  const now = Date.now();
  if (updates.frontmatter) {
    db.prepare('UPDATE gsd_specs SET frontmatter_json = ?, goal = ?, updated_at = ? WHERE spec_id = ?')
      .run(JSON.stringify(updates.frontmatter), updates.frontmatter.goal, now, specId);
  }
  if (updates.body !== undefined) {
    db.prepare('UPDATE gsd_specs SET body = ?, updated_at = ? WHERE spec_id = ?')
      .run(updates.body, now, specId);
  }
  if (updates.status) {
    db.prepare('UPDATE gsd_specs SET status = ?, updated_at = ? WHERE spec_id = ?')
      .run(updates.status, now, specId);
  }
  return getSpec(specId);
}

export function deleteSpec(specId: string): boolean {
  const db = ensureInit();
  const result = db.prepare('DELETE FROM gsd_specs WHERE spec_id = ?').run(specId);
  return result.changes > 0;
}

// ── Checkpoint CRUD ─────────────────────────────────────────────────────────────

function rowToCheckpoint(row: GsdCheckpointRow): Checkpoint {
  return {
    id: row.checkpoint_id,
    specId: row.spec_id,
    agentId: row.agent_id,
    summary: row.summary,
    completedItems: JSON.parse(row.completed_json),
    nextItems: JSON.parse(row.next_json),
    blockers: JSON.parse(row.blockers_json),
    timestamp: row.timestamp,
  };
}

export function createCheckpoint(checkpoint: {
  specId: string;
  agentId: string;
  summary: string;
  completedItems?: string[];
  nextItems?: string[];
  blockers?: string[];
}): Checkpoint {
  const db = ensureInit();
  const id = `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO gsd_checkpoints (checkpoint_id, spec_id, agent_id, summary, completed_json, next_json, blockers_json, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    checkpoint.specId,
    checkpoint.agentId,
    checkpoint.summary,
    JSON.stringify(checkpoint.completedItems ?? []),
    JSON.stringify(checkpoint.nextItems ?? []),
    JSON.stringify(checkpoint.blockers ?? []),
    now,
  );
  return getCheckpoint(id)!;
}

export function getCheckpoint(checkpointId: string): Checkpoint | null {
  const db = ensureInit();
  const row = db.prepare('SELECT * FROM gsd_checkpoints WHERE checkpoint_id = ?').get(checkpointId) as GsdCheckpointRow | undefined;
  return row ? rowToCheckpoint(row) : null;
}

export function getLatestCheckpoint(specId: string): Checkpoint | null {
  const db = ensureInit();
  const row = db.prepare(
    'SELECT * FROM gsd_checkpoints WHERE spec_id = ? ORDER BY timestamp DESC LIMIT 1',
  ).get(specId) as GsdCheckpointRow | undefined;
  return row ? rowToCheckpoint(row) : null;
}

export function getCheckpoints(specId: string, limit = 20): Checkpoint[] {
  const db = ensureInit();
  const rows = db.prepare(
    'SELECT * FROM gsd_checkpoints WHERE spec_id = ? ORDER BY timestamp DESC LIMIT ?',
  ).all(specId, limit) as GsdCheckpointRow[];
  return rows.map(rowToCheckpoint);
}

// ── Drift Alert CRUD ────────────────────────────────────────────────────────────

function rowToDriftAlert(row: GsdDriftAlertRow): DriftAlert {
  return {
    id: row.alert_id,
    specId: row.spec_id,
    description: row.drift_description,
    taskDescription: row.task_description,
    severity: row.severity as DriftSeverity,
    timestamp: row.timestamp,
  };
}

export function createDriftAlert(alert: {
  specId: string;
  description: string;
  taskDescription: string;
  severity: DriftSeverity;
}): DriftAlert {
  const db = ensureInit();
  const id = `drift_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`
    INSERT INTO gsd_drift_alerts (alert_id, spec_id, drift_description, task_description, severity, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, alert.specId, alert.description, alert.taskDescription, alert.severity, now);
  return getDriftAlert(id)!;
}

export function getDriftAlert(alertId: string): DriftAlert | null {
  const db = ensureInit();
  const row = db.prepare('SELECT * FROM gsd_drift_alerts WHERE alert_id = ?').get(alertId) as GsdDriftAlertRow | undefined;
  return row ? rowToDriftAlert(row) : null;
}

export function getDriftAlerts(specId: string, limit = 20): DriftAlert[] {
  const db = ensureInit();
  const rows = db.prepare(
    'SELECT * FROM gsd_drift_alerts WHERE spec_id = ? ORDER BY timestamp DESC LIMIT ?',
  ).all(specId, limit) as GsdDriftAlertRow[];
  return rows.map(rowToDriftAlert);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Parse markdown body for phase/checklist items */
export function parsePhases(body: string): Spec['phases'] {
  const phases: Spec['phases'] = [];
  let currentPhase: Spec['phases'][number] | null = null;

  for (const line of body.split('\n')) {
    // Match "### Phase N: Name" or "### Phase Name"
    const phaseMatch = line.match(/^###\s+(?:Phase\s+\d+[:\s]*)?(.+)/);
    if (phaseMatch) {
      currentPhase = { name: phaseMatch[1].trim(), items: [] };
      phases.push(currentPhase);
      continue;
    }

    // Match checklist items: "- [ ] text" or "- [x] text"
    const checkMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)/);
    if (checkMatch && currentPhase) {
      currentPhase.items.push({
        done: checkMatch[1].toLowerCase() === 'x',
        text: checkMatch[2].trim(),
      });
    }
  }

  return phases;
}

/** Toggle a checklist item in markdown body by matching text */
export function toggleChecklistItem(body: string, itemText: string, done: boolean): string {
  const mark = done ? 'x' : ' ';
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([-*]\s+\[)[ xX](\]\s+)(.+)/);
    if (m && m[3].trim() === itemText.trim()) {
      lines[i] = `${m[1]}${mark}${m[2]}${m[3]}`;
      break;
    }
  }
  return lines.join('\n');
}
