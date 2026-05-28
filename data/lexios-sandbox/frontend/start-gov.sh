#!/bin/bash
# Lexios Frontend Gov Portal — port 5174
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "ERROR: node_modules missing. Run: npm install"
  exit 1
fi

GOV_PORT="${LEXIOS_FRONTEND_GOV_PORT:-5174}"
echo "Starting Lexios gov portal on port ${GOV_PORT}..."
exec npx vite --config vite.gov.config.ts --port "${GOV_PORT}" --host 0.0.0.0
