#!/usr/bin/env python3
"""Stage 6 — fetch the actual content of fresh shared items and let Haiku
extract structure (what it introduces, key claims, what it could replace).

Cost guards (per the advisor's scope rules):
  - Hard cap: MAX_FETCHES_PER_RUN URL fetches (5).
  - URL cache by sha256(url) at data/research-cache/{hash}.json, TTL 30d.
  - Re-runs hit the cache and never re-call Haiku unless content changed.
  - Skip non-http URLs, files >2MB, image/video MIME types.

For each researched item, write an enriched note to Brain/Inbox/research/{slug}.md
so it lives in the vault and the wiki compiler picks it up next run.

Selection: prefer items that already have entity overlap with today's Claw work
(they're worth deeper attention). If <5 such items, fill the budget with items
that have *no* overlap but came in the last 7 days (broaden the search).
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from services.wiki_compile.domains.brain import (  # noqa: E402
    BRAIN, CLAW_MIRROR, extract_entities,
)
from services.wiki_compile.identity import load_user_context  # noqa: E402
from services.wiki_compile.llm import call_claude, analyze_image  # noqa: E402

DB_PATH = Path("/Users/amrut/nanoclaw/store/messages.db")
CACHE_DIR = Path("/Users/amrut/nanoclaw/data/research-cache")
RESEARCH_DIR = BRAIN / "Inbox" / "research"
LOG = Path("/Users/amrut/nanoclaw/data/brain-research.log")

MAX_FETCHES_PER_RUN = 5
MAX_LINK_FOLLOWS_PER_ITEM = 3      # follow up to N internal links per primary page
LINK_FOLLOW_MIN_TEXT_LEN = 8       # ignore tiny anchor text
CACHE_TTL_DAYS = 30
FETCH_TIMEOUT = 15
MAX_BODY_BYTES = 2_000_000
MAX_TEXT_CHARS_FOR_LLM = 10_000    # primary page
MAX_LINK_TEXT_CHARS = 3_500        # each link-followed page
MODEL = "claude-opus-4-7"  # OAuth/plan quota, backoff handles rate limits
SHARED_DAYS = 7
USER_AGENT = "Mozilla/5.0 (Macintosh) brain-research/1.0"

SCRIPT_RE = re.compile(r"<(script|style|nav|footer|header)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
TAG_RE = re.compile(r"<[^>]+>")
WHITESPACE_RE = re.compile(r"\s+")
PAYWALL_PATTERNS = re.compile(
    r"(subscribe to (read|continue)|sign in to (read|continue)|members only|"
    r"this content is for (members|subscribers)|paywall|create a free account|"
    r"register to (read|view)|already a subscriber|continue reading\b.{0,40}\bsubscribe|"
    r"just a moment\.\.\.|enable javascript and cookies|verify you are human)",
    re.IGNORECASE,
)
MIN_USEFUL_CONTENT_CHARS = 400
LINK_RE = re.compile(
    r'<a\s+(?:[^>]*?\s+)?href=(["\'])([^"\']+)\1[^>]*>(.*?)</a>',
    re.DOTALL | re.IGNORECASE,
)
SKIP_LINK_KEYWORDS = re.compile(
    r"(login|signup|register|cookie|privacy|terms|tos|legal|"
    r"contact|about|sitemap|rss|feed|subscribe|share|tweet|follow|"
    r"facebook|twitter|x\.com/intent|linkedin\.com/share|reddit\.com/submit)",
    re.IGNORECASE,
)
SAME_PATH_KEYWORDS = re.compile(r"^(#|javascript:|mailto:|tel:)", re.IGNORECASE)


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


def url_hash(url: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:16]


def cache_get(url: str) -> dict | None:
    p = CACHE_DIR / f"{url_hash(url)}.json"
    if not p.exists():
        return None
    try:
        c = json.loads(p.read_text())
        ts = datetime.fromisoformat(c["fetched_at"])
        if datetime.now() - ts > timedelta(days=CACHE_TTL_DAYS):
            return None
        return c
    except Exception:
        return None


def cache_put(url: str, payload: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / f"{url_hash(url)}.json").write_text(json.dumps(payload, indent=2))


def extract_internal_links(html_content: str, base_url: str) -> list[tuple[str, str]]:
    """Return list of (resolved_url, anchor_text) for same-domain links worth
    following. Excludes login/cookie/share/social-share boilerplate.
    """
    from urllib.parse import urljoin, urlparse

    base = urlparse(base_url)
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in LINK_RE.finditer(html_content):
        href = m.group(2).strip()
        anchor_html = m.group(3)
        if not href or SAME_PATH_KEYWORDS.match(href):
            continue
        full = urljoin(base_url, href)
        parsed = urlparse(full)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc != base.netloc:
            continue
        clean = full.split("#")[0]
        if clean in seen or clean == base_url:
            continue
        if SKIP_LINK_KEYWORDS.search(clean):
            continue
        anchor = WHITESPACE_RE.sub(" ", TAG_RE.sub(" ", anchor_html)).strip()
        if len(anchor) < LINK_FOLLOW_MIN_TEXT_LEN:
            continue
        if SKIP_LINK_KEYWORDS.search(anchor):
            continue
        seen.add(clean)
        out.append((clean, anchor[:100]))
    # Score: prefer longer anchor text (more meaningful), and links inside a
    # path-segment that overlaps the base URL's path (likely related content).
    base_segs = set([s for s in base.path.strip("/").split("/") if s])

    def score(item: tuple[str, str]) -> int:
        url, txt = item
        u = urlparse(url)
        u_segs = set([s for s in u.path.strip("/").split("/") if s])
        return len(txt) + 5 * len(base_segs & u_segs)

    out.sort(key=score, reverse=True)
    return out[:MAX_LINK_FOLLOWS_PER_ITEM]


def html_to_text(content: str) -> str:
    """Cheap HTML strip — kills <script>/<style>/<nav>, then tags, then dedupes
    whitespace. Good enough for product pages and READMEs; not for SPA dumps.
    """
    content = SCRIPT_RE.sub(" ", content)
    content = TAG_RE.sub(" ", content)
    content = html.unescape(content)
    content = WHITESPACE_RE.sub(" ", content)
    return content.strip()


def follow_share_redirect(url: str) -> str:
    """share.google links redirect — return final URL after one HEAD chase."""
    if "share.google" not in url:
        return url
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
            return r.geturl()
    except Exception:
        return url


def is_paywall_or_blocked(text: str) -> bool:
    """Heuristic: response is too short OR matches paywall/CDN-challenge patterns."""
    if not text or len(text.strip()) < MIN_USEFUL_CONTENT_CHARS:
        return True
    return bool(PAYWALL_PATTERNS.search(text[:3000]))


def fetch_url(url: str, follow_links: bool = False) -> dict | None:
    """Fetch a URL. If follow_links, also fetch up to MAX_LINK_FOLLOWS_PER_ITEM
    same-domain links found in the body, attaching their text under
    `linked_pages: [{url, anchor, text}]` for richer downstream analysis.

    Returns None on hard failure. For paywall/blocked content, returns the dict
    with `blocked: True` so caller can decide to fall back to metadata-only.
    """
    cached = cache_get(url)
    if cached and ("linked_pages" in cached or not follow_links):
        log(f"  cache HIT {url[:80]}")
        return cached
    if not url.startswith(("http://", "https://")):
        return None
    final_url = follow_share_redirect(url)
    try:
        req = urllib.request.Request(final_url, headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        })
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as r:
            ctype = r.headers.get("Content-Type", "")
            if any(bad in ctype.lower() for bad in ("image/", "video/", "audio/", "application/pdf")):
                log(f"  skip non-text content-type {ctype}")
                return None
            raw = r.read(MAX_BODY_BYTES)
        body = raw.decode("utf-8", errors="replace")
        is_html = "html" in ctype.lower()
        text = html_to_text(body) if is_html else body
        text = text[:MAX_TEXT_CHARS_FOR_LLM]
        blocked = is_paywall_or_blocked(text)
        payload: dict = {
            "url": url,
            "final_url": final_url,
            "fetched_at": datetime.now().isoformat(timespec="seconds"),
            "content_type": ctype,
            "text": text,
            "blocked": blocked,
        }
        if follow_links and is_html:
            link_targets = extract_internal_links(body, final_url)
            linked_pages: list[dict] = []
            for link_url, anchor in link_targets:
                # Recurse with follow_links=False so we only go one level deep.
                sub = fetch_url(link_url, follow_links=False)
                if sub:
                    linked_pages.append({
                        "url": sub["final_url"],
                        "anchor": anchor,
                        "text": sub["text"][:MAX_LINK_TEXT_CHARS],
                    })
            payload["linked_pages"] = linked_pages
            log(f"  followed {len(linked_pages)}/{len(link_targets)} internal links")
        cache_put(url, payload)
        log(f"  fetched ({len(text)} chars) {final_url[:80]}")
        return payload
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        log(f"  fetch FAIL {url[:80]}: {e}")
        return None
    except Exception as e:
        log(f"  fetch ERROR {url[:80]}: {e}")
        return None


def call_haiku(api_key: str, prompt: str) -> dict:
    # Function name kept for stability with importers (brain-watch, backlog).
    # Now routes through claude CLI (OAuth/plan quota), NOT the raw API.
    # api_key arg is ignored — kept so existing callers don't break.
    return call_claude(
        prompt,
        model=MODEL,
        system_prompt=(
            "You analyze a single web page and return STRICT JSON describing "
            "what it introduces. No markdown, no prose outside JSON."
        ),
    )


def today_claw_blob() -> str:
    if not CLAW_MIRROR.exists():
        return ""
    cutoff = datetime.now() - timedelta(hours=36)
    chunks: list[str] = []
    files = sorted(CLAW_MIRROR.glob("*.md"))
    target = [p for p in files
              if datetime.fromtimestamp(p.stat().st_mtime) >= cutoff] or files[:2]
    for p in target:
        try:
            text = p.read_text()
        except Exception:
            continue
        chunks.append(re.sub(r"^---\n.*?\n---\n", "", text, count=1, flags=re.DOTALL))
    return "\n".join(chunks)[:6000]


def select_items() -> list[dict]:
    """Pick up to MAX_FETCHES_PER_RUN items: prefer overlap, fill with recent."""
    if not DB_PATH.exists():
        return []
    cutoff = (datetime.now(timezone.utc) - timedelta(days=SHARED_DAYS)).isoformat()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = list(conn.execute(
        "SELECT id, content, url, category, status, created_at, notes, "
        "media_path, media_type, item_type "
        "FROM shared_items WHERE created_at >= ? "
        "AND ((url IS NOT NULL AND url != '') OR (media_path IS NOT NULL AND media_path != '')) "
        "ORDER BY created_at DESC",
        (cutoff,),
    ))
    conn.close()

    today_blob = today_claw_blob()
    today_ents = {e["name"] for e in extract_entities(today_blob)}

    scored: list[tuple[int, dict]] = []
    for r in rows:
        text = " ".join(filter(None, [r["content"], r["notes"], r["url"]]))
        ents = {e["name"] for e in extract_entities(text)}
        overlap = len(ents & today_ents)
        scored.append((overlap, {
            "id": r["id"], "url": r["url"], "category": r["category"],
            "status": r["status"], "shared_at": r["created_at"],
            "title": (r["content"] or r["url"] or r["id"])[:120].strip(),
            "notes": (r["notes"] or "")[:300],
            "entities": sorted(ents)[:10],
            "overlap": overlap,
            "media_path": r["media_path"],
            "media_type": r["media_type"],
            "item_type": r["item_type"],
        }))

    # Already-acted-on items are lower priority; new/triaged win.
    scored.sort(key=lambda x: (
        -x[0],                                          # overlap desc
        0 if x[1]["status"] in ("new", "triaged") else 1,
        x[1]["shared_at"] or "",
    ))
    return [s[1] for s in scored[:MAX_FETCHES_PER_RUN]]


def build_metadata_only_prompt(item: dict, today_blob: str) -> str:
    """Used when fetch failed or returned a paywall/CDN-challenge page. Analyse
    based on the WhatsApp link-preview title (in `content`) + user's triage
    notes + category alone — no page body available.
    """
    user_ctx = load_user_context()
    return f"""{user_ctx['context_block']}

