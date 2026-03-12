/**
 * Task Acknowledgment & Time Estimation System
 * Ensures no user waits silently
 *
 * Features:
 * - Immediate acknowledgment for all tasks
 * - Accurate time estimation based on historical data
 * - Progress updates during long tasks
 * - Multi-channel delivery (WhatsApp, WebSocket, etc.)
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import { UniversalRouter, type RoutingContext } from './router/index.js';
import { ResourceOrchestrator } from './resource-orchestrator.js';
import { getIntegrations } from './integration-loader.js';

// Default RAM estimate for task agents
const DEFAULT_AGENT_RAM = 2;

export interface TaskEstimate {
  taskId: string;
  acknowledged: boolean;
  estimatedCompletionMs: number;
  estimatedCompletionTime: Date;
  confidence: 'low' | 'medium' | 'high';
  progressUpdates: boolean; // Will send updates every N%
  queuePosition?: number;
  queueWaitMs?: number;
}

export interface TaskProgress {
  taskId: string;
  status: 'queued' | 'starting' | 'in_progress' | 'completed' | 'failed';
  progressPercent: number;
  currentStep?: string;
  estimatedRemainingMs?: number;
  startTime?: number;
  completionTime?: number;
}

export class TaskAcknowledgment {
  private db: Database.Database;
  private router: UniversalRouter;
  private resourceOrchestrator: ResourceOrchestrator;
  private activeTasks: Map<string, TaskProgress> = new Map();
  private progressCallbacks: Map<string, (progress: TaskProgress) => void> = new Map();

  constructor(
    dbPath: string,
    router: UniversalRouter,
    resourceOrchestrator: ResourceOrchestrator
  ) {
    this.db = new Database(dbPath);
    this.router = router;
    this.resourceOrchestrator = resourceOrchestrator;
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_estimates (
        task_id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        complexity TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        estimated_duration_ms INTEGER NOT NULL,
        actual_duration_ms INTEGER,
        queue_position INTEGER,
        queue_wait_ms INTEGER,
        confidence TEXT NOT NULL,
        user_id TEXT,
        channel TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_type TEXT NOT NULL,
        complexity TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        success BOOLEAN NOT NULL,
        model_used TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_history_type ON task_history(task_type, complexity);
      CREATE INDEX IF NOT EXISTS idx_task_estimates_user ON task_estimates(user_id);
    `);
  }

  /**
   * Acknowledge a new task and provide time estimate
   */
  async acknowledgeTask(request: {
    taskId: string;
    taskType: string;
    complexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
    userId?: string;
    channel: 'whatsapp' | 'websocket' | 'api';
    enableProgressUpdates?: boolean;
  }): Promise<TaskEstimate> {
    // Build routing context for Universal Router
    const routingContext: RoutingContext = {
      taskType: this.mapTaskType(request.taskType),
      userTier: request.userId ? 'paid_customer' : 'internal',
      costBudget: request.userId ? 'limited' : 'zero',
      qualityNeeds: request.complexity === 'expert' ? 'best' : 'good',
      latencyNeeds: 'fast',
      source: request.userId ? this.resolveSource(request.userId) : 'whatsapp',
      isPaidCustomer: !!request.userId,
      customerId: request.userId,
    };

    const routing = await this.router.route(routingContext);

    // Get historical duration data
    const historicalDuration = this.getHistoricalDuration(
      request.taskType,
      request.complexity
    );

    // Estimate based on model latency + processing time
    const estimatedDurationMs =
      historicalDuration || routing.estimatedLatencyMs + this.estimateProcessingTime(request.complexity);

    // Check resource availability
    const resourceRequest = await this.resourceOrchestrator.requestAgent({
      id: request.taskId,
      type: request.userId ? this.resolveAgentType(request.userId) : 'nanoclaw',
      priority: request.userId ? 100 : 75,
      estimatedRamGB: DEFAULT_AGENT_RAM,
      userId: request.userId,
      taskId: request.taskId,
    });

    let queuePosition: number | undefined;
    let queueWaitMs: number | undefined;

    if (!resourceRequest.approved) {
      queuePosition = resourceRequest.queuePosition;
      queueWaitMs = resourceRequest.estimatedWaitMs;
    }

    const totalWaitMs = (queueWaitMs || 0) + estimatedDurationMs;
    const estimatedCompletionTime = new Date(Date.now() + totalWaitMs);

    // Determine confidence based on historical data
    const confidence = this.estimateConfidence(request.taskType, request.complexity);

    // Record estimate
    this.db.prepare(`
      INSERT INTO task_estimates (
        task_id, task_type, complexity, created_at, estimated_duration_ms,
        queue_position, queue_wait_ms, confidence, user_id, channel
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      request.taskId,
      request.taskType,
      request.complexity,
      Date.now(),
      estimatedDurationMs,
      queuePosition || null,
      queueWaitMs || null,
      confidence,
      request.userId || null,
      request.channel
    );

    // Initialize progress tracking
    this.activeTasks.set(request.taskId, {
      taskId: request.taskId,
      status: queuePosition ? 'queued' : 'starting',
      progressPercent: 0,
      estimatedRemainingMs: totalWaitMs,
    });

    logger.info(`[TaskAcknowledgment] Task ${request.taskId} acknowledged (${request.taskType}, ETA ${Math.round(totalWaitMs / 1000)}s)`);

    return {
      taskId: request.taskId,
      acknowledged: true,
      estimatedCompletionMs: totalWaitMs,
      estimatedCompletionTime,
      confidence,
      progressUpdates: request.enableProgressUpdates || false,
      queuePosition,
      queueWaitMs,
    };
  }

  /**
   * Get historical duration for similar tasks
   */
  private getHistoricalDuration(taskType: string, complexity: string): number | null {
    const recent = this.db.prepare(`
      SELECT AVG(duration_ms) as avg_duration
      FROM task_history
      WHERE task_type = ? AND complexity = ?
        AND timestamp >= ? AND success = 1
      LIMIT 50
    `).get(
      taskType,
      complexity,
      Date.now() - 7 * 24 * 60 * 60 * 1000 // Last 7 days
    ) as any;

    return recent?.avg_duration || null;
  }

  /**
   * Estimate processing time based on complexity
   */
  private estimateProcessingTime(complexity: string): number {
    const baseTime: Record<string, number> = {
      trivial: 1000,   // 1 second
      simple: 3000,    // 3 seconds
      moderate: 8000,  // 8 seconds
      complex: 20000,  // 20 seconds
      expert: 60000,   // 60 seconds
    };

    return baseTime[complexity] || 10000;
  }

  /**
   * Estimate confidence in time estimate
   */
  private estimateConfidence(taskType: string, complexity: string): 'low' | 'medium' | 'high' {
    const historicalCount = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM task_history
      WHERE task_type = ? AND complexity = ?
        AND timestamp >= ?
    `).get(
      taskType,
      complexity,
      Date.now() - 30 * 24 * 60 * 60 * 1000 // Last 30 days
    ) as any;

    const count = historicalCount?.count || 0;

    if (count >= 20) return 'high';
    if (count >= 5) return 'medium';
    return 'low';
  }

  /**
   * Update task progress
   */
  updateProgress(taskId: string, update: Partial<TaskProgress>) {
    const current = this.activeTasks.get(taskId);
    if (!current) {
      logger.warn(`[TaskAcknowledgment] Attempted to update unknown task ${taskId}`);
      return;
    }

    const updated = { ...current, ...update };
    this.activeTasks.set(taskId, updated);

    // Trigger callback if registered
    const callback = this.progressCallbacks.get(taskId);
    if (callback) {
      callback(updated);
    }

    logger.debug(`[TaskAcknowledgment] Task ${taskId} progress: ${updated.progressPercent}% (${updated.status})`);
  }

  /**
   * Register callback for progress updates
   */
  onProgress(taskId: string, callback: (progress: TaskProgress) => void) {
    this.progressCallbacks.set(taskId, callback);
  }

  /**
   * Complete a task
   */
  completeTask(taskId: string, success: boolean, actualDurationMs: number) {
    const task = this.activeTasks.get(taskId);
    if (!task) return;

    // Update progress to 100%
    this.updateProgress(taskId, {
      status: success ? 'completed' : 'failed',
      progressPercent: 100,
      completionTime: Date.now(),
    });

    // Update estimate record
    this.db.prepare(`
      UPDATE task_estimates
      SET actual_duration_ms = ?
      WHERE task_id = ?
    `).run(actualDurationMs, taskId);

    // Add to history
    const estimate = this.db.prepare(`
      SELECT task_type, complexity FROM task_estimates WHERE task_id = ?
    `).get(taskId) as any;

    if (estimate) {
      this.db.prepare(`
        INSERT INTO task_history (
          task_type, complexity, duration_ms, success, timestamp
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        estimate.task_type,
        estimate.complexity,
        actualDurationMs,
        success ? 1 : 0,
        Date.now()
      );
    }

    // Cleanup
    this.activeTasks.delete(taskId);
    this.progressCallbacks.delete(taskId);

    logger.info(`[TaskAcknowledgment] Task ${taskId} completed (${success ? 'success' : 'failed'}, ${actualDurationMs}ms)`);
  }

  /**
   * Get progress for a task
   */
  getProgress(taskId: string): TaskProgress | null {
    return this.activeTasks.get(taskId) || null;
  }

  /**
   * Get estimate accuracy statistics
   */
  getEstimateAccuracy(hours: number = 24): any {
    const since = Date.now() - hours * 60 * 60 * 1000;

    return this.db.prepare(`
      SELECT
        task_type,
        complexity,
        confidence,
        COUNT(*) as total_tasks,
        AVG(estimated_duration_ms) as avg_estimated_ms,
        AVG(actual_duration_ms) as avg_actual_ms,
        AVG(ABS(estimated_duration_ms - actual_duration_ms)) as avg_error_ms,
        AVG(CAST(ABS(estimated_duration_ms - actual_duration_ms) AS FLOAT) / actual_duration_ms) as avg_error_percent
      FROM task_estimates
      WHERE created_at >= ? AND actual_duration_ms IS NOT NULL
      GROUP BY task_type, complexity, confidence
    `).all(since);
  }

  /**
   * Format acknowledgment message for user
   */
  formatAcknowledgment(estimate: TaskEstimate, includeDetails: boolean = true): string {
    let message = `✅ *Task received and queued*\n\n`;

    if (estimate.queuePosition) {
      message += `📊 *Queue Position:* ${estimate.queuePosition}\n`;
      if (estimate.queueWaitMs) {
        const waitMinutes = Math.round(estimate.queueWaitMs / 60000);
        message += `⏱ *Estimated Wait:* ${waitMinutes} minutes\n\n`;
      }
    }

    message += `⏰ *Estimated Completion:* ${this.formatTime(estimate.estimatedCompletionMs)}\n`;

    if (includeDetails) {
      message += `📈 *Confidence:* ${estimate.confidence}\n`;

      if (estimate.progressUpdates) {
        message += `\n_You'll receive progress updates as I work on this._`;
      } else {
        message += `\n_I'll notify you when it's done._`;
      }
    }

    return message;
  }

  /**
   * Format progress update message
   */
  formatProgress(progress: TaskProgress): string {
    let message = `🔄 *Progress Update*\n\n`;
    message += `📊 ${progress.progressPercent}% complete\n`;

    if (progress.currentStep) {
      message += `📍 Current: ${progress.currentStep}\n`;
    }

    if (progress.estimatedRemainingMs) {
      message += `⏱ Estimated remaining: ${this.formatTime(progress.estimatedRemainingMs)}`;
    }

    return message;
  }

  /**
   * Format time duration
   */
  private formatTime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Map task type to router task type
   */
  private mapTaskType(taskType: string): RoutingContext['taskType'] {
    const typeMap: Record<string, RoutingContext['taskType']> = {
      conversation: 'conversation',
      vision: 'vision',
      code: 'code',
      reasoning: 'reasoning',
      data: 'data',
      web: 'web',
      extraction: 'vision',
      query: 'conversation',
      review: 'reasoning',
    };
    return typeMap[taskType.toLowerCase()] || 'conversation';
  }

  private resolveSource(userId: string): string {
    for (const integration of getIntegrations()) {
      const claim = integration.claimsUserId?.(userId);
      if (claim) return claim.source;
    }
    return 'whatsapp';
  }

  private resolveAgentType(userId: string): string {
    for (const integration of getIntegrations()) {
      const claim = integration.claimsUserId?.(userId);
      if (claim) return claim.agentType;
    }
    return 'nanoclaw';
  }

  /**
   * Cleanup
   */
  destroy() {
    this.db.close();
  }
}
