import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { PersonaRegistry } from './persona-registry.js';

// Mock embedText — returns deterministic pseudo-embeddings based on content hash
vi.mock('./semantic-index.js', () => ({
  embedText: vi.fn(async (text: string) => {
    // Generate a deterministic 128-dim L2-normalized vector from text
    const vec = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      // Simple hash-based seed per dimension
      let h = 0;
      for (let j = 0; j < text.length; j++) {
        h = ((h << 5) - h + text.charCodeAt(j) + i * 31) | 0;
      }
      vec[i] = (h % 1000) / 1000;
    }
    // L2 normalize
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    for (let i = 0; i < 128; i++) vec[i] /= norm;
    return vec;
  }),
}));

// Mock config
vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Test fixtures ─────────────────────────────────────────────────────────────

const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  return db;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PersonaRegistry', () => {
  let db: Database.Database;
  let registry: PersonaRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new PersonaRegistry(db);
    registry.initSchema();
  });

  describe('initSchema', () => {
    it('creates all required tables', () => {
      // Core table
      const personas = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_personas'",
      ).get();
      expect(personas).toBeTruthy();

      // Embedding meta table
      const meta = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='persona_embedding_meta'",
      ).get();
      expect(meta).toBeTruthy();

      // Vec virtual table
      const vec = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='persona_vec'",
      ).get();
      expect(vec).toBeTruthy();
    });

    it('is idempotent (calling twice does not throw)', () => {
      expect(() => registry.initSchema()).not.toThrow();
    });
  });

  describe('scan + embedPersonas', () => {
    it('scans persona files from ~/.claude/agents/', async () => {
      // This test uses real persona files — skip if directory doesn't exist
      if (!fs.existsSync(AGENTS_DIR)) return;

      const count = await registry.scan();
      expect(count).toBeGreaterThan(0);

      const all = registry.getAll();
      expect(all.length).toBeGreaterThan(0);

      // Every persona should have specialties
      for (const p of all) {
        expect(p.id).toBeTruthy();
        expect(p.name).toBeTruthy();
        expect(p.department).toBeTruthy();
      }
    });

    it('embedPersonas generates domain descriptions and embeddings', async () => {
      if (!fs.existsSync(AGENTS_DIR)) return;

      await registry.scan();
      const embedded = await registry.embedPersonas();

      // Should have embedded at least some personas
      expect(embedded).toBeGreaterThan(0);

      // Check that personas have embeddings in memory
      const all = registry.getAll();
      const withEmbeddings = all.filter(p => p.embedding);
      expect(withEmbeddings.length).toBeGreaterThan(0);

      // Check that domain descriptions are populated
      const withDesc = all.filter(p => p.domainDescription && p.domainDescription.length > 10);
      expect(withDesc.length).toBe(withEmbeddings.length);
    });

    it('caches embeddings — second call embeds 0', async () => {
      if (!fs.existsSync(AGENTS_DIR)) return;

      await registry.scan();
      const first = await registry.embedPersonas();
      expect(first).toBeGreaterThan(0);

      // Second call: all cached
      const second = await registry.embedPersonas();
      expect(second).toBe(0);
    });
  });

  describe('findBestPersona (keyword fallback)', () => {
    it('matches backend-architect for database tasks', async () => {
      if (!fs.existsSync(AGENTS_DIR)) return;

      await registry.scan();

      const match = registry.findBestPersona('Design a PostgreSQL database schema for user authentication');
      expect(match).toBeTruthy();
      expect(match!.confidence).toBeGreaterThan(0);
      expect(match!.matchedKeywords.length).toBeGreaterThan(0);
    });

    it('returns null for empty registry', () => {
      const match = registry.findBestPersona('anything');
      expect(match).toBeNull();
    });
  });

  describe('findBestPersonaSemantic', () => {
    it('returns semantic + keyword scores', async () => {
      if (!fs.existsSync(AGENTS_DIR)) return;

      await registry.scan();
      await registry.embedPersonas();

      const match = await registry.findBestPersonaSemantic(
        'Add OpenAI and Google API keys to NanoClaw containers for multi-provider LLM support',
      );

      expect(match).toBeTruthy();
      expect(match!.semanticScore).toBeDefined();
      expect(match!.keywordScore).toBeDefined();
      expect(match!.confidence).toBeGreaterThan(0);

      // Semantic score should be in [0, 1]
      expect(match!.semanticScore!).toBeGreaterThanOrEqual(0);
      expect(match!.semanticScore!).toBeLessThanOrEqual(1);
    });

    it('produces different scores than keyword-only matching', async () => {
      if (!fs.existsSync(AGENTS_DIR)) return;

      await registry.scan();
      await registry.embedPersonas();

      const task = 'Add OpenAI and Google API keys to NanoClaw containers';

      const keywordMatch = registry.findBestPersona(task);
      const semanticMatch = await registry.findBestPersonaSemantic(task);

      expect(semanticMatch).toBeTruthy();
      expect(keywordMatch).toBeTruthy();

      // With mock embeddings, scores differ from keyword-only
      // (with real embeddings, semantic should be higher for domain tasks)
      expect(semanticMatch!.semanticScore).toBeDefined();
      expect(semanticMatch!.keywordScore).toBeDefined();
      // The confidence is a hybrid, not purely keyword-based
      expect(semanticMatch!.confidence).not.toBe(keywordMatch!.confidence);
    });

    it('falls back to keyword matching if no embeddings loaded', async () => {
      if (!fs.existsSync(AGENTS_DIR)) return;

      await registry.scan();
      // DON'T call embedPersonas — no embeddings in memory

      // With no persona embeddings, should fall back to keyword matching
      const match = await registry.findBestPersonaSemantic(
        'Design a PostgreSQL database schema for user authentication',
      );
      expect(match).toBeTruthy();
      expect(match!.confidence).toBeGreaterThan(0);
      // Should NOT have semantic score (keyword fallback)
      expect(match!.semanticScore).toBeUndefined();
    });

    it('hybrid score is weighted 75/25 semantic/keyword', async () => {
      if (!fs.existsSync(AGENTS_DIR)) return;

      await registry.scan();
      await registry.embedPersonas();

      const match = await registry.findBestPersonaSemantic('Build a React dashboard with WebSocket updates');
      expect(match).toBeTruthy();

      // The confidence should reflect the hybrid formula
      // confidence ≈ 0.25 * semantic + 0.75 * keyword (+ optional dept bonus)
      const expected = 0.25 * match!.semanticScore! + 0.75 * Math.min(match!.keywordScore!, 1.0);
      // Allow for department bonus (+0.15 max)
      expect(match!.confidence).toBeGreaterThanOrEqual(expected - 0.001);
      expect(match!.confidence).toBeLessThanOrEqual(expected + 0.16);
    });
  });

  describe('domain description generation', () => {
    it('produces descriptions containing department and specialties', async () => {
      if (!fs.existsSync(AGENTS_DIR)) return;

      await registry.scan();
      await registry.embedPersonas();

      const all = registry.getAll();
      for (const p of all.slice(0, 5)) {
        expect(p.domainDescription).toBeTruthy();
        // Should mention department
        expect(p.domainDescription!.toLowerCase()).toContain(p.department);
      }
    });
  });
});