You are analysing a shared link whose target page **could not be fetched**
(paywall, CDN challenge, share.google redirect that requires JS, or expired URL).

You only have:
  - The WhatsApp link-preview title (`{item.get('title','')}`)
  - The user-tagged category: {item.get('category','?')}
  - The user's triage notes (if any)

Do your best from those signals; mark anything that needs verification.
Schema is the same as the full-fetch case, but mark `freshness_signal` clearly
that this was metadata-only.

Schema:
{{
  "what_it_is": "<1-2 sentences inferred from title/category/notes; mark uncertain bits>",
  "category": "<your best classification>",
  "key_claims": ["<infer or empty>"],
  "introduces_entities": ["<proper nouns mentioned in title/notes>"],
  "linked_facts": [],
  "potential_overlap_with_user_work": [
    {{"with": "<entity from today's work>", "why": "<short>"}}
  ],
  "advances_which_goal": [
    {{"goal": "<verbatim goal>", "how": "<short>"}}
  ],
  "what_it_could_replace_or_extend": [],
  "open_questions": ["<things that need resolving — fetch alternative URL? archive.org snapshot?>"],
  "freshness_signal": "METADATA-ONLY analysis — page body unavailable. <one sentence on confidence>"
}}
NO prose outside JSON.

=== USER'S TODAY WORK (excerpt) ===
{today_blob[:3000]}

