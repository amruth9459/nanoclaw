import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerplexityClient } from './perplexity-integration.js';

// Mock logger to avoid side effects
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const MOCK_API_RESPONSE = {
  id: 'test-id',
  model: 'sonar',
  created: 1700000000,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
      finish_reason: 'stop' as const,
    },
  ],
  citations: [
    'https://www.typescriptlang.org/docs/',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 20,
    total_tokens: 30,
  },
};

describe('PerplexityClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when no API key is configured', async () => {
    const client = new PerplexityClient(undefined);
    // Clear env var if set
    const original = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;

    const clientNoKey = new PerplexityClient();

    await expect(clientNoKey.search({ query: 'test' })).rejects.toThrow(
      'Perplexity API key not configured'
    );

    process.env.PERPLEXITY_API_KEY = original;
  });

  it('isConfigured returns true when API key is set', () => {
    const client = new PerplexityClient('test-key');
    expect(client.isConfigured()).toBe(true);
  });

  it('isConfigured returns false when no API key', () => {
    const original = process.env.PERPLEXITY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;

    const client = new PerplexityClient();
    expect(client.isConfigured()).toBe(false);

    process.env.PERPLEXITY_API_KEY = original;
  });

  it('returns PerplexityResult on successful API call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_API_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new PerplexityClient('test-key');
    const result = await client.search({ query: 'What is TypeScript?' });

    expect(result.answer).toBe('TypeScript is a typed superset of JavaScript.');
    expect(result.model).toBe('sonar');
    expect(result.searchedWeb).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].url).toBe('https://www.typescriptlang.org/docs/');
    expect(result.sources[0].title).toBe('typescriptlang.org');

    // Verify fetch was called with correct params
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.perplexity.ai/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-key',
          'Content-Type': 'application/json',
        },
      })
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('sonar');
    expect(body.messages[0].content).toBe('What is TypeScript?');
  });

  it('handles response with no citations', async () => {
    const noCitations = { ...MOCK_API_RESPONSE, citations: undefined };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(noCitations), { status: 200 })
    );

    const client = new PerplexityClient('test-key');
    const result = await client.search({ query: 'test' });

    expect(result.sources).toEqual([]);
    expect(result.answer).toBe('TypeScript is a typed superset of JavaScript.');
  });

  it('throws on HTTP error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Rate limit exceeded', { status: 429 })
    );

    const client = new PerplexityClient('test-key');
    await expect(client.search({ query: 'test' })).rejects.toThrow(
      'Perplexity API returned 429'
    );
  });

  it('throws on network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const client = new PerplexityClient('test-key');
    await expect(client.search({ query: 'test' })).rejects.toThrow(
      'Perplexity API request failed: ECONNREFUSED'
    );
  });

  it('throws on invalid JSON response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json', { status: 200 })
    );

    const client = new PerplexityClient('test-key');
    await expect(client.search({ query: 'test' })).rejects.toThrow(
      'Perplexity API returned invalid JSON'
    );
  });

  it('throws when response has no answer content', async () => {
    const noContent = { ...MOCK_API_RESPONSE, choices: [] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(noContent), { status: 200 })
    );

    const client = new PerplexityClient('test-key');
    await expect(client.search({ query: 'test' })).rejects.toThrow(
      'Perplexity API returned no answer'
    );
  });

  it('passes optional search parameters correctly', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_API_RESPONSE), { status: 200 })
    );

    const client = new PerplexityClient('test-key');
    await client.search({
      query: 'test',
      model: 'sonar-pro',
      searchDomainFilter: ['example.com'],
      returnImages: true,
      returnRelatedQuestions: true,
      searchRecencyFilter: 'week',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('sonar-pro');
    expect(body.search_domain_filter).toEqual(['example.com']);
    expect(body.return_images).toBe(true);
    expect(body.return_related_questions).toBe(true);
    expect(body.search_recency_filter).toBe('week');
  });

  it('quickLookup returns just the answer string', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_API_RESPONSE), { status: 200 })
    );

    const client = new PerplexityClient('test-key');
    const answer = await client.quickLookup('What is TypeScript?');
    expect(answer).toBe('TypeScript is a typed superset of JavaScript.');
  });

  it('deepResearch uses sonar-reasoning model', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(MOCK_API_RESPONSE), { status: 200 })
    );

    const client = new PerplexityClient('test-key');
    await client.deepResearch('complex topic', 'week');

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body.model).toBe('sonar-reasoning');
    expect(body.return_images).toBe(true);
    expect(body.return_related_questions).toBe(true);
    expect(body.search_recency_filter).toBe('week');
  });
});
