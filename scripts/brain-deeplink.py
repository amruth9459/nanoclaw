#!/usr/bin/env python3
"""Stage 5 — multi-hop graph traversal across the Brain knowledge graph.

Builds an adjacency index from the wiki graph, then for every fresh shared
item (last 14 days), finds 2-hop paths between today's active Claw entities and
entities the fresh item mentions. These are the "deep links" — connections you
wouldn't see from a one-hop overlap, but that the graph proves exist.

Hard caps (per the advisor's scope guard):
  - Max BFS depth: 2 (depth 3 over ~900 entities blows up).
  - Max fan-out per node: 25 (skip super-hubs that would saturate output).
  - Max paths per fresh item: 3 (best-by-shortness then by mid-node degree).

Output: data/brain-deeplinks.json — read by brain-digest.py.
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from services.wiki_compile.domains.brain import extract_entities  # noqa: E402

_GRAPH_DIR = Path("/Users/amrut/nanoclaw/data/brain-wiki/.knowledge_graph")
GRAPH_JSON = (
    _GRAPH_DIR / "knowledge_graph.canonical.json"
    if (_GRAPH_DIR / "knowledge_graph.canonical.json").exists()
    else _GRAPH_DIR / "knowledge_graph.json"
)
ALIASES_JSON = Path("/Users/amrut/nanoclaw/data/brain-aliases.json")


def _load_alias_map() -> dict[str, str]:
    if not ALIASES_JSON.exists():
        return {}
    try:
        return json.loads(ALIASES_JSON.read_text()).get("alias_map", {}) or {}
    except Exception:
        return {}


def canonicalize(names: set[str]) -> set[str]:
    m = _load_alias_map()
    return {m.get(n, n) for n in names}
SHARED_MIRROR = Path("/Users/amrut/Brain/Groups/_claw-shared")
DB_PATH = Path("/Users/amrut/nanoclaw/store/messages.db")
OUT = Path("/Users/amrut/nanoclaw/data/brain-deeplinks.json")
LOG = Path("/Users/amrut/nanoclaw/data/brain-deeplinks.log")

MAX_DEPTH = 2
MAX_FANOUT = 25
MAX_PATHS_PER_ITEM = 3
SHARED_DAYS = 14


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def load_graph() -> dict:
    if not GRAPH_JSON.exists():
        return {"entities": {}, "relationships": []}
    return json.loads(GRAPH_JSON.read_text())


def build_adjacency(graph: dict) -> dict[str, list[tuple[str, str]]]:
    """Undirected adjacency: each edge added in both directions with the verb."""
    adj: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for r in graph.get("relationships", []):
        s, t, rt = r.get("source"), r.get("target"), r.get("type")
        if not (s and t and rt) or s == t:
            continue
        adj[s].append((t, rt))
        adj[t].append((s, f"~{rt}"))  # ~ marks reverse direction
    # Cap fan-out to keep BFS bounded.
    for node, edges in adj.items():
        if len(edges) > MAX_FANOUT:
            adj[node] = edges[:MAX_FANOUT]
    return adj


def bfs_paths(start: str, targets: set[str], adj: dict[str, list[tuple[str, str]]],
              max_depth: int = MAX_DEPTH) -> list[list[tuple[str, str, str]]]:
    """Return all paths from `start` to any node in `targets`, depth ≤ max_depth.

    A path is a list of (src, verb, dst) triples.
    """
    if start in targets:
        return [[]]  # zero-hop, but we filter overlap=0 cases upstream
    found: list[list[tuple[str, str, str]]] = []
    queue: list[tuple[str, list[tuple[str, str, str]]]] = [(start, [])]
    visited: set[str] = {start}
    while queue:
        node, path = queue.pop(0)
        if len(path) >= max_depth:
            continue
        for nbr, verb in adj.get(node, []):
            if nbr in visited:
                continue
            new_path = path + [(node, verb, nbr)]
            if nbr in targets:
                found.append(new_path)
                continue  # don't expand past a target — keep paths short
            visited.add(nbr)
            queue.append((nbr, new_path))
    return found


def today_entities() -> set[str]:
    cutoff = datetime.now() - timedelta(hours=36)
    chunks: list[str] = []
    if not SHARED_MIRROR.exists():
        return set()
    files = sorted(SHARED_MIRROR.glob("*.md"))
    target = [p for p in files
              if datetime.fromtimestamp(p.stat().st_mtime) >= cutoff] or files[:2]
    for p in target:
        try:
            text = p.read_text()
        except Exception:
            continue
        chunks.append(re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.DOTALL))
    blob = "\n".join(chunks)[:12000]
    return {e["name"] for e in extract_entities(blob)}


def fetch_fresh_items() -> list[dict]:
    if not DB_PATH.exists():
        return []
    cutoff = (datetime.now(timezone.utc) - timedelta(days=SHARED_DAYS)).isoformat()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = list(conn.execute(
        "SELECT id, content, url, category, status, created_at, notes "
        "FROM shared_items WHERE created_at >= ? ORDER BY created_at DESC",
        (cutoff,),
    ))
    conn.close()
    out = []
    for r in rows:
        text = " ".join(filter(None, [r["content"], r["notes"], r["url"]]))
        ents = sorted({e["name"] for e in extract_entities(text)})
        out.append({
            "id": r["id"], "url": r["url"], "category": r["category"],
            "status": r["status"], "shared_at": r["created_at"],
            "title": (r["content"] or r["url"] or r["id"])[:120].strip(),
            "entities": ents,
            "notes": (r["notes"] or "")[:300],
        })
    return out


def score_path(path: list[tuple[str, str, str]], graph: dict) -> tuple[int, int]:
    """Lower score = better. Sort by length, then by avg degree of mid-nodes
    (lower = more specific, less hubby)."""
    length = len(path)
    if length <= 1:
        return (length, 0)
    mid = [p[2] for p in path[:-1]]
    degrees = [graph["entities"].get(m, {}).get("mentions", 1) for m in mid]
    return (length, sum(degrees) // max(1, len(degrees)))


def main() -> int:
    if not GRAPH_JSON.exists():
        log("FATAL: graph missing")
        return 2
    graph = load_graph()
    adj = build_adjacency(graph)
    log(f"adjacency: {len(adj)} nodes, {sum(len(v) for v in adj.values())} edges (capped)")

    today = canonicalize(today_entities())
    log(f"today's entities (canonicalized): {sorted(today)}")
    if not today:
        OUT.write_text(json.dumps({"deeplinks": []}))
        return 0

    fresh = fetch_fresh_items()
    log(f"fresh shared items: {len(fresh)}")

    deeplinks: list[dict] = []
    for item in fresh:
        item_ents = canonicalize(set(item["entities"]))
        if not item_ents:
            continue
        # If the item already has direct overlap, skip — it's already surfaced
        # by the digest's primary rank. Deep links are for the *non-obvious* hits.
        if item_ents & today:
            continue
        chains: list[dict] = []
        for src in today:
            paths = bfs_paths(src, item_ents, adj)
            for p in paths:
                if not p:
                    continue
                chains.append({
                    "from_today": src,
                    "to_fresh_entity": p[-1][2],
                    "hops": [{"src": s, "verb": v, "dst": d} for s, v, d in p],
                    "length": len(p),
                })
        if not chains:
            continue
        # Best by length-then-degree, dedupe on (src,dst)
        seen: set[tuple[str, str]] = set()
        chains.sort(key=lambda c: score_path(
            [(h["src"], h["verb"], h["dst"]) for h in c["hops"]], graph))
        unique: list[dict] = []
        for c in chains:
            key = (c["from_today"], c["to_fresh_entity"])
            if key in seen:
                continue
            seen.add(key)
            unique.append(c)
            if len(unique) >= MAX_PATHS_PER_ITEM:
                break
        deeplinks.append({
            "id": item["id"],
            "title": item["title"],
            "url": item["url"],
            "category": item["category"],
            "shared_at": item["shared_at"],
            "chains": unique,
        })

    # Sort: items with shortest best-chain first, then more chains.
    deeplinks.sort(key=lambda d: (
        min((c["length"] for c in d["chains"]), default=99),
        -len(d["chains"]),
    ))
    log(f"deeplinks: {len(deeplinks)} items with at least one ≤{MAX_DEPTH}-hop chain")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "today_entities": sorted(today),
        "deeplinks": deeplinks,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
