#!/bin/bash
# SessionStart hook — auto-injects ~1K token briefing into every new session
# Sources: .current-task.json, handoffs, MEMORY.md, git state, KANBAN.md
# Output: JSON with additionalContext field
set -euo pipefail

NANOCLAW_DIR="${HOME}/nanoclaw"

# ── Gather context pieces ──────────────────────────────────────────────────

briefing_parts=()

# 1. Current task from .current-task.json
TASK_FILE="${NANOCLAW_DIR}/.current-task.json"
if [ -f "$TASK_FILE" ]; then
  task_summary=$(/usr/bin/jq -r '
    "CURRENT TASK: " + (.task // "none") +
    (if .context then "\nContext: " + .context else "" end) +
    (if .next_steps then "\nNext steps: " + (.next_steps | if type == "array" then join(", ") else . end) else "" end) +
    (if .blockers then "\nBlockers: " + (.blockers | if type == "array" then join(", ") else . end) else "" end) +
    (if .git_branch then "\nBranch: " + .git_branch else "" end)
  ' "$TASK_FILE" 2>/dev/null || echo "")
  [ -n "$task_summary" ] && briefing_parts+=("$task_summary")
fi

# 2. Latest handoff note (first 20 lines)
HANDOFF_DIR="${NANOCLAW_DIR}/groups/main/handoffs"
if [ -d "$HANDOFF_DIR" ]; then
  latest_handoff=$(find "$HANDOFF_DIR" -maxdepth 1 -name "*.md" -print0 2>/dev/null | xargs -0 ls -1t 2>/dev/null | head -1 || true)
  if [ -n "$latest_handoff" ]; then
    handoff_content=$(head -20 "$latest_handoff" 2>/dev/null || echo "")
    if [ -n "$handoff_content" ]; then
      briefing_parts+=("LAST HANDOFF ($(basename "$latest_handoff")):"$'\n'"$handoff_content")
    fi
  fi
fi

# 3. Active Projects from MEMORY.md (first 10 lines per project, max 30 lines total)
MEMORY_FILE="${NANOCLAW_DIR}/groups/main/MEMORY.md"
if [ -f "$MEMORY_FILE" ]; then
  active_projects=$(python3 -c "
import re, sys
content = open(sys.argv[1]).read()
match = re.search(r'## Active Projects.*?\n(.*?)(?=\n## )', content, re.DOTALL)
if match:
    lines = match.group(1).strip().split('\n')[:30]
    print('\n'.join(lines))
" "$MEMORY_FILE" 2>/dev/null || echo "")
  [ -n "$active_projects" ] && briefing_parts+=("ACTIVE PROJECTS:"$'\n'"$active_projects")

  # Also grab blockers section
  blockers=$(python3 -c "
import re, sys
content = open(sys.argv[1]).read()
match = re.search(r'## Blockers\n(.*?)(?=\n## )', content, re.DOTALL)
if match:
    text = match.group(1).strip()
    if text:
        print(text)
" "$MEMORY_FILE" 2>/dev/null || echo "")
  [ -n "$blockers" ] && briefing_parts+=("BLOCKERS:"$'\n'"$blockers")
fi

# 4. Git state
GIT_LOG=$(git -C "$NANOCLAW_DIR" log --oneline -3 2>/dev/null || echo "no recent commits")
GIT_DIRTY=$(git -C "$NANOCLAW_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ' || echo "0")
GIT_BRANCH=$(git -C "$NANOCLAW_DIR" branch --show-current 2>/dev/null || echo "unknown")
briefing_parts+=("REPO STATE: branch=$GIT_BRANCH, ${GIT_DIRTY} uncommitted changes"$'\n'"Recent commits: $GIT_LOG")

# 5. Kanban task counts from header
KANBAN_FILE="${NANOCLAW_DIR}/groups/main/KANBAN.md"
if [ -f "$KANBAN_FILE" ]; then
  kanban_counts=$(head -10 "$KANBAN_FILE" | grep -oE '\([0-9]+ todo, [0-9]+ active, [0-9]+ done\)' | head -2 || true)
  [ -n "$kanban_counts" ] && briefing_parts+=("KANBAN: $kanban_counts")
fi

# ── Assemble briefing ──────────────────────────────────────────────────────

briefing=""
for part in "${briefing_parts[@]}"; do
  briefing+="$part"$'\n\n'
done

# Trim to ~1K tokens (~4K chars)
briefing="${briefing:0:4000}"

# ── Output JSON with additionalContext ─────────────────────────────────────

# Use jq -Rs to safely escape the briefing text into a JSON string
echo "$briefing" | /usr/bin/jq -Rs '{additionalContext: ("SESSION BRIEFING (auto-injected by SessionStart hook):\n\n" + .)}'
