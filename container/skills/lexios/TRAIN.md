# Lexios Training Pipeline

This file is NOT a skill — it's instructions for the scheduled training task. The orchestrator reads this when running `lexios-train`.

## Goal

Build a diverse corpus of construction documents with ground truths that covers ALL 101 extraction types across all 5 domains. The current corpus only covers architectural basics (rooms, doors, windows, dimensions). You need to actively find documents that exercise structural, MEP, schedule, and site/civil types.

## Domain Coverage Targets

Track which domains have ground truth coverage. Your job is to fill the gaps.

| Domain | Types | Current coverage | What to find |
|--------|-------|-----------------|--------------|
| **Architectural** | 27 types | rooms, doors, windows, dimensions, notes (5/27) | Wall types, finishes, ceiling heights, exterior materials, insulation, accessibility |
| **Structural** | 17 types | 0/17 | Beams, columns, joists, foundations, shear walls, connections, load tables |
| **MEP** | 21 types | 0/21 | HVAC equipment, ductwork, plumbing fixtures, electrical panels, lighting, sprinklers |
| **Schedule/Admin** | 17 types | title_block only (1/17) | Door/window/finish/equipment schedules, sheet index, code summary, area calcs |
| **Site/Civil** | 19 types | 0/19 | Site boundaries, setbacks, grading, parking, utilities, drainage |

**Priority order for new documents:**
1. Commercial building with MEP sheets (covers MEP + schedules)
2. Structural drawing set (covers structural domain)
3. Site/civil plan set (covers site domain)
4. Residential with schedules (fills schedule gaps)
5. Multi-story commercial (fills accessibility, egress, elevators)

## Workflow

### 1. Find a new construction PDF

Use agent-browser to search for free construction drawing PDFs. **Prioritize documents that cover uncovered domains.**

**Document types to find (priority order — target uncovered domains first):**
- MEP plans (mechanical, electrical, plumbing layouts) — **HIGH PRIORITY, 0% covered**
- Structural plans (foundation, framing, beam layouts) — **HIGH PRIORITY, 0% covered**
- Site plans (grading, utilities, parking, landscaping) — **HIGH PRIORITY, 0% covered**
- Commercial floor plans with schedules (office, retail, institutional) — fills schedule gaps
- Multi-story buildings (elevators, stairs, egress systems)
- Residential floor plans (single-family, multi-family) — already have basic coverage

**Good sources:**
- County/city permit departments (like permitsonoma.org) — often have full plan sets with MEP/structural
- University architecture programs (student work, often public)
- Government building departments (GSA, state facilities) — commercial buildings with full MEP
- State DOT / public works — site/civil plans
- School district building departments — institutional buildings, good MEP coverage
- Hospital/healthcare facility plans — complex MEP, accessibility requirements

**Search queries (targeted by domain):**
```
# MEP plans
"mechanical plan" "electrical plan" filetype:pdf site:*.gov
"HVAC layout" "plumbing plan" sample filetype:pdf
"electrical panel schedule" "lighting plan" filetype:pdf

# Structural plans
"foundation plan" "framing plan" filetype:pdf site:*.gov
"structural drawings" "beam schedule" sample filetype:pdf
"shear wall" "structural details" filetype:pdf

# Site/Civil plans
"site plan" "grading plan" filetype:pdf site:*.gov
"civil drawings" "utility plan" sample filetype:pdf
"parking layout" "stormwater" filetype:pdf

# Schedules
"door schedule" "window schedule" "finish schedule" filetype:pdf
"equipment schedule" "panel schedule" filetype:pdf

# Full plan sets (best — cover multiple domains)
"construction drawings" "plan set" filetype:pdf site:*.gov
"building permit" "complete plans" filetype:pdf
```

Download the PDF to `/workspace/group/lexios-training/pdfs/` with a descriptive name.

### 2. Run Lexios analysis

```bash
# Prep the document
lexios-prep /workspace/group/lexios-training/pdfs/<name>.pdf --info
lexios-prep /workspace/group/lexios-training/pdfs/<name>.pdf
```

**Choose the right mode based on what's in the document:**

| Document content | Mode to use | Why |
|-----------------|-------------|-----|
| Simple residential floor plans | Quick | Only architectural basics present |
| Has structural OR MEP sheets | Standard | Need domain extraction for structural/MEP types |
| Full plan set (arch + structural + MEP + site) | Comprehensive | Exercise all domains |
| Has schedules (door/window/finish) | Standard | Schedule domain needs extraction |

For standard/comprehensive mode, tell the orchestrator explicitly: "Run in standard mode" or "Run in comprehensive mode". This triggers domain-grouped parallel extraction from `types.json`.

### 3. Evaluate results

