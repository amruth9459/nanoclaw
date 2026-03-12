/**
 * Resource Orchestrator
 * Manages compute resources (RAM, CPU, concurrent agents) across all products
 *
 * Integrates with:
 * - Universal Router (model selection)
 * - Team system (agent spawning)
 * - Task scheduler (background tasks)
 *
 * Key Features:
 * - Auto-detect RAM monitoring and limits
 * - Agent prioritization (paid customers > internal tasks)
 * - Queue management with ETA
 * - Auto-kill low-priority agents when RAM critical
 */

import os from 'os';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { logger } from './logger.js';

// Auto-detect total RAM (adapts to Mac Mini, Mac Studio, etc.)
const TOTAL_RAM_GB = os.totalmem() / 1024 / 1024 / 1024;

// Resource configuration - adapts to current system
const RESOURCE_CONFIG = {
  TOTAL_RAM_GB,
  MAX_RAM_USAGE_PERCENT: 85, // Use max 85% of RAM
  MIN_FREE_RAM_GB: Math.max(4, TOTAL_RAM_GB * 0.1), // Keep 10% or 4GB free, whichever is larger
  CRITICAL_RAM_PERCENT: 90, // Emergency threshold

  // Per-agent RAM estimates (GB) - defaults
  DEFAULT_AGENT_RAM: 2,
  VISION_TASK_RAM: 4,
  TEAM_MEMBER_RAM: 1.5,
  LOCAL_MODEL_SLM_RAM: 4,
  LOCAL_MODEL_LLM_RAM: 40,

  // Concurrent limits (scale with RAM)
  MAX_TOTAL_AGENTS: Math.min(16, Math.floor(TOTAL_RAM_GB / 4)), // 1 agent per 4GB
  MAX_AGENTS_PER_TYPE: Math.min(8, Math.floor(TOTAL_RAM_GB / 8)), // Max agents per product/type
  MAX_LOCAL_MODELS: TOTAL_RAM_GB >= 64 ? 2 : (TOTAL_RAM_GB >= 32 ? 1 : 0), // Require 32GB+ for local models
};

export enum AgentPriority {
  CRITICAL = 100, // Paying customer
  HIGH = 75,      // User-initiated NanoClaw task
  MEDIUM = 50,    // Scheduled task
  LOW = 25,       // Background optimization
  VERY_LOW = 10,  // Maintenance
}

export interface AgentRequest {
  id: string;
  type: string; // e.g., 'nanoclaw', or any integration-provided type
  priority: AgentPriority;
  estimatedRamGB: number;
  modelTier?: 'local-slm' | 'local-llm' | 'cloud';
  userId?: string; // For paying customers
  taskId?: string; // For tasks
  teamId?: string; // For team members
  product?: string; // Product name for tracking
}

export interface AgentProcess {
  id: string;
  type: string; // Product/service type
  priority: AgentPriority;
  ramAllocatedGB: number;
  ramUsedGB: number;
  modelTier?: string;
  startTime: number;
  userId?: string;
  taskId?: string;
  teamId?: string;
  product?: string;
}

export interface ResourceStatus {
  totalRamGB: number;
  usedRamGB: number;
  availableRamGB: number;
  usedPercent: number;
  activeAgents: number;
  agentsByType: Record<string, number>; // Count per product type
  queuedAgents: number;
  localModelsActive: number;
}

export interface QueueEntry {
  request: AgentRequest;
  queuedAt: number;
  estimatedWaitMs: number;
  position: number;
}

