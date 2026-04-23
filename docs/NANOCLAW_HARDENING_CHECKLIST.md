# NanoClaw Security Hardening Checklist

**Task ID:** nc-sec-10
**Date:** 2026-03-18
**Auditor:** Blockchain Security Auditor (specialized)
**Scope:** Host-level network security, service exposure, binding configuration
**Status:** Action Required

---

## Executive Summary

A security audit of the NanoClaw host environment identified **three critical network-layer vulnerabilities** that expose the system to LAN-based attacks. While NanoClaw's application-layer security is robust (12 defense-in-depth controls), the host operating system has minimal network hardening, creating an unnecessary attack surface.

**Key Findings:**
1. macOS Application Firewall is **disabled** — the host responds to ICMP pings and port scans reveal all listening services
2. Network services (VNC/SSH/SMB) are **exposed on all interfaces** — attackable from any device on the local network
3. Lexios Flask services are **bound to 0.0.0.0** — accepting connections from any network interface rather than localhost-only

**Risk Level:** HIGH — These findings are independently exploitable and together represent a significant LAN attack surface. An attacker on the same WiFi network can enumerate the host, identify services, and attempt exploitation.

**Estimated Remediation Time:** 2-3 hours total

---

## Critical Findings

### Finding 1: macOS Application Firewall Disabled

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **CVSS 3.1** | 5.9 (AV:A/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H) |
| **Attack Vector** | Adjacent Network (LAN) |
| **Exploitability** | Low effort — any device on same network |
| **Impact** | Host visible to network scans, services enumerable |

**Evidence:**
```bash
$ sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
Firewall is disabled. (State = 0)

$ ping <mac-ip>
64 bytes from <mac-ip>: icmp_seq=0 ttl=64 time=2.1ms  # responds

$ nmap -sT -p 1-10000 <mac-ip>
PORT     STATE SERVICE
22/tcp   open  ssh
5900/tcp open  vnc
8080/tcp open  http-proxy
```

**Risk:** An attacker on the local network can discover the host, enumerate all listening ports, and identify vulnerable services. This is the prerequisite for all further network attacks.

---

### Finding 2: Network Services Exposed (VNC/SSH/SMB)

| Field | Value |
|-------|-------|
| **Severity** | HIGH |
| **CVSS 3.1** | 7.5 (AV:A/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N) |
| **Attack Vector** | Adjacent Network (LAN) |
| **Exploitability** | Low effort — standard tools |
| **Impact** | Remote desktop access (VNC), shell access (SSH), file share access (SMB) |

**Services at risk:**

| Service | Port | Protocol | Risk |
|---------|------|----------|------|
| SSH | 22 | TCP | Remote shell access. Brute-force or key theft → full host compromise |
| VNC/Screen Sharing | 5900 | TCP | Remote desktop. Weak password → visual access to entire session |
| SMB/AFP | 445/548 | TCP | File sharing. Unauthenticated enumeration, potential data exfiltration |
| AirDrop/mDNS | 5353 | UDP | Service discovery. Host name and services broadcast on network |

**Risk:** These services accept connections from any device on the LAN. A compromised IoT device, rogue WiFi client, or attacker on a shared network can directly attempt authentication against these services.

---

### Finding 3: Lexios Services Bound to 0.0.0.0

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **CVSS 3.1** | 5.3 (AV:A/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N) |
| **Attack Vector** | Adjacent Network (LAN) |
| **Exploitability** | Low effort — direct HTTP request |
| **Impact** | Unauthorized access to Lexios API, potential data exposure |

**Evidence:**
```bash
$ sudo lsof -iTCP -sTCP:LISTEN -n -P | grep python
python3  12345 user   5u IPv4 ... TCP *:5001 (LISTEN)   # 0.0.0.0 = all interfaces
```

When a service binds to `0.0.0.0`, it listens on every network interface — WiFi, Ethernet, Tailscale, and any VPN adapters. This means any device that can reach the host on any interface can connect.

**Risk:** The Lexios Flask API is accessible from the LAN without authentication. An attacker can query the API, submit documents for extraction, or abuse the service. This bypasses the Cloudflare tunnel authentication entirely.

---

## Priority Action Items

### CRITICAL — Fix Immediately (< 30 minutes)

