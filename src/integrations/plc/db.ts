/**
 * PLC Site Report — Database schema and CRUD operations
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

let db: Database.Database;

export function initPlcSchema(database: Database.Database): void {
  db = database;

  db.exec(`
    CREATE TABLE IF NOT EXISTS plc_sites (
      site_id TEXT PRIMARY KEY,
      site_name TEXT NOT NULL,
      manager_jid TEXT NOT NULL,
      manager_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plc_daily_reports (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      site_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      prefill_data TEXT,
      confirmed_data TEXT,
      prefill_message_id TEXT,
      confirmed_at TEXT,
      FOREIGN KEY (site_id) REFERENCES plc_sites(site_id)
    );
    CREATE INDEX IF NOT EXISTS idx_plc_reports_date ON plc_daily_reports(date);
    CREATE INDEX IF NOT EXISTS idx_plc_reports_msgid ON plc_daily_reports(prefill_message_id);

    CREATE TABLE IF NOT EXISTS plc_report_history (
      date TEXT NOT NULL,
      site_id TEXT NOT NULL,
      report_data TEXT NOT NULL,
      PRIMARY KEY (date, site_id)
    );
  `);
}

// --- Site CRUD ---

export interface PlcSite {
  site_id: string;
  site_name: string;
  manager_jid: string;
  manager_name: string;
  active?: number;
}

export function getSites(): PlcSite[] {
  return db.prepare('SELECT * FROM plc_sites WHERE active = 1').all() as PlcSite[];
}

export function getSiteByManagerJid(jid: string): PlcSite | undefined {
  return db.prepare('SELECT * FROM plc_sites WHERE manager_jid = ?').get(jid) as PlcSite | undefined;
}

export function upsertSite(site: PlcSite): void {
  db.prepare(
    `INSERT OR REPLACE INTO plc_sites (site_id, site_name, manager_jid, manager_name)
     VALUES (?, ?, ?, ?)`,
  ).run(site.site_id, site.site_name, site.manager_jid, site.manager_name);
}

// --- Crew Roster & Equipment ---

export interface PlcCrewMember {
  id: number;
  name: string;
  type: 'ays' | 'sub';
  default_site: string;
  typical_count: number;
  active: number;
  trade: string | null;
  notes: string | null;
}

export interface PlcEquipmentItem {
  id: number;
  name: string;
  default_site: string;
  typical_count: number;
  active: number;
}

export function getCrewRosterForSite(siteId: string): PlcCrewMember[] {
  return db
    .prepare('SELECT * FROM plc_crew_roster WHERE LOWER(default_site) = LOWER(?) AND active = 1 ORDER BY type, id')
    .all(siteId) as PlcCrewMember[];
}

export function getEquipmentForSite(siteId: string): PlcEquipmentItem[] {
  return db
    .prepare('SELECT * FROM plc_equipment WHERE LOWER(default_site) = LOWER(?) AND active = 1 ORDER BY id')
    .all(siteId) as PlcEquipmentItem[];
}

export function getAllRosterEntries(): PlcCrewMember[] {
  return db.prepare('SELECT * FROM plc_crew_roster WHERE active = 1').all() as PlcCrewMember[];
}

export function getAllEquipmentEntries(): PlcEquipmentItem[] {
  return db.prepare('SELECT * FROM plc_equipment WHERE active = 1').all() as PlcEquipmentItem[];
}

// --- Daily Report CRUD ---

export interface PlcDailyReport {
  id: string;
  date: string;
  site_id: string;
  status: 'pending' | 'confirmed_same' | 'confirmed_changed' | 'off' | 'not_reported';
  prefill_data: string | null;
  confirmed_data: string | null;
  prefill_message_id: string | null;
  confirmed_at: string | null;
}

export function createDailyReport(date: string, siteId: string, prefillData: object): { id: string; created: boolean } {
  const existing = db
    .prepare('SELECT id FROM plc_daily_reports WHERE date = ? AND site_id = ?')
    .get(date, siteId) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };

  const id = randomUUID();
  db.prepare(
    `INSERT INTO plc_daily_reports (id, date, site_id, status, prefill_data)
     VALUES (?, ?, ?, 'pending', ?)`,
  ).run(id, date, siteId, JSON.stringify(prefillData));
  return { id, created: true };
}

export function getReportsForDate(date: string): PlcDailyReport[] {
  return db.prepare('SELECT * FROM plc_daily_reports WHERE date = ?').all(date) as PlcDailyReport[];
}

export function getReportByPrefillMessageId(messageId: string): PlcDailyReport | undefined {
  return db
    .prepare('SELECT * FROM plc_daily_reports WHERE prefill_message_id = ?')
    .get(messageId) as PlcDailyReport | undefined;
}

export function getReportsByPrefillMessageId(messageId: string): PlcDailyReport[] {
  return db
    .prepare('SELECT * FROM plc_daily_reports WHERE prefill_message_id = ?')
    .all(messageId) as PlcDailyReport[];
}

export function setPrefillMessageId(reportId: string, messageId: string): void {
  db.prepare('UPDATE plc_daily_reports SET prefill_message_id = ? WHERE id = ?').run(messageId, reportId);
}

export function confirmReport(
  reportId: string,
  confirmedData: object | null,
  status: 'confirmed_same' | 'confirmed_changed' | 'off',
): void {
  db.prepare(
    `UPDATE plc_daily_reports SET status = ?, confirmed_data = ?, confirmed_at = ? WHERE id = ?`,
  ).run(status, confirmedData ? JSON.stringify(confirmedData) : null, new Date().toISOString(), reportId);
}

// --- Report History ---

export interface PlcReportHistory {
  date: string;
  site_id: string;
  report_data: string;
}

export function getLatestReportForSite(siteId: string): PlcReportHistory | undefined {
  return db
    .prepare('SELECT * FROM plc_report_history WHERE site_id = ? ORDER BY date DESC LIMIT 1')
    .get(siteId) as PlcReportHistory | undefined;
}

export function storeReportHistory(date: string, siteId: string, reportData: object): void {
  db.prepare(
    `INSERT OR REPLACE INTO plc_report_history (date, site_id, report_data) VALUES (?, ?, ?)`,
  ).run(date, siteId, JSON.stringify(reportData));
}

export function getReportHistoryForRange(startDate: string, endDate: string): PlcReportHistory[] {
  return db
    .prepare('SELECT * FROM plc_report_history WHERE date >= ? AND date <= ? ORDER BY date, site_id')
    .all(startDate, endDate) as PlcReportHistory[];
}
