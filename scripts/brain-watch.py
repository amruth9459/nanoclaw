#!/usr/bin/env python3
"""Real-time trigger — watches shared_items table; analyses new shares within
~60s and notifies via WhatsApp + macOS only when the share is goal-relevant.

Pipeline per new share:
  1. Read row from shared_items
  2. fetch_url(url) with link-following (reuses brain-research helpers)
  3. Sonnet analysis with USER LONG-TERM CONTEXT (goal-weighted, same prompt)
  4. Canonicalise entities against the brain knowledge graph
  5. Write enriched research note to Brain/Inbox/research/
  6. Decide notify:
       advances_which_goal non-empty OR overlap with today's Claw entities ≥ 1
     → WhatsApp main group + macOS notification
     else → silent (note still written)

Rate-limit:
  - One Sonnet call per 60s minimum (token bucket below)
  - Single-instance lockfile (data/brain-watch.pid) via fcntl

Read-only against shared_items (NanoClaw owns the writes). Writes go to:
  - Brain/Inbox/research/{slug}.md      (enriched note)
  - data/brain-watch-state.json          (last seen id + processed history)
  - data/ipc/main/messages/{ts}.json     (WhatsApp drop, when goal-relevant)
"""
from __future__ import annotations

import errno
import fcntl
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

# Reuse the research helpers — fetch_url with link-following, build_prompt,
# render_note, call_haiku (which now points at Sonnet via MODEL).
import importlib.util  # noqa: E402

_brain_research_path = Path(__file__).resolve().parent / "brain-research.py"
_spec = importlib.util.spec_from_file_location("brain_research", _brain_research_path)
brain_research = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(brain_research)

from services.wiki_compile.domains.brain import (  # noqa: E402
    BRAIN, CLAW_MIRROR, extract_entities,
)

DB_PATH = Path("/Users/amrut/nanoclaw/store/messages.db")
RESEARCH_DIR = BRAIN / "Inbox" / "research"
STATE_PATH = Path("/Users/amrut/nanoclaw/data/brain-watch-state.json")
LOCK_PATH = Path("/Users/amrut/nanoclaw/data/brain-watch.pid")
ALIASES_JSON = Path("/Users/amrut/nanoclaw/data/brain-aliases.json")
LOG = Path("/Users/amrut/nanoclaw/data/brain-watch.log")
IPC_DIR = Path("/Users/amrut/nanoclaw/data/ipc/main/messages")
JID_FILE = Path("/Users/amrut/nanoclaw/data/main-jid.txt")

POLL_SECONDS = 60                # database poll interval
MIN_LLM_INTERVAL_SECONDS = 60    # rate-limit between Sonnet calls
MAX_TEXT_FOR_NOTIFY = 380


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def acquire_lock() -> "object | None":
    """Single-instance lock. Returns the file handle to keep open, or None
    if another instance holds the lock.
    """
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    fh = open(LOCK_PATH, "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        if e.errno in (errno.EAGAIN, errno.EACCES):
            return None
        raise
    fh.seek(0)
    fh.truncate()
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            pass
    return {"last_seen_created_at": None, "processed_ids": []}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state["processed_ids"] = state.get("processed_ids", [])[-200:]
    STATE_PATH.write_text(json.dumps(state, indent=2))


def alias_map() -> dict[str, str]:
    if not ALIASES_JSON.exists():
        return {}
    try:
        return json.loads(ALIASES_JSON.read_text()).get("alias_map", {}) or {}
    except Exception:
        return {}


def canonicalize(names: set[str]) -> set[str]:
    m = alias_map()
    return {m.get(n, n) for n in names}


def today_claw_entities() -> set[str]:
    if not CLAW_MIRROR.exists():
        return set()
    chunks: list[str] = []
    files = sorted(CLAW_MIRROR.glob("*.md"))
    cutoff = time.time() - 36 * 3600
    target = [p for p in files if p.stat().st_mtime >= cutoff] or files[:2]
    for p in target:
        try:
            text = p.read_text()
        except Exception:
            continue
        chunks.append(re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.DOTALL))
    blob = "\n".join(chunks)[:12000]
    return canonicalize({e["name"] for e in extract_entities(blob)})


