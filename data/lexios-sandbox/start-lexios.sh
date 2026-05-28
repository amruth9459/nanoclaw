#!/bin/bash
# Unified Lexios Startup - Backend + Frontend
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "Starting Lexios Platform"
echo "============================================"
echo ""
echo "Backend:  http://localhost:5002"
echo "Frontend: http://localhost:5173 (app)"
echo "          http://localhost:5174 (gov)"
echo ""
echo "Press Ctrl+C to stop all servers"
echo "============================================"
echo ""

# Start backend in background
cd backend
./start-backend.sh &
BACKEND_PID=$!
cd ..

# Cleanup on exit
trap "kill $BACKEND_PID 2>/dev/null; exit" INT TERM EXIT

# Wait for backend to be ready
sleep 3

# Start frontend (foreground, so Ctrl+C kills all)
cd frontend
./start-frontend.sh
