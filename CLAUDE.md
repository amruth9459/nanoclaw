# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/conversation-history.ts` | Thread-scoped chat history for RAG chains |
| `src/rag-chain.ts` | RAG query pipeline (contextualize → search → generate) |
| `src/semantic-index.ts` | Vector storage + Gemini embeddings (768 dims) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |
| `docs/EXPERIMENTS.md` | Experiment log (read before starting experiments) |
| `docs/journal/` | Auto-generated daily journals |
| `~/Brain/` | Obsidian vault — shared knowledge (symlinked to NanoClaw) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/resume` | Deep session recovery — pick up where you left off |
| `/wrap-up` | Structured session end — create handoff for next session |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Memory Bridge (Claw ↔ Claude Code)

`groups/main/MEMORY.md` is the shared memory between Claw and Claude Code.

**Before starting work:** Read `groups/main/MEMORY.md` — check "Active Work" for what the last session did, and "Active Projects" for current state.

**After significant work** (new files, architectural decisions, config changes):
Update `groups/main/MEMORY.md` "Active Projects" section — add new projects, remove completed ones. Keep it current state, not a log.

The `memory-bridge.sh` hook auto-updates "Active Work" with files touched live (every Edit/Write).

`groups/main/KANBAN.md` is the shared task board (auto-generated from DB). Check it for current tasks across NanoClaw and Lexios. Claw sees a summary injected into every prompt. Tasks are managed via DashClaw UI or Claw's `task_tool`.

## Documentation Rules

After significant work sessions (new features, architectural changes, test results with metrics):
- Update `docs/LEXIOS_CHANGELOG.md` or `docs/NANOCLAW_CHANGELOG.md` with a version entry
- Include: problem statement, what changed, test results with numbers, files modified
- The DEVLOG.md is auto-generated per session; the CHANGELOG is for milestone summaries

When you discover something non-obvious that would help future sessions:
- **NanoClaw learnings** → add to `groups/main/MEMORY.md` under `## Learned Facts` as `- **topic:** detail`
- **Lexios learnings** → add to `~/Lexios/docs/LEARNINGS.md` under `## Learned Facts` as `- **topic:** detail`
These feed into Claw's hot cache and benefit both desktop and container agents.

## RAG Query (MCP Tool)

The `rag_query` MCP tool provides conversational RAG over indexed documents. Available to all container agents.

**Usage:**
```
rag_query(query: "What are the door specs?", thread_id: "session-123", top_k: 5)
```

**How it works:**
1. Loads conversation history for `thread_id` (if provided)
2. Contextualizes the query using chat history (Gemini Flash)
3. Semantic search via sqlite-vec for relevant chunks
4. Generates answer with source citations (Gemini Flash)
5. Saves user/assistant turns to conversation history

**Parameters:**
- `query` (required): Natural language question
- `thread_id` (optional): Reuse for follow-up questions in same conversation
- `top_k` (optional, default 5): Number of source chunks to retrieve
- `group_folder` (optional): Limit search to a specific group

**IPC flow:** Container writes `.search.json` → host processes via `ragQuery()` → writes `.result.json` back.

## Integration Boundary

Core files (`src/*.ts`, `container/Dockerfile`, `container/agent-runner/src/ipc-mcp-stdio.ts`) must NEVER reference integration-specific names (e.g. `lexios`, `ezdxf`, `ifcopenshell`). All integration logic goes through `src/integration-types.ts` hooks. Integration-specific code lives in `src/integrations/`, `container/skills/`, `scripts/`, `groups/`, and `docs/`. A pre-commit hook (`.githooks/no-lexios-in-core.sh`) enforces this.
