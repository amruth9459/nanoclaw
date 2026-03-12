/**
 * Persona Registry
 *
 * Scans ~/.claude/agents/ for persona files, registers them in the DB,
 * and provides matching for task dispatch.
 *
 * Supports semantic matching via Claude Haiku embeddings (128-dim float32).
 * Domain descriptions are auto-generated from persona .md files and cached
 * in sqlite-vec for fast cosine similarity lookups.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { embedText } from './semantic-index.js';

export interface Persona {
  id: string;
  name: string;
  department: string;
  filePath: string;
  specialties: string[];
  roleMapping: string;
  modelTier: string;
  active: boolean;
  dispatchedCount: number;
  lastDispatchedAt: string | null;
  domainDescription?: string;
  embedding?: Float32Array;
}

export interface PersonaMatch {
  persona: Persona;
  confidence: number;
  matchedKeywords: string[];
  semanticScore?: number;
  keywordScore?: number;
}

const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');

// Stop words to exclude from matching (too generic, cause false positives)
const MATCH_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'into',
  'using', 'their', 'your', 'will', 'can', 'all', 'not', 'but', 'are',
  'been', 'they', 'them', 'than', 'its', 'full', 'use', 'new', 'any',
  'user', 'code', 'work', 'make', 'also',
]);

// Department → role mapping
const DEPT_ROLE_MAP: Record<string, string> = {
  engineering: 'developer',
  development: 'developer',
  design: 'designer',
  marketing: 'marketer',
  product: 'product',
  'project-management': 'project-manager',
  qa: 'tester',
  testing: 'tester',
  security: 'security',
  strategy: 'strategist',
  support: 'support',
  specialized: 'specialist',
  operations: 'operations',
  planning: 'planner',
  'game-dev': 'developer',
  'spatial-computing': 'developer',
};

export class PersonaRegistry {
  private db: Database.Database;
  private personas: Map<string, Persona> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
  }

  private vecLoaded = false;

  /** Create the agent_personas table and embedding tables */
  initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_personas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        department TEXT NOT NULL,
        file_path TEXT NOT NULL,
        specialties TEXT NOT NULL,
        role_mapping TEXT NOT NULL,
        model_tier TEXT DEFAULT 'cloud',
        active INTEGER DEFAULT 1,
        dispatched_count INTEGER DEFAULT 0,
        last_dispatched_at TEXT,
        registered_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_personas_dept ON agent_personas(department);
      CREATE INDEX IF NOT EXISTS idx_personas_role ON agent_personas(role_mapping);
      CREATE INDEX IF NOT EXISTS idx_personas_active ON agent_personas(active);
    `);

    // Add domain_description column (idempotent)
    try {
      this.db.exec('ALTER TABLE agent_personas ADD COLUMN domain_description TEXT');
    } catch { /* column already exists */ }

    // Load sqlite-vec for virtual table support (guard against double-load)
    if (!this.vecLoaded) {
      try {
        sqliteVec.load(this.db);
        this.vecLoaded = true;
      } catch (err: any) {
        // Already loaded on this connection (e.g. shared db handle)
        if (!String(err).includes('already loaded')) {
          logger.warn({ err }, 'Failed to load sqlite-vec for persona registry');
        }
        this.vecLoaded = true;
      }
    }

    // Embedding cache metadata + vec0 virtual table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_embedding_meta (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        persona_id TEXT NOT NULL UNIQUE,
        embedded_at TEXT NOT NULL,
        source_hash TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS persona_vec USING vec0(
        persona_rowid INTEGER PRIMARY KEY,
        embedding float[128]
      );
    `);
  }

  /** Scan ~/.claude/agents/ and register all persona files */
  async scan(): Promise<number> {
    if (!fs.existsSync(AGENTS_DIR)) {
      logger.warn({ dir: AGENTS_DIR }, 'Agents directory not found');
      return 0;
    }

    const upsert = this.db.prepare(`
      INSERT INTO agent_personas (id, name, department, file_path, specialties, role_mapping, registered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        file_path = excluded.file_path,
        specialties = excluded.specialties,
        role_mapping = excluded.role_mapping
    `);

    let count = 0;
    const departments = fs.readdirSync(AGENTS_DIR).filter(d => {
      const fullPath = path.join(AGENTS_DIR, d);
      return fs.statSync(fullPath).isDirectory();
    });

    for (const dept of departments) {
      const deptDir = path.join(AGENTS_DIR, dept);
      const files = fs.readdirSync(deptDir).filter(f => f.endsWith('.md'));

      for (const file of files) {
        const filePath = path.join(deptDir, file);
        const persona = this.parsePersonaFile(filePath, dept);
        if (persona) {
          upsert.run(
            persona.id,
            persona.name,
            persona.department,
            persona.filePath,
            JSON.stringify(persona.specialties),
            persona.roleMapping,
            new Date().toISOString(),
          );
          this.personas.set(persona.id, persona);
          count++;
        }
      }
    }

    // Load all from DB into memory
    this.loadFromDb();

    // Apply tuning overrides from autoresearch
    this.loadTuningOverrides();

    logger.info({ count, departments: departments.length }, 'Persona registry loaded');
    return count;
  }

  /** Parse a persona .md file, extracting YAML frontmatter + keywords */
  private parsePersonaFile(filePath: string, department: string): Persona | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const fileName = path.basename(filePath, '.md');

      // Parse YAML frontmatter
      let name = fileName;
      let description = '';
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (frontmatterMatch) {
        const fm = frontmatterMatch[1];
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
      }

      // Extract specialties from description + content keywords
      const specialties = this.extractSpecialties(description, content);

      return {
        id: fileName,
        name,
        department,
        filePath,
        specialties,
        roleMapping: DEPT_ROLE_MAP[department] || 'specialist',
        modelTier: 'cloud',
        active: true,
        dispatchedCount: 0,
        lastDispatchedAt: null,
      };
    } catch (err) {
      logger.warn({ filePath, err }, 'Failed to parse persona file');
      return null;
    }
  }

  /** Extract specialty keywords from persona description and content */
  private extractSpecialties(description: string, content: string): string[] {
    const keywords = new Set<string>();
    const text = (description + ' ' + content).toLowerCase();

    // Extract keywords from common patterns
    const patterns = [
      /specializ\w+ in ([^.]+)/gi,
      /expert (?:in |at )([^.]+)/gi,
      /focus\w+ on ([^.]+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const words = match[1].split(/[,;]|\band\b/).map(w => w.trim().toLowerCase());
        for (const w of words) {
          if (w.length > 2 && w.length < 40) keywords.add(w);
        }
      }
    }

    // Also add words from the description
    if (description) {
      const descWords = description.toLowerCase()
        .split(/[\s,;]+/)
        .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have'].includes(w));
      for (const w of descWords) keywords.add(w);
    }

    return [...keywords].slice(0, 20);
  }

  /** Load all personas from DB into memory cache */
  private loadFromDb(): void {
    const rows = this.db.prepare('SELECT * FROM agent_personas WHERE active = 1').all() as any[];
    this.personas.clear();
    for (const row of rows) {
      this.personas.set(row.id, {
        id: row.id,
        name: row.name,
        department: row.department,
        filePath: row.file_path,
        specialties: JSON.parse(row.specialties),
        roleMapping: row.role_mapping,
        modelTier: row.model_tier,
        active: !!row.active,
        dispatchedCount: row.dispatched_count,
        lastDispatchedAt: row.last_dispatched_at,
      });
    }
  }

  /** Load tuning overrides from persona-autoresearch */
  private loadTuningOverrides(): void {
    const tuningPath = path.join(GROUPS_DIR, 'main', 'persona-autoresearch', 'persona-tuning.json');
    if (!fs.existsSync(tuningPath)) return;

    try {
      const tuning = JSON.parse(fs.readFileSync(tuningPath, 'utf-8'));
      let applied = 0;

      for (const [id, override] of Object.entries(tuning.overrides || {})) {
        const persona = this.personas.get(id);
        const ov = override as { specialties?: string[]; boost_keywords?: string[] };
        if (!persona) continue;

        if (ov.specialties) {
          const merged = [...new Set([...ov.specialties, ...persona.specialties])];
          persona.specialties = merged.slice(0, 30);
          applied++;
        }

        if (ov.boost_keywords) {
          const existing = new Set(persona.specialties);
          for (const kw of ov.boost_keywords) {
            if (!existing.has(kw)) {
              persona.specialties.push(kw);
              existing.add(kw);
            }
          }
          persona.specialties = persona.specialties.slice(0, 30);
        }
      }

      if (applied > 0) {
        logger.info({ applied }, 'Applied persona tuning overrides');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load persona tuning overrides');
    }
  }

  /** Generate a rich domain description from a persona's .md file for embedding */
  private generateDomainDescription(persona: Persona): string {
    // Check for manual override in persona-tuning.json
    const tuningPath = path.join(GROUPS_DIR, 'main', 'persona-autoresearch', 'persona-tuning.json');
    if (fs.existsSync(tuningPath)) {
      try {
        const tuning = JSON.parse(fs.readFileSync(tuningPath, 'utf-8'));
        const override = tuning.overrides?.[persona.id]?.domain_description;
        if (override) return override;
      } catch { /* fall through to auto-generation */ }
    }

    const parts: string[] = [];

    try {
      const content = fs.readFileSync(persona.filePath, 'utf-8');

      // 1. Frontmatter description
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
        if (descMatch) parts.push(descMatch[1].trim());
      }

      // 2. Department
      parts.push(`Department: ${persona.department}`);

      // 3. Specialties
      if (persona.specialties.length > 0) {
        parts.push(`Specialties: ${persona.specialties.join(', ')}`);
      }

      // 4. First 5 actionable bullet points from body
      const body = fmMatch ? content.slice(fmMatch[0].length) : content;
      const bullets = body.match(/^[-*]\s+\*?\*?(.+)/gm);
      if (bullets) {
        const actionable = bullets
          .map(b => b.replace(/^[-*]\s+\*?\*?/, '').replace(/\*?\*?$/, '').trim())
          .filter(b => b.length > 10 && b.length < 200)
          .slice(0, 5);
        if (actionable.length > 0) {
          parts.push('Capabilities: ' + actionable.join('. '));
        }
      }
    } catch {
      // Fallback to basic info
      parts.push(`${persona.name} - ${persona.department}`);
      if (persona.specialties.length > 0) {
        parts.push(`Specialties: ${persona.specialties.join(', ')}`);
      }
    }

    return parts.join('. ');
  }

  /**
   * Embed all personas. Call after scan().
   * Caches embeddings by content hash — only re-embeds when description changes.
   * Returns the number of personas that were newly embedded (API calls made).
   */
  async embedPersonas(): Promise<number> {
    let embedded = 0;

    const getMeta = this.db.prepare(
      'SELECT rowid, source_hash FROM persona_embedding_meta WHERE persona_id = ?',
    );
    const upsertMeta = this.db.prepare(`
      INSERT INTO persona_embedding_meta (persona_id, embedded_at, source_hash)
      VALUES (?, ?, ?)
      ON CONFLICT(persona_id) DO UPDATE SET
        embedded_at = excluded.embedded_at,
        source_hash = excluded.source_hash
    `);
    const upsertVec = this.db.prepare(
      'INSERT OR REPLACE INTO persona_vec (persona_rowid, embedding) VALUES (?, ?)',
    );
    const getVec = this.db.prepare(
      'SELECT embedding FROM persona_vec WHERE persona_rowid = ?',
    );
    const updateDomainDesc = this.db.prepare(
      'UPDATE agent_personas SET domain_description = ? WHERE id = ?',
    );

    for (const persona of this.personas.values()) {
      try {
        const desc = this.generateDomainDescription(persona);
        persona.domainDescription = desc;
        updateDomainDesc.run(desc, persona.id);

        const hash = crypto.createHash('md5').update(desc).digest('hex');
        const meta = getMeta.get(persona.id) as { rowid: number; source_hash: string } | undefined;

        if (meta && meta.source_hash === hash) {
          // Cached — load embedding from DB (BigInt for vec0 primary key)
          const vecRow = getVec.get(BigInt(meta.rowid)) as { embedding: Buffer } | undefined;
          if (vecRow && vecRow.embedding) {
            // sqlite-vec returns raw bytes as Buffer — convert to Float32Array
            const buf = Buffer.isBuffer(vecRow.embedding) ? vecRow.embedding : Buffer.from(vecRow.embedding as any);
            persona.embedding = new Float32Array(buf.buffer, buf.byteOffset, 128);
            continue;
          }
        }

        // Need to embed (new or stale)
        const embedding = await embedText(desc);
        persona.embedding = embedding;

        // Store in meta table first to get rowid
        upsertMeta.run(persona.id, new Date().toISOString(), hash);
        const newMeta = getMeta.get(persona.id) as { rowid: number; source_hash: string };
        // vec0 requires INTEGER primary key — BigInt forces integer binding
        upsertVec.run(BigInt(newMeta.rowid), embedding);

        embedded++;
      } catch (err) {
        logger.warn({ personaId: persona.id, err }, 'Failed to embed persona');
      }
    }

    logger.info({ total: this.personas.size, embedded }, 'Persona embeddings loaded');
    return embedded;
  }

  /** Compute keyword overlap score (extracted from findBestPersona for reuse) */
  private computeKeywordScore(taskTokens: string[], persona: Persona): { score: number; matchedKeywords: string[] } {
    const matchedKeywords: string[] = [];
    for (const specialty of persona.specialties) {
      const specWords = specialty.split(/\s+/).map(s => s.replace(/[^a-z0-9_./-]/g, ''));
      for (const sw of specWords) {
        if (sw.length > 2 && !MATCH_STOP_WORDS.has(sw) && taskTokens.includes(sw) && !matchedKeywords.includes(sw)) {
          matchedKeywords.push(sw);
        }
      }
    }
    const score = matchedKeywords.length / Math.max(Math.min(taskTokens.length, 15), 1);
    return { score, matchedKeywords };
  }

  /** Tokenize a task description for keyword matching */
  private tokenizeTask(taskDescription: string): string[] {
    const rawTokens = taskDescription.toLowerCase()
      .split(/\s+/)
      .map(w => w.replace(/[^a-z0-9_./-]/g, ''))
      .filter(w => w.length > 2);
    return [...new Set(rawTokens.flatMap(t => {
      const parts = t.split(/[-.]/).filter(p => p.length > 2);
      return parts.length > 1 ? [t, ...parts] : [t];
    }))];
  }

  /**
   * Semantic persona matching using embeddings + keyword hybrid scoring.
   * Returns null if no persona exceeds the confidence threshold.
   */
  async findBestPersonaSemantic(taskDescription: string, requiredRole?: string): Promise<PersonaMatch | null> {
    let taskEmbedding: Float32Array;
    try {
      taskEmbedding = await embedText(taskDescription);
    } catch (err) {
      logger.warn({ err }, 'Task embedding failed, falling back to keyword matching');
      return this.findBestPersona(taskDescription, requiredRole);
    }

    const taskTokens = this.tokenizeTask(taskDescription);
    let bestMatch: PersonaMatch | null = null;
    let bestRankScore = -1;

    for (const persona of this.personas.values()) {
      if (!persona.active) continue;
      if (requiredRole && persona.roleMapping !== requiredRole) continue;
      if (!persona.embedding) continue;

      // Cosine similarity via dot product (both vectors are L2-normalized)
      let semanticScore = 0;
      for (let i = 0; i < 128; i++) {
        semanticScore += taskEmbedding[i] * persona.embedding[i];
      }
      // Clamp to [0, 1] — negative similarity means completely unrelated
      semanticScore = Math.max(0, Math.min(1, semanticScore));

      // Keyword score as secondary signal
      const { score: keywordScore, matchedKeywords } = this.computeKeywordScore(taskTokens, persona);

      // Hybrid: 75% semantic + 25% keyword
      let confidence = 0.75 * semanticScore + 0.25 * Math.min(keywordScore, 1.0);

      // Department bonus (reduced from 0.15 — semantic already captures domain)
      const deptWords = persona.department.split('-');
      for (const dw of deptWords) {
        if (taskTokens.includes(dw)) { confidence += 0.05; break; }
      }

      confidence = Math.min(confidence, 1.0);

      // Ranking score: apply recency + dispatch penalties (don't affect confidence threshold)
      let rankScore = confidence;
      if (persona.lastDispatchedAt) {
        const hoursSince = (Date.now() - new Date(persona.lastDispatchedAt).getTime()) / 3_600_000;
        if (hoursSince < 1) rankScore *= 0.8;
        else if (hoursSince < 4) rankScore *= 0.9;
      }
      if (persona.dispatchedCount > 5) rankScore *= 0.95;

      if (rankScore > bestRankScore) {
        bestRankScore = rankScore;
        bestMatch = { persona, confidence, matchedKeywords, semanticScore, keywordScore };
      }
    }

    // If no persona had embeddings, fall back to keyword matching
    if (!bestMatch) {
      logger.warn('No persona embeddings available, falling back to keyword matching');
      return this.findBestPersona(taskDescription, requiredRole);
    }

    return bestMatch;
  }

  /** Find the best persona for a task description (keyword-only fallback) */
  findBestPersona(taskDescription: string, requiredRole?: string): PersonaMatch | null {
    const taskTokens = this.tokenizeTask(taskDescription);
    let bestMatch: PersonaMatch | null = null;

    for (const persona of this.personas.values()) {
      if (!persona.active) continue;
      if (requiredRole && persona.roleMapping !== requiredRole) continue;

      const { score: keywordScore, matchedKeywords } = this.computeKeywordScore(taskTokens, persona);
      let score = keywordScore;

      // Department keyword bonus
      const deptWords = persona.department.split('-');
      for (const dw of deptWords) {
        if (taskTokens.includes(dw)) score += 0.15;
      }

      // Use raw score for threshold eligibility (penalties only affect ranking)
      const rawScore = Math.min(score, 1.0);

      // Recency penalty: prefer personas not recently dispatched (ranking only)
      let rankScore = score;
      if (persona.lastDispatchedAt) {
        const hoursSince = (Date.now() - new Date(persona.lastDispatchedAt).getTime()) / 3_600_000;
        if (hoursSince < 1) rankScore *= 0.8;
        else if (hoursSince < 4) rankScore *= 0.9;
      }

      // Dispatch count penalty (spread work across personas, ranking only)
      if (persona.dispatchedCount > 5) rankScore *= 0.95;

      if (!bestMatch || rankScore > (bestMatch as any)._rankScore) {
        bestMatch = { persona, confidence: rawScore, matchedKeywords };
        (bestMatch as any)._rankScore = rankScore;
      }
    }

    return bestMatch;
  }

  /** Mark a persona as dispatched */
  markDispatched(personaId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE agent_personas SET dispatched_count = dispatched_count + 1, last_dispatched_at = ? WHERE id = ?',
    ).run(now, personaId);

    const persona = this.personas.get(personaId);
    if (persona) {
      persona.dispatchedCount++;
      persona.lastDispatchedAt = now;
    }
  }

  /** Get all registered personas */
  getAll(): Persona[] {
    return [...this.personas.values()];
  }

  /** Get personas by department */
  getByDepartment(department: string): Persona[] {
    return [...this.personas.values()].filter(p => p.department === department);
  }

  /** Get a persona by ID */
  get(id: string): Persona | undefined {
    return this.personas.get(id);
  }

  /** Get recent dispatch activity */
  getRecentDispatches(limit = 20): any[] {
    return this.db.prepare(`
      SELECT id, name, department, dispatched_count, last_dispatched_at
      FROM agent_personas
      WHERE last_dispatched_at IS NOT NULL
      ORDER BY last_dispatched_at DESC
      LIMIT ?
    `).all(limit);
  }

  /** Get department summary */
  getDepartmentSummary(): Record<string, { total: number; active: number; dispatched: number }> {
    const summary: Record<string, { total: number; active: number; dispatched: number }> = {};
    for (const p of this.personas.values()) {
      if (!summary[p.department]) {
        summary[p.department] = { total: 0, active: 0, dispatched: 0 };
      }
      summary[p.department].total++;
      if (p.active) summary[p.department].active++;
      if (p.dispatchedCount > 0) summary[p.department].dispatched++;
    }
    return summary;
  }
}