After extraction completes, evaluate quality BY READING THE PAGE IMAGES YOURSELF and comparing to what the extraction agent found.

**Read `types.json` first** to know what fields each type expects. Then check:

**Core types (quick mode — should already work well):**
- **Rooms**: Did it find all labeled rooms? Dimensions correct?
- **Doors/Windows**: Count match? Tags and sizes correct?
- **Dimensions**: Key measurements captured? Numbers accurate?
- **Notes/Egress/Stairs/Equipment**: Present and correct?

**Structural types (standard/comprehensive — actively evaluate these):**
- **Beams**: Found all beams? Sizes (W12x26, 6x12 GLB, etc.) correct? Spans noted?
- **Columns**: Located? Sizes correct?
- **Joists/Rafters**: Sizes, spacing (16" OC, 24" OC), spans captured?
- **Foundations**: Types (spread footing, strip), dimensions, rebar specs?
- **Connections**: Simpson ties, joist hangers, anchor bolts identified?
- **Loads**: Dead/live/snow/wind/seismic values captured from notes?

**MEP types (standard/comprehensive — actively evaluate these):**
- **HVAC equipment**: Furnace/condenser found? Tonnage/BTU correct?
- **Ductwork**: Sizes, routing identified?
- **Plumbing fixtures**: Toilets, sinks, tubs counted? Types right?
- **Electrical panels**: Main panel amps? Sub-panels found?
- **Lighting**: Fixture types and locations captured?
- **Sprinklers**: Head types and locations?
- **Smoke detectors**: Locations found?

**Schedule types (standard/comprehensive):**
- **Door schedule**: All rows parsed? Tags match plan tags?
- **Window schedule**: All entries captured? U-factors/SHGC if present?
- **Finish schedule**: Room-by-room finishes correct?
- **Equipment schedule**: Tags, capacities, manufacturers?

**Site/Civil types (standard/comprehensive):**
- **Site boundary**: Property lines, dimensions, bearings?
- **Setbacks**: Required vs actual distances?
- **Parking**: Space count, ADA stalls, dimensions?
- **Utilities**: Water, sewer, gas, electric routing?
- **Grading**: Contours, spot elevations, slopes?

Score each category 0-5:
- 5: Perfect or near-perfect
- 4: Minor omissions but no errors
- 3: Some omissions or 1-2 errors
- 2: Significant gaps or errors
- 1: Mostly wrong
- 0: Completely missed

### 4. Create ground truth

Based on your manual review, create a ground truth file:

```
/workspace/group/lexios-training/ground-truths/<name>.ground-truth.json
```

Follow the same schema as `scripts/lexios-tests/corpus/permit-sonoma-bpc022/permit-sonoma-bpc022.ground-truth.json`.

The `elements` object can include ANY of the 101 type names defined in `types.json` as keys. Each key maps to an array of element dicts with fields matching that type's `fields` plus `page`.

**IMPORTANT: Include ALL types you can identify in the document, not just the core 9.** The more types in the ground truth, the better coverage we get. Specifically:

For structural sheets, include entries for:
```json
{
  "elements": {
    "beams": [{"tag": "B1", "size": "W12x26", "span": "18'-0\"", "location": "Grid A-B", "page": 3}],
    "columns": [{"tag": "C1", "size": "W8x31", "location": "Grid A-1", "page": 3}],
    "joists": [{"type": "floor", "size": "2x10", "spacing": "16\" OC", "span": "12'-0\"", "page": 3}],
    "foundations": [{"type": "spread footing", "dimensions": "24\"x24\"x12\"", "reinforcement": "#4@12\" EW", "page": 3}],
    "structural_connections": [{"type": "joist hanger", "product": "Simpson LUS210", "location": "at beam B1", "page": 3}]
  }
}
```

For MEP sheets, include entries for:
```json
{
  "elements": {
    "hvac_equipment": [{"type": "furnace", "capacity_tons": "3.5", "location": "mechanical room", "page": 5}],
    "plumbing_fixtures": [{"type": "toilet", "location": "bathroom 1", "page": 5}],
    "electrical_panels": [{"type": "main", "amperage": "200A", "location": "garage", "page": 6}],
    "lighting_fixtures": [{"type": "recessed can", "location": "kitchen", "tag": "A", "page": 6}],
    "smoke_detectors": [{"type": "hardwired", "location": "hallway", "page": 6}]
  }
}
```

For schedule sheets:
```json
{
  "elements": {
    "door_schedule": [{"tag": "101", "size": "3'-0\" x 6'-8\"", "type": "solid core", "material": "wood", "page": 7}],
    "window_schedule": [{"tag": "A", "size": "3'-0\" x 4'-0\"", "type": "double-hung", "glazing": "insulated", "page": 7}],
    "finish_schedule": [{"room": "Kitchen", "floor": "tile", "wall": "paint", "ceiling": "gypsum", "page": 7}]
  }
}
```

