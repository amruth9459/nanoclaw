import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, INITIAL_BALANCE, STORE_DIR } from './config.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      media_type TEXT,
      media_path TEXT,
      media_mimetype TEXT,
      media_size INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      chat_jid TEXT,
      run_at TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      duration_ms INTEGER,
      is_task INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS group_economics (
      group_id TEXT PRIMARY KEY,
      balance REAL NOT NULL DEFAULT 1000.0,
      initial_balance REAL NOT NULL DEFAULT 1000.0,
      total_earned REAL DEFAULT 0,
      total_spent REAL DEFAULT 0,
      last_updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clawwork_tasks (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      occupation TEXT NOT NULL,
      sector TEXT,
      prompt TEXT NOT NULL,
      max_payment REAL NOT NULL,
      estimated_hours REAL,
      status TEXT DEFAULT 'active',
      assigned_at TEXT NOT NULL,
      submitted_at TEXT,
      evaluation_score REAL,
      actual_payment REAL,
      work_output TEXT,
      artifact_paths TEXT
    );

    CREATE TABLE IF NOT EXISTS clawwork_learns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      knowledge TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bounty_opportunities (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      reward_usd REAL,
      reward_raw TEXT,
      description TEXT,
      status TEXT DEFAULT 'proposed',
      proposed_at TEXT NOT NULL,
      approved_at TEXT,
      submitted_at TEXT,
      notes TEXT
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database.prepare(
      `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
    ).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE chats ADD COLUMN channel TEXT`,
    );
    database.exec(
      `ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`,
    );
    // Backfill from JID patterns
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`);
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`);
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`);
  } catch {
    /* columns already exist */
  }

  // Add media columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN media_type TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN media_path TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN media_mimetype TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN media_size INTEGER`);
  } catch {
    /* column already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, media_type, media_path, media_mimetype, media_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.media_type ?? null,
    msg.media_path ?? null,
    msg.media_mimetype ?? null,
    msg.media_size ?? null,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  media_type?: 'image' | 'video' | 'audio' | 'document' | null;
  media_path?: string | null;
  media_mimetype?: string | null;
  media_size?: number | null;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, media_type, media_path, media_mimetype, media_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.media_type ?? null,
    msg.media_path ?? null,
    msg.media_mimetype ?? null,
    msg.media_size ?? null,
  );
}

/**
 * Get the channel name that owns a given chat JID.
 * Used by WhatsApp channel instances to route replies to the right number.
 */
export function getChatChannel(jid: string): string | undefined {
  const row = db
    .prepare('SELECT channel FROM chats WHERE jid = ?')
    .get(jid) as { channel: string | null } | undefined;
  return row?.channel ?? undefined;
}

/**
 * Get the display name for a chat from the chats table.
 * Returns undefined if the chat is unknown or if no real name is stored.
 */
export function getChatName(jid: string): string | undefined {
  const row = db
    .prepare('SELECT name FROM chats WHERE jid = ?')
    .get(jid) as { name: string } | undefined;
  // When no name is known, storeChatMetadata falls back to the jid itself
  if (!row || row.name === jid) return undefined;
  return row.name;
}

/**
 * Find @-mention messages from chats NOT in the registered set.
 * Used by the open mentions feature to trigger guest agent sessions.
 */
export function getNewMentions(
  lastTimestamp: string,
  registeredJids: string[],
  assistantName: string,
): NewMessage[] {
  const likePattern = `%@${assistantName}%`;

  if (registeredJids.length === 0) {
    // No registered groups — search all chats
    return db
      .prepare(
        `
      SELECT id, chat_jid, sender, sender_name, content, timestamp
      FROM messages
      WHERE timestamp > ?
        AND is_bot_message = 0
        AND content LIKE ?
      ORDER BY timestamp
    `,
      )
      .all(lastTimestamp, likePattern) as NewMessage[];
  }

  const placeholders = registeredJids.map(() => '?').join(',');
  return db
    .prepare(
      `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ?
      AND is_bot_message = 0
      AND chat_jid NOT IN (${placeholders})
      AND content LIKE ?
    ORDER BY timestamp
  `,
    )
    .all(lastTimestamp, ...registeredJids, likePattern) as NewMessage[];
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, media_type, media_path, media_mimetype, media_size
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, media_type, media_path, media_mimetype, media_size
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}

// --- Economics accessors ---

export interface UsageLogEntry {
  group_id: string;
  chat_jid: string | null;
  run_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  duration_ms: number | null;
  is_task: number;
}

export interface GroupEconomics {
  group_id: string;
  balance: number;
  initial_balance: number;
  total_earned: number;
  total_spent: number;
  last_updated: string;
}

export interface ClawworkTask {
  id: string;
  group_id: string;
  occupation: string;
  sector: string | null;
  prompt: string;
  max_payment: number;
  estimated_hours: number | null;
  status: string;
  assigned_at: string;
  submitted_at: string | null;
  evaluation_score: number | null;
  actual_payment: number | null;
  work_output: string | null;
  artifact_paths: string | null;
}

export function logUsage(
  groupId: string,
  chatJid: string | null,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  durationMs: number,
  isTask: boolean,
  costUsd: number,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO usage_logs (group_id, chat_jid, run_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, is_task)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    groupId,
    chatJid,
    now,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
    costUsd,
    durationMs,
    isTask ? 1 : 0,
  );
}

