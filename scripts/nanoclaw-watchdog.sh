#!/bin/bash
# NanoClaw Watchdog — ensures the main service stays alive
# Runs every 5 minutes via launchd (com.nanoclaw.watchdog)

LOG="/Users/amrut/nanoclaw/logs/watchdog.log"
PLIST="$HOME/Library/LaunchAgents/com.nanoclaw.plist"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

# Check if com.nanoclaw is loaded and running
STATUS=$(launchctl list 2>/dev/null | grep "com.nanoclaw " | awk '{print $1}')

if [ -z "$STATUS" ]; then
    log "WARN: com.nanoclaw not registered — loading plist"
    launchctl load -w "$PLIST" 2>>"$LOG"
elif [ "$STATUS" = "-" ]; then
    log "WARN: com.nanoclaw registered but not running (crashed) — kickstarting"
    launchctl kickstart gui/$(id -u)/com.nanoclaw 2>>"$LOG"
else
    # Running — check if it's actually responsive (port 8080 or 3002)
    if ! lsof -i :8080 -t >/dev/null 2>&1 && ! lsof -i :3002 -t >/dev/null 2>&1; then
        log "WARN: com.nanoclaw running (PID $STATUS) but no ports open — may be stuck"
    fi
fi
