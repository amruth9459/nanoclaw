# Lexios — Daily Build Log

*Living document — auto-generated from git history*
*Last generated: 2026-03-04*

**53 total commits** (11 meaningful) | 2026-02-26 to 2026-03-03

---

## 2026-03-03

### What Changed
- Package Lexios as standalone Python CLI with deterministic pipelines
- Add efficiency modules: extraction cache, embeddings, IFC corpus tools
- Remove update-docs.py (moved to NanoClaw scripts/)
- Fix IFC corpus URLs, schema compatibility, and scoring bugs
- (+11 auto-backup commits)

### Files (112 changed)
- ...-wall-with-opening-and-window.ground-truth.json
- .../Building-Architecture.ground-truth.json
- .../Building-Architecture.ifc
- .../Building-Structural.ifc
- .../Duplex_A_20110907.ground-truth.json
- .../bsmart/tessellation-with-individual-colors.ifc
- .../column-straight-rectangle-tessellation.ifc
- .../corpus/ifc-duplex/ifc-duplex.ground-truth.json
- .../corpus/ifc-infra-plumbing/Infra-Plumbing.ifc
- .../corpus/ifc-structural/Building-Structural.ifc
- .../ifc-building-arch.ground-truth.json
- .../ifc-building-arch/Building-Architecture.ifc
- .../ifc-building-architecture.ground-truth.json
- .../ifc-building-hvac.ground-truth.json
- .../ifc-building-structural.ground-truth.json
- .../ifc-duplex-a-20110907.ground-truth.json
- .../ifc-duplex-a-20110907/Duplex_A_20110907.ifc
- .../ifc-infra-bridge.ground-truth.json
- .../ifc-infra-plumbing.ground-truth.json
- .../ifc-infra-road.ground-truth.json
- ... and 92 more

### Stats
- 140382 insertions, 592 deletions

## 2026-03-02

### What Changed
- Add multi-model corpus run data (Claude, GPT-4.1, llava:34b)
- Switch Gemini from 3.1-pro-preview (503 overloaded) to 2.5-pro (stable)
- (+16 auto-backup commits)

### Files (34 changed)
- .../corpus/sample-blueprint/sample-blueprint.pdf
- .../sample-blueprint.ground-truth.json
- ...awings-adn-5_bnim_sent.llama3.2-vision-11b.json
- ...cuments-drawings-adn-5_bnim_sent.llava-34b.json
- ...ents-drawings-adn-5_bnim_sent.ground-truth.json
- ...ndocuments-drawings-adn-5_bnim_sent.claude.json
- ...ndocuments-drawings-adn-5_bnim_sent.gemini.json
- ...ndocuments-drawings-adn-5_bnim_sent.gpt4.1.json
- ...structionDocuments-Drawings-ADN-5_BNIM_sent.pdf
- docs/LEXIOS_CHANGELOG.md
- docs/LEXIOS_PLATFORM.md
- docs/cad-building-drawings-training-data.md
- lexios/compare.py
- lexios/corpus-builder.py
- lexios/eval.db-shm
- lexios/eval.db-wal
- lexios/extract.py
- lexios/ifc.py
- lexios/learnings.json
- lexios/pdf-sources.json
- ... and 14 more

### Stats
- 5011 insertions, 902 deletions

## 2026-03-01

### What Changed
- Add per-building group model, query classifier, and DXF extraction
- (+15 auto-backup commits)

### Files (104 changed)
- .../components/dashboard/ThreatBreakdownPie.tsx
- .../database/migrations/001_whatsapp_support.sql
- .../database/migrations/002_vector_embeddings.sql
- .../habitat-floor-plans.ground-truth.json
- .../maricopa-sample.ground-truth.json
- .../migrations/003_judge_review_tracking.sql
- .../src/components/dashboard/TopBuildingsTable.tsx
- backend/.env.example
- backend/api/decorators.py
- backend/api/v2/buildings.py
- backend/api/v2/ceo_dashboard.py
- backend/api/v2/judge_review.py
- backend/api/v2/quality.py
- backend/api/v2/security_admin.py
- backend/api/v2/uploads.py
- backend/api/v2/webhooks.py
- backend/database/quality_models.py
- backend/database/security_models.py
- backend/database/session.py
- backend/database/tests/test_whatsapp_models.py
- ... and 84 more

### Stats
- 154708 insertions, 282 deletions

## 2026-02-27

### What Changed
- Add NanoClaw integration: 101 extraction types, eval framework, training pipeline
- Restructure to mirror NanoClaw paths, add sync script
- Decouple Lexios as standalone platform

### Files (26 changed)
- .../README.md => README-nanoclaw.md
- .../container-skills/lexios-prep.sh
- .../container-skills/lexios/SKILL.md
- .../container-skills/lexios/TRAIN.md
- .../container-skills/lexios/types.json
- .../lexios => integrations/nanoclaw}/SKILL.md
- .../lexios => integrations/nanoclaw}/TRAIN.md
- .../permit-sonoma-bpc022.ground-truth.json
- .../scripts => scripts}/lexios-eval.py
- .../scripts => scripts}/test-lexios.sh
- .../skills}/lexios-prep.sh
- .../skills}/lexios/SKILL.md
- .../skills}/lexios/TRAIN.md
- .../skills}/lexios/types.json
- README-nanoclaw.md
- README.md
- container/skills/lexios-prep.sh => lexios/prep.sh
- integrations/nanoclaw/README.md
- integrations/nanoclaw/sync.sh
- nanoclaw-integration/README.md
- ... and 6 more

### Stats
- 3624 insertions, 177 deletions

## 2026-02-26

### What Changed
- Lexios handover — start with NANOCLAW_HANDOVER.md

### Files (599 changed)
- ... A to Z Nutrition Centre project knowledge.json
- ... Investment Memorandum _ November 2025 v2.0.pdf
- ... Investment Memorandum _ November 2025 v2.1.pdf
- ... merging deterministic and spatial systems.json
- ... seed valuation and technical architecture.json
- ... to Z Nutrition Centre analysis validation.json
- ... white paper validates Lexios architecture.json
- .../44f04cfc-7865-49dc-adfe-e8f4cbee34ca.pptx
- .../6bb21b07-aee8-4d7c-9f56-debc6d18b42f.pptx
- .../A to Z Nutrition Centre Full Analysis.txt
- .../AI startup product-market fit framework.json
- .../Agent-in-the-Loop (AITL) Design Guide
- .../Architecture_Version_Control_Validation.md
- .../Construction AI - General Pitch Deck.tsx
- .../Construction Takeoff App Development.json
- .../Construction Takeoff App for Drawings.json
- .../Construction Tech Investment Strategy.json
- .../Construction Tech Market Size Analysis.json
- .../Construction-AI-Platform/README.md
- .../Continuing Lexios Q&A document expansion.json
- ... and 579 more

### Stats
- 440896 insertions, 0 deletions
