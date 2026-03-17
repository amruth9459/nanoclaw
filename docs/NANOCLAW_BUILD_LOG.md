# NanoClaw — Daily Build Log

*Living document — auto-generated from git history*
*Last generated: 2026-03-17*

**414 total commits** (212 meaningful) | 2026-01-31 to 2026-03-16

---

## 2026-03-16

### What Changed
- 24 auto-backup commits (incremental saves)

### Files (9 changed)
- container/agent-runner/src/ipc-mcp-stdio.ts
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- groups/main/CLAUDE.md
- scripts/backfill-shared-items.ts
- src/channels/whatsapp.ts
- src/db.ts
- src/index.ts
- src/ipc.ts

### Stats
- 999 insertions, 167 deletions

## 2026-03-15

### What Changed
- Remove tracked pycache and test script
- (+31 auto-backup commits)

### Files (4 changed)
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- scripts/__pycache__/lexios-eval.cpython-313.pyc
- scripts/test-lexios.sh

### Stats
- 602 insertions, 531 deletions

## 2026-03-14

### What Changed
- [Agent] task_user_gkeep: Add Google Keep read-only integration
- Update devlog with Phase 1-5 engineering completion session
- Update devlog with session progress
- Update devlog with Lexios comprehensive test suite session
- Update devlog with browser & engine E2E testing session
- Update devlog with Lexios documentation update session
- (+18 auto-backup commits)

### Files (6 changed)
- container/agent-runner/src/gws-tools.ts
- container/skills/gws/gws_helper.py
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- scripts/refresh-oauth.sh
- src/db.ts

### Stats
- 887 insertions, 4 deletions

## 2026-03-13

### What Changed
- Add OAuth token refresh, Apple Container snapshot pruning, spec types
- Add container heartbeat to prevent timeout during long extractions; increase desktop_claude limits
- Add host-side fallback and security hardening
- [Agent] nc-sec-09: Implement R2 write-only backup token
- [Agent] nc-sec-14: Enable macOS firewall + stealth mode
- (+25 auto-backup commits)

### Files (25 changed)
- .claude/settings.local.json
- container/Dockerfile
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- docs/R2_BACKUP_SECURITY.md
- scripts/backup.sh
- scripts/desktop-claude.sh
- scripts/verify-r2-writeonly.sh
- security/enable-firewall.sh
- security/firewall-config.md
- src/__tests__/rate-limiter.test.ts
- src/auto-dispatch.ts
- src/container-runner.ts
- src/container-runtime.ts
- src/dashboard.ts
- src/db.ts
- src/host-fallback.ts
- src/index.ts
- ... and 5 more

### Stats
- 2362 insertions, 176 deletions

## 2026-03-12

### What Changed
- Replace Haiku pseudo-embeddings with Gemini real embeddings
- Fix Gemini embedding integration: truncate 3072→768 dims, fix migration
- Fix ENFILE file table overflow: cleanup stopped containers and remove leaked VMs
- (+15 auto-backup commits)

### Files (15 changed)
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- package-lock.json
- package.json
- scripts/test-lexios.sh
- src/auto-dispatch.ts
- src/container-runner.ts
- src/container-runtime.test.ts
- src/container-runtime.ts
- src/index.ts
- src/integration-types.ts
- src/ipc.ts
- src/persona-registry.test.ts
- src/persona-registry.ts
- src/semantic-index.ts

### Stats
- 1714 insertions, 177 deletions

## 2026-03-11

### What Changed
- Auto-dispatch, dependency inference, task completion loop, infrastructure fixes
- (+10 auto-backup commits)

### Files (47 changed)
- .claude/hooks/memory-bridge.sh
- .claude/hooks/whatsapp-sync.sh
- .githooks/no-lexios-in-core.sh
- CLAUDE.md
- container/agent-runner/src/gws-tools.ts
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- container/agent-runner/src/lexios-tools.ts
- container/agent-runner/src/safety-pulse.ts
- container/skills/gws/gws_helper.py
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- package-lock.json
- package.json
- scripts/backup.sh
- scripts/generate-build-log.py
- scripts/generate-contingency.sh
- scripts/migrate-to-mac-studio.sh
- scripts/reconcile-tasks.py
- scripts/restore.sh
- ... and 27 more

### Stats
- 3533 insertions, 1060 deletions

## 2026-03-10

### What Changed
- 15 auto-backup commits (incremental saves)

### Files (3 changed)
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- groups/main/CLAUDE.md

