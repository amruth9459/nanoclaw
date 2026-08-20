---
name: wrap-up
description: Structured session end that creates rich handoff documentation for the next session. Creates handoff note, updates .current-task.json, warns about uncommitted changes. Use at end of work sessions for seamless continuity.
---

# Wrap-Up: Structured Session End

When the user invokes `/wrap-up`, perform a structured session close-out. This creates documentation that the next session (via SessionStart hook and `/resume`) can use to immediately continue work.

## Steps

### 1. Gather Session Data

Run these commands to understand what happened this session:

```bash
# Recent commits this session
git log --oneline -10 --since="8 hours ago"

# Current diff (uncommitted work)
git diff --stat

# Current branch
git branch --show-current

# Latest commit hash
git log --format='%H' -1
```

### 2. Self-Report

Reflect on the current session and prepare these fields (use your conversation context):

- **task**: What was the main task this session?
- **context**: Brief description of the problem/feature space
- **accomplishments**: List of what was completed
- **decisions_made**: Key architectural or design decisions and why
- **approaches_tried**: What was attempted (including things that didn't work)
- **next_steps**: What should happen next (ordered by priority)
- **blockers**: Anything preventing progress
- **critical_files**: Files most important to understand for continuing this work

### 3. Update `.current-task.json`

Write/update the file at the project root with this schema:

```json
{
  "task": "Brief task description",
  "context": "Problem/feature context",
  "next_steps": ["Step 1", "Step 2"],
  "blockers": ["Blocker 1"],
  "last_session": "2026-04-12T14:30:00Z",
  "decisions_made": ["Decision 1: reason"],
  "approaches_tried": ["Approach 1: outcome"],
  "critical_files": ["src/file.ts", "docs/spec.md"],
  "git_branch": "feature/xyz",
  "git_commit": "abc123f"
}
```

All fields are optional except `task` and `last_session`. Add fields, never remove existing ones the user may have added.

### 4. Create Handoff Note

Write a markdown file to `groups/main/handoffs/YYYY-MM-DD-HHMM.md`:

```markdown
# Session Handoff — YYYY-MM-DD HH:MM

## What Was Done
- Accomplishment 1
- Accomplishment 2

## Key Decisions
- Decision 1: rationale

## Approaches Tried
- Approach 1 → outcome

## Current State
Brief description of where things stand.

## Next Steps
1. Most important next action
2. Second priority
3. Third priority

## Blockers
- Blocker description (if any)

## Critical Files
- `path/to/file` — why it matters

## Uncommitted Changes
[output of git diff --stat, or "None"]
```

### 5. Update Brain Vault Project Note

If `~/Brain/Projects/` exists, create or update a project note:

```bash
PROJECT_NAME="<slugified task name>"
NOTE_PATH="${HOME}/Brain/Projects/${PROJECT_NAME}.md"
```

Write the note with this format:

```markdown
---
tags: [project, nanoclaw]
status: active
last-updated: YYYY-MM-DDTHH:MM:SSZ
---

# Project Name

## Status
Brief current state description.

## Key Decisions
- Decision 1: rationale

## Next Steps
1. Most important next action
2. Second priority

## Related
- [[Handoffs/YYYY-MM-DD-HHMM]] — Latest handoff
```

If the file already exists, update the Status, Key Decisions, Next Steps, and `last-updated` frontmatter. Preserve any manually added sections.

### 6. Prune Old Handoffs

After creating the new handoff, prune old ones:

```bash
# Keep last 10 handoffs, delete anything older than 30 days
ls -1t groups/main/handoffs/*.md | tail -n +11 | xargs rm -f 2>/dev/null
find groups/main/handoffs/ -name "*.md" -mtime +30 -delete 2>/dev/null
```

Don't delete `.gitkeep`.

### 7. Warn About Uncommitted Changes

If `git status --porcelain` shows changes, explicitly warn:

> **Warning:** You have N uncommitted changes. Consider committing before ending this session.

List the files.

### 8. Confirm

Print a summary:

```
Session wrapped up:
- Handoff: groups/main/handoffs/YYYY-MM-DD-HHMM.md
- Task file: .current-task.json updated
- Next session will auto-load this context via SessionStart hook
```
