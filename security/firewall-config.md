# macOS Firewall Configuration

**Status**: Enabled with Stealth Mode
**Last Updated**: 2026-03-13
**Task**: nc-sec-14

## Current Configuration

- **Firewall**: Enabled
- **Stealth Mode**: Enabled
- **Allow Signed Apps**: Enabled
- **Logging**: Enabled

## What Stealth Mode Does

Stealth mode prevents your Mac from responding to:
- ICMP ping requests
- Port scan probes on closed ports
- Other network reconnaissance techniques

This makes your Mac invisible to attackers performing network discovery on the LAN.

## Setup

Run the enable script (requires sudo):
```bash
sudo bash ~/nanoclaw/security/enable-firewall.sh
```

## Verification

Check firewall status:
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode
```

Expected output:
- Firewall is enabled. (State = 1)
- Stealth mode enabled

## Temporarily Disable (if needed for debugging)

Only disable if absolutely necessary for network troubleshooting:

```bash
# Disable firewall
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off

# Disable stealth mode
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off
```

## Re-enable

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on
```

## Firewall Logs

View recent firewall activity:
```bash
sudo log show --predicate 'subsystem == "com.apple.alf"' --info --last 1h
```

## Security Implications

**Benefits:**
- Protection against LAN-based port scans
- No response to ICMP ping (reduces attack surface)
- Application-level control over network access

**Limitations:**
- Firewall is application-layer only (not packet-filter like pf)
- Does not protect against attacks on allowed applications
- Stealth mode may interfere with some network diagnostic tools

## Additional Hardening (Future Tasks)

Consider:
- Configuring packet filter (pf) for network-layer filtering
- Setting up application-specific firewall rules
- Enabling FileVault disk encryption
- Configuring System Integrity Protection (SIP)
