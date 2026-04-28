import { readEnvFile } from './env.js';

// Claude Sonnet pricing (per million tokens). For non-anthropic providers
// this gives a rough estimate — real prices vary widely (DeepSeek V4 Flash
// is ~10x cheaper, OpenRouter passthrough varies). Treat costs tagged
// provider!='anthropic' as upper-bound estimates until real per-provider
// price tables are added.
const TOKEN_PRICE_INPUT = 3.0;
const TOKEN_PRICE_OUTPUT = 15.0;
const TOKEN_PRICE_CACHE_READ = 0.30;
const TOKEN_PRICE_CACHE_WRITE = 3.75;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function calculateCost(usage: TokenUsage): number {
  const inputCost = (usage.inputTokens / 1_000_000) * TOKEN_PRICE_INPUT;
  const outputCost = (usage.outputTokens / 1_000_000) * TOKEN_PRICE_OUTPUT;
  const cacheReadCost = ((usage.cacheReadTokens ?? 0) / 1_000_000) * TOKEN_PRICE_CACHE_READ;
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) / 1_000_000) * TOKEN_PRICE_CACHE_WRITE;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Detect which model provider containers will route to. Reads `.env` (same
 * source `readSecrets()` uses, so this matches what the container sees).
 * Returns 'custom' if ANTHROPIC_BASE_URL is set in .env, else 'anthropic'.
 *
 * This is process-wide (not per-group), reflecting the env-passthrough
 * design from PR #14. If groups need divergent routing, lift this into the
 * container result.
 */
let cachedProvider: string | null = null;
export function getActiveProvider(): string {
  if (cachedProvider !== null) return cachedProvider;
  try {
    const env = readEnvFile(['ANTHROPIC_BASE_URL']);
    cachedProvider = env['ANTHROPIC_BASE_URL'] ? 'custom' : 'anthropic';
  } catch {
    cachedProvider = 'anthropic';
  }
  return cachedProvider;
}

/** Test-only: clear the provider cache. */
export function _resetProviderCache(): void {
  cachedProvider = null;
}