=== USER'S TRIAGE NOTES ===
{item.get('notes') or '(none)'}

=== ITEM ===
Title: {item.get('title','')}
URL (unreachable): {item.get('url') or '(no URL — image)'}
Category: {item.get('category')}
"""


def build_image_prompt(item: dict, today_blob: str) -> str:
    user_ctx = load_user_context()
    return f"""{user_ctx['context_block']}

The item shared was an image (no URL). Analyse the image content + the user's
triage notes + the WhatsApp message context.

Extract structure as STRICT JSON. Pull any visible text via vision; if it looks
like a screenshot of a tweet/article/code, capture the substance.

Schema:
{{
  "what_it_is": "<1-2 sentences>",
  "category": "<screenshot|photo|diagram|chart|code|whiteboard|other>",
  "text_extracted": "<text visible in the image, verbatim, capped at 800 chars>",
  "key_claims": ["<factual claims visible in the image>"],
  "introduces_entities": ["<proper nouns visible>"],
  "linked_facts": [],
  "potential_overlap_with_user_work": [
    {{"with": "<entity>", "why": "<short>"}}
  ],
  "advances_which_goal": [
    {{"goal": "<verbatim goal>", "how": "<short>"}}
  ],
  "what_it_could_replace_or_extend": [],
  "open_questions": [],
  "freshness_signal": "<one sentence — does the user already know this?>"
}}
NO prose outside JSON.

