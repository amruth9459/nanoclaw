#!/bin/bash
# Claude Code → WhatsApp real-time sync
# Reads hook event JSON from stdin, sends relevant updates to WhatsApp

set -euo pipefail

JID="120363427991119489@g.us"
API="http://localhost:8080/api/send"

INPUT=$(cat)
EVENT=$(echo "$INPUT" | /usr/bin/jq -r '.hook_event_name // empty')

send() {
  curl -s -X POST "$API" \
    -H 'Content-Type: application/json' \
    -d "{\"jid\": \"$JID\", \"message\": \"$1\"}" \
    >/dev/null 2>&1 || true
}

case "$EVENT" in
  Stop)
    # Claude finished responding — send a summary
    # Extract what was done from the stop reason
    REASON=$(echo "$INPUT" | /usr/bin/jq -r '.stop_reason // "completed"')
    send "desktop: Claude Code finished ($REASON)"
    ;;

  Notification)
    # Claude needs attention
    TITLE=$(echo "$INPUT" | /usr/bin/jq -r '.title // "Notification"')
    MSG=$(echo "$INPUT" | /usr/bin/jq -r '.message // empty')
    if [ -n "$MSG" ]; then
      send "desktop: $TITLE — $MSG"
    fi
    ;;

  TaskCompleted)
    TASK=$(echo "$INPUT" | /usr/bin/jq -r '.task_subject // "a task"')
    send "desktop: Completed — $TASK"
    ;;
esac

exit 0
