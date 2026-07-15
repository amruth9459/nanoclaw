#!/usr/bin/env python3
"""claude-brain-sync — nightly bidirectional bridge between the Claude Code
desktop memory and the Brain vault, closing the divergence found 2026-07-14
(Brain ran on debunked facts; digest was blind to actual desktop work; Claude
sessions didn't know SOUL goals / KANBAN / decided verdicts).

Forward (Claude → Brain):
    Mirrors the Claude Code memory INDEX (one-line-per-project summaries) into
    Brain/ClaudeCode/ so compile_brain_wiki indexes real current work and
    brain-digest counts it toward "today's entities". Deliberately mirrors the
    INDEX ONLY — never memory file bodies, which can hold credentials/PINs.
    Also emits a changed-lines diff note ("what moved since last sync") so the
    digest sees desktop activity as fresh signal.

Reverse (Brain → Claude):
    Writes a compact reference_brain_state.md into the Claude memory dir with
    SOUL goals, KANBAN lane counts, decided.md verdict keys, and the latest
    daily digest path. Deterministic, no LLM, auto-regenerated — do not edit
    by hand.

Runs as a stage in brain-pipeline.sh (before compile_brain_wiki). Idempotent:
files are rewritten only when content changed, so mtimes reflect real change
(brain-digest's 36h freshness window depends on this). Soft-fails: any error
logs and exits 0 so the rest of the pipeline still runs.
"""
from __future__ import annotations

import difflib
import hashlib
import re
import sys
from datetime import datetime
from pathlib import Path

CLAUDE_MEM = Path("/Users/amrut/.claude/projects/-Users-amrut/memory")
CLAUDE_INDEX = CLAUDE_MEM / "MEMORY.md"
BRAIN = Path("/Users/amrut/Brain")
CC_DIR = BRAIN / "ClaudeCode"
SOUL = BRAIN / "Notes" / "SOUL.md"
KANBAN = Path("/Users/amrut/nanoclaw/groups/main/KANBAN.md")
DECIDED = BRAIN / "decided.md"
DAILY_DIR = BRAIN / "Daily"
STATE_DIR = Path("/Users/amrut/nanoclaw/data")
PREV_SNAPSHOT = STATE_DIR / "claude-brain-sync.prev.md"
LOG = STATE_DIR / "claude-brain-sync.log"
REVERSE_NOTE = CLAUDE_MEM / "reference_brain_state.md"

# Lines in the Claude index that must never reach the Brain (and from there,
# WhatsApp digests / container agents).
_EXCLUDE_LINE = re.compile(r"sensitive|personal reading", re.IGNORECASE)

# Belt-and-braces redaction. The index shouldn't contain secrets, but a future
# index line might; kill obvious credential shapes before they cross over.
_REDACTIONS = [
    (re.compile(r"(?i)\b(pin|password|passwd|pwd|token|secret|api[_-]?key|apikey)\b(\s*[=:]\s*|\s+is\s+|\s*=\s*)`?[^\s`,;)]+`?"),
     r"\1=[redacted]"),
    (re.compile(r"\b(gh[pousr]_|sk-|xox[bap]-|AKIA)[A-Za-z0-9_\-]{8,}"), "[redacted-credential]"),
    (re.compile(r"\b[0-9a-f]{32,}\b"), "[redacted-hex]"),
]


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def sanitize(text: str) -> str:
    kept = [ln for ln in text.splitlines() if not _EXCLUDE_LINE.search(ln)]
    out = "\n".join(kept)
    for pat, repl in _REDACTIONS:
        out = pat.sub(repl, out)
    return out


def write_if_changed(path: Path, content: str) -> bool:
    """Write only when content differs, so mtime == real change."""
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == \
            hashlib.sha256(content.encode()).hexdigest():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return True


def forward_sync() -> None:
    if not CLAUDE_INDEX.exists():
        log("forward: Claude memory index missing — skipped")
        return
    raw = CLAUDE_INDEX.read_text()
    clean = sanitize(raw)

    today = datetime.now().strftime("%Y-%m-%d")
    index_note = (
        "---\n"
        f"synced: {today}\n"
        "source: ~/.claude/projects/-Users-amrut/memory/MEMORY.md (index only; bodies never mirrored)\n"
        "generator: claude-brain-sync.py\n"
        "---\n\n"
        "# Claude Code — active desktop work (memory index mirror)\n\n"
        "One line per project, auto-sanitized. This is what the desktop agent is\n"
        "actually working on — treat as ground truth over older vault notes.\n\n"
        + clean + "\n"
    )
    changed = write_if_changed(CC_DIR / "claude-code-memory-index.md", index_note)
    log(f"forward: index mirror {'updated' if changed else 'unchanged'}")

    # Changed-lines diff → the digest's freshness signal for desktop work.
    prev = PREV_SNAPSHOT.read_text() if PREV_SNAPSHOT.exists() else ""
    if clean != prev:
        added = [
            ln[2:] for ln in difflib.unified_diff(
                prev.splitlines(), clean.splitlines(), lineterm="", n=0)
            if ln.startswith("+ ") or (ln.startswith("+") and not ln.startswith("+++"))
        ]
        added = [a.lstrip("+").strip() for a in added if a.lstrip("+").strip()]
        if added:
            diff_note = (
                "---\n"
                f"synced: {today}\n"
                "generator: claude-brain-sync.py\n"
                "---\n\n"
                f"# Claude Code — what changed since last sync ({today})\n\n"
                + "\n".join(f"- {a}" for a in added[:40]) + "\n"
            )
            write_if_changed(CC_DIR / "claude-code-recent-work.md", diff_note)
            log(f"forward: recent-work note updated ({len(added)} changed lines)")
        PREV_SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        PREV_SNAPSHOT.write_text(clean)
    else:
        log("forward: no index changes since last sync")