export class ResourceOrchestrator {
  private db: Database.Database;
  private activeAgents: Map<string, AgentProcess> = new Map();
  private queue: QueueEntry[] = [];
  private monitorInterval: NodeJS.Timeout | null = null;
  private localModelsActive = 0;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initDatabase();
    this.startMonitoring();
  }

  private initDatabase() {
    // Drop old schema with hardcoded columns (monitoring data, auto-purged)
    this.db.exec(`DROP TABLE IF EXISTS resource_usage`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resource_usage (
        timestamp INTEGER PRIMARY KEY,
        total_ram_gb REAL,
        used_ram_gb REAL,
        available_ram_gb REAL,
        used_percent REAL,
        active_agents INTEGER,
        agents_by_type TEXT,
        queued_agents INTEGER,
        local_models_active INTEGER
      );

      CREATE TABLE IF NOT EXISTS agent_lifecycle (
        agent_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL,
        ram_allocated_gb REAL NOT NULL,
        ram_peak_gb REAL,
        model_tier TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        duration_seconds INTEGER,
        termination_reason TEXT,
        user_id TEXT,
        task_id TEXT,
        team_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_type ON agent_lifecycle(type);
      CREATE INDEX IF NOT EXISTS idx_agent_lifecycle_user ON agent_lifecycle(user_id);
    `);
  }

  /**
   * Request resources for a new agent
   */
  async requestAgent(request: AgentRequest): Promise<{
    approved: boolean;
    agentId?: string;
    queuePosition?: number;
    estimatedWaitMs?: number;
    reason?: string;
  }> {
    const status = await this.getStatus();

    // Check if we can start immediately
    if (this.canStartAgent(status, request)) {
      // Start immediately
      const agent: AgentProcess = {
        id: request.id,
        type: request.type,
        priority: request.priority,
        ramAllocatedGB: request.estimatedRamGB,
        ramUsedGB: 0,
        modelTier: request.modelTier,
        startTime: Date.now(),
        userId: request.userId,
        taskId: request.taskId,
        teamId: request.teamId,
      };

      this.activeAgents.set(agent.id, agent);
      this.recordAgentStart(agent);

      if (request.modelTier?.startsWith('local')) {
        this.localModelsActive++;
      }

      logger.info(`[ResourceOrchestrator] Agent ${agent.id} started (${agent.type}, ${agent.priority})`);

      return { approved: true, agentId: agent.id };
    } else {
      // Add to queue
      const position = this.addToQueue(request);
      const estimatedWaitMs = this.estimateWaitTime(position);

      logger.info(`[ResourceOrchestrator] Agent ${request.id} queued at position ${position} (wait: ${Math.round(estimatedWaitMs / 1000)}s)`);

      return {
        approved: false,
        queuePosition: position,
        estimatedWaitMs,
        reason: this.getQueueReason(status, request),
      };
    }
  }

  /**
   * Check if agent can start now
   */
  private canStartAgent(status: ResourceStatus, request: AgentRequest): boolean {
    // Check RAM availability
    const requiredRamGB = request.estimatedRamGB;
    if (status.availableRamGB < requiredRamGB + RESOURCE_CONFIG.MIN_FREE_RAM_GB) {
      return false;
    }

    // Check total agent limit
    if (status.activeAgents >= RESOURCE_CONFIG.MAX_TOTAL_AGENTS) {
      return false;
    }

    // Check per-type limits
    const agentsOfType = status.agentsByType[request.type] || 0;
    if (agentsOfType >= RESOURCE_CONFIG.MAX_AGENTS_PER_TYPE) {
      return false;
    }

    // Check local model limits
    if (request.modelTier?.startsWith('local') && this.localModelsActive >= RESOURCE_CONFIG.MAX_LOCAL_MODELS) {
      return false;
    }

    return true;
  }

  /**
   * Add agent to priority queue
   */
  private addToQueue(request: AgentRequest): number {
    const entry: QueueEntry = {
      request,
      queuedAt: Date.now(),
      estimatedWaitMs: 0,
      position: 0,
    };

    this.queue.push(entry);

    // Sort by priority (higher first)
    this.queue.sort((a, b) => b.request.priority - a.request.priority);

    // Update positions
    this.queue.forEach((e, i) => {
      e.position = i + 1;
      e.estimatedWaitMs = this.estimateWaitTime(e.position);
    });

    return entry.position;
  }

  /**
   * Estimate wait time based on queue position
   */
  private estimateWaitTime(position: number): number {
    // Average agent runtime: 3 minutes (180,000ms)
    const avgRuntimeMs = 180_000;
    const concurrentSlots = RESOURCE_CONFIG.MAX_TOTAL_AGENTS;

    return Math.ceil((position / concurrentSlots) * avgRuntimeMs);
  }

  /**
   * Get reason for queueing
   */
  private getQueueReason(status: ResourceStatus, request: AgentRequest): string {
    if (status.availableRamGB < request.estimatedRamGB + RESOURCE_CONFIG.MIN_FREE_RAM_GB) {
      return `Insufficient RAM (need ${request.estimatedRamGB}GB, available ${status.availableRamGB.toFixed(1)}GB)`;
    }
    if (status.activeAgents >= RESOURCE_CONFIG.MAX_TOTAL_AGENTS) {
      return `Max concurrent agents reached (${RESOURCE_CONFIG.MAX_TOTAL_AGENTS})`;
    }
    const agentsOfType = status.agentsByType[request.type] || 0;
    if (agentsOfType >= RESOURCE_CONFIG.MAX_AGENTS_PER_TYPE) {
      return `Max ${request.type} agents reached (${RESOURCE_CONFIG.MAX_AGENTS_PER_TYPE})`;
    }
    if (request.modelTier?.startsWith('local') && this.localModelsActive >= RESOURCE_CONFIG.MAX_LOCAL_MODELS) {
      return `Max local models running (${RESOURCE_CONFIG.MAX_LOCAL_MODELS})`;
    }
    return 'Resource limits reached';
  }

  /**
   * Release agent resources
   */
  async releaseAgent(agentId: string, reason: string = 'completed') {
    const agent = this.activeAgents.get(agentId);
    if (!agent) {
      logger.warn(`[ResourceOrchestrator] Attempted to release unknown agent ${agentId}`);
      return;
    }

    this.activeAgents.delete(agentId);
    this.recordAgentEnd(agent, reason);

    if (agent.modelTier?.startsWith('local')) {
      this.localModelsActive = Math.max(0, this.localModelsActive - 1);
    }

    logger.info(`[ResourceOrchestrator] Agent ${agentId} released (${reason})`);

    // Process queue
    await this.processQueue();
  }

  /**
   * Process queue - start agents if resources available
   */
  private async processQueue() {
    if (this.queue.length === 0) return;

    const status = await this.getStatus();

    while (this.queue.length > 0) {
      const entry = this.queue[0];

      if (this.canStartAgent(status, entry.request)) {
        // Remove from queue
        this.queue.shift();

        // Start agent
        const agent: AgentProcess = {
          id: entry.request.id,
          type: entry.request.type,
          priority: entry.request.priority,
          ramAllocatedGB: entry.request.estimatedRamGB,
          ramUsedGB: 0,
          modelTier: entry.request.modelTier,
          startTime: Date.now(),
          userId: entry.request.userId,
          taskId: entry.request.taskId,
          teamId: entry.request.teamId,
        };

        this.activeAgents.set(agent.id, agent);
        this.recordAgentStart(agent);

        if (entry.request.modelTier?.startsWith('local')) {
          this.localModelsActive++;
        }

        logger.info(`[ResourceOrchestrator] Queued agent ${agent.id} started from queue`);

        // Update status for next iteration
        const newStatus = await this.getStatus();
        Object.assign(status, newStatus);
      } else {
        break; // Can't start more yet
      }
    }

    // Update queue positions
    this.queue.forEach((e, i) => {
      e.position = i + 1;
      e.estimatedWaitMs = this.estimateWaitTime(e.position);
    });
  }

  /**
   * Get current resource status
   */
  async getStatus(): Promise<ResourceStatus> {
    const totalRamGB = os.totalmem() / 1024 / 1024 / 1024;
    // os.freemem() on macOS only reports truly free pages, excluding
    // cached/purgeable/inactive memory that macOS reclaims under pressure.
    // Use vm_stat to match Activity Monitor's view of available memory:
    // free + inactive (file cache) + purgeable + speculative.
    let freeRamGB = os.freemem() / 1024 / 1024 / 1024;
    if (process.platform === 'darwin') {
      try {
        const vmstat = execSync('vm_stat', { encoding: 'utf-8', timeout: 2000 });
        const pageSize = 16384; // Apple Silicon uses 16KB pages
        const pages = (label: string): number => {
          const m = vmstat.match(new RegExp(`${label}:\\s+(\\d+)`));
          return m ? parseInt(m[1], 10) : 0;
        };
        const freePages = pages('Pages free');
        const inactivePages = pages('Pages inactive');
        const purgeablePages = pages('Pages purgeable');
        const speculativePages = pages('Pages speculative');
        const reclaimableBytes = (freePages + inactivePages + purgeablePages + speculativePages) * pageSize;
        freeRamGB = reclaimableBytes / 1024 / 1024 / 1024;
      } catch { /* fallback to os.freemem() */ }
    }
    const usedRamGB = totalRamGB - freeRamGB;
    const usedPercent = (usedRamGB / totalRamGB) * 100;

    // Count agents by type
    const agentsByType: Record<string, number> = {};
    for (const agent of this.activeAgents.values()) {
      agentsByType[agent.type] = (agentsByType[agent.type] || 0) + 1;
    }

    return {
      totalRamGB,
      usedRamGB,
      availableRamGB: freeRamGB,
      usedPercent,
      activeAgents: this.activeAgents.size,
      agentsByType,
      queuedAgents: this.queue.length,
      localModelsActive: this.localModelsActive,
    };
  }

  /**
   * Monitor resources and enforce limits
   */
  private startMonitoring() {
    this.monitorInterval = setInterval(async () => {
      const status = await this.getStatus();

      // Record metrics
      this.recordUsage(status);

      // Check critical RAM
      if (status.usedPercent >= RESOURCE_CONFIG.CRITICAL_RAM_PERCENT) {
        logger.warn(`[ResourceOrchestrator] CRITICAL RAM: ${status.usedPercent.toFixed(1)}%`);
        await this.handleCriticalRAM();
      }

      // Process queue
      await this.processQueue();
    }, 10000); // Every 10 seconds
  }

  /**
   * Handle critical RAM - kill low-priority agents
   */
  private async handleCriticalRAM() {
    // Sort agents by priority (lowest first)
    const agents = Array.from(this.activeAgents.values()).sort(
      (a, b) => a.priority - b.priority
    );

    for (const agent of agents) {
      if (agent.priority <= AgentPriority.MEDIUM) {
        logger.warn(`[ResourceOrchestrator] Killing agent ${agent.id} (priority ${agent.priority}) due to critical RAM`);

        await this.releaseAgent(agent.id, 'killed_critical_ram');

        // Check if we're safe now
        const status = await this.getStatus();
        if (status.usedPercent < RESOURCE_CONFIG.CRITICAL_RAM_PERCENT) {
          break;
        }
      }
    }
  }

  /**
   * Record agent start
   */
  private recordAgentStart(agent: AgentProcess) {
    this.db.prepare(`
      INSERT INTO agent_lifecycle (
        agent_id, type, priority, ram_allocated_gb, model_tier, start_time,
        user_id, task_id, team_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id,
      agent.type,
      agent.priority,
      agent.ramAllocatedGB,
      agent.modelTier || null,
      agent.startTime,
      agent.userId || null,
      agent.taskId || null,
      agent.teamId || null
    );
  }

  /**
   * Record agent end
   */
  private recordAgentEnd(agent: AgentProcess, reason: string) {
    const endTime = Date.now();
    const durationSeconds = Math.floor((endTime - agent.startTime) / 1000);

    this.db.prepare(`
      UPDATE agent_lifecycle
      SET end_time = ?, duration_seconds = ?, termination_reason = ?, ram_peak_gb = ?
      WHERE agent_id = ?
    `).run(endTime, durationSeconds, reason, agent.ramUsedGB, agent.id);
  }

  /**
   * Record resource usage
   */
  private recordUsage(status: ResourceStatus) {
    this.db.prepare(`
      INSERT INTO resource_usage (
        timestamp, total_ram_gb, used_ram_gb, available_ram_gb, used_percent,
        active_agents, agents_by_type, queued_agents,
        local_models_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      status.totalRamGB,
      status.usedRamGB,
      status.availableRamGB,
      status.usedPercent,
      status.activeAgents,
      JSON.stringify(status.agentsByType),
      status.queuedAgents,
      status.localModelsActive
    );

    // Cleanup old data (keep 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.db.prepare('DELETE FROM resource_usage WHERE timestamp < ?').run(sevenDaysAgo);
  }

  /**
   * Get queue status
   */
  getQueue(): QueueEntry[] {
    return [...this.queue];
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    this.db.close();
  }
}
