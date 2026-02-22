#!/usr/bin/env bash
# Schedule the nightly self-audit task in NanoClaw's SQLite database.
# Runs every night at 3 AM (after the 2 AM security review).
#
# Usage: ./scripts/schedule-self-audit.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DB_PATH="${PROJECT_DIR}/store/messages.db"

if [[ ! -f "$DB_PATH" ]]; then
  echo "ERROR: Database not found. Start NanoClaw at least once first."
  exit 1
fi

# Resolve main group JID
MAIN_JID=""
REG_FILE="${PROJECT_DIR}/data/registered_groups.json"
if [[ -f "$REG_FILE" ]]; then
  MAIN_JID=$(node -e "
    const g = JSON.parse(require('fs').readFileSync('$REG_FILE','utf8'));
    const entry = Object.entries(g).find(([,v]) => v.folder === 'main');
    if (entry) console.log(entry[0]);
  " 2>/dev/null || true)
fi

# Fall back to registered_groups SQLite table
if [[ -z "$MAIN_JID" ]]; then
  MAIN_JID=$(sqlite3 "$DB_PATH" \
    "SELECT jid FROM registered_groups WHERE folder='main' LIMIT 1;" 2>/dev/null || true)
fi

if [[ -z "$MAIN_JID" ]]; then
  echo "ERROR: Could not find main group JID. Register main channel first."
  exit 1
fi

EXISTING=$(sqlite3 "$DB_PATH" \
  "SELECT id FROM scheduled_tasks WHERE group_folder='main' AND prompt LIKE '%Safety Brief%' AND status='active' LIMIT 1;" 2>/dev/null || true)

if [[ -n "$EXISTING" ]]; then
  echo "Self-audit already scheduled (id: $EXISTING)."
  exit 0
fi

TASK_ID="self-audit-$(date +%s)"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

read -r -d '' PROMPT << 'EOF'
[SCHEDULED SELF-AUDIT]

Run the /self-audit skill now to perform the nightly operational health check.

If the skill is unavailable, perform this minimal audit:

1. Service health: launchctl list | grep nanoclaw
2. Recent errors: grep -c '"level":50' /workspace/project/logs/nanoclaw.log 2>/dev/null || echo 0
3. Container runs (24h): grep -c "Spawning container" /workspace/project/logs/nanoclaw.log 2>/dev/null || echo 0
4. HITL events: grep -c "HITL:" /workspace/project/logs/nanoclaw.log 2>/dev/null || echo 0
5. Task failures: node -e "const db=require('better-sqlite3')('/workspace/project/store/messages.db');const f=db.prepare('SELECT count(*) as n FROM task_run_logs WHERE status=\"error\" AND run_at>datetime(\"now\",\"-24 hours\")').get();console.log('Failed:',f.n);db.close();" 2>/dev/null

Send a Safety Brief to WhatsApp:

🔍 *Safety Brief* — {date}

*Service:* {status}
*Containers (24h):* {N} runs, {N} errors
*HITL events:* {N}
*Task failures:* {N}

*Issues:* {list or "None — all systems nominal"}

_Next audit: tomorrow 3 AM_
EOF

sqlite3 "$DB_PATH" <<SQL
INSERT INTO scheduled_tasks (
  id, group_folder, chat_jid, prompt,
  schedule_type, schedule_value,
  next_run, last_run, last_result,
  status, created_at
) VALUES (
  '${TASK_ID}', 'main', '${MAIN_JID}',
  '${PROMPT//\'/\'\'}',
  'cron', '0 3 * * *',
  datetime('now', 'start of day', '+1 day', '+3 hours'),
  NULL, NULL, 'active', '${NOW}'
);
SQL

echo "✅ Nightly self-audit scheduled at 3 AM (task: $TASK_ID)"
