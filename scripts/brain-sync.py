#!/usr/bin/env python3
"""Stage 2 — mirror Claw shared memory into the Brain Obsidian vault.

Sources:
  - groups/main/MEMORY.md, KANBAN.md, MEMORY_ARCHIVE_*.md
  - ~/.claude/projects/-Users-amrut-nanoclaw/memory/*.md (auto-memory)

Destination: ~/Brain/Groups/_claw-shared/

Idempotent (frontmatter source_hash). Auto-`[[wikilinks]]` against the same
vocabulary the Brain wiki compiler uses, so the mirror integrates with the
existing graph.
"""
from __future__ import annotations

import hashlib
import re
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from services.wiki_compile.domains.brain import _get_vocab  # noqa: E402

CLAW_ROOT = Path("/Users/amrut/nanoclaw")
AUTO_MEM = Path("/Users/amrut/.claude/projects/-Users-amrut-nanoclaw/memory")
BRAIN = Path("/Users/amrut/Brain")
DEST = BRAIN / "Groups" / "_claw-shared"
LOG = Path("/Users/amrut/nanoclaw/data/brain-sync.log")

CODE_FENCE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`]*`")
WIKILINK = re.compile(r"\[\[[^\]]+\]\]")


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def collect_sources() -> list[tuple[Path, str]]:
    sources: list[tuple[Path, str]] = []
    main = CLAW_ROOT / "groups" / "main"
    for name in ("MEMORY.md", "KANBAN.md"):
        p = main / name
        if p.exists():
            sources.append((p, f"claw-{name}"))
    for p in main.glob("MEMORY_ARCHIVE_*.md"):
        sources.append((p, f"claw-{p.name}"))
    if AUTO_MEM.exists():
        for p in AUTO_MEM.glob("*.md"):
            sources.append((p, f"automem-{p.name}"))
    return sources


def auto_link(text: str, names: list[str], pattern: re.Pattern) -> str:
    if not names:
        return text
    protected: list[tuple[int, int]] = []
    for pat in (CODE_FENCE, INLINE_CODE, WIKILINK):
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


def file_hash(content: str) -> str:
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def parse_existing_hash(dest: Path) -> str | None:
    if not dest.exists():
        return None
    try:
        head = dest.read_text().split("---", 2)
        if len(head) < 3:
            return None
        for line in head[1].splitlines():
            if line.startswith("source_hash:"):
                return line.split(":", 1)[1].strip()
    except Exception:
        pass
    return None


def sync_one(src: Path, dest_name: str, names: list[str], pattern: re.Pattern) -> str:
    raw = src.read_text()
    h = file_hash(raw)
    dest = DEST / dest_name
    if parse_existing_hash(dest) == h:
        return "unchanged"
    body = auto_link(raw, names, pattern)
    fm = (
        "---\n"
        f"source_path: {src}\n"
        f"source_hash: {h}\n"
        f"last_synced: {datetime.now().isoformat(timespec='seconds')}\n"
        "synced_by: brain-sync.py\n"
        "---\n\n"
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(fm + body)
    return "updated" if parse_existing_hash(dest) else "created"


def write_index(results: list[tuple[Path, str, str]]) -> None:
    lines = [
        "---",
        "synced_by: brain-sync.py",
        f"last_synced: {datetime.now().isoformat(timespec='seconds')}",
        "---",
        "",
        "# Claw Shared — Index",
        "",
        "Auto-synced from NanoClaw + Claude Code auto-memory. Read-only mirror.",
        "",
        "| File | Source | Status |",
        "| --- | --- | --- |",
    ]
    for src, dest_name, status in sorted(results, key=lambda r: r[1]):
        lines.append(f"| [[{dest_name[:-3]}]] | `{src}` | {status} |")
    (DEST / "_Index.md").write_text("\n".join(lines) + "\n")


def main() -> int:
    if not BRAIN.exists():
        log(f"FATAL: Brain vault missing at {BRAIN}")
        return 2
    DEST.mkdir(parents=True, exist_ok=True)
    sources = collect_sources()
    log(f"sync start: {len(sources)} source(s)")
    names, pattern = _get_vocab()
    log(f"vocab: {len(names)} entities")

    results: list[tuple[Path, str, str]] = []
    for src, dest_name in sources:
        try:
            status = sync_one(src, dest_name, names, pattern)
            results.append((src, dest_name, status))
            if status != "unchanged":
                log(f"  {status}: {dest_name}")
        except Exception as e:
            log(f"  ERROR {src}: {e}")
            results.append((src, dest_name, f"error: {e}"))
    write_index(results)
    summary = {"created": 0, "updated": 0, "unchanged": 0}
    for *_rest, status in results:
        summary[status] = summary.get(status, 0) + 1
    log(f"sync done: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
