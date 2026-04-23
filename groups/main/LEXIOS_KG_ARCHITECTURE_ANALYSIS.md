# Lexios Knowledge Graph Architecture Analysis

## The Fundamental Tension: Graph Size vs. Context Windows

> "Not selling document intelligence. Selling **verified project truth with a provenance chain.** Every answer has a receipt."

> "$50M building = 30K+ pages, gap between what project knows vs what people know."

> "Too big for any AI model to hold in context."

This document quantifies that tension, analyzes why standard retrieval approaches fail for construction knowledge graphs, and proposes a 4-tier hierarchical retrieval architecture that makes the problem tractable without sacrificing the completeness guarantees that define Lexios's value.

---

## 1. The Scaling Challenge (Quantified)

### Measured Extraction Density

From Lexios's actual extraction data across 6 ingested projects:

| Source | Pages | Elements | Elements/Page | Assertions/Entity |
|--------|-------|----------|---------------|-------------------|
| Holabird (10-page residential) | 10 | 696 | 69.6 | ~5.9 |
| Medical Clinic (IFC, arch) | - | 367 | ~45* | ~5.9 |
| Office Building (IFC, MEP) | - | 3,594 | ~120* | ~5.9 |
| Knowledge DB (all 6 projects) | - | 5,044 | - | - |
| Store DB (1 project loaded) | - | 59 entities | - | 349 assertions |

*Estimated from IFC element counts; IFC files contain denser structured data than PDFs.

**Measured averages from Holabird (our best-characterized dataset):**
- 696 elements across 47 entity categories from 10 pages
- Raw JSON: 76,944 bytes = ~111 bytes/element = ~28 tokens/element
- ~5.9 assertions per entity in the store
- Assertions carry: entity_id, entity_type, field, value, value_numeric, value_unit, source_doc_id, source_page, confidence, extraction_model, status = ~200 bytes/assertion = ~50 tokens/assertion

### Extrapolation to $50M Building (30K+ Pages)

A $50M commercial building project typically includes:

```
Document Set Breakdown (30,000 pages):
  Architectural drawings:      3,000 pages
  Structural drawings:         2,000 pages
  MEP drawings:                4,000 pages
  Specifications:              5,000 pages
  Submittals:                  8,000 pages
  RFIs/Change Orders:          2,000 pages
  Field reports:               3,000 pages
  Closeout docs:               3,000 pages
```

Using measured densities (conservative 40 elements/page for drawings, 15 for text docs):

```
Entity Projection:
  Drawing entities:     9,000 pages x 40 elem/page  = 360,000
  Spec entities:        5,000 pages x 15 elem/page  =  75,000
  Submittal entities:   8,000 pages x 10 elem/page  =  80,000
  Admin entities:       8,000 pages x  5 elem/page  =  40,000
  ─────────────────────────────────────────────────────────────
  TOTAL ENTITIES:                                    ≈ 555,000
  TOTAL ASSERTIONS (x5.9):                           ≈ 3,275,000
  TOTAL RELATIONSHIPS (est 2x entities):             ≈ 1,110,000

Token Budget (full graph in context):
  Entities:       555,000 x 28 tokens    =  15,540,000 tokens
  Assertions:   3,275,000 x 50 tokens    = 163,750,000 tokens
  Relationships: 1,110,000 x 20 tokens   =  22,200,000 tokens
  ─────────────────────────────────────────────────────────────
  TOTAL:                                  ≈ 201,490,000 tokens
                                          ≈ 201M tokens
```

### Context Window Comparison

```
┌─────────────────────────────┬──────────────┬─────────────────────┐
│ Model                       │ Context      │ % of $50M Graph     │
├─────────────────────────────┼──────────────┼─────────────────────┤
│ Claude 3.5 Sonnet           │ 200K tokens  │ 0.10%               │
│ Claude 3.5 Opus / Sonnet 4  │ 200K tokens  │ 0.10%               │
│ Gemini 2.0 Flash            │ 1M tokens    │ 0.50%               │
│ Gemini 2.0 Pro              │ 2M tokens    │ 1.00%               │
│ Hypothetical 10M context    │ 10M tokens   │ 4.97%               │
│ Hypothetical 100M context   │ 100M tokens  │ 49.7%               │
└─────────────────────────────┴──────────────┴─────────────────────┘
```

### The Crossover Point

At what project size does full-graph-in-context become impossible?

