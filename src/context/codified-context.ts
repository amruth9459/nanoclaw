/**
 * Codified Context System (Tier 1 - Hot Cache)
 * Provides structured, instantly-accessible context that can be referenced in <2 tokens
 *
 * Based on research showing codified facts dramatically reduce context window usage
 * vs embedding full conversation history in every prompt.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

export interface CodedFact {
  id: string;
  category: 'system' | 'user_preference' | 'learned_fact' | 'active_project' | 'capability';
  key: string;
  value: string;
  confidence: number; // 0-1, how certain we are
  lastUpdated: number; // timestamp
  source?: string; // where this came from
  expiresAt?: number; // optional expiration
}

export interface ContextSnapshot {
  facts: CodedFact[];
  totalTokens: number; // approximate token count
  categories: Record<string, number>; // count per category
  generatedAt: number;
}

const SECTION_HEADER = '## Codified Context (Hot Cache)';

/**
 * Codified Context Manager
 * Maintains hot cache of structured facts for instant retrieval
 */
export class CodedContext {
  private facts: Map<string, CodedFact> = new Map();
  private readonly MAX_FACTS = 500; // Keep hot cache bounded
  private readonly groupFolder: string;

  constructor(groupFolder = 'main') {
    this.groupFolder = groupFolder;
    this.loadFromFiles();
  }

  private get memoryMdPath(): string {
    return path.join(process.cwd(), 'groups', this.groupFolder, 'MEMORY.md');
  }

  /**
   * Add or update a coded fact
   */
  set(category: CodedFact['category'], key: string, value: string, confidence: number = 1.0, source?: string): void {
    const id = `${category}:${key}`;

    this.facts.set(id, {
      id,
      category,
      key,
      value,
      confidence,
      lastUpdated: Date.now(),
      source,
    });

    // Evict oldest if over limit
    if (this.facts.size > this.MAX_FACTS) {
      this.evictOldest();
    }
  }

  /**
   * Get a coded fact by category and key
   */
  get(category: CodedFact['category'], key: string): CodedFact | undefined {
    const id = `${category}:${key}`;
    const fact = this.facts.get(id);

    // Check expiration
    if (fact?.expiresAt && fact.expiresAt < Date.now()) {
      this.facts.delete(id);
      return undefined;
    }

    return fact;
  }

