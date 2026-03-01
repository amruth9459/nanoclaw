#!/usr/bin/env python3
"""
Lexios Evaluation Framework

Waymo-style evaluation for construction document analysis:
- Element-level precision/recall/F1 per category (any of 101 types)
- Failure taxonomy (missed, hallucinated, misidentified, wrong_value)
- Difficulty tiers per document
- Score tracking over time with SKILL.md version hash
- Regression detection across runs
- Corpus management (add, list, stats)

Usage:
  python3 lexios/eval.py score <doc_id>              # Score one document's latest output
  python3 lexios/eval.py score <doc_id> --work-dir /path/to/work  # Custom work dir
  python3 lexios/eval.py regression                  # Run full regression suite
  python3 lexios/eval.py history [doc_id]            # Show score history
  python3 lexios/eval.py corpus                      # Show corpus stats
  python3 lexios/eval.py failures [--category X]     # Show failure patterns
  python3 lexios/eval.py report                      # Full evaluation report
"""

import json
import os
import sys
import re
import hashlib
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Optional

# ── Path Resolution ────────────────────────────────────────────────────────
# Auto-detect context: standalone Lexios (lexios/ directory) vs NanoClaw integration

SCRIPT_DIR = Path(__file__).resolve().parent

if (SCRIPT_DIR / "types.json").exists():
    # In Lexios core (lexios/ directory)
    _TYPES = SCRIPT_DIR / "types.json"
    _CORPUS = SCRIPT_DIR / "corpus"
    _DB = SCRIPT_DIR / "eval.db"
    _WORK = SCRIPT_DIR / "work"
    _SKILL = SCRIPT_DIR.parent / "integrations" / "nanoclaw" / "SKILL.md"
else:
    # In NanoClaw (scripts/ directory) — legacy compat
    _ROOT = SCRIPT_DIR.parent
    _TYPES = _ROOT / "container" / "skills" / "lexios" / "types.json"
    _CORPUS = _ROOT / "scripts" / "lexios-tests" / "corpus"
    _DB = _ROOT / "scripts" / "lexios-tests" / "eval.db"
    _WORK = _ROOT / "groups" / "main" / "lexios-work"
    _SKILL = _ROOT / "container" / "skills" / "lexios" / "SKILL.md"

# Env vars always override
TYPES_PATH = Path(os.environ.get("LEXIOS_TYPES", _TYPES))
CORPUS_DIR = Path(os.environ.get("LEXIOS_CORPUS", _CORPUS))
DB_PATH = Path(os.environ.get("LEXIOS_DB", _DB))
WORK_DIR = Path(os.environ.get("LEXIOS_WORK_DIR", _WORK))
SKILL_PATH = Path(os.environ.get("LEXIOS_SKILL", _SKILL))

# ── Types Registry ─────────────────────────────────────────────────────────

_types_cache: Optional[dict] = None

def load_types() -> dict:
    """Load types.json and return the types dict."""
    global _types_cache
    if _types_cache is None:
        if TYPES_PATH.exists():
            data = json.loads(TYPES_PATH.read_text())
            _types_cache = data.get("types", {})
        else:
            _types_cache = {}
    return _types_cache


def get_match_keys(category: str) -> list[list[str]]:
    """Get match keys for a category from types.json, with fallback defaults."""
    types = load_types()
    if category in types:
        return types[category].get("match_keys", [["name"]])

    # Fallback defaults for categories not in types.json
    DEFAULTS = {
        "rooms":      [["name"]],
        "doors":      [["location"], ["tag"], ["type"]],
        "windows":    [["tag"], ["type"]],
        "dimensions": [["description"], ["value"]],
    }
    return DEFAULTS.get(category, [["name"], ["tag"], ["type"], ["location"]])


def get_domain(category: str) -> str:
    """Get the domain for a category from types.json."""
    types = load_types()
    if category in types:
        return types[category].get("domain", "other")
    return "other"


