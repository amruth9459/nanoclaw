#!/bin/bash
# Setup Obsidian Brain Vault at ~/Brain
# Creates vault structure, symlinks to NanoClaw knowledge, and minimal Obsidian config.
# Idempotent: safe to re-run.
set -euo pipefail

BRAIN="${HOME}/Brain"
NANOCLAW="${HOME}/nanoclaw"

echo "Setting up Obsidian Brain Vault at ${BRAIN}..."

# ── Create directories ──────────────────────────────────────────────────
for dir in Learnings Projects Daily Inbox; do
  mkdir -p "${BRAIN}/${dir}"
done
echo "  Created directories: Learnings/, Projects/, Daily/, Inbox/"

# ── Create symlinks ─────────────────────────────────────────────────────
create_link() {
  local name="$1" target="$2"
  local link="${BRAIN}/${name}"
  if [ -L "$link" ]; then
    echo "  Symlink exists: ${name} → $(readlink "$link")"
  elif [ -e "$link" ]; then
    echo "  WARNING: ${link} exists but is not a symlink — skipping"
  elif [ ! -e "$target" ]; then
    echo "  WARNING: target ${target} does not exist — skipping ${name}"
  else
    ln -s "$target" "$link"
    echo "  Linked: ${name} → ${target}"
  fi
}

create_link "Zettelkasten" "${NANOCLAW}/groups/main/knowledge/zettelkasten"
create_link "Indexes"      "${NANOCLAW}/groups/main/knowledge/indexes"
create_link "Handoffs"     "${NANOCLAW}/groups/main/handoffs"
create_link "MEMORY.md"    "${NANOCLAW}/groups/main/MEMORY.md"
create_link "KANBAN.md"    "${NANOCLAW}/groups/main/KANBAN.md"
create_link "DEVLOG.md"    "${NANOCLAW}/docs/DEVLOG.md"
create_link "EXPERIMENTS.md" "${NANOCLAW}/docs/EXPERIMENTS.md"

# ── Obsidian config ─────────────────────────────────────────────────────
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
  echo "  Created .obsidian/daily-notes.json"
fi

# Enable core plugins (daily-notes)
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
  echo "  Created .obsidian/core-plugins-migration.json"
fi

# ── Map of Content ──────────────────────────────────────────────────────
INDEX="${BRAIN}/_Index.md"
if [ ! -f "$INDEX" ]; then
  cat > "$INDEX" << 'EOF'
---
tags: [moc, index]
---

# Brain Vault

Central knowledge hub. NanoClaw knowledge is symlinked — edits here propagate back.

## Knowledge Base
- [[Zettelkasten/]] — Atomic notes with wikilinks
- [[Indexes/]] — Topic indexes linking zettelkasten notes

## State
- [[MEMORY]] — Shared memory (NanoClaw ↔ Claude Code)
- [[KANBAN]] — Task board (auto-generated from DB)
- [[DEVLOG]] — Auto-generated session logs
- [[EXPERIMENTS]] — Experiment log

## Session Artifacts
- [[Handoffs/]] — Session handoff notes
- [[Daily/]] — Daily session summaries
- [[Learnings/]] — Individual learning notes
- [[Projects/]] — Per-project status notes

## Capture
- [[Inbox/]] — Manual captures and quick notes
EOF
  echo "  Created _Index.md (Map of Content)"
fi

echo ""
echo "Brain Vault ready at ${BRAIN}/"
echo "Open in Obsidian: File → Open Vault → ${BRAIN}"