  /**
   * Get all facts in a category
   */
  getCategory(category: CodedFact['category']): CodedFact[] {
    return Array.from(this.facts.values())
      .filter(f => f.category === category)
      .sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  /**
   * Search facts by key pattern
   */
  search(pattern: string): CodedFact[] {
    const regex = new RegExp(pattern, 'i');
    return Array.from(this.facts.values())
      .filter(f => regex.test(f.key) || regex.test(f.value));
  }

  /**
   * Generate a snapshot for injection into prompts
   * Returns minimal, structured context
   */
  snapshot(): ContextSnapshot {
    const validFacts = this.removeExpired();

    // Sort by confidence and recency
    const sorted = validFacts.sort((a, b) => {
      const aScore = a.confidence * 0.7 + (a.lastUpdated / Date.now()) * 0.3;
      const bScore = b.confidence * 0.7 + (b.lastUpdated / Date.now()) * 0.3;
      return bScore - aScore;
    });

    // Count by category
    const categories: Record<string, number> = {};
    for (const fact of validFacts) {
      categories[fact.category] = (categories[fact.category] || 0) + 1;
    }

    // Estimate tokens (rough: ~1 token per 4 chars)
    const totalTokens = sorted.reduce((sum, f) => {
      return sum + Math.ceil((f.key.length + f.value.length) / 4);
    }, 0);

    return {
      facts: sorted,
      totalTokens,
      categories,
      generatedAt: Date.now(),
    };
  }

  /**
   * Format snapshot as markdown for CLAUDE.md injection
   */
  toMarkdown(snapshot: ContextSnapshot): string {
    let md = `${SECTION_HEADER}\n\n`;
    md += `*Generated: ${new Date(snapshot.generatedAt).toISOString()}*\n`;
    md += `*Total Facts: ${snapshot.facts.length} (~${snapshot.totalTokens} tokens)*\n\n`;

    // Group by category
    const byCategory: Record<string, CodedFact[]> = {};
    for (const fact of snapshot.facts) {
      if (!byCategory[fact.category]) {
        byCategory[fact.category] = [];
      }
      byCategory[fact.category].push(fact);
    }

    // Output each category
    for (const [category, facts] of Object.entries(byCategory)) {
      md += `### ${category.replace(/_/g, ' ').toUpperCase()}\n\n`;

      for (const fact of facts) {
        const confidence = fact.confidence < 1.0 ? ` (${Math.round(fact.confidence * 100)}% confident)` : '';
        md += `- **${fact.key}:** ${fact.value}${confidence}\n`;
      }
      md += '\n';
    }

    return md;
  }

  /**
   * Load existing facts from MEMORY.md
   * Parses the Codified Context section, User Preferences, and Learned Facts
   */
  private loadFromFiles(): void {
    const memPath = this.memoryMdPath;

    if (!fs.existsSync(memPath)) return;

    try {
      const content = fs.readFileSync(memPath, 'utf-8');
      let loaded = 0;

      // Parse ## Codified Context (Hot Cache) section
      loaded += this.parseCodifiedSection(content);

      // Parse ## User Preferences section
      loaded += this.parseSimpleSection(content, '## User Preferences', 'user_preference');

      // Parse ## Learned Facts section
      loaded += this.parseSimpleSection(content, '## Learned Facts', 'learned_fact');

      // Parse ## Active Projects section
      loaded += this.parseSimpleSection(content, '## Active Projects', 'active_project');

      if (loaded > 0) {
        logger.info({ groupFolder: this.groupFolder, factsLoaded: loaded }, 'Loaded facts from MEMORY.md');
      }
    } catch (err) {
      logger.warn({ err, path: memPath }, 'Failed to load facts from MEMORY.md');
    }
  }

  /**
   * Parse the structured Codified Context section
   * Format: - **key:** value (XX% confident)
   * Subsections: ### CATEGORY_NAME
   */
  private parseCodifiedSection(content: string): number {
    const sectionStart = content.indexOf(SECTION_HEADER);
    if (sectionStart === -1) return 0;

    // Find next ## heading (end of this section)
    const afterHeader = content.indexOf('\n', sectionStart);
    const nextSection = content.indexOf('\n## ', afterHeader);
    const sectionContent = nextSection === -1
      ? content.slice(afterHeader)
      : content.slice(afterHeader, nextSection);

    let currentCategory: CodedFact['category'] = 'learned_fact';
    let loaded = 0;

    const categoryMap: Record<string, CodedFact['category']> = {
      'system': 'system',
      'user preference': 'user_preference',
      'learned fact': 'learned_fact',
      'active project': 'active_project',
      'capability': 'capability',
    };

    for (const line of sectionContent.split('\n')) {
      // Detect ### subsection (category)
      const subMatch = line.match(/^### (.+)$/);
      if (subMatch) {
        const catName = subMatch[1].trim().toLowerCase();
        currentCategory = categoryMap[catName] || 'learned_fact';
        continue;
      }

      // Parse fact lines: - **key:** value (XX% confident)
      const factMatch = line.match(/^- \*\*(.+?):\*\*\s*(.+?)(?:\s*\((\d+)% confident\))?\s*$/);
      if (factMatch) {
        const [, key, value, confStr] = factMatch;
        const confidence = confStr ? parseInt(confStr, 10) / 100 : 1.0;
        this.set(currentCategory, key.trim(), value.trim(), confidence, 'memory.md');
        loaded++;
      }
    }

    return loaded;
  }

  /**
   * Parse simple markdown sections (## User Preferences, ## Learned Facts, etc.)
   * Format: - key: value  OR  - **key:** value  OR  - description text
   */
  private parseSimpleSection(content: string, heading: string, category: CodedFact['category']): number {
    const sectionStart = content.indexOf(heading);
    if (sectionStart === -1) return 0;

    const afterHeader = content.indexOf('\n', sectionStart);
    const nextSection = content.indexOf('\n## ', afterHeader);
    const sectionContent = nextSection === -1
      ? content.slice(afterHeader)
      : content.slice(afterHeader, nextSection);

    let loaded = 0;

    for (const line of sectionContent.split('\n')) {
      // Skip empty lines and sub-headings
      if (!line.startsWith('- ')) continue;

      const text = line.slice(2).trim();

      // Try **key:** value format
      const boldMatch = text.match(/^\*\*(.+?):\*\*\s*(.+?)(?:\s*\((\d+)% confident\))?\s*$/);
      if (boldMatch) {
        const [, key, value, confStr] = boldMatch;
        const confidence = confStr ? parseInt(confStr, 10) / 100 : 0.9;
        this.set(category, key.trim(), value.trim(), confidence, 'memory.md');
        loaded++;
        continue;
      }

      // Try key: value format (without bold)
      const kvMatch = text.match(/^(.+?):\s+(.+)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        // Skip if key is too long (probably a sentence, not a fact)
        if (key.length <= 60) {
          this.set(category, key.trim(), value.trim(), 0.85, 'memory.md');
          loaded++;
          continue;
        }
      }

      // Plain list item — use the whole text as both key and value
      if (text.length > 5 && text.length <= 200) {
        const shortKey = text.slice(0, 60).replace(/[^a-zA-Z0-9_ -]/g, '').trim();
        if (shortKey) {
          this.set(category, shortKey, text, 0.8, 'memory.md');
          loaded++;
        }
      }
    }

    return loaded;
  }

  /**
   * Remove expired facts
   */
  private removeExpired(): CodedFact[] {
    const now = Date.now();
    const valid: CodedFact[] = [];

    for (const [id, fact] of this.facts.entries()) {
      if (fact.expiresAt && fact.expiresAt < now) {
        this.facts.delete(id);
      } else {
        valid.push(fact);
      }
    }

    return valid;
  }

  /**
   * Evict oldest facts when over limit
   */
  private evictOldest(): void {
    const sorted = Array.from(this.facts.entries())
      .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);

    const toRemove = sorted.slice(0, sorted.length - this.MAX_FACTS);
    for (const [id] of toRemove) {
      this.facts.delete(id);
    }
  }

  /**
   * Persist facts to MEMORY.md
   * Replaces the Codified Context section, preserving everything else
   */
  async persist(): Promise<void> {
    const snapshot = this.snapshot();
    if (snapshot.facts.length === 0) return;

    const md = this.toMarkdown(snapshot);
    const memPath = this.memoryMdPath;

    try {
      // Ensure directory exists
      const dir = path.dirname(memPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let existing = '';
      if (fs.existsSync(memPath)) {
        existing = fs.readFileSync(memPath, 'utf-8');
      }

      let updated: string;
      const sectionStart = existing.indexOf(SECTION_HEADER);

      if (sectionStart !== -1) {
        // Find the end of the section (next ## heading or end of file)
        const afterHeader = existing.indexOf('\n', sectionStart);
        let sectionEnd = existing.indexOf('\n## ', afterHeader);
        if (sectionEnd === -1) {
          sectionEnd = existing.length;
        }
        // Replace existing section
        updated = existing.slice(0, sectionStart) + md + existing.slice(sectionEnd);
      } else {
        // Append at end
        updated = existing.trimEnd() + '\n\n' + md;
      }

      // Atomic write: write to .tmp, rename over original
      const tmpPath = memPath + '.tmp';
      fs.writeFileSync(tmpPath, updated, 'utf-8');
      fs.renameSync(tmpPath, memPath);

      logger.info({ groupFolder: this.groupFolder, facts: snapshot.facts.length }, 'Persisted codified context to MEMORY.md');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist codified context');
    }
  }
}

/**
 * Singleton instance — initialized with default group folder.
 * Use createCodedContext() for other groups.
 */
export const codedContext = new CodedContext();

/**
 * Factory for non-default groups
 */
export function createCodedContext(groupFolder: string): CodedContext {
  return new CodedContext(groupFolder);
}

/**
 * Helper functions for common operations
 */

export function setSystemFact(key: string, value: string, confidence = 1.0): void {
  codedContext.set('system', key, value, confidence, 'system');
}

export function setUserPreference(key: string, value: string, confidence = 1.0): void {
  codedContext.set('user_preference', key, value, confidence, 'user');
}

export function learnFact(key: string, value: string, confidence = 0.8, source?: string): void {
  codedContext.set('learned_fact', key, value, confidence, source);
}

export function setActiveProject(key: string, value: string): void {
  codedContext.set('active_project', key, value, 1.0, 'user');
}

export function setCapability(key: string, value: string): void {
  codedContext.set('capability', key, value, 1.0, 'system');
}
