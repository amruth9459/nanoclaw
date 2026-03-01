/**
 * Codified Context System (Tier 1 - Hot Cache)
 * Provides structured, instantly-accessible context that can be referenced in <2 tokens
 *
 * Based on research showing codified facts dramatically reduce context window usage
 * vs embedding full conversation history in every prompt.
 */

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

/**
 * Codified Context Manager
 * Maintains hot cache of structured facts for instant retrieval
 */
export class CodedContext {
  private facts: Map<string, CodedFact> = new Map();
  private readonly MAX_FACTS = 500; // Keep hot cache bounded
  private readonly CLAUDE_MD_PATH = '/workspace/group/CLAUDE.md';
  private readonly MEMORY_MD_PATH = '/workspace/group/MEMORY.md';

  constructor() {
    this.loadFromFiles();
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
    let md = '# Codified Context (Hot Cache)\n\n';
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
      md += `## ${category.replace(/_/g, ' ').toUpperCase()}\n\n`;

      for (const fact of facts) {
        const confidence = fact.confidence < 1.0 ? ` (${Math.round(fact.confidence * 100)}% confident)` : '';
        md += `- **${fact.key}:** ${fact.value}${confidence}\n`;
      }
      md += '\n';
    }

    return md;
  }

  /**
   * Load existing facts from MEMORY.md and CLAUDE.md
   */
  private loadFromFiles(): void {
    // TODO: Parse existing markdown files to extract facts
    // For now, start with empty cache
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
   */
  async persist(): Promise<void> {
    const snapshot = this.snapshot();
    const md = this.toMarkdown(snapshot);

    // Write to MEMORY.md (append or replace section)
    // TODO: Implement file writing
  }
}

/**
 * Singleton instance
 */
export const codedContext = new CodedContext();

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
