#!/bin/bash
# Keep Claude Code OAuth token alive by periodically triggering auth validation.
# `claude auth status` checks the token and refreshes it if expiring.
# Runs via launchd every 4 hours (tokens expire after 8).

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$NANOCLAW_DIR/.env"
LOG_FILE="$NANOCLAW_DIR/logs/oauth-refresh.log"
KEYCHAIN_SERVICE="Claude Code-credentials"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/v20.18.3/bin:$PATH"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Check current Keychain token expiry
HOURS_LEFT=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "amrut" -w 2>/dev/null | \
  python3 -c "import sys,json,time; d=json.load(sys.stdin); print(f'{(d[\"claudeAiOauth\"][\"expiresAt\"]/1000 - time.time()) / 3600:.1f}')" 2>/dev/null) || HOURS_LEFT="unknown"

if python3 -c "exit(0 if float('$HOURS_LEFT') > 5 else 1)" 2>/dev/null; then
  # Token still fresh — just sync to .env
  KEYCHAIN_TOKEN=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "amrut" -w 2>/dev/null | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])")
  CURRENT_ENV_TOKEN=$(grep 'CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
  if [ "$KEYCHAIN_TOKEN" != "$CURRENT_ENV_TOKEN" ]; then
    sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${KEYCHAIN_TOKEN}|" "$ENV_FILE"
    log "Keepalive: synced fresh Keychain token to .env (${HOURS_LEFT}h remaining)"
  else
    log "Keepalive: token fresh (${HOURS_LEFT}h remaining), already synced"
  fi
  exit 0
fi

log "Keepalive: token expiring soon (${HOURS_LEFT}h left) — triggering Claude Code refresh"

# A minimal API call forces Claude Code's internal auth to refresh the token.
# `claude auth status` only reads state; an actual API call triggers the refresh flow.
# This uses ~10 tokens total — negligible cost.
claude -p "ok" --max-turns 1 --no-session-persistence > /dev/null 2>&1 || true

# Small delay for Keychain write to propagate
sleep 3

# Re-read and sync
NEW_HOURS_LEFT=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "amrut" -w 2>/dev/null | \
  python3 -c "import sys,json,time; d=json.load(sys.stdin); print(f'{(d[\"claudeAiOauth\"][\"expiresAt\"]/1000 - time.time()) / 3600:.1f}')" 2>/dev/null) || NEW_HOURS_LEFT="unknown"

KEYCHAIN_TOKEN=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "amrut" -w 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null) || {
  log "Keepalive: ERROR — cannot read Keychain after auth status"
  exit 1
}

sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${KEYCHAIN_TOKEN}|" "$ENV_FILE"
log "Keepalive: refreshed via claude auth status (${HOURS_LEFT}h → ${NEW_HOURS_LEFT}h remaining)"
