#!/usr/bin/env tsx
/**
 * Sweeper Review Lane — proposal-only.
 * Scans tasks + worktrees, writes one report per item, never mutates.
 */
import { join } from 'node:path';
import {
  ITEMS_DIR, CLOSED_DIR, archiveReport, branchExists, daysSince, ensureDirs,
  isPinned, listReports, listWorktrees, nowIso, snapshotHash, writeReport,
  isMergedToMain, type SweeperReport,
} from './lib.js';
import { initDatabase, getTaskRecords, type TaskRecord } from '../../src/db.js';

const TASK_STALE_PENDING_DAYS = 60;
const TASK_STALE_INPROGRESS_DAYS = 30;
const TASK_COMPLETED_ARCHIVE_DAYS = 7;
const WT_STALE_DAYS = 7;

function reviewTasks(): SweeperReport[] {
  const tasks = getTaskRecords();
  const reports: SweeperReport[] = [];
  const reviewedAt = nowIso();
  const seenDescriptions = new Map<string, string>();

  for (const t of tasks) {
    const id = `task-${t.id}`;
    const snap = snapshotHash(['task', t.id, t.status, t.completedAt ?? 0, t.assignedAgent ?? '', t.description]);
    const evidence: string[] = [
      `status=${t.status}`,
      `created ${Math.round(daysSince(t.createdAt))}d ago`,
      t.completedAt ? `completed ${Math.round(daysSince(t.completedAt))}d ago` : `not completed`,
      t.assignedAgent ? `assigned to ${t.assignedAgent}` : `unassigned`,
    ];

    let decision: 'keep_open' | 'proposed_close' = 'keep_open';
    let reason = 'Active task — no closure criteria met.';

    if (isPinned(id)) {
      reason = 'Pinned — explicitly excluded from auto-closure.';
    } else {
      const ageDays = daysSince(t.createdAt);
      const compAgeDays = t.completedAt ? daysSince(t.completedAt) : 0;
      const dupKey = t.description.trim().toLowerCase().slice(0, 200);
      const dupOf = seenDescriptions.get(dupKey);

      if (t.status === 'completed' && compAgeDays >= TASK_COMPLETED_ARCHIVE_DAYS) {
        decision = 'proposed_close';
        reason = `Completed ${Math.round(compAgeDays)}d ago — eligible for archive.`;
      } else if (t.status === 'cancelled') {
        decision = 'proposed_close';
        reason = 'Cancelled — eligible for archive.';
      } else if (t.status === 'in_progress' && ageDays > TASK_STALE_INPROGRESS_DAYS) {
        decision = 'proposed_close';
        reason = `In-progress for ${Math.round(ageDays)}d (>${TASK_STALE_INPROGRESS_DAYS}d) — likely stale.`;
      } else if (t.status === 'pending' && ageDays > TASK_STALE_PENDING_DAYS) {
        decision = 'proposed_close';
        reason = `Pending for ${Math.round(ageDays)}d (>${TASK_STALE_PENDING_DAYS}d) — never started, likely stale.`;
      } else if (dupOf) {
        decision = 'proposed_close';
        reason = `Duplicate description matches \`${dupOf}\`.`;
        evidence.push(`duplicate_of=${dupOf}`);
      }
      if (!dupOf) seenDescriptions.set(dupKey, id);
    }

    reports.push({
      id, kind: 'task',
      title: t.description.slice(0, 80),
      decision, reason, evidence, snapshot: snap, reviewedAt,
      payload: {
        status: t.status,
        priority: t.priority,
        complexity: t.complexity,
        assignedAgent: t.assignedAgent,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
      },
    });
  }

  return reports;
}

function reviewWorktrees(): SweeperReport[] {
  const wts = listWorktrees();
  const reports: SweeperReport[] = [];
  const reviewedAt = nowIso();

  for (const wt of wts) {
    if (wt.isMain) continue;
    const id = `wt-${wt.name}`;
    const snap = snapshotHash(['wt', wt.name, wt.branch, wt.head, wt.dirty ? '1' : '0', wt.lastCommitTs]);
    const ageDays = daysSince(wt.lastCommitTs);
    const merged = wt.branch ? isMergedToMain(wt.branch) : false;
    const branchPresent = wt.branch ? branchExists(wt.branch) : false;
    const evidence: string[] = [
      `path=${wt.path}`,
      `branch=${wt.branch || '<detached>'}`,
      `head=${wt.head.slice(0, 8)}`,
      wt.dirty ? `dirty=YES` : `dirty=no`,
      `last_commit=${wt.lastCommitTs ? Math.round(ageDays) + 'd ago' : 'unknown'}`,
      `merged_to_main=${merged ? 'yes' : 'no'}`,
      `branch_exists=${branchPresent ? 'yes' : 'no'}`,
    ];

    let decision: 'keep_open' | 'proposed_close' = 'keep_open';
    let reason = 'Active worktree — recent or dirty.';

    if (isPinned(id)) {
      reason = 'Pinned — explicitly excluded from auto-removal.';
    } else if (wt.dirty) {
      reason = 'Dirty — has uncommitted changes. Will not auto-remove.';
    } else if (ageDays < WT_STALE_DAYS) {
      reason = `Recent — last commit ${Math.round(ageDays)}d ago (<${WT_STALE_DAYS}d).`;
    } else {
      decision = 'proposed_close';
      const reasons = [`stale ${Math.round(ageDays)}d`, 'clean'];
      if (merged) reasons.push('branch merged to main');
      reason = `Eligible for removal: ${reasons.join(', ')}.`;
    }

    reports.push({
      id, kind: 'wt',
      title: wt.name,
      decision, reason, evidence, snapshot: snap, reviewedAt,
      payload: {
        path: wt.path, branch: wt.branch, head: wt.head,
        dirty: wt.dirty, lastCommitTs: wt.lastCommitTs,
        merged, branchExists: branchPresent,
      },
    });
  }

  return reports;
}

function reconcileExisting(currentIds: Set<string>): { archived: number } {
  const open = listReports(ITEMS_DIR);
  let archived = 0;
  for (const r of open) {
    if (!currentIds.has(r.id)) {
      archiveReport(r.id);
      archived++;
    }
  }
  return { archived };
}

async function main() {
  initDatabase();
  ensureDirs();
  const reports = [...reviewTasks(), ...reviewWorktrees()];
  const ids = new Set(reports.map(r => r.id));

  for (const r of reports) writeReport(r);
  const { archived } = reconcileExisting(ids);

  const proposed = reports.filter(r => r.decision === 'proposed_close');
  const tasks = reports.filter(r => r.kind === 'task');
  const wts = reports.filter(r => r.kind === 'wt');
  const proposedTasks = proposed.filter(r => r.kind === 'task');
  const proposedWts = proposed.filter(r => r.kind === 'wt');

  console.log(`Sweeper review complete @ ${nowIso()}`);
  console.log(`  Tasks reviewed:     ${tasks.length} (${proposedTasks.length} proposed_close)`);
  console.log(`  Worktrees reviewed: ${wts.length} (${proposedWts.length} proposed_close)`);
  console.log(`  Reports archived (item gone from source): ${archived}`);
  console.log(`  Reports dir: ${ITEMS_DIR}`);
  if (proposed.length) {
    console.log(`\nProposed closures (review then run \`npm run sweeper:apply\`):`);
    for (const r of proposed.slice(0, 20)) {
      console.log(`  - ${r.id}: ${r.reason}`);
    }
    if (proposed.length > 20) console.log(`  ... and ${proposed.length - 20} more.`);
  }
}

main().catch(err => {
  console.error('sweeper:review failed:', err);
  process.exit(1);
});
