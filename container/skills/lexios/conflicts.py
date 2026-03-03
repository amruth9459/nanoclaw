#!/usr/bin/env python3
"""lexios-conflicts — Deterministic cross-reference conflict detection.

Usage: lexios-conflicts <extraction.json> [--json]
"""
import json, re, sys
from pathlib import Path

def run_conflicts(extraction):
    conflicts = []
    # Schedule vs plan mismatch
    for sk, pk, tf, label in [("door_schedule","doors","tag","Door"),("window_schedule","windows","tag","Window")]:
        sched, plan = extraction.get(sk, []), extraction.get(pk, [])
        if not sched and not plan: continue
        st = {str(e.get(tf,"")).strip().upper() for e in sched if e.get(tf)}
        pt = {str(e.get(tf,"")).strip().upper() for e in plan if e.get(tf)}
        for t in st - pt:
            conflicts.append({"type":"schedule_plan_mismatch","severity":"major","element":f"{label} {t}","detail":"In schedule but not on plan"})
        for t in pt - st:
            conflicts.append({"type":"schedule_plan_mismatch","severity":"minor","element":f"{label} {t}","detail":"On plan but not in schedule"})
    # Dimension consistency
    for room in extraction.get("rooms", []):
        dims, area = room.get("dimensions"), room.get("area_sqft")
        if not dims or not area: continue
        parts = re.split(r'\s*[xX×]\s*', dims)
        if len(parts) != 2: continue
        def pf(s):
            s = s.strip()
            m = re.match(r"(\d+)['\u2032]-?\s*(\d+(?:\.\d+)?)?", s)
            if m: return int(m.group(1)) + (float(m.group(2))/12 if m.group(2) else 0)
            try: return float(s.replace("'","").replace('"',"").strip())
            except: return None
        w, h = pf(parts[0]), pf(parts[1])
        if w and h:
            computed = w * h
            try: stated = float(str(area).replace(",",""))
            except: continue
            if stated > 0 and computed > 0 and not (0.7 <= computed/stated <= 1.3):
                conflicts.append({"type":"dimension_inconsistency","severity":"minor",
                    "element":f"Room: {room.get('name','?')}","detail":f"Dims {dims} ≈ {computed:.0f} vs stated {stated:.0f} sqft"})
    # Duplicate tags
    for cat, tf, label in [("doors","tag","Door"),("windows","tag","Window")]:
        tl = {}
        for e in extraction.get(cat, []):
            t = str(e.get(tf,"")).strip()
            if t: tl.setdefault(t, []).append(str(e.get("location", f"page {e.get('page','?')}")))
        for t, locs in tl.items():
            if len(set(locs)) > 1:
                conflicts.append({"type":"duplicate_tag","severity":"minor","element":f"{label} {t}",
                    "detail":f"At {len(locs)} locations: {', '.join(set(locs))}"})
    # Missing data
    for cat, reqs in [("rooms",[("name","major")]),("doors",[("tag","minor")])]:
        for i, e in enumerate(extraction.get(cat, [])):
            for f, s in reqs:
                if not e.get(f):
                    conflicts.append({"type":"missing_data","severity":s,"element":f"{cat}/#{i+1}","detail":f"Missing '{f}'"})
    # Cross-discipline
    if extraction.get("egress_paths"):
        exits = [d for d in extraction.get("doors",[]) if str(d.get("type","")).lower() in ("exit","egress","exterior","entry")]
        if not exits:
            conflicts.append({"type":"cross_discipline_gap","severity":"major","element":"Egress/Doors",
                "detail":"Egress paths defined but no exit doors found"})
    major = sum(1 for c in conflicts if c["severity"] == "major")
    return {"total": len(conflicts), "major": major, "minor": len(conflicts)-major, "conflicts": conflicts}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h","--help"):
        print(__doc__); sys.exit(1)
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"File not found: {path}", file=sys.stderr); sys.exit(1)
    result = run_conflicts(json.loads(path.read_text()))
    path.parent.joinpath("conflicts.json").write_text(json.dumps(result, indent=2))
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        print(f"Conflicts: {result['total']} total ({result['major']} major, {result['minor']} minor)")
        for c in result["conflicts"]:
            print(f"  [{'!!' if c['severity']=='major' else '!'}] {c['element']}: {c['detail']}")
