/**
 * Integration Layer for Judge System + Response Time Manager
 *
 * Orchestrates both systems in the NanoClaw workflow:
 * 1. Response Time Manager tracks user requests and sends progress
 * 2. Judge System reviews outputs before delivery
 * 3. Combined: transparent progress + quality assurance
 */

import { JudgeSystem, JudgeSystemFactory, JudgeResult } from '../judge-system.js';
import { ResponseTimeManager, ResponseTimeManagerFactory } from '../response-time-manager.js';

export interface IntegrationConfig {
  enableJudges: boolean; // Default: true for code/reports, false for simple queries
  enableResponseTime: boolean; // Default: true
  judgeThreshold: 'always' | 'code-only' | 'revenue-only' | 'never'; // When to use judges
  progressThreshold: number; // Min task duration (ms) for progress updates
  autoApproveMinorIssues: boolean; // Auto-approve if only minor issues found
}

export interface TaskContext {
  taskId: string;
  userQuery: string;
  taskType: 'code' | 'report' | 'analysis' | 'response' | 'documentation' | 'simple-query';
  isRevenueProduct: boolean; // OSHA reports, grant digests, etc.
  sendMessage: (msg: string) => Promise<void>;
}

export interface TaskResult {
  content: string;
  judgeResult?: JudgeResult;
  approved: boolean; // Whether to send to user
  recommendation: string; // What to do with this result
  duration: number; // Total execution time (ms)
}

/**
 * Integrated Task Manager
 * Combines judge system + response time tracking
 */
export class IntegratedTaskManager {
  private judgeSystem: JudgeSystem;
  private responseManager: ResponseTimeManager;
  private config: Required<IntegrationConfig>;

  constructor(config?: Partial<IntegrationConfig>) {
    this.config = {
      enableJudges: true,
      enableResponseTime: true,
      judgeThreshold: 'code-only',
      progressThreshold: 30000, // 30 seconds
      autoApproveMinorIssues: true,
      ...config,
    };

    this.judgeSystem = JudgeSystemFactory.create();
    this.responseManager = ResponseTimeManagerFactory.create();
  }

  /**
   * Execute a task with full integration
   *
   * Flow:
   * 1. Start response time tracking (sends acknowledgment)
   * 2. Execute task (with progress updates)
   * 3. Review output with judges (if applicable)
   * 4. Send final result to user (if approved)
   */
  async executeTask(
    context: TaskContext,
    taskExecutor: () => Promise<string>
  ): Promise<TaskResult> {
    const startTime = Date.now();

    // Step 1: Start response time tracking
    if (this.config.enableResponseTime) {
      await this.responseManager.startTask(
        context.taskId,
        context.userQuery,
        context.sendMessage
      );
    }

    // Step 2: Execute the task
    let content: string;
    try {
      content = await taskExecutor();
    } catch (error) {
      this.responseManager.completeTask();
      throw error;
    }

    // Step 3: Determine if judges should review
    const shouldJudge = this.shouldUseJudges(context);

    let judgeResult: JudgeResult | undefined;
    let approved = true; // Default: approve without judges
    let recommendation = 'Send to user';

    if (shouldJudge && this.config.enableJudges) {
      // Update progress: reviewing output
      await this.responseManager.updateProgress(
        'Quality review in progress',
        context.sendMessage
      );

      // Submit for peer review
      judgeResult = await this.judgeSystem.review({
        id: context.taskId,
        content,
        contentType: this.mapTaskTypeToContentType(context.taskType),
        context: `User query: ${context.userQuery}`,
        requestedAt: startTime,
      });

      // Determine approval based on judge results
      const decision = this.makeDecision(judgeResult);
      approved = decision.approved;
      recommendation = decision.recommendation;

      // Send judge verdict to user
      await this.sendJudgeVerdict(judgeResult, decision, context.sendMessage);
    }

    // Step 4: Complete task
    this.responseManager.completeTask();

    const duration = Date.now() - startTime;

    return {
      content,
      judgeResult,
      approved,
      recommendation,
      duration,
    };
  }

  /**
   * Determine if judges should review this task
   */
  private shouldUseJudges(context: TaskContext): boolean {
    switch (this.config.judgeThreshold) {
      case 'always':
        return true;

      case 'never':
        return false;

      case 'code-only':
        return context.taskType === 'code';

      case 'revenue-only':
        return context.isRevenueProduct;

      default:
        return false;
    }
  }

  /**
   * Map task type to judge content type
   */
  private mapTaskTypeToContentType(
    taskType: TaskContext['taskType']
  ): 'code' | 'report' | 'analysis' | 'response' | 'documentation' {
    if (taskType === 'simple-query') {
      return 'response';
    }
    return taskType;
  }

  /**
   * Make decision based on judge results
   */
  private makeDecision(judgeResult: JudgeResult): {
    approved: boolean;
    recommendation: string;
  } {
    // Critical issues = always reject
    if (judgeResult.criticalIssues > 0) {
      return {
        approved: false,
        recommendation: `❌ BLOCKED: ${judgeResult.criticalIssues} critical issue(s) found. Fix and retry.`,
      };
    }

    // Consensus reject = reject
    if (judgeResult.consensus === 'reject') {
      return {
        approved: false,
        recommendation: `❌ REJECTED: Judges recommend not sending. Review feedback and revise.`,
      };
    }

    // Needs revision but only minor issues = approve if config allows
    if (
      judgeResult.consensus === 'needs_revision' &&
      judgeResult.majorIssues === 0 &&
      this.config.autoApproveMinorIssues
    ) {
      return {
        approved: true,
        recommendation: `✅ APPROVED (with minor notes): ${judgeResult.minorIssues} minor issue(s) noted but not blocking.`,
      };
    }

    // Needs revision with major issues = reject
    if (judgeResult.consensus === 'needs_revision') {
      return {
        approved: false,
        recommendation: `⚠️ NEEDS REVISION: ${judgeResult.majorIssues} major issue(s) found. Review and fix.`,
      };
    }

    // Approve = approve
    return {
      approved: true,
      recommendation: `✅ APPROVED: All judges approved. Ready to send.`,
    };
  }