export function getOrCreateEconomics(groupId: string): GroupEconomics {
  const existing = db.prepare('SELECT * FROM group_economics WHERE group_id = ?').get(groupId) as GroupEconomics | undefined;
  if (existing) return existing;

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO group_economics (group_id, balance, initial_balance, total_earned, total_spent, last_updated)
    VALUES (?, ?, ?, 0, 0, ?)
  `).run(groupId, INITIAL_BALANCE, INITIAL_BALANCE, now);

  return {
    group_id: groupId,
    balance: INITIAL_BALANCE,
    initial_balance: INITIAL_BALANCE,
    total_earned: 0,
    total_spent: 0,
    last_updated: now,
  };
}

export function deductBalance(groupId: string, costUsd: number): void {
  const now = new Date().toISOString();
  // Ensure the record exists first
  getOrCreateEconomics(groupId);
  db.prepare(`
    UPDATE group_economics
    SET balance = balance - ?, total_spent = total_spent + ?, last_updated = ?
    WHERE group_id = ?
  `).run(costUsd, costUsd, now, groupId);
}

export function addEarnings(groupId: string, amount: number): void {
  const now = new Date().toISOString();
  getOrCreateEconomics(groupId);
  db.prepare(`
    UPDATE group_economics
    SET balance = balance + ?, total_earned = total_earned + ?, last_updated = ?
    WHERE group_id = ?
  `).run(amount, amount, now, groupId);
}

export function getUsageHistory(groupId: string, limit = 20): UsageLogEntry[] {
  return db.prepare(`
    SELECT * FROM usage_logs WHERE group_id = ? ORDER BY run_at DESC LIMIT ?
  `).all(groupId, limit) as UsageLogEntry[];
}

export function getEconomicsSummary(): {
  all_earned: number;
  all_spent: number;
  net: number;
  groups: GroupEconomics[];
} {
  const groups = db.prepare('SELECT * FROM group_economics ORDER BY group_id').all() as GroupEconomics[];
  const all_earned = groups.reduce((s, g) => s + g.total_earned, 0);
  const all_spent = groups.reduce((s, g) => s + g.total_spent, 0);
  return { all_earned, all_spent, net: all_earned - all_spent, groups };
}

export function getAllUsageRecent(limit = 20): (UsageLogEntry & { id: number })[] {
  return db.prepare(`
    SELECT * FROM usage_logs ORDER BY run_at DESC LIMIT ?
  `).all(limit) as (UsageLogEntry & { id: number })[];
}

export interface UsageTimePeriod {
  total_cost: number;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  run_count: number;
}

export function getUsageSince(since: string): UsageTimePeriod {
  const result = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) as total_tokens,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
      COUNT(*) as run_count
    FROM usage_logs
    WHERE run_at >= ?
  `).get(since) as UsageTimePeriod;
  return result;
}