=== USER'S TODAY WORK (excerpt) ===
{today_blob[:3000]}

=== USER'S TRIAGE NOTES ===
{item.get('notes') or '(none)'}

=== ITEM (image only, no URL) ===
Title from WhatsApp: {item.get('title','')}
Category: {item.get('category')}
"""


def build_prompt(item: dict, page: dict, today_blob: str) -> str:
    primary_text = page.get("text", "")
    linked = page.get("linked_pages") or []
    linked_block = ""
    if linked:
        parts = ["=== LINKED PAGES (sub-context fetched from the primary page) ==="]
        for lp in linked:
            parts.append(f"\n--- {lp['anchor']} ({lp['url']}) ---\n{lp['text']}")
        linked_block = "\n".join(parts)
    user_ctx = load_user_context()
    return f"""{user_ctx['context_block']}

You are reading a primary web page plus 0-N sub-pages it links to.
Extract its structure as STRICT JSON. Use the LINKED PAGES to enrich your
understanding (e.g. "linked_facts" pulls things only visible in sub-pages).

Schema:
{{
  "what_it_is": "<1-2 sentences, precise>",
  "category": "<one of: tool, library, framework, paper, article, product, service, dataset, repo, blog, other>",
  "key_claims": ["<short factual claim>", "..."],
  "introduces_entities": ["<name>", "..."],
  "linked_facts": [                                            // ONLY from sub-pages, not primary
    {{"from": "<sub-page anchor or url>", "fact": "<one sentence>"}}
  ],
  "potential_overlap_with_user_work": [
    {{"with": "<entity/topic from today's work>", "why": "<one sentence, specific>"}}
  ],
  "advances_which_goal": [                                    // grounded in USER LONG-TERM CONTEXT above
    {{"goal": "<verbatim goal phrase from Goals & Motivations>", "how": "<one sentence>"}}
  ],
  "what_it_could_replace_or_extend": ["<existing tool/concept>", "..."],
  "open_questions": ["<thing the page hints at but doesn't resolve>", "..."], // for forward agenda
  "freshness_signal": "<one sentence on whether user already knows this>"
}}
Cap each array at 5. Empty arrays if not applicable. NO prose outside JSON.

