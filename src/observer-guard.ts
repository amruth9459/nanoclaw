import { logger } from './logger.js';

/**
 * Observer Guard — a 5-layer safety system that sits in front of the scheduled
 * task executor. It is purely advisory/observational: it never changes *when*
 * a task is scheduled (cron/interval/once logic stays in task-scheduler.ts),
 * it only decides whether a *due* task is allowed to run right now and watches
 * the in-flight population for trouble.
 *
 * Layers:
 *   1. Re-entrancy detection   — block a task that is already executing.
 *   2. Memory-explosion guard  — global + per-group concurrency caps, plus
 *                                tail-sampling load-shedding under pressure.
 *   3. Failure throttling      — back off a task after N consecutive failures.
 *   4. Timeout enforcement     — surface tasks that have run past the limit so
 *                                the caller can kill them.
 *   5. Lazy start              — stagger near-simultaneous starts so a burst of
 *                                due tasks doesn't cascade into a thundering herd.
 *
 * Design goals: non-breaking (existing tasks run untouched), observable (every
 * decision is logged — info for blocks, debug for passes), tunable (all knobs
 * configurable via the constructor), and self-cleaning (metrics for deleted
 * tasks are pruned).
 */

export interface ObserverGuardConfig {
  /** Hard cap on tasks executing concurrently across all groups. */
  maxConcurrentTasks: number;
  /** Hard cap on tasks executing concurrently within a single group. */
  maxConcurrentPerGroup: number;
  /** A task running longer than this is considered timed out (ms). */
  taskTimeoutMs: number;
  /** Consecutive failures before a task is throttled. */
  failureThreshold: number;
  /** How long a throttled task is held off (ms). */
  throttleBackoffMs: number;
  /** Base stagger applied to near-simultaneous task starts (ms). */
  lazyStartDelayMs: number;
  /** Active-task count at/above which tail-sampling load-shedding kicks in. */
  memoryThrottleThreshold: number;
  /** Fraction of incoming tasks to DROP while load-shedding (0..1). */
  tailSampleRate: number;
}

export const DEFAULT_CONFIG: ObserverGuardConfig = {
  maxConcurrentTasks: 8, // 64GB RAM / ~8GB avg per task container
  maxConcurrentPerGroup: 2,
  taskTimeoutMs: 10 * 60 * 1000, // 10 minutes
  failureThreshold: 3,
  throttleBackoffMs: 15 * 60 * 1000, // 15 minutes
  lazyStartDelayMs: 5 * 1000, // 5 seconds
  memoryThrottleThreshold: 6,
  tailSampleRate: 0.5, // drop 50% when throttling
};

/** The five guard layers, used for structured logging / stats. */
export enum GuardLayer {
  None = 0,
  Reentrancy = 1,
  Memory = 2,
  Failure = 3,
  Timeout = 4,
  LazyStart = 5,
}

export interface GuardDecision {
  allow: boolean;
  /** GuardLayer that produced the decision (None when allowed). */
  layer: GuardLayer;
  /** Human-readable reason, for logs and the dashboard. */
  reason: string;
}

/** Minimal shape the guard needs from a task — works with ScheduledTask. */
export interface GuardTask {
  id: string;
  group_folder: string;
}

interface ActiveExecution {
  taskId: string;
  groupFolder: string;
  /** When the task actually began running (epoch ms, set after lazy-start). */
  startedAt: number;
  /** Set once getTimedOutTasks() has reported it, so we only act once. */
  timedOutReported: boolean;
}

interface FailureState {
  consecutiveFailures: number;
  lastFailureAt: number;
  /** Epoch ms until which the task is throttled (0 = not throttled). */
  throttledUntil: number;
}

export interface GuardStats {
  config: ObserverGuardConfig;
  activeExecutions: number;
  activeByGroup: Record<string, number>;
  active: Array<{ taskId: string; groupFolder: string; startedAt: number; ageMs: number }>;
  throttledTasks: Array<{ taskId: string; consecutiveFailures: number; remainingMs: number }>;
  blocks: {
    reentrancy: number;
    globalLimit: number;
    groupLimit: number;
    tailSample: number;
    failureThrottle: number;
    total: number;
  };
  counters: {
    passes: number;
    started: number;
    completed: number;
    failed: number;
    timeouts: number;
    forceEvicted: number;
  };
}

const ALLOW: GuardDecision = { allow: true, layer: GuardLayer.None, reason: 'ok' };

