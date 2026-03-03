#!/bin/bash
# Claude Code → Claw state sync (memory bridge)
# PostToolUse: live-updates "## Active Work" file list on each Edit/Write
# Stop: finalizes with timestamp
set -euo pipefail

NANOCLAW_DIR="${HOME}/nanoclaw"
MEMORY="${NANOCLAW_DIR}/groups/main/MEMORY.md"
LEXIOS_MEMORY="${NANOCLAW_DIR}/groups/claw-lexios/MEMORY.md"
[ ! -f "$MEMORY" ] && exit 0

INPUT=$(cat)
EVENT=$(echo "$INPUT" | /usr/bin/jq -r '.hook_event_name // empty')

# ── PostToolUse: live file tracking ──────────────────────────────────────
if [ "$EVENT" = "PostToolUse" ]; then
  TOOL=$(echo "$INPUT" | /usr/bin/jq -r '.tool_name // empty')
  # Only track file-modifying tools
  [[ "$TOOL" != "Edit" && "$TOOL" != "Write" ]] && exit 0

  FILE_PATH=$(echo "$INPUT" | /usr/bin/jq -r '.tool_input.file_path // empty')
  [ -z "$FILE_PATH" ] && exit 0

  # Skip temp files and plan files
  [[ "$FILE_PATH" == /tmp/* ]] && exit 0
  [[ "$FILE_PATH" == */.claude/plans/* ]] && exit 0

  # Normalize path (strip home/nanoclaw prefix for readability)
  SHORT=$(echo "$FILE_PATH" | sed "s|${NANOCLAW_DIR}/||;s|${HOME}/||")
  TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

  python3 -c "
import re, sys

memory_path = sys.argv[1]
new_file = sys.argv[2]
timestamp = sys.argv[3]

content = open(memory_path).read()

# Extract current Active Work section
match = re.search(r'## Active Work\n(.*?)(?=\n## |\Z)', content, re.DOTALL)
if not match:
    sys.exit(0)

section = match.group(1)

# Parse existing files list
files_match = re.search(r'Files touched: (.+)', section)
existing = set(f.strip() for f in files_match.group(1).split(',')) if files_match else set()

# Add new file (dedup)
existing.discard('(auto-populated by memory-bridge.sh hook)')
existing.add(new_file)
files_str = ', '.join(sorted(existing))

# Build replacement (bounded: max 15 files shown)
file_list = sorted(existing)
if len(file_list) > 15:
    file_list = file_list[:15]
files_str = ', '.join(file_list)

replacement = f'''## Active Work

Active desktop session: {timestamp}
Files touched: {files_str}'''

pattern = r'## Active Work\n.*?(?=\n## |\Z)'
result = re.sub(pattern, replacement, content, count=1, flags=re.DOTALL)

tmp = memory_path + '.tmp'
open(tmp, 'w').write(result)
import os
os.rename(tmp, memory_path)
" "$MEMORY" "$SHORT" "$TIMESTAMP"

  # Also update claw-lexios memory when Lexios files are touched
  if [ -f "$LEXIOS_MEMORY" ] && [[ "$FILE_PATH" == *Lexios* || "$FILE_PATH" == *lexios* ]]; then
    python3 -c "
import re, sys

memory_path = sys.argv[1]
new_file = sys.argv[2]
timestamp = sys.argv[3]

content = open(memory_path).read()

match = re.search(r'## Active Work\n(.*?)(?=\n## |\Z)', content, re.DOTALL)
if not match:
    sys.exit(0)

section = match.group(1)
files_match = re.search(r'Files touched: (.+)', section)
existing = set(f.strip() for f in files_match.group(1).split(',')) if files_match else set()
existing.discard('(auto-populated by memory-bridge.sh hook)')
existing.add(new_file)
file_list = sorted(existing)
if len(file_list) > 15:
    file_list = file_list[:15]
files_str = ', '.join(file_list)

replacement = f'''## Active Work

Active desktop session: {timestamp}
Files touched: {files_str}'''

pattern = r'## Active Work\n.*?(?=\n## |\Z)'
result = re.sub(pattern, replacement, content, count=1, flags=re.DOTALL)

tmp = memory_path + '.tmp'
open(tmp, 'w').write(result)
import os
os.rename(tmp, memory_path)
" "$LEXIOS_MEMORY" "$SHORT" "$TIMESTAMP"
  fi

  exit 0
fi

# ── Stop: finalize with session summary ──────────────────────────────────
if [ "$EVENT" = "Stop" ]; then
  HOOK_ACTIVE=$(echo "$INPUT" | /usr/bin/jq -r '.stop_hook_active // false')
  [ "$HOOK_ACTIVE" = "true" ] && exit 0

  TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

  # Just update "Active" → "Last" to mark session as ended
  python3 -c "
import re, sys

memory_path = sys.argv[1]
timestamp = sys.argv[2]

content = open(memory_path).read()

# Replace 'Active desktop session' with 'Last desktop session'
result = content.replace('Active desktop session:', 'Last desktop session:')

# Update timestamp to session end time
result = re.sub(
    r'(Last desktop session: )\d{4}-\d{2}-\d{2} \d{2}:\d{2}',
    r'\g<1>' + timestamp,
    result,
    count=1
)

if result != content:
    tmp = memory_path + '.tmp'
    open(tmp, 'w').write(result)
    import os
    os.rename(tmp, memory_path)
" "$MEMORY" "$TIMESTAMP"

  # Also finalize claw-lexios memory if it has an active session
  if [ -f "$LEXIOS_MEMORY" ] && grep -q 'Active desktop session' "$LEXIOS_MEMORY" 2>/dev/null; then
    python3 -c "
import re, sys

memory_path = sys.argv[1]
timestamp = sys.argv[2]

content = open(memory_path).read()
result = content.replace('Active desktop session:', 'Last desktop session:')
result = re.sub(
    r'(Last desktop session: )\d{4}-\d{2}-\d{2} \d{2}:\d{2}',
    r'\g<1>' + timestamp,
    result,
    count=1
)

if result != content:
    tmp = memory_path + '.tmp'
    open(tmp, 'w').write(result)
    import os
    os.rename(tmp, memory_path)
" "$LEXIOS_MEMORY" "$TIMESTAMP"
  fi

  exit 0
fi