def _section(text: str, heading: str, max_lines: int = 8) -> list[str]:
    m = re.search(rf"^#+\s*{re.escape(heading)}.*?$", text, re.MULTILINE)
    if not m:
        return []
    out: list[str] = []
    for ln in text[m.end():].splitlines():
        if ln.startswith("#"):
            break
        if ln.strip().startswith("- "):
            out.append(ln.strip()[2:])
        if len(out) >= max_lines:
            break
    return out


def reverse_sync() -> None:
    near = _section(SOUL.read_text(), "Near-Term Goals") if SOUL.exists() else []
    vision = _section(SOUL.read_text(), "Long-Term Vision") if SOUL.exists() else []

    lanes: list[str] = []
    if KANBAN.exists():
        for ln in KANBAN.read_text().splitlines():
            if re.match(r"^## \w.* \(\d+ todo", ln):
                lanes.append(ln[3:])

    decided_keys: list[str] = []
    if DECIDED.exists():
        for ln in DECIDED.read_text().splitlines():
            if ln.startswith("- ") and "|" in ln:
                parts = [p.strip() for p in ln[2:].split("|")]
                if len(parts) >= 2 and len(parts[1]) >= 4:
                    decided_keys.append(f"{parts[1]} ({parts[0]})")

    latest_daily = ""
    if DAILY_DIR.exists():
        dailies = sorted(DAILY_DIR.glob("2*.md"))
        if dailies:
            latest_daily = str(dailies[-1])

    today = datetime.now().strftime("%Y-%m-%d")
    note = (
        "---\n"
        "name: reference-brain-state\n"
        "description: AUTO-GENERATED nightly by claude-brain-sync.py — Brain/NanoClaw goals, kanban lanes, decided verdicts. Do not edit; changes are overwritten.\n"
        "metadata:\n"
        "  type: reference\n"
        "---\n\n"
        f"# Brain/NanoClaw state (auto-synced {today})\n\n"
        "Auto-generated bridge from the Brain vault — see [[project_brain_nanoclaw_divergence]] for why.\n"
        "Sources: Brain/Notes/SOUL.md, nanoclaw KANBAN.md, Brain/decided.md.\n\n"
        "## Stated goals (SOUL.md)\n"
        + "\n".join(f"- {g}" for g in near) + "\n\n"
        "## Long-term vision\n"
        + "\n".join(f"- {g}" for g in vision) + "\n\n"
        "## Kanban lanes\n"
        + "\n".join(f"- {l}" for l in lanes) + "\n\n"
        "## Decided verdicts in force (Brain/decided.md — do not re-propose)\n"
        + "\n".join(f"- {k}" for k in decided_keys) + "\n\n"
        f"Latest daily digest: {latest_daily}\n"
    )
    changed = write_if_changed(REVERSE_NOTE, note)
    log(f"reverse: brain-state note {'updated' if changed else 'unchanged'}")

    # Ensure the memory index lists it (once).
    if CLAUDE_INDEX.exists():
        idx = CLAUDE_INDEX.read_text()
        if "reference_brain_state.md" not in idx:
            line = ("- [Brain/NanoClaw state (auto-synced nightly)](reference_brain_state.md) — "
                    "SOUL goals, kanban lane counts, decided.md verdicts; regenerated by "
                    "claude-brain-sync.py, treat as live Brain-side ground truth.\n")
            CLAUDE_INDEX.write_text(idx.rstrip() + "\n" + line)
            log("reverse: added index line to Claude MEMORY.md")


def main() -> int:
    try:
        forward_sync()
    except Exception as e:  # soft-fail: never block the pipeline
        log(f"forward sync FAILED (non-fatal): {e}")
    try:
        reverse_sync()
    except Exception as e:
        log(f"reverse sync FAILED (non-fatal): {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
