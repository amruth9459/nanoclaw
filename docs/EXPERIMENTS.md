# Experiment Log

*Structured experiment tracker. Read before starting new experiments to avoid repeating work.*
*Both Claude Code and Claw agents update this file when experiments conclude.*

---

## Entry Format

```
### EXP-NNN: Title (YYYY-MM-DD)
**Domain:** extraction | architecture | prompt-engineering | product | workflow | infrastructure
**Status:** completed | failed | abandoned | in-progress
**Hypothesis:** What we expected
**Approach:** What we tried
**Result:** What happened (with numbers)
**Learning:** Key takeaway
**Files:** Relevant paths
**Journal:** [YYYY-MM-DD](journal/YYYY-MM-DD.md)
```

---

### EXP-001: Docling as PDF Preprocessing (2026-03-05)
**Domain:** extraction
**Status:** failed
**Hypothesis:** Docling's document understanding could replace or supplement Claude vision for PDF extraction, especially for table-heavy documents.
**Approach:** Ran Docling on the full eval corpus (86 docs). Compared extraction quality against Claude vision pipeline.
**Result:** 0% accuracy on vector drawings (architectural plans, floor plans). Excellent table extraction for schedule/spec pages. Cannot replace Claude vision for the core use case.
**Learning:** Docling is worth using as a preprocessing step for schedule/spec pages only, not as a general replacement. Script at `lexios/docling_eval.py`.
**Files:** `~/Lexios/docling_eval.py`
**Journal:** [2026-03-05](journal/2026-03-05.md)

### EXP-002: Extraction Quality v0 to v2 (2026-03-05)
**Domain:** extraction
**Status:** completed
**Hypothesis:** Zone splitting and page remapping could dramatically increase extraction element count from architectural PDFs.
**Approach:** Three iterations on Holabird 10-page PDF. v0: naive single-pass. v1: zone splitting (40 zones). v2: deduplication + page remapping (pages 1-3).
**Result:** v0: 39 elements (rooms 8, doors 5, windows 4). v1: 520 elements (13.3x improvement, rooms 97, doors 50). v2: 696 elements (rooms 115 after dedup from 305, doors 76, windows 21). Cost held at ~$1.80. Door/window tags still low (6%/4%) because 9/10 pages are cover sheets.
**Learning:** Zone splitting is the single biggest extraction quality lever. Deduplication is essential after splitting. Page remapping works but needs careful tuning per document type.
**Files:** `~/Lexios/lexios/extract.py`, `lexios/work/7405711584-v2/`
**Journal:** [2026-03-05](journal/2026-03-05.md)

### EXP-003: Eval Baseline (2026-03-23)
**Domain:** extraction
**Status:** completed
**Hypothesis:** Establishing a baseline F1 score across the full corpus would reveal which document types and domains need the most work.
**Approach:** Ran eval.py across 86 docs with 91 ground truths and 27,968 elements across 33 categories. Improved `_find_extraction()` search and added `_normalize_ifc_extraction()` for IFC key mapping.
**Result:** Overall F1: 0.227 (57/86 scored, 29 skipped with no extraction). By domain: Schedule/Admin 0.781, Structural 0.233, Architectural 0.185, MEP 0.047. IFC docs: F1=1.0 after key normalization. PDF docs: F1=0.4-0.67 (permit-sonoma 0.600, a111-floorplans 0.667).
**Learning:** Schedule/Admin extraction is nearly solved. MEP is the weakest domain. IFC programmatic extraction is perfect once key names are normalized. The gap is in PDF vision extraction, particularly for MEP systems.
**Files:** `~/Lexios/lexios/eval.py`, `~/Lexios/corpus/`
**Journal:** [2026-03-23](journal/2026-03-23.md)

### EXP-004: ClawWork Economics System (2026-02-23)
**Domain:** product
**Status:** abandoned
**Hypothesis:** An economic system with token-level cost tracking and autonomous task assignment would make the agent self-sustaining.
**Approach:** Built 4 DB tables (usage_logs, group_economics, clawwork_tasks, clawwork_learns), MCP tools, Haiku evaluation, bounty hunting system with HITL approval gate.
**Result:** System worked technically but added unnecessary complexity. The bounty hunting and autonomous revenue generation didn't produce meaningful results. Token tracking was useful but the ClawWork task/learn loop was over-engineered.
**Learning:** Token-level cost tracking is valuable for observability. Autonomous revenue generation for an AI agent is premature — focus on utility first. The bounty hunting concept needs a much clearer market signal before investing further.
**Files:** `src/db.ts`, `src/index.ts`, DashClaw Economics tab
**Journal:** [2026-02-23](journal/2026-02-23.md)
