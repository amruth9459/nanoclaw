# Lexios Platform Servers

## Quick Start
```bash
./start-lexios.sh
```

This starts:
- Backend API (Flask/SocketIO) on port 5002
- App Frontend (React/Vite) on port 5173
- Gov Frontend (React/Vite) on port 5174

## Individual Servers
```bash
# Backend only
cd backend && ./start-backend.sh

# Frontend only (both apps)
cd frontend && ./start-frontend.sh

# App frontend only
cd frontend && ./start-app.sh

# Gov frontend only
cd frontend && ./start-gov.sh
```

## Requirements
- Python 3.12+ (backend)
- Node.js 18+ (frontend)
- PostgreSQL (for production, optional for dev)

## Environment Variables
Backend (.env):
- `LEXIOS_BACKEND_PORT` (default: 5002)
- `DATABASE_URL` (optional, falls back to in-memory)

Frontend:
- `LEXIOS_FRONTEND_APP_PORT` (default: 5173)
- `LEXIOS_FRONTEND_GOV_PORT` (default: 5174)

## Health Check
```bash
curl http://localhost:5002/api/v2/health
```

Expected response:
```json
{"status":"healthy","version":"7.1.0",...}
```

## Troubleshooting
- **Backend won't start**: Check `.venv` exists and `requirements.txt` installed
  ```bash
  cd backend
  python3.12 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  ```
- **Frontend won't start**: Run `npm install` in `frontend/`
- **Port conflicts**: Set alternative ports via environment variables, or check existing processes with `lsof -i :5002 -i :5173 -i :5174`
