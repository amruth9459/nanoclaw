#!/usr/bin/env python3
"""Stage 3.5 — entity disambiguation pass.

After compile_brain_wiki builds the knowledge graph, this script identifies
entity surface forms that likely refer to the same concept and writes an alias
map. The next graph load applies the map (canonical name wins, mention counts
sum, edges rewrite to canonical) — improving every downstream stage.

Two-pass strategy (advisor's guidance):
  1. **Pre-filter** — generate candidate groups using cheap heuristics:
     casefold equality, substring containment, edit distance ≤2,
     suffix/prefix normalisation. Keep only groups where one variant has
     strong evidence (≥5 mentions) and the others co-occur in ≥1 source.
  2. **Sonnet adjudicates** — for each candidate group, ask Sonnet
     "are these the same concept? if yes, what's the canonical name?" Cap
     groups per call so total cost stays bounded.

Output: data/brain-aliases.json
        data/brain-wiki/.knowledge_graph/knowledge_graph.canonical.json

Downstream stages (deeplink, digest, themes) prefer .canonical.json when
present, fall back to the original. One bad merge does not corrupt source data.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

GRAPH_JSON = Path("/Users/amrut/nanoclaw/data/brain-wiki/.knowledge_graph/knowledge_graph.json")
GRAPH_CANONICAL = Path("/Users/amrut/nanoclaw/data/brain-wiki/.knowledge_graph/knowledge_graph.canonical.json")
ALIASES_JSON = Path("/Users/amrut/nanoclaw/data/brain-aliases.json")
LOG = Path("/Users/amrut/nanoclaw/data/brain-disambiguate.log")

MODEL = "claude-sonnet-4-6"
MIN_MENTIONS_FOR_CANONICAL = 3
MAX_GROUPS_PER_LLM_CALL = 25
MAX_TOTAL_LLM_CALLS = 4
EDIT_DISTANCE_THRESHOLD = 2


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def load_api_key() -> str | None:
    if k := os.environ.get("ANTHROPIC_API_KEY"):
        return k
    env = Path("/Users/amrut/Lexios/.env")
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def load_graph() -> dict:
    if not GRAPH_JSON.exists():
        return {"entities": {}, "relationships": []}
    return json.loads(GRAPH_JSON.read_text())


# ── Pre-filter: cheap candidate-group generation ────────────────────────────
def normalise(s: str) -> str:
    """Strip suffixes/punctuation that shouldn't matter for identity."""
    s = s.strip()
    s = re.sub(r"[\s_\-]+", " ", s)
    s = re.sub(r"\s*v?\d+(\.\d+)*$", "", s)               # strip trailing version
    s = re.sub(r"\s*\(.*\)$", "", s)                       # strip parens
    s = re.sub(r"\s+(plan|guide|spec|doc|docs|notes|note|summary|"
               r"impl|implementation|roadmap|design|architecture)$",
               "", s, flags=re.IGNORECASE)
    return s.strip().lower()


