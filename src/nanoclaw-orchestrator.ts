/**
 * NanoClaw Master Orchestrator
 * Coordinates all subsystems: Resources, Goals, Teams, Acknowledgment, Universal Router
 *
 * This is the main entry point for complex multi-agent workflows.
 * Integrates:
 * - Resource Orchestrator (64GB RAM management)
 * - Goal Decomposition (breaks goals into tasks)
 * - Team Orchestrator (spawns hierarchical teams)
 * - Task Acknowledgment (time estimates, progress updates)
 * - Universal Router (model selection)
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import { RouterFactory } from './router/index.js';
import { ResourceOrchestrator, AgentPriority } from './resource-orchestrator.js';
import { GoalDecompositionEngine } from './goal-decomposition.js';
import { TeamOrchestrator, type TeamFormationRequest } from './team-orchestrator.js';
import { TaskAcknowledgment } from './task-acknowledgment.js';

export interface OrchestratorConfig {
  dbPath: string;
  enableProgressUpdates?: boolean;
  maxConcurrentTeams?: number;
  resourceOrchestrator?: ResourceOrchestrator;
  router?: ReturnType<typeof RouterFactory.create>;
}

export interface GoalRequest {
  description: string;
  targetValue?: number;
  deadline?: Date;
  priority: 'critical' | 'high' | 'medium' | 'low';
  source: 'user' | 'scheduled' | 'autonomous';
}

export interface WorkflowResult {
  goalId: string;
  teamsFormed: number;
  tasksCreated: number;
  estimatedCompletionHours: number;
  acknowledgment: string; // Message for user
}

/**
 * Master orchestrator that coordinates all NanoClaw subsystems
 */
export class NanoClawOrchestrator {
  private resourceOrchestrator: ResourceOrchestrator;
  private goalEngine: GoalDecompositionEngine;
  private teamOrchestrator: TeamOrchestrator;
  private acknowledgment: TaskAcknowledgment;
  private router: ReturnType<typeof RouterFactory.create>;
  private db: Database.Database;

  constructor(config: OrchestratorConfig) {
    this.db = new Database(config.dbPath);

    // Use injected instances when provided, create own only as fallback
    this.router = config.router ?? RouterFactory.create();
    this.resourceOrchestrator = config.resourceOrchestrator ?? new ResourceOrchestrator(config.dbPath);
    this.goalEngine = new GoalDecompositionEngine(
      config.dbPath,
      this.router,
      this.resourceOrchestrator
    );
    this.teamOrchestrator = new TeamOrchestrator(
      config.dbPath,
      this.resourceOrchestrator,
      this.goalEngine
    );
    this.acknowledgment = new TaskAcknowledgment(
      config.dbPath,
      this.router,
      this.resourceOrchestrator
    );

    logger.info('[NanoClawOrchestrator] All subsystems initialized');
  }

