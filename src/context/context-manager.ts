/**
 * Unified Context Manager (3-Tier Architecture)
 * Orchestrates hot cache, warm retrieval, and cold fetch
 *
 * Query flow:
 * 1. Check Tier 1 (Hot Cache - codified facts) - <2 tokens, instant
 * 2. If not found, check Tier 2 (Warm Retrieval - semantic search) - ~500 tokens, <1s
 * 3. If not found, check Tier 3 (Cold Fetch - Perplexity) - real-time web search
 */

import { codedContext, CodedFact, setSystemFact, learnFact } from './codified-context.js';
import { semanticSearch, SearchResult, indexConversationTurn } from './semantic-search.js';
import { perplexity, PerplexityResult } from './perplexity-integration.js';
import { MAIN_GROUP_FOLDER } from '../config.js';
import { logger } from '../logger.js';

export interface ContextQuery {
  query: string;
  category?: CodedFact['category']; // For tier 1 filtering
  groupFolder?: string; // Scope search to a group
  preferRecent?: boolean; // Prioritize recent information
  allowWebSearch?: boolean; // Whether to use tier 3 (default true)
  minConfidence?: number; // Filter threshold for facts (default 0.7)
}

export interface ContextResponse {
  answer: string;
  tier: 1 | 2 | 3; // Which tier provided the answer
  confidence: number; // 0-1
  sources: string[]; // Where the information came from
  facts?: CodedFact[]; // Relevant facts from tier 1
  searchResults?: SearchResult[]; // Relevant results from tier 2
  perplexityResult?: PerplexityResult; // Result from tier 3
  latencyMs: number; // Time to retrieve
}

/**
 * Context Manager
 * Unified interface to all 3 tiers of context retrieval
 */
