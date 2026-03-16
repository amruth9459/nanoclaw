import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR, INITIAL_BALANCE, MAIN_GROUP_FOLDER, STORE_DIR } from './config.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';
import { logger } from './logger.js';
import { getIntegrations } from './integration-loader.js';

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

  // Goal decomposition and task management
  database.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      target_value REAL,
      deadline INTEGER,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      parent_goal_id TEXT,
      FOREIGN KEY (parent_goal_id) REFERENCES goals(id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      goal_id TEXT,
      description TEXT NOT NULL,
      complexity TEXT NOT NULL,
      estimated_hours REAL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      dependencies TEXT,
      assigned_agent TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (goal_id) REFERENCES goals(id)
    );

    CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);

  // Transcripts (Omi, Fieldy, etc.) storage
  database.exec(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      device_id TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      text TEXT NOT NULL,
      speakers TEXT,
      language TEXT,
      audio_file_path TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL,
      indexed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_transcripts_source ON transcripts(source);
    CREATE INDEX IF NOT EXISTS idx_transcripts_start_time ON transcripts(start_time);
    CREATE INDEX IF NOT EXISTS idx_transcripts_device ON transcripts(device_id);
    CREATE INDEX IF NOT EXISTS idx_transcripts_created ON transcripts(created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(
      text,
      content='transcripts',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN
      INSERT INTO transcripts_fts(rowid, text)
      VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN
      INSERT INTO transcripts_fts(transcripts_fts, rowid, text)
      VALUES ('delete', old.rowid, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE ON transcripts BEGIN
      INSERT INTO transcripts_fts(transcripts_fts, rowid, text)
      VALUES ('delete', old.rowid, old.text);
      INSERT INTO transcripts_fts(rowid, text)
      VALUES (new.rowid, new.text);
    END;
  `);

  // Routing decision logs for model evaluation
  database.exec(`
    CREATE TABLE IF NOT EXISTS routing_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routed_at TEXT NOT NULL,
      route_type TEXT NOT NULL,
      model TEXT,
      reasoning TEXT,
      routing_latency_ms INTEGER,
      execution_latency_ms INTEGER,
      tokens_generated INTEGER,
      user_message_preview TEXT,
      success INTEGER DEFAULT 1
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

  // Add purpose tracking to usage_logs
  try {
    database.exec(`ALTER TABLE usage_logs ADD COLUMN purpose TEXT DEFAULT 'conversation'`);
  } catch {
    /* column already exists */
  }

  // Add project tracking to tasks
  try {
    database.exec(`ALTER TABLE tasks ADD COLUMN project TEXT DEFAULT 'nanoclaw'`);
  } catch {
    /* column already exists */
  }

  // Add source tracking to tasks (distinguishes user-given vs agent-generated)
  try {
    database.exec(`ALTER TABLE tasks ADD COLUMN source TEXT DEFAULT 'agent'`);
  } catch {
    /* column already exists */
  }

  // Agent quality review tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_quality_reviews (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      response_preview TEXT,
      content_type TEXT,
      approved INTEGER,
      consensus REAL,
      judge_count INTEGER,
      approval_count INTEGER,
      issues_found INTEGER,
      critical_issues INTEGER DEFAULT 0,
      major_issues INTEGER DEFAULT 0,
      minor_issues INTEGER DEFAULT 0,
      processing_time_ms INTEGER,
      cost_usd REAL DEFAULT 0,
      recommendation TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aqr_group ON agent_quality_reviews(group_id);
    CREATE INDEX IF NOT EXISTS idx_aqr_created ON agent_quality_reviews(created_at);
  `);

  // Shared items inbox — auto-captures links, media, research, and requests
  // the user shares so nothing falls through the cracks.
  database.exec(`
    CREATE TABLE IF NOT EXISTS shared_items (
      id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      content TEXT NOT NULL,
      url TEXT,
      sender TEXT,
      sender_name TEXT,
      chat_jid TEXT,
      message_id TEXT,
      media_path TEXT,
      media_type TEXT,
      category TEXT DEFAULT 'uncategorized',
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL,
      triaged_at TEXT,
      acted_on_at TEXT,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_shared_items_status ON shared_items(status);
    CREATE INDEX IF NOT EXISTS idx_shared_items_type ON shared_items(item_type);
    CREATE INDEX IF NOT EXISTS idx_shared_items_created ON shared_items(created_at);
  `);
}

/** Get the main database handle (must be called after initDatabase) */
export function getDb(): Database.Database {
  return db;
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // SECURITY: WAL mode prevents corruption from concurrent access
  // (IPC watcher, dashboard, main loop all hit the DB simultaneously).
  // busy_timeout prevents SQLITE_BUSY errors under brief lock contention.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

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
  purpose?: string;
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
  purpose: string = 'conversation',
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO usage_logs (group_id, chat_jid, run_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, is_task, purpose)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    purpose,
  );
}

export function logRouting(
  routeType: 'local' | 'cloud',
  model: string | null,
  reasoning: string,
  routingLatencyMs: number,
  executionLatencyMs: number | null,
  tokensGenerated: number | null,
  userMessagePreview: string,
  success: boolean,
): void {
  db.prepare(`
    INSERT INTO routing_logs (routed_at, route_type, model, reasoning, routing_latency_ms, execution_latency_ms, tokens_generated, user_message_preview, success)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    routeType,
    model,
    reasoning,
    routingLatencyMs,
    executionLatencyMs,
    tokensGenerated,
    userMessagePreview.slice(0, 200),
    success ? 1 : 0,
  );
}

export interface RoutingStats {
  total: number;
  local: number;
  cloud: number;
  byModel: Record<string, { count: number; avgLatencyMs: number; avgTokens: number; failures: number }>;
}

export function getRoutingStats(days: number = 10): RoutingStats {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare('SELECT * FROM routing_logs WHERE routed_at >= ?').all(since) as Array<{
    route_type: string; model: string | null; execution_latency_ms: number | null;
    tokens_generated: number | null; success: number;
  }>;

  const stats: RoutingStats = { total: rows.length, local: 0, cloud: 0, byModel: {} };

  for (const row of rows) {
    if (row.route_type === 'local') stats.local++;
    else stats.cloud++;

    const key = row.model || 'cloud';
    if (!stats.byModel[key]) stats.byModel[key] = { count: 0, avgLatencyMs: 0, avgTokens: 0, failures: 0 };
    const m = stats.byModel[key];
    m.count++;
    if (row.execution_latency_ms) m.avgLatencyMs += row.execution_latency_ms;
    if (row.tokens_generated) m.avgTokens += row.tokens_generated;
    if (!row.success) m.failures++;
  }

  // Convert sums to averages
  for (const m of Object.values(stats.byModel)) {
    if (m.count > 0) {
      m.avgLatencyMs = Math.round(m.avgLatencyMs / m.count);
      m.avgTokens = Math.round(m.avgTokens / m.count);
    }
  }

  return stats;
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

export function getUsageByPurpose(since?: string): Array<{
  purpose: string; total_cost: number; total_tokens: number; run_count: number;
}> {
  if (since) {
    return db.prepare(`
      SELECT
        COALESCE(purpose, 'conversation') as purpose,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) as total_tokens,
        COUNT(*) as run_count
      FROM usage_logs
      WHERE run_at >= ?
      GROUP BY purpose
      ORDER BY total_cost DESC
    `).all(since) as Array<{ purpose: string; total_cost: number; total_tokens: number; run_count: number }>;
  }
  return db.prepare(`
    SELECT
      COALESCE(purpose, 'conversation') as purpose,
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) as total_tokens,
      COUNT(*) as run_count
    FROM usage_logs
    GROUP BY purpose
    ORDER BY total_cost DESC
  `).all() as Array<{ purpose: string; total_cost: number; total_tokens: number; run_count: number }>;
}

export interface KanbanItem {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  source: string;
  project: string;
  priority: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export function getKanbanItems(project: string): KanbanItem[] {
  const items: KanbanItem[] = [];

  // Manual tasks from the tasks table (includes user-given and agent-generated)
  try {
    const taskRows = db.prepare(
      `SELECT * FROM tasks WHERE COALESCE(project, 'nanoclaw') = ? AND status != 'cancelled' ORDER BY priority DESC, created_at DESC`,
    ).all(project) as Array<{
      id: string; description: string; status: string; priority: number;
      created_at: number; source: string | null; complexity: string;
    }>;
    for (const t of taskRows) {
      const statusMap: Record<string, 'todo' | 'in_progress' | 'done'> = {
        pending: 'todo', in_progress: 'in_progress', completed: 'done', done: 'done', blocked: 'todo',
      };
      const src = t.source || 'agent';
      items.push({
        id: t.id,
        title: t.description.slice(0, 80) + (t.description.length > 80 ? '…' : ''),
        status: statusMap[t.status] || 'todo',
        source: src === 'user' ? 'user' : 'task',
        project,
        priority: t.priority,
        createdAt: new Date(t.created_at).toISOString(),
        metadata: { complexity: t.complexity, source: src },
      });
    }
  } catch { /* table may not have new columns yet */ }

  // Scheduled tasks → kanban items
  try {
    const tasks = db.prepare(`SELECT * FROM scheduled_tasks WHERE status != 'deleted'`).all() as Array<{
      id: string; group_folder: string; prompt: string; schedule_type: string;
      schedule_value: string; status: string; next_run: string | null; created_at: string;
    }>;
    for (const t of tasks) {
      let taskProject = 'nanoclaw';
      for (const integ of getIntegrations()) {
        const p = integ.determineProject?.(t.group_folder);
        if (p) { taskProject = p; break; }
      }
      if (taskProject !== project) continue;
      items.push({
        id: `sched-${t.id}`,
        title: t.prompt.slice(0, 80) + (t.prompt.length > 80 ? '…' : ''),
        status: t.status === 'active' ? 'in_progress' : t.status === 'paused' ? 'todo' : 'done',
        source: 'scheduled',
        project,
        priority: 1,
        createdAt: t.created_at,
        metadata: { schedule: `${t.schedule_type}: ${t.schedule_value}`, nextRun: t.next_run },
      });
    }
  } catch { /* table may not exist */ }

  // ClawWork tasks
  try {
    const cw = db.prepare(`SELECT * FROM clawwork_tasks`).all() as Array<{
      id: string; group_id: string; occupation: string; prompt: string;
      max_payment: number; status: string; assigned_at: string;
    }>;
    for (const t of cw) {
      if (project !== 'nanoclaw') continue; // ClawWork is always nanoclaw
      items.push({
        id: `cw-${t.id}`,
        title: `[${t.occupation}] ${t.prompt.slice(0, 60)}`,
        status: t.status === 'active' ? 'in_progress' : 'done',
        source: 'clawwork',
        project: 'nanoclaw',
        priority: 2,
        createdAt: t.assigned_at,
        metadata: { maxPayment: t.max_payment },
      });
    }
  } catch { /* table may not exist */ }

  // Bounty opportunities
  try {
    const bounties = db.prepare(`SELECT * FROM bounty_opportunities`).all() as Array<{
      id: string; platform: string; title: string; reward_usd: number | null;
      status: string; proposed_at: string; url: string;
    }>;
    for (const b of bounties) {
      if (project !== 'nanoclaw') continue;
      const statusMap: Record<string, 'todo' | 'in_progress' | 'done'> = {
        proposed: 'todo', approved: 'in_progress', working: 'in_progress',
        submitted: 'done', rejected: 'done', paid: 'done',
      };
      items.push({
        id: `bounty-${b.id}`,
        title: `[${b.platform}] ${b.title.slice(0, 60)}`,
        status: statusMap[b.status] || 'todo',
        source: 'bounty',
        project: 'nanoclaw',
        priority: 3,
        createdAt: b.proposed_at,
        metadata: { reward: b.reward_usd, url: b.url },
      });
    }
  } catch { /* table may not exist */ }

  // Sort: in_progress first, then todo, then done; within each, by priority then date
  const statusOrder = { in_progress: 0, todo: 1, done: 2 };
  items.sort((a, b) =>
    (statusOrder[a.status] ?? 1) - (statusOrder[b.status] ?? 1) ||
    a.priority - b.priority ||
    b.createdAt.localeCompare(a.createdAt),
  );

  return items;
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

// =============================================================================
// Task System (evolved from TodoWrite)
// =============================================================================

export interface TaskRecord {
  id: string;
  goalId: string | null;
  description: string;
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
  estimatedHours: number | null;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
  priority: number;
  dependencies: string[];
  assignedAgent: string | null;
  createdAt: number;
  completedAt: number | null;
  project?: string;
  source?: string;
}

// Stop words excluded from dependency keyword matching
const DEP_STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'will',
  'are', 'was', 'been', 'being', 'were', 'does', 'done', 'doing',
  'should', 'would', 'could', 'must', 'shall', 'into', 'also', 'each',
  'than', 'then', 'when', 'what', 'which', 'where', 'while', 'about',
  'after', 'before', 'between', 'through', 'during', 'without',
  'phase', 'task', 'add', 'create', 'build', 'implement', 'update', 'use',
  'using', 'make', 'need', 'needs', 'currently', 'existing', 'new',
]);

/**
 * Extract meaningful technical keywords from a task description.
 */
function extractTaskKeywords(description: string): Set<string> {
  return new Set(
    description.toLowerCase()
      .replace(/\[.*?\]/g, ' ')           // strip [Phase 0 · Engineering] tags
      .replace(/[^a-z0-9_.\-/\s]/g, ' ')  // keep dots, hyphens, slashes for tech terms
      .split(/\s+/)
      .filter(w => w.length > 2 && !DEP_STOP_WORDS.has(w))
  );
}

// Highly specific technical terms — a single match on these is significant
const HIGH_SPECIFICITY_TERMS = new Set([
  'postgresql', 'postgres', 'sqlite', 'mysql', 'mongodb', 'redis', 'elasticsearch',
  'flask', 'django', 'fastapi', 'express', 'nextjs', 'react', 'vue', 'angular', 'svelte',
  'docker', 'kubernetes', 'nginx', 'cloudflare', 'terraform', 'ansible',
  'stripe', 'twilio', 'sendgrid', 'auth0', 'firebase',
  'jwt', 'oauth', 'saml', 'openid',
  'websocket', 'graphql', 'grpc', 'rest',
  'prometheus', 'grafana', 'datadog', 'sentry',
  'github', 'gitlab', 'ci/cd', 'pipeline',
  'r2', 's3', 'cloudfront', 'lambda',
  'vite', 'webpack', 'tailwind', 'typescript', 'python',
  'anthropic', 'openai', 'gemini', 'claude', 'gpt-4',
  'extraction', 'compliance', 'takeoff', 'classification',
]);

/**
 * Compute a weighted overlap score between two keyword sets.
 * High-specificity technical terms count as 3 matches; regular terms count as 1.
 */
function computeOverlapScore(setA: Set<string>, setB: Set<string>): { score: number; shared: string[] } {
  let score = 0;
  const shared: string[] = [];
  for (const kw of setA) {
    if (setB.has(kw)) {
      shared.push(kw);
      score += HIGH_SPECIFICITY_TERMS.has(kw) ? 3 : 1;
    }
  }
  return { score, shared };
}

/**
 * Infer dependencies for a new task by analyzing existing incomplete tasks
 * in the same project. Uses weighted keyword overlap + prerequisite heuristics.
 *
 * Rules:
 * 1. Explicit ID references in description → dependency
 * 2. Weighted keyword overlap ≥ 3 (tech terms = 3 pts, regular = 1 pt) where
 *    existing task is a setup/infrastructure task → dependency
 * 3. For phased task IDs (lex-N-*), earlier-phase tasks with 2+ specific term overlap → dependency
 */
export function inferDependencies(description: string, project: string): string[] {
  const incompleteTasks = db.prepare(`
    SELECT id, description FROM tasks
    WHERE project = ? AND status NOT IN ('completed', 'done')
  `).all(project) as { id: string; description: string }[];

  if (incompleteTasks.length === 0) return [];

  const descLower = description.toLowerCase();
  const newKeywords = extractTaskKeywords(description);
  const deps: string[] = [];

  // Prerequisite indicators: existing task creates/sets up something
  const setupPatterns = [
    /\b(set\s*up|create|configure|establish|initialize|wire|connect|install|migrate)\b/i,
    /\b(schema|database|table|migration|infrastructure|pipeline|framework|architecture)\b/i,
    /\b(api\s*key|credentials|authentication|token|secret|config|environment)\b/i,
  ];

  // Usage indicators: new task uses/needs what existing task provides
  const usagePatterns = [
    /\b(use|using|requires|needs|depends|relies|consumes|calls|queries|connects?\s+to)\b/i,
    /\b(endpoint|route|api|service|provider|module|component|interface)\b/i,
  ];

  const newIsUsage = usagePatterns.some(p => p.test(description));

  for (const task of incompleteTasks) {
    // Rule 1: Explicit task ID reference in description
    if (descLower.includes(task.id.toLowerCase())) {
      deps.push(task.id);
      continue;
    }

    // Rule 2: Weighted keyword overlap + prerequisite heuristic
    const existingKeywords = extractTaskKeywords(task.description);
    const { score, shared } = computeOverlapScore(newKeywords, existingKeywords);

    if (score >= 3) {
      const existingIsSetup = setupPatterns.some(p => p.test(task.description));
      // Existing task sets up infrastructure OR new task uses/needs things → dependency
      if (existingIsSetup || newIsUsage) {
        deps.push(task.id);
        continue;
      }
      // Even without setup/usage patterns, high overlap (≥5) implies strong relationship
      if (score >= 5) {
        deps.push(task.id);
        continue;
      }
    }

    // Rule 3: Phase-based ordering for phased IDs
    const phaseMatch = task.id.match(/^(\w+)-(\d+)-(\w+)-/);
    if (phaseMatch) {
      const existingPhase = parseInt(phaseMatch[2], 10);
      if (existingPhase === 0) {
        // Phase 0 setup tasks with 2+ specific keyword overlap → dependency
        const specificOverlap = shared.filter(
          k => k.length > 4 && !['phase', 'engineering', 'security', 'product', 'infrastructure'].includes(k)
        );
        if (specificOverlap.length >= 2 && !deps.includes(task.id)) {
          deps.push(task.id);
        }
      }
    }
  }

  return deps;
}

/**
 * Create a new task (with compulsory dependency analysis).
 * If no explicit dependencies are provided, automatically infers them
 * by analyzing existing tasks in the same project.
 */
export function createTaskRecord(params: {
  description: string;
  goalId?: string | null;
  complexity?: TaskRecord['complexity'];
  estimatedHours?: number | null;
  priority?: number;
  dependencies?: string[];
  assignedAgent?: string | null;
  project?: string;
  source?: string;
}): TaskRecord {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const project = params.project || 'nanoclaw';

  // Compulsory dependency analysis: infer when not explicitly provided
  let dependencies = params.dependencies || [];
  if (dependencies.length === 0) {
    dependencies = inferDependencies(params.description, project);
    if (dependencies.length > 0) {
      logger.info({
        taskId,
        inferred: dependencies,
        desc: params.description.slice(0, 80),
      }, 'Auto-inferred task dependencies');
    }
  }

  const task: TaskRecord = {
    id: taskId,
    goalId: params.goalId || null,
    description: params.description,
    complexity: params.complexity || 'moderate',
    estimatedHours: params.estimatedHours || null,
    status: 'pending',
    priority: params.priority || 3,
    dependencies,
    assignedAgent: params.assignedAgent || null,
    createdAt: now,
    completedAt: null,
    project,
    source: params.source || 'agent',
  };

  db.prepare(`
    INSERT INTO tasks (
      id, goal_id, description, complexity, estimated_hours,
      status, priority, dependencies, assigned_agent,
      created_at, completed_at, project, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.goalId,
    task.description,
    task.complexity,
    task.estimatedHours,
    task.status,
    task.priority,
    JSON.stringify(task.dependencies),
    task.assignedAgent,
    task.createdAt,
    task.completedAt,
    task.project,
    task.source,
  );

  logger.info({ taskId, description: task.description, deps: dependencies.length }, 'Task created');
  return task;
}

/**
 * Get a task by ID
 */
export function getTaskRecord(taskId: string): TaskRecord | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any;
  if (!row) return undefined;

  return {
    id: row.id,
    goalId: row.goal_id,
    description: row.description,
    complexity: row.complexity,
    estimatedHours: row.estimated_hours,
    status: row.status,
    priority: row.priority,
    dependencies: JSON.parse(row.dependencies || '[]'),
    assignedAgent: row.assigned_agent,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Get all tasks (optionally filtered)
 */
export function getTaskRecords(filters?: {
  goalId?: string;
  status?: TaskRecord['status'];
  assignedAgent?: string;
  priority?: number;
}): TaskRecord[] {
  let query = 'SELECT * FROM tasks WHERE 1=1';
  const params: any[] = [];

  if (filters?.goalId) {
    query += ' AND goal_id = ?';
    params.push(filters.goalId);
  }

  if (filters?.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }

  if (filters?.assignedAgent) {
    query += ' AND assigned_agent = ?';
    params.push(filters.assignedAgent);
  }

  if (filters?.priority !== undefined) {
    query += ' AND priority = ?';
    params.push(filters.priority);
  }

  query += ' ORDER BY priority DESC, created_at ASC';

  const rows = db.prepare(query).all(...params) as any[];

  return rows.map(row => ({
    id: row.id,
    goalId: row.goal_id,
    description: row.description,
    complexity: row.complexity,
    estimatedHours: row.estimated_hours,
    status: row.status,
    priority: row.priority,
    dependencies: JSON.parse(row.dependencies || '[]'),
    assignedAgent: row.assigned_agent,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }));
}

/**
 * Update a task
 */
export function updateTaskRecord(taskId: string, updates: {
  status?: TaskRecord['status'];
  assignedAgent?: string | null;
  priority?: number;
  dependencies?: string[];
}): TaskRecord | undefined {
  const task = getTaskRecord(taskId);
  if (!task) {
    logger.warn({ taskId }, 'Task not found for update');
    return undefined;
  }

  const now = Date.now();
  const updateFields: string[] = [];
  const updateValues: any[] = [];

  if (updates.status !== undefined) {
    updateFields.push('status = ?');
    updateValues.push(updates.status);

    if (updates.status === 'completed') {
      updateFields.push('completed_at = ?');
      updateValues.push(now);
    }
  }

  if (updates.assignedAgent !== undefined) {
    updateFields.push('assigned_agent = ?');
    updateValues.push(updates.assignedAgent);
  }

  if (updates.priority !== undefined) {
    updateFields.push('priority = ?');
    updateValues.push(updates.priority);
  }

  if (updates.dependencies !== undefined) {
    updateFields.push('dependencies = ?');
    updateValues.push(JSON.stringify(updates.dependencies));
  }

  if (updateFields.length === 0) {
    return task; // No updates
  }

  updateValues.push(taskId);

  db.prepare(`UPDATE tasks SET ${updateFields.join(', ')} WHERE id = ?`).run(...updateValues);

  logger.info({ taskId, updates }, 'Task updated');
  return getTaskRecord(taskId);
}

/**
 * Delete a task
 */
export function deleteTaskRecord(taskId: string): boolean {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  const deleted = result.changes > 0;

  if (deleted) {
    logger.info({ taskId }, 'Task deleted');
  }

  return deleted;
}

/**
 * Get available tasks (dependencies met, ready to work on)
 */
export function getAvailableTaskRecords(agentName?: string): TaskRecord[] {
  const allTasks = getTaskRecords({ status: 'pending' });
  const available: TaskRecord[] = [];

  for (const task of allTasks) {
    // Skip if assigned to different agent
    if (task.assignedAgent && agentName && task.assignedAgent !== agentName) {
      continue;
    }

    // Check dependencies
    if (task.dependencies.length > 0) {
      const deps = task.dependencies.map(depId => getTaskRecord(depId)).filter(Boolean) as TaskRecord[];
      const allComplete = deps.every(dep => dep.status === 'completed');

      if (!allComplete) continue;
    }

    available.push(task);
  }

  // Sort by priority
  return available.sort((a, b) => b.priority - a.priority);
}

/**
 * Get task statistics
 */
export function getTaskStats(): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  blocked: number;
} {
  const all = getTaskRecords();

  return {
    total: all.length,
    pending: all.filter(t => t.status === 'pending').length,
    inProgress: all.filter(t => t.status === 'in_progress').length,
    completed: all.filter(t => t.status === 'completed').length,
    blocked: all.filter(t => t.status === 'blocked').length,
  };
}

// =============================================================================
// Transcripts System (Omi, Fieldy, etc.)
// =============================================================================

export interface TranscriptRecord {
  id: string;
  source: 'omi' | 'fieldy' | 'other';
  deviceId: string | null;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  text: string;
  speakers: Array<{speaker: string; start: number; end: number}> | null;
  language: string | null;
  audioFilePath: string | null;
  metadata: Record<string, any> | null;
  createdAt: string;
  indexedAt: string | null;
}

/**
 * Store a transcript from Omi, Fieldy, or other source
 */
export function storeTranscript(params: {
  id: string;
  source: 'omi' | 'fieldy' | 'other';
  deviceId?: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  text: string;
  speakers?: Array<{speaker: string; start: number; end: number}>;
  language?: string;
  audioFilePath?: string;
  metadata?: Record<string, any>;
}): void {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO transcripts (
      id, source, device_id, start_time, end_time, duration_seconds,
      text, speakers, language, audio_file_path, metadata,
      created_at, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.source,
    params.deviceId || null,
    params.startTime,
    params.endTime,
    params.durationSeconds,
    params.text,
    params.speakers ? JSON.stringify(params.speakers) : null,
    params.language || null,
    params.audioFilePath || null,
    params.metadata ? JSON.stringify(params.metadata) : null,
    now,
    now // indexed_at is set by FTS trigger
  );

  logger.info({ transcriptId: params.id, source: params.source, duration: params.durationSeconds }, 'Transcript stored');
}

/**
 * Get transcript by ID
 */
export function getTranscript(transcriptId: string): TranscriptRecord | undefined {
  const row = db.prepare('SELECT * FROM transcripts WHERE id = ?').get(transcriptId) as any;
  if (!row) return undefined;

  return {
    id: row.id,
    source: row.source,
    deviceId: row.device_id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    text: row.text,
    speakers: row.speakers ? JSON.parse(row.speakers) : null,
    language: row.language,
    audioFilePath: row.audio_file_path,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
  };
}

/**
 * Search transcripts by text (full-text search)
 */
export function searchTranscripts(query: string, limit: number = 10): TranscriptRecord[] {
  const rows = db.prepare(`
    SELECT t.*
    FROM transcripts t
    INNER JOIN transcripts_fts fts ON fts.rowid = t.rowid
    WHERE transcripts_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as any[];

  return rows.map(row => ({
    id: row.id,
    source: row.source,
    deviceId: row.device_id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    text: row.text,
    speakers: row.speakers ? JSON.parse(row.speakers) : null,
    language: row.language,
    audioFilePath: row.audio_file_path,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
  }));
}

/**
 * Get transcripts by date range
 */
export function getTranscriptsByDate(startDate: string, endDate?: string): TranscriptRecord[] {
  const query = endDate
    ? 'SELECT * FROM transcripts WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC'
    : 'SELECT * FROM transcripts WHERE DATE(start_time) = DATE(?) ORDER BY start_time DESC';

  const rows = endDate
    ? db.prepare(query).all(startDate, endDate)
    : db.prepare(query).all(startDate);

  return (rows as any[]).map(row => ({
    id: row.id,
    source: row.source,
    deviceId: row.device_id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    text: row.text,
    speakers: row.speakers ? JSON.parse(row.speakers) : null,
    language: row.language,
    audioFilePath: row.audio_file_path,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
  }));
}

/**
 * Get transcripts by source
 */
export function getTranscriptsBySource(source: 'omi' | 'fieldy' | 'other', limit: number = 50): TranscriptRecord[] {
  const rows = db.prepare(`
    SELECT * FROM transcripts
    WHERE source = ?
    ORDER BY start_time DESC
    LIMIT ?
  `).all(source, limit) as any[];

  return rows.map(row => ({
    id: row.id,
    source: row.source,
    deviceId: row.device_id,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    text: row.text,
    speakers: row.speakers ? JSON.parse(row.speakers) : null,
    language: row.language,
    audioFilePath: row.audio_file_path,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    createdAt: row.created_at,
    indexedAt: row.indexed_at,
  }));
}

/**
 * Get transcript statistics
 */
export function getTranscriptStats(): {
  total: number;
  bySource: Record<string, number>;
  totalDurationHours: number;
  oldestTranscript: string | null;
  newestTranscript: string | null;
} {
  const total = db.prepare('SELECT COUNT(*) as count FROM transcripts').get() as { count: number };

  const bySourceRows = db.prepare(`
    SELECT source, COUNT(*) as count
    FROM transcripts
    GROUP BY source
  `).all() as Array<{ source: string; count: number }>;

  const bySource: Record<string, number> = {};
  for (const row of bySourceRows) {
    bySource[row.source] = row.count;
  }

  const duration = db.prepare('SELECT SUM(duration_seconds) as total FROM transcripts').get() as { total: number | null };
  const totalDurationHours = duration.total ? Math.round(duration.total / 3600 * 10) / 10 : 0;

  const oldest = db.prepare('SELECT start_time FROM transcripts ORDER BY start_time ASC LIMIT 1').get() as { start_time: string } | undefined;
  const newest = db.prepare('SELECT start_time FROM transcripts ORDER BY start_time DESC LIMIT 1').get() as { start_time: string } | undefined;

  return {
    total: total.count,
    bySource,
    totalDurationHours,
    oldestTranscript: oldest?.start_time || null,
    newestTranscript: newest?.start_time || null,
  };
}

// ──────────────────────────────────────────────────────────────────
// Agent Quality Reviews
// ──────────────────────────────────────────────────────────────────

export interface QualityReview {
  id: string;
  group_id: string;
  response_preview: string | null;
  content_type: string | null;
  approved: number;
  consensus: number;
  judge_count: number;
  approval_count: number;
  issues_found: number;
  critical_issues: number;
  major_issues: number;
  minor_issues: number;
  processing_time_ms: number | null;
  cost_usd: number;
  recommendation: string | null;
  metadata: string | null;
  created_at: string;
}

export function logQualityReview(review: Omit<QualityReview, 'created_at'>): void {
  db.prepare(`
    INSERT INTO agent_quality_reviews (id, group_id, response_preview, content_type, approved, consensus,
      judge_count, approval_count, issues_found, critical_issues, major_issues, minor_issues,
      processing_time_ms, cost_usd, recommendation, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    review.id, review.group_id, review.response_preview, review.content_type,
    review.approved, review.consensus, review.judge_count, review.approval_count,
    review.issues_found, review.critical_issues, review.major_issues, review.minor_issues,
    review.processing_time_ms, review.cost_usd, review.recommendation, review.metadata,
    new Date().toISOString(),
  );
}

export function getQualityStats(groupId?: string, days = 30): {
  total_reviews: number;
  approval_rate: number;
  avg_consensus: number;
  total_issues: number;
  avg_processing_ms: number;
  total_cost: number;
} {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const where = groupId ? 'WHERE group_id = ? AND created_at >= ?' : 'WHERE created_at >= ?';
  const params = groupId ? [groupId, since] : [since];
  const row = db.prepare(`
    SELECT COUNT(*) as total,
      COALESCE(AVG(approved), 0) as approval_rate,
      COALESCE(AVG(consensus), 0) as avg_consensus,
      COALESCE(SUM(issues_found), 0) as total_issues,
      COALESCE(AVG(processing_time_ms), 0) as avg_processing_ms,
      COALESCE(SUM(cost_usd), 0) as total_cost
    FROM agent_quality_reviews ${where}
  `).get(...params) as any;
  return {
    total_reviews: row.total,
    approval_rate: Math.round(row.approval_rate * 100) / 100,
    avg_consensus: Math.round(row.avg_consensus * 100) / 100,
    total_issues: row.total_issues,
    avg_processing_ms: Math.round(row.avg_processing_ms),
    total_cost: Math.round(row.total_cost * 10000) / 10000,
  };
}

export function getRecentReviews(groupId?: string, limit = 20): QualityReview[] {
  const where = groupId ? 'WHERE group_id = ?' : '';
  const params = groupId ? [groupId, limit] : [limit];
  return db.prepare(`
    SELECT * FROM agent_quality_reviews ${where}
    ORDER BY created_at DESC LIMIT ?
  `).all(...params) as QualityReview[];
}

/**
 * Sync kanban state to groups/main/KANBAN.md for cross-agent visibility.
 * Called after any kanban mutation (create/update/delete task, dashboard API).
 * Both Claude Code and Claw read this file.
 */
export function syncKanbanFile(): void {
  try {
    const statusIcon: Record<string, string> = { todo: '[ ]', in_progress: '[>]', done: '[x]' };
    const formatItem = (item: KanbanItem) =>
      `- ${statusIcon[item.status] || '[ ]'} \`${item.id}\` ${item.title}`;

    const formatProject = (label: string, items: KanbanItem[]) => {
      const todo = items.filter(i => i.status === 'todo');
      const inProgress = items.filter(i => i.status === 'in_progress');
      const done = items.filter(i => i.status === 'done');
      const lines = [`## ${label} (${todo.length} todo, ${inProgress.length} active, ${done.length} done)`];
      if (inProgress.length) {
        lines.push('', '### In Progress', ...inProgress.map(formatItem));
      }
      if (todo.length) {
        lines.push('', '### To Do', ...todo.map(formatItem));
      }
      // Omit completed items to keep file bounded — they're in the DB
      return lines.join('\n');
    };

    // Collect project sections: NanoClaw + any integration projects
    const projects: Array<{ name: string; label: string }> = [{ name: 'nanoclaw', label: 'NanoClaw' }];
    for (const integ of getIntegrations()) {
      projects.push({ name: integ.name, label: integ.name.charAt(0).toUpperCase() + integ.name.slice(1) });
    }

    const sections = projects.map(p => formatProject(p.label, getKanbanItems(p.name)));

    const content = [
      '# Kanban Board',
      '',
      `> Auto-generated from DB. Updated: ${new Date().toISOString().slice(0, 16)}`,
      `> Edit tasks via DashClaw UI, Claw's task_tool, or Claude Code's desktop_claude.`,
      '',
      sections.join('\n\n'),
      '',
    ].join('\n');

    const filePath = path.join(GROUPS_DIR, MAIN_GROUP_FOLDER, 'KANBAN.md');
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    logger.warn({ err }, 'Failed to sync KANBAN.md');
  }
}

// ─── Shared Items Inbox ───────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;

export interface SharedItem {
  id: string;
  item_type: 'link' | 'media' | 'research' | 'request' | 'strategic' | 'document';
  content: string;
  url: string | null;
  sender: string | null;
  sender_name: string | null;
  chat_jid: string | null;
  message_id: string | null;
  media_path: string | null;
  media_type: string | null;
  category: string;
  status: 'new' | 'triaged' | 'acted_on' | 'archived';
  created_at: string;
  triaged_at: string | null;
  acted_on_at: string | null;
  notes: string | null;
}

/** Detect whether an incoming message contains a shared item worth tracking. */
export function detectSharedItems(msg: {
  id: string;
  content: string;
  sender: string;
  sender_name: string;
  chat_jid: string;
  timestamp: string;
  is_from_me?: boolean;
  media_type?: string | null;
  media_path?: string | null;
}): SharedItem[] {
  if (msg.is_from_me) return [];

  const content = msg.content || '';
  // Skip very short messages and quoted-only replies
  if (content.length < 5 && !msg.media_type) return [];
  // Skip messages that are just quotes (start with ">")
  const cleaned = content.replace(/^>.*\n?/gm, '').trim();

  const items: SharedItem[] = [];
  const now = new Date().toISOString();

  // 1. Links/URLs
  const urls = content.match(URL_REGEX) || [];
  for (const url of urls) {
    // Categorize by domain
    let category = 'uncategorized';
    if (/github\.com/.test(url)) category = 'github';
    else if (/arxiv\.org/.test(url)) category = 'research-paper';
    else if (/medium\.com|venturebeat|blog/.test(url)) category = 'article';
    else if (/producthunt\.com|share\.google/.test(url)) category = 'product';
    else if (/x\.com|twitter\.com/.test(url)) category = 'social';
    else category = 'link';

    items.push({
      id: `si_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      item_type: 'link',
      content: cleaned.slice(0, 500),
      url,
      sender: msg.sender,
      sender_name: msg.sender_name,
      chat_jid: msg.chat_jid,
      message_id: msg.id,
      media_path: null,
      media_type: null,
      category,
      status: 'new',
      created_at: msg.timestamp,
      triaged_at: null,
      acted_on_at: null,
      notes: null,
    });
  }

  // 2. Media (images, documents, audio)
  if (msg.media_type && msg.media_path) {
    const mediaCategory = msg.media_type === 'document' ? 'document'
      : msg.media_type === 'image' ? 'image'
      : msg.media_type === 'audio' ? 'voice-note'
      : 'media';

    items.push({
      id: `si_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      item_type: msg.media_type === 'document' ? 'document' : 'media',
      content: cleaned.slice(0, 500) || `[${msg.media_type}]`,
      url: null,
      sender: msg.sender,
      sender_name: msg.sender_name,
      chat_jid: msg.chat_jid,
      message_id: msg.id,
      media_path: msg.media_path,
      media_type: msg.media_type,
      category: mediaCategory,
      status: 'new',
      created_at: msg.timestamp,
      triaged_at: null,
      acted_on_at: null,
      notes: null,
    });
  }

  // 3. Strategic / request messages (no links, no media, but substantial)
  if (items.length === 0 && cleaned.length >= 80) {
    // Detect strategic thinking or requests
    const isRequest = /\b(i want|i need|can you|please|help me|set up|add|build|create|implement|research|figure out|how (do|can) (we|i))\b/i.test(cleaned);
    const isStrategic = /\b(strategy|vision|architecture|indispensable|moat|competitive|horizon|value prop|reframe|pivot|business model)\b/i.test(cleaned);

    if (isRequest || isStrategic) {
      items.push({
        id: `si_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        item_type: isStrategic ? 'strategic' : 'request',
        content: cleaned.slice(0, 500),
        url: null,
        sender: msg.sender,
        sender_name: msg.sender_name,
        chat_jid: msg.chat_jid,
        message_id: msg.id,
        media_path: null,
        media_type: null,
        category: isStrategic ? 'strategic' : 'request',
        status: 'new',
        created_at: msg.timestamp,
        triaged_at: null,
        acted_on_at: null,
        notes: null,
      });
    }
  }

  return items;
}

/** Store a shared item. Deduplicates by message_id + url. */
export function storeSharedItem(item: SharedItem): boolean {
  try {
    // Dedup: skip if same message_id + url already exists
    const existing = db.prepare(
      `SELECT id FROM shared_items WHERE message_id = ? AND (url = ? OR (url IS NULL AND ? IS NULL))`
    ).get(item.message_id, item.url, item.url) as any;
    if (existing) return false;

    db.prepare(`
      INSERT INTO shared_items (
        id, item_type, content, url, sender, sender_name, chat_jid,
        message_id, media_path, media_type, category, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id, item.item_type, item.content, item.url, item.sender,
      item.sender_name, item.chat_jid, item.message_id, item.media_path,
      item.media_type, item.category, item.status, item.created_at,
    );
    return true;
  } catch (err) {
    logger.warn({ err, itemId: item.id }, 'Failed to store shared item');
    return false;
  }
}

/** Get shared items by status. */
export function getSharedItems(status?: string, limit = 50): SharedItem[] {
  const query = status
    ? `SELECT * FROM shared_items WHERE status = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM shared_items ORDER BY created_at DESC LIMIT ?`;
  const params = status ? [status, limit] : [limit];
  return db.prepare(query).all(...params) as SharedItem[];
}

/** Get count of new (unprocessed) shared items. */
export function getNewSharedItemCount(): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM shared_items WHERE status = 'new'`).get() as any;
  return row?.count || 0;
}

/** Get a single shared item by ID. */
export function getSharedItemById(id: string): SharedItem | undefined {
  return db.prepare(`SELECT * FROM shared_items WHERE id = ?`).get(id) as SharedItem | undefined;
}

/** Update status and notes on a shared item. Returns true if a row was updated. */
export function updateSharedItemStatus(id: string, status: string, notes?: string): boolean {
  const now = new Date().toISOString();
  const timestampCol = status === 'triaged' ? 'triaged_at' : status === 'acted_on' ? 'acted_on_at' : null;

  const sets = ['status = ?'];
  const params: unknown[] = [status];

  if (notes !== undefined) {
    sets.push('notes = ?');
    params.push(notes);
  }
  if (timestampCol) {
    sets.push(`${timestampCol} = ?`);
    params.push(now);
  }

  params.push(id);
  const result = db.prepare(`UPDATE shared_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return result.changes > 0;
}