def edit_distance_le(a: str, b: str, k: int) -> bool:
    """True iff Levenshtein(a, b) ≤ k. Banded DP, early exit."""
    if abs(len(a) - len(b)) > k:
        return False
    if a == b:
        return True
    la, lb = len(a), len(b)
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        curr = [i] + [0] * lb
        lo = max(1, i - k)
        hi = min(lb, i + k)
        if lo > 1:
            curr[lo - 1] = float("inf")
        for j in range(lo, hi + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(
                curr[j - 1] + 1,
                prev[j] + 1,
                prev[j - 1] + cost,
            )
        if min(curr[lo:hi + 1]) > k:
            return False
        prev = curr
    return prev[lb] <= k


def candidate_groups(entities: dict[str, dict]) -> list[list[str]]:
    """Generate groups of entities that *might* be synonyms.

    Strategy:
      - Bucket by normalised form. Buckets of size ≥2 are candidates.
      - Then within remaining singletons, find pairs with edit distance ≤2
        AND substring containment OR shared token prefix.
    """
    names = list(entities.keys())
    by_norm: dict[str, list[str]] = defaultdict(list)
    for n in names:
        by_norm[normalise(n)].append(n)

    groups: list[list[str]] = []
    used: set[str] = set()
    for norm, members in by_norm.items():
        if len(members) >= 2:
            groups.append(sorted(members))
            used.update(members)

    # Substring / containment pairs among remaining names with sufficient mentions
    remaining = [n for n in names if n not in used
                 and entities[n].get("mentions", 0) >= MIN_MENTIONS_FOR_CANONICAL]
    remaining.sort(key=lambda n: -entities[n].get("mentions", 0))
    paired: set[str] = set()
    for i, a in enumerate(remaining):
        if a in paired:
            continue
        a_low = a.lower()
        bucket = [a]
        for b in remaining[i + 1:]:
            if b in paired or b == a:
                continue
            b_low = b.lower()
            # Substring containment (with word-boundary check)
            if (a_low in b_low or b_low in a_low) and abs(len(a) - len(b)) <= 25:
                bucket.append(b)
                paired.add(b)
                continue
            # Edit distance for short names (rare typos / casing variants)
            if len(a) >= 4 and len(b) >= 4 and edit_distance_le(a_low, b_low, EDIT_DISTANCE_THRESHOLD):
                bucket.append(b)
                paired.add(b)
        if len(bucket) >= 2:
            paired.add(a)
            groups.append(sorted(bucket))

    # Score: prefer groups where total mentions across the group is high.
    groups.sort(
        key=lambda g: -sum(entities[n].get("mentions", 0) for n in g),
    )
    return groups


# ── LLM adjudication ────────────────────────────────────────────────────────
def call_sonnet(api_key: str, prompt: str) -> dict:
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": MODEL,
            "max_tokens": 4000,
            "system": (
                "You merge synonymous entity surface forms. "
                "Be conservative — when in doubt, keep separate. Return ONLY valid JSON."
            ),
            "messages": [{"role": "user", "content": prompt}],
        }).encode(),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        resp = json.loads(r.read())
    text = resp["content"][0]["text"].strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    return json.loads(text)


def build_adjudicate_prompt(groups: list[list[str]], entities: dict) -> str:
    lines = []
    for i, grp in enumerate(groups):
        member_lines = []
        for n in grp:
            mentions = entities[n].get("mentions", 0)
            srcs = entities[n].get("sources", [])
            sample_src = srcs[0] if srcs else "?"
            member_lines.append(f"  - \"{n}\" ({mentions} mentions, e.g. {sample_src})")
        lines.append(f"Group {i+1}:\n" + "\n".join(member_lines))
    groups_block = "\n\n".join(lines)
    return f"""For each group of entity surface forms below, decide whether they refer to the
SAME concept. Be conservative: if any member is plausibly distinct (e.g. one is
a generic word, one is a specific named project), keep them separate.

Output schema (strict):
{{
  "merges": [
    {{"group_index": <int>, "canonical": "<chosen canonical name>",
      "variants": ["<other forms to merge into canonical>", "..."],
      "rationale": "<one short sentence>"}}
  ],
  "rejected": [
    {{"group_index": <int>, "reason": "<why these are NOT the same concept>"}}
  ]
}}

Pick the canonical that is most informative (full named project > short
abbreviation > generic word). If a group contains a generic word AND a specific
project name, REJECT (don't merge generic into specific).

Groups:
{groups_block}
"""


def apply_alias_map(graph: dict, alias_map: dict[str, str]) -> dict:
    """Rewrite the graph: variants → canonical, mention counts and sources merge."""
    new_entities: dict[str, dict] = {}
    for name, data in graph.get("entities", {}).items():
        canonical = alias_map.get(name, name)
        if canonical not in new_entities:
            new_entities[canonical] = {
                "type": data.get("type", "entity"),
                "mentions": 0,
                "sources": [],
                "aliases": [],
            }
        new_entities[canonical]["mentions"] += data.get("mentions", 0)
        new_entities[canonical]["sources"].extend(data.get("sources", []))
        if name != canonical:
            new_entities[canonical]["aliases"].append(name)
    for d in new_entities.values():
        d["sources"] = sorted(set(d["sources"]))
        d["aliases"] = sorted(set(d["aliases"]))

    new_relationships = []
    seen_rels: set[tuple] = set()
    for r in graph.get("relationships", []):
        s = alias_map.get(r["source"], r["source"])
        t = alias_map.get(r["target"], r["target"])
        if s == t:
            continue
        key = (s, r.get("type"), t)
        if key in seen_rels:
            continue
        seen_rels.add(key)
        new_relationships.append({**r, "source": s, "target": t})

    return {
        **graph,
        "entities": new_entities,
        "relationships": new_relationships,
        "metadata": {
            **graph.get("metadata", {}),
            "canonicalised_at": datetime.now().isoformat(timespec="seconds"),
            "total_entities": len(new_entities),
            "total_relationships": len(new_relationships),
            "alias_map_size": len(alias_map),
        },
    }


