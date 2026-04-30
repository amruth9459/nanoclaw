#!/usr/bin/env bash
set -euo pipefail

# Cloud state backup for NanoClaw
# Copies runtime data to Cloudflare R2 and pushes git repos.
# Integration backups run via hooks (e.g. ~/MyApp/integrations/nanoclaw/backup-hook.sh).
# Designed to run every 15 min via launchd.
#
# SECURITY: Uses "rclone copy" (additive) NOT "rclone sync" (destructive).
# Local deletions are NEVER propagated to R2. Daily snapshots provide
# point-in-time recovery. A compromised agent cannot wipe the backup.

NANOCLAW_DIR="${NANOCLAW_DIR:-/Users/amrut/nanoclaw}"
R2_REMOTE="${R2_REMOTE:-r2-backup-writeonly}"
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

# NanoClaw: commit runtime data AND source code (desktop_claude makes real code changes)
git_backup "$NANOCLAW_DIR" "fork" "NanoClaw" \
    groups/ data/ store/ docs/ config/ \
    src/ container/ scripts/ \
    CLAUDE.md package.json package-lock.json \
    .claude/hooks/ .githooks/

# Run integration backup hooks (e.g. ~/MyApp/integrations/nanoclaw/backup-hook.sh)
for hook in "$NANOCLAW_DIR"/src/integrations/*/backup-hook.sh; do
    [ -x "$hook" ] && "$hook" || true
done
# Also check external integration repos
for hook in ~/*/integrations/nanoclaw/backup-hook.sh; do
    [ -x "$hook" ] && "$hook" || true
done

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

# ---------- Step 2b: Home dirs not covered elsewhere ----------
# Critical user data outside the nanoclaw/Lexios trees. On restore,
# permissions for ~/.ssh must be reset (chmod 600 id_rsa, 700 ~/.ssh).

# ~/Brain — Obsidian vault (Daily, Inbox, Architecture, synthesis notes)
if [ -d "$HOME/Brain" ]; then
    r2_copy "$HOME/Brain/" "home/Brain/" \
        --exclude ".obsidian/workspace*" \
        --exclude ".obsidian/cache/**" \
        --exclude ".trash/**" \
        && log "copied ~/Brain/"
fi

# ~/.ssh — private keys, config, known_hosts (Tailscale, NN server, GitHub)
if [ -d "$HOME/.ssh" ]; then
    r2_copy "$HOME/.ssh/" "home/ssh/" \
        --exclude "agent" \
        --exclude "*.old" \
        && log "copied ~/.ssh/"
fi

# ~/Downloads/Final report — HPM 523 coursework (graded paper, drafts)
if [ -d "$HOME/Downloads/Final report" ]; then
    r2_copy "$HOME/Downloads/Final report/" "home/Downloads-Final-report/" \
        && log "copied ~/Downloads/Final report/"
fi

# ~/Library/LaunchAgents — only NanoClaw + Lexios plists (so bootstrap can rehydrate services)
LAUNCHD_TMP=$(mktemp -d)
cp "$HOME/Library/LaunchAgents/"com.nanoclaw.*.plist "$LAUNCHD_TMP/" 2>/dev/null || true
cp "$HOME/Library/LaunchAgents/"com.lexios.*.plist "$LAUNCHD_TMP/" 2>/dev/null || true
if [ -n "$(ls -A "$LAUNCHD_TMP" 2>/dev/null)" ]; then
    r2_copy "$LAUNCHD_TMP/" "home/LaunchAgents/" \
        && log "copied LaunchAgents plists"
fi
rm -rf "$LAUNCHD_TMP"

# ---------- Step 3: Generate + upload contingency doc to Google Drive ----------

CONTINGENCY_DOC="${NANOCLAW_DIR}/data/contingency.md"
if [ -x "${NANOCLAW_DIR}/scripts/generate-contingency.sh" ]; then
    "${NANOCLAW_DIR}/scripts/generate-contingency.sh" "$CONTINGENCY_DOC" >> "$LOG_FILE" 2>&1
    if command -v rclone &>/dev/null && rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
        rclone copyto "$CONTINGENCY_DOC" "gdrive:NanoClaw-Contingency.md" \
            --quiet 2>> "$LOG_FILE" && log "uploaded contingency doc to Google Drive" || log "WARN: Google Drive upload failed"

        # Upload NanoClaw platform + changelog docs
        NANOCLAW_DOCS_DIR="${NANOCLAW_DIR}/docs"
        for doc in "NANOCLAW_PLATFORM.md" "NANOCLAW_CHANGELOG.md" "NANOCLAW_BUILD_LOG.md"; do
            [ -f "${NANOCLAW_DOCS_DIR}/${doc}" ] && rclone copyto "${NANOCLAW_DOCS_DIR}/${doc}" "gdrive:NanoClaw/${doc}" \
                --quiet 2>> "$LOG_FILE" && log "uploaded ${doc} to Google Drive" || true
        done
        log "uploaded live docs to Google Drive"
    fi
fi

# ---------- Step 5: Log completion ----------

# DISABLED: Automatic snapshot pruning (write-only token has no delete permission)
# Manual pruning procedure (quarterly or as needed):
#   1. Recreate full-access 'r2' remote temporarily
#   2. List snapshots: rclone ls r2:nanoclaw-backup/snapshots/ --dirs-only
#   3. Delete old ones: rclone purge r2:nanoclaw-backup/snapshots/YYYY-MM-DD
#   4. Remove full-access remote: rclone config delete r2
#
# CUTOFF_DATE=$(date -v-90d '+%Y-%m-%d' 2>/dev/null || date -d '90 days ago' '+%Y-%m-%d' 2>/dev/null || echo "")
# if [ -n "$CUTOFF_DATE" ]; then
#     rclone lsf "r2:${R2_BUCKET}/snapshots/" --dirs-only 2>/dev/null | while read -r dir; do
#         [[ "${dir%/}" < "$CUTOFF_DATE" ]] && rclone purge "r2:${R2_BUCKET}/snapshots/${dir%/}" --quiet 2>> "$LOG_FILE"
#     done
# fi

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
