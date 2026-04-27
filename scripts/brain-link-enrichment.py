#!/usr/bin/env python3
"""Link-enrichment pass — wires up Obsidian wiki-links between the various
auto-generated note types so the graph view actually shows the structure.

Operations (each idempotent):
  1. For every shared mirror note in Brain/Inbox/shared/ that has a matching
     research note in Brain/Inbox/research/, append a "## Research" section
     with a [[research/slug]] wikilink. Skip if already present.
  2. For every theme note in Brain/Inbox/themes/, rewrite "## Items in cluster"
     entries to use [[research/slug | title]] when a matching research note
     exists.
  3. For every synthesis note in Brain/Inbox/synthesis/, replace plain item
     titles with [[research/slug | title]] when matchable.
  4. Regenerate _Index.md in research/, themes/, synthesis/.

Match strategy: research notes are named after shared_item ids (si_…). We
extract that id from each shared note's frontmatter, theme item entries by URL
matching, synthesis note items by URL matching.
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

BRAIN = Path("/Users/amrut/Brain")
SHARED_DIR = BRAIN / "Inbox" / "shared"
RESEARCH_DIR = BRAIN / "Inbox" / "research"
THEMES_DIR = BRAIN / "Inbox" / "themes"
SYNTHESIS_DIR = BRAIN / "Inbox" / "synthesis"
LOG = Path("/Users/amrut/nanoclaw/data/brain-link-enrichment.log")

FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
ID_FIELD_RE = re.compile(r"^id:\s*(\S+)", re.MULTILINE)
URL_FIELD_RE = re.compile(r"^url:\s*(\S+)", re.MULTILINE)
RESEARCH_MARKER = "## Research"


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def index_research_notes() -> dict[str, dict]:
    """Map shared_item id → {slug, path, url, title, shared_at, what_it_is}."""
    out: dict[str, dict] = {}
    if not RESEARCH_DIR.exists():
        return out
    for p in RESEARCH_DIR.glob("*.md"):
        if p.name == "_Index.md":
            continue
        try:
            text = p.read_text()
        except Exception:
            continue
        fm_match = FRONTMATTER_RE.match(text)
        if not fm_match:
            continue
        fm = fm_match.group(1)
        m = ID_FIELD_RE.search(fm)
        if not m:
            continue
        sid = m.group(1).strip()
        url_m = URL_FIELD_RE.search(fm)
        url = url_m.group(1).strip() if url_m else None
        # First H1 as title
        h1 = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
        title = h1.group(1).strip() if h1 else p.stem
        what_m = re.search(r"\*\*What it is:\*\*\s*(.+?)$", text, re.MULTILINE)
        what = what_m.group(1).strip() if what_m else ""
        # shared_at from frontmatter
        sa_m = re.search(r"^shared_at:\s*(\S+)", fm, re.MULTILINE)
        shared_at = sa_m.group(1).strip() if sa_m else ""
        out[sid] = {
            "slug": p.stem,
            "path": p,
            "url": url,
            "title": title,
            "shared_at": shared_at,
            "what_it_is": what,
        }
    return out


def link_shared_to_research(research_idx: dict[str, dict]) -> int:
    if not SHARED_DIR.exists():
        return 0
    added = 0
    for p in SHARED_DIR.glob("*.md"):
        if p.name == "_Index.md":
            continue
        text = p.read_text()
        if RESEARCH_MARKER in text:
            continue
        fm_match = FRONTMATTER_RE.match(text)
        if not fm_match:
            continue
        m = ID_FIELD_RE.search(fm_match.group(1))
        if not m:
            continue
        sid = m.group(1).strip()
        if sid not in research_idx:
            continue
        research_slug = research_idx[sid]["slug"]
        what = research_idx[sid].get("what_it_is", "")
        section = f"\n\n{RESEARCH_MARKER}\n\n→ [[{research_slug}]]"
        if what:
            section += f"\n\n_{what}_"
        p.write_text(text.rstrip() + section + "\n")
        added += 1
    return added


def _url_to_id(url: str, by_url: dict[str, str]) -> str | None:
    if not url:
        return None
    return by_url.get(url) or by_url.get(url.split("#")[0]) or by_url.get(url.split("?")[0])


def relink_theme_items(research_idx: dict[str, dict]) -> int:
    """In each theme's '## Items in cluster' block, convert plain item titles
    to [[research_slug | title]] wikilinks when a research note exists."""
    if not THEMES_DIR.exists():
        return 0
    by_url: dict[str, str] = {}
    for sid, r in research_idx.items():
        if r.get("url"):
            by_url[r["url"]] = sid
    edited = 0
    for p in THEMES_DIR.glob("*.md"):
        if p.name == "_Index.md":
            continue
        text = p.read_text()
        # Theme item lines look like:
        # - _research_ **Title** — [link](URL)
        new_lines: list[str] = []
        changed = False
        for line in text.splitlines():
            stripped = line.lstrip()
            if not stripped.startswith("- _"):
                new_lines.append(line)
                continue
            url_m = re.search(r"\(([^)]+)\)", line)
            if not url_m:
                new_lines.append(line)
                continue
            url = url_m.group(1).strip()
            sid = _url_to_id(url, by_url)
            if not sid or sid not in research_idx:
                new_lines.append(line)
                continue
            slug = research_idx[sid]["slug"]
            if slug in line:
                new_lines.append(line)
                continue
            # Append [[slug]] wikilink
            new_lines.append(line + f" · [[{slug}|research]]")
            changed = True
        if changed:
            p.write_text("\n".join(new_lines) + "\n")
            edited += 1
    return edited


def relink_synthesis_items(research_idx: dict[str, dict]) -> int:
    if not SYNTHESIS_DIR.exists():
        return 0
    by_url: dict[str, str] = {}
    for sid, r in research_idx.items():
        if r.get("url"):
            by_url[r["url"]] = sid
    edited = 0
    for p in SYNTHESIS_DIR.glob("*.md"):
        if p.name == "_Index.md":
            continue
        text = p.read_text()
        new_lines: list[str] = []
        changed = False
        for line in text.splitlines():
            url_m = re.search(r"\(([^)]+)\)", line)
            if not url_m:
                new_lines.append(line)
                continue
            url = url_m.group(1).strip()
            sid = _url_to_id(url, by_url)
            if not sid or sid not in research_idx:
                new_lines.append(line)
                continue
            slug = research_idx[sid]["slug"]
            if slug in line:
                new_lines.append(line)
                continue
            new_lines.append(line + f" · [[{slug}|research]]")
            changed = True
        if changed:
            p.write_text("\n".join(new_lines) + "\n")
            edited += 1
    return edited


def write_research_index(research_idx: dict[str, dict]) -> None:
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for sid, r in research_idx.items():
        # Read category from the research note frontmatter.
        try:
            text = r["path"].read_text()
            fm_match = FRONTMATTER_RE.match(text)
            cat = "uncategorized"
            if fm_match:
                cm = re.search(r"^category:\s*(.+)$", fm_match.group(1), re.MULTILINE)
                if cm:
                    cat = cm.group(1).strip()
        except Exception:
            cat = "uncategorized"
        by_cat[cat].append(r)
    lines = [
        "---",
        f"last_built: {datetime.now().isoformat(timespec='seconds')}",
        "built_by: brain-link-enrichment.py",
        "---",
        "",
        f"# Research Notes — Index",
        "",
        f"**{len(research_idx)} items** analysed across the corpus.",
        "",
    ]
    for cat in sorted(by_cat.keys(), key=lambda c: -len(by_cat[c])):
        items = sorted(by_cat[cat], key=lambda r: r.get("shared_at", ""), reverse=True)
        lines.append(f"## {cat} ({len(items)})")
        lines.append("")
        for r in items:
            date_s = (r.get("shared_at") or "")[:10]
            what = (r.get("what_it_is") or "")[:160]
            lines.append(f"- {date_s} [[{r['slug']}|{r['title'][:90]}]] — {what}")
        lines.append("")
    (RESEARCH_DIR / "_Index.md").write_text("\n".join(lines) + "\n")


def write_themes_index() -> None:
    if not THEMES_DIR.exists():
        return
    files = sorted(THEMES_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    files = [f for f in files if f.name != "_Index.md"]
    lines = [
        "---",
        f"last_built: {datetime.now().isoformat(timespec='seconds')}",
        "built_by: brain-link-enrichment.py",
        "---",
        "",
        f"# Themes — Index",
        "",
        f"**{len(files)} thematic syntheses** generated by brain-themes.py.",
        "",
    ]
    for p in files:
        # Extract H1 + anchor entity from frontmatter
        text = p.read_text()
        h1 = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
        title = h1.group(1).strip() if h1 else p.stem
        am = re.search(r"^anchor_entity:\s*(.+)$", text, re.MULTILINE)
        anchor = am.group(1).strip() if am else "?"
        date = p.stem.split("-")[0:3]
        date_str = "-".join(date) if len(date) == 3 else ""
        lines.append(f"- {date_str} [[{p.stem}|{title}]] _(anchor: `{anchor}`)_")
    (THEMES_DIR / "_Index.md").write_text("\n".join(lines) + "\n")


def write_synthesis_index() -> None:
    if not SYNTHESIS_DIR.exists():
        return
    files = sorted(SYNTHESIS_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    files = [f for f in files if f.name != "_Index.md"]
    lines = [
        "---",
        f"last_built: {datetime.now().isoformat(timespec='seconds')}",
        "built_by: brain-link-enrichment.py",
        "---",
        "",
        f"# Synthesis — Index",
        "",
        "Long-form syntheses across the corpus.",
        "",
    ]
    for p in files:
        text = p.read_text()
        h1 = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
        title = h1.group(1).strip() if h1 else p.stem
        lines.append(f"- [[{p.stem}|{title}]]")
    (SYNTHESIS_DIR / "_Index.md").write_text("\n".join(lines) + "\n")


def main() -> int:
    log("link enrichment start")
    research_idx = index_research_notes()
    log(f"research notes indexed: {len(research_idx)}")

    added_shared = link_shared_to_research(research_idx)
    log(f"shared mirrors enriched with research links: {added_shared}")

    edited_themes = relink_theme_items(research_idx)
    log(f"theme notes edited: {edited_themes}")

    edited_synth = relink_synthesis_items(research_idx)
    log(f"synthesis notes edited: {edited_synth}")

    write_research_index(research_idx)
    write_themes_index()
    write_synthesis_index()
    log("indices regenerated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