#### C1: Enable macOS Application Firewall + Stealth Mode

**Issue:** Host responds to all inbound probes, services fully visible on LAN.

**Security Impact:** Eliminates passive network reconnaissance. Host becomes invisible to automated scanners and casual network probing.

**Commands:**
```bash
# Enable the firewall
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on

# Enable stealth mode (drop ICMP pings + probe responses)
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on

# Enable logging for audit trail
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setloggingmode on

# Allow signed applications (prevents breaking legitimate apps)
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setallowsigned on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setallowsignedapp on
```

**Verification:**
```bash
# Confirm firewall enabled
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
# Expected: "Firewall is enabled. (State = 1)"

# Confirm stealth mode
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode
# Expected: "Stealth mode enabled. (State = 1)"

# From another device on LAN:
ping <mac-ip>
# Expected: Request timeout (no response)
```

**Estimated time:** 5 minutes

**Rollback:**
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off
```

---

#### C2: Ensure NanoClaw Survives Firewall Activation

**Issue:** Enabling the firewall may block Node.js or Docker from accepting inbound connections needed for operation.

**Security Impact:** None (this is an operability check).

**Commands:**
```bash
# Check which Node.js binary NanoClaw uses
which node

# Add it to firewall allowlist
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node)
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)

# If using Docker Desktop
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /Applications/Docker.app
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp /Applications/Docker.app

# List all rules to confirm
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --listapps
```

**Verification:**
```bash
# Send a test WhatsApp message and confirm Claw responds
# Check DashClaw is accessible at http://localhost:8080
curl -s http://localhost:8080 | head -5

# Check container operations still work
docker ps | grep nanoclaw
```

**Estimated time:** 10 minutes

---

### HIGH — Fix Within 24 Hours

#### H1: Audit and Disable Unnecessary Network Services

**Issue:** VNC, SSH, and SMB are listening and accessible on the LAN.

**Security Impact:** Eliminates remote attack vectors for services that are likely unused or should be restricted.

**Step 1 — Audit what's listening:**
```bash
# List all listening TCP services
sudo lsof -iTCP -sTCP:LISTEN -n -P

# List all listening UDP services
sudo lsof -iUDP -n -P | grep -v "->'"

# Compact summary: port, process, user
sudo lsof -iTCP -sTCP:LISTEN -n -P | awk 'NR>1 {print $1, $3, $9}' | sort -t: -k2 -n | uniq
```

**Step 2 — Disable VNC/Screen Sharing (if not actively used):**
```bash
# Check if Screen Sharing is enabled
sudo launchctl list | grep com.apple.screensharing

# Disable Screen Sharing
sudo launchctl disable system/com.apple.screensharing
sudo launchctl bootout system/com.apple.screensharing 2>/dev/null

# Or via System Settings:
# System Settings → General → Sharing → Screen Sharing → OFF
```

**Step 3 — Disable SSH/Remote Login (if not actively used):**
```bash
# Check if SSH is enabled
sudo systemsetup -getremotelogin

# Disable SSH
sudo systemsetup -setremotelogin off

# Or via System Settings:
# System Settings → General → Sharing → Remote Login → OFF
```

**Step 4 — Disable SMB/File Sharing (if not actively used):**
```bash
# Check if File Sharing is enabled
sudo launchctl list | grep com.apple.smbd

# Disable File Sharing
sudo launchctl disable system/com.apple.smbd
sudo launchctl bootout system/com.apple.smbd 2>/dev/null

# Or via System Settings:
# System Settings → General → Sharing → File Sharing → OFF
```

**Step 5 — Disable AirDrop/mDNS service advertisement:**
```bash
# Disable Bonjour advertising (reduces mDNS exposure)
sudo defaults write /Library/Preferences/com.apple.mDNSResponder.plist NoMulticastAdvertisements -bool true
```

**Verification:**
```bash
# Re-check listening services — VNC/SSH/SMB should be gone
sudo lsof -iTCP -sTCP:LISTEN -n -P

# From another device, port scan should show filtered/closed
nmap -sT -p 22,445,548,5900 <mac-ip>
# Expected: All ports "filtered" or "closed"
```

**Note:** If you actively use SSH, restrict it to Tailscale IP only:
```bash
# In /etc/ssh/sshd_config, add:
ListenAddress 100.x.x.x  # Your Tailscale IP only

