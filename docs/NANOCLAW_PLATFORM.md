# NanoClaw Platform Overview

*Living document — last updated: 2026-04-13*
*Auto-updated by `lexios/update-docs.py` via NanoClaw scheduled task (twice daily)*

## What is NanoClaw?

NanoClaw is a personal AI assistant that runs Claude in sandboxed containers, accessible via WhatsApp. It connects to messaging platforms, routes conversations through isolated Linux containers running Claude Agent SDK, and manages per-group memory, scheduled tasks, and integrations.

**Tagline:** "Your personal Claude, always on WhatsApp"

**Target Users:** Individual power users, small teams, developers who want a persistent AI assistant accessible from their phone.

## Core Capabilities

### 1. WhatsApp Integration

Full-featured WhatsApp connection using Baileys:
- Bi-directional messaging with rich formatting
- Voice note transcription (OpenAI Whisper)
- Image/document/media handling
- Typing indicators and reactions
- Dual-number support (WA1 + WA2) for self-chat scenarios
- LID JID translation for modern WhatsApp protocols

### 2. Containerized Agent Execution

Each conversation runs in an isolated container:
- **Apple Container** (macOS native) or **Docker** runtime
- Full Claude Agent SDK with tool use (Bash, file editing, web browsing)
- Per-group filesystem isolation (`groups/{name}/`)
- Configurable mount allowlist for external directory access
- Warm container pool for fast response times
- Idle preemption when scheduled tasks need to run

### 3. Multi-Channel Architecture

Extensible channel system supporting:
- **WhatsApp** (primary) — groups, DMs, self-chat
- **Telegram** (skill-based) — with agent swarm support
- **X/Twitter** (skill-based) — post, like, reply, retweet
- **Gmail** (skill-based) — read/send email as tool or full channel
- Per-channel trigger patterns and routing rules

### 4. Per-Group Memory & Context

Each group has isolated persistent state:
- `groups/{name}/CLAUDE.md` — agent instructions and memory
- `groups/{name}/files/` — generated files, reports, artifacts
- SQLite-backed conversation history
- Semantic index for context-aware retrieval (Tier 2)
- 6-month pruning for index freshness

### 5. Scheduled Tasks

Cron-based task scheduling per group:
- Tasks defined in SQLite with cron expressions
- Context modes: full conversation history or task-only
- Parallel execution alongside user messages (dual-slot queue)
- Examples: daily briefs, code reviews, monitoring, corpus building

### 6. ClawWork Economic System

Built-in economics tracking:
- Token-level cost tracking (input/output/cache)
- Per-group cost attribution
- ClawWork tasks: autonomous work the agent picks up
- Bounty hunting: find and propose revenue opportunities
- Earning goal tracking toward $5,000 computer fund
- Cost footer on each response showing spend

### 7. DashClaw Dashboard

Web dashboard at `http://localhost:8080`:
- **Overview**: Active groups, recent messages, agent status
- **Economics**: Token costs, ClawWork earnings, bounty tracking
- **Files**: Browse per-group file trees with viewer
- **Lexios**: Construction AI metrics (corpus health, model performance)
- **Send**: Manual message injection to any registered group
- Cloudflare Quick Tunnel for remote access

### 8. IPC System

Host-container communication via JSON files:
- Agent writes IPC messages to `/workspace/ipc/messages/`
- Host watches for new files, processes commands
- Request/response pattern with `.response.json` files
- Commands: send_message, react, register_group, clawwork tools
- MCP tool bridge for agent-side SDK integration

### 9. Skills System

Modular capability system:
- Skills defined as markdown + code packages
- Applied via skills engine with state tracking
- Available skills: setup, debug, customize, add-telegram, add-gmail, x-integration, convert-to-apple-container, lexios, agent-browser, batch, and more
- Skills engine records applied skills in `.nanoclaw/state.yaml`

### 10. Security

Defense-in-depth security model:
- Container sandboxing with no host network access
- Per-group IPC namespacing prevents cross-group access
- Mount allowlist controls external directory exposure
- Secrets passed via SDK env option, not filesystem
- Environment variable sanitization in agent subprocesses
- Non-main groups default to read-only mounts

## Architecture

