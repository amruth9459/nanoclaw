import {
  EARNING_GOAL,
  TOKEN_PRICE_CACHE_READ,
  TOKEN_PRICE_CACHE_WRITE,
  TOKEN_PRICE_INPUT,
  TOKEN_PRICE_OUTPUT,
} from './config.js';

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

export function getSurvivalTier(balance: number): string {
  if (balance > 500) return 'thriving';
  if (balance >= 100) return 'stable';
  if (balance >= 10) return 'struggling';
  if (balance > 0) return 'critical';
  if (balance > -50) return 'bankrupt';
  return 'in debt'; // balance went negative — earned less than spent
}

/** Progress toward earning goal, given total earned across all groups */
export function formatGoalProgress(totalEarned: number): string {
  const pct = Math.min(100, (totalEarned / EARNING_GOAL) * 100).toFixed(1);
  const bar = '█'.repeat(Math.floor(Number(pct) / 10)) + '░'.repeat(10 - Math.floor(Number(pct) / 10));
  return `🖥️ Computer fund: $${totalEarned.toFixed(2)}/$${EARNING_GOAL} [${bar}] ${pct}%`;
}

export function formatCostFooter(costUsd: number, balance: number, totalEarned?: number): string {
  const tier = getSurvivalTier(balance);
  const goalLine = totalEarned !== undefined
    ? ` | 🖥️ $${totalEarned.toFixed(2)}/$${EARNING_GOAL}`
    : '';
  return `💰 Cost: $${costUsd.toFixed(4)} | Balance: $${balance.toFixed(2)} | ${tier}${goalLine}`;
}
