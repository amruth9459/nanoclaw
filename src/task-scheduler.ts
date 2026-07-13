import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  logUsage,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { calculateCost, getActiveProvider } from './economics.js';
import { cleanupOldMedia } from './media-cleanup.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { getIntegrations } from './integration-loader.js';
import { observerGuard } from './observer-guard.js';
import { AgentPriority, ResourceOrchestrator } from './resource-orchestrator.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Silence sentinels — when a scheduled task's final result matches one of
 * these, it's an "internal" signal that there's nothing actionable to report.
 * Don't forward it as a WhatsApp message (caused 119/139 = 86% of EV-lease
 * group messages over 7d to be spam).
 *
 * Also matches the "Claw: " prefix that sendMessage adds in non-shared-number mode.
 */
const SILENCE_SENTINELS: RegExp[] = [
  /^(claw:\s*)?no response requested\.?\s*$/i,
  /^(claw:\s*)?silent pass( completed)?[.!]?\s*$/i,
  /^(claw:\s*)?no new (roles?|opportunities|leads?|listings?|matches|deals?|items?) found.*$/i,
  /^(claw:\s*)?nothing( new)? to report\.?\s*$/i,
  /^(claw:\s*)?no actionable (findings|results?|opportunities)\.?\s*$/i,
  // Pre-work narration that some agents emit as their final result
  /^(claw:\s*)?i'?ll (generate|run|check|verify|create|prepare|review|fetch|search) /i,
  /^(claw:\s*)?let me (check|verify|generate|run|prepare|review) /i,
  /^(claw:\s*)?running (the )?(daily |morning |evening |security |nightly )?(report|briefing|audit|scan|check|review)/i,
  /^(claw:\s*)?generating (the )?(daily |morning |evening |security |nightly )?(report|briefing)/i,
];

// Safety acknowledgment messages — agents echoing safety-pulse reminders.
// These can be longer than the silence-sentinel guard (bullet lists), so
// matched separately with no length cap.
const SAFETY_ACK_PATTERNS: RegExp[] = [
  /^(claw:\s*)?safety (constraints?|reminder)s? (acknowledged|noted|active)/i,
  /^(claw:\s*)?acknowledged[.!]?\s*all (safety )?constraints/i,
  /^(claw:\s*)?standing by[.!]?\s*$/i,
];

