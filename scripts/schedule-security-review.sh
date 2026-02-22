#!/usr/bin/env bash
# Schedule the nightly security review task in NanoClaw's SQLite database.
#
# Run once after NanoClaw has started at least once (so the DB exists).
# The task will run every night at 2 AM in the main group's context.
#
# Usage:
#   ./scripts/schedule-security-review.sh
#   ./scripts/schedule-security-review.sh --jid "120363XXXXXX@g.us"  # specify main group JID

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_PATH="${PROJECT_DIR}/store/messages.db"

# ── Validate DB exists ─────────────────────────────────────────────────────────
if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: Database not found at $DB_PATH"
  echo "       Start NanoClaw at least once first, then re-run this script."
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "ERROR: sqlite3 not found. Install with: brew install sqlite"
  exit 1
fi

# ── Resolve main group JID ─────────────────────────────────────────────────────
MAIN_JID=""
if [[ "${1:-}" == "--jid" && -n "${2:-}" ]]; then
  MAIN_JID="$2"
else
  # Auto-detect from registered_groups (the group whose folder is 'main')
  REG_FILE="${PROJECT_DIR}/data/registered_groups.json"
  if [[ -f "$REG_FILE" ]]; then
    MAIN_JID=$(node -e "
      const g = JSON.parse(require('fs').readFileSync('$REG_FILE','utf8'));
      const entry = Object.entries(g).find(([,v]) => v.folder === 'main');
      if (entry) console.log(entry[0]);
    " 2>/dev/null || true)
  fi
fi

if [[ -z "$MAIN_JID" ]]; then
  echo "ERROR: Could not determine main group JID."
  echo "       Pass it explicitly: $0 --jid \"120363XXXXXX@g.us\""
  echo "       Or register the main group via WhatsApp first."
  exit 1
fi

echo "Main group JID: $MAIN_JID"

# ── Check for existing security review task ────────────────────────────────────
EXISTING=$(sqlite3 "$DB_PATH" \
  "SELECT id FROM scheduled_tasks WHERE group_folder='main' AND prompt LIKE '%Nightly Security Report%' AND status='active' LIMIT 1;" 2>/dev/null || true)

if [[ -n "$EXISTING" ]]; then
  echo "Security review task already scheduled (id: $EXISTING). Nothing to do."
  echo "To reschedule: sqlite3 \"$DB_PATH\" \"DELETE FROM scheduled_tasks WHERE id='$EXISTING';\""
  exit 0
fi

# ── Build the task prompt ──────────────────────────────────────────────────────
# Inline the full prompt so the task is self-contained (isolated context mode).
TASK_ID="security-review-$(date +%s)"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Next 2 AM local time (for cron we use the cron expression)
CRON_VALUE="0 2 * * *"

read -r -d '' PROMPT << 'PROMPT_EOF' || true
[SCHEDULED SECURITY REVIEW]

You are the nightly security agent for NanoClaw. Run the /security-review skill now.

If the skill is not available, perform the review manually:

1. Check git log for files changed in the last 24 hours:
   git -C /workspace/project log --since="24 hours ago" --oneline --name-only

2. Scan for hardcoded secrets:
   grep -rn "sk-ant-\|password\s*=\s*['\"]" /workspace/project/src/ /workspace/project/container/ --include="*.ts" 2>/dev/null | grep -v node_modules

3. Check security block logs:
   grep -rn "SECURITY BLOCK\|HITL: approval\|Unauthorized IPC" /workspace/project/groups/*/logs/ 2>/dev/null | tail -20

4. Run npm audit:
   cd /workspace/project && npm audit 2>/dev/null | tail -5

5. Verify the HITL gate is intact:
   grep -n "requestApproval\|tryHandleApproval" /workspace/project/src/hitl.ts | wc -l

Send a single WhatsApp report using this format (WhatsApp formatting, no markdown headings):

🛡️ *Nightly Security Report* — {today's date}

*Changes (24h):* {N files}
*Secrets scan:* Clean / {hits}
*Security blocks fired:* {N}
*npm audit:* Clean / {severity}
*HITL gate:* OK / {issue}

*Findings:*
• {finding or "None"}

_Next review: tomorrow 2 AM_

Use 🚨 instead of 🛡️ if any finding is HIGH severity.
PROMPT_EOF

# ── Insert task into SQLite (parameterized to handle special chars in prompt) ──
_PROMPT_FILE=$(mktemp)
printf '%s' "$PROMPT" > "$_PROMPT_FILE"
python3 - "$DB_PATH" "$TASK_ID" "$MAIN_JID" "$CRON_VALUE" "$NOW" "$_PROMPT_FILE" <<'PYEOF'
import sys, sqlite3
db_path, task_id, jid, cron, now, prompt_file = sys.argv[1:]
prompt = open(prompt_file).read()
conn = sqlite3.connect(db_path)
conn.execute("""
  INSERT INTO scheduled_tasks
    (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
     next_run, last_run, last_result, status, created_at)
  VALUES
    (?, 'main', ?, ?, 'cron', ?,
     datetime('now','start of day','+1 day','+2 hours'), NULL, NULL, 'active', ?)
""", (task_id, jid, prompt, cron, now))
conn.commit(); conn.close()
PYEOF
rm -f "$_PROMPT_FILE"

echo ""
echo "✅ Nightly security review scheduled"
echo "   Task ID:  $TASK_ID"
echo "   Schedule: every night at 2 AM (cron: $CRON_VALUE)"
echo "   Group:    main ($MAIN_JID)"
echo ""
echo "Verify with:"
echo "  sqlite3 \"$DB_PATH\" \"SELECT id, schedule_value, next_run, status FROM scheduled_tasks WHERE group_folder='main';\""
