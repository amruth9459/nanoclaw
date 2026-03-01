import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;          // message/warmup container running
  activeTask: boolean;      // task container running (separate slot — doesn't block messages)
  idleWaiting: boolean;
  isWarmupContainer: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  spawnReason: string | null;   // why the current container was spawned (message preview or task description)
  taskSpawnReason: string | null; // why the current task container was spawned
  startedAt: number | null;     // when the message container started (epoch ms)
  taskStartedAt: number | null; // when the task container started (epoch ms)
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        activeTask: false,
        idleWaiting: false,
        isWarmupContainer: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        spawnReason: null,
        taskSpawnReason: null,
        startedAt: null,
        taskStartedAt: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /** Returns true if the group has any active running container. */
  isActive(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return !!(state?.active || state?.activeTask);
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      // Message container already running — queue behind it
      state.pendingMessages = true;
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, idleWaiting: state.idleWaiting }, 'Message container active, message queued');
      return;
    }

    // A task container is running but that doesn't block messages — fall through
    // and run the message container in parallel if a slot is available.

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  /**
   * Pre-warm a container for a group by running a provided async function.
   * Silently skips if the group already has an active container or the
   * concurrency cap is hit. Never retries — warmup is best-effort.
   */
  warmup(groupJid: string, fn: () => Promise<boolean>): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);
    if (state.active) return; // already warm (tasks don't block warmup either)
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) return;

    state.active = true;
    state.idleWaiting = false;
    state.isWarmupContainer = true;
    state.pendingMessages = false;
    state.spawnReason = 'Warming up';
    state.startedAt = Date.now();
    this.activeCount++;

    fn()
      .catch((err) => logger.error({ groupJid, err }, 'Warmup failed'))
      .finally(() => {
        state.active = false;
        state.isWarmupContainer = false;
        state.process = null;
        state.containerName = null;
        state.groupFolder = null;
        state.spawnReason = null;
        state.startedAt = null;
        this.activeCount--;
        this.drainMessages(groupJid);
        this.drainWaiting();
      });
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.activeTask) {
      // A task is already running — queue behind it
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      logger.debug({ groupJid, taskId }, 'Task container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately (message container may also be running in parallel)
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /** Set a human-readable reason for why the current container was spawned. */
  setSpawnReason(groupJid: string, reason: string, isTask = false): void {
    const state = this.getGroup(groupJid);
    if (isTask) {
      state.taskSpawnReason = reason;
    } else {
      state.spawnReason = reason;
    }
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If messages are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingMessages) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active message container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isWarmupContainer) return false;
    state.idleWaiting = false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active message container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isWarmupContainer = false;
    state.pendingMessages = false;
    state.startedAt = Date.now();
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting message container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.spawnReason = null;
      state.startedAt = null;
      this.activeCount--;
      this.drainMessages(groupJid);
      this.drainWaiting();
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.activeTask = true;
    state.taskStartedAt = Date.now();
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.activeTask = false;
      state.taskSpawnReason = null;
      state.taskStartedAt = null;
      this.activeCount--;
      this.drainTasks(groupJid);
      this.drainWaiting();
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  /** Drain pending messages for a group (called after message container finishes). */
  private drainMessages(groupJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);
    if (state.pendingMessages && !state.active && this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error({ groupJid, err }, 'Unhandled error in runForGroup (drain)'),
      );
    }
  }

  /** Drain pending tasks for a group (called after task container finishes). */
  private drainTasks(groupJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);
    if (state.pendingTasks.length > 0 && !state.activeTask && this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error({ groupJid, taskId: task.id, err }, 'Unhandled error in runTask (drain)'),
      );
    }
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      if (state.pendingMessages && !state.active) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Unhandled error in runForGroup (waiting)'),
        );
      } else if (state.pendingTasks.length > 0 && !state.activeTask) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error({ groupJid: nextJid, taskId: task.id, err }, 'Unhandled error in runTask (waiting)'),
        );
      }
    }
  }

  /** Returns detailed per-group state for the dashboard. */
  getDetailedStatus(): Array<{
    jid: string;
    active: boolean;
    activeTask: boolean;
    containerName: string | null;
    groupFolder: string | null;
    isWarmup: boolean;
    pendingMessages: boolean;
    pendingTaskCount: number;
    spawnReason: string | null;
    taskSpawnReason: string | null;
    startedAt: number | null;
    taskStartedAt: number | null;
  }> {
    const result: ReturnType<GroupQueue['getDetailedStatus']> = [];
    for (const [jid, state] of this.groups) {
      result.push({
        jid,
        active: state.active,
        activeTask: state.activeTask,
        containerName: state.containerName,
        groupFolder: state.groupFolder,
        isWarmup: state.isWarmupContainer,
        pendingMessages: state.pendingMessages,
        pendingTaskCount: state.pendingTasks.length,
        spawnReason: state.spawnReason,
        taskSpawnReason: state.taskSpawnReason,
        startedAt: state.startedAt,
        taskStartedAt: state.taskStartedAt,
      });
    }
    return result;
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const activeContainers: string[] = [];
    for (const [, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
