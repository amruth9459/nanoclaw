# Sweeper

Conservative housekeeping bot for NanoClaw. Modeled on
[openclaw/clawsweeper](https://github.com/openclaw/clawsweeper).

Two-lane design:

| Lane | What it does | Mutates? |
|------|--------------|----------|
| **Review** (`npm run sweeper:review`) | Scans `tasks` table + git worktrees, writes one markdown report per item with decision + snapshot hash. | Never. |
| **Apply** (`npm run sweeper:apply`) | Re-validates each `proposed_close` report against current state (snapshot hash match). Only acts if unchanged. | Default dry-run. `--apply` to mutate. v1: worktrees only. |
| **Audit** (`npm run sweeper:audit`) | Compares live state vs reports. Flags missing/orphan/stale/reopened. | Never. Exit 1 on drift. |

## What it covers in v1

- **Tasks** (`store/messages.db` `tasks` table): writes informational reports.
  - `proposed_close` if completed >7d ago, cancelled, in_progress >30d, pending >60d, or duplicate description.
  - **No table mutation in v1** — close via DashClaw / `task_tool`; reports auto-archive next review.
- **Worktrees** (`.claude/worktrees/*`): proposes removal if clean AND last commit >7d ago.
  - Apply runs `git worktree remove`. Optionally `git branch -d` if `--delete-branches` and branch merged to main.
  - Refuses to touch dirty worktrees.

## Safety primitives (from ClawSweeper)

1. **Snapshot hash per report** — apply re-computes and refuses to mutate on drift.
2. **Default dry-run** — `--apply` flag required for mutation.
3. **Pinned exclusions** — touch `.claude/sweeper/pinned/<id>` to forbid auto-close.
4. **Dirty-worktree refusal** — never auto-remove a worktree with uncommitted changes.
5. **Reports survive in git** — `.claude/sweeper/{items,closed,pinned}/` are tracked.

## Layout

```
.claude/sweeper/
├── items/      # active reports (one per open item)
├── closed/     # archived reports
└── pinned/     # touch <id> here to exclude from auto-close
```

Item id scheme: `task-<task-id>`, `wt-<worktree-name>`.

## Common usage

```bash
npm run sweeper:review                                          # generate reports
npm run sweeper:audit                                           # check drift
npm run sweeper:apply                                           # DRY-RUN of worktree removals
npm run sweeper:apply -- --apply --scope worktrees              # actually remove clean stale worktrees
npm run sweeper:apply -- --apply --scope worktrees --delete-branches --limit 10
touch .claude/sweeper/pinned/wt-eloquent-vaughan                # never auto-remove this worktree
```

## Calibration vs ClawSweeper

ClawSweeper handles ~7,300 GitHub items with 5 cadence tiers. NanoClaw has dozens
of tasks and ~50 worktrees, so this is a 2-tier system: run review hourly via cron
or on-demand. No sharding, no Codex, no token-isolation across jobs (we run locally
with file-system writes only). Same safety model.

## What's NOT here yet

- Task table mutation (kept manual to avoid fighting DashClaw / Claw writers).
- Cron/launchd integration.
- Web dashboard rendering of reports.
- Multi-repo target scanning.

These are deliberate omissions for v1. Add when usage justifies them.
