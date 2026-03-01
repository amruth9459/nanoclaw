#!/usr/bin/env bash
set -euo pipefail

# Restore NanoClaw + Lexios state from Cloudflare R2 + GitHub.
# Run on a fresh Mac to resume where you left off.

R2_REMOTE="${R2_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-nanoclaw-backup}"
NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw}"
LEXIOS_DIR="${LEXIOS_DIR:-$HOME/Lexios}"

echo "=== NanoClaw + Lexios Restore ==="
echo "NanoClaw dir: $NANOCLAW_DIR"
echo "Lexios dir:   $LEXIOS_DIR"
echo ""

# ---------- Prerequisites ----------

if ! command -v rclone &>/dev/null; then
    echo "ERROR: rclone not installed. Run: brew install rclone && rclone config"
    echo "You need an R2 remote named '${R2_REMOTE}' pointing to your Cloudflare R2 bucket."
    exit 1
fi

if ! command -v git &>/dev/null; then
    echo "ERROR: git not installed."
    exit 1
fi

# ---------- Step 1: Clone repos if not present ----------

if [ ! -d "$NANOCLAW_DIR/.git" ]; then
    echo "Cloning NanoClaw..."
    git clone https://github.com/amruth9459/nanoclaw.git "$NANOCLAW_DIR"
    cd "$NANOCLAW_DIR"
    git remote rename origin fork
    git remote add origin https://github.com/qwibitai/nanoclaw.git
else
    echo "NanoClaw repo exists at $NANOCLAW_DIR"
fi

if [ ! -d "$LEXIOS_DIR/.git" ]; then
    echo "Cloning Lexios..."
    git clone https://github.com/amruth9459/Lexios-NanoClaw.git "$LEXIOS_DIR"
else
    echo "Lexios repo exists at $LEXIOS_DIR"
fi

# ---------- Step 2: Restore NanoClaw runtime data from R2 ----------

RCLONE_FLAGS=(--transfers 8 --checkers 16 --fast-list --progress)

echo ""
echo "Restoring NanoClaw runtime data from R2..."

mkdir -p "$NANOCLAW_DIR"/{store,groups,data,config,logs}

rclone copy "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/store/" "$NANOCLAW_DIR/store/" \
    "${RCLONE_FLAGS[@]}"

rclone copy "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/groups/" "$NANOCLAW_DIR/groups/" \
    "${RCLONE_FLAGS[@]}"

rclone copy "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/data/" "$NANOCLAW_DIR/data/" \
    "${RCLONE_FLAGS[@]}"

rclone copy "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/config/" "$NANOCLAW_DIR/config/" \
    "${RCLONE_FLAGS[@]}"

rclone copy "${R2_REMOTE}:${R2_BUCKET}/nanoclaw/env/" /tmp/nanoclaw-env-restore/ \
    --progress 2>/dev/null && mv /tmp/nanoclaw-env-restore/dot-env "$NANOCLAW_DIR/.env" && rm -rf /tmp/nanoclaw-env-restore \
    || echo "WARN: no .env found in R2 (you may need to create one)"

# ---------- Step 3: Restore Lexios runtime data from R2 ----------

echo ""
echo "Restoring Lexios runtime data from R2..."

mkdir -p "$LEXIOS_DIR/backend"/{uploads,database}

rclone copy "${R2_REMOTE}:${R2_BUCKET}/lexios/backend/uploads/" "$LEXIOS_DIR/backend/uploads/" \
    "${RCLONE_FLAGS[@]}" 2>/dev/null || echo "WARN: no Lexios uploads in R2"

rclone copy "${R2_REMOTE}:${R2_BUCKET}/lexios/backend/database/" "$LEXIOS_DIR/backend/database/" \
    "${RCLONE_FLAGS[@]}" 2>/dev/null || echo "WARN: no Lexios database in R2"

# ---------- Step 4: Next steps ----------

echo ""
echo "=== Restore complete ==="
echo ""
echo "Next steps:"
echo "  1. cd $NANOCLAW_DIR && npm install && npm run build"
echo "  2. Review .env file: $NANOCLAW_DIR/.env"
echo "  3. Rebuild container: ./container/build.sh"
echo "  4. Load services:"
echo "     launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist"
echo "     launchctl load ~/Library/LaunchAgents/com.nanoclaw.backup.plist"
echo "     launchctl load ~/Library/LaunchAgents/com.nanoclaw.cloudflared.plist"
echo "  5. Verify: tail -f $NANOCLAW_DIR/logs/current.log"