=== USER'S TODAY WORK (excerpt) ===
{today_blob[:3000]}

=== USER'S TRIAGE NOTES (if any) ===
{item.get('notes') or '(none)'}

=== PRIMARY PAGE: {item.get('title', '')} ===
URL: {item['url']}
Category (user-tagged): {item.get('category')}
Content:
{primary_text}

{linked_block}
"""


def render_note(item: dict, page: dict, analysis: dict) -> str:
    fm = [
        "---",
        f"id: {item['id']}",
        f"url: {item['url']}",
        f"final_url: {page.get('final_url', item['url'])}",
        f"category: {item.get('category', 'uncategorized')}",
        f"shared_at: {item['shared_at']}",
        f"researched_at: {datetime.now().isoformat(timespec='seconds')}",
        f"researched_by: brain-research.py",
        f"overlap_with_today: {item['overlap']}",
        "---",
    ]
    parts = ["\n".join(fm), ""]
    parts.append(f"# Research: {item.get('title', item['id'])[:120]}")
    parts.append("")
    parts.append(f"**URL:** {page.get('final_url', item['url'])}")
    parts.append("")
    parts.append(f"**What it is:** {analysis.get('what_it_is', '')}")
    parts.append("")
    parts.append(f"**Category:** {analysis.get('category', '?')}")
    parts.append("")
    claims = analysis.get("key_claims") or []
    if claims:
        parts.append("## Key claims")
        for c in claims:
            parts.append(f"- {c}")
        parts.append("")
    linked_facts = analysis.get("linked_facts") or []
    if linked_facts:
        parts.append("## Linked-page facts")
        for lf in linked_facts:
            parts.append(f"- _{lf.get('from','?')}_ — {lf.get('fact','')}")
        parts.append("")
    intros = analysis.get("introduces_entities") or []
    if intros:
        parts.append("## Introduces")
        parts.append(", ".join(f"[[{n}]]" for n in intros))
        parts.append("")
    overlap = analysis.get("potential_overlap_with_user_work") or []
    if overlap:
        parts.append("## Overlap with today's work")
        for o in overlap:
            parts.append(f"- **{o.get('with','?')}** — {o.get('why','')}")
        parts.append("")
    goal_advance = analysis.get("advances_which_goal") or []
    if goal_advance:
        parts.append("## Advances long-term goal")
        for g in goal_advance:
            parts.append(f"- _{g.get('goal','?')}_ — {g.get('how','')}")
        parts.append("")
    rep = analysis.get("what_it_could_replace_or_extend") or []
    if rep:
        parts.append("## Could replace / extend")
        parts.append(", ".join(f"[[{n}]]" for n in rep))
        parts.append("")
    open_q = analysis.get("open_questions") or []
    if open_q:
        parts.append("## Open questions")
        for q in open_q:
            parts.append(f"- {q}")
        parts.append("")
    linked = page.get("linked_pages") or []
    if linked:
        parts.append("## Sub-pages fetched")
        for lp in linked:
            parts.append(f"- [{lp['anchor']}]({lp['url']})")
        parts.append("")
    fresh = analysis.get("freshness_signal")
    if fresh:
        parts.append(f"_Freshness: {fresh}_")
        parts.append("")
    return "\n".join(parts) + "\n"


def main() -> int:
    api_key = load_api_key()
    if not api_key:
        log("FATAL: no ANTHROPIC_API_KEY")
        return 2
    RESEARCH_DIR.mkdir(parents=True, exist_ok=True)

    items = select_items()
    log(f"selected {len(items)} items for research (overlap-then-recent)")
    today_blob = today_claw_blob()

    written = 0
    summaries: list[dict] = []
    for item in items:
        url = item.get("url")
        media_path = item.get("media_path")
        page: dict | None = None
        analysis: dict | None = None
        mode = "url"

        try:
            if url and url.strip():
                page = fetch_url(url, follow_links=True)
                if page and page.get("blocked"):
                    log(f"  blocked/paywall {item['id']}: falling back to metadata-only")
                    mode = "metadata"
                    analysis = call_claude(
                        build_metadata_only_prompt(item, today_blob),
                        model=MODEL,
                    )
                elif page is not None:
                    analysis = call_haiku(api_key, build_prompt(item, page, today_blob))
                    mode = "url"
                else:
                    log(f"  fetch failed {item['id']}: falling back to metadata-only")
                    mode = "metadata"
                    analysis = call_claude(
                        build_metadata_only_prompt(item, today_blob),
                        model=MODEL,
                    )
            elif media_path and Path(media_path).exists():
                log(f"  image: {media_path}")
                mode = "image"
                analysis = analyze_image(
                    media_path, build_image_prompt(item, today_blob), model=MODEL,
                )
            else:
                log(f"  skip {item['id']}: no URL and no readable image at {media_path}")
                continue
        except Exception as e:
            log(f"  analyse FAIL {item['id']} ({mode}): {e}")
            continue

        if not analysis:
            continue

        slug = re.sub(r"[^a-zA-Z0-9_\-]", "", item["id"])
        path = RESEARCH_DIR / f"{slug}.md"
        # render_note expects `page` dict; provide minimal stub for non-URL paths
        page_for_render = page or {"final_url": url or "", "linked_pages": []}
        path.write_text(render_note(item, page_for_render, analysis))
        log(f"  wrote {path.name} [{mode}]: {analysis.get('what_it_is', '?')[:60]}")
        written += 1
        summaries.append({
            "id": item["id"],
            "title": item["title"],
            "url": (page.get("final_url") if page else url) or media_path or "",
            "mode": mode,
            "what_it_is": analysis.get("what_it_is", ""),
            "category": analysis.get("category", item.get("category", "?")),
            "key_claims": (analysis.get("key_claims") or [])[:3],
            "linked_facts": (analysis.get("linked_facts") or [])[:5],
            "overlap": analysis.get("potential_overlap_with_user_work") or [],
            "advances_goal": analysis.get("advances_which_goal") or [],
            "could_replace": analysis.get("what_it_could_replace_or_extend") or [],
            "open_questions": analysis.get("open_questions") or [],
            "freshness": analysis.get("freshness_signal", ""),
            "shared_at": item["shared_at"],
            "linked_pages_count": len(page.get("linked_pages") or []) if page else 0,
            "note_path": str(path),
        })

    out = Path("/Users/amrut/nanoclaw/data/brain-research.json")
    out.write_text(json.dumps({
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "fetched": written,
        "summaries": summaries,
    }, indent=2))
    log(f"research done: {written} pages analysed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
