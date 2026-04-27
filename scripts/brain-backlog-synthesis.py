#!/usr/bin/env python3
"""One-shot historical synthesis — process every URL'd shared_item through the
goal-weighted research pipeline, then run thematic clustering across the entire
corpus (not just the last 14 days like the daily run).

Output: Brain/Inbox/synthesis/{YYYY-MM-DD}-historical-all-shares.md
        + Brain/Inbox/research/{slug}.md per processed item (reuses dir)
        + data/brain-backlog-state.json (resumable)

Resumable: cached fetches survive across runs (research-cache, 30d TTL); each
item's analysis result is checkpointed so re-runs only process items not yet
analysed. Safe to Ctrl-C and re-run.

Cost guard: prints estimated call count before starting.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

# Reuse research helpers (fetch, prompt, render_note, call_haiku → Sonnet)
_brain_research_path = Path(__file__).resolve().parent / "brain-research.py"
_spec = importlib.util.spec_from_file_location("brain_research", _brain_research_path)
brain_research = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(brain_research)

_brain_themes_path = Path(__file__).resolve().parent / "brain-themes.py"
_spec_t = importlib.util.spec_from_file_location("brain_themes", _brain_themes_path)
brain_themes = importlib.util.module_from_spec(_spec_t)
_spec_t.loader.exec_module(brain_themes)

from services.wiki_compile.domains.brain import BRAIN, extract_entities  # noqa: E402

DB_PATH = Path("/Users/amrut/nanoclaw/store/messages.db")
RESEARCH_DIR = BRAIN / "Inbox" / "research"
SYNTHESIS_DIR = BRAIN / "Inbox" / "synthesis"
STATE_PATH = Path("/Users/amrut/nanoclaw/data/brain-backlog-state.json")
LOG = Path("/Users/amrut/nanoclaw/data/brain-backlog-synthesis.log")
ALIASES_JSON = Path("/Users/amrut/nanoclaw/data/brain-aliases.json")

INTER_CALL_DELAY_S = 0.5  # gentle on rate limits
MIN_CLUSTER_SIZE = 4      # bigger anchor for full corpus
MAX_CLUSTERS = 12         # top N themes (Opus)
MAX_ITEMS_PER_CLUSTER = 12


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            pass
    return {"processed": {}, "started_at": datetime.now().isoformat(timespec="seconds")}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2))


def alias_map() -> dict[str, str]:
    if not ALIASES_JSON.exists():
        return {}
    try:
        return json.loads(ALIASES_JSON.read_text()).get("alias_map", {}) or {}
    except Exception:
        return {}


def canonicalize(names: set[str]) -> set[str]:
    m = alias_map()
    return {m.get(n, n) for n in names}


def fetch_all_urld_items() -> list[sqlite3.Row]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = list(conn.execute(
        "SELECT id, item_type, content, url, sender_name, category, status, "
        "created_at, notes FROM shared_items "
        "WHERE url IS NOT NULL AND url != '' "
        "ORDER BY created_at ASC"
    ))
    conn.close()
    return rows


def make_payload(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "url": row["url"],
        "category": row["category"],
        "status": row["status"],
        "shared_at": row["created_at"],
        "title": (row["content"] or row["url"] or row["id"])[:120].strip(),
        "notes": (row["notes"] or "")[:300],
        "entities": [],
        "overlap": 0,
    }


def analyse_one(row: sqlite3.Row, today_blob: str, api_key: str) -> dict | None:
    item = make_payload(row)
    page = brain_research.fetch_url(item["url"], follow_links=True)
    if not page:
        return None
    try:
        prompt = brain_research.build_prompt(item, page, today_blob)
        analysis = brain_research.call_haiku(api_key, prompt)
    except Exception as e:
        log(f"  analyse FAIL {row['id']}: {e}")
        return None

    slug = re.sub(r"[^a-zA-Z0-9_\-]", "", row["id"])
    note_path = RESEARCH_DIR / f"{slug}.md"
    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text(brain_research.render_note(item, page, analysis))

    return {
        "id": row["id"],
        "title": item["title"],
        "url": page.get("final_url", item["url"]),
        "category": row["category"] or "uncategorized",
        "status": row["status"],
        "shared_at": row["created_at"],
        "what_it_is": analysis.get("what_it_is", ""),
        "key_claims": (analysis.get("key_claims") or [])[:3],
        "introduces_entities": (analysis.get("introduces_entities") or [])[:8],
        "overlap_with_user_work": analysis.get("potential_overlap_with_user_work") or [],
        "advances_goal": analysis.get("advances_which_goal") or [],
        "could_replace": analysis.get("what_it_could_replace_or_extend") or [],
        "open_questions": analysis.get("open_questions") or [],
        "freshness": analysis.get("freshness_signal", ""),
        "note_path": str(note_path),
    }


def cluster_summaries(summaries: list[dict]) -> list[dict]:
    """Cluster by anchor entities — same pattern as brain-themes but applied to
    the full corpus."""
    by_entity: dict[str, list[int]] = defaultdict(list)
    for i, s in enumerate(summaries):
        ents = set(s.get("introduces_entities") or [])
        for o in (s.get("overlap_with_user_work") or []):
            if o.get("with"):
                ents.add(o["with"])
        for c in (s.get("could_replace") or []):
            ents.add(c)
        ents = canonicalize(ents)
        for e in ents:
            by_entity[e].append(i)

    candidates = [(e, idxs) for e, idxs in by_entity.items()
                  if len(idxs) >= MIN_CLUSTER_SIZE]
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
        items = []
        for i in members:
            s = summaries[i]
            items.append({
                "kind": "research",
                "title": s["title"],
                "url": s.get("url"),
                "shared_at": s.get("shared_at"),
                "snippet": s["what_it_is"],
                "entities": list(canonicalize(set(s.get("introduces_entities") or []))),
            })
        clusters.append({"anchor_entity": entity, "items": items})
    return clusters


def goal_alignment(summaries: list[dict]) -> dict[str, list[dict]]:
    by_goal: dict[str, list[dict]] = defaultdict(list)
    for s in summaries:
        for g in s.get("advances_goal") or []:
            goal = g.get("goal", "").strip()
            if goal:
                by_goal[goal].append({
                    "title": s["title"],
                    "url": s["url"],
                    "how": g.get("how", ""),
                    "shared_at": s["shared_at"],
                })
    return by_goal


def render_master_note(date: str, stats: dict, clusters_with_themes: list[tuple[dict, dict]],
                       goal_align: dict[str, list[dict]],
                       open_questions: list[str]) -> str:
    lines: list[str] = []
    lines.append("---")
    lines.append(f"date: {date}")
    lines.append("kind: backlog_synthesis")
    lines.append(f"items_processed: {stats['items_processed']}")
    lines.append(f"themes_built: {len(clusters_with_themes)}")
    lines.append(f"generated_at: {datetime.now().isoformat(timespec='seconds')}")
    lines.append("---")
    lines.append("")
    lines.append(f"# Historical Synthesis — All Shared Items ({date})")
    lines.append("")
    lines.append(
        f"Processed **{stats['items_processed']}** URL'd shares from "
        f"{stats['earliest']} to {stats['latest']}. "
        f"{stats['analysed']} analysed, {stats['failed']} failed to fetch, "
        f"{stats['cached']} served from cache."
    )
    lines.append("")
    lines.append("## Top themes")
    lines.append("")
    for cluster, theme in clusters_with_themes:
        title = theme.get("title", cluster["anchor_entity"])
        lines.append(f"### {title}")
        lines.append(f"_Anchor: [[{cluster['anchor_entity']}]] · {len(cluster['items'])} items_")
        lines.append("")
        lines.append(theme.get("thesis", ""))
        lines.append("")
        advances = theme.get("advances_goals") or []
        if advances:
            lines.append("**Advances goals:** " + "; ".join(advances))
            lines.append("")
        nxt = theme.get("next_action", "")
        if nxt:
            lines.append(f"**Next action:** {nxt}")
            lines.append("")
        lines.append("Items:")
        for it in cluster["items"][:10]:
            url = f" — [link]({it['url']})" if it.get("url") else ""
            date_s = (it.get("shared_at") or "")[:10]
            lines.append(f"- {date_s} {it['title'][:100]}{url}")
        lines.append("")
    lines.append("## Goal alignment across the corpus")
    lines.append("")
    if goal_align:
        for goal, items in sorted(goal_align.items(), key=lambda kv: -len(kv[1])):
            lines.append(f"### {goal} ({len(items)} items)")
            for it in items[:5]:
                date_s = (it.get("shared_at") or "")[:10]
                url = f" — [link]({it['url']})" if it.get("url") else ""
                lines.append(f"- {date_s} **{it['title'][:90]}**{url}")
                if it.get("how"):
                    lines.append(f"  - {it['how']}")
            lines.append("")
    else:
        lines.append("_No items were tagged as advancing a stated goal._")
        lines.append("")
    if open_questions:
        lines.append("## Consolidated open questions")
        lines.append("")
        for q in open_questions[:30]:
            lines.append(f"- {q}")
        lines.append("")
    return "\n".join(lines) + "\n"


def main() -> int:
    api_key = brain_research.load_api_key()
    if not api_key:
        log("FATAL: no ANTHROPIC_API_KEY")
        return 2

    SYNTHESIS_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()
    rows = fetch_all_urld_items()
    log(f"backlog: {len(rows)} URL'd shared_items")
    log(f"already processed: {len(state.get('processed', {}))}")

    today_blob = ""
    try:
        from services.wiki_compile.domains.brain import CLAW_MIRROR
        if CLAW_MIRROR.exists():
            chunks = []
            for p in sorted(CLAW_MIRROR.glob("*.md"))[:3]:
                t = p.read_text()
                t = re.sub(r"^---\n.*?\n---\n", "", t, count=1, flags=re.DOTALL)
                chunks.append(t)
            today_blob = "\n".join(chunks)[:6000]
    except Exception:
        pass

    summaries: list[dict] = list(state.get("processed", {}).values())
    cached = sum(1 for s in summaries if s)
    failed = 0
    started = time.time()

    for i, row in enumerate(rows, 1):
        if row["id"] in state.get("processed", {}):
            continue
        log(f"[{i}/{len(rows)}] {row['id']} — {(row['content'] or '')[:60]}")
        result = analyse_one(row, today_blob, api_key)
        if result is None:
            failed += 1
            state.setdefault("processed", {})[row["id"]] = None
        else:
            summaries.append(result)
            state.setdefault("processed", {})[row["id"]] = result
        # Save state every 10 items so a Ctrl-C is safe
        if i % 10 == 0:
            save_state(state)
            elapsed = int(time.time() - started)
            log(f"  checkpoint: {len(summaries)} ok, {failed} failed, elapsed {elapsed}s")
        time.sleep(INTER_CALL_DELAY_S)

    save_state(state)
    summaries = [s for s in summaries if s]
    log(f"analysis done: {len(summaries)} ok, {failed} failed")

    log("clustering across full corpus…")
    clusters = cluster_summaries(summaries)
    log(f"clusters: {len(clusters)}")

    log("generating Opus theses per cluster (this can take a while)…")
    today_entities_list: list[str] = []  # full corpus, not today-specific
    clusters_with_themes: list[tuple[dict, dict]] = []
    for cluster in clusters:
        try:
            prompt = brain_themes.build_theme_prompt(cluster, today_entities_list)
            theme = brain_themes.call_sonnet(api_key, prompt)
        except Exception as e:
            log(f"  theme FAIL {cluster['anchor_entity']}: {e}")
            continue
        clusters_with_themes.append((cluster, theme))
        log(f"  theme: {theme.get('title','?')[:70]}")

    open_questions: list[str] = []
    seen_q: set[str] = set()
    for s in summaries:
        for q in s.get("open_questions", [])[:2]:
            qk = q.lower()[:80]
            if qk and qk not in seen_q:
                seen_q.add(qk)
                open_questions.append(q)
    for _, t in clusters_with_themes:
        for q in (t.get("open_questions") or [])[:3]:
            qk = q.lower()[:80]
            if qk and qk not in seen_q:
                seen_q.add(qk)
                open_questions.append(q)

    goal_align = goal_alignment(summaries)

    earliest = min((s["shared_at"] for s in summaries if s.get("shared_at")), default="?")[:10]
    latest = max((s["shared_at"] for s in summaries if s.get("shared_at")), default="?")[:10]

    stats = {
        "items_processed": len(rows),
        "analysed": len(summaries),
        "failed": failed,
        "cached": cached,
        "earliest": earliest,
        "latest": latest,
    }

    date = datetime.now().strftime("%Y-%m-%d")
    note_path = SYNTHESIS_DIR / f"{date}-historical-all-shares.md"
    note_path.write_text(render_master_note(
        date, stats, clusters_with_themes, goal_align, open_questions,
    ))
    log(f"master synthesis written: {note_path}")
    log(f"goal-aligned items: {sum(len(v) for v in goal_align.values())}")
    log(f"themes: {len(clusters_with_themes)}, open questions: {len(open_questions)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
