/**
 * Team Orchestrator
 * Manages hierarchical agent teams with specialized roles
 *
 * Integrates with:
 * - TeamCreate (existing tool for spawning agents)
 * - Goal Decomposition (gets tasks to assign)
 * - Resource Orchestrator (checks resource availability)
 * - Universal Router (selects models for each agent role)
 *
 * Features:
 * - Hierarchical team structure (lead → specialists)
 * - Dynamic sub-team formation based on task complexity
 * - Agent role specialization (researcher, developer, reviewer, etc.)
 * - Cross-team communication and coordination
 */

import Database from 'better-sqlite3';
import { logger } from './logger.js';
import { ResourceOrchestrator, AgentPriority, type AgentRequest } from './resource-orchestrator.js';
import { GoalDecompositionEngine, type Task, type TeamRecommendation } from './goal-decomposition.js';

export interface TeamMember {
  agentId: string;
  role: AgentRole;
  name: string;
  specialty: string;
  modelTier: 'local-slm' | 'local-llm' | 'cloud';
  priority: AgentPriority;
  status: 'idle' | 'working' | 'blocked' | 'completed';
  currentTask?: string; // Task ID
  tasksCompleted: number;
  joinedAt: number;
}

export type AgentRole =
  | 'lead'           // Team coordinator, assigns tasks
  | 'researcher'     // Web search, data gathering
  | 'developer'      // Code writing, MVP building
  | 'reviewer'       // Code review, QA, validation
  | 'marketer'       // Copywriting, outreach, SEO
  | 'analyst'        // Data analysis, reporting
  | 'designer'       // UI/UX, visual design
  | 'tester';        // Testing, bug finding

export interface Team {
  id: string;
  name: string;
  purpose: string;
  goalId: string;
  leadAgent: string; // Agent ID
  members: TeamMember[];
  status: 'forming' | 'active' | 'completed' | 'disbanded';
  createdAt: number;
  completedAt?: number;
}

export interface TeamFormationRequest {
  goalId: string;
  teamName: string;
  purpose: string;
  recommendedRoles: TeamRecommendation[];
  priority: AgentPriority;
  maxTeamSize?: number;
}

export interface SubTeamRequest {
  parentTeamId: string;
  taskCluster: Task[]; // Related tasks
  requiredRoles: AgentRole[];
  priority: AgentPriority;
}

export class TeamOrchestrator {
  private db: Database.Database;
  private resourceOrchestrator: ResourceOrchestrator;
  private goalEngine: GoalDecompositionEngine;
  private activeTeams: Map<string, Team> = new Map();

  constructor(
    dbPath: string,
    resourceOrchestrator: ResourceOrchestrator,
    goalEngine: GoalDecompositionEngine
  ) {
    this.db = new Database(dbPath);
    this.resourceOrchestrator = resourceOrchestrator;
    this.goalEngine = goalEngine;
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        purpose TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        lead_agent TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS team_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        specialty TEXT NOT NULL,
        model_tier TEXT NOT NULL,
        priority INTEGER NOT NULL,
        status TEXT NOT NULL,
        current_task TEXT,
        tasks_completed INTEGER DEFAULT 0,
        joined_at INTEGER NOT NULL,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );

      CREATE TABLE IF NOT EXISTS team_hierarchy (
        parent_team_id TEXT NOT NULL,
        child_team_id TEXT NOT NULL,
        relationship TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (parent_team_id, child_team_id),
        FOREIGN KEY (parent_team_id) REFERENCES teams(id),
        FOREIGN KEY (child_team_id) REFERENCES teams(id)
      );

      CREATE INDEX IF NOT EXISTS idx_teams_goal ON teams(goal_id);
      CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
      CREATE INDEX IF NOT EXISTS idx_team_members_agent ON team_members(agent_id);
    `);
  }

  /**
   * Form a new team for a goal
   */
  async formTeam(request: TeamFormationRequest): Promise<Team> {
    const teamId = `team_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    logger.info(`[TeamOrchestrator] Forming team "${request.teamName}" for goal ${request.goalId}`);

    // Determine team composition
    const composition = this.planTeamComposition(request);

