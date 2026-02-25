#!/bin/bash
# Docker Watchdog - Restarts Docker Desktop if it's not responding
# Run by launchd every 2 minutes (com.nanoclaw.docker-watchdog)

LOG=/Users/amrut/nanoclaw/logs/docker-watchdog.log
MAX_LOG_SIZE=1048576  # 1MB

rotate_if_needed() {
  if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt "$MAX_LOG_SIZE" ]; then
    mv "$LOG" "${LOG}.old"
  fi
}

log() {
  rotate_if_needed
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

# Check if Docker daemon is responsive (timeout 5s)
if docker info --format '{{.ServerVersion}}' 2>/dev/null | grep -q .; then
  # Docker is fine, nothing to do
  exit 0
fi

log "WARN: Docker daemon not responding, attempting restart"

# Kill any stuck Docker processes
pkill -9 -f "Docker Desktop" 2>/dev/null
pkill -9 -f "com.docker" 2>/dev/null
sleep 3

# Remove stale sockets
rm -f /var/run/docker.sock 2>/dev/null
rm -f "$HOME/.docker/run/docker.sock" 2>/dev/null

# Start Docker Desktop
open -a "Docker Desktop"

# Wait up to 60s for Docker to become ready
for i in $(seq 1 12); do
  sleep 5
  if docker info --format '{{.ServerVersion}}' 2>/dev/null | grep -q .; then
    log "INFO: Docker restarted successfully after ${i}x5s (attempt ${i})"
    exit 0
  fi
done

log "ERROR: Docker failed to restart after 60s"
exit 1
