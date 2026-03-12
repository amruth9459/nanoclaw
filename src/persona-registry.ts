/**
 * Persona Registry
 *
 * Scans ~/.claude/agents/ for persona files, registers them in the DB,
 * and provides matching for task dispatch.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

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
}

export interface PersonaMatch {
  persona: Persona;
  confidence: number;
  matchedKeywords: string[];
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

  /** Create the agent_personas table */
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

  /** Find the best persona for a task description */
  findBestPersona(taskDescription: string, requiredRole?: string): PersonaMatch | null {
    // Clean tokens: strip punctuation, split compounds (docker-compose → docker, compose)
    const rawTokens = taskDescription.toLowerCase()
      .split(/\s+/)
      .map(w => w.replace(/[^a-z0-9_./-]/g, ''))
      .filter(w => w.length > 2);
    // Also add sub-tokens from compound words (split on - and . but keep originals)
    const taskTokens = [...new Set(rawTokens.flatMap(t => {
      const parts = t.split(/[-.]/).filter(p => p.length > 2);
      return parts.length > 1 ? [t, ...parts] : [t];
    }))];
    let bestMatch: PersonaMatch | null = null;

    for (const persona of this.personas.values()) {
      if (!persona.active) continue;
      if (requiredRole && persona.roleMapping !== requiredRole) continue;

      // Score: keyword overlap between task tokens and specialties
      const matchedKeywords: string[] = [];
      for (const specialty of persona.specialties) {
        const specWords = specialty.split(/\s+/).map(s => s.replace(/[^a-z0-9_./-]/g, ''));
        for (const sw of specWords) {
          if (sw.length > 2 && !MATCH_STOP_WORDS.has(sw) && taskTokens.includes(sw) && !matchedKeywords.includes(sw)) {
            matchedKeywords.push(sw);
          }
        }
      }

      // Cap denominator at 15 so long task descriptions don't kill the score
      let score = matchedKeywords.length / Math.max(Math.min(taskTokens.length, 15), 1);

      // Department keyword bonus
      const deptWords = persona.department.split('-');
      for (const dw of deptWords) {
        if (taskTokens.includes(dw)) score += 0.15;
      }

      // Use raw score for threshold eligibility (penalties only affect ranking)
      const rawScore = Math.min(score, 1.0);

      // Recency penalty: prefer personas not recently dispatched (ranking only)
      if (persona.lastDispatchedAt) {
        const hoursSince = (Date.now() - new Date(persona.lastDispatchedAt).getTime()) / 3_600_000;
        if (hoursSince < 1) score *= 0.8;
        else if (hoursSince < 4) score *= 0.9;
      }

      // Dispatch count penalty (spread work across personas, ranking only)
      if (persona.dispatchedCount > 5) score *= 0.95;

      const confidence = Math.min(score, 1.0);

      if (!bestMatch || confidence > bestMatch.confidence) {
        // Report raw score as confidence (for threshold check in auto-dispatch)
        bestMatch = { persona, confidence: rawScore, matchedKeywords };
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
