#!/usr/bin/env python3
"""Rename an existing wiki from stem-only article ids to path-based ones.

`services/wiki_compile/lib.slug_for()` now builds the id from the source file's
whole path inside the raw root. Every meta and every compiled article written
under the old scheme therefore sits at the wrong name, and 469 of the 2,726
Brain metas are merges of several source files that were sharing one id. This
script renames them in place, keeping `created`, `version` and `confidence`.

A merged meta is split as far as the articles on disk allow: each compiled
article gets the source whose category matches the folder it is in, and that
source's new slug becomes the article's and the meta's name. Sources with no
article of their own are dropped from `sources` and get their own meta on the
next compile (with `created` = now). Keeping all 78 sources on one meta would
re-inflate `calculate_confidence`, which is half of the original bug.

Usage:
    python3 scripts/migrate_wiki_slugs.py --wiki DIR --dry-run   # plan only
    python3 scripts/migrate_wiki_slugs.py --wiki DIR             # apply

Never point it at a live wiki you have not copied first.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from services.wiki_compile.lib import slug_for  # noqa: E402

try:
    from services.wiki_compile.domains.brain import BRAIN, categorize as brain_categorize
except Exception:  # pragma: no cover - the migration still runs without the domain
    BRAIN = None
    brain_categorize = None


def _category_of(source: str, fallback: str) -> str:
    """Which compiled/<category>/ folder this source's article belongs in."""
    if BRAIN is None or brain_categorize is None:
        return fallback
    try:
        return brain_categorize(BRAIN / source)
    except Exception:
        return fallback


def _unique(base: str, taken: set[str]) -> str:
    name = base
    n = 2
    while name in taken:
        name = f"{base}-{n}"
        n += 1
    taken.add(name)
    return name


def build_plan(wiki: Path) -> dict:
    meta_dir = wiki / ".wiki_meta"
    compiled = wiki / "compiled"

    metas: dict[Path, dict] = {}
    unreadable: list[str] = []
    for p in sorted(meta_dir.rglob("*.json")):
        try:
            metas[p] = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
            unreadable.append(f"{p.name}: {exc}")

    articles: dict[str, list[Path]] = defaultdict(list)
    if compiled.is_dir():
        for a in sorted(compiled.rglob("*.md")):
            if a.name != "index.md":
                articles[a.stem].append(a)

    meta_stems = {p.stem for p in metas}
    # Names nothing may be renamed onto: articles with no meta behind them, and
    # metas we cannot derive a new id for.
    taken = {stem for stem in articles if stem not in meta_stems}
    keep: list[Path] = []
    for p, meta in metas.items():
        if not (meta.get("sources") or []):
            taken.add(p.stem)
            keep.append(p)

    writes: list[tuple[Path, dict]] = []
    renames: list[tuple[Path, Path]] = []
    dropped_sources = 0
    orphan_articles = 0

    for mp in sorted(metas):
        meta = metas[mp]
        sources = list(dict.fromkeys(meta.get("sources") or []))
        if not sources:
            if meta.get("id") != mp.stem:
                writes.append((mp, dict(meta, id=mp.stem)))
            continue
        pool = sorted(sources)
        fallback = meta.get("category", "general")
        pairs: list[tuple[Path | None, str]] = []
        for art in articles.get(mp.stem, []):
            if not pool:
                orphan_articles += 1
                continue
            pick = next((s for s in pool if _category_of(s, fallback) == art.parent.name), pool[0])
            pool.remove(pick)
            pairs.append((art, pick))
        if not pairs:
            pairs.append((None, pool.pop(0)))
        dropped_sources += len(pool)

        for art, source in pairs:
            new = _unique(slug_for(source), taken)
            writes.append((meta_dir / f"{new}.json", dict(
                meta,
                id=new,
                title=Path(source).stem,
                sources=[source],
                category=art.parent.name if art is not None else fallback,
            )))
            if art is not None and art.stem != new:
                renames.append((art, art.with_name(f"{new}.md")))

    write_targets = {w[0] for w in writes}
    removals = [p for p in metas if p not in write_targets and p not in keep]
    # Rerunning the migration should be a no-op, not 2,785 identical writes.
    writes = [(p, m) for p, m in writes if metas.get(p) != m]
    return {
        "writes": writes,
        "renames": renames,
        "removals": removals,
        "unreadable": unreadable,
        "dropped_sources": dropped_sources,
        "orphan_articles": orphan_articles,
        "metas": len(metas),
        "articles": sum(len(v) for v in articles.values()),
    }


def apply_plan(wiki: Path, plan: dict) -> None:
    # Two phases so a new name that is currently some other article's old name
    # cannot be overwritten by whichever rename happens to run first.
    staged: list[tuple[Path, Path, Path]] = []
    for i, (old, new) in enumerate(plan["renames"]):
        tmp = old.with_name(f".migrate-tmp-{i}.md")
        os.replace(old, tmp)
        staged.append((tmp, new, old))
    for tmp, new, old in staged:
        if new.exists():
            print(f"  ! {new.name} already exists, leaving {old.name} where it was")
            os.replace(tmp, old)
            continue
        new.parent.mkdir(parents=True, exist_ok=True)
        os.replace(tmp, new)

    for path, meta in plan["writes"]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(meta, indent=2))
    for path in plan["removals"]:
        path.unlink()

    rename_map = {old.name: new.name for old, new in plan["renames"]}
    index = wiki / "compiled" / "index.md"
    if index.is_file() and rename_map:
        text = index.read_text()
        for old_name, new_name in rename_map.items():
            text = text.replace(f"/{old_name})", f"/{new_name})")
        index.write_text(text)

    state = wiki / ".compile_state.json"
    if state.is_file():
        state.unlink()
        print("  removed .compile_state.json so the next compile rewrites every article")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wiki", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    wiki: Path = args.wiki
    if not (wiki / ".wiki_meta").is_dir():
        print(f"no .wiki_meta under {wiki}, nothing to migrate")
        return 0

    plan = build_plan(wiki)
    for line in plan["unreadable"]:
        print(f"  ! unreadable meta left alone: {line}")
    print(f"  {plan['metas']} metas, {plan['articles']} articles")
    print(f"  {len(plan['renames'])} articles renamed, {len(plan['writes'])} metas written, "
          f"{len(plan['removals'])} old metas removed")
    print(f"  {plan['dropped_sources']} merged sources dropped (they recompile into their own articles), "
          f"{plan['orphan_articles']} articles left in place")
    if args.dry_run:
        print("dry run: nothing written")
        return 0

    apply_plan(wiki, plan)
    print(f"migrated {wiki}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