export class ObserverGuard {
  private readonly cfg: ObserverGuardConfig;

  /** taskId -> in-flight execution. */
  private active = new Map<string, ActiveExecution>();
  /** groupFolder -> count of active executions in that group. */
  private activeByGroup = new Map<string, number>();
  /** taskId -> failure/throttle bookkeeping. */
  private failures = new Map<string, FailureState>();

  /** Lazy-start scheduling cursor — next epoch ms a start may begin. */
  private nextStartSlot = 0;

  private blocks = {
    reentrancy: 0,
    globalLimit: 0,
    groupLimit: 0,
    tailSample: 0,
    failureThrottle: 0,
  };
  private counters = {
    passes: 0,
    started: 0,
    completed: 0,
    failed: 0,
    timeouts: 0,
    forceEvicted: 0,
  };

  constructor(config: Partial<ObserverGuardConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    logger.info({ config: this.cfg }, 'ObserverGuard initialized');
  }

  // ── Layer 1–3: admission control ──────────────────────────────────────────

  /**
   * Decide whether a due task may run right now. Pure (no state mutation beyond
   * stat counters): the caller commits the slot by calling startExecution().
   * There must be NO `await` between this call and startExecution() so the
   * read-then-reserve stays atomic on the single-threaded event loop.
   */
  shouldRunTask(task: GuardTask): GuardDecision {
    const now = Date.now();
    const { id, group_folder: group } = task;

    // Layer 1 — re-entrancy: the same task is already in flight.
    if (this.active.has(id)) {
      this.blocks.reentrancy++;
      return this.block(
        GuardLayer.Reentrancy,
        `task ${id} already executing (re-entrancy blocked)`,
        task,
      );
    }

    // Layer 3 — failure throttling: backing off after repeated failures.
    const fail = this.failures.get(id);
    if (fail && fail.throttledUntil > now) {
      this.blocks.failureThrottle++;
      const remainingMs = fail.throttledUntil - now;
      return this.block(
        GuardLayer.Failure,
        `task ${id} throttled after ${fail.consecutiveFailures} failures ` +
          `(${Math.ceil(remainingMs / 1000)}s left)`,
        task,
      );
    }

    // Layer 2 — memory explosion: global concurrency cap.
    if (this.active.size >= this.cfg.maxConcurrentTasks) {
      this.blocks.globalLimit++;
      return this.block(
        GuardLayer.Memory,
        `global concurrency cap reached (${this.active.size}/${this.cfg.maxConcurrentTasks})`,
        task,
      );
    }

    // Layer 2 — memory explosion: per-group concurrency cap.
    const groupCount = this.activeByGroup.get(group) ?? 0;
    if (groupCount >= this.cfg.maxConcurrentPerGroup) {
      this.blocks.groupLimit++;
      return this.block(
        GuardLayer.Memory,
        `group "${group}" concurrency cap reached (${groupCount}/${this.cfg.maxConcurrentPerGroup})`,
        task,
      );
    }

    // Layer 2 — memory explosion: tail-sampling load-shed under pressure.
    // Once we're near the cap, probabilistically drop a fraction of incoming
    // tasks so we degrade gracefully instead of slamming into the hard limit.
    if (this.active.size >= this.cfg.memoryThrottleThreshold) {
      if (Math.random() < this.cfg.tailSampleRate) {
        this.blocks.tailSample++;
        return this.block(
          GuardLayer.Memory,
          `tail-sample drop under memory pressure ` +
            `(active=${this.active.size} >= ${this.cfg.memoryThrottleThreshold}, ` +
            `rate=${this.cfg.tailSampleRate})`,
          task,
        );
      }
    }

    this.counters.passes++;
    logger.debug(
      { taskId: id, group, active: this.active.size },
      'ObserverGuard: task admitted',
    );
    return ALLOW;
  }

  // ── Layer 5: lazy start + execution registration ──────────────────────────

