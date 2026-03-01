/**
 * Semantic Search System (Tier 2 - Warm Retrieval)
 * Provides RAG over conversation history, MEMORY.md, and other knowledge
 *
 * Uses NanoClaw's existing semantic_search MCP tool for vector search
 */

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
 * Wraps NanoClaw's semantic_search MCP tool for context retrieval
 */
export class SemanticSearch {
  private readonly DEFAULT_TOP_K = 5;
  private readonly MIN_RELEVANCE = 0.6;

  /**
   * Search indexed documents and conversation history
   *
   * This delegates to the mcp__nanoclaw__semantic_search tool
   * which searches OCR output, conversation archives, and indexed docs
   */
  async search(options: SemanticSearchOptions): Promise<SearchResult[]> {
    const topK = options.topK || this.DEFAULT_TOP_K;
    const minRelevance = options.minRelevance || this.MIN_RELEVANCE;

    // In production, this would call the MCP tool via IPC
    // For now, return placeholder that shows the integration point

    // TODO: Integrate with mcp__nanoclaw__semantic_search via IPC
    // const ipcRequest = {
    //   type: 'semantic_search',
    //   query: options.query,
    //   top_k: topK,
    //   group_folder: options.groupFolder,
    // };

    // Placeholder - shows structure of what would be returned
    return [];
  }

  /**
   * Index new content for future retrieval
   *
   * Call this after:
   * - Completing a task/conversation turn
   * - Processing OCR output
   * - Learning new facts
   */
  async indexDocument(source: string, content: string): Promise<void> {
    // TODO: Integrate with mcp__nanoclaw__index_document via IPC
    // const ipcRequest = {
    //   type: 'index_document',
    //   source,
    //   content,
    // };
  }

  /**
   * Convert search results to codified facts
   * Useful for promoting frequently-accessed warm data to hot cache
   */
  searchResultsToFacts(results: SearchResult[]): CodedFact[] {
    const facts: CodedFact[] = [];

    for (const result of results) {
      // Extract key-value pairs from result content
      // This is heuristic - improve based on actual content structure
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
            confidence: result.relevance, // Use relevance as confidence
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
   * Useful for retrieving user preferences, active projects, learned facts
   */
  async searchMemory(query: string, topK = 3): Promise<SearchResult[]> {
    return this.search({
      query,
      topK,
      groupFolder: undefined, // Search all groups
      minRelevance: 0.7, // Higher threshold for memory
    });
  }

  /**
   * Search conversation history
   * Useful for "what did we discuss about X?"
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

export async function indexConversationTurn(turnId: string, content: string): Promise<void> {
  await semanticSearch.indexDocument(`conversation:${turnId}`, content);
}

export async function indexLearning(topic: string, content: string): Promise<void> {
  await semanticSearch.indexDocument(`learning:${topic}`, content);
}
