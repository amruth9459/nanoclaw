/**
 * Safe-Action Classifier
 * Determines if tool calls are safe to auto-approve or risky (require notification).
 *
 * Safe (auto-approve): Read, Glob, Grep, git status, git diff, npm test, ls, cat
 * Risky (require approval): Write, Edit, file deletion, git push, external APIs, rm
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';

export interface ActionClassification {
  isSafe: boolean;
  reasoning: string;
  requiresApproval: boolean;
  riskLevel: 'safe' | 'moderate' | 'high' | 'critical';
}

// Tools that are always safe (read-only operations)
const SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'TaskOutput',
  'ToolSearch',
]);

// Tools that are inherently risky (write operations)
const RISKY_TOOLS = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
]);

// Bash commands that are safe (read-only)
const SAFE_BASH_PATTERNS = [
  /^\s*git\s+(status|diff|log|show|branch|tag|remote|stash\s+list)\b/,
  /^\s*ls\b/,
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*wc\b/,
  /^\s*find\b/,
  /^\s*grep\b/,
  /^\s*rg\b/,
  /^\s*echo\b/,
  /^\s*pwd\b/,
  /^\s*which\b/,
  /^\s*whoami\b/,
  /^\s*date\b/,
  /^\s*npm\s+(test|run\s+test|run\s+lint|run\s+check|list|ls|outdated)\b/,
  /^\s*npx\s+(jest|vitest|mocha|eslint|prettier\s+--check)\b/,
  /^\s*pytest\b/,
  /^\s*python\s+-m\s+(pytest|unittest)\b/,
  /^\s*node\s+--check\b/,
  /^\s*tsc\s+--noEmit\b/,
  /^\s*cargo\s+(test|check|clippy)\b/,
  /^\s*go\s+(test|vet)\b/,
  /^\s*make\s+(test|check|lint)\b/,
];

// Bash commands that are critical risk
const CRITICAL_BASH_PATTERNS = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
  /\bgit\s+push\s+--force/,
  /\bgit\s+reset\s+--hard/,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\bkubectl\s+delete\b/,
  /\bdocker\s+rm\b/,
  /\bchmod\s+777\b/,
  /\bsudo\b/,
];

// Bash commands that are high risk
const HIGH_RISK_BASH_PATTERNS = [
  /\bgit\s+push\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+checkout\s+--\b/,
  /\bgit\s+rebase\b/,
  /\brm\b/,
  /\bcurl\b.*\b(-X\s*(POST|PUT|DELETE|PATCH)|-d\s)/,
  /\bwget\b/,
  /\bnpm\s+(publish|unpublish)\b/,
  /\bnpm\s+install\b/,
  /\bpip\s+install\b/,
  /\bapt\s+(install|remove|purge)\b/,
  /\bbrew\s+(install|uninstall|remove)\b/,
];

function classifyBashCommand(command: string): ActionClassification {
  const trimmed = command.trim();

  // Check critical first
  for (const pattern of CRITICAL_BASH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isSafe: false,
        reasoning: `Critical: matches destructive pattern ${pattern.source}`,
        requiresApproval: true,
        riskLevel: 'critical',
      };
    }
  }

  // Check high risk
  for (const pattern of HIGH_RISK_BASH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isSafe: false,
        reasoning: `High risk: matches pattern ${pattern.source}`,
        requiresApproval: true,
        riskLevel: 'high',
      };
    }
  }

  // Check safe patterns
  for (const pattern of SAFE_BASH_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        isSafe: true,
        reasoning: `Safe: matches read-only pattern ${pattern.source}`,
        requiresApproval: false,
        riskLevel: 'safe',
      };
    }
  }

  // Default: moderate risk for unknown bash commands
  return {
    isSafe: false,
    reasoning: `Moderate: unrecognized bash command, defaulting to risky`,
    requiresApproval: false,
    riskLevel: 'moderate',
  };
}

export function classifyAction(
  toolName: string,
  toolInput: Record<string, unknown>,
): ActionClassification {
  // Safe tools (read-only)
  if (SAFE_TOOLS.has(toolName)) {
    return {
      isSafe: true,
      reasoning: `Tool '${toolName}' is read-only and safe`,
      requiresApproval: false,
      riskLevel: 'safe',
    };
  }

  // Risky tools (write operations)
  if (RISKY_TOOLS.has(toolName)) {
    return {
      isSafe: false,
      reasoning: `Tool '${toolName}' modifies files`,
      requiresApproval: false, // moderate — allowed but logged
      riskLevel: 'moderate',
    };
  }

  // Bash: classify based on command content
  if (toolName === 'Bash') {
    const command = (toolInput as { command?: string })?.command || '';
    return classifyBashCommand(command);
  }

  // Team/Task tools: moderate risk
  if (['TeamCreate', 'TeamDelete', 'SendMessage', 'Task', 'TaskStop'].includes(toolName)) {
    return {
      isSafe: false,
      reasoning: `Tool '${toolName}' affects shared state`,
      requiresApproval: false,
      riskLevel: 'moderate',
    };
  }

  // MCP tools (nanoclaw namespace): classify by tool name
  if (toolName.startsWith('mcp__nanoclaw__')) {
    const mcpTool = toolName.replace('mcp__nanoclaw__', '');
    const safeMcpTools = ['list_groups', 'list_tasks', 'semantic_search', 'shared_items'];
    if (safeMcpTools.some(t => mcpTool.includes(t))) {
      return {
        isSafe: true,
        reasoning: `MCP tool '${mcpTool}' is read-only`,
        requiresApproval: false,
        riskLevel: 'safe',
      };
    }
    return {
      isSafe: false,
      reasoning: `MCP tool '${mcpTool}' may modify state`,
      requiresApproval: false,
      riskLevel: 'moderate',
    };
  }

  // Skill tool: moderate risk
  if (toolName === 'Skill') {
    return {
      isSafe: false,
      reasoning: `Skill execution may have side effects`,
      requiresApproval: false,
      riskLevel: 'moderate',
    };
  }

  // Unknown: default to moderate
  return {
    isSafe: false,
    reasoning: `Unknown tool '${toolName}', defaulting to moderate risk`,
    requiresApproval: false,
    riskLevel: 'moderate',
  };
}

const IPC_MESSAGES_DIR = '/workspace/ipc/messages';

/**
 * Create a PreToolUse hook that classifies actions and logs risky ones.
 * Sends WhatsApp notifications for high/critical risk actions.
 */
