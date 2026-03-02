import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, INITIAL_BALANCE, STORE_DIR } from './config.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js';
import { logger } from './logger.js';

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

  // Lexios customer tracking (legacy DM model)
  database.exec(`
    CREATE TABLE IF NOT EXISTS lexios_customers (
      jid TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT,
      documents_analyzed INTEGER DEFAULT 0,
      pages_processed INTEGER DEFAULT 0,
      first_contact TEXT NOT NULL,
      last_contact TEXT,
      status TEXT DEFAULT 'active'
    );
  `);

  // Lexios per-building group model
  database.exec(`
    CREATE TABLE IF NOT EXISTS lexios_buildings (
      jid TEXT PRIMARY KEY,
      name TEXT,
      address TEXT,
      owner_phone TEXT NOT NULL,
      building_type TEXT,
      status TEXT DEFAULT 'active',
      subscription_tier TEXT DEFAULT 'beta',
      monthly_rate REAL DEFAULT 0,
      documents_count INTEGER DEFAULT 0,
      queries_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      last_activity TEXT
    );

    CREATE TABLE IF NOT EXISTS lexios_building_members (
      building_jid TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'viewer',
      can_upload INTEGER DEFAULT 0,
      can_query INTEGER DEFAULT 1,
      can_invite INTEGER DEFAULT 0,
      query_limit_daily INTEGER,
      queries_today INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      joined_at TEXT NOT NULL,
      last_active TEXT,
      PRIMARY KEY (building_jid, phone)
    );

    CREATE TABLE IF NOT EXISTS lexios_documents (
      id TEXT PRIMARY KEY,
      building_jid TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER,
      discipline TEXT,
      sheet_number TEXT,
      revision TEXT DEFAULT 'R1',
      is_latest INTEGER DEFAULT 1,
      replaces_id TEXT,
      uploaded_by TEXT,
      media_path TEXT,
      extraction_path TEXT,
      spatial_data_path TEXT,
      status TEXT DEFAULT 'active',
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lexios_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      building_jid TEXT NOT NULL,
      phone TEXT NOT NULL,
      query_text TEXT NOT NULL,
      category TEXT,
      complexity TEXT,
      route TEXT,
      answer_text TEXT,
      response_time_ms INTEGER,
      cost_usd REAL DEFAULT 0,
      was_helpful INTEGER,
      asked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lexios_security_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      building_jid TEXT,
      phone TEXT,
      input_text TEXT NOT NULL,
      threat_type TEXT NOT NULL,
      pattern_name TEXT NOT NULL,
      blocked INTEGER DEFAULT 1,
      logged_at TEXT NOT NULL
    );
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

  // Add model tracking columns to lexios_queries
  try {
    database.exec(`ALTER TABLE lexios_queries ADD COLUMN model_used TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(`ALTER TABLE lexios_queries ADD COLUMN model_tier TEXT`);
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

/**
 * Get new DMs from chats whose channel is 'lexios' and are NOT already in registeredJids.
 * Used to pick up Lexios customer messages that haven't been registered yet.
 */
export function getNewLexiosDMs(
  lastTimestamp: string,
  registeredJids: string[],
  botPrefix: string,
): NewMessage[] {
  const excludePlaceholders = registeredJids.length > 0
    ? `AND m.chat_jid NOT IN (${registeredJids.map(() => '?').join(',')})`
    : '';
  const sql = `
    SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content, m.timestamp,
           m.media_type, m.media_path, m.media_mimetype, m.media_size
    FROM messages m
    JOIN chats c ON c.jid = m.chat_jid
    WHERE m.timestamp > ?
      AND c.channel = 'lexios'
      AND c.is_group = 0
      AND m.is_bot_message = 0
      AND m.content NOT LIKE ?
      ${excludePlaceholders}
    ORDER BY m.timestamp
  `;
  const params: unknown[] = [lastTimestamp, `${botPrefix}:%`, ...registeredJids];
  return db.prepare(sql).all(...params) as NewMessage[];
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
  project: 'nanoclaw' | 'lexios';
  priority: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export function getKanbanItems(project: 'nanoclaw' | 'lexios'): KanbanItem[] {
  const items: KanbanItem[] = [];

  // Scheduled tasks → kanban items
  try {
    const tasks = db.prepare(`SELECT * FROM scheduled_tasks WHERE status != 'deleted'`).all() as Array<{
      id: string; group_folder: string; prompt: string; schedule_type: string;
      schedule_value: string; status: string; next_run: string | null; created_at: string;
    }>;
    for (const t of tasks) {
      const isLexios = t.group_folder.startsWith('lexios');
      if ((project === 'lexios') !== isLexios) continue;
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

  // Lexios buildings
  if (project === 'lexios') {
    try {
      const buildings = db.prepare(`SELECT * FROM lexios_buildings`).all() as Array<{
        id: string; name: string; status: string; created_at: string;
      }>;
      for (const b of buildings) {
        items.push({
          id: `building-${b.id}`,
          title: b.name,
          status: b.status === 'active' ? 'in_progress' : b.status === 'completed' ? 'done' : 'todo',
          source: 'building',
          project: 'lexios',
          priority: 1,
          createdAt: b.created_at,
        });
      }
    } catch { /* table may not exist */ }

    // Lexios documents
    try {
      const docs = db.prepare(`SELECT * FROM lexios_documents ORDER BY created_at DESC LIMIT 50`).all() as Array<{
        id: string; filename: string; status: string; created_at: string; building_id: string;
      }>;
      for (const d of docs) {
        items.push({
          id: `doc-${d.id}`,
          title: d.filename,
          status: d.status === 'processed' ? 'done' : d.status === 'processing' ? 'in_progress' : 'todo',
          source: 'document',
          project: 'lexios',
          priority: 2,
          createdAt: d.created_at,
          metadata: { buildingId: d.building_id },
        });
      }
    } catch { /* table may not exist */ }
  }

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

// ── Lexios customer tracking ──────────────────────────────────────────

export function registerLexiosCustomer(jid: string, phone: string, name?: string): void {
  db.prepare(`
    INSERT INTO lexios_customers (jid, phone, name, first_contact, last_contact)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      last_contact = excluded.last_contact,
      name = COALESCE(excluded.name, lexios_customers.name)
  `).run(jid, phone, name || null, new Date().toISOString(), new Date().toISOString());
}

export function trackDocumentAnalysis(jid: string, pages: number): void {
  db.prepare(`
    UPDATE lexios_customers
    SET documents_analyzed = documents_analyzed + 1,
        pages_processed = pages_processed + ?,
        last_contact = ?
    WHERE jid = ?
  `).run(pages, new Date().toISOString(), jid);
}

export interface LexiosCustomerStats {
  jid: string;
  phone: string;
  name: string | null;
  documents_analyzed: number;
  pages_processed: number;
  first_contact: string;
  last_contact: string | null;
  status: string;
}

export function getLexiosCustomerStats(): LexiosCustomerStats[] {
  return db.prepare(`
    SELECT * FROM lexios_customers ORDER BY last_contact DESC
  `).all() as LexiosCustomerStats[];
}

export function getLexiosCustomerSummary(): {
  total_customers: number;
  total_documents: number;
  total_pages: number;
  active_customers: number;
} {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total_customers,
      COALESCE(SUM(documents_analyzed), 0) as total_documents,
      COALESCE(SUM(pages_processed), 0) as total_pages,
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active_customers
    FROM lexios_customers
  `).get() as { total_customers: number; total_documents: number; total_pages: number; active_customers: number };
  return row;
}

export function getLexiosCostSummary(): { total_cost: number; total_runs: number } {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) as total_cost, COUNT(*) as total_runs
    FROM usage_logs
    WHERE group_id LIKE 'lexios-%'
  `).get() as { total_cost: number; total_runs: number };
  return row;
}

// ── Lexios per-building group model ────────────────────────────────────

export interface LexiosBuilding {
  jid: string;
  name: string | null;
  address: string | null;
  owner_phone: string;
  building_type: string | null;
  status: string;
  subscription_tier: string;
  monthly_rate: number;
  documents_count: number;
  queries_count: number;
  created_at: string;
  last_activity: string | null;
}

export interface LexiosBuildingMember {
  building_jid: string;
  phone: string;
  name: string | null;
  role: string;
  can_upload: number;
  can_query: number;
  can_invite: number;
  query_limit_daily: number | null;
  queries_today: number;
  status: string;
  joined_at: string;
  last_active: string | null;
}

export interface LexiosDocument {
  id: string;
  building_jid: string;
  filename: string;
  file_type: string;
  file_size: number | null;
  discipline: string | null;
  sheet_number: string | null;
  revision: string;
  is_latest: number;
  replaces_id: string | null;
  uploaded_by: string | null;
  media_path: string | null;
  extraction_path: string | null;
  spatial_data_path: string | null;
  status: string;
  uploaded_at: string;
}

export interface LexiosQuery {
  id: number;
  building_jid: string;
  phone: string;
  query_text: string;
  category: string | null;
  complexity: string | null;
  route: string | null;
  answer_text: string | null;
  response_time_ms: number | null;
  cost_usd: number;
  was_helpful: number | null;
  asked_at: string;
}

export function registerLexiosBuilding(jid: string, ownerPhone: string, name?: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO lexios_buildings (jid, name, owner_phone, created_at, last_activity)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      last_activity = excluded.last_activity,
      name = COALESCE(excluded.name, lexios_buildings.name)
  `).run(jid, name || null, ownerPhone, now, now);

  // Auto-register owner as owner role
  addBuildingMember(jid, ownerPhone, 'owner');
}

export function getLexiosBuilding(jid: string): LexiosBuilding | undefined {
  return db.prepare('SELECT * FROM lexios_buildings WHERE jid = ?').get(jid) as LexiosBuilding | undefined;
}

export function updateLexiosBuilding(jid: string, updates: Partial<Pick<LexiosBuilding, 'name' | 'address' | 'building_type' | 'status'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.address !== undefined) { fields.push('address = ?'); values.push(updates.address); }
  if (updates.building_type !== undefined) { fields.push('building_type = ?'); values.push(updates.building_type); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (fields.length === 0) return;
  fields.push('last_activity = ?');
  values.push(new Date().toISOString());
  values.push(jid);
  db.prepare(`UPDATE lexios_buildings SET ${fields.join(', ')} WHERE jid = ?`).run(...values);
}

export function addBuildingMember(buildingJid: string, phone: string, role: string): void {
  const ROLE_PERMISSIONS: Record<string, { upload: number; query: number; invite: number }> = {
    owner:    { upload: 1, query: 1, invite: 1 },
    admin:    { upload: 1, query: 1, invite: 1 },
    uploader: { upload: 1, query: 1, invite: 0 },
    viewer:   { upload: 0, query: 1, invite: 0 },
  };
  const perms = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.viewer;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO lexios_building_members (building_jid, phone, role, can_upload, can_query, can_invite, joined_at, last_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(building_jid, phone) DO UPDATE SET
      role = excluded.role,
      can_upload = excluded.can_upload,
      can_query = excluded.can_query,
      can_invite = excluded.can_invite,
      last_active = excluded.last_active
  `).run(buildingJid, phone, role, perms.upload, perms.query, perms.invite, now, now);
}

export function getBuildingMembers(buildingJid: string): LexiosBuildingMember[] {
  return db.prepare('SELECT * FROM lexios_building_members WHERE building_jid = ? AND status = ?').all(buildingJid, 'active') as LexiosBuildingMember[];
}

export function checkBuildingPermission(buildingJid: string, phone: string, action: 'upload' | 'query' | 'invite' | 'remove' | 'billing'): boolean {
  const member = db.prepare('SELECT * FROM lexios_building_members WHERE building_jid = ? AND phone = ?').get(buildingJid, phone) as LexiosBuildingMember | undefined;
  if (!member || member.status !== 'active') return false;
  switch (action) {
    case 'upload': return member.can_upload === 1;
    case 'query': return member.can_query === 1;
    case 'invite': return member.can_invite === 1;
    case 'remove': return member.role === 'owner' || member.role === 'admin';
    case 'billing': return member.role === 'owner';
    default: return false;
  }
}

export function trackLexiosDocument(doc: {
  id: string;
  building_jid: string;
  filename: string;
  file_type: string;
  file_size?: number;
  discipline?: string;
  sheet_number?: string;
  revision?: string;
  replaces_id?: string;
  uploaded_by?: string;
  media_path?: string;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO lexios_documents (id, building_jid, filename, file_type, file_size, discipline, sheet_number, revision, replaces_id, uploaded_by, media_path, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    doc.id, doc.building_jid, doc.filename, doc.file_type,
    doc.file_size ?? null, doc.discipline ?? null, doc.sheet_number ?? null,
    doc.revision || 'R1', doc.replaces_id ?? null, doc.uploaded_by ?? null,
    doc.media_path ?? null, now,
  );
  // Update building document count
  db.prepare('UPDATE lexios_buildings SET documents_count = documents_count + 1, last_activity = ? WHERE jid = ?').run(now, doc.building_jid);
}

export function getLexiosBuildingDocuments(buildingJid: string): LexiosDocument[] {
  return db.prepare('SELECT * FROM lexios_documents WHERE building_jid = ? ORDER BY uploaded_at DESC').all(buildingJid) as LexiosDocument[];
}

export function updateDocumentRevision(oldId: string, newId: string): void {
  db.prepare('UPDATE lexios_documents SET is_latest = 0, status = ? WHERE id = ?').run('superseded', oldId);
}

/**
 * Save extraction results to disk and update the document record with the extraction path.
 * Returns the path where the extraction was saved.
 */
export function saveLexiosExtraction(
  buildingJid: string,
  groupFolder: string,
  documentFilename: string,
  extractionData: string,
): string {
  // Save extraction JSON to the group's lexios-results directory
  const groupDir = path.join(process.cwd(), 'groups', groupFolder);
  const resultsDir = path.join(groupDir, 'lexios-results');
  fs.mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = documentFilename.replace(/[^a-zA-Z0-9.-]/g, '_');
  const extractionFilename = `extraction-${safeName}-${timestamp}.json`;
  const extractionPath = path.join(resultsDir, extractionFilename);

  fs.writeFileSync(extractionPath, extractionData);

  // Also write a symlink/copy as the "latest" extraction for easy follow-up queries
  const latestPath = path.join(groupDir, 'lexios-work', 'extraction.json');
  fs.mkdirSync(path.join(groupDir, 'lexios-work'), { recursive: true });
  fs.writeFileSync(latestPath, extractionData);

  // Update the most recent document record for this building with the extraction path
  const doc = db.prepare(
    'SELECT id FROM lexios_documents WHERE building_jid = ? AND is_latest = 1 ORDER BY uploaded_at DESC LIMIT 1',
  ).get(buildingJid) as { id: string } | undefined;

  if (doc) {
    db.prepare('UPDATE lexios_documents SET extraction_path = ? WHERE id = ?').run(extractionPath, doc.id);
  }

  return extractionPath;
}

export function trackLexiosQuery(query: {
  building_jid: string;
  phone: string;
  query_text: string;
  category?: string;
  complexity?: string;
  route?: string;
  answer_text?: string;
  response_time_ms?: number;
  cost_usd?: number;
}): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO lexios_queries (building_jid, phone, query_text, category, complexity, route, answer_text, response_time_ms, cost_usd, asked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    query.building_jid, query.phone, query.query_text,
    query.category ?? null, query.complexity ?? null, query.route ?? null,
    query.answer_text ?? null, query.response_time_ms ?? null, query.cost_usd ?? 0, now,
  );
  // Update building query count
  db.prepare('UPDATE lexios_buildings SET queries_count = queries_count + 1, last_activity = ? WHERE jid = ?').run(now, query.building_jid);
}

export function getLexiosQueryStats(buildingJid: string): { total: number; by_category: Record<string, number> } {
  const total = (db.prepare('SELECT COUNT(*) as count FROM lexios_queries WHERE building_jid = ?').get(buildingJid) as { count: number }).count;
  const rows = db.prepare('SELECT category, COUNT(*) as count FROM lexios_queries WHERE building_jid = ? GROUP BY category').all(buildingJid) as Array<{ category: string | null; count: number }>;
  const by_category: Record<string, number> = {};
  for (const row of rows) by_category[row.category || 'uncategorized'] = row.count;
  return { total, by_category };
}

export function logSecurityEvent(buildingJid: string | null, phone: string | null, inputText: string, threatType: string, patternName: string): void {
  db.prepare(`
    INSERT INTO lexios_security_log (building_jid, phone, input_text, threat_type, pattern_name, logged_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(buildingJid ?? null, phone ?? null, inputText.slice(0, 500), threatType, patternName, new Date().toISOString());
}

/**
 * Get new messages from Lexios channel groups (@g.us) that are NOT already registered.
 * Used to detect new building groups that need auto-registration.
 */
export function getNewLexiosGroupMessages(
  lastTimestamp: string,
  registeredJids: string[],
  botPrefix: string,
): NewMessage[] {
  const excludePlaceholders = registeredJids.length > 0
    ? `AND m.chat_jid NOT IN (${registeredJids.map(() => '?').join(',')})`
    : '';
  const sql = `
    SELECT m.id, m.chat_jid, m.sender, m.sender_name, m.content, m.timestamp,
           m.media_type, m.media_path, m.media_mimetype, m.media_size
    FROM messages m
    JOIN chats c ON c.jid = m.chat_jid
    WHERE m.timestamp > ?
      AND c.channel = 'lexios'
      AND c.is_group = 1
      AND m.is_bot_message = 0
      AND m.content NOT LIKE ?
      ${excludePlaceholders}
    ORDER BY m.timestamp
  `;
  const params: unknown[] = [lastTimestamp, `${botPrefix}:%`, ...registeredJids];
  return db.prepare(sql).all(...params) as NewMessage[];
}

export function getLexiosBuildingSummary(): {
  total_buildings: number;
  total_documents: number;
  total_queries: number;
  active_buildings: number;
  buildings: LexiosBuilding[];
} {
  const buildings = db.prepare('SELECT * FROM lexios_buildings ORDER BY last_activity DESC').all() as LexiosBuilding[];
  return {
    total_buildings: buildings.length,
    total_documents: buildings.reduce((s, b) => s + b.documents_count, 0),
    total_queries: buildings.reduce((s, b) => s + b.queries_count, 0),
    active_buildings: buildings.filter(b => b.status === 'active').length,
    buildings,
  };
}


// ── Lexios Training Metrics (reads eval.db) ────────────────────────

let evalDb: Database.Database | null = null;

function openEvalDb(): Database.Database | null {
  if (evalDb) return evalDb;
  const evalDbPath = path.join(process.env.HOME || '', 'Lexios', 'lexios', 'eval.db');
  try {
    if (!fs.existsSync(evalDbPath)) return null;
    evalDb = new Database(evalDbPath, { readonly: true });
    return evalDb;
  } catch {
    return null;
  }
}

export interface LexiosMetrics {
  corpus: {
    total_docs: number;
    by_type: Record<string, number>;
    by_difficulty: Record<string, number>;
    types_covered: number;
    types_total: number;
    growth: { date: string; docs: number }[];
  };
  models: Record<string, {
    avg_f1: number;
    trend: number[];
    cost_per_doc: number;
  }>;
  learnings: {
    total_tips: number;
    by_category: Record<string, number>;
  };
  substitution_candidates: {
    category: string;
    local_model: string;
    local_f1: number;
    cloud_f1: number;
    ready: boolean;
  }[];
  recent_runs: {
    doc_id: string;
    date: string;
    models: number;
    elements: number;
  }[];
}

export function getLexiosMetrics(): LexiosMetrics | null {
  const edb = openEvalDb();
  if (!edb) return null;

  try {
    // Corpus docs
    const docs = edb.prepare(
      'SELECT doc_id, doc_type, difficulty, added_at FROM corpus_docs ORDER BY added_at DESC'
    ).all() as { doc_id: string; doc_type: string; difficulty: string; added_at: string }[];

    const byType: Record<string, number> = {};
    const byDiff: Record<string, number> = {};
    for (const d of docs) {
      byType[d.doc_type] = (byType[d.doc_type] || 0) + 1;
      byDiff[d.difficulty] = (byDiff[d.difficulty] || 0) + 1;
    }

    // Growth: docs added per day
    const growthMap: Record<string, number> = {};
    for (const d of docs) {
      const date = d.added_at.slice(0, 10);
      growthMap[date] = (growthMap[date] || 0) + 1;
    }
    let cumulative = 0;
    const growth = Object.entries(growthMap).sort().map(([date, count]) => {
      cumulative += count;
      return { date, docs: cumulative };
    });

    // Type coverage from model_performance
    let typesCovered = 0;
    let typesTotal = 101;
    try {
      const covered = edb.prepare(
        'SELECT COUNT(DISTINCT category) as c FROM model_performance'
      ).get() as { c: number } | undefined;
      typesCovered = covered?.c || 0;
    } catch { /* table may not exist yet */ }

    // Model performance
    const models: Record<string, { avg_f1: number; trend: number[]; cost_per_doc: number }> = {};
    try {
      const modelRows = edb.prepare(`
        SELECT model, AVG(f1) as avg_f1, AVG(cost_usd) as avg_cost
        FROM model_performance
        GROUP BY model
      `).all() as { model: string; avg_f1: number; avg_cost: number }[];

      for (const row of modelRows) {
        // Get trend: F1 per run in chronological order (use _overall rows)
        const trendRows = edb.prepare(`
          SELECT f1 FROM model_performance
          WHERE model = ? AND category = '_overall'
          ORDER BY run_at
        `).all(row.model) as { f1: number }[];

        models[row.model] = {
          avg_f1: Math.round((row.avg_f1 || 0) * 1000) / 1000,
          trend: trendRows.map(t => Math.round((t.f1 || 0) * 1000) / 1000),
          cost_per_doc: Math.round((row.avg_cost || 0) * 10000) / 10000,
        };
      }
    } catch { /* table may not exist yet */ }

    // Learnings
    const learnings = { total_tips: 0, by_category: {} as Record<string, number> };
    try {
      const learningsPath = path.join(process.env.HOME || '', 'Lexios', 'lexios', 'learnings.json');
      if (fs.existsSync(learningsPath)) {
        const data = JSON.parse(fs.readFileSync(learningsPath, 'utf-8'));
        for (const [cat, tips] of Object.entries(data)) {
          if (Array.isArray(tips)) {
            learnings.total_tips += tips.length;
            learnings.by_category[cat] = tips.length;
          }
        }
      }
    } catch { /* learnings file may not exist */ }

    // Substitution candidates
    const substitutionCandidates: LexiosMetrics['substitution_candidates'] = [];
    try {
      const cloudModels = new Set(['claude', 'gpt4.1', 'gemini']);
      const perfRows = edb.prepare(`
        SELECT model, category, AVG(f1) as avg_f1, COUNT(DISTINCT doc_id) as docs
        FROM model_performance
        GROUP BY model, category
        HAVING docs >= 3
      `).all() as { model: string; category: string; avg_f1: number; docs: number }[];

      const byCat: Record<string, Record<string, number>> = {};
      for (const r of perfRows) {
        if (!byCat[r.category]) byCat[r.category] = {};
        byCat[r.category][r.model] = r.avg_f1;
      }

      for (const [cat, modelF1s] of Object.entries(byCat)) {
        const cloudF1 = Math.max(...Object.entries(modelF1s)
          .filter(([m]) => cloudModels.has(m))
          .map(([, f]) => f), 0);
        for (const [model, f1] of Object.entries(modelF1s)) {
          if (!cloudModels.has(model) && model !== 'dxf_programmatic') {
            substitutionCandidates.push({
              category: cat,
              local_model: model,
              local_f1: Math.round(f1 * 1000) / 1000,
              cloud_f1: Math.round(cloudF1 * 1000) / 1000,
              ready: cloudF1 > 0 && f1 / cloudF1 >= 0.85,
            });
          }
        }
      }
    } catch { /* table may not exist */ }

    // Recent runs (from model_performance — group by doc_id + run_at date)
    const recentRuns: LexiosMetrics['recent_runs'] = [];
    try {
      const runRows = edb.prepare(`
        SELECT doc_id, DATE(run_at) as date,
               COUNT(DISTINCT model) as models,
               SUM(elements_found) as elements
        FROM model_performance
        GROUP BY doc_id, DATE(run_at)
        ORDER BY date DESC
        LIMIT 10
      `).all() as { doc_id: string; date: string; models: number; elements: number }[];

      for (const r of runRows) {
        recentRuns.push({
          doc_id: r.doc_id,
          date: r.date,
          models: r.models,
          elements: r.elements || 0,
        });
      }
    } catch { /* table may not exist */ }

    return {
      corpus: {
        total_docs: docs.length,
        by_type: byType,
        by_difficulty: byDiff,
        types_covered: typesCovered,
        types_total: typesTotal,
        growth,
      },
      models,
      learnings,
      substitution_candidates: substitutionCandidates,
      recent_runs: recentRuns,
    };
  } catch {
    return null;
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
}

/**
 * Create a new task
 */
export function createTaskRecord(params: {
  description: string;
  goalId?: string | null;
  complexity?: TaskRecord['complexity'];
  estimatedHours?: number | null;
  priority?: number;
  dependencies?: string[];
  assignedAgent?: string | null;
}): TaskRecord {
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  const task: TaskRecord = {
    id: taskId,
    goalId: params.goalId || null,
    description: params.description,
    complexity: params.complexity || 'moderate',
    estimatedHours: params.estimatedHours || null,
    status: 'pending',
    priority: params.priority || 3,
    dependencies: params.dependencies || [],
    assignedAgent: params.assignedAgent || null,
    createdAt: now,
    completedAt: null,
  };

  db.prepare(`
    INSERT INTO tasks (
      id, goal_id, description, complexity, estimated_hours,
      status, priority, dependencies, assigned_agent,
      created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    task.completedAt
  );

  logger.info({ taskId, description: task.description }, 'Task created');
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
