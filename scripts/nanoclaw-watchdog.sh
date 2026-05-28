#!/bin/bash
# NanoClaw Watchdog — ensures the main service stays alive
# Runs every 5 minutes via launchd (com.nanoclaw.watchdog)

LOG="/Users/amrut/nanoclaw/logs/watchdog.log"
PLIST="$HOME/Library/LaunchAgents/com.nanoclaw.plist"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"; }

# launchctl print is the only reliable way to check service state on macOS 13+
# (launchctl list omits some caffeinate-wrapped LaunchAgents)
DOMAIN="gui/$(id -u)/com.nanoclaw"
PRINT_OUT=$(launchctl print "$DOMAIN" 2>/dev/null)

if [ -z "$PRINT_OUT" ]; then
    log "WARN: com.nanoclaw not registered — bootstrapping plist"
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>>"$LOG"
elif echo "$PRINT_OUT" | grep -q "state = not running"; then
    log "WARN: com.nanoclaw registered but not running (crashed) — kickstarting"
    launchctl kickstart "$DOMAIN" 2>>"$LOG"
elif echo "$PRINT_OUT" | grep -q "state = running"; then
    # Running — verify responsiveness via DashClaw port
    if ! lsof -i :3002 -t >/dev/null 2>&1 && ! lsof -i :8080 -t >/dev/null 2>&1; then
        log "WARN: com.nanoclaw running but no ports open — may be stuck"
    fi
fi