  /**
   * Send judge verdict to user
   */
  private async sendJudgeVerdict(
    judgeResult: JudgeResult,
    decision: { approved: boolean; recommendation: string },
    sendMessage: (msg: string) => Promise<void>
  ): Promise<void> {
    const { criticalIssues, majorIssues, minorIssues, confidence } = judgeResult;

    let message = `🔍 *Quality Review Complete*\n\n`;
    message += `${decision.recommendation}\n\n`;

    if (criticalIssues > 0 || majorIssues > 0 || minorIssues > 0) {
      message += `*Issues Found:*\n`;
      if (criticalIssues > 0) message += `• 🚨 ${criticalIssues} Critical\n`;
      if (majorIssues > 0) message += `• ⚠️ ${majorIssues} Major\n`;
      if (minorIssues > 0) message += `• ℹ️ ${minorIssues} Minor\n`;
      message += `\n`;
    }

    message += `*Confidence:* ${Math.round(confidence * 100)}%\n`;
    message += `*Judges:* ${judgeResult.votes.length} reviewed\n`;

    // Show top issues (if any)
    const allIssues = judgeResult.votes.flatMap(v => v.issues);
    const topIssues = allIssues
      .filter(i => i.severity === 'critical' || i.severity === 'major')
      .slice(0, 3);

    if (topIssues.length > 0) {
      message += `\n*Top Issues:*\n`;
      topIssues.forEach((issue, i) => {
        const emoji = issue.severity === 'critical' ? '🚨' : '⚠️';
        message += `${i + 1}. ${emoji} ${issue.description}\n`;
        if (issue.suggestion) {
          message += `   _Suggestion: ${issue.suggestion}_\n`;
        }
      });
    }

    await sendMessage(message);
  }

  /**
   * Quick task execution (no judges, minimal overhead)
   */
  async executeQuickTask(
    context: TaskContext,
    taskExecutor: () => Promise<string>
  ): Promise<string> {
    // Only send acknowledgment, no progress updates, no judges
    if (this.config.enableResponseTime) {
      await context.sendMessage(`⚡ Got it! Working on it...`);
    }

    return await taskExecutor();
  }

  /**
   * Stream partial results during long tasks
   */
  async streamPartialResult(
    partialResult: string,
    sendMessage: (msg: string) => Promise<void>
  ): Promise<void> {
    await this.responseManager.streamPartialResult(partialResult, sendMessage);
  }

  /**
   * Manual progress update
   */
  async updateProgress(
    stepName: string,
    sendMessage: (msg: string) => Promise<void>
  ): Promise<void> {
    await this.responseManager.updateProgress(stepName, sendMessage);
  }
}

/**
 * Factory for integrated task manager
 */
export class IntegrationFactory {
  /**
   * Create for production (judges for code + revenue, all response time features)
   */
  static createProduction(): IntegratedTaskManager {
    return new IntegratedTaskManager({
      enableJudges: true,
      enableResponseTime: true,
      judgeThreshold: 'code-only', // Review code changes
      progressThreshold: 30000, // 30 seconds
      autoApproveMinorIssues: true,
    });
  }

  /**
   * Create for development (no judges, minimal overhead)
   */
  static createDev(): IntegratedTaskManager {
    return new IntegratedTaskManager({
      enableJudges: false,
      enableResponseTime: true,
      judgeThreshold: 'never',
      progressThreshold: 60000, // 1 minute
      autoApproveMinorIssues: true,
    });
  }

  /**
   * Create for revenue products (strict judges for quality)
   */
  static createRevenue(): IntegratedTaskManager {
    return new IntegratedTaskManager({
      enableJudges: true,
      enableResponseTime: true,
      judgeThreshold: 'revenue-only',
      progressThreshold: 30000,
      autoApproveMinorIssues: false, // Strict: all issues must be addressed
    });
  }

  /**
   * Create for simple queries (no judges, acknowledgment only)
   */
  static createSimple(): IntegratedTaskManager {
    return new IntegratedTaskManager({
      enableJudges: false,
      enableResponseTime: true,
      judgeThreshold: 'never',
      progressThreshold: 999999, // Effectively never
      autoApproveMinorIssues: true,
    });
  }
}

/**
 * Helper: Wrap container agent execution with integration
 *
 * This is the main integration point for the container agent.
 * Use this to wrap any task execution that should have:
 * - Immediate acknowledgment
 * - Progress updates
 * - Quality review
 */
export async function executeWithIntegration(
  taskId: string,
  userQuery: string,
  taskType: TaskContext['taskType'],
  isRevenueProduct: boolean,
  sendMessage: (msg: string) => Promise<void>,
  taskExecutor: () => Promise<string>
): Promise<TaskResult> {
  const manager = IntegrationFactory.createProduction();

  return manager.executeTask(
    {
      taskId,
      userQuery,
      taskType,
      isRevenueProduct,
      sendMessage,
    },
    taskExecutor
  );
}
