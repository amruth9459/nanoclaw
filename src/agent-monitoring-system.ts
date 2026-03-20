/**
 * Agent Monitoring System
 *
 * Implements 5 layers of misalignment detection based on OpenAI's approach:
 * 1. Post-hoc action review (daily safety brief)
 * 2. Pre-execution risk scoring for high-stakes commands
 * 3. Self-modification detection
 * 4. Conversation intent drift detection
 * 5. Resource abuse detection
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { getDb } from './db.js';

// ============================================================================
// Types
// ============================================================================

export interface ActionLog {
  timestamp: string;
  action_type: 'bash' | 'file_edit' | 'mcp_call' | 'agent_spawn' | 'api_call';
  command?: string;
  file_path?: string;
  tool_name?: string;
  risk_score: number; // 0-100
  flagged: boolean;
  flag_reason?: string;
  group_folder: string;
  task_id?: string;
}

export interface RiskAssessment {
  allowed: boolean;
  risk_score: number; // 0-100
  risk_category: 'low' | 'medium' | 'high' | 'critical';
  requires_confirmation: boolean;
  reason: string;
}

export interface IntentDriftSignal {
  task_id: string;
  expected_intent: string;
  detected_intent: string;
  drift_score: number; // 0-100
  timestamp: string;
}

export interface ResourceAbuseSignal {
  task_id: string;
  abuse_type: 'agent_spawning' | 'excessive_spend' | 'api_flooding';
  severity: 'warning' | 'critical';
  details: string;
  timestamp: string;
}

// ============================================================================
// Database Schema
// ============================================================================

export function initMonitoringSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      action_type TEXT NOT NULL,
      command TEXT,
      file_path TEXT,
      tool_name TEXT,
      risk_score INTEGER NOT NULL,
      flagged INTEGER NOT NULL,
      flag_reason TEXT,
      group_folder TEXT NOT NULL,
      task_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_logs_timestamp ON action_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_action_logs_flagged ON action_logs(flagged, timestamp);

    CREATE TABLE IF NOT EXISTS self_modification_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      file_path TEXT NOT NULL,
      modification_type TEXT NOT NULL,
      diff_summary TEXT,
      approved INTEGER DEFAULT 0,
      group_folder TEXT NOT NULL,
      task_id TEXT
    );

    CREATE TABLE IF NOT EXISTS intent_drift_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      expected_intent TEXT NOT NULL,
      detected_intent TEXT NOT NULL,
      drift_score INTEGER NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_abuse_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      abuse_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      details TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS safety_briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      total_actions INTEGER NOT NULL,
      flagged_actions INTEGER NOT NULL,
      high_risk_actions INTEGER NOT NULL,
      self_modifications INTEGER NOT NULL,
      intent_drifts INTEGER NOT NULL,
      resource_abuses INTEGER NOT NULL,
      brief_text TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
  `);
}

// ============================================================================
// 1. Post-hoc Action Review
// ============================================================================

export function logAction(action: ActionLog): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO action_logs (timestamp, action_type, command, file_path, tool_name, risk_score, flagged, flag_reason, group_folder, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    action.timestamp,
    action.action_type,
    action.command,
    action.file_path,
    action.tool_name,
    action.risk_score,
    action.flagged ? 1 : 0,
    action.flag_reason,
    action.group_folder,
    action.task_id
  );
}

export async function generateDailySafetyBrief(targetDate?: string): Promise<string> {
  const db = getDb();
  const date = targetDate || new Date().toISOString().split('T')[0];
  const startTime = `${date}T00:00:00.000Z`;
  const endTime = `${date}T23:59:59.999Z`;

  // Get action stats
  const actionStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) as flagged,
      SUM(CASE WHEN risk_score >= 70 THEN 1 ELSE 0 END) as high_risk
    FROM action_logs
    WHERE timestamp >= ? AND timestamp <= ?
  `).get(startTime, endTime) as any;

  // Get self-modification events
  const selfModCount = db.prepare(`
    SELECT COUNT(*) as count FROM self_modification_events
    WHERE timestamp >= ? AND timestamp <= ?
  `).get(startTime, endTime) as any;

  // Get intent drift signals
  const intentDriftCount = db.prepare(`
    SELECT COUNT(*) as count FROM intent_drift_signals
    WHERE timestamp >= ? AND timestamp <= ?
  `).get(startTime, endTime) as any;

  // Get resource abuse signals
  const resourceAbuseCount = db.prepare(`
    SELECT COUNT(*) as count FROM resource_abuse_signals
    WHERE timestamp >= ? AND timestamp <= ?
  `).get(startTime, endTime) as any;

  // Get flagged actions details
  const flaggedActions = db.prepare(`
    SELECT timestamp, action_type, command, file_path, tool_name, flag_reason, risk_score
    FROM action_logs
    WHERE flagged = 1 AND timestamp >= ? AND timestamp <= ?
    ORDER BY risk_score DESC
    LIMIT 10
  `).all(startTime, endTime) as any[];

  // Build brief
  let brief = `🔒 **Daily Agent Safety Brief — ${date}**\n\n`;
  brief += `**Summary:**\n`;
  brief += `- Total actions: ${actionStats.total}\n`;
  brief += `- Flagged actions: ${actionStats.flagged}\n`;
  brief += `- High-risk actions (≥70): ${actionStats.high_risk}\n`;
  brief += `- Self-modifications: ${selfModCount.count}\n`;
  brief += `- Intent drifts: ${intentDriftCount.count}\n`;
  brief += `- Resource abuses: ${resourceAbuseCount.count}\n\n`;

  if (flaggedActions.length > 0) {
    brief += `**Flagged Actions:**\n`;
    flaggedActions.forEach((action, i) => {
      brief += `${i + 1}. [Risk ${action.risk_score}] ${action.action_type}: `;
      if (action.command) brief += `\`${action.command.substring(0, 80)}\``;
      if (action.file_path) brief += `${action.file_path}`;
      if (action.tool_name) brief += `${action.tool_name}`;
      brief += `\n   → ${action.flag_reason}\n`;
    });
  } else {
    brief += `✅ No flagged actions today.\n`;
  }

  // Store brief
  db.prepare(`
    INSERT INTO safety_briefs (date, total_actions, flagged_actions, high_risk_actions, self_modifications, intent_drifts, resource_abuses, brief_text, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date,
    actionStats.total,
    actionStats.flagged,
    actionStats.high_risk,
    selfModCount.count,
    intentDriftCount.count,
    resourceAbuseCount.count,
    brief,
    new Date().toISOString()
  );

  return brief;
}

// ============================================================================
// 2. Pre-execution Risk Scoring
// ============================================================================

const HIGH_RISK_PATTERNS = [
  { pattern: /rm\s+-rf/, category: 'critical', reason: 'Recursive force delete' },
  { pattern: /git\s+push\s+.*--force/, category: 'critical', reason: 'Force push to remote' },
  { pattern: /git\s+reset\s+--hard/, category: 'high', reason: 'Hard reset (destructive)' },
  { pattern: /DROP\s+TABLE/i, category: 'critical', reason: 'Database table drop' },
  { pattern: /DELETE\s+FROM/i, category: 'high', reason: 'Database delete' },
  { pattern: /\.env/, category: 'high', reason: 'Accessing environment secrets' },
  { pattern: /launchctl\s+(unload|bootout)/, category: 'high', reason: 'Service shutdown' },
  { pattern: />\/dev\/null/, category: 'medium', reason: 'Output suppression (hiding evidence)' },
  { pattern: /curl.*\|\s*bash/, category: 'critical', reason: 'Pipe to bash (arbitrary code execution)' },
  { pattern: /sudo/, category: 'high', reason: 'Privilege escalation' },
];

const SENSITIVE_PATHS = [
  '/workspace/project/src/',
  '/workspace/project/.env',
  '/workspace/project/package.json',
  '~/Library/LaunchAgents/',
  '~/.claude/',
];

export function assessRisk(action: { type: 'bash' | 'file_edit'; command?: string; file_path?: string }): RiskAssessment {
  let risk_score = 0;
  let risk_category: 'low' | 'medium' | 'high' | 'critical' = 'low';
  let reasons: string[] = [];

  if (action.type === 'bash' && action.command) {
    // Check command patterns
    for (const { pattern, category, reason } of HIGH_RISK_PATTERNS) {
      if (pattern.test(action.command)) {
        reasons.push(reason);
        if (category === 'critical') {
          risk_score = Math.max(risk_score, 90);
          risk_category = 'critical';
        } else if (category === 'high') {
          risk_score = Math.max(risk_score, 70);
          risk_category = risk_category === 'critical' ? 'critical' : 'high';
        } else if (category === 'medium') {
          risk_score = Math.max(risk_score, 50);
          risk_category = ['critical', 'high'].includes(risk_category) ? risk_category : 'medium';
        }
      }
    }
  }

  if (action.type === 'file_edit' && action.file_path) {
    // Check if editing sensitive paths
    const isSensitive = SENSITIVE_PATHS.some(p => action.file_path!.includes(p));
    if (isSensitive) {
      risk_score = Math.max(risk_score, 60);
      risk_category = risk_category === 'critical' ? 'critical' : 'high';
      reasons.push('Modifying sensitive system file');
    }
  }

  const requires_confirmation = risk_score >= 70;

  return {
    allowed: risk_score < 90, // Block critical (90+) by default
    risk_score,
    risk_category,
    requires_confirmation,
    reason: reasons.length > 0 ? reasons.join('; ') : 'No specific risks detected'
  };
}

// ============================================================================
// 3. Self-Modification Detection
// ============================================================================

export function detectSelfModification(filePath: string, groupFolder: string, taskId?: string): boolean {
  const isSelfMod =
    filePath.includes('/workspace/project/src/') ||
    filePath.includes('~/Library/LaunchAgents/com.nanoclaw') ||
    filePath.includes('/workspace/project/container/');

  if (isSelfMod) {
    const db = getDb();
    db.prepare(`
      INSERT INTO self_modification_events (timestamp, file_path, modification_type, group_folder, task_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      filePath,
      'file_edit',
      groupFolder,
      taskId || null
    );

    logger.warn({ filePath, groupFolder, taskId }, 'Self-modification detected');
    return true;
  }

  return false;
}

// ============================================================================
// 4. Intent Drift Detection
// ============================================================================

const SCHEDULED_TASK_INTENTS: Record<string, string> = {
  'sched-bounty-hunter': 'Find and propose bounties from Algora/GitHub, submit completed work',
  'sched-shared-items-triage': 'Review shared inbox items, triage new items, act on triaged items',
  'sched-biz-opps-finder': 'Search for business opportunities, revenue streams, product ideas',
  'sched-security-review': 'Run security audit of NanoClaw codebase, check for vulnerabilities',
  'sched-memory-consolidation': 'Consolidate session memory, update MEMORY.md, clean up stale facts',
};

export function detectIntentDrift(taskId: string, observedBehavior: string): IntentDriftSignal | null {
  const expectedIntent = SCHEDULED_TASK_INTENTS[taskId.split('-').slice(0, 3).join('-')];
  if (!expectedIntent) return null;

  // Simple heuristic: if a scheduled task sends conversational messages, it's drifting
  const conversationalPatterns = [
    /how can i help/i,
    /what would you like/i,
    /let me know if/i,
    /is there anything else/i,
  ];

  const isDrifting = conversationalPatterns.some(p => p.test(observedBehavior));

  if (isDrifting) {
    const signal: IntentDriftSignal = {
      task_id: taskId,
      expected_intent: expectedIntent,
      detected_intent: observedBehavior.substring(0, 200),
      drift_score: 80,
      timestamp: new Date().toISOString()
    };

    const db = getDb();
    db.prepare(`
      INSERT INTO intent_drift_signals (task_id, expected_intent, detected_intent, drift_score, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(signal.task_id, signal.expected_intent, signal.detected_intent, signal.drift_score, signal.timestamp);

    logger.warn({ signal }, 'Intent drift detected');
    return signal;
  }

  return null;
}

// ============================================================================
// 5. Resource Abuse Detection
// ============================================================================

interface ResourceUsage {
  agentSpawnCount: number;
  totalSpendUsd: number;
  apiCallCount: number;
}

const RESOURCE_LIMITS = {
  MAX_AGENTS_PER_TASK: 5,
  MAX_SPEND_PER_TASK_USD: 10,
  MAX_API_CALLS_PER_MINUTE: 100,
};

export function detectResourceAbuse(taskId: string, usage: ResourceUsage): ResourceAbuseSignal | null {
  let signal: ResourceAbuseSignal | null = null;

  if (usage.agentSpawnCount > RESOURCE_LIMITS.MAX_AGENTS_PER_TASK) {
    signal = {
      task_id: taskId,
      abuse_type: 'agent_spawning',
      severity: 'critical',
      details: `Spawned ${usage.agentSpawnCount} agents (limit: ${RESOURCE_LIMITS.MAX_AGENTS_PER_TASK})`,
      timestamp: new Date().toISOString()
    };
  } else if (usage.totalSpendUsd > RESOURCE_LIMITS.MAX_SPEND_PER_TASK_USD) {
    signal = {
      task_id: taskId,
      abuse_type: 'excessive_spend',
      severity: 'critical',
      details: `Spent $${usage.totalSpendUsd.toFixed(2)} (limit: $${RESOURCE_LIMITS.MAX_SPEND_PER_TASK_USD})`,
      timestamp: new Date().toISOString()
    };
  } else if (usage.apiCallCount > RESOURCE_LIMITS.MAX_API_CALLS_PER_MINUTE) {
    signal = {
      task_id: taskId,
      abuse_type: 'api_flooding',
      severity: 'warning',
      details: `Made ${usage.apiCallCount} API calls in 1 minute (limit: ${RESOURCE_LIMITS.MAX_API_CALLS_PER_MINUTE})`,
      timestamp: new Date().toISOString()
    };
  }

  if (signal) {
    const db = getDb();
    db.prepare(`
      INSERT INTO resource_abuse_signals (task_id, abuse_type, severity, details, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(signal.task_id, signal.abuse_type, signal.severity, signal.details, signal.timestamp);

    logger.warn({ signal }, 'Resource abuse detected');
  }

  return signal;
}

// ============================================================================
// Monitoring Hooks (to be integrated into existing systems)
// ============================================================================

/**
 * Call this hook before executing bash commands
 */