```
Context Budget: 200K tokens (Claude)
  ÷ 28 tokens/entity = ~7,100 entities
  ÷ 69.6 entities/page = ~102 pages
  = roughly a 10-15 page residential project ← THIS IS WHERE WE ARE TODAY

Context Budget: 2M tokens (Gemini)
  ÷ 28 tokens/entity = ~71,400 entities (entities only, no assertions)
  ÷ 69.6 entities/page = ~1,026 pages

Context Budget: 2M tokens (with assertions)
  ÷ (28 + 50×5.9) tokens/entity-with-assertions = ~6,400 entities
  ÷ 69.6 entities/page = ~92 pages
```

**Conclusion: Even Gemini's 2M context window can only hold ~92 pages of fully-asserted construction data. A $50M building generates 30,000+ pages. The gap is 300x and growing.**

The problem is structural, not a matter of waiting for bigger context windows.

---

## 2. Current Architecture: Strengths & Limits

### Dual-Database Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Lexios Knowledge Graph                        │
│                                                                  │
│  ┌─────────────────────────┐   ┌─────────────────────────────┐  │
│  │     store.db             │   │     knowledge.db             │  │
│  │  (Assertion Store)       │   │  (Pattern Knowledge Base)    │  │
│  │                          │   │                              │  │
│  │  kg_assertion_projects   │   │  kg_projects                 │  │
│  │  kg_assertion_documents  │   │  kg_elements                 │  │
│  │  kg_assertion_entities   │   │  kg_relationships            │  │
│  │  kg_assertions           │   │  kg_patterns                 │  │
│  │  kg_conflicts            │   │  kg_dimensions               │  │
│  │  kg_assertion_relationships│ │                              │  │
│  └────────────┬─────────────┘   └──────────────┬──────────────┘  │
│               │                                │                 │
│               └──────────┬─────────────────────┘                 │
│                          │                                       │
│                  ┌───────▼───────┐                               │
│                  │   graph.py     │                               │
│                  │ (Unified API)  │                               │
│                  │               │                               │
│                  │ • impact()    │                               │
│                  │ • missing()   │                               │
│                  │ • traverse()  │                               │
│                  │ • context()   │                               │
│                  │ • anomalies() │                               │
│                  └───────────────┘                               │
└──────────────────────────────────────────────────────────────────┘
```

### What Works Today

**store.py — Provenance-Tracked Assertions (~380 lines)**
- Entity resolution by type family: spatial, spec, document-number, submittal, field, closeout
- Deterministic entity ID generation (canonical, dedup-safe)
- Conflict detection via GROUP BY entity_id, field HAVING COUNT(DISTINCT value) > 1
- Severity classification (high: size/material/fire_rating, medium: location/tag, low: other)
- Numeric value parsing (feet-inches, unit extraction)
- Full extraction→assertion pipeline with auto-project/document creation

**knowledge.py — Cross-Project Pattern Discovery (~450 lines)**
- Building type detection (medical/educational/residential/commercial/industrial)
- Relationship inference: adjacency, containment, structural bearing, finish application
- Welford's online algorithm for dimension statistics
- Pearson correlation across project features
- Pattern discovery: dimension norms, room adjacency, element density, missing element prediction

**graph.py — Unified Query API (~730 lines)**
- BFS traversal for impact analysis (bidirectional, unlimited depth)
- Missing submittal detection via spec-requirement ↔ actual-submittal cross-reference
- Relationship graph navigation with type filtering and depth limits
- Entity context view: assertions + relationships + conflicts + dimension norms + patterns
- Anomaly detection via z-score comparison (dimension outliers > 2σ)

### Where It Breaks Down at Scale

| Query Pattern | Works At | Breaks At | Failure Mode |
|---------------|----------|-----------|--------------|
| Impact analysis (BFS) | 100 entities | 10K entities | O(V+E) memory, unbounded traversal |
| Conflict detection | 1K assertions | 100K assertions | Full-table GROUP BY becomes slow |
| Missing submittals | 100 requirements | 5K requirements | Cartesian cross-check |
| Anomaly detection | 100 rooms | 10K rooms | Per-room DB round-trip |
| Entity context | Single entity | Batch queries | No caching, 6+ DB queries per call |

**Critical gap: No query result caching, no pre-computed indices, no spatial partitioning.**

The current architecture handles the "10-page residential project" regime perfectly. It does not scale to the "30,000-page commercial project" regime that defines the $50M opportunity.

---

## 3. RAG isn't Enough (Critical Analysis)

Standard Retrieval-Augmented Generation works well for document Q&A: embed text chunks, find similar chunks via vector search, inject top-k results into the prompt. This approach systematically fails for construction knowledge graphs.

### Failure Mode 1: Spatial Reasoning

**The Query:** "Does the HVAC supply duct on Level 2 have adequate clearance above the structural beam at grid intersection B-4?"

**What RAG retrieves:** The 5 most semantically similar text chunks about HVAC ducts, beams, and Level 2. These chunks likely come from different documents (MEP drawings vs. structural drawings) and contain no explicit clearance statement.

**What's actually needed:**
1. HVAC duct entity → assertions: bottom elevation = 9'-2" AFF, duct height = 18"
2. Structural beam at B-4 → assertions: top elevation = 10'-0" AFF, beam depth = 24"
3. Ceiling plenum calculation: 10'0" - 24" beam = 8'0" clearance; duct needs 9'2" + 18" = 10'8"
4. **Conflict detected: duct penetrates beam zone by 8 inches**

This requires graph traversal (entity → assertions → spatial intersection → conflict), not semantic similarity. No embedding model captures "9'-2" AFF" as spatially related to "10'-0" AFF at grid B-4."

### Failure Mode 2: Conflict Detection

**The Query:** "Are there any conflicts between the architectural door schedule and the structural opening schedule?"

**What RAG retrieves:** Similar-sounding paragraphs about doors from both schedules.

**What's actually needed:** An exhaustive cross-reference:
- For EVERY door in the architectural schedule (76 doors in Holabird alone)
- Find the corresponding structural opening
- Compare: width, height, header size, fire rating, hardware prep
- Flag ANY mismatch, not just the "most similar" ones

Conflict detection requires **guaranteed completeness** — you must check every pair, not a top-k sample. Missing even one conflict in a fire-rated assembly can fail an inspection and halt a $50M project. RAG's probabilistic retrieval cannot provide this guarantee.

### Failure Mode 3: Compliance Checking

**The Query:** "Does this building comply with IBC Table 1006.3.4(1) for maximum egress distance?"

**What RAG retrieves:** Text chunks mentioning "egress distance" or "IBC 1006."

**What's actually needed:**
1. Retrieve occupancy classification → B (Business)
2. Retrieve sprinkler status → Yes, NFPA 13
3. Look up IBC Table 1006.3.4(1): Business + sprinklered = 300 ft max
4. Calculate actual maximum egress distance from floor plan geometry
5. **Deterministic pass/fail** — not "this is probably compliant based on similar projects"

Building code compliance is a deterministic decision tree, not a similarity search. The answer must be "compliant" or "non-compliant," never "probably compliant." The IBC doesn't accept confidence scores.

### Failure Mode 4: Impact Analysis

**The Query:** "If we change the beam size at grid B-4 from W24x68 to W21x62, what else is affected?"

**What RAG retrieves:** Documents mentioning W24x68 or grid B-4.

**What's actually needed:** A complete traversal:
```
W24x68 at B-4 (structural)
  ├─ bears on → Column B-4 (check: reduced load OK?)
  ├─ supports → Slab Level 3 (check: deflection within L/360?)
  ├─ penetrated by → HVAC duct D-42 (check: clearance still adequate?)
  ├─ fire rated → 2-hour assembly A-312 (check: UL listing valid for W21?)
  ├─ referenced in → RFI #042 (notify architect of scope change)
  └─ specified in → Spec Section 05 12 00 (check: W21x62 meets spec?)
