#!/bin/bash
# Setup Obsidian Brain Vault at ~/Brain
# Creates vault structure, symlinks to NanoClaw knowledge, and minimal Obsidian config.
# Idempotent: safe to re-run.
set -euo pipefail

BRAIN="${HOME}/Brain"
NANOCLAW="${HOME}/nanoclaw"
LEXIOS="${HOME}/Lexios"

echo "Setting up Obsidian Brain Vault at ${BRAIN}..."

# ── Create directories ──────────────────────────────────────────────────
for dir in Learnings Projects Daily Inbox \
           Architecture Security Conversations Data Skills Strategy \
           Groups Notes Products \
           Lexios Lexios/Corpus Lexios/Integration Lexios/MEP Lexios/Docs; do
  mkdir -p "${BRAIN}/${dir}"
done
echo "  Created directory structure"

# ── Symlink helper ───────────────────────────────────────────────────────
create_link() {
  local name="$1" target="$2"
  local link="${BRAIN}/${name}"
  # Ensure parent directory exists
  mkdir -p "$(dirname "$link")"
  if [ -L "$link" ]; then
    return 0  # Already exists
  elif [ -e "$link" ]; then
    echo "  WARNING: ${link} exists but is not a symlink — skipping"
    return 0
  elif [ ! -e "$target" ]; then
    return 0  # Target doesn't exist — skip silently
  else
    ln -s "$target" "$link"
  fi
}

# ── Core knowledge symlinks ──────────────────────────────────────────────
echo "  Linking core knowledge..."
create_link "Zettelkasten" "${NANOCLAW}/groups/main/knowledge/zettelkasten"
create_link "Indexes"      "${NANOCLAW}/groups/main/knowledge/indexes"
create_link "Handoffs"     "${NANOCLAW}/groups/main/handoffs"

# ── Live state files ─────────────────────────────────────────────────────
echo "  Linking live state..."
create_link "MEMORY.md"      "${NANOCLAW}/groups/main/MEMORY.md"
create_link "KANBAN.md"      "${NANOCLAW}/groups/main/KANBAN.md"
create_link "DEVLOG.md"      "${NANOCLAW}/docs/DEVLOG.md"
create_link "EXPERIMENTS.md" "${NANOCLAW}/docs/EXPERIMENTS.md"
create_link "CHANGELOG.md"   "${NANOCLAW}/docs/NANOCLAW_CHANGELOG.md"
create_link "BUILD_LOG.md"   "${NANOCLAW}/docs/NANOCLAW_BUILD_LOG.md"
create_link "Journal"        "${NANOCLAW}/docs/journal"

# ── Architecture ─────────────────────────────────────────────────────────
echo "  Linking architecture..."
create_link "Architecture/SPEC.md"          "${NANOCLAW}/docs/SPEC.md"
create_link "Architecture/REQUIREMENTS.md"  "${NANOCLAW}/docs/REQUIREMENTS.md"
create_link "Architecture/PLATFORM.md"      "${NANOCLAW}/docs/NANOCLAW_PLATFORM.md"
create_link "Architecture/SDK_DEEP_DIVE.md" "${NANOCLAW}/docs/SDK_DEEP_DIVE.md"
create_link "Architecture/a2a-evaluation.md" "${NANOCLAW}/docs/a2a-evaluation.md"
create_link "Architecture/nanoclaw-architecture-final.md" "${NANOCLAW}/docs/nanoclaw-architecture-final.md"
create_link "Architecture/nanorepo-architecture.md" "${NANOCLAW}/docs/nanorepo-architecture.md"
create_link "Architecture/APPLE-CONTAINER-NETWORKING.md" "${NANOCLAW}/docs/APPLE-CONTAINER-NETWORKING.md"
create_link "Architecture/FINE_TUNING_GUIDE.md" "${NANOCLAW}/docs/FINE_TUNING_GUIDE.md"
create_link "Architecture/firewall-config"  "${NANOCLAW}/groups/main/firewall-config"
create_link "Architecture/ggml"             "${NANOCLAW}/groups/main/ggml"
create_link "Architecture/orchestration"    "${NANOCLAW}/groups/main/nanoclaw-orchestration"
create_link "Architecture/strategy"         "${NANOCLAW}/groups/main/strategy"

# ── Security ─────────────────────────────────────────────────────────────
echo "  Linking security..."
create_link "Security/SECURITY.md"          "${NANOCLAW}/docs/SECURITY.md"
create_link "Security/HARDENING_CHECKLIST.md" "${NANOCLAW}/docs/NANOCLAW_HARDENING_CHECKLIST.md"
create_link "Security/R2_BACKUP_SECURITY.md" "${NANOCLAW}/docs/R2_BACKUP_SECURITY.md"
create_link "Security/DEBUG_CHECKLIST.md"   "${NANOCLAW}/docs/DEBUG_CHECKLIST.md"
create_link "Security/security-tasks"       "${NANOCLAW}/groups/main/security-tasks"

