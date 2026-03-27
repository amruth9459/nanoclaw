# NanoClaw Changelog

*Version control document — auto-updated by `nanoclaw/scripts/update-docs.py` (twice daily via launchd)*

## v0.14.0 — Context System + Auto-Deploy (2026-03-01)

### Added
- **Semantic index** with Tier 2 context search and Tier 1 persistence
- **6-month pruning** for semantic index chunks
- **Auto-deploy pipeline** — agent builds, restarts service, notifies on WhatsApp
- **Dead code revival** — wired 6 dormant code clusters as non-blocking enrichment layers
- **Guest session protection** — skip context enrichment to prevent personal info leakage

### Fixed
- DashClaw tab switching and running agent details display
- Remote shell whitelist rejecting preset commands
- Security config .env loading and macOS RAM reporting

## v0.13.0 — Lexios Multi-Model + Metrics Dashboard (2026-03-01)

### Added
- **Lexios per-building WhatsApp group model** with DWG/DXF support
- **Lexios metrics dashboard** in DashClaw — corpus health, model F1 trends, learning effectiveness
- `/api/lexios-metrics` endpoint reading from Lexios eval.db
- Lexios mount into main container at `/workspace/lexios`
- Date included in dashboard timestamps

### Changed
- Container runtime switched from Docker to Apple Container
- Context-aware ack emojis based on message content
- Lexios extraction expanded from 9 to 101 types across 5 domains

## v0.12.0 — ClawWork Economics + Bounty Hunting (2026-02-23)

### Added
- **ClawWork economic system** — token-level cost tracking, per-group attribution
  - 4 new DB tables: usage_logs, group_economics, clawwork_tasks, clawwork_learns
  - `/clawwork <prompt>` triggers autonomous task assignment
  - MCP tools: clawwork_get_status, clawwork_decide_activity, clawwork_learn, clawwork_submit_work
  - Work evaluated by Haiku model on host-side
- **Bounty hunting** — find and propose revenue opportunities
  - bounty_opportunities DB table
  - MCP tools: find_bounties, propose_bounty, submit_bounty
  - HITL approval gate (approve-bounty / reject-bounty tokens)
  - Earning goal: $5,000 computer fund
- **DashClaw Economics tab** — spending, earnings, ClawWork activity

### Fixed
- Classify task API auth and AUTH_CODE_77 hallucination

## v0.11.0 — Reactions, Typing, Queue Fixes (2026-02-25)

### Added
- **Ack channel selection** — picks WA channel whose number != sender for visible reactions
- **react MCP tool** — agent can react to specific messages with emojis
- Message ID and sender_jid in formatted messages for react tool
- Reconnect notification: "Back online (was unreachable for Xm Ys)"
- DashClaw Files tab with grouped file browser and viewer

### Fixed
- Reactions/typing invisible when fired from same number as user (WA2 fix)
- LID JID translation for reactions
- Group queue: tasks no longer block user messages (dual-slot: active + activeTask)
- Duplicate messages when agent uses send_message MCP tool
- Reaction retry and sendMessage log noise

## v0.10.0 — Connection Stability (2026-02-25)

### Added
- Cloudflare Quick Tunnel for remote DashClaw access
- `caffeinate -i -s` wraps Node in launchd so Mac never sleeps
- WhatsApp connection watchdog (3-minute timeout)

### Fixed
- WA1 startup hang: lost `resolve` callback on reconnect after 405
- `fetchLatestWaWebVersion` hang: 5-second timeout with fallback version
- WA2 connect timeout: 30-second race
- link-preview-js missing causing silent failures
- keepAliveIntervalMs: 15s pings to keep NAT mappings alive

## v0.9.0 — Media + Safety (2026-02-22)

### Added
- ffmpeg/video support and media pipeline
- Safety pulse monitoring
- Remote shell with whitelist
- Dev watcher for hot reload
- PDF generation from agent files
- Group description management

### Fixed
- Medium and low risk security issues
- Three high-risk reliability issues
- File type validation using magic bytes

## v0.8.0 — Media Support (2026-02-20)

### Added
- Image and document handling in WhatsApp messages
- Voice note transcription via OpenAI Whisper API
- OCR stack for text extraction from images
- Open mentions system

### Fixed
- Media safety improvements
- File type validation

## v0.7.0 — Performance + Streaming (2026-02-18)

### Added
- Warm container pool on startup
- Cost footer on each agent response

### Fixed
- Eliminated runtime tsc compilation, lower streaming chunk size
- Use sendReaction for ACK on every message
- Suppress duplicate message when streaming chunks already sent

## v0.6.0 — Identity + Security (2026-02-15)

### Added
- **Claw-Prime identity** system
- **HITL gate** for sensitive operations
- **Security hardening**: per-group IPC namespaces, mount allowlist, env sanitization
- **DashClaw UI** with overview, economics, files tabs
- **Semantic index** (initial version)

### Fixed
- Secrets passed via SDK env option, not filesystem
- Environment variable sanitization in agent subprocesses

## v0.5.0 — Skills Engine + Multi-Channel (2026-02-10)

### Added
- **Skills engine** v0.1 with state tracking in `.nanoclaw/state.yaml`
- Multi-channel infrastructure
- `/convert-to-apple-container` skill
- Apple Container runtime support
- `/add-telegram` skill with agent swarm support

### Changed
- Container runtime abstracted into `src/container-runtime.ts`

## v0.4.0 — Setup + Bot Features (2026-02-05)

### Added
- `/setup` skill with scripted installation steps
- Dedicated phone number support with `is_bot_message` column
- Typing indicator on every message
- GitHub Actions for repo token counting

### Fixed
- WhatsApp auth improvements and LID translation for DMs
- Copy skill subdirectories recursively
- Various PR fixes from community contributions

## v0.3.0 — Per-Group Queue + SQLite (2026-01-20)

### Added
- **Per-group queue** with SQLite-backed state
- Graceful shutdown handling
- Container lifecycle management
- Orphan container cleanup

### Fixed
- Prevent infinite message replay on container timeout
- Duplicate responses from reconnect-stacking loops
- Stopped container accumulation

## v0.2.0 — Integrations + Security (2026-01-10)

### Added
- **X/Twitter integration** skill
- **Gmail integration** skill
- `/add-parallel` skill for Parallel AI
- `/convert-to-docker` skill
- `/customize` and `/debug` skills
- Container output size limiting
- Mount security allowlist

### Fixed
- IPC auth, message logging, container log security
- Session persistence and auto-start
- Message cursor advancement on successful processing
- Group metadata sync epoch timestamps

## v0.1.0 — Initial Release (2025-11)

### Added
- WhatsApp connection via Baileys
- Claude Agent SDK in containerized execution (Apple Container)
- Per-group filesystem isolation
- Cron-based scheduled tasks
- Basic message routing and formatting
- IPC system for host-container communication
- launchd service for macOS

---

## Repository

- **Repo:** `amruth9459/nanoclaw` (private fork)
- **Upstream:** `gavrielc/nanoclaw`
- **Branch:** main
- **Total commits:** 572 (since Jan 2025)
- **Primary language:** TypeScript
- **Contributors:** amruth9459, gavrielc, community PRs