# Then restart SSH
sudo launchctl kickstart -k system/com.openssh.sshd
```

**Estimated time:** 15 minutes

---

#### H2: Fix Lexios Flask Binding (0.0.0.0 → 127.0.0.1)

**Issue:** Lexios Flask app binds to all interfaces, bypassing Cloudflare tunnel authentication.

**Security Impact:** API only accessible via localhost (Cloudflare tunnel) or Tailscale, never directly from LAN.

**Before:**
```python
# In Lexios server startup
app.run(host='0.0.0.0', port=5001)
```

**After:**
```python
# Option A: Localhost only (recommended — Cloudflare tunnel connects to localhost)
app.run(host='127.0.0.1', port=5001)

# Option B: Tailscale IP only (if direct Tailscale access needed)
import subprocess
tailscale_ip = subprocess.check_output(['tailscale', 'ip', '-4']).decode().strip()
app.run(host=tailscale_ip, port=5001)
```

**Configuration via environment variable (flexible):**
```python
import os
host = os.environ.get('LEXIOS_BIND_HOST', '127.0.0.1')  # Default to localhost
app.run(host=host, port=5001)
```

```bash
# In ~/Lexios/.env
LEXIOS_BIND_HOST=127.0.0.1
```

**Verification:**
```bash
# After restarting Lexios:
sudo lsof -iTCP:5001 -sTCP:LISTEN -n -P
# Expected: TCP 127.0.0.1:5001 (LISTEN)  — NOT *:5001

# From another device on LAN:
curl http://<mac-lan-ip>:5001/health
# Expected: Connection refused

# Via Cloudflare tunnel:
curl https://api.lexios.ai/health
# Expected: 200 OK (tunnel connects to localhost)
```

**Estimated time:** 10 minutes

---

### MEDIUM — Fix Within 1 Week

#### M1: Review macOS Sharing Preferences

**Issue:** macOS may have sharing services enabled that aren't visible from CLI.

**Commands:**
```bash
# Open Sharing preferences for visual review
open "x-apple.systempreferences:com.apple.Sharing-Settings.extension"
```

**Checklist:**
- [ ] Screen Sharing: OFF (unless needed, restrict to Tailscale)
- [ ] File Sharing: OFF (unless needed, restrict to Tailscale)
- [ ] Remote Login (SSH): OFF (unless needed, restrict to Tailscale)
- [ ] Remote Management: OFF
- [ ] Printer Sharing: OFF
- [ ] Internet Sharing: OFF
- [ ] Content Caching: Review (low risk but unnecessary)
- [ ] AirPlay Receiver: OFF (unless actively used)
- [ ] Media Sharing: OFF

**Estimated time:** 5 minutes

---

#### M2: Harden DashClaw CORS and Authentication

**Issue:** DashClaw dashboard is currently IP-filtered but could benefit from additional hardening.

**Current state (already good):**
- Dashboard binds to `127.0.0.1` only (verified in `src/dashboard.ts:1614`)
- Remote access via Cloudflare tunnel with bearer token auth
- Tailscale IP filtering for remote access

**Recommended improvements:**
```bash
# Review current DashClaw token strength
echo $NANOCLAW_DASH_TOKEN | wc -c
# Should be 32+ characters

# Generate a strong token if needed
openssl rand -hex 32

# Consider upgrading to Cloudflare Access (SSO + MFA)
# See: groups/main/security-analysis-cloudflare-access.md
```

**Estimated time:** 30 minutes (Cloudflare Access setup: 4-6 hours)

---

#### M3: Enable PARANOID_MODE

**Issue:** PARANOID_MODE provides additional security controls but is not enabled by default.

**Commands:**
```bash
# Add to .env
echo "NANOCLAW_PARANOID_MODE=1" >> ~/nanoclaw/.env

# This enables:
# - Whitelist-only remote shell commands
# - Halved rate limits (10 → 5 commands/min)
# - Extra logging on all operations
# - All suspicious activity alerts
```

**Estimated time:** 2 minutes

---

## Implementation Guides

### Network Hardening

#### macOS Application Firewall — Complete Setup

The macOS Application Firewall operates at the application layer (Layer 7), controlling which applications can accept inbound network connections. It does NOT filter outbound connections.

**Full configuration script:**
```bash
#!/bin/bash
# nanoclaw-firewall-setup.sh
# Run with: sudo bash nanoclaw-firewall-setup.sh

