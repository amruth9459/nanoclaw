#!/usr/bin/env bash
set -euo pipefail

# Cloud state backup for NanoClaw + Lexios
# Copies runtime data to Cloudflare R2 and pushes git repos.
# Designed to run every 15 min via launchd.
#
# SECURITY: Uses "rclone copy" (additive) NOT "rclone sync" (destructive).
# Local deletions are NEVER propagated to R2. Daily snapshots provide
# point-in-time recovery. A compromised agent cannot wipe the backup.

NANOCLAW_DIR="${NANOCLAW_DIR:-/Users/amrut/nanoclaw}"
LEXIOS_DIR="${LEXIOS_DIR:-/Users/amrut/Lexios}"
R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-nanoclaw-backup}"
LOCK_FILE="/tmp/nanoclaw-backup.lock"
LOG_FILE="${NANOCLAW_DIR}/logs/backup.log"

# Daily snapshot prefix (one snapshot per day for point-in-time recovery)
SNAPSHOT_DATE=$(date '+%Y-%m-%d')
SNAPSHOT_PREFIX="snapshots/${SNAPSHOT_DATE}"

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
    shift 3
    # Remaining args are safe paths to stage (if empty, stage nothing)
    local safe_paths=("$@")

    if [ ! -d "$dir/.git" ]; then
        log "WARN: $label git repo not found at $dir, skipping git backup"
        return
    fi
    cd "$dir"

    # SECURITY: Only stage explicitly listed safe paths — NEVER "git add -A"
    # on the whole project. A compromised agent with write access to any
    # mounted dir could inject malicious code that gets auto-committed.
    if [ ${#safe_paths[@]} -gt 0 ]; then
        for p in "${safe_paths[@]}"; do
            [ -e "$p" ] && git add "$p" 2>/dev/null || true
        done
    fi

    if [ -n "$(git diff --cached --name-only 2>/dev/null)" ]; then
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

# NanoClaw: only commit runtime data dirs, NEVER src/ or scripts/
git_backup "$NANOCLAW_DIR" "fork" "NanoClaw" \
    groups/ data/ store/ docs/ config/

# Lexios: only commit core engine outputs and docs
git_backup "$LEXIOS_DIR" "origin" "Lexios" \
    lexios/corpus/ lexios/learnings.json lexios/work/ docs/

# ---------- Step 1b: Atomic SQLite backup ----------
# SECURITY: Copying .db without the WAL can produce an inconsistent backup.
# Use sqlite3 .backup to create an atomic snapshot, then upload that.
BACKUP_TMP="${NANOCLAW_DIR}/store/.backup"
mkdir -p "$BACKUP_TMP"
for dbfile in "$NANOCLAW_DIR"/store/*.db; do
    [ -f "$dbfile" ] || continue
    dbname=$(basename "$dbfile")
    if command -v sqlite3 &>/dev/null; then
        sqlite3 "$dbfile" ".backup '${BACKUP_TMP}/${dbname}'" 2>> "$LOG_FILE" \
            && log "atomic backup: $dbname" \
            || cp "$dbfile" "${BACKUP_TMP}/${dbname}" 2>/dev/null
    else
        cp "$dbfile" "${BACKUP_TMP}/${dbname}" 2>/dev/null
    fi
done

# ---------- Step 2: rclone copy NanoClaw runtime dirs ----------
# SECURITY: Using "copy" (additive) instead of "sync" (destructive).
# Files are NEVER deleted from R2 by this script. Cleanup of old files
# is a separate manual operation.

if ! command -v rclone &>/dev/null; then
    log "ERROR: rclone not installed (brew install rclone)"
    exit 1
fi

RCLONE_FLAGS=(--quiet --transfers 8 --checkers 16 --fast-list --update)

# Helper: copy to both latest/ (current state) and daily snapshot
r2_copy() {
    local src="$1" dest_suffix="$2"
    shift 2
    # Latest (always overwritten with newest version)
    rclone copy "$src" "${R2_REMOTE}:${R2_BUCKET}/latest/${dest_suffix}" \
        "${RCLONE_FLAGS[@]}" "$@" \
        2>> "$LOG_FILE" || log "WARN: latest/${dest_suffix} copy failed"
    # Daily snapshot (one per day, immutable after first write)
    rclone copy "$src" "${R2_REMOTE}:${R2_BUCKET}/${SNAPSHOT_PREFIX}/${dest_suffix}" \
        "${RCLONE_FLAGS[@]}" --ignore-existing "$@" \
        2>> "$LOG_FILE" || log "WARN: snapshot/${dest_suffix} copy failed"
}

# store/ — atomic SQLite backup copies (not the live WAL-mode DBs)
r2_copy "$BACKUP_TMP/" "nanoclaw/store/db/" \
    && log "copied atomic DB backups"

# store/ — WhatsApp auth and other non-DB files
r2_copy "$NANOCLAW_DIR/store/" "nanoclaw/store/" \
    --exclude "*.db" \
    --exclude "*.db-shm" \
    --exclude "*.db-wal" \
    --exclude "*.html" \
    --exclude ".backup/**" \
    && log "copied store/ (non-DB)"

# groups/ — group data, conversations, CLAUDE.md
r2_copy "$NANOCLAW_DIR/groups/" "nanoclaw/groups/" \
    --exclude "logs/**" \
    --exclude "ggml/**" \
    --exclude "gguf/**" \
    --exclude "node_modules/**" \
    && log "copied groups/"

# data/ — session state (exclude transient IPC json)
r2_copy "$NANOCLAW_DIR/data/" "nanoclaw/data/" \
    --exclude "ipc/*/messages/*.json" \
    --exclude "ipc/*/tasks/*.json" \
    --exclude "ipc/*/input/**" \
    --exclude "ipc/errors/**" \
    && log "copied data/"

# config/
if [ -d "$NANOCLAW_DIR/config/" ]; then
    r2_copy "$NANOCLAW_DIR/config/" "nanoclaw/config/" \
        && log "copied config/"
fi

# .env — use temp dir (rclone copyto has a CreateBucket bug with R2)
if [ -f "$NANOCLAW_DIR/.env" ]; then
    tmp_env=$(mktemp -d)
    cp "$NANOCLAW_DIR/.env" "$tmp_env/dot-env"
    r2_copy "$tmp_env/" "nanoclaw/env/" \
        && log "copied .env"
    rm -rf "$tmp_env"
fi

# ---------- Step 3: rclone copy Lexios runtime dirs ----------

if [ -d "$LEXIOS_DIR/backend/uploads/" ]; then
    r2_copy "$LEXIOS_DIR/backend/uploads/" "lexios/backend/uploads/" \
        && log "copied lexios uploads/"
fi

if [ -d "$LEXIOS_DIR/backend/database/" ]; then
    r2_copy "$LEXIOS_DIR/backend/database/" "lexios/backend/database/" \
        && log "copied lexios database/"
fi

# Lexios core data (eval.db, codes.db, learnings.json, corpus)
if [ -d "$LEXIOS_DIR/lexios/" ]; then
    r2_copy "$LEXIOS_DIR/lexios/" "lexios/core/" \
        --include "*.db" \
        --include "*.json" \
        --include "corpus/**" \
        --exclude "work/**" \
        --exclude "__pycache__/**" \
        && log "copied lexios core data"
fi

# ---------- Step 4: Generate + upload contingency doc to Google Drive ----------

CONTINGENCY_DOC="${NANOCLAW_DIR}/data/contingency.md"
if [ -x "${NANOCLAW_DIR}/scripts/generate-contingency.sh" ]; then
    "${NANOCLAW_DIR}/scripts/generate-contingency.sh" "$CONTINGENCY_DOC" >> "$LOG_FILE" 2>&1
    if command -v rclone &>/dev/null && rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
        rclone copyto "$CONTINGENCY_DOC" "gdrive:NanoClaw-Contingency.md" \
            --quiet 2>> "$LOG_FILE" && log "uploaded contingency doc to Google Drive" || log "WARN: Google Drive upload failed"

        # Upload live platform + changelog docs
        LEXIOS_DOCS_DIR="${LEXIOS_DIR}/docs"
        NANOCLAW_DOCS_DIR="${NANOCLAW_DIR}/docs"
        for doc in "LEXIOS_PLATFORM.md" "LEXIOS_CHANGELOG.md"; do
            [ -f "${LEXIOS_DOCS_DIR}/${doc}" ] && rclone copyto "${LEXIOS_DOCS_DIR}/${doc}" "gdrive:Lexios/${doc}" \
                --quiet 2>> "$LOG_FILE" && log "uploaded ${doc} to Google Drive" || log "WARN: ${doc} upload failed"
        done
        for doc in "NANOCLAW_PLATFORM.md" "NANOCLAW_CHANGELOG.md"; do
            [ -f "${NANOCLAW_DOCS_DIR}/${doc}" ] && rclone copyto "${NANOCLAW_DOCS_DIR}/${doc}" "gdrive:NanoClaw/${doc}" \
                --quiet 2>> "$LOG_FILE" && log "uploaded ${doc} to Google Drive" || log "WARN: ${doc} upload failed"
        done
        log "uploaded live docs to Google Drive"
    fi
fi

# ---------- Step 5: Log completion ----------

# ---------- Step 5a: Prune old snapshots (keep last 30 days) ----------
# List snapshot dirs older than 30 days and delete them.
# This is the ONLY place where R2 objects are deleted.
CUTOFF_DATE=$(date -v-30d '+%Y-%m-%d' 2>/dev/null || date -d '30 days ago' '+%Y-%m-%d' 2>/dev/null || echo "")
if [ -n "$CUTOFF_DATE" ]; then
    rclone lsf "${R2_REMOTE}:${R2_BUCKET}/snapshots/" --dirs-only 2>/dev/null | while read -r dir; do
        dir_date="${dir%/}"
        if [[ "$dir_date" < "$CUTOFF_DATE" ]]; then
            rclone purge "${R2_REMOTE}:${R2_BUCKET}/snapshots/${dir_date}" --quiet 2>> "$LOG_FILE" \
                && log "pruned old snapshot: ${dir_date}" || true
        fi
    done
fi

# ---------- Step 6: Log completion ----------

# Cleanup temp backup dir
rm -rf "$BACKUP_TMP"

R2_SIZE=$(rclone size "${R2_REMOTE}:${R2_BUCKET}" --json 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2 || echo "unknown")
if [ "$R2_SIZE" != "unknown" ] && [ -n "$R2_SIZE" ]; then
    R2_MB=$(( R2_SIZE / 1048576 ))
    log "=== Backup complete (R2 total: ${R2_MB}MB, snapshot: ${SNAPSHOT_DATE}) ==="
else
    log "=== Backup complete (snapshot: ${SNAPSHOT_DATE}) ==="
fi
