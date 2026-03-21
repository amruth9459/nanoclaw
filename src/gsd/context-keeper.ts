/**
 * GSD Context Keeper — Inject spec context into agent system prompts
 *
 * Generates a compact spec summary that gets injected into every agent
 * turn, keeping the agent aware of goals, progress, and constraints.
 */

import type { Spec, SpecProgress, Checkpoint } from './types.js';
import { getSpec, getSpecByProject, getLatestCheckpoint } from './db.js';
import { calculateProgress } from './checkpoint.js';

// ── Context injection ───────────────────────────────────────────────────────────

/** Generate the spec reminder block that gets injected into agent system prompts */
export function generateSpecReminder(specId: string): string | null {
  const spec = getSpec(specId);
  if (!spec) return null;

  const progress = calculateProgress(spec);
  const lastCheckpoint = getLatestCheckpoint(specId);

  return formatSpecReminder(spec, progress, lastCheckpoint);
}

/** Generate spec reminder by project path (finds active spec) */
export function generateSpecReminderByProject(projectPath: string): string | null {
  const spec = getSpecByProject(projectPath);
  if (!spec) return null;

  const progress = calculateProgress(spec);
  const lastCheckpoint = getLatestCheckpoint(spec.id);

  return formatSpecReminder(spec, progress, lastCheckpoint);
}

/** Format the spec reminder block */
export function formatSpecReminder(
  spec: Spec,
  progress: SpecProgress,
  lastCheckpoint: Checkpoint | null,
): string {
  const lines: string[] = [];

  lines.push('SPEC REMINDER (auto-injected by GSD):');
  lines.push(`You are building: ${spec.frontmatter.goal}`);

  // Success criteria summary
  if (spec.frontmatter.success_criteria.length > 0) {
    lines.push(`Goal: ${spec.frontmatter.success_criteria[0]}`);
  }

  // Progress
  if (progress.total > 0) {
    const progressItems: string[] = [];
    for (const phase of spec.phases) {
      for (const item of phase.items) {
        if (item.done) progressItems.push(`${item.text} done`);
      }
    }
    const doneStr = progressItems.length > 0 ? ` (${progressItems.slice(0, 3).join(', ')})` : '';
    lines.push(`Completed: ${progress.completed}/${progress.total} requirements${doneStr}`);
  }

  // Next task
  if (progress.next) {
    lines.push(`Next: ${progress.next}`);
  }

  // Constraints
  if (spec.frontmatter.constraints.length > 0) {
    lines.push(`Constraints: ${spec.frontmatter.constraints.join(', ')}`);
  }

  // Anti-drift
  if (spec.frontmatter.priorities.length > 0) {
    lines.push(`DO NOT: Add features not in spec. ${spec.frontmatter.priorities[0]}`);
  }

  // Last checkpoint
  if (lastCheckpoint) {
    const age = timeSince(lastCheckpoint.timestamp);
    lines.push(`Last checkpoint: ${age} — "${lastCheckpoint.summary}"`);
  }

  // Blockers
  if (lastCheckpoint && lastCheckpoint.blockers.length > 0) {
    lines.push(`Blockers: ${lastCheckpoint.blockers.join(', ')}`);
  }

  return lines.join('\n');
}

/** Generate a compact one-line status for task dispatch context */
export function generateCompactStatus(specId: string): string | null {
  const spec = getSpec(specId);
  if (!spec) return null;

  const progress = calculateProgress(spec);
  return `[GSD] ${spec.frontmatter.goal} — ${progress.completed}/${progress.total} done${progress.next ? ` — Next: ${progress.next}` : ''}`;
}

/** Generate the full spec body for progressive disclosure */
export function getRelevantSection(specId: string, currentTask?: string): string | null {
  const spec = getSpec(specId);
  if (!spec) return null;

  // If no current task, return full body
  if (!currentTask) return spec.body;

  // Find the phase that contains the current task
  const taskLower = currentTask.toLowerCase();
  for (const phase of spec.phases) {
    for (const item of phase.items) {
      if (item.text.toLowerCase().includes(taskLower) || taskLower.includes(item.text.toLowerCase())) {
        // Return just this phase's content
        const phaseHeader = `### ${phase.name}`;
        const bodyIdx = spec.body.indexOf(phaseHeader);
        if (bodyIdx >= 0) {
          // Find next phase header or end
          const nextHeader = spec.body.indexOf('\n### ', bodyIdx + phaseHeader.length);
          return nextHeader >= 0
            ? spec.body.slice(bodyIdx, nextHeader).trim()
            : spec.body.slice(bodyIdx).trim();
        }
      }
    }
  }

  // Fallback: return full body
  return spec.body;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function timeSince(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