export function getTotalUsage(): UsageTimePeriod {
  const result = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) as total_tokens,
      COALESCE(SUM(input_tokens), 0) as input_tokens,
      COALESCE(SUM(output_tokens), 0) as output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
      COUNT(*) as run_count
    FROM usage_logs
  `).get() as UsageTimePeriod;
  return result;
}

export function createClawworkTask(task: Omit<ClawworkTask, 'status' | 'submitted_at' | 'evaluation_score' | 'actual_payment' | 'work_output' | 'artifact_paths'>): void {
  db.prepare(`
    INSERT INTO clawwork_tasks (id, group_id, occupation, sector, prompt, max_payment, estimated_hours, status, assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `).run(
    task.id,
    task.group_id,
    task.occupation,
    task.sector ?? null,
    task.prompt,
    task.max_payment,
    task.estimated_hours ?? null,
    task.assigned_at,
  );
}

export function getActiveTask(groupId: string): ClawworkTask | undefined {
  return db.prepare(`
    SELECT * FROM clawwork_tasks WHERE group_id = ? AND status = 'active' ORDER BY assigned_at DESC LIMIT 1
  `).get(groupId) as ClawworkTask | undefined;
}

export function updateTaskSubmission(taskId: string, workOutput: string, artifactPaths: string[]): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE clawwork_tasks
    SET status = 'submitted', submitted_at = ?, work_output = ?, artifact_paths = ?
    WHERE id = ?
  `).run(now, workOutput, JSON.stringify(artifactPaths), taskId);
}

export function updateTaskEvaluation(taskId: string, score: number, payment: number): void {
  db.prepare(`
    UPDATE clawwork_tasks
    SET status = 'evaluated', evaluation_score = ?, actual_payment = ?
    WHERE id = ?
  `).run(score, payment, taskId);
}

export function saveLearn(groupId: string, topic: string, knowledge: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO clawwork_learns (group_id, topic, knowledge, created_at)
    VALUES (?, ?, ?, ?)
  `).run(groupId, topic, knowledge, now);
}

export function getActiveClawworkTasks(): ClawworkTask[] {
  return db.prepare(`
    SELECT * FROM clawwork_tasks WHERE status IN ('active', 'submitted') ORDER BY assigned_at DESC
  `).all() as ClawworkTask[];
}

// --- Bounty opportunity accessors ---

export interface BountyOpportunity {
  id: string;
  group_id: string;
  platform: string;
  title: string;
  url: string;
  reward_usd: number | null;
  reward_raw: string | null;
  description: string | null;
  status: string;
  proposed_at: string;
  approved_at: string | null;
  submitted_at: string | null;
  notes: string | null;
}

export function createBountyOpportunity(bounty: {
  id: string;
  group_id: string;
  platform: string;
  title: string;
  url: string;
  reward_usd: number | null;
  reward_raw: string;
  description: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO bounty_opportunities (id, group_id, platform, title, url, reward_usd, reward_raw, description, status, proposed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)
  `).run(
    bounty.id,
    bounty.group_id,
    bounty.platform,
    bounty.title,
    bounty.url,
    bounty.reward_usd ?? null,
    bounty.reward_raw,
    bounty.description,
    now,
  );
}

export function getBountyById(id: string): BountyOpportunity | undefined {
  return db.prepare('SELECT * FROM bounty_opportunities WHERE id = ?').get(id) as BountyOpportunity | undefined;
}

export function updateBountyStatus(id: string, status: string, notes?: string): void {
  const now = new Date().toISOString();
  if (status === 'approved') {
    db.prepare(`UPDATE bounty_opportunities SET status = ?, approved_at = ?, notes = COALESCE(?, notes) WHERE id = ?`)
      .run(status, now, notes ?? null, id);
  } else if (status === 'submitted') {
    db.prepare(`UPDATE bounty_opportunities SET status = ?, submitted_at = ?, notes = COALESCE(?, notes) WHERE id = ?`)
      .run(status, now, notes ?? null, id);
  } else {
    db.prepare(`UPDATE bounty_opportunities SET status = ?, notes = COALESCE(?, notes) WHERE id = ?`)
      .run(status, notes ?? null, id);
  }
}

export function getActiveBounties(groupId?: string): BountyOpportunity[] {
  if (groupId) {
    return db.prepare(`
      SELECT * FROM bounty_opportunities WHERE group_id = ? AND status IN ('approved', 'working') ORDER BY proposed_at DESC
    `).all(groupId) as BountyOpportunity[];
  }
  return db.prepare(`
    SELECT * FROM bounty_opportunities WHERE status IN ('approved', 'working') ORDER BY proposed_at DESC
  `).all() as BountyOpportunity[];
}

export function getAllBounties(limit = 50): BountyOpportunity[] {
  return db.prepare(`
    SELECT * FROM bounty_opportunities ORDER BY proposed_at DESC LIMIT ?
  `).all(limit) as BountyOpportunity[];
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      setRegisteredGroup(jid, group);
    }
  }
}
