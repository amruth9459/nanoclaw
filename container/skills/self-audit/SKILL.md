---
name: self-audit
description: Run a nightly operational self-audit. Reviews logs, container health, HITL activity, WhatsApp connection, and scheduled task failures. Sends a Safety Brief to WhatsApp.
allowed-tools: Bash, Read, Glob, Grep
---

You are running a self-audit of the NanoClaw system. Work through each section, then send one Safety Brief message.

---

## 1. Service Health

```bash
# Check if nanoclaw launchd service is running
launchctl list | grep nanoclaw | head -5

# Check for recent crashes in error log
tail -50 /workspace/project/logs/nanoclaw.error.log 2>/dev/null | grep -iE "fatal|crash|uncaughtException|exit" | tail -10

# Last 24h log entries with ERROR or WARN
grep -E '"level":(50|40)' /workspace/project/logs/nanoclaw.log 2>/dev/null | tail -20 | \
  node -e "const lines=require('fs').readFileSync('/dev/stdin','utf8').split('\n').filter(Boolean); lines.forEach(l=>{try{const o=JSON.parse(l);console.log(o.time,o.msg)}catch{}});" 2>/dev/null || \
  tail -20 /workspace/project/logs/nanoclaw.log 2>/dev/null
```

---

## 2. WhatsApp Connection

```bash
# Check auth credentials exist
ls -la /workspace/project/store/auth/ 2>/dev/null | head -5

# Check last WhatsApp message received (proxy for connection health)
node -e "
const db = require('better-sqlite3')('/workspace/project/store/messages.db');
const last = db.prepare('SELECT sender, content, timestamp FROM messages ORDER BY timestamp DESC LIMIT 1').get();
if (last) console.log('Last msg:', last.timestamp, '|', last.sender.slice(0,8), '|', last.content.slice(0,50));
else console.log('No messages in DB');
db.close();
" 2>/dev/null
```

---

## 3. Container Activity (last 24h)

```bash
# Count container runs from logs
grep -c "Spawning container agent" /workspace/project/logs/nanoclaw.log 2>/dev/null || echo "0"

# Count errors
grep -c "Container agent error\|Agent error" /workspace/project/logs/nanoclaw.log 2>/dev/null || echo "0"

# Recent container logs
find /workspace/project/groups/*/logs -name "*.log" -newer /workspace/project/groups/main/logs -type f 2>/dev/null | head -5 | while read f; do
  echo "=== $f ==="
  tail -5 "$f" 2>/dev/null
done
```

---

## 4. HITL Gate Activity

```bash
# Check for any HITL approval requests in logs
grep -E "HITL: approval|approval requested|HITL: approved|HITL: rejected|HITL: expired" \
  /workspace/project/logs/nanoclaw.log 2>/dev/null | tail -10

# Check for security blocks
grep -E "SECURITY BLOCK|Unauthorized IPC" \
  /workspace/project/logs/nanoclaw.log 2>/dev/null | tail -10
```

---

## 5. Scheduled Tasks Health

```bash
node -e "
const db = require('better-sqlite3')('/workspace/project/store/messages.db');
const tasks = db.prepare('SELECT id, group_folder, schedule_type, status, next_run, last_run FROM scheduled_tasks').all();
const logs = db.prepare('SELECT task_id, status, run_at, error FROM task_run_logs WHERE run_at > datetime(\"now\", \"-24 hours\") ORDER BY run_at DESC').all();
console.log('Active tasks:', tasks.filter(t=>t.status==='active').length);
console.log('Runs last 24h:', logs.length);
const errors = logs.filter(l=>l.status==='error');
if (errors.length) { console.log('FAILED RUNS:'); errors.forEach(e=>console.log(' -', e.task_id, e.run_at, e.error?.slice(0,80))); }
else console.log('All runs successful');
db.close();
" 2>/dev/null
```

---

## 6. Disk Usage

```bash
# Project size
du -sh /workspace/project/store/ /workspace/project/logs/ /workspace/project/groups/ 2>/dev/null

# Log rotation check (warn if any log > 50MB)
find /workspace/project/logs -name "*.log" -size +50M 2>/dev/null | head -5
```

---

## Safety Brief Format

Send ONE WhatsApp message in this format (WhatsApp formatting only):

```
🔍 *Safety Brief* — {date}

*Service:* ✅ Running / ⚠️ {issue}
*WhatsApp:* ✅ Connected / ⚠️ {issue}
*Containers (24h):* {N} runs, {N} errors
*HITL events:* {N} approvals requested, {N} security blocks
*Tasks:* {N} active, {N} failed runs
*Disk:* store={size} logs={size} groups={size}

*Issues:*
• {issue or "None — all systems nominal"}

_Next audit: tomorrow 3 AM_
```

Use ⚠️ prefix on any line with a problem. Use 🚨 as the opener if there are critical issues (service down, repeated container failures, or security blocks).
Send one message only. Keep under 300 words.
