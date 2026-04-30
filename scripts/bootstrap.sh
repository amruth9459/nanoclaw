#!/usr/bin/env bash
set -euo pipefail

# ----------------------------------------------------------------------
# 1-click full-system restore for NanoClaw + Lexios
#
# Run on a fresh Mac, Linux box, or VPS to rehydrate everything from
# R2 + GitHub: source code, runtime data, ~/Brain, ~/.ssh, coursework,
# launchd services. Idempotent — safe to re-run.
#
# Usage (interactive — prompts for R2 creds):
#   curl -fsSL https://raw.githubusercontent.com/amruth9459/nanoclaw/main/scripts/bootstrap.sh | bash
#
# Usage (non-interactive — pre-set creds via env):
#   R2_ACCESS_KEY=... R2_SECRET_KEY=... R2_ENDPOINT=https://....r2.cloudflarestorage.com \
#     bash <(curl -fsSL https://raw.githubusercontent.com/amruth9459/nanoclaw/main/scripts/bootstrap.sh)
#
# The R2 creds live in your private Google Drive copy of NanoClaw-Contingency.md.
# ----------------------------------------------------------------------

R2_BUCKET="${R2_BUCKET:-nanoclaw-backup}"
NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw}"
LEXIOS_DIR="${LEXIOS_DIR:-$HOME/Lexios}"

PLATFORM="$(uname -s)"
case "$PLATFORM" in
    Darwin) PLATFORM=macos ;;
    Linux)  PLATFORM=linux ;;
    *)      echo "ERROR: unsupported platform $PLATFORM"; exit 1 ;;
esac

say() { printf "\n\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33mWARN:\033[0m %s\n" "$*"; }
die() { printf "\033[1;31mERROR:\033[0m %s\n" "$*" >&2; exit 1; }

# ---------- Step 1: Prerequisites ----------

say "Step 1/7: Installing prerequisites ($PLATFORM)"