```

This is BFS graph traversal. RAG returns a flat list of "related" documents. It cannot guarantee discovery of the fire rating implication or the HVAC clearance conflict — the very issues that cause construction delays and cost overruns.

### Summary: Why RAG Fails for Construction

| Requirement | RAG Provides | Construction Needs |
|-------------|-------------|-------------------|
| Completeness | Top-k approximation | Guaranteed exhaustive |
| Reasoning | Semantic similarity | Spatial + logical + arithmetic |
| Output | Probabilistic relevance | Deterministic pass/fail |
| Traversal | Flat document retrieval | Graph path navigation |
| Provenance | "Source: chunk #47" | "Page 3, Door Schedule, Rev C, 2024-01-15" |

---

## 4. Hierarchical Retrieval Architecture (Proposed Solution)

### Design Principles

1. **Never put the whole graph in context** — the math proves it can't work
2. **Pre-compute what you can, retrieve on demand what you must**
3. **Tier selection is query-dependent** — different questions need different graph views
4. **Completeness guarantees flow from the database, not the LLM**

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        QUERY ROUTER                                 │
│  Classifies query → selects tier combination → assembles context    │
│                                                                     │
│  "What's the door at Room 101?"         → Tier 1 + Tier 4 (direct)│
│  "Any conflicts in the door schedule?"  → Tier 2 + Tier 3 + T4    │
│  "Impact of changing beam at B-4?"      → Tier 3 (subgraph) + T4  │
│  "Is this building IBC compliant?"      → Tier 1 + Tier 3 + T4    │
└──────────────┬──────────────────────────────────────────────────────┘
               │
     ┌─────────┼─────────┬──────────────┬──────────────┐
     ▼         ▼         ▼              ▼              │
┌─────────┐ ┌─────────┐ ┌────────────┐ ┌────────────┐ │
│ TIER 1  │ │ TIER 2  │ │  TIER 3    │ │  TIER 4    │ │
│ Project │ │ Entity  │ │ Subgraph   │ │ Full       │ │
│ Summary │ │ Catalog │ │ Cache      │ │ Assertion  │ │
│ Index   │ │ + Bloom │ │            │ │ Store      │ │
│         │ │ Filters │ │            │ │            │ │
│ 5K tok  │ │ 20K tok │ │ 50K tok    │ │ On-demand  │ │
│ Always  │ │ Always  │ │ Per-query  │ │ Per-entity │ │
│ in ctx  │ │ in ctx  │ │ loaded     │ │ retrieved  │ │
└─────────┘ └─────────┘ └────────────┘ └────────────┘ │
     │           │            │              │         │
     └───────────┴────────────┴──────────────┘         │
               COMBINED CONTEXT WINDOW                  │
               (max 150K tokens per query)              │
               ─────────────────────────────────────────┘
```

