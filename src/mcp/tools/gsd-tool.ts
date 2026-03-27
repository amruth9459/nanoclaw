/**
 * GSD Tool — MCP Interface for spec-driven development
 *
 * Agents use this tool to stay on track:
 * - Query spec status and progress
 * - Create checkpoints
 * - Validate tasks against spec
 * - Mark items as complete
 */

import { z } from 'zod';
import {
  initSpec,
  completeItem,
  completeSpec,
  getActiveSpecs,
  calculateProgress,
  checkpoint,
  validateTask,
  generateSpecReminder,
  generateBranchName,
  generateCommitMessage,
  validateBranchName,
  validateCommitMessage,
  generatePRTemplate,
} from '../../gsd/index.js';
import { getSpec, getSpecByProject, listSpecs } from '../../gsd/db.js';

export const GsdToolSchema = z.object({
  action: z.enum([
    'init', 'status', 'checkpoint', 'validate', 'complete_item', 'complete_spec', 'list',
    'gen_branch', 'gen_commit', 'gen_pr', 'validate_branch', 'validate_commit',
  ]).describe('Action to perform'),

  // For init
  project_path: z.string().optional().describe('Project directory path (for init)'),
  goal: z.string().optional().describe('Project goal (for init)'),
  success_criteria: z.array(z.string()).optional().describe('Success criteria (for init)'),
  constraints: z.array(z.string()).optional().describe('Constraints (for init)'),
  priorities: z.array(z.string()).optional().describe('Priorities (for init)'),

  // For status/checkpoint/validate/complete_item/complete_spec
  spec_id: z.string().optional().describe('Spec ID to operate on'),

  // For checkpoint
  summary: z.string().optional().describe('Checkpoint summary or PR summary'),
  agent_id: z.string().optional().describe('Agent identifier'),
  blockers: z.array(z.string()).optional().describe('Current blockers'),

  // For validate
  task_description: z.string().optional().describe('Task to validate against spec'),

  // For complete_item
  item_text: z.string().optional().describe('Checklist item text to mark as done'),

  // Git workflow fields
  jira_id: z.string().optional().describe('Jira task ID (e.g. PROJ-123)'),
  branch_type: z.enum(['feature', 'bugfix', 'hotfix']).optional().describe('Branch type'),
  gitmoji: z.string().optional().describe('Gitmoji emoji (e.g. ✨, 🐛)'),
  description: z.string().optional().describe('Short description for branch/commit'),
  testing_notes: z.string().optional().describe('Testing details for PR'),
  risk_notes: z.string().optional().describe('Risk/security notes for PR'),
  branch_name: z.string().optional().describe('Branch name to validate'),
  commit_message: z.string().optional().describe('Commit message to validate'),
});

export type GsdToolInput = z.infer<typeof GsdToolSchema>;

