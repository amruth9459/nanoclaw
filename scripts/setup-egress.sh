#!/usr/bin/env bash
# NanoClaw Container Egress Hardening
#
# Does two things:
#   1. Sets up a pf anchor to restrict container egress to api.anthropic.com only.
#      Works directly with Apple Container. On Docker Desktop (Linux VM), it targets
#      the VM's subnet, providing partial protection.
#   2. Creates a nanoclaw-restricted Docker network (bridge, no external access)
#      for OCR and other air-gapped containers.
#
# Usage:
#   sudo ./scripts/setup-egress.sh            # first-time setup (requires sudo for pf)
#   sudo ./scripts/setup-egress.sh --refresh  # update allowed IPs (run weekly or via cron)

set -euo pipefail

ANCHOR_NAME="nanoclaw_egress"
ANCHOR_CONF="/etc/pf.anchors/nanoclaw"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/nanoclaw-egress.conf"

ALLOWED_DOMAINS=(
  "api.anthropic.com"
)

# ── 1. Resolve allowed domains to IPs ──────────────────────────────────────────
echo "Resolving allowed domains..."
ALLOWED_IPS=()
for domain in "${ALLOWED_DOMAINS[@]}"; do
  while IFS= read -r ip; do
    [[ -n "$ip" ]] && ALLOWED_IPS+=("$ip")
  done < <(dig +short "$domain" A 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
done

if [[ ${#ALLOWED_IPS[@]} -eq 0 ]]; then
  echo "ERROR: Could not resolve IPs for ${ALLOWED_DOMAINS[*]}"
  echo "       Check your internet connection and try again."
  exit 1
fi

echo "Resolved IPs for api.anthropic.com:"
printf "  %s\n" "${ALLOWED_IPS[@]}"

# ── 2. Write pf anchor ─────────────────────────────────────────────────────────
sudo mkdir -p /etc/pf.anchors

# Copy template and patch in resolved IPs
IP_LIST=$(IFS=", "; echo "${ALLOWED_IPS[*]}")
sed "s|table <nanoclaw_allowed_egress> persist|table <nanoclaw_allowed_egress> persist { ${IP_LIST} }|" \
  "$TEMPLATE" | sudo tee "$ANCHOR_CONF" > /dev/null

echo "Wrote anchor config: $ANCHOR_CONF"

# ── 3. Hook anchor into /etc/pf.conf (idempotent) ─────────────────────────────
PF_CONF="/etc/pf.conf"
if ! grep -q "$ANCHOR_NAME" "$PF_CONF" 2>/dev/null; then
  printf '\n# NanoClaw egress filter\nanchor "%s"\nload anchor "%s" from "%s"\n' \
    "$ANCHOR_NAME" "$ANCHOR_NAME" "$ANCHOR_CONF" | sudo tee -a "$PF_CONF" > /dev/null
  echo "Added anchor to $PF_CONF"
else
  echo "Anchor already in $PF_CONF — refreshing rules only"
  sudo pfctl -a "$ANCHOR_NAME" -f "$ANCHOR_CONF" 2>/dev/null || true
fi

# Enable pf and load rules
sudo pfctl -e 2>/dev/null || true   # enable (no-op if already enabled)
sudo pfctl -f "$PF_CONF" 2>/dev/null && echo "pf rules loaded" || echo "Warning: pfctl reload failed (may need reboot)"

# ── 4. Install persistence launchd plist ──────────────────────────────────────
PLIST_SRC="${SCRIPT_DIR}/com.nanoclaw.egress.plist"
PLIST_DST="/Library/LaunchDaemons/com.nanoclaw.egress.plist"

if [[ -f "$PLIST_SRC" ]]; then
  sudo cp "$PLIST_SRC" "$PLIST_DST"
  sudo launchctl load -w "$PLIST_DST" 2>/dev/null || true
  echo "Installed launchd plist: $PLIST_DST"
fi

# ── 5. Create isolated Docker network for air-gapped containers ───────────────
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  if ! docker network inspect nanoclaw-restricted &>/dev/null 2>&1; then
    docker network create \
      --driver bridge \
      --internal \
      --label "nanoclaw=restricted" \
      nanoclaw-restricted
    echo "Created Docker network: nanoclaw-restricted (no external internet)"
  else
    echo "Docker network nanoclaw-restricted already exists"
  fi
else
  echo "Docker not running — skipping network creation (run again after starting Docker)"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  NanoClaw Egress Hardening Complete                           ║"
echo "║                                                               ║"
echo "║  pf anchor: restricts container subnets to api.anthropic.com ║"
echo "║  Docker:    nanoclaw-restricted network (air-gapped, no net)  ║"
echo "║                                                               ║"
echo "║  NOTE: Docker Desktop on macOS runs containers in a Linux VM. ║"
echo "║  The pf anchor targets the VM subnet, not individual          ║"
echo "║  containers. For per-container isolation, use containerConfig ║"
echo "║  networkRestricted: true in registered_groups.json            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
