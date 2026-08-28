"""Brain domain — entity/relationship/claim extraction for the user's Brain
Obsidian vault and the synced Claw shared memory.

Unlike the Jyotish domain (closed taxonomy), Brain entities are auto-discovered
from the corpus itself — note titles, level 1-3 headings, frontmatter aliases,
and existing [[wikilinks]]. This avoids hardcoding a list that rots whenever a
new project appears.

Categories track Brain's existing top-level folder convention.
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

from ..lib import Domain, iter_source_files


# ── Configuration ───────────────────────────────────────────────────────────
BRAIN = Path("/Users/amrut/Brain")
CLAW_MIRROR = BRAIN / "Groups" / "_claw-shared"

GENERIC_WORDS = {
    "active", "agent", "agents", "after", "before", "backend", "frontend",
    "cache", "code", "cost", "costs", "created", "added", "change", "changes",
    "daily", "deployment", "core", "key", "keys", "next", "notes", "note",
    "results", "result", "status", "summary", "overview", "context",
    "background", "blockers", "blocker", "todo", "tasks", "task", "fix",
    "fixed", "bug", "bugs", "test", "tests", "build", "builds", "doc", "docs",
    "data", "files", "file", "issue", "issues", "feature", "features",
    "phase", "phases", "step", "steps", "config", "configs", "setup",
    "current", "active project", "active projects", "current task",
    "next steps", "key files", "key patterns", "key subsystems",
    "table of contents", "introduction", "conclusion",
    "appendix", "references", "reference", "links", "link", "see also",
    "accuracy", "capability", "memory", "kanban", "readme", "changelog",
    "devlog", "user", "soul", "index", "untitled",
    # Common emphasis / meta words that show up as ALL_CAPS in headings
    "critical", "important", "warning", "info", "note", "tip", "deprecated",
    "active work", "learned facts", "_index", "active project", "active projects",
    "current task", "in progress", "completed", "blocked", "tldr", "tl;dr",
    "abstract", "purpose", "goal", "goals", "scope", "out of scope",
    # Scaffolding section headings observed in the top-50 by mention count
    # (templates from triage docs, security guides, design docs, etc.)
    "triage notes", "executive summary", "key entities", "connections found",
    "source memories", "current state", "success metrics", "success criteria",
    "implementation plan", "implementation steps", "implementation roadmap",
    "risk assessment", "threat model", "rollback plan", "future enhancements",
    "database schema", "security hardening", "expected output", "quick start",
    "quick reference", "how it works", "this week", "month 1", "month 2", "month 3",
    "phase 1", "phase 2", "phase 3", "phase 4", "phase 5",
    "high", "medium", "low", "from", "to", "spec", "skill", "platform",
    "memory - main group", "whatsapp integration", "check logs",
    "scheduled tasks", "test plan", "test cases", "test results",
    "database functions", "api endpoints", "endpoint", "endpoints",
    "configuration", "deployment", "deployment plan", "deployment guide",
    "summary of changes", "summary of work", "summary of findings",
    "next steps", "actions", "action items", "deliverables", "milestones",
}

CATEGORY_FOLDERS = {
    "Lexios": "lexios",
    "Jyotish": "jyotish",
    "Groups": "groups",
    "Architecture": "architecture",
    "Strategy": "strategy",
    "Skills": "skills",
    "Products": "products",
    "Projects": "projects",
    "Hermes": "hermes",
    "Security": "security",
    "Learnings": "learnings",
    "Zettelkasten": "zettelkasten",
    "Conversations": "conversations",
    "Daily": "daily",
    "Inbox": "inbox",
    "Indexes": "indexes",
    "Notes": "notes",
    "Handoffs": "handoffs",
}


HEADING_RE = re.compile(r"^#{1,3}\s+(.+?)\s*$", re.MULTILINE)
WIKILINK_RE = re.compile(r"\[\[([^\|\]]+)(?:\|[^\]]+)?\]\]")
WORD_SPLIT = re.compile(r"[\s_\-]+")
PASCAL_CASE = re.compile(r"^(?:[A-Z][a-z0-9]+){2,}$")
ALL_CAPS_TOKEN = re.compile(r"^[A-Z][A-Z0-9_]{2,}$")
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)

MIN_TITLE_LEN = 4

# Verb-relationship patterns — generalised from Jyotish's list to project-graph
# vocabulary. Order matters (more specific first).
RELATIONSHIPS = {
    "depends_on": r"(?:depends on|relies on|requires|needs|built on|powered by)",
    "blocks": r"(?:blocks?|blocking|gated by|waiting on|prevents?)",
    "uses": r"(?:uses?|using|leverages?|imports?|integrates? with)",
    "implements": r"(?:implements?|provides?|exposes?|offers?)",
    "competes_with": r"(?:competes? with|vs\.?|alternative to|rivals?)",
    "extends": r"(?:extends?|inherits? from|derives? from|forks? of)",
    "produces": r"(?:produces?|generates?|emits?|outputs?)",
    "consumes": r"(?:consumes?|reads?|ingests?|subscribes? to)",
    "deprecates": r"(?:deprecates?|replaces?|supersedes?|obsoletes?)",
    "owned_by": r"(?:owned by|maintained by|by\s+\w+|authored by)",
    "ships_to": r"(?:ships? to|deployed to|hosted on|runs on)",
}


# ── Discovery (auto-build entity vocabulary) ────────────────────────────────
def _is_linkable(name: str) -> bool:
    if len(name) < MIN_TITLE_LEN:
        return False
    if name.lower() in GENERIC_WORDS:
        return False
    if name[0].isdigit() or name.startswith("."):
        return False
    parts = WORD_SPLIT.split(name)
    multiword = len(parts) >= 2
    pascal = bool(PASCAL_CASE.match(name))
    all_caps = bool(ALL_CAPS_TOKEN.match(name))
    has_internal_caps = any(c.isupper() for c in name[1:])
    if not (multiword or pascal or all_caps or has_internal_caps):
        return False
    if multiword:
        non_generic = [p for p in parts if p.lower() not in GENERIC_WORDS]
        if not non_generic:
            return False
    return True


def _classify_entity(name: str) -> str:
    """Best-effort entity-type tag based on shape/keywords."""
    low = name.lower()
    if any(k in low for k in ("api", "sdk", "cli", "service", "server", "daemon")):
        return "system"
    if any(k in low for k in ("yoga", "dasha", "graha", "house")):
        return "jyotish"
    if any(k in low for k in ("mvp", "launch", "roadmap", "plan", "strategy")):
        return "initiative"
    if "lexios" in low:
        return "lexios"
    if "claw" in low or "nano" in low:
        return "nanoclaw"
    if any(k in low for k in ("incident", "audit", "security", "compliance")):
        return "security"
    if "_" in name and name.isupper() == name:
        return "concept"
    if PASCAL_CASE.match(name):
        return "system"
    return "topic"


_DISCOVERY_CACHE: dict[Path, list[str]] | None = None


def _discover_entities(scan_roots: list[Path], min_mentions: int = 2) -> list[str]:
    """Walk vault, collect candidate entity names from titles, headings,
    [[wikilinks]], frontmatter aliases. Keep names that appear ≥min_mentions
    times across the corpus.

    Returns names sorted longest-first (so multi-word matches win over substrings).
    """
    counts: Counter[str] = Counter()
    for p in iter_source_files(scan_roots, "*.md", skip_path_parts=["_claw-shared"]):
        # _claw-shared is a real directory, not a link, so the walk's own
        # realpath dedup does not cover it: entities there already appear
        # via the source it mirrors.
        try:
            text = p.read_text()
        except Exception:
            continue
        stem = p.stem
        if _is_linkable(stem):
            counts[stem] += 1
        for m in HEADING_RE.finditer(text):
            h = re.sub(r"\s*\(.*\)$", "", m.group(1).strip().rstrip(":")).strip()
            if _is_linkable(h):
                counts[h] += 1
        for m in WIKILINK_RE.finditer(text):
            target = m.group(1).strip()
            if _is_linkable(target):
                counts[target] += 1
        fm = FRONTMATTER_RE.match(text)
        if fm:
            for line in fm.group(1).splitlines():
                if line.startswith("aliases:"):
                    # "aliases: [a, b]" or "aliases:\n  - a\n  - b"
                    aliases = re.findall(r"[\w\-\s]+", line.split(":", 1)[1])
                    for a in aliases:
                        a = a.strip()
                        if _is_linkable(a):
                            counts[a] += 1
    # Drop low-frequency noise; keep first-appearance for ones above threshold.
    keep = [name for name, c in counts.items() if c >= min_mentions]
    keep.sort(key=lambda n: (-len(n), n))
    return keep


def _entity_pattern(names: list[str]) -> re.Pattern:
    if not names:
        return re.compile(r"(?!x)x")  # never matches
    return re.compile(r"\b(" + "|".join(re.escape(n) for n in names) + r")\b")


# ── Domain callbacks ────────────────────────────────────────────────────────
def categorize(file_path: Path) -> str:
    """Use Brain folder as category; fall back to filename heuristics."""
    try:
        rel = file_path.relative_to(BRAIN)
    except ValueError:
        return "general"
    if not rel.parts:
        return "general"
    top = rel.parts[0]
    if top in CATEGORY_FOLDERS:
        return CATEGORY_FOLDERS[top]
    name = file_path.stem.lower()
    if "lexios" in name:
        return "lexios"
    if "jyotish" in name or "vedic" in name:
        return "jyotish"
    if "nanoclaw" in name or "claw" in name:
        return "nanoclaw"
    if "security" in name or "audit" in name:
        return "security"
    return "general"


_PATTERN_CACHE: dict[str, tuple[list[str], re.Pattern]] = {}


def _get_vocab() -> tuple[list[str], re.Pattern]:
    if "vocab" not in _PATTERN_CACHE:
        names = _discover_entities([BRAIN], min_mentions=2)
        _PATTERN_CACHE["vocab"] = (names, _entity_pattern(names))
    return _PATTERN_CACHE["vocab"]


def extract_entities(content: str) -> list[dict]:
    names, pattern = _get_vocab()
    seen: set[str] = set()
    entities: list[dict] = []
    for m in pattern.finditer(content):
        name = m.group(1)
        if name not in seen:
            seen.add(name)
            entities.append({"type": _classify_entity(name), "name": name})
    return entities


def extract_relationships(content: str, entities: list[dict]) -> list[dict]:
    relationships = []
    entity_names = [e["name"] for e in entities]
    if not entity_names:
        return relationships
    for rtype, pattern in RELATIONSHIPS.items():
        for match in re.finditer(pattern, content, re.IGNORECASE):
            ctx_start = max(0, match.start() - 120)
            ctx = content[ctx_start:match.end() + 120]
            local_match_start = match.start() - ctx_start
            source = target = None
            for name in entity_names:
                low = name.lower()
                if low in ctx[:local_match_start].lower():
                    source = name
                if low in ctx[match.end() - ctx_start:].lower():
                    target = name
            if source and target and source != target:
                relationships.append({
                    "type": rtype, "source": source, "target": target,
                    "confidence": 0.6,
                })
    # Deduplicate by (source, type, target)
    seen = set()
    unique = []
    for r in relationships:
        key = (r["source"], r["type"], r["target"])
        if key not in seen:
            seen.add(key)
            unique.append(r)
    return unique[:40]


def extract_claims(content: str) -> list[dict]:
    """Quantitative claims worth tracking — KPIs, percentages, version numbers,
    durations, dollar amounts. Generic pattern set, deliberately small.
    """
    claims = []
    patterns = [
        (r"\$[\d,]+(?:\.\d+)?[kKmMbB]?\b", "money"),
        (r"\b\d{1,3}(?:\.\d+)?\s*%\b", "percent"),
        (r"\bF1\s*=\s*\d+(?:\.\d+)?%?\b", "f1"),
        (r"\bv\d+(?:\.\d+){0,2}\b", "version"),
        (r"\b\d+\s*(?:ms|s|min|hr|hours?|days?|weeks?)\b", "duration"),
        (r"\b\d+/\d+\b", "ratio"),
    ]
    for pattern, label in patterns:
        for match in re.finditer(pattern, content):
            claims.append({"raw": match.group(0), "kind": label})
    return claims[:20]


def make_domain(base: Path | None = None) -> Domain:
    """Build the Brain domain.

    Source corpus = the entire Brain vault (including the synced _claw-shared
    mirror). Compiled output, metadata, and knowledge graph are written under
    `base`, which defaults to an out-of-vault location so Obsidian doesn't
    render them and we don't recursively re-ingest our own outputs.
    """
    base = base or Path("/Users/amrut/nanoclaw/data/brain-wiki")
    return Domain(
        name="brain",
        base=base,
        title_label="Brain",
        categorize=categorize,
        extract_entities=extract_entities,
        extract_relationships=extract_relationships,
        extract_claims=extract_claims,
        raw_dirs=[BRAIN],
        file_glob="*.md",
        # Daily digests are generated *from* the graph; ingesting them back in
        # would cycle yesterday's noise forward forever.
        skip_path_parts=["Daily"],
    )
