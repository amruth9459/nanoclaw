#!/usr/bin/env python3
"""
Generate daily build journal from git history.

Produces: docs/NANOCLAW_BUILD_LOG.md

Idempotent: re-running regenerates the whole file from git history.
Designed to run daily via launchd + uploaded to Google Drive by backup.sh.

Usage:
  python3 scripts/generate-build-log.py
"""

import os
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

NANOCLAW_ROOT = Path(__file__).resolve().parent.parent


def git_log_full(repo_path: Path) -> list[dict]:
    """Get full git history with stats, oldest first."""
    result = subprocess.run(
        ["git", "-C", str(repo_path), "log", "--reverse",
         "--format=COMMIT_START%n%H%n%h%n%s%n%ai%nCOMMIT_END",
         "--stat"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"  ERROR: git log failed for {repo_path}: {result.stderr.strip()}")
        return []

    commits = []
    lines = result.stdout.split("\n")
    i = 0
    while i < len(lines):
        if lines[i].strip() == "COMMIT_START":
            i += 1
            if i + 3 >= len(lines):
                break
            full_hash = lines[i].strip(); i += 1
            short_hash = lines[i].strip(); i += 1
            message = lines[i].strip(); i += 1
            date_str = lines[i].strip(); i += 1

            # Skip COMMIT_END line
            if i < len(lines) and lines[i].strip() == "COMMIT_END":
                i += 1

            # Collect stat lines until next COMMIT_START or end
            stat_lines = []
            while i < len(lines) and lines[i].strip() != "COMMIT_START":
                line = lines[i].strip()
                if line:
                    stat_lines.append(line)
                i += 1

            # Parse stat summary (last line like "3 files changed, 17 insertions(+), 7 deletions(-)")
            insertions = 0
            deletions = 0
            files_changed = []
            summary_line = ""

            for sl in stat_lines:
                if "changed" in sl and ("insertion" in sl or "deletion" in sl):
                    summary_line = sl
                elif "|" in sl:
                    # File stat line like: "src/index.ts | 42 +++++---"
                    fname = sl.split("|")[0].strip()
                    if fname:
                        files_changed.append(fname)

            if summary_line:
                import re
                ins = re.search(r"(\d+) insertion", summary_line)
                dels = re.search(r"(\d+) deletion", summary_line)
                if ins:
                    insertions = int(ins.group(1))
                if dels:
                    deletions = int(dels.group(1))

            commits.append({
                "hash": full_hash,
                "short": short_hash,
                "message": message,
                "date": date_str[:10],
                "files": files_changed,
                "insertions": insertions,
                "deletions": deletions,
            })
        else:
            i += 1

    return commits


def group_by_date(commits: list[dict]) -> dict[str, list[dict]]:
    """Group commits by date string."""
    grouped = defaultdict(list)
    for c in commits:
        grouped[c["date"]].append(c)
    return grouped


def is_auto_backup(message: str) -> bool:
    """Check if a commit message is an auto-backup."""
    return message.lower().startswith("auto-backup")


def generate_day_section(date: str, commits: list[dict]) -> str:
    """Generate markdown for a single day."""
    meaningful = [c for c in commits if not is_auto_backup(c["message"])]
    backup_count = len(commits) - len(meaningful)

    # If only auto-backups, still show a minimal entry
    if not meaningful and backup_count > 0:
        all_files = set()
        total_ins = 0
        total_dels = 0
        for c in commits:
            all_files.update(c["files"])
            total_ins += c["insertions"]
            total_dels += c["deletions"]

        if not all_files and total_ins == 0:
            return ""  # Skip days with empty auto-backups

        lines = [f"## {date}\n"]
        lines.append("### What Changed")
        lines.append(f"- {backup_count} auto-backup commits (incremental saves)\n")

        if all_files:
            lines.append(f"### Files ({len(all_files)} changed)")
            for f in sorted(all_files)[:15]:
                lines.append(f"- {f}")
            if len(all_files) > 15:
                lines.append(f"- ... and {len(all_files) - 15} more")
            lines.append("")

        lines.append("### Stats")
        lines.append(f"- {total_ins} insertions, {total_dels} deletions")
        lines.append("")
        return "\n".join(lines)

    # Day with meaningful commits
    all_files = set()
    total_ins = 0
    total_dels = 0
    for c in commits:
        all_files.update(c["files"])
        total_ins += c["insertions"]
        total_dels += c["deletions"]

    lines = [f"## {date}\n"]
    lines.append("### What Changed")
    for c in meaningful:
        lines.append(f"- {c['message']}")
    if backup_count > 0:
        lines.append(f"- (+{backup_count} auto-backup commits)")
    lines.append("")

    if all_files:
        lines.append(f"### Files ({len(all_files)} changed)")
        for f in sorted(all_files)[:20]:
            lines.append(f"- {f}")
        if len(all_files) > 20:
            lines.append(f"- ... and {len(all_files) - 20} more")
        lines.append("")

    lines.append("### Stats")
    lines.append(f"- {total_ins} insertions, {total_dels} deletions")
    lines.append("")
    return "\n".join(lines)


def generate_build_log(repo_path: Path, repo_name: str, output_path: Path):
    """Generate the full build log for a repo."""
    if not repo_path.exists():
        print(f"  SKIP: {repo_name} repo not found at {repo_path}")
        return

    print(f"  Generating {repo_name} build log...")
    commits = git_log_full(repo_path)
    if not commits:
        print(f"  WARN: no commits found for {repo_name}")
        return

    grouped = group_by_date(commits)
    total_commits = len(commits)
    meaningful_commits = len([c for c in commits if not is_auto_backup(c["message"])])
    first_date = commits[0]["date"]
    last_date = commits[-1]["date"]

    # Header
    today = datetime.now().strftime("%Y-%m-%d")
    header = f"""# {repo_name} — Daily Build Log

*Living document — auto-generated from git history*
*Last generated: {today}*

**{total_commits} total commits** ({meaningful_commits} meaningful) | {first_date} to {last_date}

---

"""

    # Generate day sections, newest first
    sorted_dates = sorted(grouped.keys(), reverse=True)
    day_sections = []
    for date in sorted_dates:
        section = generate_day_section(date, grouped[date])
        if section:
            day_sections.append(section)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(header + "\n".join(day_sections))
    print(f"  Wrote {output_path} ({len(day_sections)} days, {total_commits} commits)")


def main():
    print("Generating daily build logs...")

    nanoclaw_output = NANOCLAW_ROOT / "docs" / "NANOCLAW_BUILD_LOG.md"
    generate_build_log(NANOCLAW_ROOT, "NanoClaw", nanoclaw_output)

    print("Done.")


if __name__ == "__main__":
    main()