### Stats
- 348 insertions, 4 deletions

## 2026-03-09

### What Changed
- Fix duplicate messages, file delivery, task frequency; add cross-group messaging, GWS integration, research protocol
- (+24 auto-backup commits)

### Files (15 changed)
- container/Dockerfile
- container/agent-runner/src/gws-tools.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- container/requirements.txt
- container/skills/gws/gws_helper.py
- container/skills/gws/requirements.txt
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- groups/main/CLAUDE.md
- scripts/pdf-metric-to-us.py
- src/channels/whatsapp.ts
- src/config.ts
- src/container-runner.ts
- src/index.ts
- src/ipc.ts

### Stats
- 1374 insertions, 605 deletions

## 2026-03-08

### What Changed
- 3 auto-backup commits (incremental saves)

### Files (2 changed)
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md

### Stats
- 33 insertions, 2 deletions

## 2026-03-07

### What Changed
- 5 auto-backup commits (incremental saves)

### Files (3 changed)
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- groups/main/CLAUDE.md

### Stats
- 121 insertions, 40 deletions

## 2026-03-06

### What Changed
- 2 auto-backup commits (incremental saves)

### Files (2 changed)
- docs/NANOCLAW_BUILD_LOG.md
- groups/main/CLAUDE.md

### Stats
- 35 insertions, 6 deletions

## 2026-03-05

### What Changed
- 6 auto-backup commits (incremental saves)

### Files (5 changed)
- docs/DEVLOG.md
- docs/NANOCLAW_BUILD_LOG.md
- docs/NANOCLAW_CHANGELOG.md
- docs/NANOCLAW_PLATFORM.md
- groups/main/CLAUDE.md

### Stats
- 136 insertions, 8 deletions

## 2026-03-04

### What Changed
- 4 auto-backup commits (incremental saves)

### Files (5 changed)
- config/router-config.json
- docs/LEXIOS_BUILD_LOG.md
- docs/NANOCLAW_BUILD_LOG.md
- docs/NANOCLAW_CHANGELOG.md
- docs/NANOCLAW_PLATFORM.md

### Stats
- 46 insertions, 219 deletions

## 2026-03-03

### What Changed
- Extract Lexios into plugin architecture with integration loader
- Add deterministic post-extraction pipeline scripts to container
- Add memory bridge hook, update-docs script, and gitignore cleanup
- (+1 auto-backup commits)

### Files (25 changed)
- .claude/hooks/memory-bridge.sh
- .gitignore
- CLAUDE.md
- container/Dockerfile
- container/agent-runner/src/ipc-mcp-stdio.ts
- docs/LEXIOS_BUILD_LOG.md
- docs/NANOCLAW_BUILD_LOG.md
- scripts/backup.sh
- scripts/update-docs.py
- src/channels/whatsapp.ts
- src/config.ts
- src/container-runner.ts
- src/dashboard.ts
- src/db.ts
- src/index.ts
- src/integration-loader.ts
- src/integration-types.ts
- src/ipc.ts
- src/lexios-customer.ts
- src/lexios-security.ts
- ... and 5 more

### Stats
- 2271 insertions, 2038 deletions

## 2026-03-02

### What Changed
- Add comprehensive API cost tracking, Lexios metrics dashboard, and platform docs
- (+13 auto-backup commits)

### Files (23 changed)
- .claude/hooks/whatsapp-sync.sh
- .claude/settings.local.json
- container/Dockerfile
- container/agent-runner/src/ifc-mcp-server.py
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- docs/NANOCLAW_CHANGELOG.md
- docs/NANOCLAW_PLATFORM.md
- groups/main/CLAUDE.md
- scripts/backup.sh
- src/config.ts
- src/container-runner.ts
- src/dashboard.ts
- src/db.ts
- src/group-queue.ts
- src/index.ts
- src/integrations/fieldy-integration.ts
- src/ipc.ts
- src/judge-system.ts
- src/mcp/tools/task-tool.ts
- ... and 3 more

### Stats
- 3443 insertions, 195 deletions

## 2026-03-01

### What Changed
- Add Lexios per-building WhatsApp group model with DWG/DXF support
- Fix security config .env loading and macOS RAM reporting
- Fix remote shell whitelist rejecting preset commands
- Fix DashClaw tab switching, show running agent details, add Tailscale URL to group description
- Wire 6 dead code clusters into NanoClaw as non-blocking enrichment layers
- Add auto-deploy pipeline: agent builds, restarts service, notifies user on WhatsApp
- Wire context system: Tier 2 semantic search + Tier 1 persistence
- Add 6-month pruning for semantic index chunks
- Skip context enrichment for guest sessions to prevent personal info leakage
- (+6 auto-backup commits)

