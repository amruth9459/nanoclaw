/**
 * Semantic Search System (Tier 2 - Warm Retrieval)
 * Provides RAG over conversation history, MEMORY.md, and other knowledge
 *
 * Delegates to the real semantic-index.ts backend (host-side, direct import).
 */

import { semanticSearch as backendSearch, indexDocument as backendIndex } from '../semantic-index.js';
import { logger } from '../logger.js';
import { CodedFact } from './codified-context.js';

export interface SearchResult {
  content: string;
  source: string;
  relevance: number; // 0-1 similarity score
  timestamp?: number;
}

export interface SemanticSearchOptions {
  query: string;
  topK?: number;
  groupFolder?: string; // Limit to specific group
  minRelevance?: number; // Filter threshold
}

/**
 * Semantic Search Manager
 * Wraps semantic-index.ts for context retrieval
 */
export class SemanticSearch {
  private readonly DEFAULT_TOP_K = 5;
  private readonly MIN_RELEVANCE = 0.6;

  /**
   * Search indexed documents and conversation history
   */
  async search(options: SemanticSearchOptions): Promise<SearchResult[]> {
    const topK = options.topK || this.DEFAULT_TOP_K;
    const minRelevance = options.minRelevance || this.MIN_RELEVANCE;

    try {
      const backendResults = await backendSearch(options.query, topK, options.groupFolder);

      return backendResults
        .map(r => ({
          content: r.content,
          source: r.source,
          relevance: 1 / (1 + r.distance),
          timestamp: undefined,
        }))
        .filter(r => r.relevance >= minRelevance);
    } catch (err) {
      logger.warn({ err }, 'Semantic search failed, returning empty');
      return [];
    }
  }

  /**
   * Index new content for future retrieval
   */
  async indexDocument(source: string, content: string, groupFolder = 'main'): Promise<void> {
    try {
      await backendIndex(source, groupFolder, content);
    } catch (err) {
      logger.warn({ err, source }, 'Semantic indexDocument failed');
    }
  }

  /**
   * Convert search results to codified facts
   * Useful for promoting frequently-accessed warm data to hot cache
   */
  searchResultsToFacts(results: SearchResult[]): CodedFact[] {
    const facts: CodedFact[] = [];

    for (const result of results) {
      const lines = result.content.split('\n');

      for (const line of lines) {
        const match = line.match(/^(.+?):\s*(.+)$/);
        if (match) {
          const [, key, value] = match;
          facts.push({
            id: `learned_fact:${key}`,
            category: 'learned_fact',
            key: key.trim(),
            value: value.trim(),
            confidence: result.relevance,
            lastUpdated: result.timestamp || Date.now(),
            source: result.source,
          });
        }
      }
    }

    return facts;
  }

  /**
   * Search MEMORY.md specifically
   */
  async searchMemory(query: string, topK = 3): Promise<SearchResult[]> {
    return this.search({
      query,
      topK,
      groupFolder: undefined,
      minRelevance: 0.7,
    });
  }

  /**
   * Search conversation history
   */
  async searchConversations(query: string, groupFolder?: string, topK = 5): Promise<SearchResult[]> {
    return this.search({
      query,
      topK,
      groupFolder,
      minRelevance: 0.6,
    });
  }
}

/**
 * Singleton instance
 */
export const semanticSearch = new SemanticSearch();

/**
 * Helper functions
 */

export async function searchContext(query: string, topK = 5): Promise<SearchResult[]> {
  return semanticSearch.search({ query, topK });
}

export async function indexConversationTurn(turnId: string, content: string, groupFolder = 'main'): Promise<void> {
  await semanticSearch.indexDocument(`conversation:${turnId}`, content, groupFolder);
}

export async function indexLearning(topic: string, content: string, groupFolder = 'main'): Promise<void> {
  await semanticSearch.indexDocument(`learning:${topic}`, content, groupFolder);
}
