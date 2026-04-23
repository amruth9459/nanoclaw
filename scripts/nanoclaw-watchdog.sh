#!/bin/bash
# NanoClaw Watchdog - Checks if the Claw Node.js service is running and restarts via launchctl if not.
# Managed by launchd (com.nanoclaw.watchdog) — runs every 5 minutes.

LOG="$HOME/Library/Logs/nanoclaw-watchdog.log"
MAX_LOG_SIZE=2097152  # 2MB
SERVICE_LABEL="com.nanoclaw"
UID_VAL=$(id -u)

rotate_if_needed() {
  if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
    mv "$LOG" "${LOG}.old"
  fi
}

log() {
  rotate_if_needed
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

# Get PID from tabular `launchctl list` output (columns: PID Status Label).
# Returns '-' if registered but not running, empty if not registered at all.
LAUNCHCTL_PID=$(launchctl list 2>/dev/null | awk -v lbl="$SERVICE_LABEL" '$3 == lbl {print $1}')

if [ -z "$LAUNCHCTL_PID" ]; then
  log "WARN: '$SERVICE_LABEL' is not registered with launchd — loading plist"
  launchctl load "$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist" 2>>"$LOG"
  log "INFO: Loaded $SERVICE_LABEL"
  exit 0
fi

if [ "$LAUNCHCTL_PID" = "-" ]; then
  log "WARN: '$SERVICE_LABEL' is registered but not running. Kickstarting..."
  launchctl kickstart -k "gui/${UID_VAL}/${SERVICE_LABEL}" 2>>"$LOG"
  sleep 5
  NEW_PID=$(launchctl list 2>/dev/null | awk -v lbl="$SERVICE_LABEL" '$3 == lbl {print $1}')
  if [ "$NEW_PID" != "-" ] && [ -n "$NEW_PID" ]; then
    log "INFO: $SERVICE_LABEL restarted successfully (PID=$NEW_PID)"
  else
    log "ERROR: $SERVICE_LABEL failed to start after kickstart (PID=${NEW_PID:--})"
  fi
else
  # Verify the PID is actually alive (launchd can lag on cleanup)
  if ! kill -0 "$LAUNCHCTL_PID" 2>/dev/null; then
    log "WARN: $SERVICE_LABEL shows PID=$LAUNCHCTL_PID but process is dead. Kickstarting..."
    launchctl kickstart -k "gui/${UID_VAL}/${SERVICE_LABEL}" 2>>"$LOG"
    sleep 5
    NEW_PID=$(launchctl list 2>/dev/null | awk -v lbl="$SERVICE_LABEL" '$3 == lbl {print $1}')
    log "INFO: $SERVICE_LABEL kickstarted (new PID=${NEW_PID:--})"
  else
    log "OK: $SERVICE_LABEL is running (PID=$LAUNCHCTL_PID)"
  fi
fi
