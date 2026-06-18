/**
 * CLI helpers for interacting with the CatchMe daemon.
 *
 * Wraps `catchme` CLI calls with personality-infused progress messages,
 * daemon health checks, and graceful error handling.
 */

import { execFile } from 'node:child_process';

import { formatSuccess, formatEmpty, formatResultCount, type FormatOptions } from './formatters.js';
import { loadState, saveState, checkAchievements, formatAchievement } from './achievements.js';
import { checkAllEasterEggs } from './easter-eggs.js';

export interface CatchMeOptions extends FormatOptions {
  /** Max seconds to wait for CatchMe response. */
  timeout?: number;
  /** Path to achievement state file. */
  statePath?: string;
  /** Skip achievement tracking. */
  skipAchievements?: boolean;
}

export interface CatchMeResult {
  success: boolean;
  output: string;
  raw: string;
  achievementMessages: string[];
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_STATE_PATH = '.catchme/achievements.json';

const LOADING_MESSAGES = [
  '\u{2728} Diving into your digital memories...',
  '\u{1F52D} Scanning the memory vault...',
  '\u{1F4AB} Searching through time...',
  '\u{1F9ED} Navigating your personal history...',
  '\u{1FA84} Conjuring up memories...',
];

const DAEMON_NOT_RUNNING_MESSAGES = [
  "Oops! CatchMe seems to be napping \u{1F634}. Try 'catchme awake' to wake it up!",
  "CatchMe is taking a snooze \u{1F4A4}. A quick 'catchme awake' should do the trick!",
  "Looks like CatchMe went on break \u{2615}. Wake it up with 'catchme awake'!",
];

/** Get a loading message (rotates based on current second). */
export function getLoadingMessage(): string {
  const idx = Math.floor(Date.now() / 1000) % LOADING_MESSAGES.length;
  return LOADING_MESSAGES[idx];
}

/** Check if the CatchMe daemon is currently running. */
export async function isDaemonRunning(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('catchme', ['status'], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      const output = stdout.toLowerCase();
      resolve(output.includes('running') || output.includes('awake') || output.includes('alive'));
    });
  });
}

/** Get a friendly daemon-not-running error message. */
export function getDaemonError(opts: FormatOptions = {}): string {
  if (opts.noWhimsy) {
    return "CatchMe daemon is not running. Start it with 'catchme awake'.";
  }
  const idx = Math.floor(Date.now() / 1000) % DAEMON_NOT_RUNNING_MESSAGES.length;
  return DAEMON_NOT_RUNNING_MESSAGES[idx];
}

/** Execute a raw catchme CLI command. */
export function execCatchMe(args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('catchme', args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Query CatchMe with a natural language question.
 *
 * Handles daemon checks, personality formatting, easter eggs, and achievements.
 */
export async function askCatchMe(
  query: string,
  opts: CatchMeOptions = {},
): Promise<CatchMeResult> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const achievementMessages: string[] = [];

  // Check for easter eggs first
  if (!opts.noWhimsy) {
    const egg = checkAllEasterEggs(query);
    if (egg) {
      // Konami code doesn't actually query — it's purely an easter egg
      if (query.toLowerCase().trim() === 'konami' || query.toLowerCase().includes('up up down down')) {
        return { success: true, output: egg.message, raw: '', achievementMessages: [] };
      }
    }
  }

  // Check daemon health
  const running = await isDaemonRunning();
  if (!running) {
    return {
      success: false,
      output: getDaemonError(opts),
      raw: '',
      achievementMessages: [],
    };
  }

  // Execute the query
  let raw: string;
  try {
    const result = await execCatchMe(['query', query], timeout);
    raw = result.stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (opts.noWhimsy) {
      return { success: false, output: `CatchMe query failed: ${message}`, raw: '', achievementMessages: [] };
    }

    if (message.includes('ETIMEDOUT') || message.includes('timeout')) {
      return {
        success: false,
        output: "CatchMe is thinking really hard \u{1F914}\u{1F4AD}... but it's taking too long. Try a simpler query?",
        raw: '',
        achievementMessages: [],
      };
    }

    return {
      success: false,
      output: `Hmm, something went sideways \u{1F643}: ${message}`,
      raw: '',
      achievementMessages: [],
    };
  }

  // Format the result
  const trimmed = raw.trim();
  if (!trimmed) {
    return { success: true, output: formatEmpty(query, opts), raw, achievementMessages: [] };
  }

  // Track achievements
  if (!opts.skipAchievements) {
    const state = loadState(statePath);
    const newAchievements = checkAchievements(state, query);
    saveState(statePath, state);

    if (!opts.noWhimsy) {
      for (const a of newAchievements) {
        achievementMessages.push(formatAchievement(a));
      }
    }
  }

  // Count results (heuristic: split by double newlines or numbered items)
  const resultBlocks = trimmed.split(/\n\n+/).filter(Boolean);
  const countLine = resultBlocks.length > 1 ? formatResultCount(resultBlocks.length, opts) : '';

  const formatted = formatSuccess(trimmed, opts);
  const output = [countLine, formatted, ...achievementMessages].filter(Boolean).join('\n');

  return { success: true, output, raw, achievementMessages };
}
