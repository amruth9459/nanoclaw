#!/bin/bash
# nc-sec-14: Enable macOS firewall + stealth mode
# Run with: sudo bash ~/nanoclaw/security/enable-firewall.sh
set -euo pipefail

FW=/usr/libexec/ApplicationFirewall/socketfilterfw
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Before: Current Firewall Configuration ==="
$FW --getglobalstate
$FW --getstealthmode
$FW --getallowsigned
$FW --getloggingmode

# Save before state
{
  echo "=== Current Firewall Configuration ==="
  $FW --getglobalstate
  $FW --getstealthmode
  $FW --getallowsigned
  $FW --getloggingmode
} > "$DIR/firewall-status-before.txt"

echo ""
echo "=== Enabling Firewall ==="
$FW --setglobalstate on

echo "=== Enabling Stealth Mode ==="
$FW --setstealthmode on

echo "=== Allowing Signed Applications ==="
$FW --setallowsigned on

echo "=== Enabling Logging ==="
$FW --setloggingmode on

echo ""
echo "=== After: Firewall Configuration ==="
$FW --getglobalstate
$FW --getstealthmode
$FW --getallowsigned
$FW --getloggingmode

# Save after state
{
  echo "=== Firewall Configuration After Changes ==="
  $FW --getglobalstate
  $FW --getstealthmode
  $FW --getallowsigned
  $FW --getloggingmode
} > "$DIR/firewall-status-after.txt"

echo ""
echo "Done. Before/after snapshots saved to:"
echo "  $DIR/firewall-status-before.txt"
echo "  $DIR/firewall-status-after.txt"
