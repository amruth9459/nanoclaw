/**
 * Container-side Agent Monitoring Hooks
 *
 * Lightweight versions of the host-side monitoring system.
 * Risk assessment runs locally in the container; logging is done via IPC
 * so the host can persist to the database.
 */

import fs from 'fs';
import path from 'path';

const IPC_DIR = '/workspace/ipc';
const IPC_MESSAGES_DIR = path.join(IPC_DIR, 'messages');

// ============================================================================
// Types
// ============================================================================

interface RiskAssessment {
  allowed: boolean;
  risk_score: number;
  risk_category: 'low' | 'medium' | 'high' | 'critical';
  requires_confirmation: boolean;
  reason: string;
}

interface MonitoringIpcMessage {
  type: 'monitoring_log';
  action_type: 'bash' | 'file_edit' | 'agent_spawn';
  command?: string;
  file_path?: string;
  risk_score: number;
  flagged: boolean;
  flag_reason?: string;
  group_folder: string;
  task_id?: string;
  is_self_modification?: boolean;
  timestamp: string;
}

// ============================================================================
// Risk Patterns (mirrored from host-side monitoring)
// ============================================================================

const HIGH_RISK_PATTERNS = [
  { pattern: /rm\s+-rf/, category: 'critical' as const, reason: 'Recursive force delete' },
  { pattern: /git\s+push\s+.*--force/, category: 'critical' as const, reason: 'Force push to remote' },
  { pattern: /git\s+reset\s+--hard/, category: 'high' as const, reason: 'Hard reset (destructive)' },
  { pattern: /DROP\s+TABLE/i, category: 'critical' as const, reason: 'Database table drop' },
  { pattern: /DELETE\s+FROM/i, category: 'high' as const, reason: 'Database delete' },
  { pattern: /\.env/, category: 'high' as const, reason: 'Accessing environment secrets' },
  { pattern: /launchctl\s+(unload|bootout)/, category: 'high' as const, reason: 'Service shutdown' },
  { pattern: />\/dev\/null/, category: 'medium' as const, reason: 'Output suppression (hiding evidence)' },
  { pattern: /curl.*\|\s*bash/, category: 'critical' as const, reason: 'Pipe to bash (arbitrary code execution)' },
  { pattern: /sudo/, category: 'high' as const, reason: 'Privilege escalation' },
];

const SENSITIVE_PATHS = [
  '/workspace/project/src/',
  '/workspace/project/.env',
  '/workspace/project/package.json',
  '~/Library/LaunchAgents/',
  '~/.claude/',
];

// ============================================================================
// IPC Helper
// ============================================================================

function writeMonitoringIpc(message: MonitoringIpcMessage): void {
  try {
    fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
    const filename = `${Date.now()}-monitoring-${Math.random().toString(36).slice(2, 8)}.json`;
    const filepath = path.join(IPC_MESSAGES_DIR, filename);
    const tmp = `${filepath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(message, null, 2));
    fs.renameSync(tmp, filepath);
  } catch {
    // Monitoring should never break the agent
  }
}

// ============================================================================
// Risk Assessment (runs locally in container)
// ============================================================================

function assessRisk(action: { type: 'bash' | 'file_edit'; command?: string; file_path?: string }): RiskAssessment {
  let risk_score = 0;
  let risk_category: 'low' | 'medium' | 'high' | 'critical' = 'low';
  const reasons: string[] = [];

  if (action.type === 'bash' && action.command) {
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
    const isSensitive = SENSITIVE_PATHS.some(p => action.file_path!.includes(p));
    if (isSensitive) {
      risk_score = Math.max(risk_score, 60);
      risk_category = risk_category === 'critical' ? 'critical' : 'high';
      reasons.push('Modifying sensitive system file');
    }
  }

  return {
    allowed: risk_score < 90,
    risk_score,
    risk_category,
    requires_confirmation: risk_score >= 70,
    reason: reasons.length > 0 ? reasons.join('; ') : 'No specific risks detected',
  };
}

// ============================================================================
// Monitoring Hooks
// ============================================================================

/**
 * Call before executing bash commands.
 * Returns false if the command should be blocked (critical risk).
 */
export function beforeBashCommand(command: string, groupFolder: string, taskId?: string): boolean {
  const assessment = assessRisk({ type: 'bash', command });

  writeMonitoringIpc({
    type: 'monitoring_log',
    action_type: 'bash',
    command,
    risk_score: assessment.risk_score,
    flagged: assessment.requires_confirmation || !assessment.allowed,
    flag_reason: assessment.reason !== 'No specific risks detected' ? assessment.reason : undefined,
    group_folder: groupFolder,
    task_id: taskId,
    timestamp: new Date().toISOString(),
  });

  return assessment.allowed;
}

/**
 * Call before editing files.
 * Always returns true (file edits are logged but not blocked).
 */
export function beforeFileEdit(filePath: string, groupFolder: string, taskId?: string): boolean {
  const assessment = assessRisk({ type: 'file_edit', file_path: filePath });

  const isSelfMod =
    filePath.includes('/workspace/project/src/') ||
    filePath.includes('/workspace/project/container/');

  writeMonitoringIpc({
    type: 'monitoring_log',
    action_type: 'file_edit',
    file_path: filePath,
    risk_score: isSelfMod ? Math.max(assessment.risk_score, 80) : assessment.risk_score,
    flagged: isSelfMod || assessment.requires_confirmation,
    flag_reason: isSelfMod ? 'Self-modification detected' : assessment.reason !== 'No specific risks detected' ? assessment.reason : undefined,
    group_folder: groupFolder,
    task_id: taskId,
    is_self_modification: isSelfMod,
    timestamp: new Date().toISOString(),
  });

  return true;
}

/**
 * Call after agent sends a message (for intent drift detection on scheduled tasks).
 */
export function afterAgentMessage(taskId: string, messageText: string, groupFolder: string): void {
  if (!taskId.startsWith('sched-')) return;

  const conversationalPatterns = [
    /how can i help/i,
    /what would you like/i,
    /let me know if/i,
    /is there anything else/i,
  ];

  const isDrifting = conversationalPatterns.some(p => p.test(messageText));
  if (!isDrifting) return;

  writeMonitoringIpc({
    type: 'monitoring_log',
    action_type: 'bash', // logged as action for the host to categorize as intent_drift
    command: `[INTENT_DRIFT] task=${taskId} text=${messageText.substring(0, 200)}`,
    risk_score: 80,
    flagged: true,
    flag_reason: `Intent drift: scheduled task ${taskId} sent conversational message`,
    group_folder: groupFolder,
    task_id: taskId,
    timestamp: new Date().toISOString(),
  });
}