if [ "$PLATFORM" = macos ]; then
    if ! command -v brew &>/dev/null; then
        say "Installing Homebrew"
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        # Apple Silicon: add brew to PATH for this shell
        [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    brew install rclone git node@20 python@3.12 cloudflared 2>&1 | tail -5 || true
    brew link --overwrite --force node@20 2>/dev/null || true
elif [ "$PLATFORM" = linux ]; then
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq
        sudo apt-get install -y -qq curl git python3 python3-venv python3-pip rclone unzip
        # Node 20 via NodeSource
        if ! command -v node &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y -qq nodejs
        fi
    else
        die "Only apt-get-based Linux is supported in bootstrap. Install rclone/git/node/python3 manually then re-run."
    fi
fi

for cmd in rclone git node python3; do
    command -v "$cmd" >/dev/null || die "$cmd not on PATH after install"
done

# ---------- Step 2: rclone R2 config ----------

say "Step 2/7: Configuring rclone R2 remote"

if rclone listremotes 2>/dev/null | grep -q '^r2:'; then
    say "rclone 'r2' remote already configured — skipping"
else
    if [ -z "${R2_ACCESS_KEY:-}" ]; then
        echo "Enter R2 credentials (find them in Google Drive: NanoClaw-Contingency.md)"
        read -rp "R2 Access Key: " R2_ACCESS_KEY
        read -rsp "R2 Secret Key: " R2_SECRET_KEY; echo
        read -rp "R2 Endpoint URL (https://<account>.r2.cloudflarestorage.com): " R2_ENDPOINT
    fi
    [ -n "${R2_ACCESS_KEY:-}" ] && [ -n "${R2_SECRET_KEY:-}" ] && [ -n "${R2_ENDPOINT:-}" ] \
        || die "R2 credentials missing"

    rclone config create r2 s3 \
        provider Cloudflare \
        access_key_id "$R2_ACCESS_KEY" \
        secret_access_key "$R2_SECRET_KEY" \
        endpoint "$R2_ENDPOINT" \
        --non-interactive >/dev/null
    say "rclone 'r2' configured"
fi

# Sanity check: can we list the bucket?
rclone lsd "r2:${R2_BUCKET}/latest/" >/dev/null 2>&1 \
    || die "Cannot list r2:${R2_BUCKET}/latest/ — check creds + bucket name"

# ---------- Step 3: Restore SSH keys FIRST (so SSH cloning Lexios works) ----------

say "Step 3/7: Restoring ~/.ssh from R2"

mkdir -p "$HOME/.ssh"
rclone copy "r2:${R2_BUCKET}/latest/home/ssh/" "$HOME/.ssh/" --transfers 4 -q || warn "no ~/.ssh in R2"
chmod 700 "$HOME/.ssh"
[ -f "$HOME/.ssh/id_rsa" ]      && chmod 600 "$HOME/.ssh/id_rsa"
[ -f "$HOME/.ssh/config" ]      && chmod 600 "$HOME/.ssh/config"
[ -f "$HOME/.ssh/known_hosts" ] && chmod 644 "$HOME/.ssh/known_hosts"
[ -f "$HOME/.ssh/id_rsa.pub" ]  && chmod 644 "$HOME/.ssh/id_rsa.pub"

# Pre-trust github.com so the SSH clone for Lexios doesn't prompt
ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
sort -u -o "$HOME/.ssh/known_hosts" "$HOME/.ssh/known_hosts" 2>/dev/null || true

# ---------- Step 4: Clone + restore NanoClaw ----------

say "Step 4/7: Cloning + restoring NanoClaw → $NANOCLAW_DIR"

if [ ! -d "$NANOCLAW_DIR/.git" ]; then
    git clone https://github.com/amruth9459/nanoclaw.git "$NANOCLAW_DIR"
    git -C "$NANOCLAW_DIR" remote rename origin fork
    git -C "$NANOCLAW_DIR" remote add origin https://github.com/qwibitai/nanoclaw.git
fi
bash "$NANOCLAW_DIR/scripts/restore.sh"

# ---------- Step 5: Clone + restore Lexios ----------

say "Step 5/7: Cloning + restoring Lexios → $LEXIOS_DIR"

if [ ! -d "$LEXIOS_DIR/.git" ]; then
    # Use HTTPS — matches the auto-backup remote URL — avoids SSH key dependency on first clone.
    git clone https://github.com/amruth9459/Lexios-NanoClaw.git "$LEXIOS_DIR"
fi
bash "$LEXIOS_DIR/scripts/restore.sh"

# ---------- Step 6: Build NanoClaw + load services (macOS only) ----------

say "Step 6/7: Building NanoClaw"

cd "$NANOCLAW_DIR"
npm install --silent
npm run build

if [ "$PLATFORM" = macos ]; then
    say "Loading launchd services"
    for plist in com.nanoclaw com.nanoclaw.backup com.nanoclaw.cloudflared com.nanoclaw.mlx-server \
                 com.lexios.backup com.lexios.serve com.lexios.cloudflared; do
        f="$HOME/Library/LaunchAgents/${plist}.plist"
        if [ -f "$f" ]; then
            launchctl unload "$f" 2>/dev/null || true
            launchctl load "$f" 2>/dev/null && echo "  loaded $plist" || warn "$plist failed to load"
        fi
    done

    # Container image (Apple Container or Docker)
    if [ -x "$NANOCLAW_DIR/container/build.sh" ]; then
        say "Building agent container (this takes 5-10 min)"
        "$NANOCLAW_DIR/container/build.sh" || warn "container build failed — run manually"
    fi
else
    warn "VPS / Linux: launchd services + Docker container build skipped (macOS-specific). Use systemd / docker manually."
fi

# ---------- Step 7: Verify ----------

say "Step 7/7: Verification"

echo "  NanoClaw repo:    $(git -C "$NANOCLAW_DIR" log -1 --format='%h %s')"
echo "  Lexios repo:      $(git -C "$LEXIOS_DIR" log -1 --format='%h %s')"
echo "  ~/Brain files:    $(find "$HOME/Brain" -type f 2>/dev/null | wc -l | tr -d ' ')"
echo "  ~/.ssh files:     $(ls "$HOME/.ssh" 2>/dev/null | wc -l | tr -d ' ')"
echo "  HPM523 files:     $(ls "$HOME/Downloads/Final report" 2>/dev/null | wc -l | tr -d ' ')"
[ "$PLATFORM" = macos ] && echo "  launchd services: $(launchctl list 2>/dev/null | grep -cE 'com\.(nanoclaw|lexios)')"

cat <<EOF

==========================================
   Bootstrap complete.
==========================================
Verify:
  tail -f $NANOCLAW_DIR/logs/nanoclaw.error.log
  tail -f $NANOCLAW_DIR/logs/backup.log
  cd $NANOCLAW_DIR && npm run build && node dist/index.js   # manual run

If you didn't restore on macOS, you must:
  - Re-create launchd / systemd services for the backup loop
  - Install Docker (or run agents another way)
EOF