def today_claw_text() -> str:
    if not CLAW_MIRROR.exists():
        return ""
    chunks: list[str] = []
    files = sorted(CLAW_MIRROR.glob("*.md"))
    cutoff = time.time() - 36 * 3600
    target = [p for p in files if p.stat().st_mtime >= cutoff] or files[:2]
    for p in target:
        try:
            text = p.read_text()
        except Exception:
            continue
        chunks.append(re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.DOTALL))
    return "\n".join(chunks)[:6000]


def fetch_new_rows(state: dict) -> list[sqlite3.Row]:
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    where = ""
    params: tuple = ()
    if state.get("last_seen_created_at"):
        where = "WHERE created_at > ?"
        params = (state["last_seen_created_at"],)
    rows = list(conn.execute(
        f"SELECT id, item_type, content, url, sender_name, category, status, "
        f"created_at, notes, media_path, media_type FROM shared_items {where} "
        f"ORDER BY created_at ASC",
        params,
    ))
    conn.close()
    seen = set(state.get("processed_ids", []))
    return [r for r in rows if r["id"] not in seen]


def make_research_payload(row: sqlite3.Row) -> dict:
    """Match brain-research.py's `item` shape so we can reuse build_prompt etc."""
    # Some columns may not exist in older row_factory results — use dict() with .get()
    rd = dict(row)
    return {
        "id": rd.get("id"),
        "url": rd.get("url"),
        "category": rd.get("category"),
        "status": rd.get("status"),
        "shared_at": rd.get("created_at"),
        "title": (rd.get("content") or rd.get("url") or rd.get("id") or "")[:120].strip(),
        "notes": (rd.get("notes") or "")[:300],
        "entities": [],
        "overlap": 0,
        "media_path": rd.get("media_path"),
        "media_type": rd.get("media_type"),
        "item_type": rd.get("item_type"),
    }


def emit_macos_notification(title: str, body: str) -> None:
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{body[:200]}" with title "{title[:80]}" sound name "Glass"'],
            check=False, timeout=5,
        )
    except Exception as e:
        log(f"  macOS notify failed: {e}")


def emit_whatsapp(title: str, body: str, note_path: Path) -> None:
    if not (IPC_DIR.exists() and JID_FILE.exists()):
        log(f"  WhatsApp skipped (IPC dir or main-jid.txt missing)")
        return
    jid = JID_FILE.read_text().strip()
    msg_path = IPC_DIR / f"brain-watch-{int(time.time())}.json"
    text = f"🧠 {title}\n\n{body}\n\nNote: {note_path}"
    msg_path.write_text(json.dumps({
        "type": "message",
        "chatJid": jid,
        "text": text[:1500],
    }))
    log(f"  WhatsApp IPC dropped: {msg_path.name}")


