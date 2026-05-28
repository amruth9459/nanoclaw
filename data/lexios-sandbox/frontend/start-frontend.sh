#!/bin/bash
# Lexios Frontend Startup Script
# Runs both app (port 5173) and gov (port 5174) Vite dev servers concurrently
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "ERROR: node_modules missing. Run: npm install"
  exit 1
fi

APP_PORT="${LEXIOS_FRONTEND_APP_PORT:-5173}"
GOV_PORT="${LEXIOS_FRONTEND_GOV_PORT:-5174}"

echo "Starting Lexios frontend (app=${APP_PORT}, gov=${GOV_PORT})..."

npx concurrently \
  --names "app,gov" \
  --prefix-colors "blue,magenta" \
  "npx vite --config vite.app.config.ts --port ${APP_PORT} --host 0.0.0.0" \
  "npx vite --config vite.gov.config.ts --port ${GOV_PORT} --host 0.0.0.0"
