#!/usr/bin/env python3
"""lexios-takeoff — Deterministic quantity aggregation from extraction data.

Usage: lexios-takeoff <extraction.json> [--floor FLOOR] [--json]
"""
import json, re, sys
from pathlib import Path

def parse_area(value):
    if isinstance(value, (int, float)): return float(value)
    if not isinstance(value, str): return None
    try: return float(value.replace(",", ""))
    except ValueError: pass
    m = re.match(r"([\d,.]+)\s*(?:sq\.?\s*ft|sqft|sf)", value, re.IGNORECASE)
    return float(m.group(1).replace(",", "")) if m else None

def run_takeoff(extraction, floor_filter=None):
    if floor_filter:
        fl = floor_filter.lower().strip()
        extraction = {k: [e for e in v if str(e.get("level", e.get("floor", ""))).lower().strip() == fl]
                      for k, v in extraction.items() if isinstance(v, list)}
    cats = {k: v for k, v in extraction.items() if isinstance(v, list) and v}
    result = {"element_counts": {}, "by_level": {}, "by_type": {}, "areas": {},
              "totals": {"elements": 0, "types": len(cats)}}
    all_elems = []
    for cat, elems in sorted(cats.items()):
        result["element_counts"][cat] = len(elems)
        result["totals"]["elements"] += len(elems)
        all_elems.extend(elems)
    # by level
    for e in all_elems:
        lvl = str(e.get("level", e.get("floor", "unspecified")) or "unspecified").lower().strip()
        result["by_level"][lvl] = result["by_level"].get(lvl, 0) + 1
    # by type for key categories
    for cat, field in [("doors","type"),("windows","type"),("equipment","type")]:
        if cat in cats:
            counts = {}
            for e in cats[cat]:
                t = str(e.get(field, "unspecified") or "unspecified").lower().strip()
                counts[t] = counts.get(t, 0) + 1
            result["by_type"][cat] = counts
    # areas
    rooms = cats.get("rooms", [])
    if rooms:
        by_level, by_func, wa, woa = {}, {}, 0, 0
        for r in rooms:
            a = parse_area(r.get("area_sqft"))
            lvl = str(r.get("level", "unspecified")).lower().strip()
            func = str(r.get("function", "unspecified")).lower().strip()
            if a and a > 0:
                wa += 1; by_level[lvl] = by_level.get(lvl, 0) + a; by_func[func] = by_func.get(func, 0) + a
            else:
                woa += 1
        result["areas"] = {"total_sqft": round(sum(by_level.values()), 1),
                           "by_level": {k: round(v, 1) for k, v in sorted(by_level.items())},
                           "by_function": {k: round(v, 1) for k, v in sorted(by_func.items())},
                           "rooms_with_area": wa, "rooms_without_area": woa}
    return result

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__); sys.exit(1)
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"File not found: {path}", file=sys.stderr); sys.exit(1)
    floor = None
    if "--floor" in sys.argv:
        idx = sys.argv.index("--floor")
        if idx + 1 < len(sys.argv): floor = sys.argv[idx + 1]
    extraction = json.loads(path.read_text())
    result = run_takeoff(extraction, floor)
    path.parent.joinpath("takeoff.json").write_text(json.dumps(result, indent=2))
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        print(f"Takeoff: {result['totals']['types']} types, {result['totals']['elements']} elements")
        for cat, count in sorted(result["element_counts"].items()):
            print(f"  {cat}: {count}")
        if result["areas"]:
            print(f"  Area: {result['areas']['total_sqft']:,.1f} sqft")
