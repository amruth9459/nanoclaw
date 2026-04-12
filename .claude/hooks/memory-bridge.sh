#!/bin/bash
# Claude Code → Claw state sync (memory bridge)
# PostToolUse: live-updates "## Active Work" file list on each Edit/Write
#   - Updates groups/main/MEMORY.md (Claw sees this)
#   - Updates Claude Code auto-memory (Claude Code sees this on next session)
# Stop: finalizes with timestamp in both files
set -euo pipefail

NANOCLAW_DIR="${HOME}/nanoclaw"
CLAW_MEMORY="${NANOCLAW_DIR}/groups/main/MEMORY.md"
CLAUDE_MEMORY="${HOME}/.claude/projects/-Users-amrut-nanoclaw/memory/MEMORY.md"

[ ! -f "$CLAW_MEMORY" ] && exit 0

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

  # Update Claw memory (groups/main/MEMORY.md)
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
if len(file_list) > 25:
    file_list = file_list[:25]
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
" "$CLAW_MEMORY" "$SHORT" "$TIMESTAMP"

  # Update Claude Code auto-memory (last session tracking)
  if [ -f "$CLAUDE_MEMORY" ]; then
    python3 -c "
import re, sys, os

memory_path = sys.argv[1]
new_file = sys.argv[2]
timestamp = sys.argv[3]

content = open(memory_path).read()

# Find or create '## Last Session' section at the end
section_pattern = r'## Last Session\n(.*?)(?=\n## |\Z)'
match = re.search(section_pattern, content, re.DOTALL)

if match:
    section = match.group(1)
    files_match = re.search(r'Files: (.+)', section)
    existing = set(f.strip() for f in files_match.group(1).split(',')) if files_match else set()
    existing.add(new_file)
    file_list = sorted(existing)
    if len(file_list) > 20:
        file_list = file_list[:20]
    files_str = ', '.join(file_list)
    # Categorize
    lexios_files = [f for f in file_list if f.startswith('Lexios/')]
    nanoclaw_files = [f for f in file_list if not f.startswith('Lexios/')]
    cats = []
    if lexios_files:
        cats.append(f'Lexios: {len(lexios_files)} files')
    if nanoclaw_files:
        cats.append(f'NanoClaw: {len(nanoclaw_files)} files')
    replacement = f'## Last Session\nActive: {timestamp}\nScope: {\" + \".join(cats)}\nFiles: {files_str}'
    result = re.sub(section_pattern, replacement, content, count=1, flags=re.DOTALL)
else:
    # Append new section
    replacement = f'\n\n## Last Session\nActive: {timestamp}\nScope: unknown\nFiles: {new_file}'
    result = content.rstrip() + replacement + '\n'

tmp = memory_path + '.tmp'
open(tmp, 'w').write(result)
os.rename(tmp, memory_path)
" "$CLAUDE_MEMORY" "$SHORT" "$TIMESTAMP" 2>/dev/null || true
  fi

  exit 0
fi

# ── Stop: finalize with session summary ──────────────────────────────────
if [ "$EVENT" = "Stop" ]; then
  HOOK_ACTIVE=$(echo "$INPUT" | /usr/bin/jq -r '.stop_hook_active // false')
  [ "$HOOK_ACTIVE" = "true" ] && exit 0

  TIMESTAMP=$(date '+%Y-%m-%d %H:%M')

  # Finalize Claw memory: Active → Last, add summary
  python3 -c "
import re, sys, subprocess, os

memory_path = sys.argv[1]
timestamp = sys.argv[2]
nanoclaw_dir = sys.argv[3]

content = open(memory_path).read()

result = content.replace('Active desktop session:', 'Last desktop session:')

result = re.sub(
    r'(Last desktop session: )\d{4}-\d{2}-\d{2} \d{2}:\d{2}',
    r'\g<1>' + timestamp,
    result,
    count=1
)

# Generate summary from git diff + recent commits
summary_parts = []
try:
    diff = subprocess.run(
        ['git', '-C', nanoclaw_dir, 'diff', '--stat', 'HEAD'],
        capture_output=True, text=True, timeout=10
    )
    commits = subprocess.run(
        ['git', '-C', nanoclaw_dir, 'log', '--oneline', '-5', '--since=12 hours ago'],
        capture_output=True, text=True, timeout=10
    )
    # Extract changed file names from diff stat
    if diff.stdout.strip():
        diff_files = []
        for line in diff.stdout.strip().split('\n')[:-1]:
            fname = line.split('|')[0].strip()
            if fname:
                diff_files.append(fname.split('/')[-1].replace('.ts', '').replace('.sh', ''))
        if diff_files:
            summary_parts.append('Changed: ' + ', '.join(diff_files[:8]))
    # Extract commit messages
    if commits.stdout.strip():
        msgs = [line.split(' ', 1)[1] if ' ' in line else line for line in commits.stdout.strip().split('\n')]
        summary_parts.append('Commits: ' + '; '.join(msgs[:3]))
