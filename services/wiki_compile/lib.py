"""Generic LLM Wiki v2 compile pipeline.

Pipeline stages (per the Jyotish compiler that originated this design):
    raw/ → categorize → extract_entities → extract_relationships → extract_claims
        → metadata + confidence → compiled/ → knowledge_graph.json → index.md

A `Domain` bundles the four extraction callables + the on-disk paths. The lib
runs the pipeline; domains stay declarative.
"""
from __future__ import annotations

import fnmatch
import json
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable


@dataclass
class Domain:
    """A wiki domain — Jyotish, Brain, Lexios all plug in here."""

    name: str
    base: Path  # wiki home (contains raw/, compiled/, .wiki_meta/, .knowledge_graph/)
    categorize: Callable[[Path], str]
    extract_entities: Callable[[str], list[dict]]  # returns [{"type": str, "name": str}]
    extract_relationships: Callable[[str, list[dict]], list[dict]]
    extract_claims: Callable[[str], list[dict]]
    raw_dirs: list[Path] = field(default_factory=list)  # if empty, defaults to base/raw
    file_glob: str = "*.md"
    title_label: str = ""  # e.g. "Jyotish", "Brain". Used in printed banners.
    # Path-part substrings to skip during raw scans. E.g. for Brain we skip
    # ["Daily"] so generated daily digests don't cycle back into the graph.
    skip_path_parts: list[str] = field(default_factory=list)

    @property
    def raw(self) -> list[Path]:
        return self.raw_dirs or [self.base / "raw"]

    @property
    def compiled(self) -> Path:
        return self.base / "compiled"

    @property
    def meta_dir(self) -> Path:
        return self.base / ".wiki_meta"

    @property
    def graph_dir(self) -> Path:
        return self.base / ".knowledge_graph"

    @property
    def state_path(self) -> Path:
        return self.base / ".compile_state.json"

    def ensure_dirs(self) -> None:
        self.compiled.mkdir(parents=True, exist_ok=True)
        self.meta_dir.mkdir(parents=True, exist_ok=True)
        self.graph_dir.mkdir(parents=True, exist_ok=True)


def iter_source_files(
    roots: Iterable[Path],
    file_glob: str = "*.md",
    skip_path_parts: Iterable[str] = (),
) -> list[Path]:
    """Every matching source file under `roots`, descending through symlinked
    directories.

    `Path.rglob` never follows a symlinked directory, and this vault keeps whole
    categories behind exactly one: `Brain/Zettelkasten` (493 notes),
    `Brain/Products`, and most of `Hermes` and `Lexios` are directories in
    nanoclaw that are linked into the vault. Every walk built on rglob read them
    as empty, and read them as empty *quietly* — the compile reported success
    and the category simply never appeared in `compiled/`.

    Each real directory and each real file is visited once. That makes a
    symlink pointing at an ancestor terminate instead of looping, and it means a
    file reachable by two vault paths (`Lexios/Corpus` and `Groups/claw-lexios-3`
    are the same directory on disk, 19 files) is ingested once rather than
    compiled twice into two categories under one shared `.wiki_meta` slug.
    Directory names are sorted before descending, so which of the two paths is
    kept is stable across runs rather than dependent on inode order.
    """
    skip = set(skip_path_parts)
    seen_dirs: set[str] = set()
    seen_files: set[str] = set()
    found: list[Path] = []
    for root in roots:
        if not root.exists():
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
            real_dir = os.path.realpath(dirpath)
            if real_dir in seen_dirs:
                dirnames[:] = []
                continue
            seen_dirs.add(real_dir)
            dirnames[:] = sorted(d for d in dirnames if d not in skip)
            here = Path(dirpath)
            if skip.intersection(here.parts):
                continue
            for name in sorted(fnmatch.filter(filenames, file_glob)):
                path = here / name
                real = os.path.realpath(path)
                if real in seen_files:
                    continue
                seen_files.add(real)
                found.append(path)
    return found


