#!/usr/bin/env python3
"""lexios-diff — Compare two extraction JSONs for revision tracking.

Usage: lexios-diff <old.json> <new.json> [--json]
"""
import json, os, sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
_types_cache = None

def _load_types():
    global _types_cache
    if _types_cache is None:
        for p in [Path(os.environ.get("LEXIOS_TYPES", "")), SCRIPT_DIR / "types.json",
                  Path("/home/node/.claude/skills/lexios/types.json")]:
            if p.exists():
                _types_cache = json.loads(p.read_text()).get("types", {}); return _types_cache
        _types_cache = {}
    return _types_cache

def get_match_keys(category):
    types = _load_types()
    if category in types: return types[category].get("match_keys", [["name"]])
    return {"rooms":[["name"]],"doors":[["location"],["tag"],["type"]],"windows":[["tag"],["type"]],
            "dimensions":[["description"],["value"]]}.get(category, [["name"],["tag"],["type"]])

def norm(v): return str(v).strip().lower() if v is not None else ""

def match_element(elem, candidates, keys):
    for kg in keys:
        ev = tuple(norm(elem.get(k)) for k in kg)
        if all(v == "" for v in ev): continue
        for i, c in enumerate(candidates):
            if ev == tuple(norm(c.get(k)) for k in kg): return i
    return None

def diff_category(old_elems, new_elems, keys):
    added, removed, modified = [], [], []
    matched = set()
    for oe in old_elems:
        idx = match_element(oe, new_elems, keys)
        if idx is not None and idx not in matched:
            matched.add(idx)
            changes = {}
            for k in set(oe) | set(new_elems[idx]):
                if k == "page": continue
                if norm(oe.get(k)) != norm(new_elems[idx].get(k)):
                    changes[k] = {"old": oe.get(k), "new": new_elems[idx].get(k)}
            if changes: modified.append({"element": new_elems[idx], "changes": changes})
        else:
            removed.append(oe)
    for i, ne in enumerate(new_elems):
        if i not in matched: added.append(ne)
    return {"added": added, "removed": removed, "modified": modified}

def run_diff(old_ext, new_ext):
    all_cats = {k for k, v in {**old_ext, **new_ext}.items() if isinstance(v, list)}
    result = {"categories": {}, "summary": {"total_added": 0, "total_removed": 0, "total_modified": 0,
              "categories_added": [], "categories_removed": []}}
    for cat in sorted(all_cats):
        oe = old_ext.get(cat, []) if isinstance(old_ext.get(cat), list) else []
        ne = new_ext.get(cat, []) if isinstance(new_ext.get(cat), list) else []
        if not oe and ne: result["summary"]["categories_added"].append(cat)
        elif oe and not ne: result["summary"]["categories_removed"].append(cat)
        d = diff_category(oe, ne, get_match_keys(cat))
        if d["added"] or d["removed"] or d["modified"]:
            result["categories"][cat] = d
            result["summary"]["total_added"] += len(d["added"])
            result["summary"]["total_removed"] += len(d["removed"])
            result["summary"]["total_modified"] += len(d["modified"])
    return result

if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] in ("-h","--help"):
        print(__doc__); sys.exit(1)
    old_p, new_p = Path(sys.argv[1]), Path(sys.argv[2])
    for p in (old_p, new_p):
        if not p.exists(): print(f"Not found: {p}", file=sys.stderr); sys.exit(1)
    result = run_diff(json.loads(old_p.read_text()), json.loads(new_p.read_text()))
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        s = result["summary"]
        print(f"Diff: +{s['total_added']} -{s['total_removed']} ~{s['total_modified']}")
        for cat, d in result["categories"].items():
            print(f"  {cat}: +{len(d['added'])} -{len(d['removed'])} ~{len(d['modified'])}")
