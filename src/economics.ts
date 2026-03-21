// Claude Sonnet pricing (per million tokens)
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
