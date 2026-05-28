#!/bin/bash
# Lexios Backend Startup Script
# Activates venv, loads .env, runs Flask server on port 5002
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d ".venv" ]; then
  echo "ERROR: .venv missing. Run: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

source .venv/bin/activate

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export LEXIOS_BACKEND_PORT="${LEXIOS_BACKEND_PORT:-5002}"

echo "Starting Lexios backend on port ${LEXIOS_BACKEND_PORT}..."
exec .venv/bin/python run_server.py
