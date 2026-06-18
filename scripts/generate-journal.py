#!/usr/bin/env python3
"""
Generate daily journal from git history, tasks, dev sessions, and experiments.

Produces: docs/journal/YYYY-MM-DD.md  (one per day)
          docs/journal/INDEX.md       (running index)

Idempotent: re-running overwrites the day's file.

Usage:
  python3 scripts/generate-journal.py              # Today
  python3 scripts/generate-journal.py 2026-03-20   # Specific date
  python3 scripts/generate-journal.py --rebuild     # All days from first commit
"""

import os
import re
import sqlite3
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

NANOCLAW_ROOT = Path(__file__).resolve().parent.parent
JOURNAL_DIR = NANOCLAW_ROOT / "docs" / "journal"
DEVLOG_PATH = NANOCLAW_ROOT / "docs" / "DEVLOG.md"
EXPERIMENTS_PATH = NANOCLAW_ROOT / "docs" / "EXPERIMENTS.md"
DB_PATH = NANOCLAW_ROOT / "store" / "messages.db"

# Area categorization (matches memory-bridge.sh AREA_MAP)
AREA_MAP = {
    # Lexios
    "extract.py": "extraction", "serve.py": "whatsapp-serve",
    "sheets.py": "classification", "ifc": "ifc", "eval.py": "eval",
    "corpus": "corpus", "cache.py": "cache", "embed": "embeddings",
    "batch.py": "batch", "train": "training",
    # NanoClaw
    "src/index.ts": "orchestrator", "src/router": "router",
    "src/container": "container", "src/dashboard": "dashboard",
    "src/ipc": "ipc", "src/integrations": "integrations",
    "container/agent-runner": "agent-runtime",
    "container/Dockerfile": "container-build",
    "container/skills": "skills",
    "scripts/": "scripts", "docs/": "docs",
    ".claude/hooks": "hooks", "CLAUDE.md": "config",
}


def categorize_file(filepath: str) -> set[str]:
    areas = set()
    for pattern, area in AREA_MAP.items():
        if pattern in filepath:
            areas.add(area)
    return areas


def is_auto_backup(message: str) -> bool:
    return message.lower().startswith("auto-backup")


