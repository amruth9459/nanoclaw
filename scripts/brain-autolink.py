#!/usr/bin/env python3
"""
Brain Vault Auto-Linker
Scans ~/Brain for markdown files without a ## Related section and adds
cross-references based on keyword overlap and entity co-occurrence.

Usage:
  python3 scripts/brain-autolink.py              # Link all unlinked files
  python3 scripts/brain-autolink.py --dry-run    # Preview without writing
  python3 scripts/brain-autolink.py --force      # Re-link even files with existing ## Related
  python3 scripts/brain-autolink.py --file X.md  # Link a single file

Designed to run on session end via memory-bridge.sh hook.
"""
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

BRAIN = Path(os.environ.get("BRAIN_VAULT_PATH", os.path.expanduser("~/Brain")))
MAX_LINKS = 6
MIN_SCORE = 0.05
SKIP_DIRS = {".obsidian", ".trash", "node_modules", ".git"}
SKIP_STEMS = {"_Index", "Brain Map"}

# ── Keyword extraction ───────────────────────────────────────────────────

STOP_WORDS = {
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "her",
    "was", "one", "our", "out", "has", "had", "its", "this", "that", "with",
    "from", "have", "been", "will", "they", "each", "make", "like", "than",
    "them", "into", "some", "when", "what", "which", "their", "about",
    "would", "there", "could", "other", "more", "very", "also", "just",
    "should", "these", "after", "above", "such", "being", "through", "most",
    "does", "here", "where", "over", "between", "before", "while",
    "related", "note", "notes", "tags", "true", "false", "type", "created",
    "updated", "source", "domain", "file", "files", "see", "use", "using",
}


def extract_keywords(text: str) -> Counter:
    """Extract meaningful keywords from markdown text."""
    # Strip YAML frontmatter
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.DOTALL)
    # Strip wikilinks but keep display text
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", text)
    # Strip markdown formatting
    text = re.sub(r"[#*`>\-|=]", " ", text)
    # Strip URLs
    text = re.sub(r"https?://\S+", "", text)

    words = re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", text.lower())
    keywords = Counter()
    for w in words:
        if w not in STOP_WORDS and len(w) > 2:
            keywords[w] += 1
    return keywords


def extract_entities(text: str) -> set:
    """Extract capitalized entity names (project names, acronyms)."""
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.DOTALL)
    entities = set()
    # Multi-word capitalized phrases
    for m in re.finditer(r"[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+", text):
        entities.add(m.group().lower())
    # Acronyms (2+ uppercase)
    for m in re.finditer(r"\b[A-Z]{2,}\b", text):
        entities.add(m.group().lower())
    return entities


# ── Scoring ──────────────────────────────────────────────────────────────

def jaccard(a: Counter, b: Counter) -> float:
    keys = set(a) | set(b)
    if not keys:
        return 0.0
    intersection = sum(min(a.get(k, 0), b.get(k, 0)) for k in keys)
    union = sum(max(a.get(k, 0), b.get(k, 0)) for k in keys)
    return intersection / union if union else 0.0


def section_of(rel_path: str) -> str:
    parts = Path(rel_path).parts
    return parts[0] if len(parts) > 1 else "root"


# ── Main ─────────────────────────────────────────────────────────────────

def main():
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    single_file = None
    if "--file" in sys.argv:
        idx = sys.argv.index("--file")
        if idx + 1 < len(sys.argv):
            single_file = sys.argv[idx + 1]

    if not BRAIN.exists():
        print(f"Brain vault not found at {BRAIN}")
        sys.exit(1)

    # Index all markdown files
    files = {}  # rel_path -> content
    for p in BRAIN.rglob("*.md"):
        rel = str(p.relative_to(BRAIN))
        if any(d in rel.split(os.sep) for d in SKIP_DIRS):
            continue
        if p.stem in SKIP_STEMS:
            continue
        try:
            content = p.read_text(errors="replace")
            files[rel] = content
        except Exception:
            continue

    print(f"Indexed {len(files)} markdown files")

    # Build keyword and entity indexes
    kw_index = {}  # rel_path -> Counter
    ent_index = {}  # rel_path -> set
    inv_index = defaultdict(set)  # keyword -> set of rel_paths

    for rel, content in files.items():
        kw = extract_keywords(content)
        ent = extract_entities(content)
        kw_index[rel] = kw
        ent_index[rel] = ent
        for word in kw:
            inv_index[word].add(rel)

    # Determine which files need linking
    if single_file:
        targets = [single_file] if single_file in files else []
        if not targets:
            # Try matching by stem
            for rel in files:
                if Path(rel).stem == Path(single_file).stem:
                    targets.append(rel)
                    break
    elif force:
        targets = list(files.keys())
    else:
        # Only files without ## Related
        targets = [rel for rel, content in files.items()
                    if "## Related" not in content]

    print(f"Linking {len(targets)} files ({'dry run' if dry_run else 'live'})")

    linked = 0
    for rel_a in targets:
        kw_a = kw_index[rel_a]
        ent_a = ent_index[rel_a]
        section_a = section_of(rel_a)

        if not kw_a:
            continue

        # Find candidate files via inverted index (share at least one keyword)
        candidates = set()
        for word in kw_a:
            candidates |= inv_index[word]
        candidates.discard(rel_a)

        if not candidates:
            continue

        # Score each candidate
        scored = []
        for rel_b in candidates:
            kw_b = kw_index[rel_b]
            ent_b = ent_index[rel_b]

            score = jaccard(kw_a, kw_b)

            # Bonus for entity overlap
            common_ent = ent_a & ent_b
            if common_ent:
                score += 0.1 * len(common_ent)

            if score >= MIN_SCORE:
                scored.append((rel_b, score))

        if not scored:
            continue

        scored.sort(key=lambda x: -x[1])

        # Select with cross-section diversity
        selected = []
        sections_seen = Counter()
        for rel_b, score in scored:
            sec = section_of(rel_b)
            # Allow max 2 from same section unless it's the only option
            if sections_seen[sec] >= 2 and len(scored) > MAX_LINKS:
                continue
            selected.append((rel_b, score))
            sections_seen[sec] += 1
            if len(selected) >= MAX_LINKS:
                break

        if not selected:
            continue

        # Build Related section
        lines = ["\n## Related\n"]
        for rel_b, score in selected:
            stem = Path(rel_b).stem
            display = stem.replace("-", " ").replace("_", " ").title()
            lines.append(f"- [[{stem}|{display}]]")
        related_block = "\n".join(lines) + "\n"

        if dry_run:
            print(f"  {rel_a}: would add {len(selected)} links")
            continue

        # Write to file
        filepath = BRAIN / rel_a
        content = files[rel_a]

        # Remove existing ## Related if --force
        if force and "## Related" in content:
            content = re.sub(
                r"\n## Related\n.*?(?=\n## |\Z)", "", content, flags=re.DOTALL
            )

        content = content.rstrip() + "\n" + related_block
        filepath.write_text(content)
        linked += 1

    print(f"Linked {linked} files with cross-references")

    # Quick stats
    total_links = 0
    resolved = 0
    all_stems = {Path(r).stem for r in files}
    for content in files.values():
        for m in re.finditer(r"\[\[([^|\]]+)", content):
            total_links += 1
            if m.group(1) in all_stems:
                resolved += 1

    print(f"Vault stats: {len(files)} files, ~{total_links} wikilinks, ~{resolved} resolved")


if __name__ == "__main__":
    main()
