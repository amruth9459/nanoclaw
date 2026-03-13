#!/bin/bash
# Wrapper to launch claude -p in a clean environment
# Logs initialization to help debug hangs
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT

# Log start to help debug
echo "[desktop-claude] Starting at $(date), PID $$" >> /tmp/desktop-claude-debug.log

exec /opt/homebrew/bin/claude "$@"