### Tier 1: Project Summary Index (Always in Context)

**Purpose:** High-level routing and decision-making. Every query gets this context.

**Content:**
```json
{
  "project": {
    "name": "Riverside Medical Center",
    "type": "medical",
    "value": "$52M",
    "jurisdiction": "City of Phoenix, AZ",
    "code_year": "2021 IBC"
  },
  "building": {
    "stories": 4,
    "total_area_sf": 128000,
    "construction_type": "Type I-A",
    "occupancy": ["B", "I-2", "A-3"],
    "sprinklered": true
  },
  "systems": {
    "structural": "Steel frame, composite deck",
    "hvac": "VAV with chilled water",
    "plumbing": "Domestic + medical gas",
    "electrical": "480/277V, emergency generator",
    "fire_protection": "NFPA 13 wet pipe"
  },
  "documents": {
    "total_pages": 31247,
    "drawing_sheets": 847,
    "spec_sections": 312,
    "submittals": 1847,
    "rfis": 342
  },
  "critical_dimensions": {
    "floor_to_floor": "14'-0\" (typical), 16'-6\" (Level 1)",
    "column_grid": "30' x 30' (typical)",
    "plenum_depth": "4'-6\" (typical)"
  },
  "known_issues": {
    "open_conflicts": 47,
    "high_severity": 12,
    "missing_submittals": 23,
    "pending_rfis": 18
  }
}
```

**Size:** ~800 bytes JSON = ~200 tokens raw, ~2K tokens with formatting and labels.

**Max budget:** 5K tokens (leaves room for project-specific annotations).

**Generation:** Post-extraction aggregation. Updated on every new document ingestion. Deterministic — no LLM needed to generate.

### Tier 2: Entity Catalog with Bloom Filters

**Purpose:** Fast existence checks ("Does this entity exist in the project?") and catalog-level queries ("How many doors on Level 2?") without loading full entity data.

**Content:**
```
ENTITY CATALOG (555,000 entries)
─────────────────────────────────
Format per entry: entity_id | type | level | doc_count | assertion_count | confidence_avg
Size per entry: ~40 bytes = ~10 tokens

Example entries:
  door:level-1:lobby:3068 | door | L1 | 3 docs | 12 assertions | 0.94
  room:level-2:exam-4     | room | L2 | 2 docs | 8 assertions  | 0.91
  spec-section:09-21-16   | spec | -  | 1 doc  | 24 assertions | 0.97
```

**Full catalog size:** 555,000 x 10 tokens = 5.55M tokens — too large for context.

**Solution: Compressed index + Bloom filter**

