#!/usr/bin/env python3
"""Stage 7 — daily relevance digest. Queries the Brain LLM Wiki v2 graph,
fresh shared_items, deeplinks (multi-hop graph chains), and URL research,
then writes Brain/Daily/YYYY-MM-DD.md + multi-channel notifications.

Pipeline order:
    shared-items-sync → brain-sync → compile_brain_wiki → brain-deeplink
    → brain-research → brain-digest
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from services.wiki_compile.domains.brain import (  # noqa: E402
    BRAIN, CLAW_MIRROR, extract_entities,
)
from services.wiki_compile.identity import load_user_context  # noqa: E402

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
META_DIR = Path("/Users/amrut/nanoclaw/data/brain-wiki/.wiki_meta")
LATEST = Path("/Users/amrut/nanoclaw/data/brain-digest.json")
LOG = Path("/Users/amrut/nanoclaw/data/brain-digest.log")
DAILY = BRAIN / "Daily"
DB_PATH = Path("/Users/amrut/nanoclaw/store/messages.db")
DEEPLINKS_JSON = Path("/Users/amrut/nanoclaw/data/brain-deeplinks.json")
RESEARCH_JSON = Path("/Users/amrut/nanoclaw/data/brain-research.json")
THEMES_JSON = Path("/Users/amrut/nanoclaw/data/brain-themes.json")

MAX_CLAW_CHARS = 12000
TOP_RELEVANT = 10
SURPRISE_CANDIDATES = 25
SHARED_DAYS = 14
# Sonnet for the surprise pass — finding non-obvious cross-graph connections
# is reasoning, not structure extraction. Haiku underperforms here.
MODEL = "claude-sonnet-4-6"


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().isoformat(timespec="seconds")
    LOG.open("a").write(f"[{ts}] {msg}\n")
    print(f"[{ts}] {msg}", file=sys.stderr)


def _load_optional_json(p: Path) -> dict:
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def load_api_key() -> str | None:
    if k := os.environ.get("ANTHROPIC_API_KEY"):
        return k
    env = Path("/Users/amrut/Lexios/.env")
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def recent_claw_text(hours: int = 36) -> tuple[str, list[str]]:
    cutoff = datetime.now() - timedelta(hours=hours)
    chunks: list[str] = []
    sources: list[str] = []
    if not CLAW_MIRROR.exists():
        return "", []
    files = sorted(CLAW_MIRROR.glob("*.md"))
    recent = [p for p in files if datetime.fromtimestamp(p.stat().st_mtime) >= cutoff]
    target = recent if recent else files[:2]
    for p in target:
        try:
            text = p.read_text()
        except Exception:
            continue
        text = re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.DOTALL)
        chunks.append(f"### {p.name}\n{text}")
        sources.append(p.name)
    return "\n\n".join(chunks)[:MAX_CLAW_CHARS], sources


def load_graph() -> dict:
    if not GRAPH_JSON.exists():
        return {"entities": {}, "relationships": []}
    return json.loads(GRAPH_JSON.read_text())


def load_meta_index() -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not META_DIR.exists():
        return out
    for f in META_DIR.glob("*.json"):
        try:
            m = json.loads(f.read_text())
            out[m["id"]] = m
        except Exception:
            continue
    return out


def fresh_shared_items(today_entities: set[str], days: int = SHARED_DAYS) -> list[dict]:
    if not DB_PATH.exists():
        return []
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = list(conn.execute(
        "SELECT id, content, url, category, status, created_at, notes "
        "FROM shared_items WHERE created_at >= ? ORDER BY created_at DESC",
        (cutoff,),
    ))
    conn.close()
    out: list[dict] = []
    for r in rows:
        text = " ".join(filter(None, [r["content"], r["notes"], r["url"]]))
        ents = canonicalize({e["name"] for e in extract_entities(text)})
        overlap = today_entities & ents
        out.append({
            "id": r["id"],
            "title": (r["content"] or r["url"] or r["id"])[:120].strip(),
            "category": r["category"] or "uncategorized",
            "status": r["status"],
            "url": r["url"],
            "shared_at": r["created_at"],
            "entities": sorted(ents)[:10],
            "shared_entities": sorted(overlap),
            "overlap": len(overlap),
            "notes": (r["notes"] or "")[:280],
        })
    out.sort(key=lambda x: x["shared_at"] or "", reverse=True)
    out.sort(key=lambda x: x["overlap"], reverse=True)
    return out


def find_relevant_notes(today_entities: set[str], meta: dict[str, dict]) -> list[dict]:
    ranked: list[dict] = []
    for slug, m in meta.items():
        note_entities = canonicalize(set(m.get("entities", [])))
        overlap = today_entities & note_entities
        if not overlap:
            continue
        sources = m.get("sources", [])
        if any("_claw-shared" in s or s.startswith("Groups/_claw-shared") for s in sources):
            continue
        ranked.append({
            "slug": slug,
            "category": m.get("category", "general"),
            "shared_entities": sorted(overlap),
            "overlap": len(overlap),
            "confidence": m.get("confidence", 0.0),
            "sources": sources[:2],
        })
    ranked.sort(key=lambda r: (-r["overlap"], -r["confidence"], r["slug"]))
    return ranked


def graph_neighbours(entities: set[str], graph: dict) -> dict[str, list[tuple[str, str]]]:
    rels = graph.get("relationships", [])
    by_source: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for r in rels:
        s, t, rt = r.get("source"), r.get("target"), r.get("type")
        if not (s and t and rt):
            continue
        if s in entities:
            by_source[s].append((t, rt))
        if t in entities:
            by_source[t].append((s, rt))
    return by_source


def call_haiku(api_key: str, prompt: str) -> dict:
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": MODEL,
            "max_tokens": 2500,
            "system": (
                "You are a graph-aware relevance scout. Return ONLY valid JSON. "
                "No prose, no markdown fences."
            ),
            "messages": [{"role": "user", "content": prompt}],
        }).encode(),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.loads(r.read())
    text = resp["content"][0]["text"].strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    return json.loads(text)


def build_surprise_prompt(today_entities: list[str], candidates: list[dict],
                          neighbours: dict[str, list[tuple[str, str]]],
                          fresh: list[dict] | None = None,
                          deeplinks: list[dict] | None = None,
                          research: list[dict] | None = None) -> str:
    fresh = fresh or []
    deeplinks = deeplinks or []
    research = research or []
    cand_lines = []
    for c in candidates[:SURPRISE_CANDIDATES]:
        cand_lines.append(f"- {c['slug']} [{c['category']}] shares: {', '.join(c['shared_entities'][:5])}")
    fresh_lines = []
    for f in fresh[:15]:
        if f["overlap"] == 0:
            continue
        fresh_lines.append(
            f"- [{f['shared_at'][:10]}] {f['title'][:80]} ({f['category']}) shares: {', '.join(f['shared_entities'][:5])}"
        )
    deep_lines = []
    for d in deeplinks[:10]:
        for c in d.get("chains", [])[:2]:
            chain_str = " -> ".join([f"{h['src']}=[{h['verb']}]={h['dst']}" for h in c["hops"]])
            deep_lines.append(f"- {d['title'][:60]}: {chain_str}")
    res_lines = []
    for r in research[:8]:
        res_lines.append(f"- {r.get('title','?')[:80]} — {r.get('what_it_is','')[:140]}")
    neigh_lines = []
    for ent, related in list(neighbours.items())[:20]:
        if not related:
            continue
        rel_str = ", ".join(f"{t}({rt})" for t, rt in related[:5])
        neigh_lines.append(f"- {ent} ↔ {rel_str}")
    user_ctx = load_user_context()
    return f"""{user_ctx['context_block']}

