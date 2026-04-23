/**
 * Goal Decomposition Engine
 * Automatically breaks down high-level goals into actionable sub-tasks
 *
 * Integrates with:
 * - TeamCreate (spawns specialized agents)
 * - Universal Router (selects best model for decomposition)
 * - Resource Orchestrator (checks availability)
 *
 * Example:
 * Goal: "Earn $5,250 for Mac Studio"
 * → Sub-goals: Find bounties, Build products, Market services, etc.
 * → Tasks: Research OSHA data, Create MVP, Write emails, etc.
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import { UniversalRouter, type RoutingContext } from './router/index.js';
import { ResourceOrchestrator, AgentPriority } from './resource-orchestrator.js';

export interface Goal {
  id: string;
  description: string;
  targetValue?: number; // e.g., $5250
  deadline?: Date;
  status: 'active' | 'completed' | 'blocked' | 'cancelled';
  priority: 'critical' | 'high' | 'medium' | 'low';
  createdAt: number;
  completedAt?: number;
  parentGoalId?: string; // For sub-goals
}

export interface Task {
  id: string;
  goalId: string;
  description: string;
  complexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
  estimatedHours?: number;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: number; // 0-100
  dependencies: string[]; // Task IDs that must complete first
  assignedAgent?: string; // Agent/team ID
  createdAt: number;
  completedAt?: number;
}

export interface DecompositionResult {
  goalId: string;
  subGoals: Goal[];
  tasks: Task[];
  recommendedTeams: TeamRecommendation[];
  estimatedTotalHours: number;
  criticalPath: string[]; // Task IDs in order
}

export interface TeamRecommendation {
  role: string; // e.g., "researcher", "developer", "marketer"
  purpose: string;
  requiredSkills: string[];
  estimatedHours: number;
}

export class GoalDecompositionEngine {
  private db: Database.Database;
  private router: UniversalRouter;
  private resourceOrchestrator: ResourceOrchestrator;

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
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        target_value REAL,
        deadline INTEGER,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        parent_goal_id TEXT,
        FOREIGN KEY (parent_goal_id) REFERENCES goals(id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        description TEXT NOT NULL,
        complexity TEXT NOT NULL,
        estimated_hours REAL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL,
        dependencies TEXT, -- JSON array of task IDs
        assigned_agent TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (goal_id) REFERENCES goals(id)
      );

      CREATE TABLE IF NOT EXISTS decomposition_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        model_used TEXT NOT NULL,
        decomposition_time_ms INTEGER NOT NULL,
        sub_goals_count INTEGER NOT NULL,
        tasks_count INTEGER NOT NULL,
        estimated_total_hours REAL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (goal_id) REFERENCES goals(id)
      );

      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);
  }

  /**
   * Decompose a high-level goal into sub-goals and tasks
   */
  async decomposeGoal(goal: Omit<Goal, 'id' | 'createdAt' | 'status'>): Promise<DecompositionResult> {
    const startTime = Date.now();

    // Create goal record
    const goalId = `goal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const fullGoal: Goal = {
      ...goal,
      id: goalId,
      status: 'active',
      createdAt: Date.now(),
    };

    this.saveGoal(fullGoal);

    // Use Universal Router to select best model for decomposition
    const routingContext: RoutingContext = {
      taskType: 'reasoning',
      userTier: 'internal',
      costBudget: 'limited',
      qualityNeeds: 'best',
      latencyNeeds: 'batch',
      source: 'internal',
      estimatedTokens: 5000,
    };

    const decision = await this.router.route(routingContext);

    logger.info(`[GoalDecomposition] Decomposing goal "${goal.description}" with ${decision.modelId}`);

    // Generate decomposition using selected model
    const decomposition = await this.generateDecomposition(fullGoal, decision.modelId);

    // Save sub-goals and tasks
    for (const subGoal of decomposition.subGoals) {
      this.saveGoal(subGoal);
    }

    for (const task of decomposition.tasks) {
      this.saveTask(task);
    }

    // Record decomposition
    const decompositionTime = Date.now() - startTime;
    this.recordDecomposition({
      goalId,
      modelUsed: decision.modelId,
      decompositionTimeMs: decompositionTime,
      subGoalsCount: decomposition.subGoals.length,
      tasksCount: decomposition.tasks.length,
      estimatedTotalHours: decomposition.estimatedTotalHours,
    });

    logger.info(`[GoalDecomposition] Decomposed into ${decomposition.subGoals.length} sub-goals, ${decomposition.tasks.length} tasks (${decompositionTime}ms)`);

    return decomposition;
  }

  /**
   * Generate decomposition using AI model
   */
  private async generateDecomposition(goal: Goal, modelId: string): Promise<DecompositionResult> {
    // Build prompt for decomposition
    const prompt = this.buildDecompositionPrompt(goal);

    // Execute with router (uses fallback if needed)
    const result = await this.router.execute(
      {
        taskType: 'reasoning',
        userTier: 'internal',
        costBudget: 'limited',
        qualityNeeds: 'best',
        latencyNeeds: 'batch',
        source: 'internal',
      },
      async (selectedModelId) => {
        // Call local Ollama for goal decomposition (free, fast)
        try {
          const response = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'qwen2.5-coder:latest',
              messages: [{ role: 'user', content: prompt }],
              stream: false,
              format: 'json',
            }),
          });
          if (response.ok) {
            const data = await response.json() as { message?: { content?: string } };
            const content = data.message?.content || '';
            const parsed = JSON.parse(content);
            // Map parsed result to DecompositionResult format
            return {
              subGoals: (parsed.subGoals || []).map((sg: Record<string, unknown>, i: number) => ({
                id: `subgoal_${Date.now()}_${i}`,
                description: sg.description || '',
                targetValue: sg.estimatedHours ? Number(sg.estimatedHours) * 50 : undefined,
                status: 'active' as const,
                priority: (sg.priority as string) || 'medium',
                createdAt: Date.now(),
                parentGoalId: goal.id,
              })),
              tasks: (parsed.tasks || []).map((t: Record<string, unknown>, i: number) => ({
                id: `task_${Date.now()}_${i}`,
                description: t.description || '',
                complexity: t.complexity || 'moderate',
                estimatedHours: Number(t.estimatedHours) || 4,
                dependencies: (t.dependencies as string[]) || [],
                priority: Number(t.priority) || 50,
              })),
              recommendedTeams: parsed.recommendedTeams || [],
              criticalPath: parsed.criticalPath || [],
            } as DecompositionResult;
          }
        } catch {
          // Ollama unavailable — fall back to mock
        }
        return this.mockDecomposition(goal);
      }
    );

    return result.result;
  }

  /**
   * Build decomposition prompt
   */
  private buildDecompositionPrompt(goal: Goal): string {
    return `You are a goal decomposition expert. Break down this high-level goal into actionable sub-goals and tasks.

**Goal:** ${goal.description}
${goal.targetValue ? `**Target Value:** $${goal.targetValue}` : ''}
${goal.deadline ? `**Deadline:** ${new Date(goal.deadline).toISOString().split('T')[0]}` : ''}
**Priority:** ${goal.priority}

**Requirements:**
1. Create 3-5 sub-goals that collectively achieve the main goal
2. For each sub-goal, create 5-10 specific, actionable tasks
3. Identify task dependencies (which tasks must complete first)
4. Estimate hours for each task (be realistic)
5. Recommend specialized teams/roles needed
6. Identify the critical path (tasks that directly impact completion)

**Output Format:**
Return JSON with this structure:
{
  "subGoals": [
    {
      "description": "...",
      "priority": "high",
      "estimatedHours": 20
    }
  ],
  "tasks": [
    {
      "description": "...",
      "complexity": "moderate",
      "estimatedHours": 4,
      "dependencies": [],
      "priority": 80
    }
  ],
  "recommendedTeams": [
    {
      "role": "researcher",
      "purpose": "...",
      "requiredSkills": ["..."],
      "estimatedHours": 10
    }
  ],
  "criticalPath": ["task1", "task2", "task3"]
}

Be specific and actionable. Focus on tasks that can start immediately.`;
  }

  /**
   * Mock decomposition (replace with actual model call)
   */
  private mockDecomposition(goal: Goal): DecompositionResult {
    // Example decomposition for "Earn $5,250 for Mac Studio"
    const subGoals: Goal[] = [
      {
        id: `subgoal_${Date.now()}_1`,
        description: 'Find and complete high-value bounties',
        targetValue: 2000,
        status: 'active',
        priority: 'high',
        createdAt: Date.now(),
        parentGoalId: goal.id,
      },
      {
        id: `subgoal_${Date.now()}_2`,
        description: 'Build and launch data arbitrage products',
        targetValue: 2000,
        status: 'active',
        priority: 'high',
        createdAt: Date.now(),
        parentGoalId: goal.id,
      },
      {
        id: `subgoal_${Date.now()}_3`,
        description: 'Market Vantage Intelligence services',
        targetValue: 1250,
        status: 'active',
        priority: 'medium',
        createdAt: Date.now(),
        parentGoalId: goal.id,
      },
    ];

    const tasks: Task[] = [
      {
        id: `task_${Date.now()}_1`,
        goalId: subGoals[0].id,
        description: 'Research available bounties (Anthropic, GitHub, etc.)',
        complexity: 'simple',
        estimatedHours: 2,
        status: 'pending',
        priority: 90,
        dependencies: [],
        createdAt: Date.now(),
      },
      {
        id: `task_${Date.now()}_2`,
        goalId: subGoals[1].id,
        description: 'Build OSHA Violation Predictor MVP',
        complexity: 'moderate',
        estimatedHours: 6,
        status: 'pending',
        priority: 85,
        dependencies: [],
        createdAt: Date.now(),
      },
      {
        id: `task_${Date.now()}_3`,
        goalId: subGoals[2].id,
        description: 'Deploy Vantage Intelligence landing page',
        complexity: 'simple',
        estimatedHours: 2,
        status: 'pending',
        priority: 80,
        dependencies: [],
        createdAt: Date.now(),
      },
    ];

    const recommendedTeams: TeamRecommendation[] = [
      {
        role: 'researcher',
        purpose: 'Find bounties and revenue opportunities',
        requiredSkills: ['web search', 'data analysis', 'opportunity evaluation'],
        estimatedHours: 10,
      },
      {
        role: 'developer',
        purpose: 'Build MVPs and prototypes',
        requiredSkills: ['Python', 'TypeScript', 'API integration'],
        estimatedHours: 30,
      },
      {
        role: 'marketer',
        purpose: 'Launch products and acquire customers',
        requiredSkills: ['copywriting', 'SEO', 'email outreach'],
        estimatedHours: 15,
      },
    ];

    return {
      goalId: goal.id,
      subGoals,
      tasks,
      recommendedTeams,
      estimatedTotalHours: 55,
      criticalPath: [tasks[0].id, tasks[1].id, tasks[2].id],
    };
  }

  /**
   * Get next actionable task (no blockers)
   */
  getNextTask(goalId?: string): Task | null {
    const query = goalId
      ? `SELECT * FROM tasks WHERE goal_id = ? AND status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1`
      : `SELECT * FROM tasks WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1`;

    const row = goalId
      ? this.db.prepare(query).get(goalId)
      : this.db.prepare(query).get();

    if (!row) return null;

    return this.rowToTask(row as any);
  }

  /**
   * Update task status
   */
  updateTaskStatus(taskId: string, status: Task['status'], assignedAgent?: string) {
    const updates: any = { status };
    if (assignedAgent) updates.assigned_agent = assignedAgent;
    if (status === 'completed') updates.completed_at = Date.now();

    const setParts = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), taskId];

    this.db.prepare(`UPDATE tasks SET ${setParts} WHERE id = ?`).run(...values);

    logger.info(`[GoalDecomposition] Task ${taskId} status updated to ${status}`);
  }

  /**
   * Save goal to database
   */
  private saveGoal(goal: Goal) {
    this.db.prepare(`
      INSERT INTO goals (
        id, description, target_value, deadline, status, priority,
        created_at, completed_at, parent_goal_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      goal.id,
      goal.description,
      goal.targetValue || null,
      goal.deadline ? goal.deadline.getTime() : null,
      goal.status,
      goal.priority,
      goal.createdAt,
      goal.completedAt || null,
      goal.parentGoalId || null
    );
  }

  /**
   * Save task to database
   */
  private saveTask(task: Task) {
    this.db.prepare(`
      INSERT INTO tasks (
        id, goal_id, description, complexity, estimated_hours, status,
        priority, dependencies, assigned_agent, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.goalId,
      task.description,
      task.complexity,
      task.estimatedHours || null,
      task.status,
      task.priority,
      JSON.stringify(task.dependencies),
      task.assignedAgent || null,
      task.createdAt,
      task.completedAt || null
    );
  }

  /**
   * Record decomposition
   */
  private recordDecomposition(record: {
    goalId: string;
    modelUsed: string;
    decompositionTimeMs: number;
    subGoalsCount: number;
    tasksCount: number;
    estimatedTotalHours: number;
  }) {
    this.db.prepare(`
      INSERT INTO decomposition_history (
        goal_id, model_used, decomposition_time_ms, sub_goals_count,
        tasks_count, estimated_total_hours, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.goalId,
      record.modelUsed,
      record.decompositionTimeMs,
      record.subGoalsCount,
      record.tasksCount,
      record.estimatedTotalHours,
      Date.now()
    );
  }

  /**
   * Convert database row to Task
   */
  private rowToTask(row: any): Task {
    return {
      id: row.id,
      goalId: row.goal_id,
      description: row.description,
      complexity: row.complexity,
      estimatedHours: row.estimated_hours,
      status: row.status,
      priority: row.priority,
      dependencies: JSON.parse(row.dependencies || '[]'),
      assignedAgent: row.assigned_agent,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  }

  /**
   * Cleanup
   */
  destroy() {
    this.db.close();
  }
}