```
COMPRESSED INDEX (in-context, ~20K tokens):
  ┌──────────────────────────────────────────────┐
  │ Entity Type Summary                           │
  │   rooms: 4,200 (L1: 1050, L2: 1050, ...)    │
  │   doors: 3,800 (L1: 950, L2: 950, ...)      │
  │   windows: 1,200                              │
  │   spec_sections: 312                          │
  │   ...                                         │
  │                                               │
  │ Level Index (entity count per level per type) │
  │   L1: 2800 entities, L2: 2600, L3: 2400, L4: 2200 │
  │                                               │
  │ Discipline Index                              │
  │   Architectural: 45% entities                 │
  │   Structural: 15%                             │
  │   MEP: 30%                                    │
  │   Spec: 10%                                   │
  │                                               │
  │ Bloom Filter (serialized, ~2KB)               │
  │   FPR: 1% for 555K entities                   │
  │   Checks: entity_exists(id) → bool            │
  └──────────────────────────────────────────────┘
```

**Bloom filter math:**
- 555,000 entities, 1% false positive rate
- Optimal: m = -n×ln(p) / (ln2)² = -555000×ln(0.01) / 0.48 ≈ 5,327,000 bits = 665 KB
- Base64 encoded: ~890 KB — too large for context
- **Alternative: per-level/per-type mini-blooms** (only load the relevant partition)
  - Per-level: ~1,300 entities/level × 4 levels = 5,200 per partition
  - 5,200 entities at 1% FPR = ~6.2 KB per partition = ~8.3 KB base64
  - **Load 1-2 relevant partitions per query: 8-17 KB = ~4K-8K tokens**

**Query coverage:** Answers "how many X on level Y?" and "does entity Z exist?" without any database call. Routes deeper queries to Tier 3/4 with precise partition hints.

### Tier 3: Relationship Subgraph Cache

**Purpose:** Pre-computed graph neighborhoods for common query patterns. Loaded per-query based on Tier 1/2 routing.

**Partitioning Strategies:**

```
SPATIAL PARTITIONING
────────────────────
┌──────┬──────┬──────┐
│ Zone │ Zone │ Zone │  Level 2 Grid
│ A1   │ A2   │ A3   │  (30' x 30' column grid)
├──────┼──────┼──────┤
│ Zone │ Zone │ Zone │  Each zone: ~200 entities
│ B1   │ B2   │ B3   │  + internal relationships
├──────┼──────┼──────┤
│ Zone │ Zone │ Zone │  ~2K tokens per zone
│ C1   │ C2   │ C3   │
└──────┴──────┴──────┘

Partition key: (level, grid_zone)
Typical query loads: 1-4 adjacent zones = 2K-8K tokens
```

```
DISCIPLINE PARTITIONING
───────────────────────
  ┌─────────────┐
  │ Structural  │── bears_on ──┐
  │ Subgraph    │              │
  └──────┬──────┘              │
         │supports             │
  ┌──────▼──────┐       ┌─────▼─────┐
  │ MEP         │──pen──│ Arch      │
  │ Subgraph    │       │ Subgraph  │
  └─────────────┘       └───────────┘

Cross-discipline edges pre-computed at partition boundaries.
Load one discipline subgraph + boundary edges: ~15K tokens
```

```
TEMPORAL PARTITIONING (Document Versions)
─────────────────────────────────────────
  Rev A (2024-01) ──superseded_by──▶ Rev B (2024-06) ──superseded_by──▶ Rev C (2024-11)
                                                                           ↑ CURRENT

  Default: load only current revision entities
  Diff query: load Rev B + Rev C, compute delta
  Audit query: load full revision chain
```

**Pre-computation:**

Each subgraph cache entry contains:
```json
{
  "partition_key": "level-2:zone-B2",
  "entities": [
    {"id": "room:level-2:exam-4", "type": "room", "assertions_summary": "..."},
    {"id": "door:level-2:exam-4:3068", "type": "door", "assertions_summary": "..."}
  ],
  "internal_edges": [
    {"from": "room:level-2:exam-4", "to": "door:level-2:exam-4:3068", "type": "contains"}
  ],
  "boundary_edges": [
    {"from": "room:level-2:exam-4", "to": "hvac:level-2:vav-12", "type": "served_by", "target_partition": "level-2:mep"}
  ],
  "stats": {"entities": 47, "edges": 112, "tokens": 3200}
}
```

**Budget:** Max 50K tokens per query for Tier 3 data. Typically 2-5 partitions loaded.

### Tier 4: Full Assertion Store (Database Queries)

**Purpose:** On-demand retrieval of complete entity data when Tiers 1-3 indicate relevance.

**Query patterns:**

