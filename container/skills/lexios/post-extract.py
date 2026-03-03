#!/usr/bin/env python3
"""lexios-post-extract — Run full post-extraction pipeline (comply+conflicts+takeoff+report).

Usage:
    lexios-post-extract <work-dir> [--jurisdiction ID] [--format whatsapp|json]
                                    [--skip comply,conflicts,takeoff] [--json]

Runs deterministic analysis on extraction.json, producing:
- compliance.json (code compliance check)
- conflicts.json (cross-reference conflicts)
- takeoff.json (quantity aggregation)
- analysis.json (combined envelope)
- Formatted output to stdout
"""

import json
import os
import re
import sqlite3
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

# ── Takeoff ───────────────────────────────────────────────────────────────────

def parse_area(value) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    try:
        return float(value.replace(",", ""))
    except ValueError:
        pass
    m = re.match(r"([\d,.]+)\s*(?:sq\.?\s*ft|sqft|sf)", value, re.IGNORECASE)
    if m:
        return float(m.group(1).replace(",", ""))
    return None


def count_by_level(elements: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for elem in elements:
        level = elem.get("level", elem.get("floor", "unspecified"))
        if level is None:
            level = "unspecified"
        level = str(level).lower().strip()
        counts[level] = counts.get(level, 0) + 1
    return counts


def count_by_type(elements: list[dict], type_field: str = "type") -> dict[str, int]:
    counts: dict[str, int] = {}
    for elem in elements:
        t = str(elem.get(type_field, "unspecified") or "unspecified").lower().strip()
        counts[t] = counts.get(t, 0) + 1
    return counts


def run_takeoff(extraction: dict) -> dict:
    categories = {k: v for k, v in extraction.items() if isinstance(v, list) and v}
    result = {
        "element_counts": {},
        "by_level": {},
        "by_type": {},
        "areas": {},
        "totals": {"elements": 0, "types": len(categories)},
    }
    all_elements = []
    for cat, elements in sorted(categories.items()):
        result["element_counts"][cat] = len(elements)
        result["totals"]["elements"] += len(elements)
        all_elements.extend(elements)

    result["by_level"] = count_by_level(all_elements)

    type_fields = {"doors": "type", "windows": "type", "equipment": "type",
                   "plumbing_fixtures": "type", "lighting_fixtures": "type"}
    for cat, field in type_fields.items():
        if cat in categories:
            result["by_type"][cat] = count_by_type(categories[cat], field)

    rooms = categories.get("rooms", [])
    if rooms:
        by_level: dict[str, float] = {}
        by_function: dict[str, float] = {}
        with_area = without_area = 0
        for room in rooms:
            area = parse_area(room.get("area_sqft"))
            level = str(room.get("level", "unspecified")).lower().strip()
            func = str(room.get("function", "unspecified")).lower().strip()
            if area and area > 0:
                with_area += 1
                by_level[level] = by_level.get(level, 0) + area
                by_function[func] = by_function.get(func, 0) + area
            else:
                without_area += 1
        result["areas"] = {
            "total_sqft": round(sum(by_level.values()), 1),
            "by_level": {k: round(v, 1) for k, v in sorted(by_level.items())},
            "by_function": {k: round(v, 1) for k, v in sorted(by_function.items())},
            "rooms_with_area": with_area,
            "rooms_without_area": without_area,
        }
    return result


# ── Conflicts ─────────────────────────────────────────────────────────────────

def parse_dimension_pair(dim_str: str) -> tuple[float, float] | None:
    if not isinstance(dim_str, str):
        return None
    parts = re.split(r'\s*[xX×]\s*', dim_str)
    if len(parts) != 2:
        return None
    def parse_one(s):
        s = s.strip()
        m = re.match(r"(\d+)['\u2032]-?\s*(\d+(?:\.\d+)?)?[\"″\u2033]?", s)
        if m:
            return int(m.group(1)) + (float(m.group(2)) / 12 if m.group(2) else 0)
        try:
            return float(s.replace("'", "").replace('"', "").strip())
        except ValueError:
            return None
    w, h = parse_one(parts[0]), parse_one(parts[1])
    return (w, h) if w is not None and h is not None else None


def run_conflicts(extraction: dict) -> dict:
    conflicts = []

    # Schedule vs plan mismatch
    for sched_key, plan_key, tag_field, label in [
        ("door_schedule", "doors", "tag", "Door"),
        ("window_schedule", "windows", "tag", "Window"),
    ]:
        schedule = extraction.get(sched_key, [])
        plan = extraction.get(plan_key, [])
        if not schedule and not plan:
            continue
        sched_tags = {str(e.get(tag_field, "")).strip().upper() for e in schedule if e.get(tag_field)}
        plan_tags = {str(e.get(tag_field, "")).strip().upper() for e in plan if e.get(tag_field)}
        for tag in sched_tags - plan_tags:
            conflicts.append({"type": "schedule_plan_mismatch", "severity": "major",
                              "element": f"{label} {tag}", "detail": f"In schedule but not on plan"})
        for tag in plan_tags - sched_tags:
            conflicts.append({"type": "schedule_plan_mismatch", "severity": "minor",
                              "element": f"{label} {tag}", "detail": f"On plan but not in schedule"})

    # Dimension consistency
    for room in extraction.get("rooms", []):
        dims = room.get("dimensions")
        area = room.get("area_sqft")
        if not dims or not area:
            continue
        pair = parse_dimension_pair(dims)
        if not pair:
            continue
        computed = pair[0] * pair[1]
        try:
            stated = float(str(area).replace(",", ""))
        except (ValueError, TypeError):
            continue
        if stated > 0 and computed > 0:
            ratio = computed / stated
            if ratio < 0.7 or ratio > 1.3:
                conflicts.append({"type": "dimension_inconsistency", "severity": "minor",
                                  "element": f"Room: {room.get('name', '?')}",
                                  "detail": f"Dims {dims} ≈ {computed:.0f} sqft vs stated {stated:.0f} sqft"})

    # Duplicate tags
    for cat, tag_field, label in [("doors", "tag", "Door"), ("windows", "tag", "Window")]:
        tag_locs: dict[str, list[str]] = {}
        for e in extraction.get(cat, []):
            tag = str(e.get(tag_field, "")).strip()
            if tag:
                loc = e.get("location", f"page {e.get('page', '?')}")
                tag_locs.setdefault(tag, []).append(str(loc))
        for tag, locs in tag_locs.items():
            if len(set(locs)) > 1:
                conflicts.append({"type": "duplicate_tag", "severity": "minor",
                                  "element": f"{label} {tag}",
                                  "detail": f"At {len(locs)} locations: {', '.join(set(locs))}"})

    # Missing data
    for cat, required in [("rooms", [("name", "major")]), ("doors", [("tag", "minor")])]:
        for i, elem in enumerate(extraction.get(cat, [])):
            for field, sev in required:
                if not elem.get(field):
                    ident = elem.get("name", elem.get("tag", f"#{i+1}"))
                    conflicts.append({"type": "missing_data", "severity": sev,
                                      "element": f"{cat}/{ident}",
                                      "detail": f"Missing '{field}'"})

    # Cross-discipline
    if extraction.get("egress_paths"):
        exit_doors = [d for d in extraction.get("doors", [])
                      if str(d.get("type", "")).lower() in ("exit", "egress", "exterior", "entry")]
        if not exit_doors:
            conflicts.append({"type": "cross_discipline_gap", "severity": "major",
                              "element": "Egress/Doors",
                              "detail": f"Egress paths defined but no exit doors found"})

    major = sum(1 for c in conflicts if c["severity"] == "major")
    return {"total": len(conflicts), "major": major, "minor": len(conflicts) - major,
            "conflicts": conflicts}


# ── Compliance ────────────────────────────────────────────────────────────────

def parse_dimension(value_str: str) -> float | None:
    """Parse dimension string to numeric value in inches."""
    if not value_str:
        return None
    m = re.match(r"(\d+)['\u2032]-?\s*(\d+(?:\.\d+)?)?[\"″\u2033]?", value_str)
    if m:
        return int(m.group(1)) * 12 + (float(m.group(2)) if m.group(2) else 0)
    try:
        return float(value_str)
    except (ValueError, TypeError):
        return None


def run_comply(extraction_path: Path, jurisdiction_id: str) -> dict:
    """Run compliance check. Returns empty dict if codes.db not found."""
    # Look for codes.db in known locations
    codes_db = None
    for candidate in [
        Path(os.environ.get("LEXIOS_CODES_DB", "")),
        SCRIPT_DIR / "codes.db",
        Path("/home/node/.claude/skills/lexios/codes.db"),
        Path.home() / ".lexios" / "codes.db",
    ]:
        if candidate.exists():
            codes_db = candidate
            break

    if not codes_db:
        return {"error": "codes.db not found", "summary": {"pass": 0, "fail": 0, "insufficient_data": 0}}

    extraction = json.loads(extraction_path.read_text())
    db = sqlite3.connect(str(codes_db))

    jur = db.execute("SELECT * FROM jurisdictions WHERE id = ?", (jurisdiction_id,)).fetchone()
    if not jur:
        db.close()
        return {"error": f"Jurisdiction '{jurisdiction_id}' not found",
                "summary": {"pass": 0, "fail": 0, "insufficient_data": 0}}

    rules = db.execute("SELECT * FROM effective_rules WHERE jurisdiction_id = ?",
                       (jurisdiction_id,)).fetchall()

    results = {
        "jurisdiction": {"id": jur[0], "name": jur[1], "state": jur[2],
                         "adopted_code": jur[5], "completeness": jur[10]},
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "total_rules": len(rules),
        "results": [],
        "summary": {"pass": 0, "fail": 0, "insufficient_data": 0},
    }

    for rule in rules:
        check = _check_rule(rule, extraction)
        results["results"].append(check)
        results["summary"][check["status"]] = results["summary"].get(check["status"], 0) + 1

    by_category: dict[str, dict] = {}
    for r in results["results"]:
        cat = r["category"]
        by_category.setdefault(cat, {"pass": 0, "fail": 0, "insufficient_data": 0})
        by_category[cat][r["status"]] = by_category[cat].get(r["status"], 0) + 1
    results["by_category"] = by_category

    db.close()
    return results


def _check_rule(rule, extraction: dict) -> dict:
    result = {"rule_id": rule[0], "code": rule[2], "section": rule[3], "title": rule[4],
              "category": rule[5], "severity": rule[10], "status": "insufficient_data", "details": None}
    ext_types_json, ext_field, check_type = rule[12], rule[13], rule[7]
    threshold, threshold_unit = rule[8], rule[9]
    if not ext_types_json:
        return result
    try:
        ext_types = json.loads(ext_types_json)
    except (json.JSONDecodeError, TypeError):
        return result
    found = []
    for et in ext_types:
        elems = extraction.get(et, [])
        if isinstance(elems, list):
            found.extend(elems)
    if not found:
        result["details"] = f"No {', '.join(ext_types)} data"
        return result
    if check_type == "boolean":
        result["status"] = "pass"
        result["details"] = f"Found {len(found)} element(s)"
        return result
    if threshold is None or not ext_field:
        return result
    violations, passes = [], 0
    for elem in found:
        content = elem.get("content", elem)
        val_str = (content if isinstance(content, dict) else elem).get(ext_field) or elem.get(ext_field)
        if val_str is None:
            continue
        val = parse_dimension(str(val_str))
        if val is None:
            try:
                val = float(val_str)
            except (ValueError, TypeError):
                continue
        if check_type in ("min_dimension", "min_area") and val < threshold:
            violations.append(f"{val_str} < {threshold} {threshold_unit}")
        elif check_type in ("max_dimension", "max_distance", "max_area") and val > threshold:
            violations.append(f"{val_str} > {threshold} {threshold_unit}")
        elif check_type == "min_count" and val < threshold:
            violations.append(f"{val_str} < {threshold}")
        else:
            passes += 1
    if violations:
        result["status"] = "fail"
        result["details"] = "; ".join(violations[:3])
    elif passes > 0:
        result["status"] = "pass"
        result["details"] = f"{passes} element(s) checked"
    else:
        result["details"] = f"No {ext_field} values found"
    return result


# ── Report Formatting ─────────────────────────────────────────────────────────

MAX_WA = 4000

def format_wa(extraction, compliance, conflicts, takeoff) -> list[str]:
    parts = []

    if extraction:
        cats = {k: v for k, v in extraction.items() if isinstance(v, list) and v}
        total = sum(len(v) for v in cats.values())
        lines = [f"*Document Analysis Complete*", "",
                 f"Found *{total} elements* across *{len(cats)} categories*:", ""]
        for cat, elems in sorted(cats.items(), key=lambda x: -len(x[1])):
            lines.append(f"• {cat.replace('_', ' ').title()}: {len(elems)}")
        parts.append("\n".join(lines))

    if compliance and "error" not in compliance:
        s = compliance.get("summary", {})
        jur = compliance.get("jurisdiction", {})
        lines = [f"*Compliance — {jur.get('name', '?')}*",
                 f"Code: {jur.get('adopted_code', '?')}", "",
                 f"• Pass: {s.get('pass', 0)}",
                 f"• Fail: {s.get('fail', 0)}",
                 f"• Insufficient data: {s.get('insufficient_data', 0)}"]
        failures = [r for r in compliance.get("results", []) if r.get("status") == "fail"]
        if failures:
            lines.extend(["", f"*Failures ({len(failures)}):*"])
            for f in failures[:5]:
                lines.append(f"  {f['code']} {f['section']}: {f['title']}")
            if len(failures) > 5:
                lines.append(f"  ... and {len(failures) - 5} more")
        parts.append("\n".join(lines))

    if conflicts and conflicts.get("total", 0) > 0:
        lines = [f"*Conflicts ({conflicts['total']})*",
                 f"Major: {conflicts.get('major', 0)} | Minor: {conflicts.get('minor', 0)}", ""]
        for c in conflicts.get("conflicts", [])[:8]:
            lines.append(f"{'⚠️' if c['severity'] == 'major' else 'ℹ️'} {c['element']}: {c['detail']}")
        parts.append("\n".join(lines))

    if takeoff:
        totals = takeoff.get("totals", {})
        lines = [f"*Quantity Takeoff*",
                 f"Types: {totals.get('types', 0)} | Elements: {totals.get('elements', 0)}", ""]
        for cat, count in sorted(takeoff.get("element_counts", {}).items(), key=lambda x: -x[1])[:10]:
            lines.append(f"• {cat.replace('_', ' ').title()}: {count}")
        areas = takeoff.get("areas", {})
        if areas.get("total_sqft"):
            lines.extend(["", f"*Area: {areas['total_sqft']:,.0f} sqft*"])
        parts.append("\n".join(lines))

    if not parts:
        return ["No analysis results."]

    text = "\n\n".join(parts)
    if len(text) <= MAX_WA:
        return [text]

    # Split
    msgs, current, current_len = [], [], 0
    for line in text.split("\n"):
        ll = len(line) + 1
        if current_len + ll > MAX_WA and current:
            msgs.append("\n".join(current))
            current, current_len = [], 0
        current.append(line)
        current_len += ll
    if current:
        msgs.append("\n".join(current))
    return msgs


# ── Pipeline orchestrator ─────────────────────────────────────────────────────

def run_post_extract(work_dir: Path, jurisdiction_id: str, skip: set[str],
                     output_format: str) -> dict:
    extraction_path = work_dir / "extraction.json"
    if not extraction_path.exists():
        return {"status": "error", "error": f"extraction.json not found in {work_dir}"}

    extraction = json.loads(extraction_path.read_text())
    categories = {k: v for k, v in extraction.items() if isinstance(v, list)}
    extraction_summary = {
        "types": len([v for v in categories.values() if v]),
        "elements": sum(len(v) for v in categories.values()),
    }

    compliance_result = conflicts_result = takeoff_result = None
    futures = {}

    with ThreadPoolExecutor(max_workers=3) as pool:
        if "comply" not in skip:
            futures["comply"] = pool.submit(run_comply, extraction_path, jurisdiction_id)
        if "conflicts" not in skip:
            futures["conflicts"] = pool.submit(run_conflicts, extraction)
        if "takeoff" not in skip:
            futures["takeoff"] = pool.submit(run_takeoff, extraction)

        for key, future in futures.items():
            try:
                r = future.result()
            except Exception as e:
                r = {"error": str(e)}
            if key == "comply":
                compliance_result = r
            elif key == "conflicts":
                conflicts_result = r
            elif key == "takeoff":
                takeoff_result = r

    files = {"extraction": str(extraction_path)}
    for name, data in [("compliance", compliance_result), ("conflicts", conflicts_result),
                       ("takeoff", takeoff_result)]:
        if data and "error" not in data:
            p = work_dir / f"{name}.json"
            p.write_text(json.dumps(data, indent=2))
            files[name] = str(p)

    envelope = {
        "status": "success",
        "analyzed_at": datetime.now(timezone.utc).isoformat(),
        "extraction_summary": extraction_summary,
    }

    if compliance_result:
        if "error" not in compliance_result:
            envelope["compliance"] = compliance_result.get("summary", {})
        else:
            envelope["compliance"] = {"error": compliance_result["error"]}

    if conflicts_result and "error" not in conflicts_result:
        envelope["conflicts"] = {"total": conflicts_result.get("total", 0),
                                 "major": conflicts_result.get("major", 0),
                                 "minor": conflicts_result.get("minor", 0)}

    if takeoff_result and "error" not in takeoff_result:
        envelope["takeoff"] = {**takeoff_result.get("element_counts", {}),
                               "total_sqft": takeoff_result.get("areas", {}).get("total_sqft", 0)}

    messages = format_wa(extraction, compliance_result, conflicts_result, takeoff_result)
    envelope["messages"] = messages
    envelope["files"] = files

    analysis_path = work_dir / "analysis.json"
    analysis_path.write_text(json.dumps(envelope, indent=2))
    files["analysis"] = str(analysis_path)

    return envelope


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 1

    work_dir = Path(sys.argv[1])
    if not work_dir.is_dir():
        print(f"Not a directory: {work_dir}", file=sys.stderr)
        return 1

    jurisdiction_id = "base-ibc-2021"
    if "--jurisdiction" in sys.argv:
        idx = sys.argv.index("--jurisdiction")
        if idx + 1 < len(sys.argv):
            jurisdiction_id = sys.argv[idx + 1]

    output_format = "whatsapp"
    if "--format" in sys.argv:
        idx = sys.argv.index("--format")
        if idx + 1 < len(sys.argv):
            output_format = sys.argv[idx + 1]

    skip = set()
    if "--skip" in sys.argv:
        idx = sys.argv.index("--skip")
        if idx + 1 < len(sys.argv):
            skip = set(sys.argv[idx + 1].split(","))

    use_json = "--json" in sys.argv

    result = run_post_extract(work_dir, jurisdiction_id, skip, output_format)

    if use_json:
        print(json.dumps(result, indent=2))
    else:
        for msg in result.get("messages", []):
            print(msg)
            print()

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