### Files (75 changed)
- .../agent-runner/src/goal-classifier-prompt.ts
- .claude/settings.local.json
- .claude/worktrees/eloquent-vaughan
- .gitignore
- MIGRATION_GUIDE.md
- config/router-config.json
- container/Dockerfile
- container/agent-runner/src/integration-wrapper.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- container/agent-runner/src/safety-pulse.ts
- container/skills/batch/SKILL.md
- container/skills/frontend-design/SKILL.md
- container/skills/simplify/SKILL.md
- groups/main/CLAUDE.md
- package-lock.json
- package.json
- scripts/__pycache__/lexios-eval.cpython-313.pyc
- scripts/backup.sh
- scripts/diagnose-whatsapp.sh
- scripts/export-for-migration.sh
- ... and 55 more

### Stats
- 19905 insertions, 3713 deletions

## 2026-02-28

### What Changed
- Switch container runtime from Docker to Apple Container and fix dashboard timestamps
- Include date in dashboard timestamps to distinguish across days

### Files (4 changed)
- container/build.sh
- src/container-runtime.test.ts
- src/container-runtime.ts
- src/dashboard.ts

### Stats
- 99 insertions, 58 deletions

## 2026-02-27

### What Changed
- Add Lexios vs NanoClaw distinction to agent instructions
- Exclude untracked src/integrations and src/router from build
- Mount Lexios repo into main container at /workspace/lexios
- Add context-aware ack emojis based on message content

### Files (4 changed)
- groups/main/CLAUDE.md
- src/container-runner.ts
- src/index.ts
- tsconfig.json

### Stats
- 130 insertions, 40 deletions

## 2026-02-26

### What Changed
- Fix reaction retry and sendMessage log noise
- Fix classifyTask API auth and AUTH_CODE_77 hallucination

### Files (3 changed)
- groups/main/CLAUDE.md
- src/channels/whatsapp.ts
- src/clawwork.ts

### Stats
- 39 insertions, 23 deletions

## 2026-02-25

### What Changed
- Add WhatsApp connection watchdog
- Add ffmpeg/video support, safety pulse, remote shell, and dev watcher
- Fix three high-risk reliability issues
- Fix medium and low risk issues
- Account for real $250 owner investment in economics
- Fix reactions/typing visibility, queue blocking, and connection stability
- Add group description, PDF generation, files viewer, and GGUF/OSHA tasks
- Fix duplicate messages when agent uses send_message MCP tool

### Files (25 changed)
- .claude/settings.local.json
- container/Dockerfile
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- container/agent-runner/src/safety-pulse.ts
- container/skills/extract-frame.sh
- container/skills/generate-pdf.sh
- groups/main/CLAUDE.md
- package-lock.json
- package.json
- scripts/docker-watchdog.sh
- src/channels/whatsapp.ts
- src/config.ts
- src/container-runner.ts
- src/dashboard.ts
- src/dev-watcher.ts
- src/economics.ts
- src/group-queue.ts
- src/index.ts
- src/ipc.ts
- ... and 5 more

### Stats
- 1959 insertions, 452 deletions

## 2026-02-24

### What Changed
- Add ClawWork economics, bounty hunting, WA stability fixes

### Files (16 changed)
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- package.json
- src/bounty-gate.ts
- src/bounty-hunter.ts
- src/channels/whatsapp.ts
- src/clawwork.ts
- src/config.ts
- src/container-runner.ts
- src/dashboard.ts
- src/db.ts
- src/economics.ts
- src/index.ts
- src/ipc.ts
- src/types.ts
- src/whatsapp-auth.ts

### Stats
- 2425 insertions, 36 deletions

## 2026-02-23

### What Changed
- Add open mentions, OCR stack, and media pipeline fixes

### Files (9 changed)
- container/Dockerfile
- container/skills/ocr.sh
- groups/global/CLAUDE.md
- groups/main/CLAUDE.md
- src/channels/whatsapp.ts
- src/config.ts
- src/db.ts
- src/index.ts
- src/whatsapp-auth.ts

### Stats
- 507 insertions, 57 deletions

## 2026-02-22