export function createSafeActionHook(chatJid: string, groupFolder: string): HookCallback {
  let safeCount = 0;
  let riskyCount = 0;

  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const toolName = preInput.tool_name;
    const toolInput = (preInput.tool_input || {}) as Record<string, unknown>;

    const classification = classifyAction(toolName, toolInput);

    if (classification.isSafe) {
      safeCount++;
    } else {
      riskyCount++;
    }

    // Log all classifications to stderr for debugging
    const total = safeCount + riskyCount;
    const autoApprovalRate = total > 0 ? Math.round((safeCount / total) * 100) : 0;

    if (classification.riskLevel === 'high' || classification.riskLevel === 'critical') {
      console.error(
        `[safe-action] ${classification.riskLevel.toUpperCase()}: ${toolName} — ${classification.reasoning} (auto-approval rate: ${autoApprovalRate}%)`,
      );

      // Send WhatsApp notification for high/critical risk actions
      try {
        fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
        const filepath = path.join(IPC_MESSAGES_DIR, `${Date.now()}-risk-alert.json`);
        const preview = toolName === 'Bash'
          ? (toolInput.command as string || '').slice(0, 100)
          : JSON.stringify(toolInput).slice(0, 100);
        const data = {
          type: 'message',
          chatJid,
          groupFolder,
          text: `⚠️ *${classification.riskLevel.toUpperCase()} Risk Action*\n\nTool: \`${toolName}\`\nAction: \`${preview}\`\nReason: ${classification.reasoning}`,
          timestamp: new Date().toISOString(),
        };
        const tmp = `${filepath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, filepath);
      } catch {
        // Non-fatal: don't block execution on notification failure
      }
    }

    // Never block execution — just classify and log
    return {};
  };
}
