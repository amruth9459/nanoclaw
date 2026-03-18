#!/usr/bin/env python3
"""
Memory Consolidation Agent for NanoClaw

Reads recent user messages, finds patterns, surfaces aging requests,
and writes insights to MEMORY.md via IPC.

Runs daily. Only produces output if there is something genuinely useful.
"""

import json
import sqlite3
import re
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone

import os

# Paths work both in container (/workspace/...) and on host for testing
_HOST_ROOT = Path(os.environ.get("NANOCLAW_ROOT", "/workspace/project"))
_GROUP_DIR = Path(os.environ.get("NANOCLAW_GROUP_DIR", "/workspace/group"))
_IPC_ROOT  = Path(os.environ.get("NANOCLAW_IPC_DIR", "/workspace/ipc/tasks"))

DB_PATH    = _HOST_ROOT / "store/messages.db"
STATE_FILE = _GROUP_DIR / "consolidation_state.json"
MEMORY_MD  = _GROUP_DIR / "MEMORY.md"
IPC_DIR    = _IPC_ROOT
MAIN_JID   = "120363427991119489@g.us"

MIN_NEW_MESSAGES = 3   # skip run if fewer than this many new user messages


# ── state ─────────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"last_run": None}


def save_state(state: dict):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


# ── data ──────────────────────────────────────────────────────────────────────

def get_user_messages(since: str | None) -> list[dict]:
    """Return user messages in main group since `since` ISO timestamp."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    if since:
        rows = conn.execute(
            """SELECT content, sender_name, timestamp
               FROM messages
               WHERE chat_jid = ? AND is_from_me = 0 AND is_bot_message = 0
                 AND timestamp > ?
               ORDER BY timestamp ASC""",
            (MAIN_JID, since),
        ).fetchall()
    else:
        # First run: look back 7 days
        cutoff = (datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=7)).isoformat()
        rows = conn.execute(
            """SELECT content, sender_name, timestamp
               FROM messages
               WHERE chat_jid = ? AND is_from_me = 0 AND is_bot_message = 0
                 AND timestamp > ?
               ORDER BY timestamp ASC""",
            (MAIN_JID, cutoff),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── analysis ──────────────────────────────────────────────────────────────────

def extract_requests(messages: list[dict]) -> list[str]:
    """Pull out user request lines, skipping quoted WhatsApp replies."""
    REQUEST_PATTERNS = re.compile(
        r'\b(can you|please|could you|need to|want to|add|fix|build|'
        r'create|update|remind|schedule|set up|integrate|connect|enable)\b',
        re.IGNORECASE,
    )
    found = []
    for m in messages:
        # Strip quoted lines (lines starting with ">") from WhatsApp replies
        lines = [l for l in m["content"].splitlines() if not l.strip().startswith('>')]
        content = ' '.join(lines).strip()
        if content and REQUEST_PATTERNS.search(content):
            snippet = content[:120].replace('\n', ' ')
            if len(content) > 120:
                snippet += '…'
            found.append(snippet)
    return found


def extract_topics(messages: list[dict]) -> list[str]:
    """Return top recurring content words (ignoring common words)."""
    STOPWORDS = {
        'the','a','an','is','it','in','on','at','to','for','of','and','or',
        'but','not','i','you','we','my','your','that','this','with','from',
        'was','are','be','been','have','has','do','did','can','will','would',
        'should','could','what','when','where','how','why','which','just',
        'also','get','got','let','if','so','then','there','here','as','by',
        'ok','okay','yes','no','hey','hi','claw','please',
    }
    freq: dict[str, int] = {}
    for m in messages:
        # Skip quoted lines
        lines = [l for l in m["content"].splitlines() if not l.strip().startswith('>')]
        words = re.findall(r'\b[a-z]{4,}\b', ' '.join(lines).lower())
        for w in words:
            if w not in STOPWORDS:
                freq[w] = freq.get(w, 0) + 1

    # Only words appearing in 2+ messages
    return [w for w, c in sorted(freq.items(), key=lambda x: -x[1]) if c >= 2][:8]


def get_aging_requests(days: int = 7) -> list[str]:
    """
    Parse MEMORY.md 'Explicit Requests' section and return items
    older than `days` days (based on Mar date tags).
    """
    if not MEMORY_MD.exists():
        return []
    content = MEMORY_MD.read_text()
    section = re.search(
        r'### Explicit Requests.*?(?=\n### |\n## |\Z)', content, re.DOTALL
    )
    if not section:
        return []

    aged = []
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    # Lines like "- Add context-hub for Lexios and NanoClaw (asked twice)"
    # or "- GC outreach template — ... (Mar 11)"
    for line in section.group(0).split('\n'):
        line = line.strip()
        if not line.startswith('- '):
            continue
        # Find date like "(Mar 11)" or "(Mar 11, 12)"
        m = re.search(r'\((?:asked.*?\bMar\s+(\d+)|\bMar\s+(\d+))', line)
        if m:
            day = int(m.group(1) or m.group(2))
            # Assume current month (March 2026)
            try:
                item_date = datetime(now.year, 3, day)
                if (now - item_date).days >= days:
                    aged.append(line[2:].strip())  # strip leading "- "
            except ValueError:
                pass
        else:
            # No date tag — treat as old
            aged.append(line[2:].strip())
    return aged[:10]


# ── ipc ───────────────────────────────────────────────────────────────────────

def emit_learn(topic: str, knowledge: str):
    import time
    IPC_DIR.mkdir(parents=True, exist_ok=True)
    ts = int(time.time() * 1000)
    payload = {"type": "learn", "topic": topic, "knowledge": knowledge, "domain": "nanoclaw"}
    (IPC_DIR / f"learn_{ts}.json").write_text(json.dumps(payload))


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    state = load_state()
    last_run = state.get("last_run")

    messages = get_user_messages(last_run)
    print(f"New user messages since last run: {len(messages)}")

    if len(messages) < MIN_NEW_MESSAGES:
        print(f"Skipping — need {MIN_NEW_MESSAGES}+ messages, got {len(messages)}.")
        save_state({"last_run": datetime.now(timezone.utc).replace(tzinfo=None).isoformat()})
        return

    requests = extract_requests(messages)
    topics   = extract_topics(messages)
    aging    = get_aging_requests(days=7)

    print(f"Requests found: {len(requests)}")
    print(f"Top topics: {topics}")
    print(f"Aging requests (>7d): {len(aging)}")

    insights = []

    if topics:
        insights.append(f"Recent themes: {', '.join(topics[:5])}")

    if aging:
        insights.append(
            f"{len(aging)} pending request(s) older than 7 days:\n"
            + "\n".join(f"  • {r[:100]}" for r in aging[:5])
        )

    if requests:
        insights.append(
            f"{len(requests)} new request(s) detected:\n"
            + "\n".join(f"  • {r}" for r in requests[:5])
        )

    if insights:
        summary = (
            f"🧠 *Memory consolidation* ({len(messages)} new messages)\n\n"
            + "\n\n".join(insights)
        )
        print("\n--- INSIGHT ---")
        print(summary)

        # Persist the most notable finding as a learned fact
        if aging:
            knowledge = (
                f"Aging explicit requests (>{7}d unactioned): "
                + "; ".join(aging[:3])
                + f". Detected during consolidation of {len(messages)} messages."
            )
            if len(knowledge) >= 200:
                emit_learn("aging-requests", knowledge)

    else:
        print("No notable insights — staying silent.")

    save_state({"last_run": datetime.now(timezone.utc).replace(tzinfo=None).isoformat()})
    print("Done.")


if __name__ == "__main__":
    main()