  /**
   * Reserve a concurrency slot for the task and apply the Layer-5 lazy-start
   * stagger. The slot is reserved SYNCHRONOUSLY (before the first await) so a
   * burst of starts is accounted for race-free; the returned promise resolves
   * after the (possibly zero) stagger delay, at which point the task should
   * actually spawn. Returns the applied delay in ms.
   */
  async startExecution(taskId: string, groupFolder: string): Promise<number> {
    // --- synchronous reservation (no await before this completes) ---
    const exec: ActiveExecution = {
      taskId,
      groupFolder,
      startedAt: Date.now(),
      timedOutReported: false,
    };
    this.active.set(taskId, exec);
    this.activeByGroup.set(groupFolder, (this.activeByGroup.get(groupFolder) ?? 0) + 1);
    this.counters.started++;

    // Layer 5 — lazy start: stagger only when we're adding to existing load or
    // another start is already queued in the near future. A single idle start
    // incurs no delay.
    const now = Date.now();
    let delay = 0;
    if (this.active.size > 1 || now < this.nextStartSlot) {
      const slotStart = Math.max(now, this.nextStartSlot);
      delay = slotStart - now;
      this.nextStartSlot = slotStart + this.cfg.lazyStartDelayMs;
    } else {
      this.nextStartSlot = now + this.cfg.lazyStartDelayMs;
    }

    if (delay > 0) {
      logger.debug(
        { taskId, groupFolder, delayMs: delay, active: this.active.size },
        'ObserverGuard: lazy-start stagger applied',
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Reset the clock to actual run start so timeout measures real run time,
      // not the time spent waiting in the stagger queue.
      const stillActive = this.active.get(taskId);
      if (stillActive) stillActive.startedAt = Date.now();
    }

    return delay;
  }

  /**
   * Release the task's concurrency slot and update its failure/throttle state.
   * Safe to call even if the task was never registered (no-op on the slot).
   */
  endExecution(taskId: string, success: boolean, durationMs: number): void {
    const exec = this.active.get(taskId);
    if (exec) {
      this.active.delete(taskId);
      const groupCount = (this.activeByGroup.get(exec.groupFolder) ?? 1) - 1;
      if (groupCount <= 0) this.activeByGroup.delete(exec.groupFolder);
      else this.activeByGroup.set(exec.groupFolder, groupCount);
    }

    if (success) {
      this.counters.completed++;
      // A clean run clears any accumulated failure/throttle state.
      if (this.failures.has(taskId)) {
        logger.debug({ taskId }, 'ObserverGuard: failure state cleared after success');
        this.failures.delete(taskId);
      }
    } else {
      this.counters.failed++;
      // Layer 3 — failure throttling: count and back off after the threshold.
      const fail = this.failures.get(taskId) ?? {
        consecutiveFailures: 0,
        lastFailureAt: 0,
        throttledUntil: 0,
      };
      fail.consecutiveFailures++;
      fail.lastFailureAt = Date.now();
      if (fail.consecutiveFailures >= this.cfg.failureThreshold) {
        fail.throttledUntil = Date.now() + this.cfg.throttleBackoffMs;
        logger.info(
          {
            taskId,
            consecutiveFailures: fail.consecutiveFailures,
            backoffMs: this.cfg.throttleBackoffMs,
          },
          'ObserverGuard: task throttled after consecutive failures',
        );
      }
      this.failures.set(taskId, fail);
    }

    logger.debug(
      { taskId, success, durationMs, active: this.active.size },
      'ObserverGuard: execution ended',
    );
  }

  // ── Layer 4: timeout enforcement ──────────────────────────────────────────

  /**
   * Return tasks that have exceeded the timeout and have not yet been reported.
   * Each task is reported at most once (flagged), so the caller can issue a
   * single kill. As a leak backstop, executions older than 2× the timeout are
   * force-evicted from the active set (the container's own hard timeout is the
   * real reaper; this just prevents permanent accounting drift).
   */
  getTimedOutTasks(): Array<{ taskId: string; groupFolder: string; ageMs: number }> {
    const now = Date.now();
    const out: Array<{ taskId: string; groupFolder: string; ageMs: number }> = [];
    const forceEvictMs = this.cfg.taskTimeoutMs * 2;

    for (const exec of this.active.values()) {
      const ageMs = now - exec.startedAt;
      if (ageMs <= this.cfg.taskTimeoutMs) continue;

      if (!exec.timedOutReported) {
        exec.timedOutReported = true;
        this.counters.timeouts++;
        logger.info(
          { taskId: exec.taskId, groupFolder: exec.groupFolder, ageMs, limitMs: this.cfg.taskTimeoutMs },
          'ObserverGuard: task exceeded timeout',
        );
        out.push({ taskId: exec.taskId, groupFolder: exec.groupFolder, ageMs });
      }

      // Leak backstop: assume truly-dead executions and reclaim the slot.
      if (ageMs > forceEvictMs) {
        this.active.delete(exec.taskId);
        const groupCount = (this.activeByGroup.get(exec.groupFolder) ?? 1) - 1;
        if (groupCount <= 0) this.activeByGroup.delete(exec.groupFolder);
        else this.activeByGroup.set(exec.groupFolder, groupCount);
        this.counters.forceEvicted++;
        logger.warn(
          { taskId: exec.taskId, groupFolder: exec.groupFolder, ageMs },
          'ObserverGuard: force-evicted stale execution (leak backstop)',
        );
      }
    }
    return out;
  }

  // ── Self-cleaning ─────────────────────────────────────────────────────────

  /**
   * Drop failure/throttle metrics for tasks that no longer exist. Active
   * executions are never pruned. Returns the number of entries removed.
   */
  prune(knownTaskIds: Iterable<string>): number {
    const known = knownTaskIds instanceof Set ? knownTaskIds : new Set(knownTaskIds);
    let removed = 0;
    for (const taskId of this.failures.keys()) {
      if (!known.has(taskId) && !this.active.has(taskId)) {
        this.failures.delete(taskId);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ removed }, 'ObserverGuard: pruned metrics for deleted tasks');
    }
    return removed;
  }

