#!/bin/zsh
# SessionStart hook — injects the latest Brain digest summary into the Claude
# Code session so the model knows what's currently relevant from the vault.
#
# Reads /Users/amrut/nanoclaw/data/brain-digest.json (written by brain-digest.py)
# and prints a compact summary to stdout. Claude Code captures stdout and
# prepends it to the session context.
#
# Silent if the digest file is missing or stale (>36h).
set -u

DIGEST=/Users/amrut/nanoclaw/data/brain-digest.json
[ -f "$DIGEST" ] || exit 0

# Stale guard: skip if digest is older than 36h (1.5 days)
if [ "$(find "$DIGEST" -mtime +1.5 -print 2>/dev/null)" ]; then
  exit 0
fi

/usr/bin/env python3 - "$DIGEST" <<'PY'
import json, sys
from pathlib import Path

p = Path(sys.argv[1])
try:
    d = json.loads(p.read_text())
except Exception:
    sys.exit(0)

today = d.get("today_entities") or []
rel = d.get("relevant_notes") or []
surp = d.get("surprising_connections") or []
date = d.get("date", "?")

if not (today or rel or surp):
    sys.exit(0)

print("## Brain digest ({}):".format(date))
if today:
    print("- Active entities: " + ", ".join(today[:8]))
if rel:
    print("- Relevant notes:")
    for r in rel[:5]:
        slug = r.get("slug", "?")
        cat = r.get("category", "?")
        shared = r.get("shared_entities", [])[:3]
        print(f"  - {slug} ({cat}) — shares: {', '.join(shared)}")
if surp:
    print("- Surprising connections:")
    for s in surp[:3]:
        a = s.get("a", "?"); b = s.get("b", "?")
        ins = (s.get("insight") or "").strip()
        print(f"  - {a} ↔ {b}: {ins}")
print(f"- Full daily: ~/Brain/Daily/{date}.md")
PY
