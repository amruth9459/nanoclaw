# Lexios Autoresearch Program (v2 — 2026-07-16)

## Objective

Raise **real-vision extraction F1** on the fixed eval set. Nothing else counts.

- **Eval docs:** `Duplex_A_20110907` (residential duplex, 2 level images) and
  `NBU_MedicalClinic_Arch` (medical clinic, 8 quadrant images).
- **Metric:** effective F1 = F1 of your postprocessed output when the
  fabrication probes are clean, else F1 of the RAW vision output. Measured by
  the orchestrator, not by you.
- **Success criteria:** F1 ≥ 0.70 on the duplex, ≥ 0.50 on the clinic
  (real vision starts around 0.2–0.4).

## How a night works (v2 mechanics — read this, it changed)

1. The orchestrator measures tonight's **baseline** (current experiment.py,
   real vision, eval docs) before any session runs.
2. Your session edits ONLY the CONFIG section of `experiment.py` — one
   hypothesis — and ends. You cannot run anything; you have no shell.
3. The orchestrator measures your edit the same way, keeps it only on strict
   improvement over tonight's best, and reverts it otherwise. Edits outside
   the CONFIG markers are auto-rejected before measurement.

## What died in v1 (do not resurrect)

The old corpus metric scored 80+ docs where `postprocess()` **injections**
(elements seeded from ground-truth knowledge) saturated F1 at 1.0 while real
vision F1 sat at 0.2–0.4. Injections are now detected: measurement probes
`postprocess({})` and a 1-element decoy; if postprocess manufactures elements
from nothing, it is disqualified and the run is scored on raw vision output.
`postprocess()` may TRANSFORM vision output — rename, normalize, dedupe,
split — never invent. Corpus/manifest registration work no longer moves the
metric and is a wasted night-slot.

## Research directions (priority order — unchanged, still unexploited)

### 1. Room name matching (high impact)
GT uses IFC names ("FOYER", "HALLWAY"); vision produces variants ("Living
Area" vs "LIVING ROOM", "STOR." vs "STORAGE"). Levers: prompt for canonical
IFC-style names; honest normalization maps in postprocess (input-transforming).

### 2. Door/window tag extraction (high impact)
GT has tags like "A101"; vision misses or invents them. Levers: prompt
emphasis on reading tags; preprocess zoom/crop strategies.

### 3. Element count coverage (medium impact)
Duplex GT has 24 doors; vision typically finds 5–12. Levers: higher DPI in
preprocess; quadrant/zone splitting; "list ALL doors, even closet/bathroom
doors" prompt phrasing.

### 4. Dimension extraction (medium impact)
GT sizes like "49.2x79.1". Levers: explicit prompt instruction to read
dimension annotations.

### 5. Structural elements (low priority)
Beams/railings — hard from 2D. Parked.

## Hard boundaries

- Edit ONLY between `EXPERIMENT CONFIG` markers in `experiment.py`.
- Do NOT touch `evaluate.py`, `prepare.py`, ground truth, the markers, or
  `run()` — the guard rejects the whole edit.
- No GT-derived injections (probed; scored as raw if detected).
- One hypothesis per slot; don't repeat rows from the results history.

## Metrics history

`results.tsv` — rows from 2026-07-16 onward are orchestrator-measured
real-vision eval scores. Rows before 2026-07-15 are from the saturated corpus
metric under a broken gate (see `results-archive.tsv`) — do not trust or
compare against them.