function isSilenceSentinel(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  // Safety acks: any length, since the bullet list is all boilerplate
  if (SAFETY_ACK_PATTERNS.some(re => re.test(trimmed))) return true;
  // Other sentinels only match short messages — real reports are long
  if (trimmed.length > 500) return false;
  return SILENCE_SENTINELS.some(re => re.test(trimmed));
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  orchestrator?: ResourceOrchestrator;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();

  // Observer Guard, Layers 1–3: admission control. This is a synchronous
  // read-then-decide; the matching startExecution() below commits the slot.
  // There must be NO `await` between this check and startExecution() so the
  // concurrency accounting stays race-free on the event loop.
  const decision = observerGuard.shouldRunTask(task);
  if (!decision.allow) {
    logger.info(
      { taskId: task.id, group: task.group_folder, layer: decision.layer, reason: decision.reason },
      'Scheduled task blocked by Observer Guard',
    );
    return;
  }

  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Observer Guard: commit the concurrency slot and apply the Layer-5
  // lazy-start stagger before any container work begins. Registration is
  // synchronous (happens before this promise's first await), so a burst of
  // due tasks is counted correctly even while staggering.
  await observerGuard.startExecution(task.id, task.group_folder);

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // Track task agent lifecycle in orchestrator
  const taskDesignation = task.id.includes('bounty-hunter') ? 'bounty' : 'task';
  let orchType = 'nanoclaw';
  for (const integration of getIntegrations()) {
    const t = integration.determineOrchestratorType?.(task.group_folder);
    if (t) { orchType = t; break; }
  }
  const agentId = `nanoclaw-task-${task.group_folder}-${Date.now()}`;
  await deps.orchestrator?.requestAgent({
    id: agentId,
    type: orchType,
    priority: AgentPriority.MEDIUM,
    estimatedRamGB: 2,
    taskId: String(task.id),
  });

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id, groupFolder: task.group_folder }, 'Closing task container after result');
      // Scheduled tasks live in the activeTask slot; closeStdin gates on state.active
      // which is only set for user-message containers. closeTaskStdin writes the
      // sentinel by group folder directly.
      deps.queue.closeTaskStdin(task.group_folder);
    }, TASK_CLOSE_DELAY_MS);
  };

  // Set spawn reason and designation for dashboard
  const taskPreview = task.prompt.slice(0, 120) + (task.prompt.length > 120 ? '…' : '');
  deps.queue.setSpawnReason(task.chat_jid, taskPreview, true);
  deps.queue.setDesignation(task.chat_jid, taskDesignation, true);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        designation: taskDesignation,
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Only forward the FINAL result (isPartial=false). Forwarding every
          // streaming chunk caused intermediate "thinking" messages and same-
          // content duplicates (the partial chunk + the final chunk both fire).
          // Also drop "silence sentinel" outputs that the agent uses to signal
          // no action needed — they shouldn't reach the user.
          if (!streamedOutput.isPartial && !isSilenceSentinel(streamedOutput.result)) {
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
          } else if (streamedOutput.isPartial) {
            logger.debug({ taskId: task.id }, 'Skipping partial streaming chunk');
          } else {
            logger.info({ taskId: task.id, sentinel: streamedOutput.result.slice(0, 80) },
              'Task returned silence sentinel — not forwarding to chat');
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          // Track usage/cost for scheduled tasks (same as user messages)
          if (streamedOutput.usage && !streamedOutput.isPartial) {
            const costUsd = calculateCost(streamedOutput.usage);
            const durationMs = Date.now() - startTime;
            const purpose = task.id.includes('bounty-hunter') ? 'bounty' : 'task';
            logUsage(task.group_folder, task.chat_jid, streamedOutput.usage, durationMs, true, costUsd, purpose, getActiveProvider());
            logger.info({ taskId: task.id, costUsd, usage: streamedOutput.usage }, 'Task cost tracked');
          }
          // NOTE: do NOT call notifyIdle here — it mutates the *message* slot
          // (idleWaiting + _close to the live conversation container). A task
          // finishing must not tear down a parallel message container. The task
          // winds down via scheduleClose() → closeTaskStdin() below.
          // Tasks that signal success without populating `result` (e.g. agent sent
          // the WhatsApp reply via MCP tool, then returned silent success) won't
          // hit the result-branch above. Schedule close here too — otherwise
          // the container sits until the 2h max-lifetime cap.
          if (!streamedOutput.isPartial) scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  // Observer Guard: release the concurrency slot and update Layer-3 failure/
  // throttle state. Done before orchestrator release so the slot is freed even
  // if that call rejects.
  observerGuard.endExecution(task.id, !error, durationMs);

  // Release orchestrator tracking
  await deps.orchestrator?.releaseAgent(agentId, error ? 'error' : 'completed');

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun: string | null = null;
  try {
    if (task.schedule_type === 'cron') {
      const interval = CronExpressionParser.parse(task.schedule_value, {
        tz: TIMEZONE,
      });
      nextRun = interval.next().toISOString();
    } else if (task.schedule_type === 'interval') {
      const ms = parseInt(task.schedule_value, 10);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`invalid interval: ${task.schedule_value}`);
      nextRun = new Date(Date.now() + ms).toISOString();
    }
    // 'once' tasks have no next run
  } catch (schedErr) {
    // A bad schedule must not leave next_run in the past — that reruns the task
    // every poll forever. Pause it and surface the error.
    const msg = schedErr instanceof Error ? schedErr.message : String(schedErr);
    logger.error({ taskId: task.id, schedule: task.schedule_value, err: msg }, 'Invalid task schedule — pausing task');
    updateTask(task.id, { status: 'paused', next_run: null });
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: 0,
      status: 'error',
      result: null,
      error: `Paused: invalid schedule "${task.schedule_value}" (${msg})`,
    });
    return;
  }

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  // Run media cleanup on startup
  cleanupOldMedia();

  // Track when we last ran cleanup (once per day)
  let lastCleanupDay = new Date().getDate();

  // Task IDs currently queued or running. next_run is only advanced AFTER a run
  // completes, so a task taking >1 poll interval stays "due" and would be
  // re-enqueued every tick (running the daily report twice, tripling cost).
  // Guard here so each due task is enqueued at most once per firing.
  const inFlight = new Set<string>();

  const loop = async () => {
    try {
      // Run daily media cleanup at midnight
      const currentDay = new Date().getDate();
      if (currentDay !== lastCleanupDay) {
        lastCleanupDay = currentDay;
        cleanupOldMedia();
      }

      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Skip if this task is already queued or running from a prior tick.
        if (inFlight.has(currentTask.id)) {
          continue;
        }
        inFlight.add(currentTask.id);

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          async () => {
            try {
              await runTask(currentTask, deps);
            } finally {
              inFlight.delete(currentTask.id);
            }
          },
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();

  // ── Observer Guard, Layer 4: timeout monitoring + self-cleaning ───────────
  // Runs on its own cadence (independent of the 60s scheduler poll) so a stuck
  // task is detected promptly. Tasks past the limit are wound down via the
  // task close sentinel; metrics for deleted tasks are pruned.
  const GUARD_MONITOR_INTERVAL = 30000;
  const monitorLoop = () => {
    try {
      const timedOut = observerGuard.getTimedOutTasks();
      for (const t of timedOut) {
        logger.warn(
          { taskId: t.taskId, groupFolder: t.groupFolder, ageMs: t.ageMs },
          'Observer Guard: killing timed-out task',
        );
        // Wind the task container down via its IPC close sentinel. The
        // container's own hard timeout is the ultimate backstop.
        deps.queue.closeTaskStdin(t.groupFolder);
      }

      // Self-cleaning: drop failure/throttle metrics for tasks that no longer
      // exist so the guard doesn't accumulate state for deleted schedules.
      const knownTaskIds = new Set(getAllTasks().map((t) => t.id));
      observerGuard.prune(knownTaskIds);
    } catch (err) {
      logger.error({ err }, 'Error in Observer Guard monitor loop');
    }
    setTimeout(monitorLoop, GUARD_MONITOR_INTERVAL);
  };
  monitorLoop();
}
