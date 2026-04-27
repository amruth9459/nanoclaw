#!/usr/bin/env python3
"""Sync the `shared_items` SQLite table into the Brain Obsidian vault.

Each row in `store/messages.db:shared_items` represents something the user sent
into Claw — Product Hunt links, GitHub repos, articles, tools. They're the raw
material for synthesis. This script writes one markdown note per item under
`Brain/Inbox/shared/` so the existing wiki compiler picks them up as first-class
graph nodes (alongside Lexios, NanoClaw, Jyotish, etc.).

Behaviour:
  - Idempotent: each note has frontmatter `db_row_hash`; re-runs overwrite only
    when the hash changes (status updates, new triage notes, etc.).
  - Auto-wikilinks: shared content gets `[[Lexios]]`-style links to existing
    Brain entities using the same vocab the wiki compiler uses.
  - Maintains `Brain/Inbox/shared/_Index.md` listing items by category + status.

Run order: shared-items-sync.py → brain-sync.py → compile_brain_wiki.py → brain-digest.py
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

# Reuse the same vocabulary the wiki compiler uses, so wikilinks are consistent
# across shared items, Claw memory, and existing Brain notes.
from services.wiki_compile.domains.brain import (  # noqa: E402
    BRAIN, _get_vocab, _is_linkable,
)

DB_PATH = Path("/Users/amrut/nanoclaw/store/messages.db")
DEST = BRAIN / "Inbox" / "shared"
LOG = Path("/Users/amrut/nanoclaw/data/shared-items-sync.log")

# Match wikilink/code/fence patterns we must NOT substitute inside.
CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`]*`")
WIKILINK = re.compile(r"\[\[[^\]]+\]\]")
URL_RE = re.compile(r"https?://\S+")


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def fetch_items() -> list[sqlite3.Row]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = list(conn.execute(
        "SELECT id, item_type, content, url, sender_name, category, status, "
        "created_at, triaged_at, acted_on_at, notes FROM shared_items"
    ))
    conn.close()
    return rows


def derive_title(row: sqlite3.Row) -> str:
    """Pick a human title from the URL or content head."""
    content = (row["content"] or "").strip()
    # Strip URL fragment if it's at the end of content
    head = URL_RE.sub("", content).strip(" |·-—\t\n")
    head = head.split("\n")[0].strip()
    if len(head) >= 6:
        return head[:120]
    if row["url"]:
        return row["url"][:120]
    return f"Item {row['id']}"


def auto_link(text: str, names: list[str], pattern: re.Pattern) -> str:
    if not names:
        return text
    protected: list[tuple[int, int]] = []
    for pat in (CODE_FENCE, INLINE_CODE, WIKILINK, URL_RE):
        for m in pat.finditer(text):
            protected.append(m.span())
    protected.sort()

    def is_protected(idx: int) -> bool:
        for s, e in protected:
            if s <= idx < e:
                return True
        return False

    out: list[str] = []
    last = 0
    linked: set[str] = set()
    for m in pattern.finditer(text):
        if is_protected(m.start()):
            continue
        name = m.group(1)
        if name in linked:
            continue
        linked.add(name)
        out.append(text[last:m.start()])
        out.append(f"[[{name}]]")
        last = m.end()
    out.append(text[last:])
    return "".join(out)


def row_hash(row: sqlite3.Row) -> str:
    """Hash on every field that should trigger a re-write."""
    payload = json.dumps({
        "type": row["item_type"], "content": row["content"], "url": row["url"],
        "category": row["category"], "status": row["status"],
        "notes": row["notes"], "sender": row["sender_name"],
        "triaged_at": row["triaged_at"], "acted_on_at": row["acted_on_at"],
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def existing_hash(path: Path) -> str | None:
    if not path.exists():
        return None
    head = path.read_text().split("---", 2)
    if len(head) < 3:
        return None
    for line in head[1].splitlines():
        if line.startswith("db_row_hash:"):
            return line.split(":", 1)[1].strip()
    return None


def render_note(row: sqlite3.Row, names: list[str], pattern: re.Pattern, h: str) -> str:
    title = derive_title(row)
    body_lines: list[str] = []
    if row["url"]:
        body_lines.append(f"**URL:** {row['url']}")
    body_lines.append("")
    body_lines.append(row["content"] or "")
    if row["notes"]:
        body_lines.append("")
        body_lines.append("## Triage notes")
        body_lines.append(row["notes"])
    raw_body = "\n".join(body_lines)
    linked_body = auto_link(raw_body, names, pattern)

    fm = [
        "---",
        f"id: {row['id']}",
        f"db_row_hash: {h}",
        f"item_type: {row['item_type']}",
        f"category: {row['category'] or 'uncategorized'}",
        f"status: {row['status']}",
    ]
    if row["url"]:
        fm.append(f"url: {row['url']}")
    if row["sender_name"]:
        fm.append(f"sender: {row['sender_name']}")
    if row["created_at"]:
        fm.append(f"shared_at: {row['created_at']}")
    if row["triaged_at"]:
        fm.append(f"triaged_at: {row['triaged_at']}")
    if row["acted_on_at"]:
        fm.append(f"acted_on_at: {row['acted_on_at']}")
    fm.append(f"last_synced: {datetime.now().isoformat(timespec='seconds')}")
    fm.append("synced_by: shared-items-sync.py")
    fm.append("---")

    safe_title = title.replace("[", "(").replace("]", ")")
    return "\n".join(fm) + f"\n\n# {safe_title}\n\n{linked_body}\n"


def slugify_id(row_id: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\-]", "", row_id) or "unknown"


def write_index(items_meta: list[dict]) -> None:
    by_status: dict[str, list[dict]] = {}
    by_category: dict[str, list[dict]] = {}
    for m in items_meta:
        by_status.setdefault(m["status"], []).append(m)
        by_category.setdefault(m["category"], []).append(m)

    lines = [
        "---",
        f"last_synced: {datetime.now().isoformat(timespec='seconds')}",
        "synced_by: shared-items-sync.py",
        "---",
        "",
        "# Shared Items — Index",
        "",
        f"Total: **{len(items_meta)}** items synced from Claw `shared_items` table.",
        "",
        "## By status",
    ]
    for status, group in sorted(by_status.items(), key=lambda kv: -len(kv[1])):
        lines.append(f"- **{status}**: {len(group)}")
    lines.append("")
    lines.append("## By category")
    for cat, group in sorted(by_category.items(), key=lambda kv: -len(kv[1])):
        lines.append(f"- **{cat}**: {len(group)}")
    lines.append("")
    lines.append("## Recent (last 25)")
    items_meta.sort(key=lambda m: m.get("shared_at", ""), reverse=True)
    for m in items_meta[:25]:
        date = (m.get("shared_at") or "")[:10]
        lines.append(f"- {date} [[{m['filename'][:-3]}|{m['title']}]] _({m['category']}, {m['status']})_")
    (DEST / "_Index.md").write_text("\n".join(lines) + "\n")


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    rows = fetch_items()
    log(f"sync start: {len(rows)} shared_items")

    names, pattern = _get_vocab()
    log(f"vocab: {len(names)} entities for wikilink resolution")

    items_meta: list[dict] = []
    counts = {"created": 0, "updated": 0, "unchanged": 0}
    for row in rows:
        slug = slugify_id(row["id"])
        path = DEST / f"{slug}.md"
        h = row_hash(row)
        prev = existing_hash(path)
        if prev == h:
            counts["unchanged"] += 1
        else:
            try:
                path.write_text(render_note(row, names, pattern, h))
                counts["updated" if prev else "created"] += 1
            except Exception as e:
                log(f"  ERROR writing {slug}: {e}")
                continue
        items_meta.append({
            "filename": path.name,
            "title": derive_title(row),
            "category": row["category"] or "uncategorized",
            "status": row["status"],
            "shared_at": row["created_at"] or "",
        })

    write_index(items_meta)
    log(f"sync done: {counts}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
