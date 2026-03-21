#!/bin/bash
# Auto-refresh Claude Code OAuth token
# Runs via launchd every 6 hours (tokens expire after 8)
# Updates .env and Keychain so both NanoClaw and Claude Code stay authenticated

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$NANOCLAW_DIR/.env"
LOG_FILE="$NANOCLAW_DIR/logs/oauth-refresh.log"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
TOKEN_ENDPOINT="https://platform.claude.com/v1/oauth/token"
KEYCHAIN_SERVICE="Claude Code-credentials"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Get current refresh token from Keychain
CREDS=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null) || {
  log "ERROR: Cannot read Keychain credentials"
  exit 1
}

REFRESH_TOKEN=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['refreshToken'])")

if [ -z "$REFRESH_TOKEN" ]; then
  log "ERROR: No refresh token in Keychain"
  exit 1
fi

# Refresh the token (with retry on rate limit)
MAX_RETRIES=4
RETRY_DELAY=60
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
subprocess.run(['security', 'delete-generic-password', '-s', '$KEYCHAIN_SERVICE'],
               capture_output=True)
subprocess.run(['security', 'add-generic-password', '-s', '$KEYCHAIN_SERVICE',
                '-a', '', '-w', new_creds, '-U'],
               check=True)
" 2>/dev/null && log "Updated Keychain" || log "WARNING: Keychain update failed (non-fatal)"

log "Refresh complete: ${NEW_ACCESS:0:30}... expires_in=${EXPIRES_IN}s"