| Pattern | SQL | Latency Target |
|---------|-----|----------------|
| Single entity assertions | WHERE entity_id = ? | < 5ms |
| Entity conflicts | WHERE entity_id = ? AND resolution_status = 'open' | < 5ms |
| Batch entity fetch | WHERE entity_id IN (?, ?, ...) | < 50ms for 100 |
| BFS traversal (depth 2) | Recursive CTE or app-level BFS | < 200ms |
| Conflict scan (project) | GROUP BY entity_id, field HAVING COUNT(DISTINCT value) > 1 | < 2s |
| Missing submittals | Cross-join requirements × actuals | < 1s |

**Optimizations required at scale:**

```sql
-- Indices needed (not all present today)
CREATE INDEX idx_assertions_entity ON kg_assertions(entity_id, status);
CREATE INDEX idx_assertions_field ON kg_assertions(entity_id, field);
CREATE INDEX idx_entities_project_type ON kg_assertion_entities(project_id, entity_type);
CREATE INDEX idx_entities_spatial ON kg_assertion_entities(project_id, spatial_location);
CREATE INDEX idx_relationships_source ON kg_assertion_relationships(source_entity_id);
CREATE INDEX idx_relationships_target ON kg_assertion_relationships(target_entity_id);
CREATE INDEX idx_conflicts_entity ON kg_conflicts(entity_id, resolution_status);
```

**BFS with early termination:**
```python
def bounded_bfs(start_id, max_depth=3, max_nodes=500, stop_types=None):
    """BFS that respects depth limits and node budgets."""
    visited = {start_id}
    queue = deque([(start_id, 0)])
    results = []

    while queue and len(results) < max_nodes:
        current_id, depth = queue.popleft()
        if depth >= max_depth:
            continue

        neighbours = get_neighbours(current_id)
        for nid, rel_type in neighbours:
            if nid in visited:
                continue
            if stop_types and get_entity_type(nid) in stop_types:
                results.append((nid, depth + 1, "boundary"))
                continue  # Don't traverse past boundary types

            visited.add(nid)
            results.append((nid, depth + 1, rel_type))
            queue.append((nid, depth + 1))

    return results
```

**Result caching:**
- LRU cache for entity assertions (TTL: 5 minutes)
- Pre-computed conflict snapshots (refreshed on ingestion)
- Materialized views for common aggregations

---

## 5. Implementation Roadmap

### Phase 1: Instrumentation (Week 1-2)

**Goal:** Measure actual query patterns before optimizing.

**Tasks:**
- [ ] Add query logging to graph.py (query type, entities touched, latency, result size)
- [ ] Instrument store.py and knowledge.py DB calls with timing
- [ ] Log context window usage per agent invocation (tokens used vs. available)
- [ ] Create dashboard endpoint for query analytics
- [ ] Run 50 representative queries against Holabird dataset, profile

**Output:** Query pattern report showing:
- Distribution of query types (impact, conflict, compliance, context)
- Average entities touched per query
- P50/P95/P99 latency
- Token budget utilization

**Effort:** 2-3 days dev, runs in production passively.

### Phase 2: Summary Tier (Week 2-3)

**Goal:** Generate and maintain Tier 1 project summaries.

**Tasks:**
- [ ] Implement `ProjectSummary` class that aggregates post-extraction
- [ ] Auto-generate summary on extraction completion (hook into `post_extract.py`)
- [ ] Store summary as JSON in store.db (new `kg_project_summaries` table)
- [ ] Inject summary into every agent context window
- [ ] Add summary diff tracking (flag changes between extractions)

**Output:** Every project has a ~2K token summary always available.

**Effort:** 3-4 days dev. Immediate value — agents get project awareness for free.

### Phase 3: Subgraph Cache (Week 3-6)

**Goal:** Implement Tier 3 spatial and temporal partitioning.

**Tasks:**
- [ ] Design partition key schema (level × grid_zone × discipline)
- [ ] Implement `SubgraphCache` that pre-computes partition contents post-ingestion
- [ ] Build boundary edge detection (cross-partition relationships)
- [ ] Add partition selection to query router (Tier 1 summary → relevant partitions)
- [ ] Implement cache invalidation on document revision
- [ ] Add SQLite indices for scaled query patterns
- [ ] Benchmark: 10K entity project, measure query latency before/after

**Output:** Queries against specific building zones load only relevant subgraphs.

**Effort:** 2-3 weeks dev. Requires careful schema design.

### Phase 4: Adaptive Retrieval (Week 6-10)

