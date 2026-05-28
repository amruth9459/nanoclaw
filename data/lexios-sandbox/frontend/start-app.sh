#!/bin/bash
# Lexios Frontend App — port 5173
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "ERROR: node_modules missing. Run: npm install"
  exit 1
fi

APP_PORT="${LEXIOS_FRONTEND_APP_PORT:-5173}"
echo "Starting Lexios app on port ${APP_PORT}..."
exec npx vite --config vite.app.config.ts --port "${APP_PORT}" --host 0.0.0.0