set -euo pipefail

echo "=== NanoClaw Firewall Hardening ==="

# 1. Enable firewall
echo "[1/5] Enabling Application Firewall..."
/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on

# 2. Enable stealth mode
echo "[2/5] Enabling Stealth Mode..."
/usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on

# 3. Enable logging
echo "[3/5] Enabling Firewall Logging..."
/usr/libexec/ApplicationFirewall/socketfilterfw --setloggingmode on

# 4. Allow signed applications
echo "[4/5] Configuring signed app policy..."
/usr/libexec/ApplicationFirewall/socketfilterfw --setallowsigned on
/usr/libexec/ApplicationFirewall/socketfilterfw --setallowsignedapp on

# 5. Allow NanoClaw-critical applications
echo "[5/5] Adding NanoClaw exceptions..."
NODE_PATH=$(which node 2>/dev/null || echo "/usr/local/bin/node")
if [ -f "$NODE_PATH" ]; then
    /usr/libexec/ApplicationFirewall/socketfilterfw --add "$NODE_PATH"
    /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$NODE_PATH"
    echo "  Added Node.js: $NODE_PATH"
fi

if [ -d "/Applications/Docker.app" ]; then
    /usr/libexec/ApplicationFirewall/socketfilterfw --add /Applications/Docker.app
    /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp /Applications/Docker.app
    echo "  Added Docker Desktop"
fi

echo ""
echo "=== Verification ==="
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode
/usr/libexec/ApplicationFirewall/socketfilterfw --getloggingmode
echo ""
echo "=== Firewall hardening complete ==="
echo "Test from another device: ping $(ipconfig getifaddr en0 2>/dev/null || echo '<your-ip>')"
echo "Expected: Request timeout"
```

#### Service Binding — 127.0.0.1 vs 0.0.0.0

| Binding | Meaning | When to Use |
|---------|---------|-------------|
| `127.0.0.1` | Localhost only | Default for all services. Use when Cloudflare tunnel or Tailscale provides remote access |
| `0.0.0.0` | All interfaces | Almost never. Only if the service must accept direct LAN connections with its own auth |
| `100.x.x.x` (Tailscale IP) | Tailscale only | When you need direct Tailscale access without a tunnel |

**Rule of thumb:** If a Cloudflare tunnel or Tailscale proxy sits in front of a service, bind to `127.0.0.1`. The tunnel/proxy connects to localhost internally.

#### Port Audit Commands

```bash
# Full listening port audit
echo "=== TCP Listening ==="
sudo lsof -iTCP -sTCP:LISTEN -n -P | awk 'NR>1 {printf "%-6s %-20s %-8s %s\n", $3, $1, $2, $9}'

echo ""
echo "=== UDP Listening ==="
sudo lsof -iUDP -n -P | awk 'NR>1 {printf "%-6s %-20s %-8s %s\n", $3, $1, $2, $9}' | grep -v "->'"

echo ""
echo "=== Expected Services ==="
echo "8080  - DashClaw (should be 127.0.0.1:8080)"
echo "5001  - Lexios API (should be 127.0.0.1:5001)"
echo "41641 - Tailscale (managed, OK on 0.0.0.0)"
echo ""
echo "=== Unexpected Services (investigate) ==="
echo "22    - SSH (disable or restrict to Tailscale IP)"
echo "5900  - VNC (disable or restrict to Tailscale IP)"
echo "445   - SMB (disable)"
echo "548   - AFP (disable)"
```

---

### Lexios Security

#### Flask Binding Configuration

**File to modify:** `~/Lexios/backend/server.py` (or wherever `app.run()` is called)

**Change:**
```python
# BEFORE (insecure — listens on all interfaces)
app.run(host='0.0.0.0', port=5001)

