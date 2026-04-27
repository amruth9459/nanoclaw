#!/usr/bin/env python3
"""Stage 6.5 — thematic synthesis across the day's signals.

Given:
  - research summaries (fetched URLs analysed by Haiku)
  - fresh shared items (last 14d, with overlap)
  - top relevant Brain notes (entity-overlap rank)
  - the knowledge graph

Cluster items that share entities. For every cluster of ≥3 items, ask Sonnet
to write a real synthesis paragraph: what's emerging, what it implies for the
user's current work, and what they should do or learn next. Each cluster
becomes one Markdown note in Brain/Inbox/themes/{date}-{slug}.md.

The output of this stage feeds back into the digest as a "Themes" section.
Themes are deeper than per-item analysis because they connect *multiple*
items into a single thesis — the synthesis the user actually asked for.
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

from services.wiki_compile.domains.brain import BRAIN  # noqa: E402
from services.wiki_compile.identity import load_user_context  # noqa: E402
from services.wiki_compile.llm import call_claude  # noqa: E402

RESEARCH_JSON = Path("/Users/amrut/nanoclaw/data/brain-research.json")
DEEPLINKS_JSON = Path("/Users/amrut/nanoclaw/data/brain-deeplinks.json")
LATEST_DIGEST = Path("/Users/amrut/nanoclaw/data/brain-digest.json")
META_DIR = Path("/Users/amrut/nanoclaw/data/brain-wiki/.wiki_meta")
THEMES_DIR = BRAIN / "Inbox" / "themes"
OUT = Path("/Users/amrut/nanoclaw/data/brain-themes.json")
LOG = Path("/Users/amrut/nanoclaw/data/brain-themes.log")

# Opus for theses — this is the highest-leverage stage. Cross-domain synthesis
# is exactly where Opus's deeper multi-hop reasoning and tighter prose pay back.
# 4 calls/day × Opus is still under $1, so quality wins outright.
MODEL = "claude-opus-4-7"
MIN_CLUSTER_SIZE = 3
MAX_CLUSTERS = 4
MAX_ITEMS_PER_CLUSTER = 8


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


def load_json(p: Path) -> dict:
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def collect_signals() -> tuple[list[dict], dict]:
    """Pull every signal that should participate in clustering. Each item gets
    a {kind, title, entities, snippet, ref} record.
    """
    digest = load_json(LATEST_DIGEST)
    research = load_json(RESEARCH_JSON).get("summaries", [])
    deeplinks = load_json(DEEPLINKS_JSON).get("deeplinks", [])

    items: list[dict] = []

    # Research summaries — high signal, deep content.
    for r in research:
        ents = []
        for o in r.get("overlap") or []:
            if o.get("with"):
                ents.append(o["with"])
        for c in r.get("could_replace") or []:
            ents.append(c)
        for k in r.get("key_claims") or []:
            ents.append(k[:50])
        title = r.get("title", "?")
        items.append({
            "kind": "research",
            "title": title,
            "snippet": r.get("what_it_is", ""),
            "url": r.get("url"),
            "shared_at": r.get("shared_at"),
            "entities": list(set(ents)),
            "open_questions": r.get("open_questions") or [],
        })

    # Fresh shared items with overlap (from the digest's earlier pass).
    for f in digest.get("fresh_shared_items") or []:
        items.append({
            "kind": "fresh",
            "title": f.get("title", "?"),
            "snippet": (f.get("notes") or "")[:200],
            "url": f.get("url"),
            "shared_at": f.get("shared_at"),
            "entities": list(set(
                (f.get("shared_entities") or []) + (f.get("entities") or [])
            )),
        })

    # Top relevant Brain notes — context for clusters.
    for n in (digest.get("relevant_notes") or [])[:15]:
        items.append({
            "kind": "brain_note",
            "title": n.get("slug", "?"),
            "snippet": "",
            "url": None,
            "entities": list(set(n.get("shared_entities") or [])),
            "category": n.get("category", "?"),
        })

    # Deeplinks — items reached via 2-hop, distinct value.
    for d in deeplinks:
        chain_ents = []
        for c in d.get("chains", []):
            for h in c.get("hops", []):
                chain_ents.extend([h.get("src"), h.get("dst")])
        items.append({
            "kind": "deeplink",
            "title": d.get("title", "?"),
            "snippet": "",
            "url": d.get("url"),
            "shared_at": d.get("shared_at"),
            "entities": list({e for e in chain_ents if e}),
        })

    return items, {
        "today_entities": digest.get("today_entities", []),
        "date": digest.get("date", datetime.now().strftime("%Y-%m-%d")),
    }


def cluster_by_entities(items: list[dict]) -> list[dict]:
    """Group items that share at least one entity. Greedy single-pass:
    anchor on the most-mentioned entity, merge items touching it, repeat.
    """
    # entity → indexes of items mentioning it
    by_entity: dict[str, list[int]] = defaultdict(list)
    for i, it in enumerate(items):
        for e in it.get("entities") or []:
            by_entity[e].append(i)

    # Filter low-frequency entities (cluster anchor must connect multiple items)
    candidates = [(e, idxs) for e, idxs in by_entity.items() if len(idxs) >= MIN_CLUSTER_SIZE]
    # Anchor on entities mentioned by the most distinct items.
    candidates.sort(key=lambda x: -len(x[1]))

    clusters: list[dict] = []
    used: set[int] = set()
    for entity, idxs in candidates:
        if len(clusters) >= MAX_CLUSTERS:
            break
        members = [i for i in idxs if i not in used]
        if len(members) < MIN_CLUSTER_SIZE:
            continue
        members = members[:MAX_ITEMS_PER_CLUSTER]
        used.update(members)
        clusters.append({
            "anchor_entity": entity,
            "items": [items[i] for i in members],
        })
    return clusters


def call_sonnet(api_key: str, prompt: str) -> dict:
    # Routes through claude CLI (OAuth/plan), NOT raw API. api_key arg ignored.
    return call_claude(
        prompt,
        model=MODEL,
        system_prompt=(
            "You are a strategist who writes tight, specific synthesis paragraphs. "
            "You connect cross-domain signals into one paragraph the reader can "
            "act on. No fluff, no generic phrasing, no hedging. Return STRICT JSON."
        ),
        timeout=300,
    )


def build_theme_prompt(cluster: dict, today_entities: list[str]) -> str:
    item_blocks = []
    for it in cluster["items"]:
        ents = ", ".join((it.get("entities") or [])[:6])
        title = it.get("title", "?")[:120]
        snippet = (it.get("snippet") or "")[:280]
        url = f" [{it['url']}]" if it.get("url") else ""
        item_blocks.append(
            f"- ({it['kind']}) {title}{url}\n  entities: {ents}\n  snippet: {snippet}"
        )

    user_ctx = load_user_context()
    return f"""{user_ctx['context_block']}