# ── Database ────────────────────────────────────────────────────────────────

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(DB_PATH))
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS eval_runs (
            id INTEGER PRIMARY KEY,
            doc_id TEXT NOT NULL,
            run_at TEXT NOT NULL,
            skill_hash TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'quick',
            duration_s REAL,

            -- Legacy per-category columns (kept for backward compat)
            rooms_precision REAL, rooms_recall REAL, rooms_f1 REAL,
            doors_precision REAL, doors_recall REAL, doors_f1 REAL,
            windows_precision REAL, windows_recall REAL, windows_f1 REAL,
            dimensions_precision REAL, dimensions_recall REAL, dimensions_f1 REAL,
            notes_recall REAL,
            classification_accuracy REAL,

            -- Aggregate
            overall_f1 REAL,
            total_correct INTEGER DEFAULT 0,
            total_missed INTEGER DEFAULT 0,
            total_hallucinated INTEGER DEFAULT 0,
            total_wrong_value INTEGER DEFAULT 0
        );

        -- Normalized per-category scores (supports all 101 types)
        CREATE TABLE IF NOT EXISTS eval_category_scores (
            id INTEGER PRIMARY KEY,
            run_id INTEGER REFERENCES eval_runs(id),
            category TEXT NOT NULL,
            domain TEXT,
            precision REAL,
            recall REAL,
            f1 REAL,
            correct INTEGER DEFAULT 0,
            missed INTEGER DEFAULT 0,
            hallucinated INTEGER DEFAULT 0,
            wrong_value INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS failures (
            id INTEGER PRIMARY KEY,
            run_id INTEGER REFERENCES eval_runs(id),
            doc_id TEXT NOT NULL,
            category TEXT NOT NULL,
            failure_type TEXT NOT NULL,
            element TEXT NOT NULL,
            expected TEXT,
            actual TEXT,
            notes TEXT
        );

        CREATE TABLE IF NOT EXISTS corpus_docs (
            doc_id TEXT PRIMARY KEY,
            pdf_filename TEXT NOT NULL,
            source_url TEXT,
            doc_type TEXT NOT NULL,
            difficulty TEXT NOT NULL DEFAULT 'medium',
            pages INTEGER,
            description TEXT,
            added_at TEXT NOT NULL,
            gt_verified INTEGER DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_runs_doc ON eval_runs(doc_id);
        CREATE INDEX IF NOT EXISTS idx_runs_time ON eval_runs(run_at);
        CREATE INDEX IF NOT EXISTS idx_failures_cat ON failures(category, failure_type);
        CREATE INDEX IF NOT EXISTS idx_catscores_run ON eval_category_scores(run_id);
    """)
    return db


# ── Ground Truth Schema ─────────────────────────────────────────────────────

GROUND_TRUTH_SCHEMA = {
    "doc_id": "unique identifier (e.g., 'permit-sonoma-bpc022')",
    "pdf": "filename in store/media/",
    "source": "URL where PDF was obtained",
    "doc_type": "residential | commercial | industrial | institutional | mixed",
    "difficulty": "easy | medium | hard",
    "pages": {
        "total": "int",
        "classifications": {"1": "floor_plan | elevation | structural | detail | ..."}
    },
    "elements": {
        "<any_type_name>": [
            "list of element dicts with fields matching types.json fields + page"
        ]
    },
    "compliance_flags": ["list of issues that SHOULD be flagged"],
    "false_positive_patterns": ["list of things that should NOT be flagged as critical"]
}


# ── Scoring Engine ──────────────────────────────────────────────────────────

def fuzzy_match(expected: str, actual: str, threshold: float = 0.6) -> bool:
    """Case-insensitive substring/overlap matching."""
    if not expected or not actual:
        return False
    e = expected.upper().strip()
    a = actual.upper().strip()
    if e in a or a in e:
        return True
    # Word overlap
    e_words = set(e.split())
    a_words = set(a.split())
    if not e_words:
        return False
    overlap = len(e_words & a_words) / len(e_words)
    return overlap >= threshold


def extract_field(elem: dict, keys: list[str]) -> str:
    """Extract a value from an extraction element trying multiple keys.
    Looks in both top-level and nested 'content' dict."""
    content = elem.get("content", elem)
    for key in keys:
        # Try content dict first
        if isinstance(content, dict):
            val = content.get(key)
            if val:
                return str(val)
        # Try top-level
        val = elem.get(key)
        if val:
            return str(val)
    return ""


def multi_field_match(gt_elem: dict, ext_elem: dict,
                      match_keys: list[list[str]]) -> bool:
    """Try matching on multiple key strategies in priority order.

    match_keys is a list of key groups, e.g.:
      [["tag"], ["location"], ["type"]]
    Tries each group in order. If a GT field exists for that key group,
    the extracted element must match it. First successful match wins.
    """
    for keys in match_keys:
        gt_val = ""
        for k in keys:
            gt_val = gt_elem.get(k, "")
            if gt_val:
                break
        if not gt_val:
            continue  # GT doesn't have this field, try next

        ext_val = extract_field(ext_elem, keys)
        if ext_val and fuzzy_match(gt_val, ext_val):
            return True
    return False


def score_elements(gt_elements: list, extracted_elements: list,
                   match_keys: list[list[str]],
                   gt_is_minimum: bool = True) -> dict:
    """
    Score extracted elements against ground truth.

    match_keys: priority-ordered list of key groups for matching.
      e.g. [["name"]] for rooms, [["tag"], ["location"], ["type"]] for doors.
    gt_is_minimum: if True, extra extracted elements are NOT counted as
      hallucinations (GT is a required subset, not a complete enumeration).

    Returns precision, recall, F1, and failure details.
    """
    if not gt_elements:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0,
                "correct": 0, "missed": 0, "hallucinated": 0, "extras": 0,
                "wrong_value": 0, "failures": []}

    matched_gt = set()
    matched_ext = set()
    correct = 0
    wrong_value = 0
    failures = []

    for i, gt_elem in enumerate(gt_elements):
        best_idx = None

        for j, ext_elem in enumerate(extracted_elements):
            if j in matched_ext:
                continue
            if multi_field_match(gt_elem, ext_elem, match_keys):
                best_idx = j
                break

        if best_idx is not None:
            matched_gt.add(i)
            matched_ext.add(best_idx)
            ext_elem = extracted_elements[best_idx]

            # Check value accuracy (dimensions, values)
            gt_dims = gt_elem.get("dimensions", "") or gt_elem.get("value", "")
            ext_content = ext_elem.get("content", {})
            ext_dims = ""
            if isinstance(ext_content, dict):
                ext_dims = ext_content.get("dimensions", "") or ext_content.get("value", "")

            gt_label = gt_elem.get("name", gt_elem.get("description",
                       gt_elem.get("tag", gt_elem.get("type", "?"))))

            if gt_dims and ext_dims and not fuzzy_match(gt_dims, str(ext_dims), 0.5):
                wrong_value += 1
                failures.append({
                    "type": "wrong_value",
                    "element": str(gt_label),
                    "expected": str(gt_dims),
                    "actual": str(ext_dims)
                })
            else:
                correct += 1
        else:
            gt_label = gt_elem.get("name", gt_elem.get("description",
                       gt_elem.get("tag", gt_elem.get("type", "?"))))
            failures.append({
                "type": "missed",
                "element": str(gt_label),
                "expected": str(gt_label),
                "actual": None
            })

    missed = len(gt_elements) - len(matched_gt)
    extras = len(extracted_elements) - len(matched_ext)

    # Hallucination counting depends on GT completeness
    hallucinated = 0 if gt_is_minimum else extras

    if not gt_is_minimum:
        for j, ext_elem in enumerate(extracted_elements):
            if j not in matched_ext:
                ext_label = extract_field(ext_elem, ["name", "tag", "type", "description"])
                failures.append({
                    "type": "hallucinated",
                    "element": ext_label or f"element #{j}",
                    "expected": None,
                    "actual": ext_label
                })

    total_gt = len(gt_elements)
    found = correct + wrong_value
    recall = found / total_gt if total_gt > 0 else 0

    # Precision: if GT is minimum subset, only measure against matched elements
    if gt_is_minimum:
        precision = correct / found if found > 0 else (1.0 if total_gt == 0 else 0)
    else:
        total_extracted = len(extracted_elements)
        precision = found / total_extracted if total_extracted > 0 else 0

    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

    return {
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
        "correct": correct,
        "missed": missed,
        "hallucinated": hallucinated,
        "extras": extras,
        "wrong_value": wrong_value,
        "failures": failures
    }


def score_classification(gt_classifications: dict, extraction: dict) -> float:
    """Score page classification accuracy."""
    return 1.0  # Placeholder — updated when we have classification output


def get_skill_hash() -> str:
    """SHA256 of current SKILL.md for version tracking."""
    if SKILL_PATH.exists():
        return hashlib.sha256(SKILL_PATH.read_bytes()).hexdigest()[:12]
    return "unknown"


# Categories that use recall-only scoring (no precision/F1)
RECALL_ONLY_CATEGORIES = {"key_notes", "notes"}


def score_document(doc_id: str, gt_path: Path, extraction_path: Path,
                   mode: str = "quick") -> dict:
    """Full scoring of one document against ground truth.

    Dynamically scores ALL categories present in ground truth elements,
    loading match strategies from types.json.
    """
    gt = json.loads(gt_path.read_text())
    extraction = json.loads(extraction_path.read_text())

    results = {"doc_id": doc_id, "mode": mode, "categories": {}}
    all_failures = []
    total_correct = total_missed = total_hallucinated = total_wrong_value = 0

    elements = gt.get("elements", {})
    gt_is_min = gt.get("gt_is_minimum", True)

    for category, gt_items in elements.items():
        if not isinstance(gt_items, list) or not gt_items:
            continue

        # Recall-only categories (key_notes, notes)
        if category in RECALL_ONLY_CATEGORIES:
            notes_text = json.dumps(extraction.get(category, extraction.get("notes", []))).lower()
            found = sum(1 for n in gt_items
                        if any(w in notes_text for w in n.get("text", "").lower().split()[:3]))
            total = len(gt_items)
            results["categories"][category] = {
                "recall": round(found / total, 3) if total > 0 else 1.0,
                "found": found, "total": total,
                "domain": get_domain(category)
            }
            continue

        # Standard element scoring — get match keys from types.json
        keys = get_match_keys(category)
        extracted = extraction.get(category, [])
        if not isinstance(extracted, list):
            extracted = []

        r = score_elements(gt_items, extracted, match_keys=keys, gt_is_minimum=gt_is_min)
        r["domain"] = get_domain(category)
        results["categories"][category] = r
        all_failures.extend([{**f, "category": category} for f in r["failures"]])
        total_correct += r["correct"]
        total_missed += r["missed"]
        total_hallucinated += r["hallucinated"]
        total_wrong_value += r["wrong_value"]

    # Overall F1
    f1_scores = [v["f1"] for v in results["categories"].values() if "f1" in v]
    results["overall_f1"] = round(sum(f1_scores) / len(f1_scores), 3) if f1_scores else 0

    results["totals"] = {
        "correct": total_correct,
        "missed": total_missed,
        "hallucinated": total_hallucinated,
        "wrong_value": total_wrong_value
    }
    results["failures"] = all_failures
    results["skill_hash"] = get_skill_hash()

    return results


# ── Database Operations ─────────────────────────────────────────────────────

def save_run(db: sqlite3.Connection, results: dict, duration_s: float = 0):
    """Save evaluation run to database (both legacy and normalized tables)."""
    cats = results["categories"]
    totals = results["totals"]

    # Write to eval_runs (legacy columns for backward compat)
    run_id = db.execute("""
        INSERT INTO eval_runs (
            doc_id, run_at, skill_hash, mode, duration_s,
            rooms_precision, rooms_recall, rooms_f1,
            doors_precision, doors_recall, doors_f1,
            windows_precision, windows_recall, windows_f1,
            dimensions_precision, dimensions_recall, dimensions_f1,
            notes_recall, classification_accuracy,
            overall_f1, total_correct, total_missed,
            total_hallucinated, total_wrong_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        results["doc_id"], datetime.utcnow().isoformat(), results["skill_hash"],
        results["mode"], duration_s,
        cats.get("rooms", {}).get("precision"), cats.get("rooms", {}).get("recall"),
        cats.get("rooms", {}).get("f1"),
        cats.get("doors", {}).get("precision"), cats.get("doors", {}).get("recall"),
        cats.get("doors", {}).get("f1"),
        cats.get("windows", {}).get("precision"), cats.get("windows", {}).get("recall"),
        cats.get("windows", {}).get("f1"),
        cats.get("dimensions", {}).get("precision"), cats.get("dimensions", {}).get("recall"),
        cats.get("dimensions", {}).get("f1"),
        cats.get("notes", {}).get("recall") or cats.get("key_notes", {}).get("recall"),
        None,
        results["overall_f1"], totals["correct"], totals["missed"],
        totals["hallucinated"], totals["wrong_value"]
    )).lastrowid

    # Write to normalized eval_category_scores (all categories)
    for category, scores in cats.items():
        db.execute("""
            INSERT INTO eval_category_scores
                (run_id, category, domain, precision, recall, f1,
                 correct, missed, hallucinated, wrong_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            run_id, category, scores.get("domain"),
            scores.get("precision"), scores.get("recall"), scores.get("f1"),
            scores.get("correct", 0), scores.get("missed", 0),
            scores.get("hallucinated", 0), scores.get("wrong_value", 0)
        ))

    for f in results.get("failures", []):
        db.execute("""
            INSERT INTO failures (run_id, doc_id, category, failure_type,
                                  element, expected, actual, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (run_id, results["doc_id"], f.get("category", "unknown"),
              f["type"], f["element"], f.get("expected"), f.get("actual"), None))

    db.commit()
    return run_id


# ── Commands ────────────────────────────────────────────────────────────────

def cmd_score(doc_id: str, work_dir: Optional[Path] = None):
    """Score a specific document's latest extraction output."""
    work = work_dir or WORK_DIR

    # Find ground truth
    gt_files = list(CORPUS_DIR.glob(f"{doc_id}/*.ground-truth.json"))
    if not gt_files:
        gt_files = list(CORPUS_DIR.glob(f"*{doc_id}*.ground-truth.json"))
    if not gt_files:
        print(f"No ground truth found for '{doc_id}'")
        print(f"Expected: {CORPUS_DIR}/{doc_id}/<name>.ground-truth.json")
        return 1

    gt_path = gt_files[0]
    ext_path = work / "extraction.json"
    if not ext_path.exists():
        print(f"No extraction.json found at {ext_path}. Run Lexios first.")
        return 1

    results = score_document(doc_id, gt_path, ext_path)
    db = init_db()
    run_id = save_run(db, results)

    # Print results
    print(f"\n{'='*60}")
    print(f"  Lexios Evaluation — {doc_id}")
    print(f"  SKILL.md: {results['skill_hash']}")
    print(f"{'='*60}\n")

    # Group categories by domain for display
    by_domain: dict[str, list[tuple[str, dict]]] = {}
    for cat, scores in results["categories"].items():
        domain = scores.get("domain", "other")
        by_domain.setdefault(domain, []).append((cat, scores))

    DOMAIN_LABELS = {
        "architectural": "Architectural",
        "structural": "Structural",
        "mep": "MEP",
        "schedule_admin": "Schedule/Admin",
        "site_civil": "Site/Civil",
        "other": "Other",
    }

    for domain in ["architectural", "structural", "mep", "schedule_admin", "site_civil", "other"]:
        items = by_domain.get(domain, [])
        if not items:
            continue
        print(f"  {DOMAIN_LABELS.get(domain, domain)}:")
        for cat, scores in items:
            if "f1" in scores:
                bar = "█" * int(scores["f1"] * 20) + "░" * (20 - int(scores["f1"] * 20))
                print(f"    {cat:20s}  {bar}  P={scores['precision']:.2f}  R={scores['recall']:.2f}  F1={scores['f1']:.2f}")
            elif "recall" in scores:
                bar = "█" * int(scores["recall"] * 20) + "░" * (20 - int(scores["recall"] * 20))
                print(f"    {cat:20s}  {bar}  R={scores['recall']:.2f}  ({scores.get('found',0)}/{scores.get('total',0)})")
        print()

    t = results["totals"]
    print(f"  Overall F1:  {results['overall_f1']:.3f}")
    print(f"  Correct: {t['correct']}  Missed: {t['missed']}  "
          f"Hallucinated: {t['hallucinated']}  Wrong value: {t['wrong_value']}")

    if results["failures"]:
        print(f"\n  Failures ({len(results['failures'])}):")
        for f in results["failures"][:10]:
            icon = {"missed": "⊘", "hallucinated": "⊕", "wrong_value": "≠"}.get(f["type"], "?")
            print(f"    {icon} [{f.get('category','?')}] {f['type']}: {f['element']}")
            if f.get("expected") and f.get("actual"):
                print(f"      expected: {f['expected']}")
                print(f"      actual:   {f['actual']}")

    print(f"\n  Saved as run #{run_id}")
    return 0


def cmd_history(doc_id: Optional[str] = None):
    """Show score history."""
    db = init_db()
    if doc_id:
        rows = db.execute(
            "SELECT run_at, skill_hash, overall_f1, total_correct, total_missed, "
            "total_hallucinated, total_wrong_value FROM eval_runs "
            "WHERE doc_id = ? ORDER BY run_at DESC LIMIT 20", (doc_id,)
        ).fetchall()
        print(f"\nHistory for {doc_id}:")
    else:
        rows = db.execute(
            "SELECT run_at, doc_id, skill_hash, overall_f1, total_correct, total_missed, "
            "total_hallucinated, total_wrong_value FROM eval_runs "
            "ORDER BY run_at DESC LIMIT 30"
        ).fetchall()
        print("\nAll recent runs:")

    if not rows:
        print("  No runs recorded yet.")
        return

    print(f"  {'Date':20s} {'Doc':25s} {'Skill':8s} {'F1':6s} {'✓':4s} {'⊘':4s} {'⊕':4s} {'≠':4s}")
    print(f"  {'-'*75}")
    for row in rows:
        if doc_id:
            date, skill, f1, c, m, h, w = row
            doc = doc_id
        else:
            date, doc, skill, f1, c, m, h, w = row
        f1_str = f"{f1:.3f}" if f1 is not None else "N/A"
        print(f"  {date[:19]:20s} {doc[:25]:25s} {skill[:8]:8s} {f1_str:6s} {c or 0:4d} {m or 0:4d} {h or 0:4d} {w or 0:4d}")


def cmd_corpus():
    """Show corpus statistics."""
    docs = []
    for d in sorted(CORPUS_DIR.iterdir()) if CORPUS_DIR.exists() else []:
        if not d.is_dir():
            continue
        gt_files = list(d.glob("*.ground-truth.json"))
        pdf_files = list(d.glob("*.pdf"))
        if gt_files:
            gt = json.loads(gt_files[0].read_text())
            elems = gt.get("elements", {})
            categories = [k for k, v in elems.items() if isinstance(v, list) and v]
            docs.append({
                "id": d.name,
                "type": gt.get("doc_type", "unknown"),
                "difficulty": gt.get("difficulty", "medium"),
                "pages": gt.get("pages", {}).get("total", "?"),
                "has_pdf": len(pdf_files) > 0,
                "elements": sum(len(v) for v in elems.values() if isinstance(v, list)),
                "categories": categories,
            })

    print(f"\nLexios Test Corpus: {len(docs)} documents\n")
    if not docs:
        print(f"  No documents yet. Add ground truths to {CORPUS_DIR}/")
        return

    types = {}
    for d in docs:
        types.setdefault(d["type"], []).append(d)

    print(f"  {'ID':30s} {'Type':15s} {'Diff':8s} {'Pages':6s} {'Elems':6s} {'Categories':30s}")
    print(f"  {'-'*100}")
    for d in docs:
        cats_str = ", ".join(d["categories"][:5])
        if len(d["categories"]) > 5:
            cats_str += f" +{len(d['categories'])-5}"
        print(f"  {d['id'][:30]:30s} {d['type'][:15]:15s} {d['difficulty']:8s} "
              f"{str(d['pages']):6s} {d['elements']:6d} {cats_str}")

    print(f"\n  By type: {', '.join(f'{t}: {len(v)}' for t, v in types.items())}")

    # All categories across corpus
    all_cats = set()
    for d in docs:
        all_cats.update(d["categories"])
    print(f"  Categories in corpus: {', '.join(sorted(all_cats))}")

    # Coverage gaps
    target_types = ["residential", "commercial", "industrial", "institutional"]
    target_diffs = ["easy", "medium", "hard"]
    missing_types = [t for t in target_types if t not in types]
    if missing_types:
        print(f"  Missing doc types: {', '.join(missing_types)}")

    diffs = {d["difficulty"] for d in docs}
    missing_diffs = [d for d in target_diffs if d not in diffs]
    if missing_diffs:
        print(f"  Missing difficulties: {', '.join(missing_diffs)}")


def cmd_failures(category: Optional[str] = None):
    """Show failure patterns across all runs."""
    db = init_db()

    if category:
        rows = db.execute(
            "SELECT failure_type, element, COUNT(*) as cnt "
            "FROM failures WHERE category = ? "
            "GROUP BY failure_type, element ORDER BY cnt DESC LIMIT 30",
            (category,)
        ).fetchall()
        print(f"\nTop failures in '{category}':")
    else:
        rows = db.execute(
            "SELECT category, failure_type, COUNT(*) as cnt "
            "FROM failures GROUP BY category, failure_type "
            "ORDER BY cnt DESC LIMIT 30"
        ).fetchall()
        print("\nFailure taxonomy:")

    if not rows:
        print("  No failures recorded yet.")
        return

    if category:
        for ftype, element, cnt in rows:
            icon = {"missed": "⊘", "hallucinated": "⊕", "wrong_value": "≠"}.get(ftype, "?")
            print(f"  {icon} {ftype:15s} {element[:40]:40s} x{cnt}")
    else:
        print(f"  {'Category':20s} {'Type':15s} {'Count':6s}")
        print(f"  {'-'*45}")
        for cat, ftype, cnt in rows:
            print(f"  {cat:20s} {ftype:15s} {cnt:6d}")

    # Regression detection
    print("\n  Regression check:")
    docs = db.execute(
        "SELECT DISTINCT doc_id FROM eval_runs ORDER BY doc_id"
    ).fetchall()
    regressions = []
    for (doc_id_val,) in docs:
        runs = db.execute(
            "SELECT overall_f1, skill_hash, run_at FROM eval_runs "
            "WHERE doc_id = ? ORDER BY run_at DESC LIMIT 2", (doc_id_val,)
        ).fetchall()
        if len(runs) == 2 and runs[0][0] is not None and runs[1][0] is not None:
            delta = runs[0][0] - runs[1][0]
            if delta < -0.05:
                regressions.append((doc_id_val, runs[1][0], runs[0][0], delta))

    if regressions:
        for doc_id_val, old_f1, new_f1, delta in regressions:
            print(f"  ! {doc_id_val}: F1 {old_f1:.3f} -> {new_f1:.3f} ({delta:+.3f})")
    else:
        print("  No regressions detected")


def cmd_report():
    """Full evaluation report using normalized category scores."""
    db = init_db()

    # Latest run per document
    latest_runs = db.execute("""
        SELECT e.id, e.doc_id, e.overall_f1, e.total_correct, e.total_missed,
               e.total_hallucinated, e.total_wrong_value, e.skill_hash, e.run_at
        FROM eval_runs e
        INNER JOIN (
            SELECT doc_id, MAX(run_at) as max_run
            FROM eval_runs GROUP BY doc_id
        ) latest ON e.doc_id = latest.doc_id AND e.run_at = latest.max_run
        ORDER BY e.doc_id
    """).fetchall()

    if not latest_runs:
        print("No evaluation data. Run: python3 lexios/eval.py score <doc_id>")
        return

    print(f"\n{'='*70}")
    print(f"  LEXIOS EVALUATION REPORT — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"  SKILL.md: {get_skill_hash()}")
    print(f"{'='*70}\n")

    # Collect all scored categories across all latest runs
    run_ids = [r[0] for r in latest_runs]
    placeholders = ",".join("?" * len(run_ids))

    cat_scores = db.execute(f"""
        SELECT cs.run_id, cs.category, cs.domain, cs.precision, cs.recall, cs.f1
        FROM eval_category_scores cs
        WHERE cs.run_id IN ({placeholders})
        ORDER BY cs.category
    """, run_ids).fetchall()

    # Build a mapping: run_id -> {category -> scores}
    run_cats: dict[int, dict[str, dict]] = {}
    all_categories = set()
    for run_id, cat, domain, prec, rec, f1 in cat_scores:
        run_cats.setdefault(run_id, {})[cat] = {
            "domain": domain, "precision": prec, "recall": rec, "f1": f1
        }
        all_categories.add(cat)

    # If no normalized scores exist, fall back to legacy columns
    if not cat_scores:
        all_categories = {"rooms", "doors", "windows", "dimensions"}
        for row in latest_runs:
            run_id = row[0]
            # Query legacy columns
            legacy = db.execute(
                "SELECT rooms_f1, doors_f1, windows_f1, dimensions_f1 FROM eval_runs WHERE id = ?",
                (run_id,)
            ).fetchone()
            if legacy:
                run_cats[run_id] = {}
                for i, cat in enumerate(["rooms", "doors", "windows", "dimensions"]):
                    if legacy[i] is not None:
                        run_cats[run_id][cat] = {"f1": legacy[i], "domain": "architectural"}

    # Determine display columns: pick top categories by frequency
    cat_freq = {}
    for rc in run_cats.values():
        for cat in rc:
            cat_freq[cat] = cat_freq.get(cat, 0) + 1
    display_cats = sorted(cat_freq.keys(), key=lambda c: (-cat_freq[c], c))[:8]

    # Header
    cat_headers = [c[:7] for c in display_cats]
    header = f"  {'Document':25s} {'Overall':8s} " + " ".join(f"{h:7s}" for h in cat_headers)
    print(header)
    print(f"  {'-'*(25 + 8 + 1 + 8 * len(display_cats))}")

    def fmt(v):
        return f"{v:.2f}" if v is not None else "  - "

    f1_scores = []
    for row in latest_runs:
        run_id, doc, overall, *_ = row
        f1_scores.append(overall or 0)
        cat_vals = []
        for cat in display_cats:
            scores = run_cats.get(run_id, {}).get(cat, {})
            cat_vals.append(fmt(scores.get("f1", scores.get("recall"))))
        print(f"  {doc[:25]:25s} {fmt(overall):8s} " + " ".join(f"{v:7s}" for v in cat_vals))

    avg_f1 = sum(f1_scores) / len(f1_scores) if f1_scores else 0
    print(f"\n  Average F1: {avg_f1:.3f} across {len(latest_runs)} documents")

    # Totals
    totals = db.execute(f"""
        SELECT SUM(total_correct), SUM(total_missed),
               SUM(total_hallucinated), SUM(total_wrong_value)
        FROM eval_runs WHERE id IN ({placeholders})
    """, run_ids).fetchone()

    if totals[0] is not None:
        c, m, h, w = totals
        total = c + m + h + w
        print(f"  Total elements: {total} "
              f"(correct:{c} missed:{m} hallucinated:{h} wrong_value:{w})")

    # Per-domain summary from normalized scores
    if cat_scores:
        domain_f1s: dict[str, list[float]] = {}
        for _, cat, domain, _, _, f1 in cat_scores:
            if f1 is not None and domain:
                domain_f1s.setdefault(domain, []).append(f1)
        if domain_f1s:
            print(f"\n  Per-domain average F1:")
            for domain in ["architectural", "structural", "mep", "schedule_admin", "site_civil"]:
                scores_list = domain_f1s.get(domain, [])
                if scores_list:
                    avg = sum(scores_list) / len(scores_list)
                    print(f"    {domain:20s} {avg:.3f} ({len(scores_list)} categories)")

    # Top failure patterns
    top_failures = db.execute(f"""
        SELECT f.category, f.failure_type, f.element, COUNT(*) as cnt
        FROM failures f
        WHERE f.run_id IN ({placeholders})
        GROUP BY f.category, f.failure_type, f.element
        ORDER BY cnt DESC LIMIT 5
    """, run_ids).fetchall()

    if top_failures:
        print(f"\n  Top failure patterns:")
        for cat, ftype, elem, cnt in top_failures:
            print(f"    [{cat}] {ftype}: {elem} (x{cnt})")

    print(f"\n{'='*70}\n")


def cmd_regression(results_dir: Optional[str] = None):
    """Run full regression: score all corpus documents and detect regressions."""
    work = Path(results_dir) if results_dir else WORK_DIR
    db = init_db()

    docs = []
    for d in sorted(CORPUS_DIR.iterdir()) if CORPUS_DIR.exists() else []:
        if not d.is_dir():
            continue
        gt_files = list(d.glob("*.ground-truth.json"))
        if gt_files:
            docs.append((d.name, gt_files[0]))

    if not docs:
        print("No corpus documents found.")
        return 1

    print(f"\nRunning regression on {len(docs)} documents...\n")
    all_ok = True

    for doc_id, gt_path in docs:
        ext_path = work / "extraction.json"
        if not ext_path.exists():
            print(f"  {doc_id}: SKIP (no extraction.json in {work})")
            continue

        results = score_document(doc_id, gt_path, ext_path)
        run_id = save_run(db, results)

        # Check for regression vs previous run
        prev = db.execute(
            "SELECT overall_f1 FROM eval_runs WHERE doc_id = ? AND id < ? "
            "ORDER BY run_at DESC LIMIT 1", (doc_id, run_id)
        ).fetchone()

        delta_str = ""
        if prev and prev[0] is not None:
            delta = results["overall_f1"] - prev[0]
            if delta < -0.05:
                delta_str = f"  REGRESSION ({delta:+.3f})"
                all_ok = False
            elif delta > 0.05:
                delta_str = f"  improved ({delta:+.3f})"

        bar = "█" * int(results["overall_f1"] * 20) + "░" * (20 - int(results["overall_f1"] * 20))
        cats_str = ", ".join(results["categories"].keys())
        print(f"  {doc_id:30s}  {bar}  F1={results['overall_f1']:.3f}  [{cats_str}]{delta_str}")

    print(f"\n  {'PASS — no regressions' if all_ok else 'FAIL — regressions detected'}")
    return 0 if all_ok else 1


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    cmd = sys.argv[1]

    if cmd == "score":
        if len(sys.argv) < 3:
            print("Usage: eval.py score <doc_id> [--work-dir /path/to/dir]")
            return 1
        doc_id = sys.argv[2]
        work_dir = None
        if "--work-dir" in sys.argv:
            idx = sys.argv.index("--work-dir")
            if idx + 1 < len(sys.argv):
                work_dir = Path(sys.argv[idx + 1])
        return cmd_score(doc_id, work_dir)

    elif cmd == "regression":
        results_dir = sys.argv[2] if len(sys.argv) > 2 else None
        return cmd_regression(results_dir)

    elif cmd == "history":
        cmd_history(sys.argv[2] if len(sys.argv) > 2 else None)

    elif cmd == "corpus":
        cmd_corpus()

    elif cmd == "failures":
        cat = None
        if "--category" in sys.argv:
            idx = sys.argv.index("--category")
            cat = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None
        cmd_failures(cat)

    elif cmd == "report":
        cmd_report()

    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