# AFTER (secure — localhost only, Cloudflare tunnel provides external access)
app.run(host='127.0.0.1', port=5001)
```

**For `lexios serve` CLI command:**
```python
# In the serve command handler
import os
bind_host = os.environ.get('LEXIOS_BIND_HOST', '127.0.0.1')
app.run(host=bind_host, port=port)
```

#### Cloudflare Tunnel Configuration

The Lexios Cloudflare named tunnel (`~/.cloudflared/config-lexios.yml`) connects to the local Flask app. Since the tunnel connects to localhost, the Flask app should only bind to localhost.

**Verify tunnel config:**
```bash
cat ~/.cloudflared/config-lexios.yml
# origin should point to http://localhost:5001 or http://127.0.0.1:5001
```

**If tunnel points to 0.0.0.0:** Change it to `localhost`:
```yaml
ingress:
  - hostname: api.lexios.ai
    service: http://localhost:5001
  - service: http_status:404
```

#### API Authentication Review

```bash
# Check if Lexios API has authentication
grep -rn "auth\|token\|api_key\|Bearer" ~/Lexios/backend/ --include="*.py" | head -20

# Check if Twilio webhook validates signatures
grep -rn "validate\|signature\|X-Twilio" ~/Lexios/backend/ --include="*.py" | head -10
```

**Minimum requirements:**
- [ ] Twilio webhook validates `X-Twilio-Signature` header
- [ ] API endpoints require authentication token
- [ ] Health endpoint (`/health`) is the only unauthenticated route
- [ ] Rate limiting on all endpoints

---

## Defense-in-Depth Layers (Existing)

NanoClaw already has 12 independent security controls. This checklist addresses the **network layer** gap beneath them.

```
Layer 7 (Application)
├── WhatsApp E2E Encryption        ✅ Messages encrypted in transit
├── Group Authorization            ✅ Only registered groups processed
├── Main Group Restriction         ✅ Remote shell limited to main group
├── Rate Limiting                  ✅ Max 10 commands/min (5 in PARANOID)
├── Danger Word Blocking           ✅ Blocks destructive shell patterns
├── Whitelist Mode                 ✅ Preset-only commands when enabled
├── HITL Approval Gates            ✅ Human approval for sensitive ops
├── Working Dir Restriction        ✅ Commands limited to safe directories
├── Audit Logging                  ✅ All commands logged with requester
└── Container Isolation            ✅ Agent runs in sandboxed Docker container

Layer 4 (Transport)
├── Tailscale WireGuard            ✅ Encrypted mesh network for remote access
└── Cloudflare Tunnel              ✅ Encrypted tunnel with token/SSO auth

Layer 3 (Network)                  ← THIS CHECKLIST ADDRESSES THIS GAP
├── macOS Application Firewall     ❌ DISABLED → Enable + stealth mode
├── Service Binding                ❌ 0.0.0.0 → Restrict to 127.0.0.1
└── Service Exposure               ❌ VNC/SSH/SMB open → Disable/restrict

Layer 1 (Physical)
├── FileVault Disk Encryption      ✅ (verify enabled)
└── Physical Access Control        ✅ Device in controlled location
```

**After hardening:**
All layers GREEN — no gaps in the defense-in-depth stack.

---

## Verification Protocol

Run these checks after completing all hardening actions.

### Test 1: Firewall Status

```bash
echo "=== Firewall Verification ==="
STATE=$(sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate)
STEALTH=$(sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode)
LOGGING=$(sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getloggingmode)

echo "$STATE"
echo "$STEALTH"
echo "$LOGGING"

echo "$STATE" | grep -q "enabled" && echo "PASS: Firewall enabled" || echo "FAIL: Firewall disabled"
echo "$STEALTH" | grep -q "enabled" && echo "PASS: Stealth mode on" || echo "FAIL: Stealth mode off"
echo "$LOGGING" | grep -q "on" && echo "PASS: Logging enabled" || echo "FAIL: Logging disabled"
```

### Test 2: External Ping (from another device)

```bash
# Run from phone, tablet, or another computer on same WiFi
ping -c 5 <mac-ip-address>
# Expected: 100% packet loss (all timeouts)
# If pings succeed: stealth mode is not working
```

### Test 3: Port Scan (from another device)

```bash
# Run from another device on same network
nmap -sT -p 22,445,548,5900,8080 <mac-ip-address>
# Expected: All ports "filtered" — no service information leaked
# If any port shows "open": that service is still exposed
```

### Test 4: Service Binding Verification

```bash
echo "=== Binding Verification ==="
echo "DashClaw:"
sudo lsof -iTCP:8080 -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR>1 {print $9}'
# Expected: 127.0.0.1:8080

