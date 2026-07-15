#!/bin/zsh
# Daily Brain pipeline — 10 stages:
#   1. shared-items-sync.py        — pull shared_items DB rows → Brain/Inbox/shared/
#   2. brain-sync.py               — mirror Claw shared memory into Brain vault
#   3. claude-brain-sync.py        — bidirectional Claude Code memory bridge
#                                    (sanitized index → Brain/ClaudeCode/;
#                                    SOUL/KANBAN/decided → Claude memory)
#   4. compile_brain_wiki.py       — entity/relationship/graph compile (LLM Wiki v2)
#   5. brain-disambiguate.py       — Sonnet alias merging → knowledge_graph.canonical.json
#   6. brain-deeplink.py           — multi-hop graph chains → data/brain-deeplinks.json
#   7. brain-research.py           — fetch top URLs + sub-page link-following + Sonnet
#   8. brain-themes.py             — Opus synthesis across clusters → Brain/Inbox/themes/
#   9. brain-digest.py             — render daily + notifications
#  10. brain-link-enrichment.py    — Obsidian wikilink crosslinking + index regeneration
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
  run "1/10" "shared-items-sync.py"
  run "2/10" "brain-sync.py"
  run "3/10" "claude-brain-sync.py"
  run "4/10" "compile_brain_wiki.py"
  run "5/10" "brain-disambiguate.py"
  run "6/10" "brain-deeplink.py"
  run "7/10" "brain-research.py"
  run "8/10" "brain-themes.py"
  run "9/10" "brain-digest.py"
  run "10/10" "brain-link-enrichment.py"
  echo "[$(ts)] === pipeline done ==="
} >> "$LOG" 2>&1
