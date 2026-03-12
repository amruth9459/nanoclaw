#!/usr/bin/env python3
"""
Task Auto-Reconciliation

Reads MEMORY.md "Active Projects" section, finds items marked COMPLETE or LIVE,
fuzzy-matches them against pending kanban tasks in the DB, and marks matches as completed.

Usage:
  python3 scripts/reconcile-tasks.py            # run reconciliation
  python3 scripts/reconcile-tasks.py --dry-run   # preview matches without changing DB
"""
import os
import re
import sqlite3
import sys

NANOCLAW_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEMORY_PATH = os.path.join(NANOCLAW_DIR, "groups", "main", "MEMORY.md")
DB_PATH = os.path.join(NANOCLAW_DIR, "store", "messages.db")
KANBAN_PATH = os.path.join(NANOCLAW_DIR, "groups", "main", "KANBAN.md")

# Words too common to be useful for matching
STOP_WORDS = {
    "the", "and", "for", "with", "that", "this", "from", "have", "has",
    "are", "was", "were", "been", "being", "not", "all", "new", "now",
    "complete", "completed", "live", "done", "ready", "phase", "fully",
    "via", "using", "into", "also", "use", "used", "run", "runs",
}

MIN_KEYWORD_MATCHES = 3


def extract_completed_items(memory_content: str) -> list[dict]:
    """Parse Active Projects section, return items with COMPLETE or LIVE markers."""
    match = re.search(
        r"## Active Projects\n(.*?)(?=\n## |\Z)", memory_content, re.DOTALL
    )
    if not match:
        return []

    items = []
    for line in match.group(1).strip().split("\n"):
        line = line.strip()
        if not line.startswith("- "):
            continue

        # Check for COMPLETE or LIVE markers
        if "COMPLETE" not in line.upper() and "LIVE" not in line.upper():
            continue

        # Extract topic keywords from the bold title part
        title_match = re.match(r"- \*\*(.+?)\*\*", line)
        if not title_match:
            continue

        title = title_match.group(1)
        # Remove date/status markers from title for cleaner keyword extraction
        title_clean = re.sub(r"\([\d-]+\)", "", title)
        title_clean = re.sub(r"COMPLETE|LIVE", "", title_clean, flags=re.IGNORECASE)

        # Extract meaningful keywords
        words = re.findall(r"[a-zA-Z][a-zA-Z0-9_.-]+", title_clean.lower())
        keywords = [w for w in words if w not in STOP_WORDS and len(w) > 2]

        if keywords:
            items.append({"title": title.strip(), "keywords": keywords, "line": line})

    return items


def get_pending_tasks(db_path: str) -> list[dict]:
    """Get tasks that could be reconciled."""
    if not os.path.exists(db_path):
        return []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, description, project, status FROM tasks "
            "WHERE status IN ('todo', 'pending', 'in_progress')"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def fuzzy_match(item_keywords: list[str], task_desc: str) -> list[str]:
    """Return matched keywords between a completed item and a task description."""
    task_tokens = set(re.findall(r"[a-zA-Z][a-zA-Z0-9_.-]+", task_desc.lower()))
    matched = []
    for kw in item_keywords:
        if kw in task_tokens:
            matched.append(kw)
        # Also check substring match for compound words (e.g. "postgresql" in "PostgreSQL@17")
        elif any(kw in t for t in task_tokens):
            matched.append(kw)
    return matched


def reconcile(dry_run: bool = False) -> int:
    """Main reconciliation logic. Returns number of tasks reconciled."""
    if not os.path.exists(MEMORY_PATH):
        print("MEMORY.md not found, skipping reconciliation")
        return 0

    memory_content = open(MEMORY_PATH).read()
    completed_items = extract_completed_items(memory_content)

    if not completed_items:
        return 0

    pending_tasks = get_pending_tasks(DB_PATH)
    if not pending_tasks:
        return 0

    matches = []
    for item in completed_items:
        for task in pending_tasks:
            matched_kws = fuzzy_match(item["keywords"], task["description"])
            if len(matched_kws) >= MIN_KEYWORD_MATCHES:
                matches.append(
                    {
                        "task_id": task["id"],
                        "task_desc": task["description"][:80],
                        "task_status": task["status"],
                        "item_title": item["title"][:60],
                        "matched_keywords": matched_kws,
                        "match_count": len(matched_kws),
                    }
                )

    if not matches:
        return 0

    # Deduplicate: if a task matches multiple items, keep the best match
    best_matches: dict[str, dict] = {}
    for m in matches:
        tid = m["task_id"]
        if tid not in best_matches or m["match_count"] > best_matches[tid]["match_count"]:
            best_matches[tid] = m

    reconciled = 0
    if not dry_run:
        conn = sqlite3.connect(DB_PATH)
        try:
            for tid, m in best_matches.items():
                conn.execute(
                    "UPDATE tasks SET status = 'completed', completed_at = strftime('%s','now') WHERE id = ?",
                    (tid,),
                )
                reconciled += 1
                print(
                    f"  RECONCILED: {m['task_id']} ({m['match_count']} keywords: {', '.join(m['matched_keywords'])})"
                )
                print(f"    Task: {m['task_desc']}")
                print(f"    Item: {m['item_title']}")
            conn.commit()
        finally:
            conn.close()

        # Regenerate KANBAN.md
        regenerate_kanban()
    else:
        for tid, m in best_matches.items():
            reconciled += 1
            print(
                f"  WOULD RECONCILE: {m['task_id']} ({m['match_count']} keywords: {', '.join(m['matched_keywords'])})"
            )
            print(f"    Task: {m['task_desc']}")
            print(f"    Item: {m['item_title']}")

    return reconciled


def regenerate_kanban():
    """Regenerate KANBAN.md from current DB state."""
    if not os.path.exists(DB_PATH):
        return

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        tasks = conn.execute(
            "SELECT id, description, status, priority, project, assigned_agent "
            "FROM tasks ORDER BY priority DESC, created_at ASC"
        ).fetchall()
    finally:
        conn.close()

    if not tasks:
        return

    # Group by status
    buckets: dict[str, list] = {
        "in_progress": [],
        "todo": [],
        "pending": [],
        "completed": [],
    }
    for t in tasks:
        status = t["status"]
        bucket = buckets.get(status, buckets.get("pending", []))
        bucket.append(dict(t))

    lines = ["# Kanban Board", "", f"*Auto-generated from DB. {len(tasks)} tasks total.*", ""]

    for status, label in [
        ("in_progress", "In Progress"),
        ("todo", "To Do"),
        ("pending", "Pending"),
        ("completed", "Completed (recent)"),
    ]:
        items = buckets.get(status, [])
        if status == "completed":
            items = items[:10]  # Only show last 10 completed
        if not items:
            continue

        lines.append(f"## {label}")
        lines.append("")
        for t in items:
            project = f"[{t['project']}]" if t.get("project") else ""
            agent = f" → {t['assigned_agent']}" if t.get("assigned_agent") else ""
            lines.append(f"- **{t['id']}** {project}: {t['description'][:100]}{agent}")
        lines.append("")

    content = "\n".join(lines) + "\n"
    tmp = KANBAN_PATH + ".tmp"
    with open(tmp, "w") as f:
        f.write(content)
    os.rename(tmp, KANBAN_PATH)


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    mode = "DRY RUN" if dry_run else "RECONCILE"
    print(f"Task Reconciliation ({mode})")
    print("=" * 40)

    count = reconcile(dry_run=dry_run)

    if count > 0:
        print(f"\nReconciled {count} task(s)")
    else:
        print("\nNo tasks to reconcile")