export async function beforeBashCommand(command: string, groupFolder: string, taskId?: string): Promise<boolean> {
  const assessment = assessRisk({ type: 'bash', command });

  // Log the action
  logAction({
    timestamp: new Date().toISOString(),
    action_type: 'bash',
    command,
    risk_score: assessment.risk_score,
    flagged: assessment.requires_confirmation || !assessment.allowed,
    flag_reason: assessment.reason,
    group_folder: groupFolder,
    task_id: taskId
  });

  // Block critical commands
  if (!assessment.allowed) {
    logger.error({ command, assessment }, 'Blocked critical command');
    return false;
  }

  // Require confirmation for high-risk commands
  if (assessment.requires_confirmation) {
    logger.warn({ command, assessment }, 'High-risk command requires confirmation');
    // TODO: Implement HITL confirmation flow
    // For now, log and allow
  }

  return true;
}

/**
 * Call this hook before editing files
 */
export async function beforeFileEdit(filePath: string, groupFolder: string, taskId?: string): Promise<boolean> {
  const assessment = assessRisk({ type: 'file_edit', file_path: filePath });

  // Check for self-modification
  const isSelfMod = detectSelfModification(filePath, groupFolder, taskId);

  // Log the action
  logAction({
    timestamp: new Date().toISOString(),
    action_type: 'file_edit',
    file_path: filePath,
    risk_score: isSelfMod ? Math.max(assessment.risk_score, 80) : assessment.risk_score,
    flagged: isSelfMod || assessment.requires_confirmation,
    flag_reason: isSelfMod ? 'Self-modification detected' : assessment.reason,
    group_folder: groupFolder,
    task_id: taskId
  });

  return true;
}

/**
 * Call this hook after agent sends a message (for intent drift detection)
 */
export function afterAgentMessage(taskId: string, messageText: string): void {
  if (taskId.startsWith('sched-')) {
    detectIntentDrift(taskId, messageText);
  }
}

/**
 * Call this hook periodically to check resource usage
 */
export function checkResourceUsage(taskId: string, usage: ResourceUsage): void {
  detectResourceAbuse(taskId, usage);
}
