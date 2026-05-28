# Lexios Sandbox — Services

Operational guide for the backend (Flask + SocketIO) and frontend (Vite dev
servers) that ship with this sandbox.

> **Heads-up.** The launchd label `com.lexios.backend` is already used by the
> production Lexios deployment at `~/Lexios/`. This sandbox uses the
> `com.lexios.sandbox.*` namespace so it can coexist on the same machine. The
> sandbox backend listens on the same port (5002) as the production backend, so
> only one of them can run at a time.

## Port assignments

| Service               | Port | Health/URL                                  |
|-----------------------|------|---------------------------------------------|
| Backend (Flask)       | 5002 | `http://localhost:5002/api/v2/health`       |
| Frontend — App        | 5173 | `http://localhost:5173/`                    |
| Frontend — Gov portal | 5174 | `http://localhost:5174/`                    |

The backend port is configurable via `LEXIOS_BACKEND_PORT` in `backend/.env`.
The frontend ports are configurable via `LEXIOS_FRONTEND_APP_PORT` and
`LEXIOS_FRONTEND_GOV_PORT` (set in the launchd plists or via the shell).

## Files

### Startup scripts

| Script                            | Purpose                                  |
|-----------------------------------|------------------------------------------|
| `backend/start-backend.sh`        | Activates `.venv`, loads `.env`, runs `run_server.py` |
| `frontend/start-app.sh`           | Vite dev server for the main app (port 5173) |
| `frontend/start-gov.sh`           | Vite dev server for the gov portal (port 5174) |
| `frontend/start-frontend.sh`      | Both `app` and `gov` concurrently (interactive use) |

### launchd plists (`~/Library/LaunchAgents/`)

| Plist                                       | Service                |
|---------------------------------------------|------------------------|
| `com.lexios.sandbox.backend.plist`          | Backend on port 5002   |
| `com.lexios.sandbox.frontend.app.plist`     | Frontend app on 5173   |
| `com.lexios.sandbox.frontend.gov.plist`     | Frontend gov on 5174   |

Each plist has `KeepAlive.Crashed = true`, so the process auto-restarts on
failure. `ThrottleInterval = 10` rate-limits restart loops to once per 10 s.

### Logs

`logs/` (relative to the sandbox root):

| File                      | Source                                  |
|---------------------------|-----------------------------------------|
| `backend.out.log`         | Backend stdout                          |
| `backend.err.log`         | Backend stderr                          |
| `frontend-app.out.log`    | App stdout                              |
| `frontend-app.err.log`    | App stderr                              |
| `frontend-gov.out.log`    | Gov portal stdout                       |
| `frontend-gov.err.log`    | Gov portal stderr                       |

## Loading / unloading services

`launchctl load -w` enables `RunAtLoad` and starts the job. `launchctl unload`
stops it. Loading is **not** idempotent — use `unload` first if the job is
already loaded.

```bash
# Load (start) all three sandbox services
launchctl load -w ~/Library/LaunchAgents/com.lexios.sandbox.backend.plist
launchctl load -w ~/Library/LaunchAgents/com.lexios.sandbox.frontend.app.plist
launchctl load -w ~/Library/LaunchAgents/com.lexios.sandbox.frontend.gov.plist

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.lexios.sandbox.backend.plist
launchctl unload ~/Library/LaunchAgents/com.lexios.sandbox.frontend.app.plist
launchctl unload ~/Library/LaunchAgents/com.lexios.sandbox.frontend.gov.plist
```

**Before loading the sandbox backend**, unload the production backend to free
port 5002:

```bash
launchctl unload ~/Library/LaunchAgents/com.lexios.backend.plist
```

## Service status

```bash
# Is the job loaded?
launchctl list | grep com.lexios.sandbox

# Detailed status (last exit code, PID, etc.)
launchctl print gui/$(id -u)/com.lexios.sandbox.backend

# Process-level check
lsof -nP -iTCP:5002 -iTCP:5173 -iTCP:5174 -sTCP:LISTEN
```

## Manual run (without launchd)

```bash
# Backend
cd backend && ./start-backend.sh

# Frontend (both ports, foreground, ctrl-c stops both)
cd frontend && ./start-frontend.sh

# Or each separately
cd frontend && ./start-app.sh
cd frontend && ./start-gov.sh
```

## Health checks

```bash
curl http://localhost:5002/api/v2/health    # backend
curl -I http://localhost:5173/              # app
curl -I http://localhost:5174/              # gov portal
```

Backend healthy response shape:
```json
{
  "status": "healthy",
  "version": "7.1.0",
  "databaseAvailable": true,
  "extractorAvailable": true,
  "blueprintsLoaded": true
}
```

## Environment variables

Defined in `backend/.env`:

| Variable               | Required | Notes                                |
|------------------------|----------|--------------------------------------|
| `LEXIOS_BACKEND_PORT`  | no       | Defaults to `5002`                   |
| `DATABASE_URL`         | yes      | PostgreSQL connection string         |
| `SECRET_KEY`           | yes      | Flask session signing key            |
| `FLASK_ENV`            | no       | `development` or `production`        |
| `ANTHROPIC_API_KEY`    | rec.     | Needed for LLM-backed endpoints      |
| `OPENAI_API_KEY`       | opt.     | Alternative LLM provider             |
| `JWT_ACCESS_TOKEN_EXPIRES`  | no  | Seconds; defaults set in `.env`      |
| `JWT_REFRESH_TOKEN_EXPIRES` | no  | Seconds; defaults set in `.env`      |

See `backend/.env.example` for the full template. The launchd plists do not
override `.env`; they only set `PATH` and the per-frontend port overrides.

## First-time setup (fresh checkout)

```bash
# Backend
cd backend
python3.12 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
# (verify .env is populated; copy from .env.example if not)

# Frontend
cd ../frontend
npm install
npm run build       # produces dist-app/ and dist-gov/

# Optional: install launchd services (once)
launchctl load -w ~/Library/LaunchAgents/com.lexios.sandbox.backend.plist
launchctl load -w ~/Library/LaunchAgents/com.lexios.sandbox.frontend.app.plist
launchctl load -w ~/Library/LaunchAgents/com.lexios.sandbox.frontend.gov.plist
```

> **Python version.** The backend pins older C-extension wheels
> (`numpy==1.26.2`, `opencv-python==4.8.1.78`, `eventlet==0.33.3`) that don't
> have prebuilt wheels for Python 3.14. Use Python 3.12.

## Troubleshooting

- **`Address already in use` on 5002** — the production backend
  (`~/Lexios/backend`) is running. Unload its launchd job first.
- **Backend exits immediately with `Database not available`** — Postgres isn't
  running. Bring it up via `backend/docker-compose.yml` or your local instance.
- **Frontend `vite: command not found`** — `node_modules` is missing. Run
  `npm install` in `frontend/`.
- **launchd job keeps restarting** — check `logs/*.err.log`; the
  `ThrottleInterval` will slow the crash loop but won't stop it.
