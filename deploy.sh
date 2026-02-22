#!/usr/bin/env bash
# NanoClaw Deployment Script
# Builds host + container, then restarts the launchd service.
#
# Usage:
#   ./deploy.sh           — full rebuild (host + container + restart)
#   ./deploy.sh --host    — host TypeScript only (skip container rebuild)
#   ./deploy.sh --dev     — build then run in foreground dev mode (no launchd)

set -euo pipefail

cd "$(dirname "$0")"

HOST_ONLY=false
DEV_MODE=false
for arg in "$@"; do
  case "$arg" in
    --host) HOST_ONLY=true ;;
    --dev)  DEV_MODE=true  ;;
  esac
done

echo "==> Building host TypeScript..."
npm run build
echo "    Done."

if ! $HOST_ONLY; then
  echo "==> Rebuilding agent container..."
  ./container/build.sh
  echo "    Done."
fi

if $DEV_MODE; then
  echo "==> Starting in dev mode (Ctrl-C to stop)..."
  npm run dev
  exit 0
fi

# Restart the launchd service
echo "==> Restarting NanoClaw service..."
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null \
  || { echo "    Service not loaded — starting fresh..."; launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist; }

sleep 2

# Tail the log briefly to confirm clean startup
echo ""
echo "==> Startup log:"
tail -8 logs/nanoclaw.log 2>/dev/null || true
echo ""
echo "Done. Run 'tail -f logs/nanoclaw.log' to follow logs."
