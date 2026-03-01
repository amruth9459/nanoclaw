/**
 * Perplexity Integration (Tier 3 - Cold Fetch)
 * Provides real-time web search and current information retrieval
 *
 * Used when information is not in hot cache (Tier 1) or warm retrieval (Tier 2)
 */

export interface PerplexitySearchOptions {
  query: string;
  model?: 'sonar' | 'sonar-pro' | 'sonar-reasoning';
  searchDomainFilter?: string[]; // Restrict to specific domains
  returnImages?: boolean;
  returnRelatedQuestions?: boolean;
  searchRecencyFilter?: 'month' | 'week' | 'day' | 'hour';
}

export interface PerplexityResult {
  answer: string;
  sources: Array<{
    url: string;
    title: string;
    snippet: string;
  }>;
  images?: Array<{
    url: string;
    description: string;
  }>;
  relatedQuestions?: string[];
  model: string;
  searchedWeb: boolean;
}

/**
 * Perplexity API Client
 * Handles real-time web search for information not in cache
 */
export class PerplexityClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl = 'https://api.perplexity.ai';
  private readonly defaultModel = 'sonar'; // Fast, cost-effective

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.PERPLEXITY_API_KEY;
  }

  /**
   * Search the web via Perplexity API
   *
   * Returns real-time information with source citations
   */
  async search(options: PerplexitySearchOptions): Promise<PerplexityResult> {
    if (!this.apiKey) {
      throw new Error('Perplexity API key not configured. Set PERPLEXITY_API_KEY env var.');
    }

    const model = options.model || this.defaultModel;

    // Build request payload
    const payload = {
      model,
      messages: [
        {
          role: 'user',
          content: options.query,
        },
      ],
      search_domain_filter: options.searchDomainFilter,
      return_images: options.returnImages || false,
      return_related_questions: options.returnRelatedQuestions || false,
      search_recency_filter: options.searchRecencyFilter,
    };

    // TODO: Implement actual API call
    // const response = await fetch(`${this.baseUrl}/chat/completions`, {
    //   method: 'POST',
    //   headers: {
    //     'Authorization': `Bearer ${this.apiKey}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify(payload),
    // });

    // Placeholder - shows structure of what would be returned
    return {
      answer: 'Perplexity integration pending - API key required',
      sources: [],
      model,
      searchedWeb: true,
    };
  }

  /**
   * Quick fact lookup
   * Uses sonar model for fast, cost-effective answers
   */
  async quickLookup(query: string): Promise<string> {
    const result = await this.search({
      query,
      model: 'sonar',
      returnRelatedQuestions: false,
    });

    return result.answer;
  }

  /**
   * Deep research
   * Uses sonar-reasoning for complex queries requiring multi-step reasoning
   */
  async deepResearch(query: string, searchRecency?: 'month' | 'week' | 'day'): Promise<PerplexityResult> {
    return this.search({
      query,
      model: 'sonar-reasoning',
      returnImages: true,
      returnRelatedQuestions: true,
      searchRecencyFilter: searchRecency,
    });
  }

  /**
   * Check API availability
   */
  isConfigured(): boolean {
    return !!this.apiKey;
  }
}

/**
 * Singleton instance
 */
export const perplexity = new PerplexityClient();

/**
 * Helper functions
 */

export async function searchWeb(query: string): Promise<PerplexityResult> {
  return perplexity.search({ query });
}

export async function lookupFact(query: string): Promise<string> {
  return perplexity.quickLookup(query);
}

export async function researchTopic(query: string, recency?: 'month' | 'week' | 'day'): Promise<PerplexityResult> {
  return perplexity.deepResearch(query, recency);
}