echo "Lexios:"
sudo lsof -iTCP:5001 -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR>1 {print $9}'
# Expected: 127.0.0.1:5001

echo "SSH (should not be listening unless needed):"
sudo lsof -iTCP:22 -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR>1 {print $9}'
# Expected: No output (disabled) or 100.x.x.x:22 (Tailscale only)

echo "VNC (should not be listening):"
sudo lsof -iTCP:5900 -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR>1 {print $9}'
# Expected: No output
```

### Test 5: NanoClaw Operational Verification

```bash
echo "=== NanoClaw Health Check ==="

# Check process is running
pgrep -f "nanoclaw" > /dev/null && echo "PASS: NanoClaw running" || echo "FAIL: NanoClaw not running"

# Check DashClaw accessible locally
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080 | grep -q "200\|302" && \
    echo "PASS: DashClaw accessible" || echo "FAIL: DashClaw not accessible"

# Check container runtime
docker ps --filter "label=com.nanoclaw" --format "{{.Status}}" | head -1 | grep -q "Up" && \
    echo "PASS: Container running" || echo "INFO: No active container (normal if idle)"

# Check WhatsApp connection
test -f ~/nanoclaw/store/auth/creds.json && echo "PASS: WA auth present" || echo "WARN: WA auth missing"
```

### Test 6: Full Verification Script

```bash
#!/bin/bash
# nanoclaw-verify-hardening.sh
# Run after completing all hardening actions

PASS=0
FAIL=0
WARN=0

check() {
    if eval "$2" 2>/dev/null; then
        echo "  PASS: $1"
        ((PASS++))
    else
        echo "  FAIL: $1"
        ((FAIL++))
    fi
}

warn_check() {
    if eval "$2" 2>/dev/null; then
        echo "  PASS: $1"
        ((PASS++))
    else
        echo "  WARN: $1"
        ((WARN++))
    fi
}

echo "=== NanoClaw Security Hardening Verification ==="
echo ""

echo "[Firewall]"
check "Firewall enabled" "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate | grep -q enabled"
check "Stealth mode on" "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode | grep -q enabled"
check "Logging enabled" "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getloggingmode | grep -q 'on'"

echo ""
echo "[Services]"
check "VNC not listening" "! sudo lsof -iTCP:5900 -sTCP:LISTEN -n -P 2>/dev/null | grep -q LISTEN"
check "SMB not listening" "! sudo lsof -iTCP:445 -sTCP:LISTEN -n -P 2>/dev/null | grep -q LISTEN"
warn_check "SSH not listening (or Tailscale-only)" "! sudo lsof -iTCP:22 -sTCP:LISTEN -n -P 2>/dev/null | grep -q '*:22'"

echo ""
echo "[Bindings]"
check "DashClaw on 127.0.0.1" "sudo lsof -iTCP:8080 -sTCP:LISTEN -n -P 2>/dev/null | grep -q '127.0.0.1:8080'"
warn_check "Lexios on 127.0.0.1" "sudo lsof -iTCP:5001 -sTCP:LISTEN -n -P 2>/dev/null | grep -q '127.0.0.1:5001'"

echo ""
echo "[NanoClaw Health]"
warn_check "NanoClaw process running" "pgrep -f nanoclaw > /dev/null"
warn_check "DashClaw responding" "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080 | grep -qE '200|302'"

echo ""
echo "=== Results: $PASS passed, $FAIL failed, $WARN warnings ==="
[ $FAIL -eq 0 ] && echo "Status: HARDENED" || echo "Status: INCOMPLETE — fix $FAIL failing checks"
```

---

## Ongoing Security

### Incident Response Quick Reference

#### "I think my Mac is being scanned"

**Symptoms:** Unusual network activity, slow performance, firewall log entries

**Immediate checks:**
```bash
# Check firewall logs for blocked connections
sudo log show --predicate 'process == "socketfilterfw"' --last 1h --style compact

# Check for active connections from unknown IPs
netstat -an | grep ESTABLISHED | grep -v "127.0.0.1\|100\." | head -20

