#!/usr/bin/env python3
"""Trusted re-scorer for the autoresearch eval gate (v2, 2026-07-16).

WHY THIS EXISTS (adversarial-grade Finding 1): experiment.py executes
agent-authored CONFIG code (preprocess/postprocess) inside the same process
that computes and reports F1, so in-process code could rebind the scorer or
doctor the summary and forge any number. This script is the other side of the
trust boundary: it NEVER imports or executes experiment.py or any CONFIG code.
It reads the extraction ARTIFACTS the untrusted process dumped (raw vision
output, postprocessed output, probe outputs), recomputes every score against
ground truth itself, and prints the summary the orchestrator gates on.

An adversary can still write GT-derived content INTO the artifacts (that is
injection, and the randomized probes + raw/post split target it), but it can
no longer control the arithmetic. This file is covered by the orchestrator's
guard hash — editing it is a rejected gate edit.

Usage: score_eval.py <artifacts.json> <gt_dir> <probe_sentinel> <doc_id,doc_id,...>
Prints a JSON summary on the last line.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "Lexios"))
from lexios.eval import score_elements, get_match_keys  # noqa: E402


def count_elements(d: dict) -> int:
    return sum(len(v) for v in d.values() if isinstance(v, list))


def score_extraction(extracted: dict, gt_elements: dict, gt_is_min: bool) -> float:
    all_f1 = []
    for category, gt_items in gt_elements.items():
        if not isinstance(gt_items, list) or not gt_items:
            continue
        scores = score_elements(gt_items, extracted.get(category, []),
                                match_keys=get_match_keys(category),
                                gt_is_minimum=gt_is_min)
        all_f1.append(scores["f1"])
    return sum(all_f1) / len(all_f1) if all_f1 else 0.0


def main() -> int:
    artifacts_path, gt_dir_s, sentinel, docs_s = sys.argv[1:5]
    gt_dir = Path(gt_dir_s)
    eval_docs = [d for d in docs_s.split(",") if d]

    try:
        artifacts = json.loads(Path(artifacts_path).read_text())
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"artifacts unreadable: {e}"}))
        return 1

    # ── Phantom recount (trusted): fabrication from empty/decoy probe outputs.
    # Missing probe outputs fail CLOSED (treated as not clean).
    if "probe_empty_out" not in artifacts or "probe_decoy_out" not in artifacts:
        clean = False
        fabricated = -1
    else:
        n_empty = count_elements(artifacts["probe_empty_out"])
        decoy_out = artifacts["probe_decoy_out"]
        n_decoy_in = count_elements(artifacts.get("probe_decoy_in", {})) or 2
        fabricated = max(n_empty, max(0, count_elements(decoy_out) - n_decoy_in))
        # The decoy input carried the run's random sentinel; a postprocess that
        # DROPS those elements is behaving differently on probe-shaped input —
        # suspicious, fail closed.
        decoy_text = json.dumps(decoy_out)
        sentinel_survived = sentinel in decoy_text if sentinel else True
        clean = fabricated == 0 and sentinel_survived

    manifest = {m["doc_id"]: m for m in json.loads((gt_dir / "manifest.json").read_text())}
    results = []
    for doc_id in eval_docs:
        doc_art = (artifacts.get("docs") or {}).get(doc_id)
        if not doc_art or "raw" not in doc_art or "post" not in doc_art:
            # Missing artifacts fail closed: doc scores 0.
            results.append({"doc_id": doc_id, "raw_f1": 0.0, "post_f1": 0.0,
                            "f1": 0.0, "missing_artifacts": True})
            continue
        gt_data = json.loads((gt_dir / manifest[doc_id]["gt_file"]).read_text())
        gt_elements = gt_data.get("elements", {})
        gt_is_min = gt_data.get("gt_is_minimum", True)
        if gt_is_min is None:
            gt_is_min = True
        raw_f1 = score_extraction(doc_art["raw"], gt_elements, gt_is_min)
        post_f1 = score_extraction(doc_art["post"], gt_elements, gt_is_min)
        eff = post_f1 if clean else raw_f1
        results.append({"doc_id": doc_id, "raw_f1": round(raw_f1, 4),
                        "post_f1": round(post_f1, 4), "f1": round(eff, 4)})

    overall = sum(r["f1"] for r in results) / len(results) if results else 0.0
    print(json.dumps({
        "ok": True,
        "overall_f1": round(overall, 4),
        "phantom_fabricated": fabricated,
        "phantom_clean": clean,
        "results": results,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
