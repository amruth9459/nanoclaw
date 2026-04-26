#!/bin/zsh
# Daily Brain pipeline — 8 stages:
#   1. shared-items-sync.py   — pull shared_items DB rows → Brain/Inbox/shared/
#   2. brain-sync.py          — mirror Claw shared memory into Brain vault
#   3. compile_brain_wiki.py  — entity/relationship/graph compile (LLM Wiki v2)
#   4. brain-disambiguate.py  — Sonnet alias merging → knowledge_graph.canonical.json
#   5. brain-deeplink.py      — multi-hop graph chains → data/brain-deeplinks.json
#   6. brain-research.py      — fetch top URLs + sub-page link-following + Sonnet
#   7. brain-themes.py        — Opus synthesis across clusters → Brain/Inbox/themes/
#   8. brain-digest.py        — render daily + notifications
#
# Triggered by ~/Library/LaunchAgents/com.nanoclaw.brain-pipeline.plist (daily 7am).
# Each step's failure is logged but doesn't block subsequent steps — partial
# results are better than silent silence.
set -u
cd /Users/amrut/nanoclaw

LOG=/Users/amrut/nanoclaw/data/brain-pipeline.log
mkdir -p "$(dirname "$LOG")"
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

run() {
  local step="$1" script="$2"
  echo "[$(ts)] step $step: $script"
  /usr/bin/env python3 "/Users/amrut/nanoclaw/scripts/$script"
  echo "[$(ts)] step $step exit=$?"
}

{
  echo "[$(ts)] === pipeline start ==="
  run "1/8" "shared-items-sync.py"
  run "2/8" "brain-sync.py"
  run "3/8" "compile_brain_wiki.py"
  run "4/8" "brain-disambiguate.py"
  run "5/8" "brain-deeplink.py"
  run "6/8" "brain-research.py"
  run "7/8" "brain-themes.py"
  run "8/8" "brain-digest.py"
  echo "[$(ts)] === pipeline done ==="
} >> "$LOG" 2>&1
