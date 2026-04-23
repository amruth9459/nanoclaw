/**
 * Conversation history storage for RAG chains.
 *
 * Stores conversation turns (user + assistant messages) keyed by thread ID.
 * Uses the shared SQLite database (messages.db) with a sliding window that
 * keeps the last N turns per thread and auto-prunes old threads.
 */

import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

const DB_PATH = path.join(STORE_DIR, 'messages.db');

export interface ConversationTurn {
  id: number;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

function openDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conv_thread
      ON conversation_history(thread_id, timestamp DESC);
  `);
  return db;
}

/**
 * Add a conversation turn (user or assistant message) to a thread.
 */
export function addTurn(threadId: string, role: 'user' | 'assistant', content: string): void {
  const db = openDb();
  try {
    db.prepare(
      'INSERT INTO conversation_history (thread_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
    ).run(threadId, role, content, new Date().toISOString());
  } finally {
    db.close();
  }
}

/**
 * Get the most recent conversation turns for a thread.
 * Returns in chronological order (oldest first).
 */
export function getHistory(threadId: string, maxTurns = 10): ConversationTurn[] {
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT id, thread_id AS threadId, role, content, timestamp
      FROM conversation_history
      WHERE thread_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(threadId, maxTurns) as ConversationTurn[];
    return rows.reverse(); // chronological order
  } finally {
    db.close();
  }
}

/**
 * Clear all conversation history for a thread.
 */
export function clearHistory(threadId: string): number {
  const db = openDb();
  try {
    const result = db.prepare('DELETE FROM conversation_history WHERE thread_id = ?').run(threadId);
    return result.changes;
  } finally {
    db.close();
  }
}

/**
 * Prune threads older than maxAgeMs (default 7 days).
 * Removes all turns from threads where the newest turn is older than the cutoff.
 */
export function pruneOldThreads(maxAgeMs = 7 * 24 * 60 * 60 * 1000): { deleted: number } {
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    // Find threads where the most recent turn is older than the cutoff
    const staleThreads = db.prepare(`
      SELECT thread_id
      FROM conversation_history
      GROUP BY thread_id
      HAVING MAX(timestamp) < ?
    `).all(cutoff) as { thread_id: string }[];

    if (staleThreads.length === 0) return { deleted: 0 };

    const threadIds = staleThreads.map(r => r.thread_id);
    const placeholders = threadIds.map(() => '?').join(',');
    const result = db.prepare(
      `DELETE FROM conversation_history WHERE thread_id IN (${placeholders})`,
    ).run(...threadIds);

    logger.info({ deleted: result.changes, threads: threadIds.length, cutoff }, 'Pruned old conversation threads');
    return { deleted: result.changes };
  } finally {
    db.close();
  }
}

/**
 * Enforce sliding window: keep only the last maxTurns per thread.
 */
export function enforceWindow(threadId: string, maxTurns = 10): number {
  const db = openDb();
  try {
    // Delete turns older than the last maxTurns
    const result = db.prepare(`
      DELETE FROM conversation_history
      WHERE thread_id = ?
        AND id NOT IN (
          SELECT id FROM conversation_history
          WHERE thread_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `).run(threadId, threadId, maxTurns);
    return result.changes;
  } finally {
    db.close();
  }
}

/**
 * Format conversation history as a string for LLM prompts.
 */
export function formatHistory(turns: ConversationTurn[]): string {
  return turns
    .map(t => `${t.role === 'user' ? 'Human' : 'Assistant'}: ${t.content}`)
    .join('\n');
}