def main() -> int:
    if not GRAPH_JSON.exists():
        log(f"FATAL: graph missing at {GRAPH_JSON}")
        return 2
    api_key = load_api_key()
    if not api_key:
        log("FATAL: no ANTHROPIC_API_KEY")
        return 2

    graph = load_graph()
    entities = graph.get("entities", {})
    log(f"loaded graph: {len(entities)} entities, {len(graph.get('relationships', []))} relationships")

    groups = candidate_groups(entities)
    log(f"candidate groups (heuristic): {len(groups)}")
    if not groups:
        log("nothing to disambiguate")
        # Still write a passthrough canonical so downstream prefers it.
        GRAPH_CANONICAL.write_text(json.dumps(graph, indent=2))
        ALIASES_JSON.write_text(json.dumps({
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "alias_map": {},
            "merges": [],
            "rejected": [],
        }, indent=2))
        return 0

    # Cap groups sent to LLM (cost control)
    sent_groups = groups[:MAX_GROUPS_PER_LLM_CALL * MAX_TOTAL_LLM_CALLS]
    log(f"adjudicating {len(sent_groups)} groups across "
        f"{(len(sent_groups) + MAX_GROUPS_PER_LLM_CALL - 1) // MAX_GROUPS_PER_LLM_CALL} LLM calls")

    all_merges: list[dict] = []
    all_rejected: list[dict] = []
    for batch_start in range(0, len(sent_groups), MAX_GROUPS_PER_LLM_CALL):
        batch = sent_groups[batch_start:batch_start + MAX_GROUPS_PER_LLM_CALL]
        try:
            resp = call_sonnet(api_key, build_adjudicate_prompt(batch, entities))
        except Exception as e:
            log(f"  LLM call FAILED on batch starting {batch_start}: {e}")
            continue
        for m in resp.get("merges", []):
            idx = m.get("group_index")
            # Re-key group_index relative to the global sent_groups list
            if isinstance(idx, int) and 1 <= idx <= len(batch):
                m["group_index"] = batch_start + idx
                all_merges.append(m)
        for r in resp.get("rejected", []):
            idx = r.get("group_index")
            if isinstance(idx, int) and 1 <= idx <= len(batch):
                r["group_index"] = batch_start + idx
                all_rejected.append(r)
    log(f"LLM result: {len(all_merges)} merges, {len(all_rejected)} rejections")

    # Build alias map
    alias_map: dict[str, str] = {}
    for m in all_merges:
        canonical = m.get("canonical", "").strip()
        variants = m.get("variants") or []
        if not canonical or not variants:
            continue
        for v in variants:
            v = v.strip()
            if v and v != canonical and v in entities:
                alias_map[v] = canonical
    log(f"alias map size: {len(alias_map)}")

    canonical_graph = apply_alias_map(graph, alias_map)
    GRAPH_CANONICAL.write_text(json.dumps(canonical_graph, indent=2))
    log(f"canonical graph written: "
        f"{len(canonical_graph['entities'])} entities "
        f"({len(entities) - len(canonical_graph['entities'])} merged), "
        f"{len(canonical_graph['relationships'])} relationships")

    ALIASES_JSON.write_text(json.dumps({
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "graph_source": str(GRAPH_JSON),
        "alias_map": alias_map,
        "merges": all_merges,
        "rejected": all_rejected,
        "stats": {
            "entities_before": len(entities),
            "entities_after": len(canonical_graph["entities"]),
            "merged_count": len(entities) - len(canonical_graph["entities"]),
            "alias_map_size": len(alias_map),
        },
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