# ── Conversations ────────────────────────────────────────────────────────
echo "  Linking conversations..."
create_link "Conversations/main"        "${NANOCLAW}/groups/main/conversations"
create_link "Conversations/claw-lexios" "${NANOCLAW}/groups/claw-lexios/conversations"

# ── Data ─────────────────────────────────────────────────────────────────
echo "  Linking data..."
create_link "Data/contingency.md"               "${NANOCLAW}/data/contingency.md"
create_link "Data/lexios-persona"               "${NANOCLAW}/data/lexios-persona"
create_link "Data/memory_consolidations.jsonl"  "${NANOCLAW}/groups/main/memory_consolidations.jsonl"
create_link "Data/preferences.json"             "${NANOCLAW}/groups/main/knowledge/preferences.json"

# ── Skills ───────────────────────────────────────────────────────────────
echo "  Linking skills..."
create_link "Skills/agent-browser"    "${NANOCLAW}/container/skills/agent-browser"
create_link "Skills/security-review"  "${NANOCLAW}/container/skills/security-review"
create_link "Skills/self-audit"       "${NANOCLAW}/container/skills/self-audit"

# ── Groups ───────────────────────────────────────────────────────────────
echo "  Linking groups..."
for group_dir in "${NANOCLAW}"/groups/*/; do
  group_name=$(basename "$group_dir")
  [ "$group_name" = "main" ] && continue  # main is broken out into sections
  create_link "Groups/${group_name}" "$group_dir"
done

# ── Products ─────────────────────────────────────────────────────────────
echo "  Linking products..."
create_link "Products/agency-agents"          "${NANOCLAW}/groups/main/agency-agents"
create_link "Products/android-analysis"       "${NANOCLAW}/groups/main/android-analysis"
create_link "Products/bounty-hunting"         "${NANOCLAW}/groups/main/bounty-hunting"
create_link "Products/claw-empire"            "${NANOCLAW}/groups/main/claw-empire"
create_link "Products/competitive-intel"      "${NANOCLAW}/groups/main/competitive-intel"
create_link "Products/contractwatch"          "${NANOCLAW}/groups/main/contractwatch"
create_link "Products/grant-opportunity-radar" "${NANOCLAW}/groups/main/grant-opportunity-radar"
create_link "Products/grant-radar-mvp"        "${NANOCLAW}/groups/main/grant-radar-mvp"
create_link "Products/life"                   "${NANOCLAW}/groups/main/life"
create_link "Products/omi-docs"               "${NANOCLAW}/groups/main/omi-docs"
create_link "Products/omi-self-hosted"        "${NANOCLAW}/groups/main/omi-self-hosted-architecture"
create_link "Products/osha-mvp"               "${NANOCLAW}/groups/main/osha-mvp"
create_link "Products/osha-predictor"         "${NANOCLAW}/groups/main/osha-predictor"
create_link "Products/osha-product"           "${NANOCLAW}/groups/main/osha-product"
create_link "Products/osha-violation-predictor" "${NANOCLAW}/groups/main/osha-violation-predictor"
create_link "Products/products"               "${NANOCLAW}/groups/main/products"
create_link "Products/regulatoryedge"         "${NANOCLAW}/groups/main/regulatoryedge"
create_link "Products/vantage-intelligence"   "${NANOCLAW}/groups/main/vantage-intelligence"

# ── Strategy ─────────────────────────────────────────────────────────────
echo "  Linking strategy..."
create_link "Strategy/BETA_LAUNCH_CHECKLIST.md" "${NANOCLAW}/groups/main/BETA_LAUNCH_CHECKLIST.md"
create_link "Strategy/GRANT_RADAR_LAUNCH_PLAN.md" "${NANOCLAW}/groups/main/GRANT_RADAR_LAUNCH_PLAN.md"
create_link "Strategy/o1-visa-strategy.md"     "${NANOCLAW}/groups/main/o1-visa-strategy.md"
create_link "Strategy/UNIVERSAL_ROUTER.md"     "${NANOCLAW}/groups/main/UNIVERSAL_ROUTER.md"

# ── Lexios ───────────────────────────────────────────────────────────────
echo "  Linking Lexios..."
# Core Lexios files
create_link "Lexios/README.md"    "${LEXIOS}/README.md"
create_link "Lexios/DESIGN.md"    "${LEXIOS}/DESIGN.md"
create_link "Lexios/ROADMAP.md"   "${LEXIOS}/ROADMAP.md"
create_link "Lexios/CHANGELOG.md" "${LEXIOS}/docs/LEXIOS_CHANGELOG.md"
create_link "Lexios/DEVLOG.md"    "${LEXIOS}/docs/DEVLOG.md"
create_link "Lexios/LEARNINGS.md" "${LEXIOS}/docs/LEARNINGS.md"
create_link "Lexios/MEMORY.md"    "${NANOCLAW}/groups/claw-lexios/MEMORY.md"

# Lexios docs
create_link "Lexios/Docs/ARCHITECTURE.md" "${LEXIOS}/docs/ARCHITECTURE.md"
create_link "Lexios/Docs/DEPLOYMENT.md"   "${LEXIOS}/docs/DEPLOYMENT.md"
create_link "Lexios/Docs/PLATFORM.md"     "${LEXIOS}/docs/LEXIOS_PLATFORM.md"
create_link "Lexios/Docs/PRICING.md"      "${LEXIOS}/docs/PRICING.md"
create_link "Lexios/Docs/SETUP_GUIDE.md"  "${LEXIOS}/docs/LEXIOS_SETUP_GUIDE.md"
create_link "Lexios/Docs/USER_FLOWS.md"   "${LEXIOS}/docs/USER_FLOWS.md"

# Lexios subsections
create_link "Lexios/Research"      "${NANOCLAW}/groups/claw-lexios/raw"
create_link "Lexios/Research-main" "${NANOCLAW}/groups/main/lexios-research"
create_link "Lexios/Conversations" "${NANOCLAW}/groups/claw-lexios/conversations"
create_link "Lexios/Marketing"     "${NANOCLAW}/data/lexios-staged/marketing"
create_link "Lexios/Sales"         "${NANOCLAW}/data/lexios-staged/sales"
create_link "Lexios/Platform"      "${NANOCLAW}/data/lexios-staged/docs"

# Lexios group-based dirs
create_link "Lexios/Access"        "${NANOCLAW}/groups/main/lexios-access"
create_link "Lexios/Acquisition"   "${NANOCLAW}/groups/main/lexios-acquisition"
create_link "Lexios/Agent-API"     "${NANOCLAW}/groups/main/lexios-agent-api"
create_link "Lexios/Autoresearch"  "${NANOCLAW}/groups/main/lexios-autoresearch"
create_link "Lexios/Launch"        "${NANOCLAW}/groups/main/lexios-launch"
create_link "Lexios/Query"         "${NANOCLAW}/groups/main/lexios-query"
create_link "Lexios/Results"       "${NANOCLAW}/groups/main/lexios-results"
create_link "Lexios/Router"        "${NANOCLAW}/groups/main/lexios-router"
create_link "Lexios/Sheets"        "${NANOCLAW}/groups/main/lexios-sheets"
create_link "Lexios/Testing"       "${NANOCLAW}/groups/main/lexios-testing"
create_link "Lexios/Training"      "${NANOCLAW}/groups/main/lexios-training"
create_link "Lexios/WhatsApp"      "${NANOCLAW}/groups/main/lexios-whatsapp"
create_link "Lexios/Work"          "${NANOCLAW}/groups/main/lexios-work"

# Lexios integration (claw-lexios-2)
create_link "Lexios/Integration/baseline_eval_report.md" "${NANOCLAW}/groups/claw-lexios-2/baseline_eval_report.md"
create_link "Lexios/Integration/DEPLOYMENT-INSTRUCTIONS.md" "${NANOCLAW}/groups/claw-lexios-2/DEPLOYMENT-INSTRUCTIONS.md"
create_link "Lexios/Integration/integration_plan.md" "${NANOCLAW}/groups/claw-lexios-2/integration_plan.md"
create_link "Lexios/Integration/ROUTER_ACTIVATION_PLAN.md" "${NANOCLAW}/groups/claw-lexios-2/ROUTER_ACTIVATION_PLAN.md"
create_link "Lexios/Integration/TASK-COMPLETION-SUMMARY.md" "${NANOCLAW}/groups/claw-lexios-2/TASK-COMPLETION-SUMMARY.md"

# Lexios corpus (claw-lexios-3)
create_link "Lexios/Corpus/CORPUS-EXPANSION-PLAN.md" "${NANOCLAW}/groups/claw-lexios-3/CORPUS-EXPANSION-PLAN.md"
create_link "Lexios/Corpus/corpus-sources.md" "${NANOCLAW}/groups/claw-lexios-3/corpus-sources.md"
create_link "Lexios/Corpus/E2E_TEST_README.md" "${NANOCLAW}/groups/claw-lexios-3/E2E_TEST_README.md"

# Lexios MEP (claw-lexios-4)
create_link "Lexios/MEP/mep-corpus-expansion-plan.md" "${NANOCLAW}/groups/claw-lexios-4/mep-corpus-expansion-plan.md"
create_link "Lexios/MEP/SETUP_INSTRUCTIONS.md" "${NANOCLAW}/groups/claw-lexios-4/SETUP_INSTRUCTIONS.md"
create_link "Lexios/MEP/VERIFICATION_REPORT.md" "${NANOCLAW}/groups/claw-lexios-4/VERIFICATION_REPORT.md"

# Lexios misc
create_link "Lexios/deferred-items-tracker.md" "${NANOCLAW}/groups/claw-lexios/deferred-items-tracker.md"
create_link "Lexios/knowledge-base-architecture.md" "${NANOCLAW}/groups/claw-lexios/knowledge-base-architecture.md"
create_link "Lexios/phase-0-execution-log.md" "${NANOCLAW}/groups/claw-lexios/phase-0-execution-log.md"

# ── Notes (groups/main root-level markdown files) ────────────────────────
echo "  Linking notes from groups/main..."
for mdfile in "${NANOCLAW}"/groups/main/*.md; do
  [ ! -f "$mdfile" ] && continue
  name=$(basename "$mdfile")
  # Skip files already linked elsewhere
  case "$name" in
    CLAUDE.md|MEMORY.md|KANBAN.md|BETA_LAUNCH_CHECKLIST.md|GRANT_RADAR_LAUNCH_PLAN.md|o1-visa-strategy.md|UNIVERSAL_ROUTER.md)
      continue ;;
  esac
  create_link "Notes/${name}" "$mdfile"
done

# Notes: subdirectories in groups/main that aren't already linked
for subdir in "${NANOCLAW}"/groups/main/*/; do
  dirname=$(basename "$subdir")
  # Skip dirs already linked above
  case "$dirname" in
    knowledge|handoffs|conversations|firewall-config|ggml|nanoclaw-orchestration|strategy|\
    security-tasks|agency-agents|android-analysis|bounty-hunting|claw-empire|competitive-intel|\
    contractwatch|grant-opportunity-radar|grant-radar-mvp|life|omi-docs|omi-self-hosted-architecture|\
    osha-mvp|osha-predictor|osha-product|osha-violation-predictor|products|regulatoryedge|\
    vantage-intelligence|lexios-*)
      continue ;;
  esac
  create_link "Notes/${dirname}" "$subdir"
