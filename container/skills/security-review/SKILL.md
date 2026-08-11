---
name: security-review
description: Run a full security audit of the NanoClaw codebase. Checks for secrets, injection vectors, IPC auth bypasses, and HITL gaps. Sends a report to WhatsApp.
allowed-tools: Bash, Read, Glob, Grep
---

You are running a security review of the NanoClaw codebase at `/workspace/project`.

Work through these checks in order and keep notes. At the end, send a single WhatsApp report.

---

## 1. Recent Changes (since last 24h)

```bash
git -C /workspace/project log --since="24 hours ago" --oneline --name-only
git -C /workspace/project diff HEAD~1 --stat 2>/dev/null || true
```

For each changed file, note if it touches: IPC, auth, container args, hooks, or HITL.

---

## 2. Hardcoded Secrets Scan

```bash
grep -rn \
  -e "sk-ant-" \
  -e "ANTHROPIC_API_KEY\s*=" \
  -e "password\s*=\s*['\"][^'\"]\+" \
  -e "secret\s*=\s*['\"][^'\"]\+" \
  /workspace/project/src/ \
  /workspace/project/container/ \
  --include="*.ts" --include="*.js" --include="*.json" 2>/dev/null | grep -v "node_modules" | grep -v ".env.example"
```

Flag any hits. Ignore variable declarations that read from env (e.g. `process.env.KEY`).

---

## 3. IPC Authorization Audit

Read `/workspace/project/src/ipc.ts` and verify:
- Non-main groups cannot send to other groups' JIDs
- `isMain` is derived from directory path (not from IPC file content)
- The HITL gate fires when `isMain && !targetGroup`

Check for any new `case` branches in `processTaskIpc` that lack authorization checks.

---

## 4. HITL Gate Audit

Read `/workspace/project/src/hitl.ts` and verify:
- Approval tokens are cryptographically random (crypto.randomBytes)
- Expiry is enforced before execute()
- No way to bypass gate by sending a message to a registered JID from an unregistered one

---

## 5. Security Hook Audit

Read `/workspace/project/container/agent-runner/src/index.ts` (the `createSecurityHook` function) and verify:
- Self-mutation pattern covers redirect variants (>, >>, tee)
- rm -rf pattern checks both -rf and --recursive --force
- Network exfiltration check is active when NANOCLAW_NETWORK_RESTRICTED=1

---

## 6. Container Args Audit

Read `/workspace/project/src/container-runner.ts` and verify:
- Secrets are passed via stdin only (never as -e flags)
- Mount allowlist is loaded from outside the project root (tamper-proof)
- `networkRestricted` containers use the correct Docker network

---

## 7. Security Block Log Review

```bash
# Check if any security blocks fired in the last 24h
find /workspace/project/groups/*/logs -name "*.log" -newer /workspace/project/groups/main/logs -exec grep -l "SECURITY BLOCK\|HITL\|Unauthorized" {} \; 2>/dev/null | head -20
grep -rn "SECURITY BLOCK\|HITL: approval\|Unauthorized IPC" /workspace/project/groups/*/logs/ 2>/dev/null | tail -50
```

---

## 8. Dependency Vulnerability Check

```bash
cd /workspace/project && npm audit --json 2>/dev/null | \
  node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const r=JSON.parse(d); const vulns=r.vulnerabilities||{}; const highs=Object.entries(vulns).filter(([,v])=>['high','critical'].includes(v.severity)); console.log(highs.length>0?'HIGH/CRITICAL: '+highs.map(([n])=>n).join(', '):'No high/critical vulns');" 2>/dev/null || echo "npm audit unavailable"
```

---

## Report Format

Send a WhatsApp message using this format (WhatsApp formatting only — no markdown headings):

```
🛡️ *Nightly Security Report* — {date}

*Changes reviewed:* {N files changed in 24h}

*Findings:*
• {finding 1 or "None"}
• {finding 2}

*Secrets:* Clean / {N hits}
*IPC auth:* OK / {issue}
*HITL gate:* OK / {issue}
*Security blocks fired:* {N} in last 24h
*npm audit:* Clean / {severity}

_Next review: tomorrow 2 AM_
```

If there are HIGH findings, prefix the message with 🚨 instead of 🛡️.
Send only one message. Keep it under 400 words.

## Related

- [[SKILL|Check if nanoclaw launchd service is running]]
- [[2026-02-26-conversation-1536|Conversation]]
- [[2026-02-25-conversation-1133|Conversation]]
- [[SECURITY_ANALYSIS_REMOTE_SHELL|Security Analysis: Remote Shell Attack Surface]]
- [[SAFETY_PROTOCOL|NanoClaw Safety Protocol]]
- [[SECURITY|NanoClaw Security Model]]
