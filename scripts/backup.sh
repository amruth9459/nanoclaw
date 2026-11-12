#!/usr/bin/env bash
set -euo pipefail

# Cloud state backup for NanoClaw
# Copies runtime data to Cloudflare R2 and pushes git repos.
# Integration backups run via hooks (e.g. ~/MyApp/integrations/nanoclaw/backup-hook.sh).
# Designed to run every 15 min via launchd.
#
# SECURITY: Uses "rclone copy" (additive) NOT "rclone sync" (destructive).
# Local deletions are NEVER propagated to R2. Daily snapshots provide
# point-in-time recovery.

NANOCLAW_DIR="${NANOCLAW_DIR:-/Users/amrut/nanoclaw}"
R2_REMOTE="${R2_REMOTE:-r2-backup-writeonly}"
R2_BUCKET="${R2_BUCKET:-nanoclaw-backup}"
LOCK_FILE="${BACKUP_LOCK:-/tmp/nanoclaw-backup.lock}"
BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/nanoclaw-backup}"
LOG_FILE="${NANOCLAW_DIR}/logs/backup.log"
# Resolved now: git_backup cds into NANOCLAW_DIR, after which a relative $0 points elsewhere.
R2_DELTA="$(cd "$(dirname "$0")" && pwd)/r2_delta.py"

# Daily snapshot date (one snapshot per day for point-in-time recovery)
SNAPSHOT_DATE="${BACKUP_DATE:-$(date '+%Y-%m-%d')}"

mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

