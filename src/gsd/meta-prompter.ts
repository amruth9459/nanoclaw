/**
 * GSD Meta-Prompter — Generate role-specific prompts from specs
 *
 * Creates context-aware system prompts that keep agents on track.
 * Supports progressive disclosure, anti-drift reminders, and
 * milestone celebrations.
 */

import type { AgentRole, MetaPromptOptions, Spec, SpecProgress } from './types.js';
import { getSpec } from './db.js';
import { calculateProgress } from './checkpoint.js';
import { getLastCheckpoint } from './checkpoint.js';
import { generateSpecReminder, getRelevantSection } from './context-keeper.js';
import { shouldCheckpoint } from './checkpoint.js';

// ── Prompt generation ───────────────────────────────────────────────────────────

/** Generate a role-specific meta-prompt for an agent */
export function generateMetaPrompt(opts: MetaPromptOptions): string {
  const spec = getSpec(opts.specId);
  if (!spec) return '';

  const progress = calculateProgress(spec);
  const sections: string[] = [];

  // 1. Spec reminder (always included)
  const reminder = generateSpecReminder(opts.specId);
  if (reminder) sections.push(reminder);

  // 2. Role-specific instructions
  sections.push(generateRoleInstructions(opts.role, spec, progress));

  // 3. Relevant spec section (progressive disclosure)
  if (opts.currentTask) {
    const section = getRelevantSection(opts.specId, opts.currentTask);
    if (section) {
      sections.push(`RELEVANT SPEC SECTION:\n${section}`);
    }
  }

  // 4. Milestone celebration
  const celebration = checkMilestone(progress);
  if (celebration) sections.push(celebration);

  // 5. Auto-checkpoint reminder
  const interval = opts.checkpointInterval ?? 10;
  if (opts.turnNumber && shouldCheckpoint(opts.turnNumber, interval)) {
    sections.push(
      'CHECKPOINT DUE: Use gsd_tool({ action: "checkpoint", summary: "..." }) to save progress.',
    );
  }

  return sections.join('\n\n');
}

/** Generate instructions specific to the agent's role */
function generateRoleInstructions(role: AgentRole, spec: Spec, progress: SpecProgress): string {
  switch (role) {
    case 'developer':
      return [
        'ROLE: Developer',
        `You are implementing: ${spec.frontmatter.goal}`,
        progress.next ? `Current task: ${progress.next}` : 'All checklist items completed!',
        'Rules:',
        '- Only implement what\'s in the spec',
        '- Mark items complete as you finish them: gsd_tool({ action: "complete_item", item_text: "..." })',
        '- If you discover something that needs doing but isn\'t in spec, note it but don\'t do it',
        spec.frontmatter.priorities.length > 0
          ? `- Priority: ${spec.frontmatter.priorities[0]}`
          : '',
      ].filter(Boolean).join('\n');

    case 'reviewer':
      return [
        'ROLE: Reviewer',
        `You are reviewing work against: ${spec.frontmatter.goal}`,
        'Check:',
        `- Does the implementation satisfy success criteria? [${spec.frontmatter.success_criteria.join('; ')}]`,
        `- Are constraints respected? [${spec.frontmatter.constraints.join('; ')}]`,
        '- Is there any off-spec work that should be reverted?',
        '- Are there gaps between spec and implementation?',
      ].join('\n');

    case 'tester':
      return [
        'ROLE: Tester',
        `You are testing: ${spec.frontmatter.goal}`,
        'Test against success criteria:',
        ...spec.frontmatter.success_criteria.map((c, i) => `  ${i + 1}. ${c}`),
        'Report:',
        '- Which criteria pass/fail',
        '- Edge cases found',
        '- Performance observations',
      ].join('\n');

    case 'planner':
      return [
        'ROLE: Planner',
        `You are planning: ${spec.frontmatter.goal}`,
        `Progress: ${progress.completed}/${progress.total} done`,
        'Tasks:',
        '- Review what\'s been completed',
        '- Identify blockers and dependencies',
        '- Suggest next steps and task priorities',
        '- Estimate remaining effort',
      ].join('\n');

    default:
      return '';
  }
}

/** Check for milestone achievements to celebrate */
function checkMilestone(progress: SpecProgress): string | null {
  if (progress.total === 0) return null;

  const pct = (progress.completed / progress.total) * 100;

  if (progress.completed === progress.total) {
    return 'ALL REQUIREMENTS COMPLETED! Run final validation and mark spec as complete.';
  }
  if (pct >= 75 && pct < 100) {
    return `MILESTONE: ${progress.completed}/${progress.total} requirements done (${Math.round(pct)}%). Almost there!`;
  }
  if (pct >= 50 && pct < 75) {
    return `MILESTONE: ${progress.completed}/${progress.total} requirements done (${Math.round(pct)}%). Halfway there!`;
  }
  if (pct >= 25 && pct < 50) {
    return `Progress: ${progress.completed}/${progress.total} requirements done (${Math.round(pct)}%). Keep going!`;
  }

  return null;
}

/** Generate anti-drift reminder text */
export function generateAntiDriftReminder(specId: string): string | null {
  const spec = getSpec(specId);
  if (!spec) return null;

  return [
    `Remember: you're building "${spec.frontmatter.goal}", not something else.`,
    spec.frontmatter.constraints.length > 0
      ? `Constraints: ${spec.frontmatter.constraints.join('. ')}.`
      : '',
    spec.frontmatter.priorities.length > 0
      ? `Priority: ${spec.frontmatter.priorities[0]}.`
      : '',
  ].filter(Boolean).join(' ');
}