  /**
   * Main workflow: Goal → Decomposition → Team Formation → Execution
   */
  async processGoal(request: GoalRequest): Promise<WorkflowResult> {
    logger.info(`[NanoClawOrchestrator] Processing goal: "${request.description}"`);

    const startTime = Date.now();
    const taskId = `goal_${Date.now()}`;

    // Step 1: Decompose — if decomposition returns 0 tasks (mock/stub mode),
    // return a graceful acknowledgment without attempting team formation
    let decomposition: Awaited<ReturnType<GoalDecompositionEngine['decomposeGoal']>>;
    try {
      decomposition = await this.goalEngine.decomposeGoal({
        description: request.description,
        targetValue: request.targetValue,
        deadline: request.deadline,
        priority: request.priority,
      });
    } catch (err) {
      logger.warn({ err }, '[NanoClawOrchestrator] Goal decomposition failed');
      return {
        goalId: taskId,
        teamsFormed: 0,
        tasksCreated: 0,
        estimatedCompletionHours: 0,
        acknowledgment: `Goal acknowledged but not decomposed — single-agent flow will handle this.`,
      };
    }

    if (decomposition.tasks.length === 0) {
      logger.info('[NanoClawOrchestrator] Decomposition returned 0 tasks (mock mode), skipping team formation');
      return {
        goalId: decomposition.goalId,
        teamsFormed: 0,
        tasksCreated: 0,
        estimatedCompletionHours: 0,
        acknowledgment: `Goal acknowledged but not decomposed — single-agent flow will handle this.`,
      };
    }

    // Step 2: Acknowledge
    const ack = await this.acknowledgment.acknowledgeTask({
      taskId,
      taskType: 'reasoning',
      complexity: 'complex',
      channel: 'whatsapp',
      enableProgressUpdates: true,
    });

    logger.info(`[NanoClawOrchestrator] Goal acknowledged, ETA ${Math.round(ack.estimatedCompletionMs / 1000)}s`);

    logger.info(`[NanoClawOrchestrator] Decomposed into ${decomposition.tasks.length} tasks`);

    // Step 3: Form teams based on recommendations
    this.acknowledgment.updateProgress(taskId, {
      status: 'in_progress',
      progressPercent: 30,
      currentStep: 'Forming specialized agent teams',
    });

    const teamsFormed: string[] = [];

    for (const rec of decomposition.recommendedTeams) {
      try {
        const teamRequest: TeamFormationRequest = {
          goalId: decomposition.goalId,
          teamName: `${rec.role} Team`,
          purpose: rec.purpose,
          recommendedRoles: [rec],
          priority: this.mapPriorityToAgentPriority(request.priority),
        };

        const team = await this.teamOrchestrator.formTeam(teamRequest);
        teamsFormed.push(team.id);

        logger.info(`[NanoClawOrchestrator] Formed team: ${team.name}`);
      } catch (err: any) {
        logger.warn(`[NanoClawOrchestrator] Failed to form team for ${rec.role}: ${err.message}`);
      }
    }

    // Step 4: Assign tasks to teams
    this.acknowledgment.updateProgress(taskId, {
      status: 'in_progress',
      progressPercent: 60,
      currentStep: 'Assigning tasks to team members',
    });

    let tasksAssigned = 0;
    for (const task of decomposition.tasks.slice(0, 10)) { // Start with first 10 tasks
      if (teamsFormed.length > 0) {
        const teamId = teamsFormed[tasksAssigned % teamsFormed.length];
        try {
          await this.teamOrchestrator.assignTask(teamId, task.id);
          tasksAssigned++;
        } catch (err: any) {
          logger.warn(`[NanoClawOrchestrator] Failed to assign task ${task.id}: ${err.message}`);
        }
      }
    }

    // Step 5: Complete acknowledgment
    this.acknowledgment.updateProgress(taskId, {
      status: 'completed',
      progressPercent: 100,
      currentStep: 'Teams formed and tasks assigned',
    });

    const totalTime = Date.now() - startTime;
    this.acknowledgment.completeTask(taskId, true, totalTime);

    const result: WorkflowResult = {
      goalId: decomposition.goalId,
      teamsFormed: teamsFormed.length,
      tasksCreated: decomposition.tasks.length,
      estimatedCompletionHours: decomposition.estimatedTotalHours,
      acknowledgment: this.formatWorkflowAcknowledgment({
        goalDescription: request.description,
        teamsCount: teamsFormed.length,
        tasksCount: decomposition.tasks.length,
        estimatedHours: decomposition.estimatedTotalHours,
        queuePosition: ack.queuePosition,
      }),
    };

    logger.info(`[NanoClawOrchestrator] Goal processing complete (${totalTime}ms)`);

    return result;
  }

  /**
   * Format acknowledgment message for user
   */
  private formatWorkflowAcknowledgment(data: {
    goalDescription: string;
    teamsCount: number;
    tasksCount: number;
    estimatedHours: number;
    queuePosition?: number;
  }): string {
    let message = `✅ *Goal Acknowledged*\n\n`;
    message += `📋 *Goal:* ${data.goalDescription}\n\n`;

    if (data.queuePosition) {
      message += `⏳ *Queue Position:* ${data.queuePosition}\n`;
      message += `_Your request is queued due to resource limits_\n\n`;
    }

    message += `🎯 *Work Plan Created:*\n`;
    message += `• ${data.teamsCount} specialized teams formed\n`;
    message += `• ${data.tasksCount} tasks identified\n`;
    message += `• Estimated ${data.estimatedHours} hours total\n\n`;

    message += `🤖 *Teams are working on this now*\n`;
    message += `You'll receive progress updates as work completes.\n\n`;
    message += `_Powered by NanoClaw Multi-Agent System_`;

    return message;
  }

  /**
   * Map goal priority to agent priority
   */
  private mapPriorityToAgentPriority(priority: GoalRequest['priority']): AgentPriority {
    const map: Record<GoalRequest['priority'], AgentPriority> = {
      critical: AgentPriority.CRITICAL,
      high: AgentPriority.HIGH,
      medium: AgentPriority.MEDIUM,
      low: AgentPriority.LOW,
    };
    return map[priority];
  }

  /**
   * Get system status
   */
  async getStatus() {
    const resourceStatus = await this.resourceOrchestrator.getStatus();
    const routerMetrics = this.router.getMetrics('1h');

    return {
      resources: resourceStatus,
      router: routerMetrics,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Cleanup all subsystems
   */
  destroy() {
    this.acknowledgment.destroy();
    this.teamOrchestrator.destroy();
    this.goalEngine.destroy();
    this.resourceOrchestrator.destroy();
    this.db.close();

    logger.info('[NanoClawOrchestrator] All subsystems destroyed');
  }
}

/**
 * Factory for creating orchestrator
 */
export class OrchestratorFactory {
  static create(dbPath: string = './store/nanoclaw.db'): NanoClawOrchestrator {
    return new NanoClawOrchestrator({
      dbPath,
      enableProgressUpdates: true,
      maxConcurrentTeams: 4,
    });
  }
}