if ! [[ "$SNAPSHOT_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    log "ERROR: BACKUP_DATE must look like YYYY-MM-DD, got: $SNAPSHOT_DATE"
    exit 1
fi
export BACKUP_DATE="$SNAPSHOT_DATE" BACKUP_STATE_DIR LOG_FILE R2_REMOTE R2_BUCKET

# mkdir-based lock to prevent concurrent runs (macOS has no flock).
# The holder writes its pid into the lock. A first full upload can run for
# hours, so a lock is stale when its pid is no longer a backup.sh, not when
# it is old. A lock with no pid file (the old script's, or one being taken
# this instant) still goes stale after 30 min.
holder_running() {
    local pid
    pid=$(cat "$LOCK_FILE/pid" 2>/dev/null) || return 1
    [[ "$pid" =~ ^[0-9]+$ ]] || return 1
    ps -p "$pid" -o command= 2>/dev/null | grep -q 'backup\.sh'
}
cleanup_lock() {
    if [ "$(cat "$LOCK_FILE/pid" 2>/dev/null)" = "$$" ]; then
        rm -rf "$LOCK_FILE"
    fi
}
if ! mkdir "$LOCK_FILE" 2>/dev/null; then
    if holder_running \
        || { [ ! -f "$LOCK_FILE/pid" ] && ! find "$LOCK_FILE" -maxdepth 0 -mmin +30 | grep -q .; }; then
        log "SKIP: another backup is already running"
        exit 0
    fi
    log "WARN: removing stale lock $LOCK_FILE"
    rm -rf "$LOCK_FILE"
    mkdir "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE/pid"
trap cleanup_lock EXIT

mkdir -p "$BACKUP_STATE_DIR"
chmod 700 "$BACKUP_STATE_DIR"

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

    # SECURITY: Only stage explicitly listed safe paths: NEVER "git add -A"
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

# ---------- Step 2: copy only what changed to NanoClaw R2 ----------
# SECURITY: r2_delta.py only copies (additive). Files are NEVER deleted from
# R2 by this script. Cleanup of old files is a separate manual operation.
# Each run lists the local tree and uploads the files that differ from the
# manifests in $BACKUP_STATE_DIR; nothing is listed or HEADed on the R2 side.

if ! command -v rclone &>/dev/null; then
    log "ERROR: rclone not installed (brew install rclone)"
    exit 1
fi
if ! command -v python3 &>/dev/null; then
    log "ERROR: python3 not found, R2 backup skipped"
    exit 1
fi

UPLOADED_FILES=0
UPLOADED_BYTES=0
RUN_ERRORS=0
RUN_SOURCES=()

# r2_delta SRC SUFFIX KEYMODE FILTERS...  (md5 for files rewritten every run, else mtime)
r2_delta() {
    local src="$1" dest_suffix="$2" keymode="$3" out files bytes errs
    shift 3
    RUN_SOURCES+=("$dest_suffix")
    if ! out=$(python3 "$R2_DELTA" push "$src" "$dest_suffix" "$keymode" "$@" 2>> "$LOG_FILE") \
        || ! [[ "$out" =~ ^[0-9]+\ [0-9]+\ [0-9]+$ ]]; then
        log "ERROR: r2_delta failed for ${dest_suffix}"
        RUN_ERRORS=$((RUN_ERRORS + 1))
        return 1
    fi
    read -r files bytes errs <<< "$out"
    UPLOADED_FILES=$((UPLOADED_FILES + files))
    UPLOADED_BYTES=$((UPLOADED_BYTES + bytes))
    RUN_ERRORS=$((RUN_ERRORS + errs))
    [ "$errs" -eq 0 ]
}

# store/: atomic SQLite backup copies (not the live WAL-mode DBs)
r2_delta "$BACKUP_TMP/" "nanoclaw/store/db/" md5 \
    && log "copied atomic DB backups"

# store/: WhatsApp auth and other non-DB files
r2_delta "$NANOCLAW_DIR/store/" "nanoclaw/store/" mtime \
    --exclude "*.db" \
    --exclude "*.db-shm" \
    --exclude "*.db-wal" \
    --exclude "*.html" \
    --exclude ".backup/**" \
    && log "copied store/ (non-DB)"

# groups/: group data, conversations, CLAUDE.md
r2_delta "$NANOCLAW_DIR/groups/" "nanoclaw/groups/" mtime \
    --exclude "logs/**" \
    --exclude "ggml/**" \
    --exclude "gguf/**" \
    --exclude "node_modules/**" \
    --exclude ".archive/**" \
    && log "copied groups/"

# data/: session state (exclude transient IPC json)
r2_delta "$NANOCLAW_DIR/data/" "nanoclaw/data/" mtime \
    --exclude "ipc/*/messages/*.json" \
    --exclude "ipc/*/tasks/*.json" \
    --exclude "ipc/*/input/**" \
    --exclude "ipc/errors/**" \
    --exclude "lexios-sandbox/logs/**" \
    && log "copied data/"

# config/
if [ -d "$NANOCLAW_DIR/config/" ]; then
    r2_delta "$NANOCLAW_DIR/config/" "nanoclaw/config/" mtime \
        && log "copied config/"
fi

# .env: use temp dir (rclone copyto has a CreateBucket bug with R2)
if [ -f "$NANOCLAW_DIR/.env" ]; then
    tmp_env=$(mktemp -d)
    cp "$NANOCLAW_DIR/.env" "$tmp_env/dot-env"
    r2_delta "$tmp_env/" "nanoclaw/env/" md5 \
        && log "copied .env"
    rm -rf "$tmp_env"
fi

# ---------- Step 2b: Home dirs not covered elsewhere ----------
# Critical user data outside the nanoclaw/Lexios trees. On restore,
# permissions for ~/.ssh must be reset (chmod 600 id_rsa, 700 ~/.ssh).

# ~/Brain: Obsidian vault (Daily, Inbox, Architecture, synthesis notes)
if [ -d "$HOME/Brain" ]; then
    r2_delta "$HOME/Brain/" "home/Brain/" mtime \
        --exclude ".obsidian/workspace*" \
        --exclude ".obsidian/cache/**" \
        --exclude ".trash/**" \
        && log "copied ~/Brain/"
fi

# ~/.claude: distilled knowledge ONLY. Session transcripts expire on
# cleanupPeriodDays and history.jsonl holds every raw prompt; neither leaves this
# machine. What ships is the curated memory and the weekly session extracts.
if [ -d "$HOME/.claude/session-extracts" ]; then
    r2_delta "$HOME/.claude/session-extracts/" "home/claude/session-extracts/" mtime \
        --include "*.md" \
        && log "copied ~/.claude/session-extracts/"
fi

if [ -d "$HOME/.claude/projects" ]; then
    r2_delta "$HOME/.claude/projects/" "home/claude/memory/" mtime \
        --include "*/memory/**" \
        && log "copied ~/.claude memory/"
fi

# ~/.ssh: private keys, config, known_hosts (Tailscale, NN server, GitHub)
if [ -d "$HOME/.ssh" ]; then
    r2_delta "$HOME/.ssh/" "home/ssh/" mtime \
        --exclude "agent" \
        --exclude "*.old" \
        && log "copied ~/.ssh/"
fi

# ~/Downloads/Final report: HPM 523 coursework (graded paper, drafts)
if [ -d "$HOME/Downloads/Final report" ]; then
    r2_delta "$HOME/Downloads/Final report/" "home/Downloads-Final-report/" mtime \
        && log "copied ~/Downloads/Final report/"
fi

# ~/Library/LaunchAgents: only NanoClaw + Lexios plists (so bootstrap can rehydrate services)
LAUNCHD_TMP=$(mktemp -d)
cp "$HOME/Library/LaunchAgents/"com.nanoclaw.*.plist "$LAUNCHD_TMP/" 2>/dev/null || true
cp "$HOME/Library/LaunchAgents/"com.lexios.*.plist "$LAUNCHD_TMP/" 2>/dev/null || true
if [ -n "$(ls -A "$LAUNCHD_TMP" 2>/dev/null)" ]; then
    r2_delta "$LAUNCHD_TMP/" "home/LaunchAgents/" md5 \
        && log "copied LaunchAgents plists"
fi
rm -rf "$LAUNCHD_TMP"

# Day manifests and the day's list of sources go up in one copy per day; any
# that fail stay queued in $BACKUP_STATE_DIR/outbox for the next run.
python3 "$R2_DELTA" finish ${RUN_SOURCES[@]+"${RUN_SOURCES[@]}"} 2>> "$LOG_FILE" \
    || RUN_ERRORS=$((RUN_ERRORS + 1))

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

# DISABLED: Automatic snapshot pruning (every daily copy is kept)
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

MB=$((UPLOADED_BYTES / 1048576))
printf '{"date":"%s","finished":"%s","uploaded_files":%d,"uploaded_bytes":%d,"errors":%d}\n' \
    "$SNAPSHOT_DATE" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$UPLOADED_FILES" "$UPLOADED_BYTES" "$RUN_ERRORS" \
    > "$BACKUP_STATE_DIR/last-run.json.tmp"
mv "$BACKUP_STATE_DIR/last-run.json.tmp" "$BACKUP_STATE_DIR/last-run.json"
log "=== Backup complete (snapshot: ${SNAPSHOT_DATE}, uploaded: ${MB} MB in ${UPLOADED_FILES} files, errors: ${RUN_ERRORS}) ==="
[ "$RUN_ERRORS" -eq 0 ]