You are synthesizing a THEME from items the user has been collecting + active
work topics. Weight everything against the USER LONG-TERM CONTEXT above —
especially Goals & Motivations and Risk Tolerance. A theme that doesn't connect
to a stated goal should be flagged as such, not invented.

Anchor entity: {cluster['anchor_entity']}
Today's active topics: {', '.join(today_entities[:15]) or '(none)'}

Items in this cluster:
{chr(10).join(item_blocks)}

Write a synthesis paragraph (NOT a list) that:
1. Names what's emerging — the actual pattern across these items, not just "they all mention X".
2. Connects (or honestly disconnects) the pattern to the user's stated goals.
3. Says what it implies for the user's CURRENT work specifically (mention named projects).
4. Identifies one concrete next action the user should take this week.

Output schema (strict):
{{
  "title": "<3-7 word theme title>",
  "thesis": "<one paragraph, 80-150 words, specific and grounded>",
  "advances_goals": ["<verbatim goal phrases this advances; empty if it doesn't>"],
  "evidence": ["<2-4 bullets pointing to specific items in the cluster>"],
  "implication": "<one sentence: what changes in the user's work>",
  "next_action": "<one sentence: a specific, executable next step weighted by goal urgency>",
  "open_questions": ["<things the cluster doesn't resolve>", "..."]
}}
NO prose outside JSON. Empty arrays where appropriate. If the theme does NOT
advance any stated goal, set advances_goals to [] and say so plainly in the thesis.
"""


def slugify(s: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.lower())
    return s.strip("-")[:60] or "theme"


def render_theme_note(date: str, cluster: dict, theme: dict) -> str:
    fm = [
        "---",
        f"date: {date}",
        f"anchor_entity: {cluster['anchor_entity']}",
        f"item_count: {len(cluster['items'])}",
        f"generated_by: brain-themes.py",
        f"generated_at: {datetime.now().isoformat(timespec='seconds')}",
        f"model: {MODEL}",
        "---",
    ]
    parts = ["\n".join(fm), ""]
    parts.append(f"# {theme.get('title', cluster['anchor_entity'])}")
    parts.append("")
    parts.append(f"_Anchor: [[{cluster['anchor_entity']}]] · {len(cluster['items'])} items · {date}_")
    parts.append("")
    parts.append("## Thesis")
    parts.append(theme.get("thesis", ""))
    parts.append("")
    advances = theme.get("advances_goals") or []
    if advances:
        parts.append("## Advances stated goals")
        for g in advances:
            parts.append(f"- {g}")
        parts.append("")
    evidence = theme.get("evidence") or []
    if evidence:
        parts.append("## Evidence")
        for e in evidence:
            parts.append(f"- {e}")
        parts.append("")
    impl = theme.get("implication", "")
    if impl:
        parts.append(f"**Implication:** {impl}")
        parts.append("")
    nxt = theme.get("next_action", "")
    if nxt:
        parts.append(f"**Next action (this week):** {nxt}")
        parts.append("")
    open_q = theme.get("open_questions") or []
    if open_q:
        parts.append("## Open questions")
        for q in open_q:
            parts.append(f"- {q}")
        parts.append("")
    parts.append("## Items in cluster")
    for it in cluster["items"]:
        url = f" — [link]({it['url']})" if it.get("url") else ""
        parts.append(f"- _{it['kind']}_ **{it.get('title','?')[:120]}**{url}")
    parts.append("")
    return "\n".join(parts) + "\n"


def main() -> int:
    api_key = load_api_key()
    if not api_key:
        log("FATAL: no ANTHROPIC_API_KEY")
        return 2

    items, ctx = collect_signals()
    log(f"signals: {len(items)} items "
        f"({sum(1 for i in items if i['kind']=='research')} research, "
        f"{sum(1 for i in items if i['kind']=='fresh')} fresh, "
        f"{sum(1 for i in items if i['kind']=='brain_note')} brain notes, "
        f"{sum(1 for i in items if i['kind']=='deeplink')} deeplinks)")

    clusters = cluster_by_entities(items)
    log(f"clusters: {len(clusters)} (size ≥{MIN_CLUSTER_SIZE})")
    if not clusters:
        OUT.write_text(json.dumps({"themes": [], "generated_at": datetime.now().isoformat()}))
        return 0

    THEMES_DIR.mkdir(parents=True, exist_ok=True)
    date = ctx["date"]
    themes_out: list[dict] = []
    for cluster in clusters:
        try:
            prompt = build_theme_prompt(cluster, ctx["today_entities"])
            theme = call_sonnet(api_key, prompt)
        except Exception as e:
            log(f"  theme FAIL {cluster['anchor_entity']}: {e}")
            continue
        slug = slugify(theme.get("title", cluster["anchor_entity"]))
        path = THEMES_DIR / f"{date}-{slug}.md"
        path.write_text(render_theme_note(date, cluster, theme))
        log(f"  wrote {path.name}: {theme.get('title','?')[:70]}")
        themes_out.append({
            "anchor_entity": cluster["anchor_entity"],
            "title": theme.get("title", ""),
            "thesis": theme.get("thesis", ""),
            "advances_goals": theme.get("advances_goals") or [],
            "implication": theme.get("implication", ""),
            "next_action": theme.get("next_action", ""),
            "open_questions": theme.get("open_questions") or [],
            "evidence": theme.get("evidence") or [],
            "item_count": len(cluster["items"]),
            "note_path": str(path),
        })

    OUT.write_text(json.dumps({
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "date": date,
        "themes": themes_out,
    }, indent=2))
    log(f"themes done: {len(themes_out)} written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
