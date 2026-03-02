/**
 * Task Tool - MCP Interface for Task System
 *
 * Replaces TodoWrite with a more powerful multi-agent task system
 * Based on Claude Code's evolution from Todos to Tasks
 */

import { z } from 'zod';
import { formatTaskList } from '../../task-system.js';
import {
  TaskRecord,
  createTaskRecord,
  getTaskRecord,
  getTaskRecords,
  updateTaskRecord,
  deleteTaskRecord,
  getAvailableTaskRecords,
  getTaskStats,
} from '../../db.js';

const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']);
const TaskComplexitySchema = z.enum(['trivial', 'simple', 'moderate', 'complex', 'expert']);

export const TaskToolSchema = z.object({
  action: z.enum(['create', 'update', 'list', 'get', 'delete', 'available']).describe('Action to perform'),

  // For create
  description: z.string().optional().describe('Task description'),
  complexity: TaskComplexitySchema.optional().describe('Task complexity'),
  priority: z.number().min(1).max(100).optional().describe('Priority 1-100 (100=highest)'),
  dependencies: z.array(z.string()).optional().describe('Task IDs this depends on'),
  assignedAgent: z.string().optional().describe('Agent name to assign'),
  estimatedHours: z.number().optional().describe('Estimated hours to complete'),

  // For update/get/delete
  taskId: z.string().optional().describe('Task ID to operate on'),

  // For update
  status: TaskStatusSchema.optional().describe('New status'),
  newPriority: z.number().min(1).max(100).optional().describe('New priority'),
  newAgent: z.string().optional().describe('New assigned agent'),

  // For list
  filterStatus: TaskStatusSchema.optional().describe('Filter by status'),
  filterAgent: z.string().optional().describe('Filter by assigned agent'),
});

export type TaskToolInput = z.infer<typeof TaskToolSchema>;

export async function executeTaskTool(input: TaskToolInput): Promise<string> {
  try {
    switch (input.action) {
      case 'create': {
        if (!input.description) {
          return 'Error: description is required for create action';
        }

        const task = createTaskRecord({
          description: input.description,
          complexity: input.complexity,
          priority: input.priority,
          dependencies: input.dependencies,
          assignedAgent: input.assignedAgent,
          estimatedHours: input.estimatedHours,
        });

        return `✓ Task created: ${task.id}\n${task.description}\nPriority: ${'★'.repeat(Math.min(task.priority, 5))}`;
      }

      case 'update': {
        if (!input.taskId) {
          return 'Error: taskId is required for update action';
        }

        const updates: any = {};
        if (input.status) updates.status = input.status;
        if (input.newPriority) updates.priority = input.newPriority;
        if (input.newAgent !== undefined) updates.assignedAgent = input.newAgent;

        const task = updateTaskRecord(input.taskId, updates);

        if (!task) {
          return `Error: Task ${input.taskId} not found`;
        }

        return `✓ Task updated: ${task.id}\nStatus: ${task.status}\nPriority: ${'★'.repeat(Math.min(task.priority, 5))}`;
      }

      case 'get': {
        if (!input.taskId) {
          return 'Error: taskId is required for get action';
        }

        const task = getTaskRecord(input.taskId);

        if (!task) {
          return `Error: Task ${input.taskId} not found`;
        }

        const deps = task.dependencies.length > 0
          ? `\nDependencies: ${task.dependencies.join(', ')}`
          : '';

        const agent = task.assignedAgent
          ? `\nAssigned: @${task.assignedAgent}`
          : '';

        return `**Task ${task.id}**\n` +
               `Description: ${task.description}\n` +
               `Status: ${task.status}\n` +
               `Priority: ${'★'.repeat(Math.min(task.priority, 5))}\n` +
               `Complexity: ${task.complexity}` +
               agent + deps;
      }

      case 'list': {
        const filters: any = {};
        if (input.filterStatus) filters.status = input.filterStatus;
        if (input.filterAgent) filters.assignedAgent = input.filterAgent;

        const tasks = getTaskRecords(filters);
        const stats = getTaskStats();

        const header = `**Tasks** (${stats.pending} pending, ${stats.inProgress} in progress, ${stats.completed} completed)\n\n`;
        const taskList = formatTaskList(tasks);

        return header + taskList;
      }

      case 'delete': {
        if (!input.taskId) {
          return 'Error: taskId is required for delete action';
        }

        const deleted = deleteTaskRecord(input.taskId);

        if (!deleted) {
          return `Error: Task ${input.taskId} not found`;
        }

        return `✓ Task ${input.taskId} deleted`;
      }

      case 'available': {
        const agent = input.filterAgent;
        const tasks = getAvailableTaskRecords(agent);

        const header = agent
          ? `**Available tasks for @${agent}**\n\n`
          : `**Available tasks**\n\n`;

        if (tasks.length === 0) {
          return header + 'No available tasks (all dependencies met)';
        }

        return header + formatTaskList(tasks);
      }

      default:
        return `Error: Unknown action ${input.action}`;
    }
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

export const TaskToolDefinition = {
  name: 'TaskTool',
  description: `Manage tasks with multi-agent coordination support.

Actions:
- create: Create a new task with description, priority, dependencies
- update: Update task status, priority, or assigned agent
- list: List all tasks (optionally filtered by status or agent)
- get: Get details of a specific task
- delete: Delete a task
- available: List tasks available to work on (dependencies met)

Tasks support:
- Dependencies: Tasks can depend on other tasks
- Assignment: Tasks can be assigned to specific agents
- Priority: 1-100 scale (100 = highest)
- Status tracking: pending → in_progress → completed
- Complexity estimation: trivial, simple, moderate, complex, expert

Example usage:
- Create: action=create, description="Build login page", priority=90
- Update: action=update, taskId="task_123", status="completed"
- List: action=list, filterStatus="pending"
- Available: action=available, filterAgent="frontend-dev"`,
  input_schema: TaskToolSchema,
};
