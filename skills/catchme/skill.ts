/**
 * CatchMe Skill — your personal memory companion.
 *
 * Integrates with a locally-running CatchMe daemon (`catchme awake`)
 * to query personal digital memories: emails, chats, documents, calendar
 * events, browser history, and more.
 *
 * The skill wraps the CatchMe CLI with personality-rich formatting,
 * an achievement system, and hidden easter eggs.
 */

import { askCatchMe, isDaemonRunning, getDaemonError, getLoadingMessage, type CatchMeOptions } from './cli-helpers.js';
import { listAchievements, loadState } from './achievements.js';
import { isWorkQuery } from './formatters.js';

export interface SkillConfig {
  /** Disable whimsy for minimal output. */
  noWhimsy: boolean;
  /** Path to persist achievement state. */
  statePath: string;
  /** Query timeout in ms. */
  timeout: number;
}

const DEFAULT_CONFIG: SkillConfig = {
  noWhimsy: false,
  statePath: '.catchme/achievements.json',
  timeout: 30_000,
};

/**
 * Main entry point: query CatchMe with a natural language question.
 *
 * Examples:
 *   query("What was I working on this morning?")
 *   query("Show me all my emails from yesterday")
 *   query("What meetings do I have today?")
 */
export async function query(
  input: string,
  config: Partial<SkillConfig> = {},
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Auto-detect tone: work queries get slightly more professional treatment
  const workMode = isWorkQuery(input);
  const opts: CatchMeOptions = {
    noWhimsy: cfg.noWhimsy,
    timeout: cfg.timeout,
    statePath: cfg.statePath,
    skipAchievements: false,
  };

  const result = await askCatchMe(input, opts);

  // Prefix work queries with a subtle professional note
  if (workMode && !cfg.noWhimsy && result.success) {
    return `\u{1F4BC} ${result.output}`;
  }

  return result.output;
}

/** Check CatchMe daemon health and return a friendly status. */
export async function status(config: Partial<SkillConfig> = {}): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const running = await isDaemonRunning();

  if (running) {
    if (cfg.noWhimsy) return 'CatchMe daemon is running.';
    return '\u{2705} CatchMe is awake and ready to help you remember everything!';
  }

  return getDaemonError(cfg);
}

/** Show achievement progress. */
export function achievements(config: Partial<SkillConfig> = {}): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const state = loadState(cfg.statePath);

  if (cfg.noWhimsy) {
    const total = Object.keys(state.achievements).length;
    return `Achievements: ${total}/7. Total queries: ${state.totalQueries}.`;
  }

  return listAchievements(state);
}

/** Get a loading message for display while querying. */
export function loading(config: Partial<SkillConfig> = {}): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (cfg.noWhimsy) return 'Querying CatchMe...';
  return getLoadingMessage();
}

// Re-export types for consumers
export type { CatchMeOptions, CatchMeResult } from './cli-helpers.js';
export type { MemoryFormat, Tone, FormatOptions } from './formatters.js';
export type { Achievement, AchievementState } from './achievements.js';
export type { EasterEggResult } from './easter-eggs.js';