**Goal:** Smart tier selection based on query classification.

**Tasks:**
- [ ] Build query classifier (rule-based first, ML later)
  - Existence queries → Tier 1 + 2
  - Spatial queries → Tier 1 + 3 (spatial partition)
  - Conflict queries → Tier 1 + 2 + 4 (full scan)
  - Impact queries → Tier 1 + 3 (discipline partition) + 4
  - Compliance queries → Tier 1 + 3 + 4 (code-specific)
- [ ] Implement context budget manager (allocate tokens across tiers)
- [ ] Add iterative deepening: start with Tier 1-2, escalate to 3-4 if insufficient
- [ ] Build query result cache with intelligent invalidation
- [ ] A/B test: adaptive retrieval vs. current full-context approach

**Output:** System automatically selects minimal context needed per query.

**Effort:** 3-4 weeks dev. Requires query classification training data from Phase 1.

---

## 6. Cost-Benefit Analysis

### Per-Tier Metrics (at $50M building scale: 555K entities)

| Metric | Tier 1: Summary | Tier 2: Catalog | Tier 3: Subgraph | Tier 4: Full Store |
|--------|----------------|-----------------|-------------------|-------------------|
| **Storage** | 2 KB/project | 22 MB (catalog) + 665 KB (bloom) | 180 MB (all partitions) | 850 MB (SQLite) |
| **Retrieval Latency** | 0 ms (in-context) | 0 ms (in-context) / 5ms (partition bloom) | 20-100 ms (load partition) | 5-2000 ms (per query) |
| **Context Cost** | 2K tokens (fixed) | 15-20K tokens (fixed) | 5-50K tokens (per query) | 1-20K tokens (per entity batch) |
| **Query Coverage** | Routing + overview (100% of queries use this) | Existence + counting (~30% of queries answered here) | Spatial + relationship (~50% of remaining) | Everything else (~20% need full store) |
| **Build Cost** | Trivial (aggregation) | Medium (index + bloom) | High (partitioning + boundaries) | Exists (current system) |

### Token Budget Model (200K context window)

```
┌─────────────────────────────────────────────────────────────┐
│ Context Window Budget Allocation (200K tokens)              │
│                                                             │
│ System prompt + tools:          15K tokens  (7.5%)          │
│ Tier 1 (Project Summary):       5K tokens  (2.5%)   FIXED  │
│ Tier 2 (Entity Catalog):       20K tokens  (10.0%)  FIXED  │
│ Tier 3 (Subgraph Cache):       50K tokens  (25.0%)  LOADED │
│ Tier 4 (Retrieved Assertions): 30K tokens  (15.0%)  LOADED │
│ Conversation history:          40K tokens  (20.0%)         │
│ Model reasoning headroom:      40K tokens  (20.0%)         │
│                                                             │
│ TOTAL GRAPH DATA IN CONTEXT:  105K tokens                   │
│ Effective coverage:            ~35K entities per query       │
│                                (6.3% of 555K — targeted)    │
└─────────────────────────────────────────────────────────────┘
```

**Compared to naive approach:**
- Naive: 0.10% of graph in context, random selection → low relevance
- Hierarchical: 6.3% of graph in context, targeted selection → high relevance
- **63x improvement in effective coverage per token spent**

### Query Answering Coverage by Tier Combination

| Query Type | Tier 1 Only | + Tier 2 | + Tier 3 | + Tier 4 |
|------------|-------------|----------|----------|----------|
| "What type of building?" | 100% | - | - | - |
| "How many doors on Level 2?" | 40% | 95% | - | - |
| "Does entity X exist?" | 10% | 99% (bloom) | - | - |
| "Door spec at Room 101" | 0% | 10% | 70% | 100% |
| "Conflicts in fire ratings" | 0% | 0% | 40% | 100% |
| "Impact of beam change at B-4" | 0% | 0% | 80% | 100% |
| "Full IBC egress compliance" | 0% | 0% | 30% | 100% |

---

## 7. Differentiation Moat

### Why This Architecture is Defensible

#### 1. Graph Completeness Guarantees

Standard RAG: "We found 47 relevant documents about fire ratings."
Lexios: "There are exactly 312 fire-rated assemblies in this project. 298 have matching test reports. 14 are missing UL listings. Here are the 14, with the spec section requiring them, the drawing showing them, and the submittal log gap."

**The difference:** RAG cannot prove a negative. Lexios can prove "no conflicts exist" because the graph is complete and the check is exhaustive. This is a regulatory-grade capability.

