#!/usr/bin/env tsx
/**
 * Sweeper Apply Lane — mutates only when stored snapshot still matches.
 *
 * Default: dry-run.
 * Mutate worktrees: --apply --scope worktrees   (or --scope all)
 * Mutate tasks:     not yet supported in v1 — reports are informational.
 *                   Close tasks via DashClaw or task_tool; the next review
 *                   pass will archive the stale report automatically.
 */
import { join } from 'node:path';
import {
  ITEMS_DIR, archiveReport, branchExists, deleteBranch, ensureDirs,
  isMergedToMain, isPinned, listReports, listWorktrees, removeWorktree,
  snapshotHash, type SweeperReport,
} from './lib.js';

interface Args {
  apply: boolean;
  scope: 'worktrees' | 'tasks' | 'all';
  limit: number;
  deleteBranches: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const deleteBranches = argv.includes('--delete-branches');
  const scopeIdx = argv.indexOf('--scope');
  const scope = (scopeIdx >= 0 ? argv[scopeIdx + 1] : 'worktrees') as Args['scope'];
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 50;
  if (!['worktrees', 'tasks', 'all'].includes(scope)) {
    console.error(`invalid --scope: ${scope}`);
    process.exit(2);
  }
  return { apply, scope, limit, deleteBranches };
}

function currentWtSnapshot(name: string): string | null {
  const wt = listWorktrees().find(w => w.name === name);
  if (!wt) return null;
  return snapshotHash(['wt', wt.name, wt.branch, wt.head, wt.dirty ? '1' : '0', wt.lastCommitTs]);
}

function applyWorktreeReport(r: SweeperReport, args: Args): { ok: boolean; reason: string } {
  if (isPinned(r.id)) return { ok: false, reason: 'pinned (skip)' };
  const name = r.id.replace(/^wt-/, '');
  const live = listWorktrees().find(w => w.name === name);
  if (!live) {
    archiveReport(r.id);
    return { ok: true, reason: 'worktree already gone — report archived' };
  }
  const liveSnap = currentWtSnapshot(name);
  if (liveSnap !== r.snapshot) {
    return { ok: false, reason: `snapshot drift (report=${r.snapshot} live=${liveSnap}) — re-run review` };
  }
  if (live.dirty) return { ok: false, reason: 'dirty — refuse to remove' };

  if (!args.apply) return { ok: true, reason: 'DRY-RUN: would remove worktree' };

  removeWorktree(live.path);
  let branchNote = '';
  if (args.deleteBranches && live.branch && branchExists(live.branch)) {
    if (isMergedToMain(live.branch)) {
      try { deleteBranch(live.branch, false); branchNote = `; branch ${live.branch} deleted (merged)`; }
      catch (e) { branchNote = `; branch delete failed: ${(e as Error).message}`; }
    } else {
      branchNote = `; branch ${live.branch} kept (unmerged)`;
    }
  }
  archiveReport(r.id);
  return { ok: true, reason: `removed worktree ${live.path}${branchNote}` };
}

async function main() {
  ensureDirs();
  const args = parseArgs();
  const reports = listReports(ITEMS_DIR).filter(r => r.decision === 'proposed_close');

  if (!args.apply) {
    console.log('=== DRY RUN === (pass --apply to mutate)\n');
  }

  let processed = 0;
  let mutated = 0;
  let skipped = 0;

  if (args.scope === 'worktrees' || args.scope === 'all') {
    const wtReports = reports.filter(r => r.kind === 'wt');
    console.log(`[worktrees] ${wtReports.length} proposed_close report(s) to evaluate`);
    for (const r of wtReports) {
      if (processed >= args.limit) {
        console.log(`  -- limit reached (${args.limit}) --`);
        break;
      }
      const result = applyWorktreeReport(r, args);
      processed++;
      if (result.ok) {
        if (args.apply) mutated++;
        console.log(`  OK  ${r.id}: ${result.reason}`);
      } else {
        skipped++;
        console.log(`  SKIP ${r.id}: ${result.reason}`);
      }
    }
  }

  if (args.scope === 'tasks' || args.scope === 'all') {
    const taskReports = reports.filter(r => r.kind === 'task');
    console.log(`\n[tasks] ${taskReports.length} proposed_close report(s) — informational only in v1.`);
    console.log('       Close tasks via DashClaw / task_tool; reports auto-archive on next review.');
  }

  console.log(`\nDone. processed=${processed} mutated=${mutated} skipped=${skipped}`);
  if (!args.apply && processed > 0) {
    console.log('Re-run with: npm run sweeper:apply -- --apply --scope worktrees [--delete-branches] [--limit N]');
  }
}

main().catch(err => {
  console.error('sweeper:apply failed:', err);
  process.exit(1);
});