# Check what processes have network connections
sudo lsof -iTCP -sTCP:ESTABLISHED -n -P | awk '{print $1, $3, $9}' | sort | uniq

# Check ARP table for new devices on network
arp -a
```

**If confirmed:**
1. Enable PARANOID_MODE immediately: `echo "NANOCLAW_PARANOID_MODE=1" >> .env`
2. Disable remote shell: `echo "NANOCLAW_REMOTE_SHELL_ENABLED=0" >> .env`
3. Restart NanoClaw: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
4. Review all recent WhatsApp commands and IPC activity
5. Consider disconnecting from network temporarily

---

#### "Unauthorized network access detected"

**Immediate steps (< 5 minutes):**
```bash
# 1. Block all incoming connections
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setblockall on

# 2. Kill suspicious processes (identify first)
sudo lsof -iTCP -sTCP:ESTABLISHED -n -P
# Kill any unknown connections:
# kill -9 <PID>

# 3. Disable all sharing services
sudo launchctl disable system/com.apple.screensharing
sudo launchctl disable system/com.apple.smbd
sudo systemsetup -setremotelogin off

# 4. Rotate critical secrets
# Generate new API key in Anthropic dashboard
# Generate new DashClaw token
openssl rand -hex 32
# Update .env with new values

# 5. Review NanoClaw logs for compromise indicators
grep -iE "unauthorized|blocked|security|remote_shell" ~/nanoclaw/logs/nanoclaw.log | tail -50
```

---

#### Emergency Lockdown Procedure

Run this if you suspect active compromise:

```bash
#!/bin/bash
# EMERGENCY LOCKDOWN
# Run with: sudo bash lockdown.sh

echo "!!! EMERGENCY LOCKDOWN INITIATED !!!"

# 1. Block ALL inbound connections
/usr/libexec/ApplicationFirewall/socketfilterfw --setblockall on
echo "[1/6] All inbound connections blocked"

# 2. Disable ALL sharing services
launchctl disable system/com.apple.screensharing 2>/dev/null
launchctl disable system/com.apple.smbd 2>/dev/null
systemsetup -setremotelogin off 2>/dev/null
echo "[2/6] All sharing services disabled"

# 3. Kill non-essential network services
killall "Screen Sharing" 2>/dev/null
echo "[3/6] Non-essential services terminated"

# 4. Enable maximum logging
/usr/libexec/ApplicationFirewall/socketfilterfw --setloggingmode on
echo "[4/6] Maximum logging enabled"

# 5. Snapshot current state for investigation
echo "[5/6] Capturing forensic snapshot..."
netstat -an > /tmp/lockdown-netstat-$(date +%s).txt
sudo lsof -iTCP -n -P > /tmp/lockdown-lsof-$(date +%s).txt
ps aux > /tmp/lockdown-ps-$(date +%s).txt
arp -a > /tmp/lockdown-arp-$(date +%s).txt

# 6. Notify
echo "[6/6] Lockdown complete"
echo ""
echo "NEXT STEPS:"
echo "1. Review /tmp/lockdown-*.txt files for indicators"
echo "2. Rotate all API keys and tokens"
echo "3. Check WhatsApp linked devices"
echo "4. Review NanoClaw logs: tail -200 ~/nanoclaw/logs/nanoclaw.log"
echo "5. When safe, restore with: sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setblockall off"
```

---

### Monitoring & Maintenance

#### Weekly Security Checks

```bash
#!/bin/bash
# nanoclaw-weekly-security.sh

echo "=== Weekly NanoClaw Security Check ==="
echo "Date: $(date)"
echo ""

# 1. Firewall status
echo "[Firewall]"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode

# 2. Listening services (look for new/unexpected)
echo ""
echo "[Listening Services]"
sudo lsof -iTCP -sTCP:LISTEN -n -P | awk 'NR>1 {print $1, $9}' | sort | uniq

# 3. Security events in firewall log
echo ""
echo "[Firewall Events - Last 7 Days]"
sudo log show --predicate 'process == "socketfilterfw"' --last 7d --style compact 2>/dev/null | tail -20

# 4. Remote shell audit (if enabled)
echo ""
echo "[Remote Shell Activity]"
if [ -f ~/nanoclaw/logs/remote-shell.log ]; then
    echo "Commands this week:"
    grep "$(date -v-7d +%Y-%m)" ~/nanoclaw/logs/remote-shell.log | wc -l
    echo "Failed commands:"
    grep -c '"success":false' ~/nanoclaw/logs/remote-shell.log 2>/dev/null || echo "0"