#### 2. Provenance Chain Integrity

Every assertion in the Lexios graph carries:
```
assertion → source_doc_id → document → filename, revision, revision_date
assertion → source_page → exact page number
assertion → confidence → extraction confidence score
assertion → extraction_model → which model extracted it
assertion → extracted_at → timestamp
```

When a general contractor asks "Where does it say the door is 3'-0"?" Lexios answers: "Drawing A-201, Rev C, dated 2024-01-15, Door Schedule, Row 12, Column D. Extracted by Claude Sonnet at 0.97 confidence on 2024-02-01."

No general-purpose AI can provide this. The provenance chain is structural, not generated.

#### 3. Cross-Project Learning (knowledge.db)

The knowledge database accumulates intelligence across all projects:

```
Current state (6 projects ingested):
  5,044 elements → 571 relationships → 102 patterns → 33 dimension norms

At 100 projects:
  ~300K elements → ~35K relationships → ~2K patterns → ~500 dimension norms

  Patterns like:
  "Medical buildings: exam rooms average 120 sqft (σ=15),
   always adjacent to nurse station (94% of projects),
   require 3 electrical outlets (87% of projects)"
```

This is a flywheel: more projects → better norms → better anomaly detection → more value → more projects. A competitor starting today has zero project history.

#### 4. Deterministic Compliance

```
RAG-based compliance check:
  "Based on similar documents, this building likely complies
   with IBC egress requirements."
  Confidence: ~0.85
  Liability: Undefined

Lexios compliance check:
  IBC 1006.3.4(1) → Occupancy B + Sprinklered → Max 300 ft
  Measured: Room 401 to Exit 2 = 287 ft → PASS
  Measured: Room 318 to Exit 1 = 312 ft → FAIL (12 ft over)
  Source: Drawing A-103, Level 3 Floor Plan, Rev B
  Confidence: 1.00 (deterministic calculation)
  Liability: Traceable to source document
```

Regulatory compliance is binary. Lexios provides binary answers with traceable provenance. LLMs provide probabilistic answers with hallucination risk.

### Why Claude Can't Eat Lexios's Lunch Even With 10M Context Windows

**Argument 1: Size doesn't solve structure.**
A 10M context window can hold ~50K entities with assertions. A $50M building has 555K+. Even at 10M tokens, you're looking at 9% coverage. More critically, dumping 10M tokens of unstructured assertions into a context window doesn't create a graph — it creates a haystack. The LLM still can't do deterministic BFS, guaranteed-complete conflict detection, or spatial intersection calculations.

**Argument 2: Cost doesn't scale.**
Processing 10M tokens per query at current pricing ($15/M input for Claude Sonnet) = $150 per query. A GC asks 50 questions per day = $7,500/day. Lexios's approach: 105K tokens per query = $1.58/query = $79/day. That's a 95x cost advantage, and it grows with project size.

**Argument 3: The provenance chain can't be generated.**
An LLM reading 10M tokens of construction documents cannot reliably trace "this dimension came from page 47 of drawing A-201 Rev C." It can guess. Lexios doesn't guess — it looked up the assertion record. For a platform whose value proposition is "every answer has a receipt," this isn't a nice-to-have. It's the product.

**Argument 4: Cross-project intelligence is a cold-start problem.**
Even if Claude had infinite context, it processes one conversation at a time. It cannot accumulate "exam rooms in medical buildings average 120 sqft" across 100 projects unless someone builds the knowledge graph to store that learning. That someone is Lexios.

**Argument 5: Regulatory liability requires auditability.**
When a building fails inspection because the AI said "probably compliant," who is liable? Construction professionals need audit trails, not confidence scores. The hierarchical retrieval architecture produces deterministic, traceable, auditable answers. The LLM is a reasoning engine that reads from the graph — not a replacement for it.

---

*The graph is the moat. The LLM is the interface. Build the graph first.*

## Related

- [[gitnexus-inspired-features|GitNexus-Inspired Features for Lexios]]
- [[LEXIOS_WHATSAPP_BETA|Lexios WhatsApp Agent — Beta Deployment Architecture]]
- [[2026-03-17|Journal: 2026-03-17]]
- [[lexios-agent-accessibility-plan|Lexios Agent Accessibility - Future-Proofing Plan]]
- [[LEXIOS_IMPLEMENTATION_ROADMAP|Lexios WhatsApp Beta — Implementation Roadmap]]
- [[2026-02-28|Journal: 2026-02-28]]