def calculate_confidence(sources: list, last_confirmed: str, contradictions: int = 0) -> float:
    """Original Jyotish formula — kept verbatim so confidence values stay comparable."""
    source_score = min(len(sources) * 0.3, 0.9)
    try:
        days_ago = (datetime.now() - datetime.fromisoformat(last_confirmed)).days
        recency_score = 0.1 if days_ago < 7 else (0.05 if days_ago < 30 else 0.0)
    except Exception:
        recency_score = 0.0
    return round(max(0.0, min(1.0, source_score + recency_score - contradictions * 0.2)), 2)


def _load_state(domain: Domain) -> dict:
    if not domain.state_path.exists():
        return {}
    try:
        return json.loads(domain.state_path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        # A state file written by an older non-atomic save, or truncated by a
        # crash. Losing it costs one full recompile, so continue — but say so,
        # because a run that silently starts from an empty state looks exactly
        # like a run that had nothing to do.
        print(f"  ! compile state unreadable ({exc}); recompiling from scratch")
        return {}


def _save_state(domain: Domain, state: dict) -> None:
    """Write via a temp file in the same directory, then rename.

    `brain-watch.py` spawns its own compile, so two runs share this file
    routinely. A plain write_text leaves it truncated for the length of the
    write and the other process dies on a half-written JSON — which is how a
    seven-minute run ended at file 900. os.replace is atomic on POSIX, so a
    reader sees either the old state or the new one. Two runs still overwrite
    each other's entries; the cost of that is a redundant recompile, not a
    crash."""
    tmp = domain.state_path.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(tmp, domain.state_path)


def _file_key(file_path: Path, raw_dirs: list[Path]) -> str:
    """Stable key relative to whichever raw dir the file lives under."""
    for r in raw_dirs:
        try:
            return str(file_path.relative_to(r))
        except ValueError:
            continue
    return str(file_path)


def compile_file(domain: Domain, file_path: Path, force: bool = False) -> dict | None:
    state = _load_state(domain)
    file_key = _file_key(file_path, domain.raw)
    last_mtime = state.get(file_key, 0)
    try:
        current_mtime = file_path.stat().st_mtime
    except (FileNotFoundError, OSError):
        # Broken symlink or transient file — skip without aborting the run.
        return None
    if not force and current_mtime <= last_mtime:
        return None

    try:
        content = file_path.read_text()
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return None
    category = domain.categorize(file_path)
    slug = file_path.stem.replace(" ", "_").lower()
    wiki_path = domain.compiled / category / f"{slug}.md"
    wiki_path.parent.mkdir(parents=True, exist_ok=True)

    meta_path = domain.meta_dir / f"{slug}.json"
    existing = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    entities = domain.extract_entities(content)
    relationships = domain.extract_relationships(content, entities)
    claims = domain.extract_claims(content)
    sources = list(set(existing.get("sources", []) + [file_key]))

    metadata = {
        "id": slug,
        "category": category,
        "sources": sources,
        "created": existing.get("created", datetime.now().isoformat()),
        "last_updated": datetime.now().isoformat(),
        "last_confirmed": datetime.now().isoformat(),
        "confidence": calculate_confidence(sources, datetime.now().isoformat()),
        "version": existing.get("version", 0) + 1,
        "status": "active",
        "claims": claims,
        "entities": [e["name"] for e in entities],
        "entity_count": len(entities),
        "relationship_count": len(relationships),
        "tier": "semantic",
    }

    meta_path.write_text(json.dumps(metadata, indent=2))

    article = (
        f"# {file_path.stem.replace('-', ' ').replace('_', ' ').title()}\n\n"
        "---\n"
        f"**Category:** {category} | **Confidence:** {metadata['confidence']} | **Version:** {metadata['version']}\n"
        f"**Entities:** {len(entities)} | **Last updated:** {metadata['last_updated'][:10]}\n"
        "---\n\n"
        f"{content}\n"
    )
    wiki_path.write_text(article)

    state[file_key] = current_mtime
    _save_state(domain, state)

    return {
        "path": str(wiki_path.relative_to(domain.base)),
        "category": category,
        "entities": len(entities),
        "relationships": len(relationships),
        "confidence": metadata["confidence"],
    }


def build_knowledge_graph(domain: Domain) -> dict:
    all_entities: dict[str, dict] = {}
    all_relationships: list[dict] = []

    for raw_file in iter_source_files(
        domain.raw, domain.file_glob, domain.skip_path_parts
    ):
        try:
            content = raw_file.read_text()
        except Exception:
            continue
        entities = domain.extract_entities(content)
        relationships = domain.extract_relationships(content, entities)

        for e in entities:
            key = e["name"]
            if key not in all_entities:
                all_entities[key] = {"type": e.get("type", "entity"), "mentions": 0, "sources": []}
            all_entities[key]["mentions"] += 1
            all_entities[key]["sources"].append(raw_file.name)

        all_relationships.extend(relationships)

    for e in all_entities.values():
        e["sources"] = list(set(e["sources"]))

    graph = {
        "domain": domain.name,
        "entities": all_entities,
        "relationships": all_relationships,
        "metadata": {
            "created": datetime.now().isoformat(),
            "total_entities": len(all_entities),
            "total_relationships": len(all_relationships),
        },
    }

    graph_path = domain.graph_dir / "knowledge_graph.json"
    graph_path.write_text(json.dumps(graph, indent=2))
    print(f"  Knowledge graph: {len(all_entities)} entities, {len(all_relationships)} relationships")
    return graph


def generate_index(domain: Domain) -> None:
    articles_by_cat: dict[str, list[dict]] = defaultdict(list)
    for wiki_path in domain.compiled.rglob("*.md"):
        if wiki_path.name == "index.md":
            continue
        meta_path = domain.meta_dir / f"{wiki_path.stem}.json"
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        articles_by_cat[meta.get("category", "general")].append({
            "title": wiki_path.stem.replace("-", " ").replace("_", " ").title(),
            "path": str(wiki_path.relative_to(domain.compiled)),
            "confidence": meta.get("confidence", 0),
            "entities": meta.get("entity_count", 0),
        })

    label = domain.title_label or domain.name.title()
    out = f"# {label} Knowledge Base Index\n\n**Updated:** {datetime.now().isoformat()[:10]}\n\n"
    for cat in sorted(articles_by_cat.keys()):
        out += f"\n## {cat.title()}\n\n"
        for a in sorted(articles_by_cat[cat], key=lambda x: -x["confidence"]):
            out += f"- [{a['confidence']:.2f}] [{a['title']}]({a['path']}) ({a['entities']} entities)\n"

    (domain.compiled / "index.md").write_text(out)


def compile_all(domain: Domain, force: bool = False) -> int:
    domain.ensure_dirs()
    label = domain.title_label or domain.name.title()
    print(f"=== {label} Knowledge Base Compilation ===\n")
    compiled = 0
    for f in iter_source_files(domain.raw, domain.file_glob, domain.skip_path_parts):
        result = compile_file(domain, f, force=force)
        if result:
            print(
                f"  {result['path']} ({result['category']}, "
                f"{result['entities']} entities, conf={result['confidence']})"
            )
            compiled += 1

    print(f"\n  Compiled {compiled} files")
    build_knowledge_graph(domain)
    generate_index(domain)
    print("  Done.")
    return compiled


def show_stats(domain: Domain) -> None:
    label = domain.title_label or domain.name.title()
    print(f"\n=== {label} Wiki Stats ===")
    total = 0
    confs: list[float] = []
    cats: dict[str, int] = defaultdict(int)
    for f in domain.meta_dir.glob("*.json"):
        m = json.loads(f.read_text())
        total += 1
        confs.append(m.get("confidence", 0))
        cats[m.get("category", "?")] += 1
    if confs:
        print(f"  Articles: {total}")
        print(f"  Avg confidence: {sum(confs) / len(confs):.2f}")
        print(f"  Categories: {dict(cats)}")
    graph_path = domain.graph_dir / "knowledge_graph.json"
    if graph_path.exists():
        g = json.loads(graph_path.read_text())
        print(f"  Entities: {g['metadata']['total_entities']}")
        print(f"  Relationships: {g['metadata']['total_relationships']}")