    // Request resources for lead agent first
    const leadRequest: AgentRequest = {
      id: `${teamId}_lead`,
      type: 'nanoclaw',
      priority: request.priority,
      estimatedRamGB: 2,
      modelTier: 'cloud', // Lead uses best model
      taskId: request.goalId,
      teamId,
    };

    const leadApproval = await this.resourceOrchestrator.requestAgent(leadRequest);

    if (!leadApproval.approved) {
      logger.warn(`[TeamOrchestrator] Team formation queued (lead agent queued at position ${leadApproval.queuePosition})`);
      throw new Error(`Team formation queued: wait ${Math.round((leadApproval.estimatedWaitMs || 0) / 1000)}s`);
    }

    // Create team
    const team: Team = {
      id: teamId,
      name: request.teamName,
      purpose: request.purpose,
      goalId: request.goalId,
      leadAgent: leadApproval.agentId!,
      members: [
        {
          agentId: leadApproval.agentId!,
          role: 'lead',
          name: `${request.teamName} Lead`,
          specialty: 'Team coordination and task assignment',
          modelTier: 'cloud',
          priority: request.priority,
          status: 'idle',
          tasksCompleted: 0,
          joinedAt: Date.now(),
        },
      ],
      status: 'forming',
      createdAt: Date.now(),
    };

    // Spawn specialist agents based on composition
    for (const spec of composition.specialists) {
      const memberRequest: AgentRequest = {
        id: `${teamId}_${spec.role}`,
        type: 'nanoclaw',
        priority: request.priority - 10, // Slightly lower than lead
        estimatedRamGB: this.estimateRamForRole(spec.role),
        modelTier: spec.modelTier,
        taskId: request.goalId,
        teamId,
      };

      const approval = await this.resourceOrchestrator.requestAgent(memberRequest);

      if (approval.approved) {
        team.members.push({
          agentId: approval.agentId!,
          role: spec.role,
          name: spec.name,
          specialty: spec.specialty,
          modelTier: spec.modelTier,
          priority: request.priority - 10,
          status: 'idle',
          tasksCompleted: 0,
          joinedAt: Date.now(),
        });
      } else {
        logger.warn(`[TeamOrchestrator] Member ${spec.role} queued, team will start with partial roster`);
      }
    }

    // Save team
    this.saveTeam(team);
    this.activeTeams.set(teamId, team);

    // Update status to active
    team.status = 'active';
    this.updateTeamStatus(teamId, 'active');

    logger.info(`[TeamOrchestrator] Team "${team.name}" formed with ${team.members.length} members`);

