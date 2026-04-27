#!/usr/bin/env tsx
/**
 * Sweeper Audit Lane — drift detection, no mutation.
 * Compares current state to reports under items/ and closed/.
 * Exit code != 0 if drift severity is "action_needed".
 */
import { ITEMS_DIR, CLOSED_DIR, ensureDirs, listReports, listWorktrees, snapshotHash } from './lib.js';
import { initDatabase, getTaskRecords } from '../../src/db.js';

interface DriftRow {
  id: string;
  category: string;
  detail: string;
}

async function main() {
  initDatabase();
  ensureDirs();

  const items = listReports(ITEMS_DIR);
  const closed = listReports(CLOSED_DIR);
  const itemsById = new Map(items.map(r => [r.id, r]));
  const closedById = new Map(closed.map(r => [r.id, r]));

  const tasks = getTaskRecords();
  const wts = listWorktrees().filter(w => !w.isMain);

  const drift: DriftRow[] = [];
  const currentTaskIds = new Set(tasks.map(t => `task-${t.id}`));
  const currentWtIds = new Set(wts.map(w => `wt-${w.name}`));

  // Missing reports — current items without an open record
  let missingTask = 0;
  let missingWt = 0;
  for (const t of tasks) {
    const id = `task-${t.id}`;
    if (!itemsById.has(id) && !closedById.has(id)) {
      missingTask++;
      drift.push({ id, category: 'missing_open_record', detail: `task ${t.id} (status=${t.status}) has no report` });
    }
  }
  for (const wt of wts) {
    const id = `wt-${wt.name}`;
    if (!itemsById.has(id) && !closedById.has(id)) {
      missingWt++;
      drift.push({ id, category: 'missing_open_record', detail: `worktree ${wt.name} has no report` });
    }
  }

  // Orphan open records — report exists but item is gone
  let orphans = 0;
  for (const r of items) {
    const stillExists = r.kind === 'task' ? currentTaskIds.has(r.id) : currentWtIds.has(r.id);
    if (!stillExists) {
      orphans++;
      drift.push({ id: r.id, category: 'orphan_open_record', detail: 'item gone but report still in items/' });
    }
  }

  // Stale reports — snapshot drifted
  let stale = 0;
  for (const r of items) {
    let liveSnap: string | null = null;
    if (r.kind === 'task') {
      const t = tasks.find(x => `task-${x.id}` === r.id);
      if (t) liveSnap = snapshotHash(['task', t.id, t.status, t.completedAt ?? 0, t.assignedAgent ?? '', t.description]);
    } else {
      const w = wts.find(x => `wt-${x.name}` === r.id);
      if (w) liveSnap = snapshotHash(['wt', w.name, w.branch, w.head, w.dirty ? '1' : '0', w.lastCommitTs]);
    }
    if (liveSnap && liveSnap !== r.snapshot) {
      stale++;
      drift.push({ id: r.id, category: 'stale_snapshot', detail: `report=${r.snapshot} live=${liveSnap}` });
    }
  }

  // Reopened — closed report but item is back
  let reopened = 0;
  for (const r of closed) {
    const back = r.kind === 'task' ? currentTaskIds.has(r.id) : currentWtIds.has(r.id);
    if (back) {
      reopened++;
      drift.push({ id: r.id, category: 'reopened', detail: 'item exists again — should be moved back to items/' });
    }
  }

  console.log('=== Sweeper Audit ===');
  console.log(`Open items reviewed:    tasks=${tasks.length} worktrees=${wts.length}`);
  console.log(`Reports (items/):       ${items.length}`);
  console.log(`Reports (closed/):      ${closed.length}`);
  console.log('');
  console.log(`Missing open records:   tasks=${missingTask} worktrees=${missingWt}`);
  console.log(`Orphan open records:    ${orphans}`);
  console.log(`Stale snapshots:        ${stale}`);
  console.log(`Reopened (closed→live): ${reopened}`);

  if (drift.length) {
    console.log('\nDrift detail:');
    for (const d of drift.slice(0, 50)) console.log(`  [${d.category}] ${d.id} — ${d.detail}`);
    if (drift.length > 50) console.log(`  ... ${drift.length - 50} more`);
  }

  const actionNeeded = orphans + stale + reopened;
  if (actionNeeded > 0) {
    console.log(`\nStatus: ACTION NEEDED (${actionNeeded} drift items). Re-run \`npm run sweeper:review\`.`);
    process.exit(1);
  } else {
    console.log('\nStatus: clean.');
  }
}

main().catch(err => {
  console.error('sweeper:audit failed:', err);
  process.exit(1);
});