export class ContextManager {
  /**
   * Retrieve context using 3-tier cascade
   *
   * 1. Tier 1 (Hot): Check codified facts - instant, <2 tokens
   * 2. Tier 2 (Warm): Semantic search over history - <1s
   * 3. Tier 3 (Cold): Perplexity web search - real-time
   */
  async query(options: ContextQuery): Promise<ContextResponse> {
    const startTime = Date.now();
    const minConfidence = options.minConfidence || 0.7;
    const allowWebSearch = options.allowWebSearch !== false; // Default true

    // TIER 1: Check hot cache (codified facts)
    const tier1Results = await this.queryTier1(options.query, options.category, minConfidence);

    if (tier1Results.facts.length > 0) {
      return {
        answer: this.formatFactsAsAnswer(tier1Results.facts),
        tier: 1,
        confidence: tier1Results.confidence,
        sources: tier1Results.facts.map(f => f.source || 'codified context').filter(Boolean) as string[],
        facts: tier1Results.facts,
        latencyMs: Date.now() - startTime,
      };
    }

    // TIER 2: Semantic search over conversation history and memory
    const tier2Results = await this.queryTier2(options.query, options.groupFolder);

    if (tier2Results.results.length > 0 && tier2Results.confidence >= minConfidence) {
      // Optionally promote to tier 1 if confidence is high
      if (tier2Results.confidence >= 0.85) {
        await this.promoteToHotCache(tier2Results.results);
      }

      return {
        answer: this.formatSearchResultsAsAnswer(tier2Results.results),
        tier: 2,
        confidence: tier2Results.confidence,
        sources: tier2Results.results.map(r => r.source),
        searchResults: tier2Results.results,
        latencyMs: Date.now() - startTime,
      };
    }

    // TIER 3: Real-time web search (if allowed)
    if (allowWebSearch && perplexity.isConfigured()) {
      try {
        const tier3Result = await this.queryTier3(options.query, options.preferRecent);

        // Index the result for future tier 2 retrieval
        await this.indexPerplexityResult(options.query, tier3Result);

        // Extract high-confidence facts for tier 1
        await this.extractFactsFromPerplexity(tier3Result);

        return {
          answer: tier3Result.answer,
          tier: 3,
          confidence: 0.8, // Perplexity results are generally reliable
          sources: tier3Result.sources.map(s => s.url),
          perplexityResult: tier3Result,
          latencyMs: Date.now() - startTime,
        };
      } catch (err) {
        logger.warn({ err }, 'Tier 3 (Perplexity) search failed, falling through');
      }
    }

    // No results found in any tier
    return {
      answer: 'I don\'t have information about that in my current context.',
      tier: 1,
      confidence: 0,
      sources: [],
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * TIER 1: Query codified facts (hot cache)
   */
  private async queryTier1(
    query: string,
    category?: CodedFact['category'],
    minConfidence = 0.7
  ): Promise<{ facts: CodedFact[]; confidence: number }> {
    let facts: CodedFact[];

    if (category) {
      // Search within specific category
      facts = codedContext.getCategory(category);
    } else {
      // Search across all facts using pattern matching
      facts = codedContext.search(query);
    }

    // Filter by confidence
    facts = facts.filter(f => f.confidence >= minConfidence);

    // Sort by confidence and recency
    facts.sort((a, b) => {
      const aScore = a.confidence * 0.7 + (a.lastUpdated / Date.now()) * 0.3;
      const bScore = b.confidence * 0.7 + (b.lastUpdated / Date.now()) * 0.3;
      return bScore - aScore;
    });

    const avgConfidence = facts.length > 0
      ? facts.reduce((sum, f) => sum + f.confidence, 0) / facts.length
      : 0;

    return { facts, confidence: avgConfidence };
  }

  /**
   * TIER 2: Semantic search (warm retrieval)
   */
  private async queryTier2(query: string, groupFolder?: string): Promise<{ results: SearchResult[]; confidence: number }> {
    const results = await semanticSearch.search({
      query,
      topK: 5,
      groupFolder: groupFolder || MAIN_GROUP_FOLDER,
      minRelevance: 0.6,
    });

    const avgConfidence = results.length > 0
      ? results.reduce((sum, r) => sum + r.relevance, 0) / results.length
      : 0;

    return { results, confidence: avgConfidence };
  }

  /**
   * TIER 3: Perplexity web search (cold fetch)
   */
  private async queryTier3(query: string, preferRecent = false): Promise<PerplexityResult> {
    const recencyFilter = preferRecent ? 'week' : undefined;

    return perplexity.search({
      query,
      model: 'sonar', // Fast, cost-effective
      returnRelatedQuestions: true,
      searchRecencyFilter: recencyFilter,
    });
  }

  /**
   * Promote tier 2 results to tier 1 (hot cache)
   */
  private async promoteToHotCache(results: SearchResult[]): Promise<void> {
    const facts = semanticSearch.searchResultsToFacts(results);

    for (const fact of facts) {
      codedContext.set(
        fact.category,
        fact.key,
        fact.value,
        fact.confidence,
        fact.source
      );
    }
  }

  /**
   * Index Perplexity result for future tier 2 retrieval
   */
  private async indexPerplexityResult(query: string, result: PerplexityResult): Promise<void> {
    const content = `${query}\n\n${result.answer}\n\nSources: ${result.sources.map(s => s.url).join(', ')}`;
    await semanticSearch.indexDocument(`perplexity:${Date.now()}`, content, MAIN_GROUP_FOLDER);
  }

  /**
   * Extract high-confidence facts from Perplexity results
   */
  private async extractFactsFromPerplexity(result: PerplexityResult): Promise<void> {
    // Simple extraction - look for key: value patterns
    const lines = result.answer.split('\n');

    for (const line of lines) {
      const match = line.match(/^(.+?):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        learnFact(
          key.trim(),
          value.trim(),
          0.75, // Medium confidence - came from web search
          result.sources[0]?.url
        );
      }
    }
  }

  /**
   * Format facts as natural language answer
   */
  private formatFactsAsAnswer(facts: CodedFact[]): string {
    if (facts.length === 0) {
      return 'No relevant facts found.';
    }

    if (facts.length === 1) {
      return facts[0].value;
    }

    // Multiple facts - format as list
    return facts.map(f => `• ${f.key}: ${f.value}`).join('\n');
  }

  /**
   * Format search results as natural language answer
   */
  private formatSearchResultsAsAnswer(results: SearchResult[]): string {
    if (results.length === 0) {
      return 'No relevant information found.';
    }

    if (results.length === 1) {
      return results[0].content;
    }

    // Multiple results - combine top results
    return results.slice(0, 3).map(r => r.content).join('\n\n');
  }

  /**
   * Record a conversation turn for future retrieval
   */
  async recordConversationTurn(turnId: string, userMessage: string, assistantResponse: string, groupFolder?: string): Promise<void> {
    const content = `User: ${userMessage}\n\nAssistant: ${assistantResponse}`;
    await indexConversationTurn(turnId, content, groupFolder || MAIN_GROUP_FOLDER);
  }

  /**
   * Get current context snapshot for prompt injection
   * Returns minimal, structured context from tier 1
   */
  async getPromptContext(): Promise<string> {
    const snapshot = codedContext.snapshot();
    return codedContext.toMarkdown(snapshot);
  }

  /**
   * Persist all tiers to disk
   */
  async persist(): Promise<void> {
    await codedContext.persist();
    // Tier 2 and 3 auto-persist via their respective systems
  }
}

/**
 * Singleton instance
 */
export const contextManager = new ContextManager();

/**
 * Helper functions
 */

export async function askContext(query: string, allowWebSearch = true): Promise<ContextResponse> {
  return contextManager.query({ query, allowWebSearch });
}

export async function getSystemContext(): Promise<ContextResponse> {
  return contextManager.query({
    query: 'system configuration',
    category: 'system',
    allowWebSearch: false,
  });
}

export async function getUserPreferences(): Promise<ContextResponse> {
  return contextManager.query({
    query: 'user preferences',
    category: 'user_preference',
    allowWebSearch: false,
  });
}

export async function getActiveProjects(): Promise<ContextResponse> {
  return contextManager.query({
    query: 'active projects',
    category: 'active_project',
    allowWebSearch: false,
  });
}