def process_one(row: sqlite3.Row, today_ents: set[str], api_key: str) -> bool:
    """Returns True iff a notification was emitted (goal-relevant or overlap).
    Dispatches to URL fetch / metadata-only / image-vision based on what the
    shared_item provides.
    """
    from services.wiki_compile.llm import call_claude, analyze_image  # local import
    item = make_research_payload(row)
    url = item["url"]
    media_path = item.get("media_path")
    today_blob = today_claw_text()
    page: dict | None = None
    analysis: dict | None = None
    mode: str = "url"

    try:
        if url and url.startswith(("http://", "https://")):
            log(f"  fetching {url[:80]}")
            page = brain_research.fetch_url(url, follow_links=True)
            if page and page.get("blocked"):
                log(f"  blocked/paywall — falling back to metadata-only")
                mode = "metadata"
                analysis = call_claude(
                    brain_research.build_metadata_only_prompt(item, today_blob),
                    model=brain_research.MODEL,
                )
            elif page is not None:
                analysis = brain_research.call_haiku(
                    api_key, brain_research.build_prompt(item, page, today_blob),
                )
            else:
                log(f"  fetch failed — falling back to metadata-only")
                mode = "metadata"
                analysis = call_claude(
                    brain_research.build_metadata_only_prompt(item, today_blob),
                    model=brain_research.MODEL,
                )
        elif media_path and Path(media_path).exists():
            log(f"  image: {media_path}")
            mode = "image"
            analysis = analyze_image(
                media_path,
                brain_research.build_image_prompt(item, today_blob),
                model=brain_research.MODEL,
            )
        else:
            log(f"  skip {row['id']}: no usable URL or readable image at {media_path}")
            return False
    except Exception as e:
        log(f"  analysis failed for {row['id']} ({mode}): {e}")
        return False

    if not analysis:
        return False

    slug = re.sub(r"[^a-zA-Z0-9_\-]", "", row["id"])
    note_path = RESEARCH_DIR / f"{slug}.md"
    note_path.parent.mkdir(parents=True, exist_ok=True)
    page_for_render = page or {"final_url": url or media_path or "", "linked_pages": []}
    note_path.write_text(brain_research.render_note(item, page_for_render, analysis))
    log(f"  wrote {note_path.name} [{mode}]")

    advances_goal = analysis.get("advances_which_goal") or []
    overlap_with_work = analysis.get("potential_overlap_with_user_work") or []

    # Also compute a structural overlap with today's canonical entities for
    # belt-and-braces (the LLM might miss it).
    text_for_ents = (item["title"] or "") + " " + (analysis.get("what_it_is") or "")
    item_ents = canonicalize({e["name"] for e in extract_entities(text_for_ents)})
    structural_overlap = today_ents & item_ents

    notify = bool(advances_goal) or bool(overlap_with_work) or bool(structural_overlap)
    if not notify:
        log(f"  silent: no goal/overlap signal for {row['id']}")
        return False

    title = item["title"][:80]
    body_parts = []
    if advances_goal:
        g = advances_goal[0]
        body_parts.append(f"goal: {g.get('goal','?')} — {g.get('how','')}")
    if overlap_with_work:
        o = overlap_with_work[0]
        body_parts.append(f"overlaps {o.get('with','?')}: {o.get('why','')}")
    elif structural_overlap:
        body_parts.append(f"overlaps: {', '.join(sorted(structural_overlap))}")
    body = "\n".join(body_parts)[:MAX_TEXT_FOR_NOTIFY]

    emit_macos_notification(f"📥 {title}", body)
    emit_whatsapp(title, body, note_path)
    log(f"  notified: {title}")
    return True


def loop_once(state: dict, api_key: str, last_llm_ts: list[float]) -> dict:
    rows = fetch_new_rows(state)
    if not rows:
        return state
    log(f"new shared_items rows: {len(rows)}")
    today_ents = today_claw_entities()
    log(f"today's entities (canonicalized): {sorted(today_ents)}")
    for row in rows:
        # Rate-limit Sonnet calls
        wait = MIN_LLM_INTERVAL_SECONDS - (time.time() - last_llm_ts[0])
        if wait > 0:
            log(f"  rate-limit: sleeping {int(wait)}s before next analysis")
            time.sleep(wait)
        try:
            process_one(row, today_ents, api_key)
        except Exception as e:
            log(f"  process_one ERROR for {row['id']}: {e}")
        last_llm_ts[0] = time.time()
        state["processed_ids"] = state.get("processed_ids", []) + [row["id"]]
        state["last_seen_created_at"] = row["created_at"]
        save_state(state)
    return state


def main() -> int:
    api_key = brain_research.load_api_key()
    if not api_key:
        log("FATAL: no ANTHROPIC_API_KEY")
        return 2

    lock = acquire_lock()
    if lock is None:
        log("another brain-watch instance is running — exiting")
        return 0

    log("brain-watch online")
    state = load_state()
    last_llm_ts = [0.0]

    try:
        while True:
            try:
                state = loop_once(state, api_key, last_llm_ts)
            except Exception as e:
                log(f"loop ERROR: {e}")
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        log("brain-watch shutdown via KeyboardInterrupt")
        return 0


if __name__ == "__main__":
    sys.exit(main())
