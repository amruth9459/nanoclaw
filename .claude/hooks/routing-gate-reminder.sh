#!/bin/bash
# SessionStart hook — date-gated reminder to run the routing-gate verification.
# Local replacement for a /schedule cloud routine (the gate reads LOCAL ledgers +
# transcripts a cloud agent can't see). See project_opus_quota_routing.md.
#
# Fires on/after DUE date, on every session start, until the sentinel exists.
# After the gate is run + reported, the agent is told to `touch` the sentinel so
# this goes quiet. Plain stdout on exit 0 is prepended to session context.
set -u

DUE="2026-07-05"
SENTINEL="$HOME/.claude-ledger/.routing_gate_done"
TODAY="${GATE_TODAY_OVERRIDE:-$(date +%Y-%m-%d)}"

# not due yet, or already handled -> silent
[ -f "$SENTINEL" ] && exit 0
[[ "$TODAY" < "$DUE" ]] && exit 0

cat <<'EOF'
## [scheduled check due] routing-gate-check (was set for 2026-07-05)
The `codex-build-router` hook has now been live ~2 weeks. Run the verification gate and report to the user:
  bash ~/.claude-ledger/routing_gate.sh
Interpret the deltas vs the 2026-06-21 baseline (context: memory `project_opus_quota_routing.md`):
- WORKING -> Codex sessions/output up clearly AND Opus bash+edit share down / already_delegating up. Keep the hook; suggest re-checking monthly.
- NOT MOVING -> Codex flat AND bash+edit still ~28%. The nudge isn't enough: recommend escalating to a more assertive/blocking nudge, OR adding capacity (2nd account / the `claudex` API overflow valve).
After reporting to the user, run `touch ~/.claude-ledger/.routing_gate_done` so this reminder stops firing.
EOF
exit 0