export async function executeGsdTool(input: GsdToolInput): Promise<string> {
  try {
    switch (input.action) {
      case 'init': {
        if (!input.project_path || !input.goal) {
          return 'Error: project_path and goal are required for init';
        }
        if (!input.success_criteria || input.success_criteria.length === 0) {
          return 'Error: At least one success criterion is required';
        }

        const spec = initSpec({
          projectPath: input.project_path,
          goal: input.goal,
          successCriteria: input.success_criteria,
          constraints: input.constraints,
          priorities: input.priorities,
        });

        return `Spec initialized: ${spec.id}\nGoal: ${spec.frontmatter.goal}\nCriteria: ${spec.frontmatter.success_criteria.length}\nSaved to: ${input.project_path}/.gsd/spec.md`;
      }

      case 'status': {
        const spec = resolveSpec(input.spec_id);
        if (!spec) return 'Error: No spec found. Use init to create one.';

        const progress = calculateProgress(spec);
        const reminder = generateSpecReminder(spec.id);

        const lines: string[] = [
          `Spec: ${spec.id} (${spec.status})`,
          `Goal: ${spec.frontmatter.goal}`,
          `Progress: ${progress.completed}/${progress.total} items done`,
        ];

        if (progress.next) lines.push(`Next: ${progress.next}`);
        if (progress.blockers.length > 0) lines.push(`Blockers: ${progress.blockers.join(', ')}`);

        // Phase breakdown
        if (progress.phases.length > 0) {
          lines.push('');
          lines.push('Phases:');
          for (const phase of progress.phases) {
            const mark = phase.completed === phase.total ? 'done' : `${phase.completed}/${phase.total}`;
            lines.push(`  ${phase.name}: ${mark}`);
          }
        }

        return lines.join('\n');
      }

      case 'checkpoint': {
        const spec = resolveSpec(input.spec_id);
        if (!spec) return 'Error: No spec found';
        if (!input.summary) return 'Error: summary is required for checkpoint';

        const ckpt = checkpoint({
          specId: spec.id,
          agentId: input.agent_id ?? 'unknown',
          summary: input.summary,
          blockers: input.blockers,
        });

        const progress = calculateProgress(spec);
        return `Checkpoint saved: ${ckpt.id}\nProgress: ${progress.completed}/${progress.total}\nSummary: ${input.summary}`;
      }

      case 'validate': {
        const spec = resolveSpec(input.spec_id);
        if (!spec) return 'Error: No spec found';
        if (!input.task_description) return 'Error: task_description is required for validate';

        const result = validateTask(spec.id, input.task_description);
        if (result.valid) {
          return `Valid: ${result.reason}`;
        }
        return `DRIFT DETECTED: ${result.reason}`;
      }

      case 'complete_item': {
        const spec = resolveSpec(input.spec_id);
        if (!spec) return 'Error: No spec found';
        if (!input.item_text) return 'Error: item_text is required';

        const updated = completeItem(spec.id, input.item_text);
        if (!updated) return `Error: Could not find item "${input.item_text}" in spec`;

        const progress = calculateProgress(updated);
        return `Item completed: "${input.item_text}"\nProgress: ${progress.completed}/${progress.total}`;
      }

      case 'complete_spec': {
        const spec = resolveSpec(input.spec_id);
        if (!spec) return 'Error: No spec found';

        const completed = completeSpec(spec.id);
        if (!completed) return 'Error: Failed to complete spec';
        return `Spec "${spec.frontmatter.goal}" marked as completed!`;
      }

      case 'list': {
        const specs = listSpecs();
        if (specs.length === 0) return 'No specs found. Use init to create one.';

        const lines = specs.map(s => {
          const progress = calculateProgress(s);
          return `[${s.status}] ${s.id}: ${s.frontmatter.goal} (${progress.completed}/${progress.total})`;
        });
        return lines.join('\n');
      }

      // ── Git workflow actions ──────────────────────────────────────────

      case 'gen_branch': {
        const spec = resolveSpec(input.spec_id);
        if (!spec?.frontmatter.jira_id && !input.jira_id) {
          return 'Error: jira_id required (set in spec or pass as parameter)';
        }
        const jiraId = input.jira_id ?? spec!.frontmatter.jira_id!;
        const branchType = input.branch_type ?? spec?.frontmatter.branch_type ?? 'feature';
        const desc = input.description ?? spec?.frontmatter.goal ?? 'implementation';

        const branch = generateBranchName(jiraId, desc, branchType);
        return `Branch: ${branch}\n\nUse:\ngit checkout -b ${branch}`;
      }

      case 'gen_commit': {
        if (!input.jira_id || !input.gitmoji || !input.description) {
          return 'Error: jira_id, gitmoji, and description are required';
        }
        const commitMsg = generateCommitMessage(input.jira_id, input.gitmoji, input.description);
        return `Commit message:\n${commitMsg}\n\nUse:\ngit commit -m "${commitMsg}"`;
      }

      case 'gen_pr': {
        const spec = resolveSpec(input.spec_id);
        if (!spec?.frontmatter.jira_id && !input.jira_id) {
          return 'Error: jira_id required (set in spec or pass as parameter)';
        }
        if (!input.testing_notes) {
          return 'Error: testing_notes required for PR template';
        }

        const jiraId = input.jira_id ?? spec!.frontmatter.jira_id!;
        const branchType = input.branch_type ?? spec?.frontmatter.branch_type ?? 'feature';
        const goal = input.description ?? spec?.frontmatter.goal ?? 'implementation';

        const branchForPR = generateBranchName(jiraId, goal, branchType);

        const template = generatePRTemplate({
          jiraId,
          branchName: branchForPR,
          summary: input.summary ?? goal,
          testingNotes: input.testing_notes,
          riskNotes: input.risk_notes,
        });

        return template;
      }

      case 'validate_branch': {
        if (!input.branch_name) return 'Error: branch_name required';
        const result = validateBranchName(input.branch_name);
        return result.valid ? `✓ Valid branch name` : `✗ Invalid: ${result.reason}`;
      }

      case 'validate_commit': {
        if (!input.commit_message) return 'Error: commit_message required';
        const result = validateCommitMessage(input.commit_message);
        return result.valid ? `✓ Valid commit message` : `✗ Invalid: ${result.reason}`;
      }

      default:
        return `Error: Unknown action ${input.action}`;
    }
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

function resolveSpec(specId?: string): ReturnType<typeof getSpec> {
  if (specId) return getSpec(specId);
  // Try to find the active spec
  const active = getActiveSpecs();
  return active.length > 0 ? active[0] : null;
}

export const GsdToolDefinition = {
  name: 'GsdTool',
  description: `GSD (Get Shit Done) — Spec-driven development for autonomous agents.

Stay on track with your project spec. Use this tool to:
- Check status: What's done, what's next, what's blocked
- Checkpoint: Save progress snapshots
- Validate: Check if a task is within spec scope
- Complete items: Mark checklist items as done
- Git workflow: Generate branch names, commit messages, and PR templates

Actions:
- init: Create a new spec (requires project_path, goal, success_criteria)
- status: Get current progress (completed/total, next item, blockers)
- checkpoint: Save a progress snapshot (requires summary)
- validate: Check if a task is within spec (requires task_description)
- complete_item: Mark a checklist item as done (requires item_text)
- complete_spec: Mark the entire spec as completed
- list: List all specs
- gen_branch: Generate Jira-linked branch name (requires jira_id or spec with jira_id)
- gen_commit: Generate commit message (requires jira_id, gitmoji, description)
- gen_pr: Generate PR template (requires jira_id or spec with jira_id, testing_notes)
- validate_branch: Validate a branch name format
- validate_commit: Validate a commit message format

Example usage:
- Gen branch: action=gen_branch, jira_id="PROJ-123", description="add auth"
- Gen commit: action=gen_commit, jira_id="PROJ-123", gitmoji="✨", description="add SSO login"
- Validate: action=validate_branch, branch_name="feature/PROJ-123-add-auth"`,
  input_schema: GsdToolSchema,
};
