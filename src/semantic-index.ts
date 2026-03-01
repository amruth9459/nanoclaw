/**
 * Semantic indexing with sqlite-vec.
 *
 * Embeds text using Claude Haiku (prompt → float32 vector via a
 * deterministic JSON array extraction) and stores them in a
 * sqlite-vec virtual table. Agents can search via the MCP tool
 * or the host can index OCR output and conversations automatically.
 *
 * Embedding model: we ask claude-haiku-4-5 to produce a 128-dim
 * float32 vector JSON array representing the semantic content of a
 * chunk. This avoids a separate embedding API dependency while
 * keeping latency low (haiku is fast).
 *
 * Dimensions: 128 (compact, fast, sufficient for personal-scale retrieval)
 */

import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import * as sqliteVec from 'sqlite-vec';

import { STORE_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const DIMS = 128;
const DB_PATH = path.join(STORE_DIR, 'messages.db');
const CHUNK_SIZE = 800;  // chars per chunk
const CHUNK_OVERLAP = 100;

// ── DB setup ───────────────────────────────────────────────────────────────────

function openVecDb(): Database.Database {
  const db = new Database(DB_PATH);
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_chunks (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      source   TEXT NOT NULL,        -- e.g. "ocr/scan_001.json" or "conversations/2026-01-01-foo.md"
      group_folder TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content  TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_semantic_source_chunk
      ON semantic_chunks(source, chunk_index);

    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_vec USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${DIMS}]
    );
  `);
  return db;
}

// ── Embedding via Claude Haiku ─────────────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const env = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY required for semantic indexing');
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

async function embedText(text: string): Promise<Float32Array> {
  const client = getClient();

  // Ask Haiku to produce a semantic embedding as a JSON float array.
  // We use a strict prompt so the output is parseable deterministically.
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Produce a ${DIMS}-dimensional semantic embedding for the following text.

Output ONLY a JSON array of ${DIMS} float numbers between -1 and 1. No explanation, no code block, just the raw JSON array starting with [ and ending with ].

Text to embed:
${text.slice(0, 1200)}`,
    }],
  });

  const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
  const match = raw.match(/\[[\s\S]+\]/);
  if (!match) throw new Error(`Embedding parse failed: ${raw.slice(0, 100)}`);

  const arr: number[] = JSON.parse(match[0]);
  if (arr.length !== DIMS) throw new Error(`Wrong dims: got ${arr.length}, expected ${DIMS}`);

  // L2-normalize for cosine similarity via dot product
  const norm = Math.sqrt(arr.reduce((s, x) => s + x * x, 0)) || 1;
  return new Float32Array(arr.map(x => x / norm));
}

// ── Chunking ───────────────────────────────────────────────────────────────────

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
    i += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter(c => c.trim().length > 20);
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface IndexResult {
  source: string;
  chunksIndexed: number;
  chunksSkipped: number;
}

/**
 * Index a text document. Skips chunks already indexed (by source + chunk_index).
 */
export async function indexDocument(
  source: string,
  groupFolder: string,
  content: string,
): Promise<IndexResult> {
  const db = openVecDb();
  const chunks = chunkText(content);
  let indexed = 0;
  let skipped = 0;

  const checkStmt = db.prepare(
    'SELECT id FROM semantic_chunks WHERE source = ? AND chunk_index = ?',
  );
  const insertChunk = db.prepare(`
    INSERT OR IGNORE INTO semantic_chunks (source, group_folder, chunk_index, content, indexed_at)
    VALUES (?, ?, ?, ?, ?)
    RETURNING id
  `);
  const insertVec = db.prepare(
    'INSERT OR REPLACE INTO semantic_vec (chunk_id, embedding) VALUES (?, ?)',
  );

  for (let i = 0; i < chunks.length; i++) {
    const existing = checkStmt.get(source, i);
    if (existing) { skipped++; continue; }

    try {
      const embedding = await embedText(chunks[i]);
      const row = insertChunk.get(source, groupFolder, i, chunks[i], new Date().toISOString()) as { id: number } | undefined;
      if (row) {
        insertVec.run(row.id, embedding);
        indexed++;
      }
    } catch (err) {
      logger.warn({ source, chunk: i, err }, 'Embedding failed for chunk');
    }
  }

  db.close();
  logger.info({ source, indexed, skipped }, 'Document indexed');
  return { source, chunksIndexed: indexed, chunksSkipped: skipped };
}