For site plans:
```json
{
  "elements": {
    "site_boundary": [{"dimension": "120'-0\"", "bearing": "N45°E", "type": "property line", "page": 1}],
    "setbacks": [{"side": "front", "required": "25'-0\"", "actual": "30'-0\"", "page": 1}],
    "parking": [{"total_spaces": "24", "ada_spaces": "2", "location": "south lot", "page": 1}],
    "site_utilities": [{"utility": "water", "size": "2\"", "location": "north property line", "page": 1}]
  }
}
```

The eval framework (`scripts/lexios-eval.py`) dynamically scores all categories present in the ground truth — no code changes needed when adding new types.

### 5. Log the training run

Append to `/workspace/group/lexios-training/training-log.jsonl`:

```json
{
  "date": "2026-02-27",
  "pdf": "filename.pdf",
  "source": "https://...",
  "doc_type": "commercial_mep",
  "pages": 12,
  "mode": "standard",
  "domains_tested": ["architectural", "mep", "schedule_admin"],
  "scores": {
    "rooms": 4,
    "doors": 3,
    "windows": 4,
    "hvac_equipment": 3,
    "plumbing_fixtures": 4,
    "electrical_panels": 2,
    "door_schedule": 4,
    "dimensions": 3,
    "notes": 5
  },
  "avg_score": 3.6,
  "new_types_tested": ["hvac_equipment", "plumbing_fixtures", "electrical_panels", "door_schedule"],
  "issues_found": [
    "Missed 2 of 5 exhaust fans",
    "Electrical panel amperage wrong (read 100A as 200A)"
  ],
  "skill_improvements": [
    "MEP extraction prompt needs instruction to look for equipment tags in title blocks",
    "Electrical panel extraction should cross-reference panel schedule if present"
  ]
}
```

### 6. Propose SKILL.md improvements

If you find consistent failure patterns across multiple training runs:

1. Read the current SKILL.md
2. Identify which domain extraction prompt needs improvement
3. Write the specific change needed
4. Save to `/workspace/group/lexios-training/proposed-changes.md`
5. Report via WhatsApp: "Lexios training found pattern X across N documents. Proposed fix: Y"

**Pay special attention to new domain extraction quality:**
- Are structural member sizes being read correctly?
- Are MEP equipment capacities (tons, BTU, amps) accurate?
- Are schedule tables being parsed row-by-row correctly?
- Are site dimensions and bearings being captured?

Do NOT modify SKILL.md directly — propose changes for human review.

### 7. Copy good ground truths to test suite

When a ground truth file is high-quality (you verified it manually against the images), copy it to the corpus:

```bash
# Create corpus directory for this document
mkdir -p /workspace/project/scripts/lexios-tests/corpus/<doc-id>/

# Copy files
cp /workspace/group/lexios-training/pdfs/<name>.pdf /workspace/project/scripts/lexios-tests/corpus/<doc-id>/
cp /workspace/group/lexios-training/ground-truths/<name>.ground-truth.json /workspace/project/scripts/lexios-tests/corpus/<doc-id>/
```

This grows the automated test suite over time.

### 8. Check domain coverage

After each training run, check coverage status:

```bash
python3 /workspace/project/scripts/lexios-eval.py corpus
```

This shows which categories have ground truth coverage. Your goal is to get at least 3 ground truth entries for each of the 5 domains:
- [ ] Architectural: 3+ docs with extended types (wall_types, finishes, ceiling_heights, etc.)
- [ ] Structural: 3+ docs with beams, columns, joists, foundations
- [ ] MEP: 3+ docs with HVAC, plumbing, electrical types
- [ ] Schedule/Admin: 3+ docs with door/window/finish/equipment schedules
- [ ] Site/Civil: 3+ docs with site boundary, grading, parking, utilities

## Training cadence

Each training run should:
- Find 1 new PDF (prioritize uncovered domains — check coverage first!)
- Choose the right mode (standard or comprehensive for non-residential docs)
- Run Lexios on it
- Evaluate and create ground truth with ALL identifiable types, not just core 9
- Take ~15-20 minutes total

Target: 15+ diverse ground truths covering all 5 domains, with at least 50 of the 101 types exercised.

## What NOT to do

- Don't download copyrighted architectural plans from paid services
- Don't submit the PDFs anywhere or share them externally
- Don't modify SKILL.md directly — only propose changes
- Don't spend more than 20 minutes per training run
- Don't re-test PDFs that already have ground truths
- Don't keep finding residential floor plans — we already have that covered
- Don't create ground truths with only rooms/doors/windows if the document has structural/MEP/schedule content visible