except Exception:
    pass

if summary_parts:
    summary_line = 'Summary: ' + ' | '.join(summary_parts)
    # Insert summary after the timestamp line
    result = re.sub(
        r'(Last desktop session: [^\n]+)\n',
        r'\1\n' + summary_line + '\n',
        result,
        count=1
    )
    # Remove any previous Summary line to avoid duplication
    lines = result.split('\n')
    seen_summary = False
    cleaned = []
    for line in lines:
        if line.startswith('Summary: '):
            if not seen_summary:
                seen_summary = True
                cleaned.append(line)
        else:
            cleaned.append(line)
    result = '\n'.join(cleaned)

if result != content:
    tmp = memory_path + '.tmp'
    open(tmp, 'w').write(result)
    os.rename(tmp, memory_path)
" "$CLAW_MEMORY" "$TIMESTAMP" "$NANOCLAW_DIR"

  # Finalize Claude Code auto-memory: Active → Last
  if [ -f "$CLAUDE_MEMORY" ]; then
    python3 -c "
import re, sys, os

memory_path = sys.argv[1]
timestamp = sys.argv[2]

content = open(memory_path).read()

result = content.replace('Active: ', 'Ended: ')
result = re.sub(
    r'(Ended: )\d{4}-\d{2}-\d{2} \d{2}:\d{2}',
    r'\g<1>' + timestamp,
    result,
    count=1
)

if result != content:
    tmp = memory_path + '.tmp'
    open(tmp, 'w').write(result)
    os.rename(tmp, memory_path)
" "$CLAUDE_MEMORY" "$TIMESTAMP" 2>/dev/null || true
  fi

  # ── Generate DEVLOG entries ──────────────────────────────────────────
  python3 -c "
import re, os, subprocess, sys
from datetime import datetime

NANOCLAW_DIR = sys.argv[1]
LEXIOS_DIR = os.path.expanduser('~/Lexios')
CLAUDE_MEMORY = sys.argv[2]
timestamp = sys.argv[3]

# Area categorization map
AREA_MAP = {
    # Lexios
    'extract.py': 'extraction', 'serve.py': 'whatsapp-serve',
    'sheets.py': 'classification', 'ifc': 'ifc', 'eval.py': 'eval',
    'corpus': 'corpus', 'cache.py': 'cache', 'embed': 'embeddings',
    'batch.py': 'batch', 'train': 'training',
    # NanoClaw
    'src/index.ts': 'orchestrator', 'src/router': 'router',
    'src/container': 'container', 'src/dashboard': 'dashboard',
    'src/ipc': 'ipc', 'src/integrations': 'integrations',
    'container/agent-runner': 'agent-runtime',
    'container/Dockerfile': 'container-build',
    'container/skills': 'skills',
    'scripts/': 'scripts', 'docs/': 'docs',
    '.claude/hooks': 'hooks', 'CLAUDE.md': 'config',
}

def categorize(filepath):
    areas = set()
    for pattern, area in AREA_MAP.items():
        if pattern in filepath:
            areas.add(area)
    return areas

def git_diff_stat(repo_path):
    try:
        result = subprocess.run(
            ['git', '-C', repo_path, 'diff', '--stat', 'HEAD'],
            capture_output=True, text=True, timeout=10
        )
        lines = result.stdout.strip().split('\n')
        if not lines or not lines[-1]:
            return None
        # Last line like: ' 5 files changed, 120 insertions(+), 42 deletions(-)'
        summary = lines[-1].strip()
        import re as _re
        ins = _re.search(r'(\d+) insertion', summary)
        dels = _re.search(r'(\d+) deletion', summary)
        files_changed = _re.search(r'(\d+) file', summary)
        insertions = int(ins.group(1)) if ins else 0
        deletions = int(dels.group(1)) if dels else 0
        n_files = int(files_changed.group(1)) if files_changed else 0
        if insertions == 0 and deletions == 0:
            return None
        return f'+{insertions} -{deletions} across {n_files} files'
    except Exception:
        return None

def write_devlog(devlog_path, files, areas, diff_stat, timestamp):
    if not files:
        return
    # Read existing content
    if os.path.exists(devlog_path):
        content = open(devlog_path).read()
    else:
        return  # Don't create if header file doesn't exist

    areas_str = ', '.join(sorted(areas)) if areas else 'general'
    files_str = ', '.join(sorted(files))

    entry = f'### {timestamp}\n\n'
    entry += f'**Areas:** {areas_str}\n'
    entry += f'**Files ({len(files)}):** {files_str}\n'
    if diff_stat:
        entry += f'**Diff:** {diff_stat}\n'

    # Insert after the --- separator
    marker = '---\n'
    idx = content.find(marker)
    if idx >= 0:
        insert_pos = idx + len(marker)
        result = content[:insert_pos] + '\n' + entry + content[insert_pos:]
    else:
        result = content + '\n' + entry

    tmp = devlog_path + '.tmp'
    open(tmp, 'w').write(result)
    os.rename(tmp, devlog_path)

