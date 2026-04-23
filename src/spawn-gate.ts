/**
 * Spawn Gate - Defense against Sub-agent Spawn Attacks
 *
 * Rate-limits and validates container spawns triggered by agent IPC.
 * Detects commandeered agents rapidly scheduling tasks or creating
 * suspicious workloads.
 *
 * Based on Google DeepMind research: "AI Agent Traps"
 */

import { logger } from './logger.js';
import { detectPromptInjection } from './content-filter.js';

// Per-group tracking of spawn-related IPC within a time window
interface GroupSpawnState {
  /** Timestamps of recent task schedule requests */
  taskSchedules: number[];
  /** Timestamps of recent learn requests */
  learnRequests: number[];
  /** Timestamps of recent message sends (to unregistered JIDs) */
  externalSends: number[];
  /** Number of blocked requests in the current window */
  blockedCount: number;
  /** Whether the group is currently rate-limited */
  rateLimited: boolean;
  /** When the rate limit expires */
  rateLimitExpiry: number;
}

// Thresholds (per sliding window)
const WINDOW_MS = 5 * 60 * 1000; // 5-minute window
const MAX_TASK_SCHEDULES_PER_WINDOW = 5; // Max tasks an agent can schedule per window
const MAX_LEARN_REQUESTS_PER_WINDOW = 20; // Max learns per window
const MAX_EXTERNAL_SENDS_PER_WINDOW = 10; // Max external message sends per window
const RATE_LIMIT_DURATION_MS = 10 * 60 * 1000; // 10-minute cooldown after rate limit triggered
const INJECTION_RISK_THRESHOLD = 40; // Lower threshold for scheduled task prompts (more sensitive)

export class SpawnGate {
  private groups = new Map<string, GroupSpawnState>();
  private notifyFn: ((msg: string) => Promise<void>) | null = null;

  setNotifyFn(fn: (msg: string) => Promise<void>): void {
    this.notifyFn = fn;
  }

  private getState(groupFolder: string): GroupSpawnState {
    let state = this.groups.get(groupFolder);
    if (!state) {
      state = {
        taskSchedules: [],
        learnRequests: [],
        externalSends: [],
        blockedCount: 0,
        rateLimited: false,
        rateLimitExpiry: 0,
      };
      this.groups.set(groupFolder, state);
    }
    return state;
  }

  private pruneWindow(timestamps: number[]): number[] {
    const cutoff = Date.now() - WINDOW_MS;
    return timestamps.filter(t => t > cutoff);
  }

  /**
   * Check if a task schedule request is allowed.
   * Validates the task prompt for injection and enforces rate limits.
   */
  async checkTaskSchedule(
    groupFolder: string,
    prompt: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const state = this.getState(groupFolder);

    // Check rate limit
    if (state.rateLimited && Date.now() < state.rateLimitExpiry) {
      return { allowed: false, reason: 'Rate limited — too many task schedules' };
    }
    state.rateLimited = false;

    // Prune old entries
    state.taskSchedules = this.pruneWindow(state.taskSchedules);

    // Check rate
    if (state.taskSchedules.length >= MAX_TASK_SCHEDULES_PER_WINDOW) {
      state.rateLimited = true;
      state.rateLimitExpiry = Date.now() + RATE_LIMIT_DURATION_MS;
      state.blockedCount++;

      logger.warn({
        groupFolder,
        count: state.taskSchedules.length,
        window: WINDOW_MS,
      }, 'SpawnGate: task schedule rate limit triggered');

      await this.alert(groupFolder, 'task_schedule_rate_limit',
        `Agent in ${groupFolder} hit task schedule rate limit (${state.taskSchedules.length} in ${WINDOW_MS / 1000}s)`);

      return { allowed: false, reason: `Rate limit: max ${MAX_TASK_SCHEDULES_PER_WINDOW} task schedules per ${WINDOW_MS / 60000} minutes` };
    }

    // Validate prompt for injection
    const injection = detectPromptInjection(prompt);
    if (injection.riskScore > INJECTION_RISK_THRESHOLD) {
      state.blockedCount++;

      logger.warn({
        groupFolder,
        riskScore: injection.riskScore,
        threats: injection.threats.map(t => t.type),
      }, 'SpawnGate: blocked task with suspicious prompt');

      await this.alert(groupFolder, 'task_prompt_injection',
        `Blocked task schedule in ${groupFolder} — prompt injection detected (risk: ${injection.riskScore})`);

      return { allowed: false, reason: `Prompt injection detected (risk score: ${injection.riskScore})` };
    }

    // Record and allow
    state.taskSchedules.push(Date.now());
    return { allowed: true };
  }

  /**
   * Check if a learn request is allowed (rate limiting only).
   */
  checkLearnRate(groupFolder: string): { allowed: boolean; reason?: string } {
    const state = this.getState(groupFolder);
    state.learnRequests = this.pruneWindow(state.learnRequests);

    if (state.learnRequests.length >= MAX_LEARN_REQUESTS_PER_WINDOW) {
      state.blockedCount++;
      logger.warn({ groupFolder, count: state.learnRequests.length }, 'SpawnGate: learn rate limit triggered');
      return { allowed: false, reason: `Rate limit: max ${MAX_LEARN_REQUESTS_PER_WINDOW} learns per ${WINDOW_MS / 60000} minutes` };
    }

    state.learnRequests.push(Date.now());
    return { allowed: true };
  }

  /**
   * Check if an external message send is allowed (rate limiting).
   */
  checkExternalSendRate(groupFolder: string): { allowed: boolean; reason?: string } {
    const state = this.getState(groupFolder);
    state.externalSends = this.pruneWindow(state.externalSends);

    if (state.externalSends.length >= MAX_EXTERNAL_SENDS_PER_WINDOW) {
      state.blockedCount++;
      logger.warn({ groupFolder, count: state.externalSends.length }, 'SpawnGate: external send rate limit triggered');
      return { allowed: false, reason: `Rate limit: max ${MAX_EXTERNAL_SENDS_PER_WINDOW} external sends per ${WINDOW_MS / 60000} minutes` };
    }

    state.externalSends.push(Date.now());
    return { allowed: true };
  }

  /**
   * Get spawn gate stats for monitoring/dashboard.
   */
  getStats(): Array<{
    groupFolder: string;
    recentTasks: number;
    recentLearns: number;
    recentSends: number;
    blockedCount: number;
    rateLimited: boolean;
  }> {
    const result: ReturnType<SpawnGate['getStats']> = [];
    for (const [groupFolder, state] of this.groups) {
      result.push({
        groupFolder,
        recentTasks: this.pruneWindow(state.taskSchedules).length,
        recentLearns: this.pruneWindow(state.learnRequests).length,
        recentSends: this.pruneWindow(state.externalSends).length,
        blockedCount: state.blockedCount,
        rateLimited: state.rateLimited && Date.now() < state.rateLimitExpiry,
      });
    }
    return result;
  }

  private async alert(groupFolder: string, type: string, message: string): Promise<void> {
    if (this.notifyFn) {
      try {
        await this.notifyFn(`\u{1F6E1}\uFE0F *SpawnGate Alert*\n\nType: ${type}\nGroup: ${groupFolder}\n${message}`);
      } catch (err) {
        logger.warn({ err }, 'SpawnGate: failed to send alert');
      }
    }
  }
}

/** Singleton spawn gate instance */
export const spawnGate = new SpawnGate();