Today's active topics:
{', '.join(today_entities[:30])}

Candidate Brain notes (filtered by entity overlap):
{chr(10).join(cand_lines) or '(none)'}

Recently-shared items with overlap (last {SHARED_DAYS}d):
{chr(10).join(fresh_lines) or '(none)'}

Multi-hop graph chains (deeplinks — items with NO direct overlap but ≤2 hops away):
{chr(10).join(deep_lines) or '(none)'}

Researched pages (LLM-summarised actual URL content):
{chr(10).join(res_lines) or '(none)'}

Graph neighbours of today's entities (1-hop):
{chr(10).join(neigh_lines) or '(none)'}

Find 3-6 SURPRISING / NON-OBVIOUS connections, weighted against the USER
LONG-TERM CONTEXT above. Favour insights that:
  - Advance one of the user's stated goals (Goals & Motivations)
  - Bridge today's work + a fresh share + a goal in one sentence
  - Reveal that a fresh item changes the priority of an existing project

If a connection doesn't tie to anything goal-relevant, skip it. Empty array is
better than filler.

Output schema (strict):
{{
  "surprising_connections": [
    {{"a": "<entity or note>", "b": "<entity or note>",
      "advances_goal": "<verbatim goal phrase or empty>",
      "insight": "<one sentence — why this matters TODAY>"}}
  ]
}}
Cap at 6.
"""


def render_digest(date: str, today_entities: list[str], relevant: list[dict],
                  surprise: list[dict], sources: list[str],
                  fresh: list[dict] | None = None,
                  deeplinks: list[dict] | None = None,
                  research: list[dict] | None = None,
                  themes: list[dict] | None = None,
                  forward_agenda: list[dict] | None = None) -> str:
    fresh = fresh or []
    deeplinks = deeplinks or []
    research = research or []
    themes = themes or []
    forward_agenda = forward_agenda or []
    lines = [
        f"# {date}",
        "",
        "## Cross-Pollination (auto)",
        f"_Generated {datetime.now().isoformat(timespec='seconds')} via brain-digest.py_",
        "",
        f"**Today's entities** (from {', '.join(sources) or 'latest snapshot'}): "
        + (", ".join(f"`{e}`" for e in today_entities[:15]) or "_none detected_"),
        "",
    ]
    if themes:
        lines.append("### 🧵 Themes (Sonnet synthesis across items)")
        for t in themes:
            title = t.get("title", t.get("anchor_entity", "?"))
            anchor = t.get("anchor_entity", "?")
            note_link = ""
            if t.get("note_path"):
                stem = Path(t["note_path"]).stem
                note_link = f" → [[{stem}]]"
            lines.append(f"- **{title}** _(anchor: `{anchor}`, {t.get('item_count',0)} items)_{note_link}")
            thesis = t.get("thesis", "")
            if thesis:
                lines.append(f"  - {thesis}")
            impl = t.get("implication", "")
            if impl:
                lines.append(f"  - **Implication:** {impl}")
            nxt = t.get("next_action", "")
            if nxt:
                lines.append(f"  - **Next action:** {nxt}")
        lines.append("")
    if forward_agenda:
        lines.append("### 🎯 Suggested next research")
        for q in forward_agenda[:6]:
            lines.append(f"- {q}")
        lines.append("")
    fresh_relevant = [f for f in fresh if f["overlap"] > 0]
    if fresh_relevant:
        lines.append(f"### Freshly-shared items relevant to today (last {SHARED_DAYS}d)")
        for f in fresh_relevant[:8]:
            shared = ", ".join(f"`{e}`" for e in f["shared_entities"][:4])
            url = f" — [link]({f['url']})" if f["url"] else ""
            date_str = (f["shared_at"] or "")[:10]
            lines.append(
                f"- {date_str} **{f['title'][:90]}** _({f['category']})_{url}\n"
                f"  - shares: {shared}"
                + (f"\n  - notes: {f['notes'][:200]}" if f["notes"] else "")
            )
        lines.append("")
    if research:
        lines.append("### Research (URL-fetched & analysed)")
        for r in research[:5]:
            url = r.get("url", "")
            url_md = f" — [link]({url})" if url else ""
            lines.append(f"- **{r.get('title','?')[:90]}**{url_md}")
            lines.append(f"  - {r.get('what_it_is','')}")
            overlap = r.get("overlap") or []
            for o in overlap[:2]:
                lines.append(f"  - overlaps **{o.get('with','?')}** — {o.get('why','')}")
            replace = r.get("could_replace") or []
            if replace:
                lines.append(f"  - could replace/extend: {', '.join(replace[:3])}")
        lines.append("")
    if deeplinks:
        lines.append("### Deep links (multi-hop graph chains)")
        for d in deeplinks[:6]:
            url = d.get("url", "")
            url_md = f" — [link]({url})" if url else ""
            lines.append(f"- **{d['title'][:80]}**{url_md}")
            for c in d.get("chains", [])[:2]:
                chain_str = " → ".join(
                    [f"`{h['src']}` -[{h['verb']}]→ `{h['dst']}`" for h in c["hops"]]
                )
                lines.append(f"  - {chain_str}")
        lines.append("")
    if relevant:
        lines.append("### Relevant Brain notes (entity-overlap rank)")
        for r in relevant[:TOP_RELEVANT]:
            shared = ", ".join(f"`{e}`" for e in r["shared_entities"][:4])
            lines.append(
                f"- [[{r['slug']}]] _({r['category']}, conf {r['confidence']:.2f})_ — "
                f"{r['overlap']} shared: {shared}"
            )
        lines.append("")
    if surprise:
        lines.append("### Surprising connections (LLM pass)")
        for s in surprise:
            goal = s.get("advances_goal", "")
            goal_tag = f" — _goal: {goal}_" if goal else ""
            lines.append(
                f"- **{s.get('a','?')}** ↔ **{s.get('b','?')}** — {s.get('insight','')}{goal_tag}"
            )
        lines.append("")
    return "\n".join(lines) + "\n"


def write_daily(date: str, body: str) -> Path:
    DAILY.mkdir(parents=True, exist_ok=True)
    target = DAILY / f"{date}.md"
    marker = "## Cross-Pollination (auto)"
    if target.exists():
        existing = target.read_text()
        if marker in existing:
            head = existing.split(marker, 1)[0].rstrip() + "\n\n"
            new_section = body.split(marker, 1)[1]
            target.write_text(head + marker + new_section)
        else:
            target.write_text(existing.rstrip() + "\n\n" + body[len(f"# {date}\n\n"):])
    else:
        target.write_text(body)
    return target


def notify(relevant: list[dict], surprise: list[dict], fresh: list[dict],
           research: list[dict], deeplinks: list[dict], daily_path: Path) -> None:
    n = len(relevant) + len(surprise)
    if n == 0 and not (fresh or research or deeplinks):
        log("notify: nothing to surface")
        return
    title = (
        f"Brain digest: {len(relevant)} relevant, {len(surprise)} surprising, "
        f"{len(research)} researched, {len(deeplinks)} deeplinks"
    )
    bullets: list[str] = []
    fresh_overlap = [f for f in fresh if f["overlap"] > 0]
    for f in fresh_overlap[:2]:
        bullets.append(f"• {f['title'][:60]}")
    for r in research[:2]:
        bullets.append(f"• research: {r.get('title','?')[:55]}")
    for s in surprise[:2]:
        bullets.append(f"• {s.get('a','?')} ↔ {s.get('b','?')}")
    body = "\n".join(bullets) or "see Daily note"
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{body}" with title "{title}" sound name "Glass"'],
            check=False, timeout=5,
        )
        log(f"macOS notification sent: {title}")
    except Exception as e:
        log(f"macOS notify failed: {e}")
    try:
        ipc_dir = Path("/Users/amrut/nanoclaw/data/ipc/main/messages")
        jid_file = Path("/Users/amrut/nanoclaw/data/main-jid.txt")
        if ipc_dir.exists() and jid_file.exists():
            jid = jid_file.read_text().strip()
            msg_path = ipc_dir / f"brain-digest-{int(datetime.now().timestamp())}.json"
            msg_path.write_text(json.dumps({
                "type": "message",
                "chatJid": jid,
                "text": f"🧠 {title}\n\n" + "\n".join(bullets) + f"\n\n{daily_path}",
            }))
            log(f"WhatsApp IPC dropped → main group: {msg_path.name}")
        else:
            log("WhatsApp skipped (data/ipc/main/messages or main-jid.txt missing)")
    except Exception as e:
        log(f"WhatsApp notify failed: {e}")


def main() -> int:
    if not GRAPH_JSON.exists():
        log(f"FATAL: graph missing — run scripts/compile_brain_wiki.py first ({GRAPH_JSON})")
        return 2

    claw_text, sources = recent_claw_text(hours=36)
    if not claw_text.strip():
        log("no Claw shared content — abort")
        return 1

    raw_ents = {e["name"] for e in extract_entities(claw_text)}
    today_ents = canonicalize(raw_ents)
    log(f"today's entities: {len(today_ents)} (canonicalized from {len(raw_ents)}) — {sorted(today_ents)[:10]}")

    meta = load_meta_index()
    relevant = find_relevant_notes(today_ents, meta)
    log(f"relevant notes by entity overlap: {len(relevant)}")

    graph = load_graph()
    neighbours = graph_neighbours(today_ents, graph)
    log(f"graph neighbours: {sum(len(v) for v in neighbours.values())} edges")

    fresh = fresh_shared_items(today_ents)
    fresh_with_overlap = [f for f in fresh if f["overlap"] > 0]
    log(f"fresh shared items (last {SHARED_DAYS}d): {len(fresh)} total, "
        f"{len(fresh_with_overlap)} with overlap")

    deeplinks_data = _load_optional_json(DEEPLINKS_JSON)
    deeplinks = deeplinks_data.get("deeplinks", [])
    log(f"deeplinks: {len(deeplinks)}")

    research_data = _load_optional_json(RESEARCH_JSON)
    research = research_data.get("summaries", [])
    log(f"research summaries: {len(research)}")

    themes_data = _load_optional_json(THEMES_JSON)
    themes = themes_data.get("themes", [])
    log(f"themes: {len(themes)}")

    # Forward-looking agenda: collect all open_questions across research +
    # themes, dedupe, surface as "Suggested next research".
    seen_q: set[str] = set()
    forward_agenda: list[str] = []
    for r in research:
        for q in (r.get("open_questions") or [])[:3]:
            qk = q.lower()[:80]
            if qk and qk not in seen_q:
                seen_q.add(qk)
                forward_agenda.append(q)
    for t in themes:
        for q in (t.get("open_questions") or [])[:3]:
            qk = q.lower()[:80]
            if qk and qk not in seen_q:
                seen_q.add(qk)
                forward_agenda.append(q)
    log(f"forward agenda: {len(forward_agenda)} questions")

    surprise: list[dict] = []
    api_key = load_api_key()
    if api_key and (relevant or neighbours or fresh_with_overlap or deeplinks or research):
        prompt = build_surprise_prompt(
            sorted(today_ents), relevant, neighbours, fresh, deeplinks, research,
        )
        try:
            resp = call_haiku(api_key, prompt)
            surprise = resp.get("surprising_connections", []) or []
            log(f"surprising connections: {len(surprise)}")
        except Exception as e:
            log(f"Haiku call failed (continuing without surprises): {e}")
    elif not api_key:
        log("no ANTHROPIC_API_KEY — skipping surprise pass")

    date = datetime.now().strftime("%Y-%m-%d")
    body = render_digest(
        date, sorted(today_ents), relevant, surprise, sources,
        fresh, deeplinks, research, themes, forward_agenda,
    )
    daily = write_daily(date, body)
    log(f"daily written: {daily}")

    LATEST.parent.mkdir(parents=True, exist_ok=True)
    LATEST.write_text(json.dumps({
        "date": date,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "daily_path": str(daily),
        "today_entities": sorted(today_ents),
        "relevant_notes": relevant[:TOP_RELEVANT],
        "fresh_shared_items": fresh_with_overlap[:TOP_RELEVANT],
        "deeplinks": deeplinks[:8],
        "research": research[:8],
        "themes": themes,
        "forward_agenda": forward_agenda[:10],
        "surprising_connections": surprise,
    }, indent=2))

    notify(relevant, surprise, fresh, research, deeplinks, daily)
    return 0


if __name__ == "__main__":
    sys.exit(main())