    return team;
  }

  /**
   * Form a sub-team for a cluster of related tasks
   */
  async formSubTeam(request: SubTeamRequest): Promise<Team> {
    const parentTeam = this.activeTeams.get(request.parentTeamId);
    if (!parentTeam) {
      throw new Error(`Parent team ${request.parentTeamId} not found`);
    }

    const subTeamId = `team_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const subTeamName = `${parentTeam.name} - Sub-team`;

    logger.info(`[TeamOrchestrator] Forming sub-team for parent ${request.parentTeamId}`);

    // Create sub-team with required roles
    const subTeam: Team = {
      id: subTeamId,
      name: subTeamName,
      purpose: `Handle tasks: ${request.taskCluster.map(t => t.description).join(', ')}`,
      goalId: parentTeam.goalId,
      leadAgent: `${subTeamId}_lead`,
      members: [],
      status: 'forming',
      createdAt: Date.now(),
    };

    // Spawn lead for sub-team
    const leadRequest: AgentRequest = {
      id: subTeam.leadAgent,
      type: 'nanoclaw',
      priority: request.priority - 20, // Lower than parent team
      estimatedRamGB: 1.5,
      modelTier: 'local-llm', // Sub-team leads can use local models
      teamId: subTeamId,
    };

    const leadApproval = await this.resourceOrchestrator.requestAgent(leadRequest);

    if (leadApproval.approved) {
      subTeam.members.push({
        agentId: leadApproval.agentId!,
        role: 'lead',
        name: `${subTeamName} Lead`,
        specialty: 'Sub-team coordination',
        modelTier: 'local-llm',
        priority: request.priority - 20,
        status: 'idle',
        tasksCompleted: 0,
        joinedAt: Date.now(),
      });
    }

    // Add required specialist roles
    for (const role of request.requiredRoles) {
      const memberRequest: AgentRequest = {
        id: `${subTeamId}_${role}`,
        type: 'nanoclaw',
        priority: request.priority - 25,
        estimatedRamGB: this.estimateRamForRole(role),
        modelTier: this.selectModelForRole(role),
        teamId: subTeamId,
      };

      const approval = await this.resourceOrchestrator.requestAgent(memberRequest);

      if (approval.approved) {
        subTeam.members.push({
          agentId: approval.agentId!,
          role,
          name: `${role} (sub-team)`,
          specialty: this.getRoleSpecialty(role),
          modelTier: this.selectModelForRole(role),
          priority: request.priority - 25,
          status: 'idle',
          tasksCompleted: 0,
          joinedAt: Date.now(),
        });
      }
    }

    // Save sub-team and hierarchy
    this.saveTeam(subTeam);
    this.saveTeamHierarchy(request.parentTeamId, subTeamId, 'sub-team');
    this.activeTeams.set(subTeamId, subTeam);

    subTeam.status = 'active';
    this.updateTeamStatus(subTeamId, 'active');

    logger.info(`[TeamOrchestrator] Sub-team formed with ${subTeam.members.length} members`);

    return subTeam;
  }

  /**
   * Plan team composition based on recommendations
   */
  private planTeamComposition(request: TeamFormationRequest): {
    lead: { role: 'lead'; modelTier: 'cloud' };
    specialists: Array<{ role: AgentRole; name: string; specialty: string; modelTier: any }>;
  } {
    const specialists: Array<{ role: AgentRole; name: string; specialty: string; modelTier: any }> = [];

    for (const rec of request.recommendedRoles) {
      const role = this.mapRecommendationToRole(rec.role);
      specialists.push({
        role,
        name: `${rec.role} Agent`,
        specialty: rec.purpose,
        modelTier: this.selectModelForRole(role),
      });
    }

    // Limit team size
    const maxSize = request.maxTeamSize || 6;
    return {
      lead: { role: 'lead', modelTier: 'cloud' },
      specialists: specialists.slice(0, maxSize - 1), // -1 for lead
    };
  }

  /**
   * Map recommendation role to AgentRole
   */
  private mapRecommendationToRole(role: string): AgentRole {
    const roleMap: Record<string, AgentRole> = {
      researcher: 'researcher',
      developer: 'developer',
      marketer: 'marketer',
      analyst: 'analyst',
      reviewer: 'reviewer',
      designer: 'designer',
      tester: 'tester',
    };
    return roleMap[role.toLowerCase()] || 'researcher';
  }

  /**
   * Select model tier for role
   */
  private selectModelForRole(role: AgentRole): 'local-slm' | 'local-llm' | 'cloud' {
    const modelMap: Record<AgentRole, 'local-slm' | 'local-llm' | 'cloud'> = {
      lead: 'cloud',           // Best model for coordination
      researcher: 'local-llm', // Good reasoning for research
      developer: 'cloud',      // Best for code generation
      reviewer: 'local-llm',   // Good for QA
      marketer: 'local-slm',   // Simple for copywriting
      analyst: 'local-llm',    // Good for data analysis
      designer: 'cloud',       // Best for creative work
      tester: 'local-slm',     // Simple for testing
    };
    return modelMap[role];
  }

  /**
   * Get specialty description for role
   */
  private getRoleSpecialty(role: AgentRole): string {
    const specialties: Record<AgentRole, string> = {
      lead: 'Team coordination, task assignment, progress tracking',
      researcher: 'Web search, data gathering, competitive analysis',
      developer: 'Code writing, MVP building, API integration',
      reviewer: 'Code review, QA testing, validation',
      marketer: 'Copywriting, email outreach, SEO optimization',
      analyst: 'Data analysis, reporting, metrics tracking',
      designer: 'UI/UX design, visual assets, prototyping',
      tester: 'Testing, bug finding, edge case discovery',
    };
    return specialties[role];
  }

  /**
   * Estimate RAM for role
   */
  private estimateRamForRole(role: AgentRole): number {
    const ramMap: Record<AgentRole, number> = {
      lead: 2,
      researcher: 1.5,
      developer: 2,
      reviewer: 1.5,
      marketer: 1,
      analyst: 1.5,
      designer: 2,
      tester: 1,
    };
    return ramMap[role];
  }

  /**
   * Assign task to team member
   */
  async assignTask(teamId: string, taskId: string, memberRole?: AgentRole): Promise<void> {
    const team = this.activeTeams.get(teamId);
    if (!team) throw new Error(`Team ${teamId} not found`);

    // Find best member for task
    let member: TeamMember | undefined;

    if (memberRole) {
      member = team.members.find(m => m.role === memberRole && m.status === 'idle');
    } else {
      // Auto-assign to idle member
      member = team.members.find(m => m.status === 'idle');
    }

    if (!member) {
      logger.warn(`[TeamOrchestrator] No idle member available in team ${teamId}`);
      return;
    }

    // Update member status
    member.status = 'working';
    member.currentTask = taskId;

    this.db.prepare(`
      UPDATE team_members
      SET status = 'working', current_task = ?
      WHERE agent_id = ?
    `).run(taskId, member.agentId);

    logger.info(`[TeamOrchestrator] Assigned task ${taskId} to ${member.role} in team ${teamId}`);
  }

  /**
   * Mark task complete and update member
   */
  completeTask(teamId: string, agentId: string) {
    const team = this.activeTeams.get(teamId);
    if (!team) return;

    const member = team.members.find(m => m.agentId === agentId);
    if (!member) return;

    member.status = 'idle';
    member.currentTask = undefined;
    member.tasksCompleted++;

    this.db.prepare(`
      UPDATE team_members
      SET status = 'idle', current_task = NULL, tasks_completed = tasks_completed + 1
      WHERE agent_id = ?
    `).run(agentId);

    logger.info(`[TeamOrchestrator] ${member.role} completed task (total: ${member.tasksCompleted})`);
  }

  /**
   * Disband team and release resources
   */
  async disbandTeam(teamId: string) {
    const team = this.activeTeams.get(teamId);
    if (!team) return;

    // Release all members
    for (const member of team.members) {
      await this.resourceOrchestrator.releaseAgent(member.agentId, 'team_disbanded');
    }

    // Update status
    team.status = 'disbanded';
    team.completedAt = Date.now();
    this.updateTeamStatus(teamId, 'disbanded');

    this.activeTeams.delete(teamId);

    logger.info(`[TeamOrchestrator] Team ${teamId} disbanded`);
  }

  /**
   * Save team to database
   */
  private saveTeam(team: Team) {
    this.db.prepare(`
      INSERT INTO teams (id, name, purpose, goal_id, lead_agent, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(team.id, team.name, team.purpose, team.goalId, team.leadAgent, team.status, team.createdAt);

    for (const member of team.members) {
      this.db.prepare(`
        INSERT INTO team_members (
          team_id, agent_id, role, name, specialty, model_tier, priority,
          status, current_task, tasks_completed, joined_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        team.id, member.agentId, member.role, member.name, member.specialty,
        member.modelTier, member.priority, member.status, member.currentTask || null,
        member.tasksCompleted, member.joinedAt
      );
    }
  }

  /**
   * Save team hierarchy
   */
  private saveTeamHierarchy(parentId: string, childId: string, relationship: string) {
    this.db.prepare(`
      INSERT INTO team_hierarchy (parent_team_id, child_team_id, relationship, created_at)
      VALUES (?, ?, ?, ?)
    `).run(parentId, childId, relationship, Date.now());
  }

  /**
   * Update team status
   */
  private updateTeamStatus(teamId: string, status: Team['status']) {
    const updates: any = { status };
    if (status === 'completed' || status === 'disbanded') {
      updates.completed_at = Date.now();
    }

    const setParts = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), teamId];

    this.db.prepare(`UPDATE teams SET ${setParts} WHERE id = ?`).run(...values);
  }

  /**
   * Get team status
   */
  getTeam(teamId: string): Team | null {
    return this.activeTeams.get(teamId) || null;
  }

  /**
   * Cleanup
   */
  destroy() {
    this.db.close();
  }
}
