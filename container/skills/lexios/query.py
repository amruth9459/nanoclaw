#!/usr/bin/env python3
"""lexios-query — Answer follow-up questions against extraction data.

Usage: lexios-query "<question>" [--work-dir DIR] [--extraction FILE] [--json]
"""
import json, re, sys
from pathlib import Path

# Inline query classifier (avoids import dependency)
SIMPLE_KW = {'where','find','locate','show','list','how many','count','what is','which','what are'}
COMPLEX_KW = {'comply','compliance','code','requirement','calculate','analyze','compare','conflict','difference','between'}
CRITICAL_KW = {'safety','fire','emergency','exit','egress','ada','ibc','nfpa','structural','load','seismic','wind','bearing'}
CATEGORY_KW = {
    "compliance": {'comply','compliance','code','ibc','ada','nfpa','osha','requirement','violation'},
    "quantity": {'how many','count','total','number of','quantity','takeoff'},
    "location": {'where','find','locate','location','floor','room','near'},
    "specification": {'what is','what are','type of','material','spec','size','dimension'},
}

def classify(query):
    ql = query.lower().strip()
    words = ql.split()
    cat = "general"
    for c, kws in CATEGORY_KW.items():
        if any(kw in ql for kw in kws): cat = c; break
    if any(kw in ql for kw in CRITICAL_KW):
        return {"complexity":"critical","route":"llm","category":cat}
    if sum(1 for kw in COMPLEX_KW if kw in ql) >= 2 or len(words) > 20:
        return {"complexity":"complex","route":"llm","category":cat}
    if any(kw in ql for kw in SIMPLE_KW) and len(words) < 10:
        return {"complexity":"simple","route":"cache","category":cat}
    return {"complexity":"moderate","route":"extraction","category":cat}

def _level_filter(ql):
    m = re.search(r"(?:floor|level)\s+(\w+)", ql)
    if m: return m.group(1)
    for w, n in {"first":"1","second":"2","third":"3","1st":"1","2nd":"2","3rd":"3"}.items():
        if w in ql: return n
    return None

def answer(query, extraction):
    cl = classify(query)
    if cl["route"] == "llm":
        cats = {k: len(v) for k, v in extraction.items() if isinstance(v, list) and v}
        return {"answer": None, "needs_llm": True, "classification": cl,
                "context": {"query": query, "available_categories": cats}}
    ql = query.lower()
    cat = cl["category"]

    if cat == "quantity":
        for c, elems in extraction.items():
            if not isinstance(elems, list): continue
            cw = c.replace("_"," ")
            cs = cw.rstrip("s") if cw.endswith("s") else cw
            if cw in ql or cs in ql:
                lf = _level_filter(ql)
                if lf:
                    filtered = [e for e in elems if str(e.get("level",e.get("floor",""))).lower().strip() == lf]
                    return {"answer": f"{len(filtered)} {c} on {lf}", "count": len(filtered),
                            "needs_llm": False, "classification": cl}
                return {"answer": f"{len(elems)} {c} total", "count": len(elems),
                        "needs_llm": False, "classification": cl}
        total = sum(len(v) for v in extraction.values() if isinstance(v, list))
        return {"answer": f"{total} total elements", "count": total, "needs_llm": False, "classification": cl}

    if cat == "location" or cat == "specification":
        for c, elems in extraction.items():
            if not isinstance(elems, list): continue
            for e in elems:
                for f in ("name","tag","type"):
                    v = str(e.get(f,"")).strip().lower()
                    if v and v in ql:
                        return {"answer": json.dumps(e, indent=2), "element": e, "category": c,
                                "needs_llm": False, "classification": cl}

    if "area" in ql or "sqft" in ql or "square" in ql:
        rooms = extraction.get("rooms", [])
        total = sum(r.get("area_sqft", 0) for r in rooms if isinstance(r.get("area_sqft"), (int, float)))
        if total:
            return {"answer": f"Total area: {total:,.0f} sqft", "total_sqft": total,
                    "needs_llm": False, "classification": cl}

    return {"answer": None, "needs_llm": True, "classification": cl,
            "context": {"query": query}}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] in ("-h","--help"):
        print(__doc__); sys.exit(1)
    query = sys.argv[1]
    ext_path = None
    for flag in ("--extraction","--work-dir"):
        if flag in sys.argv:
            idx = sys.argv.index(flag)
            if idx + 1 < len(sys.argv):
                p = Path(sys.argv[idx + 1])
                if flag == "--work-dir": p = p / "extraction.json"
                if p.exists(): ext_path = p; break
    if not ext_path:
        for candidate in [Path("extraction.json"), Path("/workspace/group/lexios-work/extraction.json")]:
            if candidate.exists(): ext_path = candidate; break
    if not ext_path:
        print(json.dumps({"error": "No extraction.json found", "needs_llm": True})); sys.exit(1)
    result = answer(query, json.loads(ext_path.read_text()))
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    elif result.get("needs_llm"):
        print(f"[Needs LLM] {result.get('context', {}).get('query', query)}")
    else:
        print(result.get("answer", "No answer"))
