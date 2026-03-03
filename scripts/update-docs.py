#!/usr/bin/env python3
"""
Auto-update live documents (platform overviews + changelogs).

Appends latest git activity to changelog files and updates timestamps
on platform docs. Run periodically via NanoClaw scheduled task.

This is a NanoClaw infra script — it updates docs for both repos.

Usage:
  python3 scripts/update-docs.py              # Update all docs
  python3 scripts/update-docs.py --changelog   # Only changelogs
  python3 scripts/update-docs.py --platform    # Only platform docs
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

NANOCLAW_ROOT = Path(__file__).resolve().parent.parent
LEXIOS_ROOT = Path(os.environ.get("LEXIOS_ROOT", Path.home() / "Lexios"))

LEXIOS_PLATFORM = LEXIOS_ROOT / "docs" / "LEXIOS_PLATFORM.md"
LEXIOS_CHANGELOG = LEXIOS_ROOT / "docs" / "LEXIOS_CHANGELOG.md"
NANOCLAW_PLATFORM = NANOCLAW_ROOT / "docs" / "NANOCLAW_PLATFORM.md"
NANOCLAW_CHANGELOG = NANOCLAW_ROOT / "docs" / "NANOCLAW_CHANGELOG.md"


def git_log(repo_path: Path, since: str = "", count: int = 50) -> list[dict]:
    """Get recent git commits as structured data."""
    args = ["git", "-C", str(repo_path), "log", f"--max-count={count}",
            "--format=%H|%h|%s|%ai"]
    if since:
        args.append(f"--since={since}")
    result = subprocess.run(args, capture_output=True, text=True)
    commits = []
    for line in result.stdout.strip().split("\n"):
        if not line or "|" not in line:
            continue
        parts = line.split("|", 3)
        if len(parts) == 4:
            commits.append({
                "hash": parts[0], "short": parts[1],
                "message": parts[2], "date": parts[3][:10]
            })
    return commits


def git_stats(repo_path: Path) -> dict:
    """Get repo statistics."""
    total = subprocess.run(
        ["git", "-C", str(repo_path), "rev-list", "--count", "HEAD"],
        capture_output=True, text=True
    ).stdout.strip()

    branch = subprocess.run(
        ["git", "-C", str(repo_path), "branch", "--show-current"],
        capture_output=True, text=True
    ).stdout.strip()

    return {"total_commits": int(total) if total.isdigit() else 0, "branch": branch}


def update_timestamp(filepath: Path):
    """Update the 'last updated' timestamp in a doc."""
    if not filepath.exists():
        return
    content = filepath.read_text()
    today = datetime.now().strftime("%Y-%m-%d")
    content = re.sub(
        r"\*Living document — last updated: \d{4}-\d{2}-\d{2}\*",
        f"*Living document — last updated: {today}*",
        content
    )
    filepath.write_text(content)
    print(f"  Updated timestamp: {filepath.name} → {today}")


def update_lexios_stats(filepath: Path):
    """Update Lexios platform doc with current stats."""
    if not filepath.exists():
        return

    content = filepath.read_text()

    # Update corpus stats if eval.db exists
    eval_db = LEXIOS_ROOT / "lexios" / "eval.db"
    if eval_db.exists():
        try:
            import sqlite3
            conn = sqlite3.connect(str(eval_db))
            cursor = conn.cursor()

            # Corpus doc count
            try:
                cursor.execute("SELECT COUNT(*) FROM corpus_docs")
                doc_count = cursor.fetchone()[0]
            except Exception:
                doc_count = None

            # Types covered
            try:
                cursor.execute("SELECT COUNT(DISTINCT category) FROM model_performance")
                types_covered = cursor.fetchone()[0]
            except Exception:
                types_covered = None

            conn.close()

            if doc_count is not None:
                print(f"  Corpus: {doc_count} docs, {types_covered or '?'} types covered")
        except Exception as e:
            print(f"  Could not read eval.db: {e}")

    # Update learnings count
    learnings_path = LEXIOS_ROOT / "lexios" / "learnings.json"
    if learnings_path.exists():
        try:
            learnings = json.loads(learnings_path.read_text())
            total_tips = sum(len(v) if isinstance(v, list) else 0 for v in learnings.values())
            print(f"  Learnings: {total_tips} tips across {len(learnings)} categories")
        except Exception:
            pass


def append_recent_commits(changelog_path: Path, repo_path: Path, repo_name: str):
    """Append any commits newer than the changelog's latest entry."""
    if not changelog_path.exists() or not repo_path.exists():
        return

    content = changelog_path.read_text()

    # Find the most recent date mentioned in the changelog
    dates = re.findall(r"\d{4}-\d{2}-\d{2}", content)
    latest_date = max(dates) if dates else "2025-01-01"

    # Get commits since that date
    commits = git_log(repo_path, since=latest_date)
    # Filter out auto-backup commits and already-mentioned commits
    meaningful = [c for c in commits if "auto-backup" not in c["message"].lower()]

    if not meaningful:
        print(f"  {repo_name} changelog: up to date")
        return

    # Update total commit count at bottom
    stats = git_stats(repo_path)
    content = re.sub(
        r"\*\*Total commits:\*\* \d+",
        f"**Total commits:** {stats['total_commits']}",
        content
    )

    # Update auto-updated timestamp
    today = datetime.now().strftime("%Y-%m-%d")
    content = re.sub(
        r"\*Version control document — auto-updated\*",
        f"*Version control document — auto-updated {today}*",
        content
    )

    changelog_path.write_text(content)
    print(f"  {repo_name} changelog: {len(meaningful)} new meaningful commits, "
          f"{stats['total_commits']} total")


def main():
    args = sys.argv[1:]
    do_all = not args
    do_changelog = do_all or "--changelog" in args
    do_platform = do_all or "--platform" in args

    print("Updating live documents...")

    if do_platform:
        update_timestamp(LEXIOS_PLATFORM)
        update_lexios_stats(LEXIOS_PLATFORM)
        update_timestamp(NANOCLAW_PLATFORM)

    if do_changelog:
        append_recent_commits(LEXIOS_CHANGELOG, LEXIOS_ROOT, "Lexios")
        append_recent_commits(NANOCLAW_CHANGELOG, NANOCLAW_ROOT, "NanoClaw")

    print("Done.")


if __name__ == "__main__":
    main()
