/**
 * Auto-Dispatcher
 *
 * Periodically picks up unassigned kanban tasks, matches them to the best
 * persona, and enqueues them in the GroupQueue task slot for execution.
 */
import fs from 'fs';

import { logger } from './logger.js';
import { PersonaRegistry, type PersonaMatch } from './persona-registry.js';
import { GroupQueue } from './group-queue.js';
import type { ContainerInput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import type Database from 'better-sqlite3';

/** Callback to actually spawn a container for a dispatched task */
export type SpawnTaskFn = (
  groupJid: string,
  group: RegisteredGroup,
  input: ContainerInput,
) => Promise<void>;

export interface DispatchRecord {
  taskId: string;
  personaId: string;
  personaName: string;
  department: string;
  description: string;
  confidence: number;
  dispatchedAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
}

const DISPATCH_INTERVAL_MS = 60_000; // Check every 60s
const MIN_CONFIDENCE = 0.30;         // Minimum match confidence (Gemini semantic-dominant hybrid)
const MAX_FAILURES = 3;              // Stop re-dispatching after this many failures
const FAILURE_COOLDOWN_MIN = 30;     // Minutes to wait after a failure before retrying

export class AutoDispatcher {
  private db: Database.Database;
  private registry: PersonaRegistry;
  private queue: GroupQueue;
  private getRegisteredGroups: () => Record<string, RegisteredGroup>;
  private spawnTaskFn: SpawnTaskFn;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private dispatches: DispatchRecord[] = [];

  constructor(opts: {
    db: Database.Database;
    registry: PersonaRegistry;
    queue: GroupQueue;
    getRegisteredGroups: () => Record<string, RegisteredGroup>;
    spawnTaskFn: SpawnTaskFn;
  }) {
    this.db = opts.db;
    this.registry = opts.registry;
    this.queue = opts.queue;
    this.getRegisteredGroups = opts.getRegisteredGroups;
    this.spawnTaskFn = opts.spawnTaskFn;

    // Create dispatch tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        persona_name TEXT NOT NULL,
        department TEXT NOT NULL,
        description TEXT,
        confidence REAL NOT NULL,
        dispatched_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT DEFAULT 'queued'
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_log(status);
      CREATE INDEX IF NOT EXISTS idx_dispatch_time ON dispatch_log(dispatched_at);
    `);

    // On startup, reset any tasks orphaned by previous process death
    this.resetOrphanedOnStartup();
  }

  /** Start the auto-dispatch timer */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('AutoDispatcher started (checking every 60s)');
    // Run immediately, then schedule next tick after completion (no overlap)
    this.tick();
  }

  /** Stop the auto-dispatch timer */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('AutoDispatcher stopped');
  }

  /** One tick of the dispatch loop (async, schedules next tick after completion) */
  private async tick(): Promise<void> {
    try {
      await this.dispatchUnassignedTasks();
    } catch (err) {
      logger.warn({ err }, 'AutoDispatcher tick error');
    }
    // Schedule next tick only if not stopped
    if (this.running) {
      this.timer = setTimeout(() => this.tick(), DISPATCH_INTERVAL_MS);
    }
  }

  /** Find unassigned kanban tasks and dispatch them */
  private async dispatchUnassignedTasks(): Promise<void> {
    // Reset stale dispatches: tasks stuck in_progress from failed dispatches
    this.resetStaleDispatches();

    const groups = this.getRegisteredGroups();
    const queueStatus = this.queue.getDetailedStatus();

    // Build list of available group slots per project
    // All claw-lexios* groups handle lexios tasks; main handles nanoclaw tasks
    const projectSlots: { jid: string; group: RegisteredGroup; project: string }[] = [];

    for (const [jid, group] of Object.entries(groups)) {
      const groupStatus = queueStatus.find(s => s.jid === jid);
      if (groupStatus?.activeTask) continue; // slot busy

      if (group.folder.startsWith('claw-lexios')) {
        projectSlots.push({ jid, group, project: 'lexios' });
      } else if (group.folder === 'main') {
        projectSlots.push({ jid, group, project: 'nanoclaw' });
      }
    }

    if (projectSlots.length === 0) return;

    // Get unassigned tasks for each project that has idle slots
    const projectsWithSlots = [...new Set(projectSlots.map(s => s.project))];

    for (const project of projectsWithSlots) {
      const idleSlots = projectSlots.filter(s => s.project === project);
      if (idleSlots.length === 0) continue;

      // Dependency-aware dispatch: only dispatch tasks whose dependencies are all completed
      const eligibleTasks = this.getDependencyReadyTasks(project, idleSlots.length);

      // Dispatch each task to an idle slot
      let slotIdx = 0;
      for (const task of eligibleTasks) {
        if (slotIdx >= idleSlots.length) break;

        const match = await this.registry.findBestPersonaSemantic(task.description);
        if (!match || match.confidence < MIN_CONFIDENCE) {
          logger.info({
            taskId: task.id,
            confidence: match?.confidence?.toFixed(3),
            semanticScore: match?.semanticScore?.toFixed(3),
            keywordScore: match?.keywordScore?.toFixed(3),
            persona: match?.persona?.name,
            desc: task.description?.slice(0, 60),
          }, 'No persona match above threshold');
          continue;
        }

        this.dispatch(task, match, idleSlots[slotIdx].jid, idleSlots[slotIdx].group);
        slotIdx++;
      }
    }
  }

  /**
   * Get tasks eligible for dispatch, respecting dependency ordering.
   * A task is READY when all tasks listed in its `dependencies` JSON array
   * have status 'completed' or 'done'. Tasks with empty/null dependencies
   * are always eligible.
   */
  private getDependencyReadyTasks(project: string, limit: number): any[] {
    // Query tasks whose dependencies are ALL satisfied (completed/done).
    // Uses json_each() to expand the dependencies array and NOT EXISTS
    // to ensure no unsatisfied dependency remains.
    const tasks = this.db.prepare(`
      SELECT t.id, t.description, t.priority, t.project
      FROM tasks t
      WHERE t.status IN ('todo', 'pending')
        AND (t.assigned_agent IS NULL OR t.assigned_agent = '')
        AND t.project = ?
        AND t.description NOT LIKE '[Human Action]%'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(
            CASE
              WHEN t.dependencies IS NULL OR t.dependencies = '' OR t.dependencies = '[]' THEN '[]'
              ELSE t.dependencies
            END
          ) d
          JOIN tasks dep ON dep.id = d.value
          WHERE dep.status NOT IN ('completed', 'done')
        )
        -- Skip tasks that have failed too many times
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_log d
          WHERE d.task_id = t.id AND d.status = 'failed'
          GROUP BY d.task_id
          HAVING COUNT(*) >= ${MAX_FAILURES}
        )
        -- Skip tasks whose last failure was within cooldown period
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_log d
          WHERE d.task_id = t.id AND d.status = 'failed'
            AND (julianday('now') - julianday(d.completed_at)) * 24 * 60 < ${FAILURE_COOLDOWN_MIN}
        )
      ORDER BY t.priority DESC
      LIMIT ?
    `).all(project, limit) as any[];

    // Count blocked and retry-exhausted tasks for logging
    const blocked = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM tasks t
      WHERE t.status IN ('todo', 'pending')
        AND (t.assigned_agent IS NULL OR t.assigned_agent = '')
        AND t.project = ?
        AND EXISTS (
          SELECT 1 FROM json_each(t.dependencies) d
          JOIN tasks dep ON dep.id = d.value
          WHERE dep.status NOT IN ('completed', 'done')
        )
    `).get(project) as any;

    const retryExhausted = this.db.prepare(`
      SELECT t.id FROM tasks t
      WHERE t.status IN ('todo', 'pending')
        AND (t.assigned_agent IS NULL OR t.assigned_agent = '')
        AND t.project = ?
        AND EXISTS (
          SELECT 1 FROM dispatch_log d
          WHERE d.task_id = t.id AND d.status = 'failed'
          GROUP BY d.task_id
          HAVING COUNT(*) >= ${MAX_FAILURES}
        )
    `).all(project) as any[];

    if (tasks.length > 0 || retryExhausted.length > 0) {
      logger.info({
        project,
        ready: tasks.length,
        blocked: blocked?.cnt || 0,
        retryExhausted: retryExhausted.length,
        exhaustedIds: retryExhausted.map((t: any) => t.id),
        readyIds: tasks.map((t: any) => t.id),
      }, 'Dependency-aware dispatch');
    }

    return tasks;
  }

  /** Reset tasks stuck in_progress from failed or orphaned dispatches */
  private resetStaleDispatches(): void {
    // Find tasks that are in_progress but their latest dispatch either:
    // 1. Failed explicitly
    // 2. Has been "running" for over 100 minutes (exceeds max container timeout of 90 min)
    const stale = this.db.prepare(`
      SELECT t.id, d.status as dispatch_status FROM tasks t
      INNER JOIN dispatch_log d ON d.task_id = t.id
      WHERE t.status = 'in_progress'
        AND d.dispatched_at = (
          SELECT MAX(d2.dispatched_at) FROM dispatch_log d2 WHERE d2.task_id = t.id
        )
        AND (
          d.status = 'failed'
          OR (d.status = 'running' AND (julianday('now') - julianday(d.dispatched_at)) * 24 * 60 > 100)
        )
    `).all() as any[];

    if (stale.length > 0) {
      const resetTaskStmt = this.db.prepare(
        'UPDATE tasks SET status = ?, assigned_agent = ? WHERE id = ?',
      );
      const resetDispatchStmt = this.db.prepare(
        'UPDATE dispatch_log SET status = ?, completed_at = ? WHERE task_id = ? AND status = ?',
      );
      for (const row of stale) {
        resetTaskStmt.run('pending', null, row.id);
        // Also mark orphaned "running" dispatch_log entries as failed
        if (row.dispatch_status === 'running') {
          resetDispatchStmt.run('failed', new Date().toISOString(), row.id, 'running');
        }
      }
      logger.info({ count: stale.length, ids: stale.map((r: any) => r.id) }, 'Reset stale dispatched tasks');
    }
  }

  /**
   * On startup, reset ALL in_progress tasks whose dispatch is still "running".
   * After a service restart, those containers are dead — the work was lost.
   * Called once from the constructor, not on every tick.
   */
  private resetOrphanedOnStartup(): void {
    const orphaned = this.db.prepare(`
      SELECT t.id FROM tasks t
      INNER JOIN dispatch_log d ON d.task_id = t.id
      WHERE t.status = 'in_progress'
        AND d.dispatched_at = (
          SELECT MAX(d2.dispatched_at) FROM dispatch_log d2 WHERE d2.task_id = t.id
        )
        AND d.status IN ('running', 'queued')
    `).all() as any[];

    if (orphaned.length > 0) {
      const resetTask = this.db.prepare(
        'UPDATE tasks SET status = ?, assigned_agent = NULL WHERE id = ?',
      );
      const resetDispatch = this.db.prepare(
        'UPDATE dispatch_log SET status = ?, completed_at = ? WHERE task_id = ? AND status IN (?, ?)',
      );
      const now = new Date().toISOString();
      for (const row of orphaned) {
        resetTask.run('pending', row.id);
        resetDispatch.run('failed', now, row.id, 'running', 'queued');
      }
      logger.info(
        { count: orphaned.length, ids: orphaned.map((r: any) => r.id) },
        'Reset orphaned in_progress tasks on startup',
      );
    }
  }

  /** Dispatch a task to a persona */
  private async dispatch(
    task: { id: string; description: string; project?: string },
    match: PersonaMatch,
    groupJid: string,
    group: RegisteredGroup,
  ): Promise<void> {
    const now = new Date().toISOString();
    const { persona, confidence } = match;

    // Update task assignment in kanban
    this.db.prepare(
      'UPDATE tasks SET status = ?, assigned_agent = ? WHERE id = ?',
    ).run('in_progress', persona.name, task.id);

    // Log the dispatch
    this.db.prepare(`
      INSERT INTO dispatch_log (task_id, persona_id, persona_name, department, description, confidence, dispatched_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')
    `).run(task.id, persona.id, persona.name, persona.department, task.description, confidence, now);

    // Mark persona as dispatched
    this.registry.markDispatched(persona.id);

    // Add to in-memory dispatches
    this.dispatches.push({
      taskId: task.id,
      personaId: persona.id,
      personaName: persona.name,
      department: persona.department,
      description: task.description,
      confidence,
      dispatchedAt: now,
      status: 'queued',
    });
    // Keep only last 50
    if (this.dispatches.length > 50) this.dispatches.shift();

    // Read persona content from file
    let personaContent: string | undefined;
    try {
      if (fs.existsSync(persona.filePath)) {
        personaContent = fs.readFileSync(persona.filePath, 'utf-8');
      }
    } catch { /* persona file not readable */ }

    // Add project context
    let projectContext = '';
    if (task.project === 'lexios') {
      projectContext = `
## Project: Lexios
Construction document intelligence platform. Codebase at /workspace/lexios/ (read-only mount).
Use desktop_claude to make changes — it spawns a full Claude Code session on the host at ~/Lexios/.
desktop_claude has full tool access (Read, Write, Edit, Bash, Agent, etc.), no budget limit, 30 min timeout.
Read /workspace/group/MEMORY.md for current project state before starting.
`;
    } else if (task.project === 'nanoclaw') {
      projectContext = `
## Project: NanoClaw
Personal Claude assistant platform. Codebase at /workspace/project/ (read-only mount).
Use desktop_claude to make changes — it spawns a full Claude Code session on the host at ~/nanoclaw/.
desktop_claude has full tool access (Read, Write, Edit, Bash, Agent, etc.), no budget limit, 30 min timeout.
After code changes: run npm run build to compile TypeScript. If container code changed, run ./container/build.sh.
Read /workspace/group/MEMORY.md for current project state before starting.
`;
    }

    // Guardrails + verification — safety boundaries, not capability limits
    const guardrailsBlock = `
## Guardrails
- DO NOT git push to any remote without explicit approval. Commit locally only.
- DO NOT delete files outside the project directory.
- DO NOT modify .env files containing real API keys — create .env.example instead.
- DO NOT install system-level packages (brew, apt). Python packages in venv are OK.

## desktop_claude Usage
When calling desktop_claude:
- DO NOT set max_budget_usd — leave it unset so it runs unlimited. You are on an unlimited plan.
- Set workdir to the appropriate project root (NOT ~/nanoclaw unless working on NanoClaw itself).
- Give detailed, actionable prompts with specific file paths and implementation steps.
- One desktop_claude call per major task — batch related changes together.

## MANDATORY: Verification Protocol
You must verify every code change. No exceptions.
1. After writing code, run the build/import check:
   - Python: python -c "import <module>" or python -m pytest tests/ -x --tb=short
   - TypeScript: npm run build
2. If no tests exist for your change, WRITE a test. Minimum: one test per new function covering the happy path.
3. If tests fail, fix the code and re-run. Loop until green.
4. Your final message MUST include:
   - Files changed (with paths)
   - Test command run
   - Test output (pass/fail, count)
   - If any test was skipped or couldn't run, explain why
5. NEVER report "done" with failing tests or untested code.
`;

    // Task completion protocol
    const agentAuthor = `${persona.name} (${persona.department}) <agent@nanoclaw>`;
    const completionBlock = `
## MANDATORY: Task Completion
When you finish this task:
1. **Work on a feature branch.** In your desktop_claude prompt, ALWAYS start with:
   "First: git checkout -b claw/${task.id}"
   Then implement, test, and commit on that branch:
   "git add -A && git commit --author='${agentAuthor}' -m '[Agent] ${task.id}: <brief description>

Automated by: ${persona.name} (${persona.department})
Dispatched by: NanoClaw Auto-Dispatch'"
   This is critical — uncommitted work is invisible and gets redone.
2. **Propose for approval.** Call propose_implementation with:
   - task_id: "${task.id}"
   - branch: "claw/${task.id}"
   - summary: brief description of changes
   - files_changed, insertions, deletions from git diff --stat
   The user will approve or reject via WhatsApp. Do NOT merge to main yourself.
3. Use task_tool to mark it: action=update, taskId="${task.id}", status="review"
4. Your final message MUST include a summary of what was done, files changed, and test results.
5. If you cannot complete the task, use task_tool: action=update, taskId="${task.id}", status="blocked"
   and explain what's blocking you.
`;

    // GSD context injection: if there's an active spec, include it
    let gsdContext = '';
    try {
      const { generateCompactStatus } = await import('./gsd/context-keeper.js');
      const { getActiveSpecs } = await import('./gsd/spec-manager.js');
      const activeSpecs = getActiveSpecs();
      if (activeSpecs.length > 0) {
        const status = generateCompactStatus(activeSpecs[0].id);
        if (status) gsdContext = `\n${status}\n`;
      }
    } catch { /* GSD not initialized yet */ }

    // Enqueue in GroupQueue task slot
    const prompt = `[AUTO-DISPATCH] Task: ${task.description}\n${gsdContext}${projectContext}\n${guardrailsBlock}\n${completionBlock}\nYou are ${persona.name} (${persona.department}). Complete this task using your specialized expertise.\n\nTask ID: ${task.id}`;

    const containerInput: ContainerInput = {
      prompt,
      groupFolder: group.folder,
      chatJid: groupJid,
      isMain: true,
      designation: 'task',
      personaId: persona.id,
      personaContent,
      dispatchTaskId: task.id,
    };

    const spawnFn = this.spawnTaskFn;
    this.queue.enqueueTask(groupJid, `dispatch-${task.id}`, async () => {
      await spawnFn(groupJid, group, containerInput);
    });

    logger.info({
      taskId: task.id,
      persona: persona.name,
      department: persona.department,
      confidence: confidence.toFixed(3),
      semanticScore: match.semanticScore?.toFixed(3),
      keywordScore: match.keywordScore?.toFixed(3),
      matchedKeywords: match.matchedKeywords?.slice(0, 5),
    }, 'Auto-dispatched task to persona');
  }

  /** Get recent dispatch records for the dashboard */
  getRecentDispatches(limit = 20): DispatchRecord[] {
    return this.db.prepare(`
      SELECT task_id, persona_id, persona_name, department, description, confidence, dispatched_at, status
      FROM dispatch_log
      ORDER BY dispatched_at DESC
      LIMIT ?
    `).all(limit) as any[];
  }

  /** Get dispatch stats */
  getStats(): { total: number; queued: number; running: number; completed: number; failed: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM dispatch_log
    `).get() as any;
    return row || { total: 0, queued: 0, running: 0, completed: 0, failed: 0 };
  }

  /** Mark a dispatch as completed or failed */
  updateDispatchStatus(taskId: string, status: 'completed' | 'failed'): void {
    this.db.prepare(
      'UPDATE dispatch_log SET status = ?, completed_at = ? WHERE task_id = ? AND status IN (?, ?)',
    ).run(status, new Date().toISOString(), taskId, 'queued', 'running');
  }
}