done

# ── Obsidian config ──────────────────────────────────────────────────────
echo "  Configuring Obsidian..."
OBSIDIAN_DIR="${BRAIN}/.obsidian"
mkdir -p "$OBSIDIAN_DIR"

# Daily notes plugin config
DAILY_NOTES="${OBSIDIAN_DIR}/daily-notes.json"
if [ ! -f "$DAILY_NOTES" ]; then
  cat > "$DAILY_NOTES" << 'EOF'
{
  "folder": "Daily",
  "format": "YYYY-MM-DD",
  "template": ""
}
EOF
fi

# Enable core plugins
CORE_PLUGINS="${OBSIDIAN_DIR}/core-plugins-migration.json"
if [ ! -f "$CORE_PLUGINS" ]; then
  cat > "$CORE_PLUGINS" << 'EOF'
{
  "daily-notes": true,
  "graph": true,
  "backlink": true,
  "tag-pane": true,
  "page-preview": true
}
EOF
fi

# ── Map of Content ───────────────────────────────────────────────────────
# Don't overwrite — _Index.md is manually maintained
if [ ! -f "${BRAIN}/_Index.md" ]; then
  cat > "${BRAIN}/_Index.md" << 'EOF'
---
tags: [moc, index]
---

# Brain Vault

Central knowledge hub. Edits here propagate back to source via symlinks.

> Open **Brain Map.canvas** for the visual overview.

## Knowledge
- [[Zettelkasten/]] — Atomic notes with wikilinks
- [[Indexes/]] — Topic indexes
- [[Learnings/]] — Individual learning notes

## Live State
- [[MEMORY]] — Shared memory (NanoClaw ↔ Claude Code ↔ Claw)
- [[KANBAN]] — Task board
- [[DEVLOG]] — Session logs
- [[CHANGELOG]] — Milestone summaries

## Session Artifacts
- [[Handoffs/]] — Session handoff notes
- [[Daily/]] — Daily session summaries
- [[Journal/]] — Auto-generated daily journals
- [[Projects/]] — Per-project status notes

## Capture
- [[Inbox/]] — Manual captures and quick notes
EOF
fi

# ── Summary ──────────────────────────────────────────────────────────────
LINK_COUNT=$(find "$BRAIN" -type l 2>/dev/null | wc -l | tr -d ' ')
FILE_COUNT=$(find "$BRAIN" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
echo ""
echo "Brain Vault ready at ${BRAIN}/"
echo "  ${LINK_COUNT} symlinks, ${FILE_COUNT} markdown files"
echo "Open in Obsidian: File → Open Vault → ${BRAIN}"
