"""Identity loader — reads SOUL/USER/IDENTITY files once and exposes a compact
user-context block that LLM-stage prompts can include verbatim.

The point: every LLM-driven stage in the brain pipeline should weight its output
against what the user has explicitly said matters (Goals & Motivations, Risk
Tolerance, Prime Directive, Core Values), not just against today's entity blob.

This module is deliberately small: load → trim → cache. No LLM calls here.
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

CLAW_GROUP = Path("/Users/amrut/nanoclaw/groups/main")
SOUL = CLAW_GROUP / "SOUL.md"
USER = CLAW_GROUP / "USER.md"
IDENTITY = CLAW_GROUP / "IDENTITY.md"

# Sections we actually want to reach the LLM. Other sections (e.g. "Hardware
# Specs", "Software Stack") are noise for synthesis. Order matters — earlier
# sections weight first in the prompt.
USER_SECTIONS_KEEP = [
    "## Goals & Motivations",
    "## Work & Interests",
    "## Communication Preferences",
    "## Risk Tolerance",
    "## Current Projects",
]
SOUL_SECTIONS_KEEP = [
    "## Prime Directive",
    "## Core Values",
]
IDENTITY_SECTIONS_KEEP = [
    "## What I Do",
    "## How I Work",
]

MAX_CONTEXT_CHARS = 4000


def _read(p: Path) -> str:
    if not p.exists():
        return ""
    try:
        return p.read_text()
    except Exception:
        return ""


def _extract_sections(content: str, headings: list[str]) -> list[tuple[str, str]]:
    """Slice a markdown doc by ## headings; keep only the requested ones."""
    if not content:
        return []
    # Split on lines starting with ## (level-2 heading)
    parts = re.split(r"^(##\s+.*)$", content, flags=re.MULTILINE)
    out: list[tuple[str, str]] = []
    i = 1
    while i < len(parts):
        heading = parts[i].strip()
        body = parts[i + 1] if i + 1 < len(parts) else ""
        for wanted in headings:
            if heading.startswith(wanted):
                out.append((heading, body.strip()))
                break
        i += 2
    return out


def _trim(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rsplit("\n", 1)[0] + "\n…"


_CACHE: dict | None = None


def load_user_context() -> dict:
    """Returns:
        {
          "context_block": "<markdown ready to drop in a prompt>",
          "goal_entities": [<short goal phrases extractable from USER.md>],
          "loaded_from": [<paths>],
        }
    Cached for the lifetime of the process.
    """
    global _CACHE
    if _CACHE is not None:
        return _CACHE

    soul = _extract_sections(_read(SOUL), SOUL_SECTIONS_KEEP)
    user = _extract_sections(_read(USER), USER_SECTIONS_KEEP)
    identity = _extract_sections(_read(IDENTITY), IDENTITY_SECTIONS_KEEP)

    blocks: list[str] = []
    blocks.append("=== USER LONG-TERM CONTEXT (load once, weight everything) ===")
    if soul:
        blocks.append("\n## From SOUL.md (purpose + values)\n")
        for h, body in soul:
            blocks.append(f"{h}\n{body}\n")
    if user:
        blocks.append("\n## From USER.md (goals + preferences)\n")
        for h, body in user:
            blocks.append(f"{h}\n{body}\n")
    if identity:
        blocks.append("\n## From IDENTITY.md (operational style)\n")
        for h, body in identity:
            blocks.append(f"{h}\n{body}\n")

    raw = "\n".join(blocks)
    context_block = _trim(raw, MAX_CONTEXT_CHARS)

    # Pull goal phrases as entities. We look inside USER.md's Goals section and
    # pluck noun-phrase-ish bullet items that mention named projects/products.
    goal_entities: list[str] = []
    for h, body in user:
        if h.startswith("## Goals & Motivations"):
            for line in body.splitlines():
                line = line.strip()
                if not line.startswith("-"):
                    continue
                phrase = line.lstrip("- ").strip()
                phrase = re.sub(r"\s*\([^)]*\)$", "", phrase).strip()
                if 4 <= len(phrase) <= 100:
                    goal_entities.append(phrase[:100])
    # Dedupe preserving order
    seen: set[str] = set()
    unique_goals: list[str] = []
    for g in goal_entities:
        if g.lower() not in seen:
            seen.add(g.lower())
            unique_goals.append(g)

    _CACHE = {
        "context_block": context_block,
        "goal_entities": unique_goals[:20],
        "loaded_from": [str(p) for p in (SOUL, USER, IDENTITY) if p.exists()],
        "loaded_at": datetime.now().isoformat(timespec="seconds"),
    }
    return _CACHE