def git_commits_for_date(date: str) -> list[dict]:
    """Get all commits for a specific date."""
    next_date = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    result = subprocess.run(
        ["git", "-C", str(NANOCLAW_ROOT), "log", "--reverse",
         f"--since={date}", f"--until={next_date}",
         "--format=COMMIT_START%n%h%n%s%nCOMMIT_END",
         "--stat"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return []

    commits = []
    lines = result.stdout.split("\n")
    i = 0
    while i < len(lines):
        if lines[i].strip() == "COMMIT_START":
            i += 1
            if i + 1 >= len(lines):
                break
            short_hash = lines[i].strip(); i += 1
            message = lines[i].strip(); i += 1
            # Skip COMMIT_END
            if i < len(lines) and lines[i].strip() == "COMMIT_END":
                i += 1
            # Collect stat lines
            stat_lines = []
            while i < len(lines) and lines[i].strip() != "COMMIT_START":
                line = lines[i].strip()
                if line:
                    stat_lines.append(line)
                i += 1
            # Parse stats
            insertions = 0
            deletions = 0
            files = []
            for sl in stat_lines:
                if "changed" in sl and ("insertion" in sl or "deletion" in sl):
                    ins = re.search(r"(\d+) insertion", sl)
                    dels = re.search(r"(\d+) deletion", sl)
                    if ins: insertions = int(ins.group(1))
                    if dels: deletions = int(dels.group(1))
                elif "|" in sl:
                    fname = sl.split("|")[0].strip()
                    if fname:
                        files.append(fname)
            commits.append({
                "short": short_hash, "message": message,
                "files": files, "insertions": insertions, "deletions": deletions,
            })
        else:
            i += 1
    return commits


def get_completed_tasks(date: str) -> list[dict]:
    """Get tasks completed on the given date from SQLite."""
    if not DB_PATH.exists():
        return []
    try:
        conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        # Check if tasks table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
        if not cursor.fetchone():
            conn.close()
            return []
        cursor.execute(
            "SELECT id, description FROM tasks WHERE status='done' AND completed_at LIKE ?",
            (f"{date}%",)
        )
        tasks = [{"id": row["id"], "description": row["description"]} for row in cursor.fetchall()]
        conn.close()
        return tasks
    except (sqlite3.OperationalError, sqlite3.DatabaseError):
        return []


def parse_devlog_sessions(date: str) -> list[dict]:
    """Parse DEVLOG.md for sessions matching the date."""
    if not DEVLOG_PATH.exists():
        return []
    content = DEVLOG_PATH.read_text()
    sessions = []
    # Match sessions like: ### 2026-03-24 22:49
    pattern = rf"### ({re.escape(date)} \d{{2}}:\d{{2}})\n\n(.*?)(?=\n### |\Z)"
    for match in re.finditer(pattern, content, re.DOTALL):
        timestamp = match.group(1)
        body = match.group(2).strip()
        areas_match = re.search(r"\*\*Areas:\*\* (.+)", body)
        files_match = re.search(r"\*\*Files \((\d+)\):\*\* (.+)", body)
        diff_match = re.search(r"\*\*Diff:\*\* (.+)", body)
        sessions.append({
            "time": timestamp.split(" ", 1)[1] if " " in timestamp else timestamp,
            "areas": areas_match.group(1) if areas_match else "",
            "files_count": int(files_match.group(1)) if files_match else 0,
            "files": files_match.group(2) if files_match else "",
            "diff": diff_match.group(1) if diff_match else "",
        })
    return sessions


def parse_experiments_for_date(date: str) -> list[dict]:
    """Find experiments referencing the given date."""
    if not EXPERIMENTS_PATH.exists():
        return []
    content = EXPERIMENTS_PATH.read_text()
    experiments = []
    # Match: ### EXP-NNN: Title (YYYY-MM-DD)
    pattern = r"### (EXP-\d+): (.+?) \(([^)]+)\)\n(.*?)(?=\n### EXP-|\Z)"
    for match in re.finditer(pattern, content, re.DOTALL):
        exp_id = match.group(1)
        title = match.group(2)
        exp_date = match.group(3)
        body = match.group(4)
        if exp_date == date:
            status_match = re.search(r"\*\*Status:\*\* (\S+)", body)
            result_match = re.search(r"\*\*Result:\*\* (.+?)(?:\n\*\*|\Z)", body, re.DOTALL)
            status = status_match.group(1) if status_match else "unknown"
            result = result_match.group(1).strip() if result_match else ""
            # Condense result to first line
            result = result.split("\n")[0] if result else ""
            experiments.append({"id": exp_id, "title": title, "status": status, "result": result})
    return experiments


def generate_journal_for_date(date: str) -> str | None:
    """Generate journal markdown for a single date. Returns None if nothing happened."""
    commits = git_commits_for_date(date)
    tasks = get_completed_tasks(date)
    sessions = parse_devlog_sessions(date)
    experiments = parse_experiments_for_date(date)

    if not commits and not tasks and not sessions and not experiments:
        return None

    now = datetime.now().strftime("%H:%M")
    meaningful = [c for c in commits if not is_auto_backup(c["message"])]
    auto_count = len(commits) - len(meaningful)

    # Aggregate file stats
    all_files = set()
    total_ins = 0
    total_dels = 0
    all_areas = set()
    for c in commits:
        for f in c["files"]:
            all_files.add(f)
            all_areas |= categorize_file(f)
        total_ins += c["insertions"]
        total_dels += c["deletions"]

    lines = [f"# Journal: {date}\n"]
    lines.append(f"*Auto-generated at {now}*\n")

    # Summary
    lines.append("## Summary")
    commit_summary = f"{len(meaningful)} meaningful commit{'s' if len(meaningful) != 1 else ''}"
    if auto_count:
        commit_summary += f", {auto_count} auto-backup{'s' if auto_count != 1 else ''}"
    lines.append(f"- {commit_summary}")
    if all_files:
        lines.append(f"- {len(all_files)} files changed (+{total_ins}, -{total_dels})")
    if tasks:
        lines.append(f"- {len(tasks)} task{'s' if len(tasks) != 1 else ''} completed")
    if sessions:
        lines.append(f"- {len(sessions)} dev session{'s' if len(sessions) != 1 else ''}")
    lines.append("")

    # Commits
    if meaningful:
        lines.append("## Commits")
        for c in meaningful:
            lines.append(f"- `{c['short']}` -- {c['message']}")
        lines.append("")

    # Tasks Completed
    if tasks:
        lines.append("## Tasks Completed")
        for t in tasks:
            lines.append(f"- **{t['id']}**: {t['description']}")
        lines.append("")

    # Sessions (deduplicated — only show unique timestamps)
    if sessions:
        seen_times = set()
        unique_sessions = []
        for s in sessions:
            if s["time"] not in seen_times:
                seen_times.add(s["time"])
                unique_sessions.append(s)
        lines.append("## Sessions")
        for s in unique_sessions:
            lines.append(f"### {s['time']}")
            if s["areas"]:
                lines.append(f"**Areas:** {s['areas']}")
            if s["files"]:
                lines.append(f"**Files ({s['files_count']}):** {s['files']}")
            if s["diff"]:
                lines.append(f"**Diff:** {s['diff']}")
            lines.append("")

    # Files by Area
    if all_areas:
        area_files = defaultdict(list)
        for f in sorted(all_files):
            cats = categorize_file(f)
            if cats:
                for cat in cats:
                    area_files[cat].append(f)
            else:
                area_files["other"].append(f)
        lines.append("## Files by Area")
        for area in sorted(area_files.keys()):
            files = area_files[area]
            lines.append(f"- **{area}** ({len(files)}): {', '.join(files[:10])}")
            if len(files) > 10:
                lines[-1] += f", ... +{len(files) - 10} more"
        lines.append("")

    # Experiments
    if experiments:
        lines.append("## Experiments")
        for e in experiments:
            line = f"- **{e['id']}**: {e['title']} -- {e['status']}"
            if e["result"]:
                line += f", {e['result']}"
            lines.append(line)
        lines.append("")

    return "\n".join(lines)


def generate_index():
    """Regenerate INDEX.md from all journal files."""
    journal_files = sorted(JOURNAL_DIR.glob("????-??-??.md"), reverse=True)
    if not journal_files:
        return

    lines = ["# Journal Index\n"]
    lines.append("*Auto-generated — do not edit manually.*\n")
    lines.append("| Date | Commits | Tasks | Sessions | Areas |")
    lines.append("|------|---------|-------|----------|-------|")

    for jf in journal_files:
        date = jf.stem
        content = jf.read_text()
        # Parse summary stats
        meaningful_match = re.search(r"(\d+) meaningful commit", content)
        auto_match = re.search(r"(\d+) auto-backup", content)
        tasks_match = re.search(r"(\d+) tasks? completed", content)
        sessions_match = re.search(r"(\d+) dev sessions?", content)

        meaningful = int(meaningful_match.group(1)) if meaningful_match else 0
        auto = int(auto_match.group(1)) if auto_match else 0
        n_tasks = int(tasks_match.group(1)) if tasks_match else 0
        n_sessions = int(sessions_match.group(1)) if sessions_match else 0

        commit_str = str(meaningful)
        if auto:
            commit_str += f" + {auto} auto"

        # Extract areas from "Files by Area" section
        areas = []
        for m in re.finditer(r"\*\*(\w[\w-]*)\*\* \(\d+\)", content):
            areas.append(m.group(1))
        areas_str = ", ".join(areas[:5])
        if len(areas) > 5:
            areas_str += f", +{len(areas) - 5}"

        lines.append(f"| [{date}]({date}.md) | {commit_str} | {n_tasks} | {n_sessions} | {areas_str} |")

    lines.append("")
    (JOURNAL_DIR / "INDEX.md").write_text("\n".join(lines))


def get_all_dates() -> list[str]:
    """Get all dates from first commit to today."""
    # Find the root commit (oldest), then get its date
    result = subprocess.run(
        ["git", "-C", str(NANOCLAW_ROOT), "rev-list", "--max-parents=0", "HEAD"],
        capture_output=True, text=True
    )
    if result.returncode != 0 or not result.stdout.strip():
        return []
    root_hash = result.stdout.strip().split("\n")[0]
    result = subprocess.run(
        ["git", "-C", str(NANOCLAW_ROOT), "log", "--format=%ai", "-1", root_hash],
        capture_output=True, text=True
    )
    if result.returncode != 0 or not result.stdout.strip():
        return []
    first_date = datetime.strptime(result.stdout.strip()[:10], "%Y-%m-%d")
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    dates = []
    current = first_date
    while current <= today:
        dates.append(current.strftime("%Y-%m-%d"))
        current += timedelta(days=1)
    return dates


def main():
    JOURNAL_DIR.mkdir(parents=True, exist_ok=True)

    if "--rebuild" in sys.argv:
        dates = get_all_dates()
        print(f"Rebuilding journals for {len(dates)} days...")
        generated = 0
        for date in dates:
            content = generate_journal_for_date(date)
            if content:
                (JOURNAL_DIR / f"{date}.md").write_text(content)
                generated += 1
        print(f"Generated {generated} journal files.")
    else:
        # Single date (positional arg or today)
        date = None
        for arg in sys.argv[1:]:
            if re.match(r"\d{4}-\d{2}-\d{2}$", arg):
                date = arg
                break
        if not date:
            date = datetime.now().strftime("%Y-%m-%d")

        print(f"Generating journal for {date}...")
        content = generate_journal_for_date(date)
        if content:
            (JOURNAL_DIR / f"{date}.md").write_text(content)
            print(f"Wrote docs/journal/{date}.md")
        else:
            print(f"No activity found for {date}")

    generate_index()
    print("Updated docs/journal/INDEX.md")


if __name__ == "__main__":
    main()