  // ── Observability ─────────────────────────────────────────────────────────

  getStats(): GuardStats {
    const now = Date.now();
    const activeByGroup: Record<string, number> = {};
    for (const [group, count] of this.activeByGroup) activeByGroup[group] = count;

    const active = Array.from(this.active.values()).map((e) => ({
      taskId: e.taskId,
      groupFolder: e.groupFolder,
      startedAt: e.startedAt,
      ageMs: now - e.startedAt,
    }));

    const throttledTasks: GuardStats['throttledTasks'] = [];
    for (const [taskId, fail] of this.failures) {
      if (fail.throttledUntil > now) {
        throttledTasks.push({
          taskId,
          consecutiveFailures: fail.consecutiveFailures,
          remainingMs: fail.throttledUntil - now,
        });
      }
    }

    const blockTotal =
      this.blocks.reentrancy +
      this.blocks.globalLimit +
      this.blocks.groupLimit +
      this.blocks.tailSample +
      this.blocks.failureThrottle;

    return {
      config: this.cfg,
      activeExecutions: this.active.size,
      activeByGroup,
      active,
      throttledTasks,
      blocks: { ...this.blocks, total: blockTotal },
      counters: { ...this.counters },
    };
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private block(layer: GuardLayer, reason: string, task: GuardTask): GuardDecision {
    logger.info(
      { taskId: task.id, group: task.group_folder, layer, reason },
      'ObserverGuard: task blocked',
    );
    return { allow: false, layer, reason };
  }
}

/**
 * Process-wide singleton. Thresholds can be overridden via env vars without a
 * code change; anything unset falls back to DEFAULT_CONFIG.
 */
function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
function envFloat(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

function envConfig(): Partial<ObserverGuardConfig> {
  const cfg: Partial<ObserverGuardConfig> = {};
  const maxConcurrent = envInt('NANOCLAW_GUARD_MAX_CONCURRENT');
  if (maxConcurrent !== undefined) cfg.maxConcurrentTasks = maxConcurrent;
  const maxPerGroup = envInt('NANOCLAW_GUARD_MAX_PER_GROUP');
  if (maxPerGroup !== undefined) cfg.maxConcurrentPerGroup = maxPerGroup;
  const timeout = envInt('NANOCLAW_GUARD_TIMEOUT_MS');
  if (timeout !== undefined) cfg.taskTimeoutMs = timeout;
  const failThreshold = envInt('NANOCLAW_GUARD_FAILURE_THRESHOLD');
  if (failThreshold !== undefined) cfg.failureThreshold = failThreshold;
  const backoff = envInt('NANOCLAW_GUARD_BACKOFF_MS');
  if (backoff !== undefined) cfg.throttleBackoffMs = backoff;
  const lazy = envInt('NANOCLAW_GUARD_LAZY_START_MS');
  if (lazy !== undefined) cfg.lazyStartDelayMs = lazy;
  const memThreshold = envInt('NANOCLAW_GUARD_MEMORY_THRESHOLD');
  if (memThreshold !== undefined) cfg.memoryThrottleThreshold = memThreshold;
  const sampleRate = envFloat('NANOCLAW_GUARD_TAIL_SAMPLE_RATE');
  if (sampleRate !== undefined) cfg.tailSampleRate = sampleRate;
  return cfg;
}

export const observerGuard = new ObserverGuard(envConfig());
