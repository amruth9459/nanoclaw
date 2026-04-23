/**
 * Competitive Intelligence persistence layer.
 *
 * SQLite schema and CRUD for intel checks audit trail.
 * Uses the shared database from db.ts.
 */
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { getDb } from '../db.js';
import type {
  IntelCheck,
  IntelCheckRow,
  CompetitorSignal,
  SignalSeverity,
} from './types.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function initCompetitiveIntelSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS competitive_intel_checks (
      id TEXT PRIMARY KEY,
      competitor TEXT NOT NULL,
      check_type TEXT NOT NULL,
      signals_found TEXT NOT NULL,
      signal_count INTEGER NOT NULL DEFAULT 0,
      max_severity TEXT NOT NULL DEFAULT 'LOW',
      report TEXT NOT NULL DEFAULT '',
      alert_sent INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intel_checks_competitor
      ON competitive_intel_checks(competitor, checked_at DESC);
    CREATE INDEX IF NOT EXISTS idx_intel_checks_severity
      ON competitive_intel_checks(max_severity);
  `);
}

// ---------------------------------------------------------------------------
// Row ↔ Object Conversion
// ---------------------------------------------------------------------------

function rowToCheck(row: IntelCheckRow): IntelCheck {
  return {
    id: row.id,
    competitor: row.competitor,
    check_type: row.check_type as IntelCheck['check_type'],
    signals_found: JSON.parse(row.signals_found) as CompetitorSignal[],
    signal_count: row.signal_count,
    max_severity: row.max_severity as SignalSeverity,
    report: row.report,
    alert_sent: row.alert_sent === 1,
    checked_at: row.checked_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function logIntelCheck(params: {
  competitor: string;
  check_type: IntelCheck['check_type'];
  signals: CompetitorSignal[];
  max_severity: SignalSeverity;
  report: string;
  alert_sent: boolean;
}): IntelCheck {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO competitive_intel_checks
      (id, competitor, check_type, signals_found, signal_count, max_severity, report, alert_sent, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.competitor,
    params.check_type,
    JSON.stringify(params.signals),
    params.signals.length,
    params.max_severity,
    params.report,
    params.alert_sent ? 1 : 0,
    now,
  );

  return {
    id,
    competitor: params.competitor,
    check_type: params.check_type,
    signals_found: params.signals,
    signal_count: params.signals.length,
    max_severity: params.max_severity,
    report: params.report,
    alert_sent: params.alert_sent,
    checked_at: now,
  };
}

export function getIntelChecks(
  competitor: string,
  limit: number = 10,
): IntelCheck[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM competitive_intel_checks WHERE competitor = ? ORDER BY checked_at DESC, rowid DESC LIMIT ?',
  ).all(competitor, limit) as IntelCheckRow[];
  return rows.map(rowToCheck);
}

export function getLatestIntelCheck(
  competitor: string,
): IntelCheck | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM competitive_intel_checks WHERE competitor = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1',
  ).get(competitor) as IntelCheckRow | undefined;
  return row ? rowToCheck(row) : null;
}

export function getIntelCheckById(id: string): IntelCheck | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM competitive_intel_checks WHERE id = ?',
  ).get(id) as IntelCheckRow | undefined;
  return row ? rowToCheck(row) : null;
}

export function getIntelStats(): {
  total_checks: number;
  checks_with_signals: number;
  alerts_sent: number;
  latest_check: string | null;
} {
  const db = getDb();
  const total = (db.prepare(
    'SELECT COUNT(*) as cnt FROM competitive_intel_checks',
  ).get() as { cnt: number }).cnt;
  const withSignals = (db.prepare(
    'SELECT COUNT(*) as cnt FROM competitive_intel_checks WHERE signal_count > 0',
  ).get() as { cnt: number }).cnt;
  const alerts = (db.prepare(
    'SELECT COUNT(*) as cnt FROM competitive_intel_checks WHERE alert_sent = 1',
  ).get() as { cnt: number }).cnt;
  const latest = db.prepare(
    'SELECT MAX(checked_at) as latest FROM competitive_intel_checks',
  ).get() as { latest: string | null };

  return {
    total_checks: total,
    checks_with_signals: withSignals,
    alerts_sent: alerts,
    latest_check: latest.latest,
  };
}
