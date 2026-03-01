#!/usr/bin/env bash
set -euo pipefail

# Cloud state backup for NanoClaw + Lexios
# Syncs runtime data to Cloudflare R2 and pushes git repos.
# Designed to run every 15 min via launchd.

NANOCLAW_DIR="${NANOCLAW_DIR:-/Users/amrut/nanoclaw}"
LEXIOS_DIR="${LEXIOS_DIR:-/Users/amrut/Lexios}"
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-nanoclaw-backup}"
LOCK_FILE="/tmp/nanoclaw-backup.lock"
LOG_FILE="${NANOCLAW_DIR}/logs/backup.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# mkdir-based lock to prevent concurrent runs (macOS has no flock)
cleanup_lock() { rm -rf "$LOCK_FILE"; }
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
    # Stale lock check: if lock is older than 30 min, remove it
    if [ -d "$LOCK_FILE" ] && find "$LOCK_FILE" -maxdepth 0 -mmin +30 | grep -q .; then
        rm -rf "$LOCK_FILE"
        mkdir "$LOCK_FILE"
    else
        log "SKIP: another backup is already running"
        exit 0
    fi
fi
trap cleanup_lock EXIT

log "=== Backup started ==="

# ---------- Step 1: Git auto-commit + push ----------

git_backup() {
    local dir="$1" remote="$2" label="$3"
    if [ ! -d "$dir/.git" ]; then
        log "WARN: $label git repo not found at $dir, skipping git backup"
        return
    fi
    cd "$dir"

    # Check for uncommitted changes (tracked + untracked)
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        git add -A
        git commit --no-verify -m "auto-backup $(date '+%Y-%m-%d %H:%M')" || true
        log "$label: committed changes"
    fi

    # Push if there are unpushed commits
    local branch
    branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    if git push "$remote" "$branch" --quiet 2>/dev/null; then
        log "$label: pushed to $remote/$branch"
    else
        log "WARN: $label git push to $remote failed (will retry next cycle)"
    fi
}

git_backup "$NANOCLAW_DIR" "fork" "NanoClaw"
git_backup "$LEXIOS_DIR" "origin" "Lexios"

# ---------- Step 2: rclone sync NanoClaw runtime dirs ----------

if ! command -v rclone &>/dev/null; then
    log "ERROR: rclone not installed (brew install rclone)"
    exit 1
fi

RCLONE_FLAGS=(--quiet --transfers 8 --checkers 16 --fast-list)

# store/ — SQLite DBs + WhatsApp auth
rclone sync "$NANOCLAW_DIR/store/" "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/store/" \
    "${RCLONE_FLAGS[@]}" \
    --exclude "*.html" \
    --exclude "*.db-shm" \
    --exclude "*.db-wal" \
    2>> "$LOG_FILE" && log "synced store/" || log "WARN: store/ sync failed"

# groups/ — group data, conversations, CLAUDE.md
rclone sync "$NANOCLAW_DIR/groups/" "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/groups/" \
    "${RCLONE_FLAGS[@]}" \
    --exclude "logs/**" \
    --exclude "ggml/**" \
    --exclude "gguf/**" \
    --exclude "node_modules/**" \
    2>> "$LOG_FILE" && log "synced groups/" || log "WARN: groups/ sync failed"

# data/ — session state (exclude transient IPC json)
rclone sync "$NANOCLAW_DIR/data/" "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/data/" \
    "${RCLONE_FLAGS[@]}" \
    --exclude "ipc/*/messages/*.json" \
    --exclude "ipc/*/tasks/*.json" \
    --exclude "ipc/errors/**" \
    2>> "$LOG_FILE" && log "synced data/" || log "WARN: data/ sync failed"

# config/
if [ -d "$NANOCLAW_DIR/config/" ]; then
    rclone sync "$NANOCLAW_DIR/config/" "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/config/" \
        "${RCLONE_FLAGS[@]}" \
        2>> "$LOG_FILE" && log "synced config/" || log "WARN: config/ sync failed"
fi

# .env
if [ -f "$NANOCLAW_DIR/.env" ]; then
    rclone copyto "$NANOCLAW_DIR/.env" "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/.env" \
        --quiet 2>> "$LOG_FILE" && log "synced .env" || log "WARN: .env sync failed"
fi

# ---------- Step 3: rclone sync Lexios runtime dirs ----------

if [ -d "$LEXIOS_DIR/backend/uploads/" ]; then
    rclone sync "$LEXIOS_DIR/backend/uploads/" "${R2_REMOTE}:${R2_BUCKET}/lexios/backend/uploads/" \
        "${RCLONE_FLAGS[@]}" \
        2>> "$LOG_FILE" && log "synced lexios uploads/" || log "WARN: lexios uploads/ sync failed"
fi

if [ -d "$LEXIOS_DIR/backend/database/" ]; then
    rclone sync "$LEXIOS_DIR/backend/database/" "${R2_REMOTE}:${R2_BUCKET}/lexios/backend/database/" \
        "${RCLONE_FLAGS[@]}" \
        2>> "$LOG_FILE" && log "synced lexios database/" || log "WARN: lexios database/ sync failed"
fi

# ---------- Step 4: Log completion ----------

R2_SIZE=$(rclone size "${R2_REMOTE}:${R2_BUCKET}" --json 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2 || echo "unknown")
if [ "$R2_SIZE" != "unknown" ] && [ -n "$R2_SIZE" ]; then
    R2_MB=$(( R2_SIZE / 1048576 ))
    log "=== Backup complete (R2 total: ${R2_MB}MB) ==="
else
    log "=== Backup complete ==="
fi