# Read file list from Claude Code auto-memory
if not os.path.exists(CLAUDE_MEMORY):
    sys.exit(0)

mem_content = open(CLAUDE_MEMORY).read()
match = re.search(r'## Last Session\n(.*?)(?=\n## |\Z)', mem_content, re.DOTALL)
if not match:
    sys.exit(0)

files_match = re.search(r'Files: (.+)', match.group(1))
if not files_match:
    sys.exit(0)

all_files = [f.strip() for f in files_match.group(1).split(',')]
all_files = [f for f in all_files if f]

if not all_files:
    sys.exit(0)

# Split into buckets
lexios_files = [f for f in all_files if f.startswith('Lexios/')]
nanoclaw_files = [f for f in all_files if not f.startswith('Lexios/') and not f.startswith('Library/') and not f.startswith('.cloud')]

# Process NanoClaw
if nanoclaw_files:
    areas = set()
    for f in nanoclaw_files:
        areas |= categorize(f)
    diff_stat = git_diff_stat(NANOCLAW_DIR)
    devlog = os.path.join(NANOCLAW_DIR, 'docs', 'DEVLOG.md')
    write_devlog(devlog, nanoclaw_files, areas, diff_stat, timestamp)

# Process Lexios
if lexios_files and os.path.isdir(LEXIOS_DIR):
    # Strip 'Lexios/' prefix for display
    short_files = [f.replace('Lexios/', '', 1) for f in lexios_files]
    areas = set()
    for f in short_files:
        areas |= categorize(f)
    diff_stat = git_diff_stat(LEXIOS_DIR)
    devlog = os.path.join(LEXIOS_DIR, 'docs', 'DEVLOG.md')
    write_devlog(devlog, short_files, areas, diff_stat, timestamp)
" "$NANOCLAW_DIR" "$CLAUDE_MEMORY" "$TIMESTAMP" 2>/dev/null || true

  # ── Write Obsidian daily note ────────────────────────────────────────
  BRAIN_PATH="${BRAIN_VAULT_PATH:-${HOME}/Brain}"
  if [ -d "${BRAIN_PATH}/Daily" ] && [ -f "$CLAUDE_MEMORY" ]; then
    python3 -c "
import re, os, subprocess, sys

brain_daily = sys.argv[1]
claude_memory = sys.argv[2]
timestamp = sys.argv[3]
nanoclaw_dir = sys.argv[4]

daily_note = os.path.join(brain_daily, timestamp.split(' ')[0].replace('-', '-') + '.md')
date_str = timestamp.split(' ')[0]

# Read file list from Claude Code auto-memory
mem = open(claude_memory).read()
match = re.search(r'## Last Session\n(.*?)(?=\n## |\Z)', mem, re.DOTALL)
if not match:
    sys.exit(0)

section = match.group(1)
files_match = re.search(r'Files: (.+)', section)
scope_match = re.search(r'Scope: (.+)', section)

files = [f.strip() for f in files_match.group(1).split(',')] if files_match else []
scope = scope_match.group(1) if scope_match else 'unknown'
files = [f for f in files if f]

if not files:
    sys.exit(0)

# Get diff stats
diff_stat = ''
try:
    r = subprocess.run(['git', '-C', nanoclaw_dir, 'diff', '--stat', 'HEAD'],
                       capture_output=True, text=True, timeout=10)
    lines = r.stdout.strip().split('\n')
    if lines and lines[-1]:
        diff_stat = lines[-1].strip()
except Exception:
    pass

# Build session entry
entry = f'## Session — {timestamp}\n\n'
entry += f'**Scope:** {scope}\n'
if diff_stat:
    entry += f'**Diff:** {diff_stat}\n'
entry += f'**Files ({len(files)}):** {\", \".join(sorted(files))}\n'

if os.path.exists(daily_note):
    # Append to existing daily note
    with open(daily_note, 'a') as f:
        f.write('\n' + entry)
else:
    # Create new daily note with frontmatter
    content = f'---\ntags: [daily]\ndate: {date_str}\n---\n\n# {date_str}\n\n{entry}'
    with open(daily_note, 'w') as f:
        f.write(content)
" "${BRAIN_PATH}/Daily" "$CLAUDE_MEMORY" "$TIMESTAMP" "$NANOCLAW_DIR" 2>/dev/null || true
  fi

  # ── Reconcile kanban tasks against MEMORY.md completions ──────────────
  python3 "${NANOCLAW_DIR}/scripts/reconcile-tasks.py" 2>/dev/null || true

  exit 0
fi
