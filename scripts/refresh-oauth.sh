#!/bin/bash
# Auto-refresh Claude Code OAuth token
# Runs via launchd every 6 hours (tokens expire after 8)
#
# Strategy: Keychain-first. Claude Code desktop refreshes its own token into
# Keychain. We just read that token and sync it to .env. Only hit the API
# if the Keychain token is expired/expiring (<2h remaining).

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$NANOCLAW_DIR/.env"
LOG_FILE="$NANOCLAW_DIR/logs/oauth-refresh.log"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_ENDPOINT="https://platform.claude.com/v1/oauth/token"
KEYCHAIN_SERVICE="Claude Code-credentials"

COOLDOWN_FILE="$NANOCLAW_DIR/logs/.oauth-cooldown"
COOLDOWN_HOURS=6

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Read Keychain credentials
CREDS=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "amrut" -w 2>/dev/null) || \
CREDS=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null) || {
  log "ERROR: Cannot read Keychain credentials"
  exit 1
}

# Check if Keychain token is still fresh (>2h remaining)
KEYCHAIN_TOKEN=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])")
KEYCHAIN_EXPIRY=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth'].get('expiresAt',0))")
HOURS_LEFT=$(python3 -c "import time; print(f'{($KEYCHAIN_EXPIRY/1000 - time.time()) / 3600:.1f}')")
CURRENT_ENV_TOKEN=$(grep 'CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE" | cut -d= -f2-)

# If Keychain has a fresh token that differs from .env, just sync it (no API call)
if python3 -c "import time; exit(0 if ($KEYCHAIN_EXPIRY/1000 - time.time()) > 7200 else 1)" 2>/dev/null; then
  if [ "$KEYCHAIN_TOKEN" != "$CURRENT_ENV_TOKEN" ]; then
    sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${KEYCHAIN_TOKEN}|" "$ENV_FILE"
    log "Synced Keychain token to .env (${HOURS_LEFT}h remaining, no API call)"
  else
    log "Token already in sync (${HOURS_LEFT}h remaining)"
  fi
  rm -f "$COOLDOWN_FILE"
  exit 0
fi

log "Keychain token expiring soon (${HOURS_LEFT}h left) — attempting API refresh"

# Cooldown: skip API call if rate-limited recently
if [ -f "$COOLDOWN_FILE" ]; then
  cooldown_age=$(( ($(date +%s) - $(stat -f %m "$COOLDOWN_FILE" 2>/dev/null || echo 0)) / 3600 ))
  if [ "$cooldown_age" -lt "$COOLDOWN_HOURS" ]; then
    # Even in cooldown, sync whatever Keychain has (it may still work)
    if [ "$KEYCHAIN_TOKEN" != "$CURRENT_ENV_TOKEN" ]; then
      sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${KEYCHAIN_TOKEN}|" "$ENV_FILE"
      log "COOLDOWN: synced Keychain token to .env anyway (${HOURS_LEFT}h remaining)"
    else
      log "SKIP: in cooldown (${cooldown_age}h/${COOLDOWN_HOURS}h), token already synced"
    fi
    exit 0
  fi
  rm -f "$COOLDOWN_FILE"
fi

REFRESH_TOKEN=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['refreshToken'])")

if [ -z "$REFRESH_TOKEN" ]; then
  log "ERROR: No refresh token in Keychain"
  exit 1
fi

# Refresh the token (with retry on rate limit)
MAX_RETRIES=2
RETRY_DELAY=120
for attempt in $(seq 1 $MAX_RETRIES); do
  RESPONSE=$(curl -sL -X POST "$TOKEN_ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"$REFRESH_TOKEN\",\"client_id\":\"$CLIENT_ID\"}" 2>&1)

  if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); exit(0 if 'access_token' in d else 1)" 2>/dev/null; then
    break
  fi

  if echo "$RESPONSE" | grep -q "rate_limit"; then
    if [ "$attempt" -lt "$MAX_RETRIES" ]; then
      log "Rate limited (attempt $attempt/$MAX_RETRIES) — retrying in ${RETRY_DELAY}s"
      sleep "$RETRY_DELAY"
      RETRY_DELAY=$((RETRY_DELAY * 2))
      continue
    fi
    # All retries exhausted — set cooldown to prevent spiral
    touch "$COOLDOWN_FILE"
    log "ERROR: Rate limited after $MAX_RETRIES attempts — cooldown set for ${COOLDOWN_HOURS}h"
    # Still sync Keychain token even on API failure
    if [ "$KEYCHAIN_TOKEN" != "$CURRENT_ENV_TOKEN" ]; then
      sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${KEYCHAIN_TOKEN}|" "$ENV_FILE"
      log "Synced Keychain token to .env as fallback (${HOURS_LEFT}h remaining)"
    fi
    exit 1
  fi

  log "ERROR: Refresh failed (attempt $attempt) — $(echo "$RESPONSE" | head -c 200)"
  exit 1
done

# Parse response
NEW_ACCESS=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])" 2>/dev/null) || {
  log "ERROR: Could not parse access_token from response"
  exit 1
}

NEW_REFRESH=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null)
EXPIRES_IN=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expires_in',28800))" 2>/dev/null)

# Update .env
sed -i '' "s|CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${NEW_ACCESS}|" "$ENV_FILE"
log "Updated .env with new access token (expires in ${EXPIRES_IN}s)"

# Update Keychain with new tokens
EXPIRES_AT=$(python3 -c "import time; print(int((time.time() + ${EXPIRES_IN}) * 1000))")

# Read existing creds, update tokens, write back
python3 -c "
import sys, json, subprocess

creds = json.loads('''$CREDS''')
creds['claudeAiOauth']['accessToken'] = '$NEW_ACCESS'
if '$NEW_REFRESH':
    creds['claudeAiOauth']['refreshToken'] = '$NEW_REFRESH'
creds['claudeAiOauth']['expiresAt'] = $EXPIRES_AT

new_creds = json.dumps(creds)

# Delete old and add new
subprocess.run(['security', 'delete-generic-password', '-s', '$KEYCHAIN_SERVICE', '-a', 'amrut'],
               capture_output=True)
subprocess.run(['security', 'add-generic-password', '-s', '$KEYCHAIN_SERVICE',
                '-a', 'amrut', '-w', new_creds, '-U'],
               check=True)
" 2>/dev/null && log "Updated Keychain" || log "WARNING: Keychain update failed (non-fatal)"

rm -f "$COOLDOWN_FILE"
log "Refresh complete: ${NEW_ACCESS:0:30}... expires_in=${EXPIRES_IN}s"
