/**
 * GSD Checkpoint — Auto-checkpointing for spec progress
 *
 * Creates periodic snapshots of agent progress against the spec.
 * Tracks what's done, what's next, and what's blocked.
 */

import { logger } from '../logger.js';
import type { Checkpoint, Spec, SpecProgress } from './types.js';
import { getSpec } from './db.js';
import { createCheckpoint, getLatestCheckpoint, getCheckpoints } from './db.js';

const DEFAULT_CHECKPOINT_INTERVAL = 10; // turns

// ── Progress calculation ────────────────────────────────────────────────────────

/** Calculate progress from a spec's phases/checklist items */
export function calculateProgress(spec: Spec): SpecProgress {
  let completed = 0;
  let total = 0;
  let nextItem: string | null = null;
  const phaseProgress: SpecProgress['phases'] = [];

  for (const phase of spec.phases) {
    let phaseCompleted = 0;
    for (const item of phase.items) {
      total++;
      if (item.done) {
        completed++;
        phaseCompleted++;
      } else if (!nextItem) {
        nextItem = item.text;
      }
    }
    phaseProgress.push({
      name: phase.name,
      completed: phaseCompleted,
      total: phase.items.length,
    });
  }

  // If no phases found, count requirements from body text
  if (total === 0) {
    const reqMatch = spec.body.match(/^(\d+)\.\s+/gm);
    if (reqMatch) total = reqMatch.length;
  }

  return {
    completed,
    total,
    next: nextItem,
    blockers: [],
    phases: phaseProgress,
  };
}

// ── Checkpoint management ───────────────────────────────────────────────────────

/** Create a checkpoint for the current spec state */
export function checkpoint(opts: {
  specId: string;
  agentId: string;
  summary: string;
  blockers?: string[];
}): Checkpoint {
  const spec = getSpec(opts.specId);
  if (!spec) throw new Error(`Spec not found: ${opts.specId}`);

  const progress = calculateProgress(spec);

  // Gather completed and next items
  const completedItems: string[] = [];
  const nextItems: string[] = [];
  for (const phase of spec.phases) {
    for (const item of phase.items) {
      if (item.done) completedItems.push(item.text);
      else nextItems.push(item.text);
    }
  }

  const ckpt = createCheckpoint({
    specId: opts.specId,
    agentId: opts.agentId,
    summary: opts.summary,
    completedItems,
    nextItems: nextItems.slice(0, 5), // Top 5 next items
    blockers: opts.blockers ?? progress.blockers,
  });

  logger.info(
    { specId: opts.specId, checkpointId: ckpt.id, completed: progress.completed, total: progress.total },
    'GSD checkpoint created',
  );

  return ckpt;
}

/** Check if it's time for an auto-checkpoint based on turn number */
export function shouldCheckpoint(turnNumber: number, interval: number = DEFAULT_CHECKPOINT_INTERVAL): boolean {
  return turnNumber > 0 && turnNumber % interval === 0;
}

/** Get the latest checkpoint for a spec */
export function getLastCheckpoint(specId: string): Checkpoint | null {
  return getLatestCheckpoint(specId);
}

/** Get checkpoint history */
export function getCheckpointHistory(specId: string, limit = 20): Checkpoint[] {
  return getCheckpoints(specId, limit);
}

/** Format checkpoint as human-readable summary */
export function formatCheckpoint(ckpt: Checkpoint, progress: SpecProgress): string {
  const lines: string[] = [
    `Checkpoint ${ckpt.id} (${new Date(ckpt.timestamp).toISOString()})`,
    `Agent: ${ckpt.agentId}`,
    `Progress: ${progress.completed}/${progress.total} items completed`,
    `Summary: ${ckpt.summary}`,
  ];

  if (ckpt.blockers.length > 0) {
    lines.push(`Blockers: ${ckpt.blockers.join(', ')}`);
  }
  if (progress.next) {
    lines.push(`Next: ${progress.next}`);
  }

  return lines.join('\n');
}