```
nanoclaw/
  src/
    index.ts              # Main orchestrator: state, message loop, agent invocation
    channels/
      whatsapp.ts         # WhatsApp connection (Baileys), auth, send/receive
    config.ts             # Trigger patterns, paths, intervals, token pricing
    container-runner.ts   # Spawn agent containers with mounts
    container-runtime.ts  # Runtime abstraction (Apple Container / Docker)
    db.ts                 # SQLite operations (messages, groups, economics, tasks)
    dashboard.ts          # DashClaw web UI + API routes
    economics.ts          # Token cost tracking, earning goals
    clawwork.ts           # Autonomous work system
    bounty-hunter.ts      # Revenue opportunity discovery
    bounty-gate.ts        # HITL approval for bounties
    group-queue.ts        # Per-group dual-slot queue (messages + tasks)
    ipc.ts                # IPC watcher and command dispatch
    router.ts             # Message formatting and outbound routing
    task-scheduler.ts     # Cron-based scheduled task runner
  container/
    agent-runner/src/     # Container-side agent code (compiled into image)
      index.ts            # Claude Agent SDK runner
      ipc-mcp-stdio.ts   # MCP tools bridge (IPC-based)
    skills/               # Skills available inside containers
    Dockerfile            # Agent container image definition
    build.sh              # Container build script
  groups/                 # Per-group state directories
  store/                  # WhatsApp auth + SQLite DB
  data/                   # IPC directories, config files
```

**Database:** SQLite at `store/messages.db` — messages, groups, economics, scheduled tasks, bounties, usage logs

**Dependencies:** Node.js 22+, TypeScript, Claude Agent SDK, Baileys, better-sqlite3, Apple Container or Docker

## Integration with Lexios

NanoClaw is one consumer of the Lexios platform:
1. `sync.sh` copies Lexios core files into NanoClaw's container
2. Agents run Lexios extraction/eval inside containers
3. Per-building WhatsApp groups for construction teams
4. Scheduled tasks run eval benchmarks and corpus building
5. DashClaw Lexios tab shows training metrics from `eval.db`

## Current State (March 2026)

| Component | Status |
|-----------|--------|
| WhatsApp integration (dual-number) | Production |
| Apple Container runtime | Production |
| Docker runtime | Production |
| Per-group queue (dual-slot) | Production |
| DashClaw dashboard | Production |
| ClawWork economics | Production |
| Bounty hunting | Production |
| Semantic index / context system | Production |
| Scheduled tasks | Production |
| IPC + MCP bridge | Production |
| Skills engine | Production |
| Telegram channel | Available (skill) |
| X/Twitter integration | Available (skill) |
| Gmail integration | Available (skill) |
| Voice transcription | Available (skill) |
| Lexios integration | Active |
| Auto-deploy pipeline | Production |

## Deployment

- **macOS**: launchd service (`com.nanoclaw.plist`) with `caffeinate` wrapper
- **Linux**: systemd user service
- Cloudflare Quick Tunnel for remote dashboard access
- Auto-backup via scheduled commits
- Container image rebuilt on code changes via auto-deploy pipeline

## History

| Date | Milestone |
|------|-----------|
| Nov 2025 | Initial commit: WhatsApp → Claude via containers |
| Dec 2025 | Per-group queue, SQLite state, graceful shutdown |
| Jan 2026 | Skills engine, multi-channel architecture, Telegram support |
| Feb 2026 | ClawWork economics, bounty hunting, DashClaw dashboard |
| Feb 2026 | Apple Container support, security hardening, voice transcription |
| Feb 2026 | Lexios integration, 101-type extraction, eval framework |
| Mar 2026 | Context system, semantic index, auto-deploy, dead code revival |
| Mar 2026 | Multi-model Lexios (GPT-4.1 + Gemini), corpus builder, metrics dashboard |

## Related

- [[CHANGELOG|NanoClaw Changelog]]
- [[README|Area: Infrastructure]]
- [[MEMORY_ARCHIVE_2026-03|Memory - Main Group]]
- [[IDENTITY|IDENTITY]]
- [[technical-openharness|OpenHarness - Open Agent Framework]]
- [[2026-04-07-conversation-2232|Conversation]]