### What Changed
- Decouple formatting test from `@Andy` (#329)
- feat: Claw-Prime identity, HITL gate, security hardening, DashClaw UI, and semantic index
- fix: use parameterized Python insert in schedule scripts
- fix: update deploy.sh for launchd + container/build.sh workflow
- fix: suppress duplicate message when streaming chunks already sent
- fix: use sendReaction for ACK and fire on every message
- perf: eliminate runtime tsc and lower streaming chunk size
- feat: warm container pool on startup
- Add media support for images and documents
- Add media safety improvements
- Add file type validation using magic bytes

### Files (37 changed)
- .claude/agents/auto-qa-security.md
- .claude/agents/human-typing-simulator.md
- .claude/agents/qa-reviewer.md
- .claude/settings.local.json
- .claude/skills/qa-review/agent.ts
- .claude/skills/qa-review/skill.json
- container/Dockerfile
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- container/skills/security-review/SKILL.md
- container/skills/self-audit/SKILL.md
- deploy.sh
- groups/global/CLAUDE.md
- groups/main/CLAUDE.md
- package-lock.json
- package.json
- scripts/com.nanoclaw.egress.plist
- scripts/nanoclaw-egress.conf
- scripts/schedule-security-review.sh
- scripts/schedule-self-audit.sh
- ... and 17 more

### Stats
- 4648 insertions, 672 deletions

## 2026-02-21

### What Changed
- docs: add nanoclaw.dev link to README header
- docs(zh): Apply stylistic and consistency improvements to README_zh.md (#328)
- docs: fix README_zh consistency and remove Skills System CLI section
- fix: copy skill subdirectories recursively (#175)
- fix: only preempt idle containers when scheduled tasks enqueue
- fix: correctly trigger idle preemption in streaming input mode
- test: add coverage for isTaskContainer and idleWaiting reset
- docs: update token count to 36.6k tokens · 18% of context window
- fix: update voice note test to match empty-content skip behavior
- fix: add .catch() handlers to fire-and-forget async calls (#221) (#355)
- docs: update token count to 36.8k tokens · 18% of context window

### Files (9 changed)
- README.md
- README_zh.md
- repo-tokens/badge.svg
- src/channels/whatsapp.test.ts
- src/container-runner.ts
- src/group-queue.test.ts
- src/group-queue.ts
- src/index.ts
- src/task-scheduler.ts

### Stats
- 313 insertions, 104 deletions

## 2026-02-20

### What Changed
- refactor: extract runtime-specific code into src/container-runtime.ts (#321)
- docs: update token count to 36.4k tokens · 18% of context window
- feat: convert container runtime from Apple Container to Docker (#323)
- docs: update token count to 36.3k tokens · 18% of context window
- docs: update skills to use Docker commands after runtime migration (#325)
- feat: add voice transcription as nanorepo skill (#326)
- feat: add /convert-to-apple-container skill, remove /convert-to-docker (#324)
- fix: pass filePath in setupRerereAdapter stale MERGE_HEAD cleanup

### Files (39 changed)
- .../add-discord/modify/src/index.ts.intent.md
- .../add-telegram/modify/src/index.ts.intent.md
- .../add/src/transcription.ts
- .../convert-to-apple-container/manifest.yaml
- .../modify/container/build.sh
- .../modify/container/build.sh.intent.md
- .../modify/src/channels/whatsapp.test.ts
- .../modify/src/channels/whatsapp.test.ts.intent.md
- .../modify/src/channels/whatsapp.ts
- .../modify/src/channels/whatsapp.ts.intent.md
- .../modify/src/container-runtime.test.ts
- .../modify/src/container-runtime.ts
- .../modify/src/container-runtime.ts.intent.md
- .../skills/add-voice-transcription/manifest.yaml
- .../tests/convert-to-apple-container.test.ts
- .../tests/voice-transcription.test.ts
- .claude/skills/add-parallel/SKILL.md
- .claude/skills/add-voice-transcription/SKILL.md
- .claude/skills/convert-to-apple-container/SKILL.md
- .claude/skills/convert-to-docker/SKILL.md
- ... and 19 more

### Stats
- 2692 insertions, 1143 deletions

## 2026-02-19

### What Changed
- Skills engine v0.1 + multi-channel infrastructure (#307)
- Documentation improvements
- Update README.md (#316)

### Files (84 changed)
- .../add-discord/add/src/channels/discord.test.ts
- .../add-discord/modify/src/config.ts.intent.md
- .../add-discord/modify/src/index.ts.intent.md
- .../add-telegram/add/src/channels/telegram.test.ts
- .../add-telegram/add/src/channels/telegram.ts
- .../add-telegram/modify/src/config.ts.intent.md
- .../add-telegram/modify/src/index.ts.intent.md
- .../skills/add-discord/add/src/channels/discord.ts
- .../skills/add-discord/modify/src/routing.test.ts
- .../skills/add-telegram/modify/src/routing.test.ts
- .claude/skills/add-discord/SKILL.md
- .claude/skills/add-discord/manifest.yaml
- .claude/skills/add-discord/modify/src/config.ts
- .claude/skills/add-discord/modify/src/index.ts
- .claude/skills/add-discord/tests/discord.test.ts
- .claude/skills/add-telegram/SKILL.md
- .claude/skills/add-telegram/manifest.yaml
- .claude/skills/add-telegram/modify/src/config.ts
- .claude/skills/add-telegram/modify/src/index.ts
- .claude/skills/add-telegram/tests/telegram.test.ts
- ... and 64 more

### Stats
- 13141 insertions, 608 deletions

## 2026-02-18

### What Changed
- chore: update Discord invite link
- Fix/WA reconnect, container perms, assist name in env (#297)
- docs: update token count to 35.6k tokens · 18% of context window
- fix: quote ASSISTANT_NAME in .env to handle special characters
- docs: update token count to 36.3k tokens · 18% of context window

### Files (7 changed)
- .claude/skills/setup/scripts/06-register-channel.sh
- README.md
- README_zh.md
- container/Dockerfile
- repo-tokens/badge.svg
- src/container-runner.ts
- src/whatsapp-auth.ts

### Stats
- 52 insertions, 18 deletions

## 2026-02-16

### What Changed
- feat: add setup skill with scripted steps (#258)
- chore: add nanoclaw profile and sales images
- chore: update social preview with new subtitle
- fix: ensure setup skill runs Docker conversion before building containers
- fix: skip empty WhatsApp protocol messages

### Files (20 changed)
- .../skills/setup/scripts/01-check-environment.sh
- .../skills/setup/scripts/06-register-channel.sh
- .../skills/setup/scripts/07-configure-mounts.sh
- .claude/skills/convert-to-docker/SKILL.md
- .claude/skills/setup/SKILL.md
- .claude/skills/setup/scripts/02-install-deps.sh
- .claude/skills/setup/scripts/03-setup-container.sh
- .claude/skills/setup/scripts/04-auth-whatsapp.sh
- .claude/skills/setup/scripts/05-sync-groups.sh
- .claude/skills/setup/scripts/05b-list-groups.sh
- .claude/skills/setup/scripts/08-setup-service.sh
- .claude/skills/setup/scripts/09-verify.sh
- .claude/skills/setup/{ => scripts}/qr-auth.html
- assets/nanoclaw-profile.jpeg
- assets/nanoclaw-sales.png
- assets/social-preview.jpg
- package-lock.json
- package.json
- src/channels/whatsapp.ts
- src/router.ts

### Stats
- 1914 insertions, 674 deletions

## 2026-02-15

### What Changed
- feat: add repo-tokens GitHub Action with token count badge
- feat: add is_bot_message column and support dedicated phone numbers (#235)
- fix: use GitHub App token for token count workflow
- fix: add git pull --rebase before push in token count workflow (#253)
- ci: add workflow_dispatch trigger to token count workflow (#254)
- docs: update token count to 35.5k tokens · 18% of context window

### Files (22 changed)
- .github/workflows/update-tokens.yml
- README.md
- package.json
- repo-tokens/README.md
- repo-tokens/action.yml
- repo-tokens/badge.svg
- repo-tokens/examples/green.svg
- repo-tokens/examples/red.svg
- repo-tokens/examples/yellow-green.svg
- repo-tokens/examples/yellow.svg
- src/channels/whatsapp.test.ts
- src/channels/whatsapp.ts
- src/config.ts
- src/container-runner.ts
- src/db.test.ts
- src/db.ts
- src/env.ts
- src/formatting.test.ts
- src/index.ts
- src/ipc.ts
- ... and 2 more

### Stats
- 625 insertions, 150 deletions

## 2026-02-14

### What Changed
- fix: typing indicator now shows on every message, not just the first

### Files (3 changed)
- src/channels/whatsapp.test.ts
- src/channels/whatsapp.ts
- src/index.ts

### Stats
- 7 insertions, 3 deletions

## 2026-02-13

### What Changed
- fix: pass requiresTrigger through IPC and auto-discover additional directories
- Merge pull request #84 from jiakeboge/feature/add-chinese-readme
- docs: update Chinese README and move language link to badge row
- security: sanitize env vars from agent Bash subprocesses (#171)
- security: pass secrets via SDK env option and delete temp file (#213)
- fix: send available presence on connect so typing indicators work consistently
- fix: use available instead of paused when stopping typing indicator
- fix: repair WhatsApp channel tests (missing Browsers mock and async flush)

### Files (8 changed)
- README.md
- README_zh.md
- container/Dockerfile
- container/agent-runner/src/index.ts
- src/channels/whatsapp.test.ts
- src/channels/whatsapp.ts
- src/container-runner.ts
- src/ipc.ts

### Stats
- 145 insertions, 66 deletions

## 2026-02-12

### What Changed
- chore: add /groups/ and /launchd/ to CODEOWNERS
- Add Apple Container Networking Setup documentation (#178)
- test: add comprehensive WhatsApp connector tests (#182)
- fix: WhatsApp auth improvements and LID translation for DMs

### Files (7 changed)
- .claude/skills/setup/SKILL.md
- .claude/skills/setup/qr-auth.html
- .github/CODEOWNERS
- docs/APPLE-CONTAINER-NETWORKING.md
- src/channels/whatsapp.test.ts
- src/channels/whatsapp.ts
- src/whatsapp-auth.ts

### Stats
- 1215 insertions, 29 deletions

## 2026-02-11

### What Changed
- Refactor index (#156)
- fix: prevent infinite message replay on container timeout (#164)

### Files (30 changed)
- .claude/skills/add-gmail/SKILL.md
- .claude/skills/add-telegram-swarm/SKILL.md
- .claude/skills/add-telegram/SKILL.md
- .claude/skills/customize/SKILL.md
- .claude/skills/debug/SKILL.md
- .claude/skills/x-integration/SKILL.md
- .github/workflows/test.yml
- CLAUDE.md
- README.md
- container/agent-runner/src/ipc-mcp-stdio.ts
- docs/SPEC.md
- package-lock.json
- package.json
- src/channels/whatsapp.ts
- src/config.ts
- src/container-runner.test.ts
- src/container-runner.ts
- src/db.test.ts
- src/db.ts
- src/formatting.test.ts
- ... and 10 more

### Stats
- 4648 insertions, 1538 deletions

## 2026-02-09

### What Changed
- Fix orphan container cleanup and update installation steps (#149)
- Adds Agent Swarms
- feat: add Telegram agent swarm skill
- fix: bust shields.io cache for Discord badge
- feat: move to Claude's native memory management
- docs: clarify agent swarms vs teams in Telegram skill

### Files (28 changed)
- .../{agent-browser.md => agent-browser/SKILL.md}
- .claude/skills/add-telegram-swarm/SKILL.md
- .claude/skills/add-telegram/SKILL.md
- .claude/skills/add-voice-transcription/SKILL.md
- .claude/skills/setup/SKILL.md
- .gitignore
- CLAUDE.md
- README.md
- container/Dockerfile
- container/agent-runner/package-lock.json
- container/agent-runner/package.json
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp-stdio.ts
- container/agent-runner/src/ipc-mcp.ts
- docs/DEBUG_CHECKLIST.md
- docs/REQUIREMENTS.md
- docs/SDK_DEEP_DIVE.md
- docs/SPEC.md
- groups/global/CLAUDE.md
- groups/main/CLAUDE.md
- ... and 8 more

### Stats
- 3834 insertions, 886 deletions

## 2026-02-08

### What Changed
- feat: Add /add-telegram skill for Telegram channel support (#83)

### Files (1 changed)
- .claude/skills/add-telegram/SKILL.md

### Stats
- 574 insertions, 0 deletions

## 2026-02-07

### What Changed
- fix: improve container error logging to include full stdout/stderr
- fix: setup skill reliability, requiresTrigger option, agent-browser visibility

### Files (10 changed)
- .claude/skills/setup/SKILL.md
- CLAUDE.md
- container/agent-runner/src/index.ts
- container/skills/agent-browser.md
- groups/global/CLAUDE.md
- groups/main/CLAUDE.md
- src/container-runner.ts
- src/db.ts
- src/index.ts
- src/types.ts

### Stats
- 117 insertions, 59 deletions

## 2026-02-06

### What Changed
- fix: proper container lifecycle management to prevent stopped container accumulation
- feat: per-group queue, SQLite state, graceful shutdown
- fix: address review feedback for per-group queue reliability
- feat: per-group queue, SQLite state, graceful shutdown (#111)
- fix: improve agent output schema, tool descriptions, and shutdown robustness
- small tweak to acknowledgement prompt
- fix: defend against missing structured output and message without content
- fix: replace hardcoded /Users/user fallback with os.homedir()

### Files (13 changed)
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp.ts
- groups/global/CLAUDE.md
- groups/main/CLAUDE.md
- src/config.ts
- src/container-runner.ts
- src/db.ts
- src/group-queue.ts
- src/index.ts
- src/mount-security.ts
- src/task-scheduler.ts
- src/types.ts
- src/utils.ts

### Stats
- 913 insertions, 275 deletions

## 2026-02-05

### What Changed
- Fix duplicate responses caused by reconnect-stacking loops
- feat: Add Chinese README and language switcher

### Files (4 changed)
- README.md
- README_zh.md
- src/index.ts
- src/task-scheduler.ts

### Stats
- 205 insertions, 6 deletions

## 2026-02-04

### What Changed
- Add X integration skill (#52)
- fix: translate WhatsApp LID JIDs to phone JIDs for self-chat messages (#62)
- Add voice transcription skill using OpenAI Whisper API (#77)

### Files (13 changed)
- .claude/skills/add-voice-transcription/SKILL.md
- .claude/skills/x-integration/SKILL.md
- .claude/skills/x-integration/agent.ts
- .claude/skills/x-integration/host.ts
- .claude/skills/x-integration/lib/browser.ts
- .claude/skills/x-integration/lib/config.ts
- .claude/skills/x-integration/scripts/like.ts
- .claude/skills/x-integration/scripts/post.ts
- .claude/skills/x-integration/scripts/quote.ts
- .claude/skills/x-integration/scripts/reply.ts
- .claude/skills/x-integration/scripts/retweet.ts
- .claude/skills/x-integration/scripts/setup.ts
- src/index.ts

### Stats
- 1969 insertions, 2 deletions

## 2026-02-03

### What Changed
- Improve setup UX with AskUserQuestion tool and security education (#60)
- Add prettier
- Update setup skill to use claude setup-token for auth
- Remove ToS gray areas section from README (#65)
- refactor: deduplicate logger into shared module (#39)

### Files (17 changed)
- .claude/skills/setup/SKILL.md
- .prettierrc
- README.md
- docs/SPEC.md
- groups/main/CLAUDE.md
- groups/nanoclaw-testing/CLAUDE.md
- package-lock.json
- package.json
- src/config.ts
- src/container-runner.ts
- src/db.ts
- src/index.ts
- src/logger.ts
- src/mount-security.ts
- src/task-scheduler.ts
- src/types.ts
- src/whatsapp-auth.ts

### Stats
- 1197 insertions, 759 deletions

## 2026-02-02

### What Changed
- Security improvements: per-group session isolation, remove built-in Gmail
- Add register_group IPC command for dynamic group registration
- Update README.md
- Update README.md
- Update README.md
- Update README.md
- Add /convert-to-docker skill for Docker migration (#23)
- Add /add-parallel skill for Parallel AI integration (#28)
- Fix minor issues in add-parallel skill
- Add Docker support and integrate /convert-to-docker into setup flow
- Add contribution guidelines and PR checks for skills-only model
- Add social preview image

### Files (20 changed)
- .claude/skills/add-parallel/SKILL.md
- .claude/skills/convert-to-docker/SKILL.md
- .claude/skills/debug/SKILL.md
- .claude/skills/setup/SKILL.md
- .github/CODEOWNERS
- .github/PULL_REQUEST_TEMPLATE.md
- .github/workflows/skills-only.yml
- .gitignore
- .mcp.json
- CLAUDE.md
- CONTRIBUTING.md
- README.md
- REQUIREMENTS.md => docs/REQUIREMENTS.md
- SPEC.md => docs/SPEC.md
- assets/social-preview.jpg
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp.ts
- docs/SECURITY.md
- src/container-runner.ts
- src/index.ts

### Stats
- 1046 insertions, 128 deletions

## 2026-02-01

### What Changed
- Fix container execution and add debug tooling
- Fix session persistence and auto-start container system
- Support OAuth token authentication as alternative to API key
- Rewrite documentation with project philosophy and RFS
- Update project and agent context files
- Rewrite README intro with balanced OpenClaw comparison
- Clean up README prose and add contribution FAQ
- Add typing indicator while agent is processing
- Add PreCompact hook for conversation archiving, remove /clear command
- Fix security issues: IPC auth, message logging, container logs
- Remove redundant comments throughout codebase
- Fix scheduled tasks and improve task scheduling UX
- Fix task deletion FK constraint error
- Refactor: delete dead code, extract utils, rename files for clarity
- Add NanoClaw logo and branding assets
- Update README.md
- Move Quick Start section above Philosophy
- Fix security: only expose auth vars to containers, not full .env
- Secure IPC with per-group namespaces to prevent privilege escalation
- Fix hardcoded home directory fallback in container runner
- Remove message content from info-level logs
- Fix message loss when processMessage throws
- Fix: only update lastAgentTimestamp on agent success
- Merge pull request #2 from gavrielc/claude/fix-dotenv-exposure-LEzJ8
- Merge pull request #7 from gavrielc/claude/fix-home-directory-fallback-FF5Tr
- Merge pull request #9 from gavrielc/claude/fix-sensitive-log-data-xb0E8
- Merge pull request #11 from gavrielc/claude/fix-message-loss-error-DJwye
- Merge pull request #12 from gavrielc/claude/fix-agent-failure-timestamp-yiOZt
- Merge pull request #3 from gavrielc/claude/secure-ipc-access-Ni9l4
- Apply fixes from closed PRs: sentinel markers, JID lookup, schedule validation
- Make main group respond to all messages without trigger prefix
- Add context_mode option for scheduled tasks
- Add group metadata sync for easier group activation
- Make OpenClaw critique specific with actual numbers
- Fix timezone handling and message filtering
- Add mount security allowlist for external directory access (#14)
- Pre-launch fixes: error handling, cleanup, consistency
- Fix group metadata sync setting epoch timestamp for new groups (#15)
- Escape regex metacharacters in ASSISTANT_NAME for trigger pattern (#16)
- Fix message cursor to only advance on successful processing (#17)
- Add container output size limiting to prevent memory issues (#18)
- Add /add-gmail skill for Gmail integration
- Add Qwibit Ops context and NanoClaw Testing group

### Files (38 changed)
- .claude/skills/add-gmail/SKILL.md
- .claude/skills/customize/SKILL.md
- .claude/skills/debug/SKILL.md
- .claude/skills/setup/SKILL.md
- .mcp.json
- CLAUDE.md
- README.md
- REQUIREMENTS.md
- SPEC.md
- assets/nanoclaw-favicon.png
- assets/nanoclaw-icon.png
- assets/nanoclaw-logo-dark.png
- assets/nanoclaw-logo.png
- config-examples/mount-allowlist.json
- container/Dockerfile
- container/agent-runner/package-lock.json
- container/agent-runner/package.json
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp.ts
- groups/CLAUDE.md
- ... and 18 more

### Stats
- 3696 insertions, 1204 deletions

## 2026-01-31

### What Changed
- Initial commit: NanoClaw - Personal Claude assistant via WhatsApp
- Fix: exit gracefully when auth needed in daemon mode
- Replace QR code display with macOS notification
- Separate WhatsApp auth from daemon into standalone script
- Improve setup skill: better Gmail explanation, use placeholders
- Extract config and types into separate files, clean up index.ts
- Extract database operations into separate db.ts module
- Remove unnecessary shutdown handlers
- Simplify runAgent: just pass the prompt
- Include missed messages when catching up the agent
- Keep trigger in prompt, simplify message formatting
- Store and display sender's WhatsApp name
- Use date + time format in message timestamps
- Update docs to reflect current architecture
- Add built-in scheduler with group-scoped tasks
- Add containerized agent execution with Apple Container
- Update setup skill for container architecture
- Mount project root for main channel

### Files (30 changed)
- .claude/skills/customize/SKILL.md
- .claude/skills/setup/SKILL.md
- .gitignore
- .mcp.json
- CLAUDE.md
- LICENSE
- README.md
- REQUIREMENTS.md
- SPEC.md
- container/Dockerfile
- container/agent-runner/package.json
- container/agent-runner/src/index.ts
- container/agent-runner/src/ipc-mcp.ts
- container/agent-runner/tsconfig.json
- container/build.sh
- container/skills/agent-browser.md
- groups/CLAUDE.md
- groups/main/CLAUDE.md
- launchd/com.nanoclaw.plist
- package-lock.json
- ... and 10 more

### Stats
- 7119 insertions, 762 deletions