export interface SearchResult {
  source: string;
  groupFolder: string;
  chunkIndex: number;
  content: string;
  distance: number;
}

/**
 * Semantic search across all indexed documents.
 * Returns top-k results sorted by cosine distance (lower = more similar).
 */
export async function semanticSearch(
  query: string,
  topK = 5,
  groupFolder?: string,
): Promise<SearchResult[]> {
  const db = openVecDb();
  const queryVec = await embedText(query);

  const groupFilter = groupFolder
    ? "AND c.group_folder = '" + groupFolder.replace(/'/g, "''") + "'"
    : '';

  const rows = db.prepare(`
    SELECT
      c.source,
      c.group_folder,
      c.chunk_index,
      c.content,
      v.distance
    FROM semantic_vec v
    JOIN semantic_chunks c ON c.id = v.chunk_id
    WHERE v.embedding MATCH ?
      AND k = ?
      ${groupFilter}
    ORDER BY v.distance
  `).all(queryVec, topK) as SearchResult[];

  db.close();
  return rows;
}

/**
 * Index all OCR output files for a group folder.
 * Looks for JSON files in groups/{folder}/output/ and MD files in conversations/.
 */
export async function indexGroupFiles(groupFolder: string): Promise<void> {
  const GROUPS_DIR = path.join(process.cwd(), 'groups');
  const groupDir = path.join(GROUPS_DIR, groupFolder);

  // OCR output JSON files
  const ocrDir = path.join(groupDir, 'output');
  if (fs.existsSync(ocrDir)) {
    for (const file of fs.readdirSync(ocrDir).filter(f => f.endsWith('.json'))) {
      try {
        const content = fs.readFileSync(path.join(ocrDir, file), 'utf-8');
        const parsed = JSON.parse(content);
        const text = parsed.text || content;
        await indexDocument(`${groupFolder}/output/${file}`, groupFolder, text);
      } catch (err) {
        logger.warn({ file, err }, 'Failed to index OCR file');
      }
    }
  }

  // Conversation archives
  const convDir = path.join(groupDir, 'conversations');
  if (fs.existsSync(convDir)) {
    for (const file of fs.readdirSync(convDir).filter(f => f.endsWith('.md'))) {
      try {
        const content = fs.readFileSync(path.join(convDir, file), 'utf-8');
        await indexDocument(`${groupFolder}/conversations/${file}`, groupFolder, content);
      } catch (err) {
        logger.warn({ file, err }, 'Failed to index conversation file');
      }
    }
  }

  logger.info({ groupFolder }, 'Group file indexing complete');
}

/**
 * Return indexing stats.
 */
/**
 * Delete chunks older than maxAgeMs (default 6 months).
 * Removes both the chunk rows and their vector embeddings.
 */
export function pruneOldChunks(maxAgeMs = 6 * 30 * 24 * 60 * 60 * 1000): { deleted: number } {
  try {
    const db = openVecDb();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const oldIds = db.prepare(
      'SELECT id FROM semantic_chunks WHERE indexed_at < ?',
    ).all(cutoff) as { id: number }[];

    if (oldIds.length === 0) {
      db.close();
      return { deleted: 0 };
    }

    const ids = oldIds.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');

    db.prepare(`DELETE FROM semantic_vec WHERE chunk_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM semantic_chunks WHERE id IN (${placeholders})`).run(...ids);

    db.close();
    logger.info({ deleted: ids.length, cutoff }, 'Pruned old semantic chunks');
    return { deleted: ids.length };
  } catch (err) {
    logger.warn({ err }, 'Failed to prune old semantic chunks');
    return { deleted: 0 };
  }
}

export function getIndexStats(): { totalChunks: number; sources: number; groups: string[] } {
  try {
    const db = openVecDb();
    const stats = db.prepare(`
      SELECT count(*) as total, count(DISTINCT source) as sources
      FROM semantic_chunks
    `).get() as { total: number; sources: number };
    const groups = (db.prepare('SELECT DISTINCT group_folder FROM semantic_chunks').all() as { group_folder: string }[])
      .map(r => r.group_folder);
    db.close();
    return { totalChunks: stats.total, sources: stats.sources, groups };
  } catch {
    return { totalChunks: 0, sources: 0, groups: [] };
  }
}