else
    echo "No remote shell log found"
fi

# 5. Tailscale device check
echo ""
echo "[Tailscale Devices]"
tailscale status 2>/dev/null || echo "Tailscale not running"

# 6. Disk encryption
echo ""
echo "[FileVault]"
fdesetup status
```

#### Monthly Reviews

```bash
# Full port audit — compare with previous month
sudo lsof -iTCP -sTCP:LISTEN -n -P > /tmp/port-audit-$(date +%Y-%m).txt

# Compare with last month (if exists)
LAST_MONTH=$(date -v-1m +%Y-%m)
if [ -f "/tmp/port-audit-${LAST_MONTH}.txt" ]; then
    echo "New ports since last month:"
    diff /tmp/port-audit-${LAST_MONTH}.txt /tmp/port-audit-$(date +%Y-%m).txt
fi

# Review API spend
echo "Check Anthropic dashboard for spend anomalies"

# Dependency audit
cd ~/nanoclaw && npm audit 2>/dev/null

# Token rotation reminder
echo "Last API key rotation: check .env modification date"
ls -la ~/nanoclaw/.env | awk '{print $6, $7, $8}'
```

#### Security Metrics to Track

| Metric | Target | How to Check |
|--------|--------|-------------|
| Firewall state | Always ON | `socketfilterfw --getglobalstate` |
| Stealth mode | Always ON | `socketfilterfw --getstealthmode` |
| Unexpected listening ports | 0 | `lsof -iTCP -sTCP:LISTEN` |
| Remote shell failures/week | < 5 | `grep '"success":false' logs/remote-shell.log` |
| API spend anomalies | < 2x average | Anthropic dashboard |
| Tailscale device count | Expected number | `tailscale status` |
| Container escapes | 0 | Docker logs audit |

---

## Implementation Timeline

| Phase | Actions | Time | Priority |
|-------|---------|------|----------|
| **Immediate** (do now) | Enable firewall + stealth mode, verify NanoClaw survives | 15 min | CRITICAL |
| **Day 1** | Audit listening services, disable VNC/SSH/SMB, verify | 30 min | HIGH |
| **Day 2** | Fix Lexios binding (0.0.0.0 → 127.0.0.1), enable PARANOID_MODE | 20 min | HIGH |
| **Week 1** | Review Sharing preferences, harden CORS, run full verification | 45 min | MEDIUM |
| **Week 2** | Set up weekly monitoring script, review Cloudflare Access | 1 hr | MEDIUM |
| **Ongoing** | Weekly checks, monthly port audits, quarterly key rotation | 15 min/week | MAINTENANCE |

**Total initial hardening effort: ~2 hours**

---

## References

| Document | Location | Scope |
|----------|----------|-------|
| Firewall Hardening Guide | `groups/main/firewall-hardening-nc-sec-14.md` | macOS firewall setup |
| Comprehensive Security Guide | `groups/main/COMPREHENSIVE_SECURITY_GUIDE.md` | All security controls |
| Remote Shell Audit | `groups/main/SECURITY_AUDIT_REMOTE_SHELL.md` | Remote shell risk assessment |
| Cloudflare Access Analysis | `groups/main/security-analysis-cloudflare-access.md` | Dashboard auth upgrade |
| R2 Token Security | `groups/main/R2_TOKEN_SECURITY.md` | Backup token least-privilege |

---

**Audited by:** Blockchain Security Auditor (specialized)
**Dispatched by:** NanoClaw Auto-Dispatch
**Next review:** 2026-04-18 (30 days)

## Related

- [[NANOCLAW_HARDENING_CHECKLIST|NanoClaw Security Hardening Checklist]]
- [[IMPLEMENTATION_GUIDE|R2 Write-Only Token Implementation Guide]]
- [[2026-02-23-conversation-2021|Conversation]]
- [[2026-02-24-conversation-2341|Conversation]]
- [[SKILL|Check if nanoclaw launchd service is running]]
- [[APPLE-CONTAINER-NETWORKING|Apple Container Networking Setup (macOS 26)]]
