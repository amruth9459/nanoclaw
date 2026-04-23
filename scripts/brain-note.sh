#!/bin/bash
# Create an Obsidian-formatted note in ~/Brain/
# Usage: brain-note.sh <type> <topic> <content> [domain] [tags]
#   type: learning | project | daily
#   domain: nanoclaw (default), lexios, etc.
#   tags: comma-separated extra tags
#
# No-op if ~/Brain/ doesn't exist.
set -euo pipefail

BRAIN="${BRAIN_VAULT_PATH:-${HOME}/Brain}"
[ ! -d "$BRAIN" ] && exit 0

TYPE="${1:?Usage: brain-note.sh <type> <topic> <content> [domain] [tags]}"
TOPIC="${2:?Missing topic}"
CONTENT="${3:?Missing content}"
DOMAIN="${4:-nanoclaw}"
EXTRA_TAGS="${5:-}"

# Map type → directory
case "$TYPE" in
  learning)  DIR="${BRAIN}/Learnings" ;;
  project)   DIR="${BRAIN}/Projects" ;;
  daily)     DIR="${BRAIN}/Daily" ;;
  *)         echo "Unknown type: ${TYPE}" >&2; exit 1 ;;
esac

mkdir -p "$DIR"

# Generate slug from topic
SLUG=$(echo "$TOPIC" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9 _-]//g' | tr ' ' '-' | sed 's/--*/-/g' | head -c 80)
DATE=$(date +%Y-%m-%d)
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build filename
if [ "$TYPE" = "daily" ]; then
  FILEPATH="${DIR}/${DATE}.md"
else
  FILEPATH="${DIR}/${DATE}_${SLUG}.md"
fi

# Build tags array
TAGS="${TYPE}, ${DOMAIN}"
if [ -n "$EXTRA_TAGS" ]; then
  TAGS="${TAGS}, ${EXTRA_TAGS}"
fi

# For daily notes, append if file exists
if [ "$TYPE" = "daily" ] && [ -f "$FILEPATH" ]; then
  printf '\n## %s\n\n%s\n' "$TOPIC" "$CONTENT" >> "$FILEPATH"
else
  cat > "$FILEPATH" << ENDNOTE
---
tags: [${TAGS}]
domain: ${DOMAIN}
created: ${CREATED}
source: ${DOMAIN}
---

# ${TOPIC}

${CONTENT}
ENDNOTE
fi

echo "$FILEPATH"
