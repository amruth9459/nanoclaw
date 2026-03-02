/**
 * Task System - Evolved from TodoWrite
 *
 * Based on lessons from "Seeing like an Agent" (Claude Code):
 * - Tasks > Todos: More flexible, multi-agent capable
 * - Support dependencies and coordination
 * - Allow dynamic modification and deletion
 * - Enable cross-agent communication
 *
 * This re-exports task types and functions from db.ts and goal-decomposition.ts
 */

// Re-export Task type from goal-decomposition (compatible with our needs)
export type { Task } from './goal-decomposition.js';

/**
 * Format tasks for display
 */
export function formatTaskList(tasks: Array<{
  id: string;
  description: string;
  status: string;
  priority: number;
  dependencies: string[];
  assignedAgent?: string | null;
}>): string {
  if (tasks.length === 0) {
    return 'No tasks';
  }

  const lines: string[] = [];

  for (const task of tasks) {
    const icon = task.status === 'completed' ? '✓' :
                 task.status === 'in_progress' ? '▶' :
                 task.status === 'blocked' ? '⏸' : '◦';

    const priority = '★'.repeat(Math.min(task.priority, 5));
    const agent = task.assignedAgent ? ` [@${task.assignedAgent}]` : '';
    const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.length})` : '';

    lines.push(`${icon} ${priority} ${task.description}${agent}${deps}`);
  }

  return lines.join('\n');
}
