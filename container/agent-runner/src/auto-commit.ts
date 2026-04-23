/**
 * Auto-Commit System
 * Triggers after a task is marked "completed" in TodoWrite.
 * Auto-stages modified files, generates commit message, and commits.
 *
 * Format: "[Task] {description}\n\nCo-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
 */

import { execSync } from 'child_process';
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

export interface AutoCommitResult {
  committed: boolean;
  commitHash?: string;
  message?: string;
  filesCommitted?: string[];
  error?: string;
}

function log(message: string): void {
  console.error(`[auto-commit] ${message}`);
}

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000 }).trim();
}

/**
 * Check if there are staged or unstaged changes to commit.
 */
function hasChanges(cwd: string): boolean {
  try {
    const status = exec('git status --porcelain', cwd);
    return status.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if we're in a git repository.
 */
function isGitRepo(cwd: string): boolean {
  try {
    exec('git rev-parse --is-inside-work-tree', cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a short summary of changes from git diff.
 */
function getDiffSummary(cwd: string): string {
  try {
    const stat = exec('git diff --cached --stat', cwd);
    if (!stat) {
      // Nothing staged yet — check unstaged
      return exec('git diff --stat', cwd) || 'No diff available';
    }
    return stat;
  } catch {
    return 'No diff available';
  }
}

/**
 * Get list of modified/added files.
 */
function getModifiedFiles(cwd: string): string[] {
  try {
    const output = exec('git status --porcelain', cwd);
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => line.slice(3).trim());
  } catch {
    return [];
  }
}

/**
 * Generate a commit message from the task description and diff.
 */
function generateCommitMessage(taskDescription: string, diffSummary: string): string {
  // Clean up task description
  const cleanDesc = taskDescription
    .replace(/^\[.*?\]\s*/, '') // Remove existing prefixes like [in_progress]
    .replace(/^(Create|Implement|Add|Fix|Update|Refactor|Remove|Delete)\s+/i, '$1 ')
    .trim();

  const summary = cleanDesc.length > 72
    ? cleanDesc.slice(0, 69) + '...'
    : cleanDesc;

  return `[Task] ${summary}\n\n${diffSummary}\n\nCo-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>`;
}

/**
 * Perform an auto-commit of all modified files.
 */
export async function autoCommit(
  taskDescription: string,
  cwd: string,
): Promise<AutoCommitResult> {
  if (!isGitRepo(cwd)) {
    return { committed: false, error: 'Not a git repository' };
  }

  if (!hasChanges(cwd)) {
    return { committed: false, error: 'No changes to commit' };
  }

  try {
    const files = getModifiedFiles(cwd);
    log(`Found ${files.length} modified files: ${files.slice(0, 5).join(', ')}${files.length > 5 ? '...' : ''}`);

    // Stage all modified files
    exec('git add -A', cwd);

    // Generate commit message
    const diffSummary = getDiffSummary(cwd);
    const message = generateCommitMessage(taskDescription, diffSummary);

    // Commit
    exec(`git commit -m ${JSON.stringify(message)}`, cwd);

    // Get commit hash
    const hash = exec('git rev-parse --short HEAD', cwd);

    log(`Committed: ${hash} — ${taskDescription.slice(0, 60)}`);

    return {
      committed: true,
      commitHash: hash,
      message,
      filesCommitted: files,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Commit failed: ${errorMsg}`);
    return { committed: false, error: errorMsg };
  }
}

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/**
 * Create a PreToolUse hook for TodoWrite that triggers auto-commit
 * when a task is marked as "completed".
 */
export function createAutoCommitHook(cwd: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as { todos?: TodoItem[] } | undefined;

    if (!toolInput?.todos) return {};

    // Check if any todo is being marked as completed
    const completedTasks = toolInput.todos.filter(t => t.status === 'completed');
    if (completedTasks.length === 0) return {};

    // Find the most recently completed task (last in the completed list)
    const lastCompleted = completedTasks[completedTasks.length - 1];
    const description = lastCompleted.content || lastCompleted.activeForm || 'Task completed';

    // Only commit if there are actual file changes
    if (!hasChanges(cwd)) {
      log(`Task completed: "${description}" — no file changes to commit`);
      return {};
    }

    log(`Task completed: "${description}" — auto-committing...`);
    const result = await autoCommit(description, cwd);

    if (result.committed) {
      log(`Auto-commit successful: ${result.commitHash} (${result.filesCommitted?.length || 0} files)`);
    } else {
      log(`Auto-commit skipped: ${result.error}`);
    }

    // Don't modify the TodoWrite input — let it proceed normally
    return {};
  };
}
