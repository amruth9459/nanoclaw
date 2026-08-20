---
name: resume
description: Deep session recovery. Reads handoff notes, current task, DEVLOG, experiments, MEMORY.md, and git state to reconstruct full context from the previous session. Use at the start of a session when you need to pick up where you left off.
---

# Resume: Deep Session Recovery

When the user invokes `/resume`, perform a comprehensive context recovery from all available sources and present a structured briefing.

## Steps

### 1. Read All Context Sources

Read these files (skip any that don't exist):

1. **`.current-task.json`** — full contents (task, context, next steps, blockers, decisions, approaches, critical files, branch, commit)
2. **Latest handoff note** — `ls -1t groups/main/handoffs/*.md | head -1` → read full file
3. **`groups/main/MEMORY.md`** — read Active Projects section and Blockers section
4. **Last 3 DEVLOG entries** — read `docs/DEVLOG.md`, extract the 3 most recent `###` entries
5. **In-progress experiments** — read `docs/EXPERIMENTS.md`, look for entries marked as in-progress or not yet concluded
6. **Git state:**
   ```bash
   git branch --show-current
   git log --oneline -5
   git diff --stat
   git status --porcelain | head -20
   ```

### 2. Present Structured Briefing

Format and present the findings in this structure:

```
## Session Recovery

### Last Session
[From handoff note: what was done, when, key decisions]

### Current Task
[From .current-task.json: task description, context]

### Active Projects
[From MEMORY.md: list of active projects with one-line status each]

### Blockers
[From MEMORY.md + .current-task.json: anything preventing progress]

### Active Experiments
[From EXPERIMENTS.md: any in-progress experiments with status]

### Repo State
- Branch: [current branch]
- Last 5 commits: [one-line each]
- Uncommitted changes: [count and summary]

### Suggested Next Steps
[From .current-task.json next_steps + your analysis of what makes sense to do now]
```

### 3. Offer to Continue

After presenting the briefing, ask:

> Ready to continue. What would you like to work on?

If the current task and next steps are clear, suggest the most logical next action.

## Notes

- This skill is complementary to the SessionStart hook. SessionStart provides a lightweight auto-briefing (~1K tokens). `/resume` provides a deep, interactive recovery.
- If no handoff or `.current-task.json` exists, fall back to git log + MEMORY.md + DEVLOG for context.
- Don't modify any files — this is read-only.
