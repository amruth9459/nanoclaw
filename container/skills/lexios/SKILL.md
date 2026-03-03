---
name: lexios
description: Analyze construction documents — blueprints, floor plans, specs, schedules. Extract structured data, check code compliance (IBC/ADA/NFPA), find cross-discipline conflicts, and calculate quantities. Activate when a PDF with architectural or engineering content is shared.
allowed-tools: Bash(lexios-prep:*), Bash(lexios-post-extract:*), Bash(lexios-takeoff:*), Bash(lexios-conflicts:*), Bash(lexios-query:*), Bash(lexios-diff:*), Bash(lexios-dxf:*), Bash(lexios-ifc:*), Bash(lexios-classify:*), Read, Task, Write
---

# Lexios — Construction Document Intelligence

Analyze construction documents by extracting structured data (Claude vision), then running deterministic post-extraction pipelines.

## PDF Analysis (5 steps)

### 1. Prepare
```bash
lexios-prep /workspace/media/<file>.pdf [--pages N] [--dpi 300]
```
Output: `/workspace/group/lexios-work/page-*.png`

### 2. Classify Pages
Read each PNG with vision. Classify as: floor_plan, elevation, section, detail, schedule, site_plan, structural, mep, cover, spec.

### 3. Extract Elements
Load types from `/home/node/.claude/skills/lexios/types.json`. Select types matching page types present.

**Modes** (default Quick unless user requests otherwise):
- **Quick** (~9 types, ~$0.50): rooms, doors, windows, dimensions, title_block, notes, egress_paths, stairs_elevators, equipment
- **Standard** (~30 types, ~$2.00): Quick + domain-relevant types
- **Comprehensive** (~100 types, ~$5.00): All types across all domains

Read PNGs and extract structured JSON for each type. Each element has fields defined in types.json.
Write to `/workspace/group/lexios-work/extraction.json`.

### 4. Run Post-Extraction Pipeline
```bash
lexios-post-extract /workspace/group/lexios-work --format whatsapp --json
```
This single command runs **all** post-extraction analysis in parallel:
- **Compliance** — checks IBC/ADA/NFPA rules from codes.db
- **Conflicts** — schedule vs plan mismatch, dimension inconsistency, duplicate tags, missing data, cross-discipline gaps
- **Takeoff** — element counts by type/level, area aggregation

Output: `analysis.json` (envelope with messages + file paths), `compliance.json`, `conflicts.json`, `takeoff.json`.

The `--json` flag returns a structured envelope with `messages` array ready for WhatsApp.

### 5. Send Results
Send each message from the `messages` array. Use `send_file` MCP tool for the full `analysis.json`.

## DXF/DWG Analysis
```bash
lexios-dxf /workspace/media/<file>.dxf /workspace/group/lexios-work/
lexios-post-extract /workspace/group/lexios-work --format whatsapp --json
```

## IFC (BIM) Analysis
```bash
lexios-ifc /workspace/media/<file>.ifc /workspace/group/lexios-work/
lexios-post-extract /workspace/group/lexios-work --format whatsapp --json
```

## Follow-up Questions
```bash
lexios-query "<question>" --work-dir /workspace/group/lexios-work --json
```
Returns deterministic answer for simple queries (quantity, location, specification).
Returns `{"needs_llm": true, "context": ...}` for complex queries — answer with your own reasoning using the context provided.

## Individual Pipeline Commands
```bash
lexios-takeoff /workspace/group/lexios-work/extraction.json --json
lexios-conflicts /workspace/group/lexios-work/extraction.json --json
lexios-classify "user question here"
```

## Revision Comparison
```bash
lexios-diff <old-extraction.json> <new-extraction.json> --json
```

## Important Rules
- **Default Quick mode** — only upgrade if user requests or document is complex
- **Never hallucinate codes** — only cite sections from compliance.json results
- **DXF data > PDF OCR** — native CAD coordinates are more reliable
- **4000 char limit** per WhatsApp message — pipeline handles splitting
- **extraction.json schema**: `{type_name: [{field: value, page: N}, ...], ...}`
- Types, fields, match_keys defined in `/home/node/.claude/skills/lexios/types.json`
