# A2A Protocol Evaluation for NanoClaw Team System

**Date:** 2026-03-18
**Status:** Technical evaluation
**Author:** LSP/Index Engineer (specialized agent)

---

## Table of Contents

1. [Current System Architecture](#1-current-system-architecture)
2. [A2A Protocol Architecture](#2-a2a-protocol-architecture)
3. [Gap Analysis](#3-gap-analysis)
4. [ADK Compatibility Assessment](#4-adk-compatibility-assessment)
5. [Migration Path Options](#5-migration-path-options)
6. [Recommendation](#6-recommendation)
7. [Implementation Checklist](#7-implementation-checklist-if-migrating)

---

## 1. Current System Architecture

### How TeamCreate/SendMessage Works Today

NanoClaw's multi-agent system follows a 4-step orchestration pipeline:

```
User Message → GoalClassifier → NanoClawOrchestrator
  ├── Step 1: GoalDecompositionEngine.decomposeGoal()
  ├── Step 2: TaskAcknowledgment.acknowledgeTask()
  ├── Step 3: TeamOrchestrator.formTeam()  (per recommended role)
  └── Step 4: TeamOrchestrator.assignTask() (round-robin)
```

**Entry point** (`src/index.ts`): When the goal classifier returns `shouldUseTeams: true` with `confidence: 'high'`, the system enters multi-agent mode via `NanoClawOrchestrator.processGoal()`.

**Team formation** (`src/team-orchestrator.ts`): Each team gets a lead agent (cloud model, 2GB RAM) plus up to 5 specialists. Roles include `lead`, `researcher`, `developer`, `reviewer`, `marketer`, `analyst`, `designer`, and `tester`. Model tier is selected by role: developers and designers get cloud models, researchers and analysts get local-llm, marketers and testers get local-slm.

**Task assignment**: Tasks are assigned round-robin to idle team members matching the required role. Member status transitions: `idle` → `working` → `idle` (on completion) or `blocked` (on dependency failure).

### Message Flow and State Management

Agents communicate through a file-based IPC system:

```
Container Agent
  │ writes JSON to /workspace/ipc/messages/{id}.json
  ▼
Host IPC Watcher (polls every ~100ms)
  │ reads JSON, processes request, deletes file
  ▼
Host Action (send WhatsApp message, update DB, etc.)
  │ writes response to /workspace/ipc/responses/{id}.response.json
  ▼
Container Agent polls for response file
```

Key characteristics:
- **Async, file-based**: no persistent connections between agents
- **Unidirectional per message**: agent writes request, host writes response
- **No direct agent-to-agent messaging**: all communication routes through the host
- **Dedup**: MD5 hash of `jid:text` prevents duplicate sends within 30-second window
- **Concurrency control**: max 2 concurrent `desktop_claude` instances via semaphore

### Database Schema and Persistence

Six tables power the team system:

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `teams` | Team metadata | `id`, `name`, `purpose`, `goal_id`, `lead_agent`, `status` |
| `team_members` | Individual agents | `team_id`, `agent_id`, `role`, `model_tier`, `priority`, `status`, `current_task` |
| `team_hierarchy` | Parent-child teams | `parent_team_id`, `child_team_id`, `relationship` |
| `goals` | High-level objectives | `id`, `description`, `target_value`, `deadline`, `status`, `priority` |
| `tasks` | Actionable work items | `id`, `goal_id`, `complexity`, `estimated_hours`, `status`, `dependencies`, `assigned_agent` |
| `agent_lifecycle` | Resource tracking | `agent_id`, `type`, `priority`, `ram_allocated_gb`, `model_tier`, `team_id` |

Team status lifecycle: `forming` → `active` → `completed` | `disbanded`
Task status lifecycle: `pending` → `in_progress` → `completed` | `blocked`

### Integration Points

- **ResourceOrchestrator** (`src/resource-orchestrator.ts`): RAM-aware agent scheduling with priority queuing. Limits: `min(16, TOTAL_RAM_GB / 4)` max agents, critical RAM (>90%) triggers low-priority agent termination.
- **GoalDecompositionEngine** (`src/goal-decomposition.ts`): Uses Claude to break goals into 3-5 sub-goals and 5-10 tasks with dependency graphs and critical path analysis.
- **ContainerRunner** (`src/container-runner.ts`): Spawns isolated containers with read-only project mounts, per-group writable mounts, and secrets via stdin.
- **GroupQueue** (`src/group-queue.ts`): Separates message and task slots to prevent message stalls from long-running tasks.

---

## 2. A2A Protocol Architecture

### Overview

The Agent-to-Agent (A2A) protocol is an open standard for inter-agent communication, created by Google in April 2025 and now governed by the Linux Foundation (Apache 2.0). Current release: v1.0.0 (March 12, 2026). Anthropic is a co-founder of the Agentic AI Foundation (AAIF) alongside Google, OpenAI, Microsoft, and AWS.

A2A operates on three layers:

| Layer | Purpose |
|-------|---------|
| **Canonical Data Model** | Protocol Buffers definitions: Task, Message, Part, Artifact, AgentCard |
| **Abstract Operations** | 11 transport-independent operations |
| **Protocol Bindings** | JSON-RPC 2.0, gRPC, HTTP/REST |

### Agent Card Schema and Discovery

Every A2A agent publishes a JSON document at `/.well-known/agent-card.json` describing its capabilities:

```json
{
  "name": "NanoClaw Research Agent",
  "url": "https://agents.nanoclaw.local/researcher",
  "version": "1.0.0",
  "description": "Web research and data gathering specialist",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true
  },
  "skills": [
    {
      "id": "web-research",
      "name": "Web Research",
      "description": "Searches and synthesizes information from web sources",
      "tags": ["research", "search", "analysis"],
      "inputModes": ["text"],
      "outputModes": ["text"]
    }
  ],
  "authentication": {
    "schemes": ["apiKey"]
  }
}
```

Discovery is passive (well-known URL) or active (registry lookup). v1.0 adds `supportedInterfaces[]` for multi-protocol agents and JWS-signed cards (RFC 7515).

### 11 Core Operations

| # | Operation | Transport | Description |
|---|-----------|-----------|-------------|
| 1 | `message/send` | POST | Send message, receive Task or Message |
| 2 | `message/stream` | SSE | Send message with streaming response |
| 3 | `tasks/get` | GET | Retrieve task state and artifacts |
| 4 | `tasks/list` | GET | Paginated task listing with filters |
| 5 | `tasks/cancel` | POST | Request task cancellation |
| 6 | `tasks/resubscribe` | SSE | Re-establish streaming for existing task |
| 7 | `pushNotificationConfig/set` | POST | Register webhook for async updates |
| 8 | `pushNotificationConfig/get` | GET | Retrieve webhook config |
| 9 | `pushNotificationConfig/list` | GET | List all webhook configs |
| 10 | `pushNotificationConfig/delete` | DELETE | Remove webhook config |
| 11 | `agent/getAuthenticatedExtendedCard` | GET | Detailed card post-auth |

Minimum viable implementation requires only operations 1 and 3 (`message/send` and `tasks/get`).

### Task Lifecycle and State Management

```
submitted ──► working ──► completed
                │    ──► failed
                │    ──► canceled
                ▼
          input-required ──► working ──► (terminal)
          auth-required  ──► working ──► (terminal)
```

Terminal states: `completed`, `failed`, `canceled`, `rejected`. Non-terminal states: `submitted`, `working`, `input-required`, `auth-required`.

Each state transition carries a timestamp. The `TaskStatus` object includes `state`, `message` (optional context), and `timestamp`.

### Protocol Bindings

**JSON-RPC 2.0** (recommended for most implementations):
```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{"text": "Research competitor pricing"}],
      "messageId": "msg-001"
    }
  },
  "id": "req-001"
}
```

**gRPC**: Proto definitions at `spec/a2a.proto`. Server-streaming for `SendStreamingMessage` and `TaskSubscription`.

**HTTP/REST**: RESTful endpoints like `GET /v1/tasks/{id}`, `POST /v1/message:send`. v1.0 errors use ProtoJSON `google.rpc.Status`.

### Authentication and Security

| Mechanism | Use Case |
|-----------|----------|
| API Key | Simple internal agents |
| HTTP Auth (Basic/Bearer) | Token-based access |
| OAuth 2.0 | External agent federation (v1.0 adds PKCE + Device Code) |
| OpenID Connect | Identity federation |
| Mutual TLS | High-security agent meshes |

Production requirements: HTTPS mandatory, TLS 1.3+ recommended, authenticate every request, validate all parameters.

---

## 3. Gap Analysis

### Feature Parity Comparison

| Capability | NanoClaw Current | A2A Protocol | Gap |
|------------|-----------------|--------------|-----|
| **Agent discovery** | Hardcoded roles in TeamOrchestrator | Agent Cards at well-known URLs | NanoClaw has no discovery mechanism |
| **Message format** | Unstructured JSON via IPC files | Typed Messages with Parts (text, file, data) | A2A is richer and standardized |
| **Task states** | 4 states (pending, in_progress, completed, blocked) | 9 states including auth-required, input-required, rejected | A2A covers more edge cases |
| **Streaming** | Not supported (poll-based IPC) | SSE streaming built-in | NanoClaw lacks real-time updates |
| **Push notifications** | Not supported | Webhook-based push | NanoClaw requires polling |
| **Authentication** | Implicit (same-host trust) | 5 auth mechanisms | NanoClaw has no inter-agent auth |
| **Multi-turn conversations** | Via session IDs in ContainerInput | Via `contextId` grouping messages and tasks | Conceptually similar |
| **Task dependencies** | Explicit `dependencies[]` in tasks table | Not built-in (application-level concern) | NanoClaw is stronger here |
| **Resource management** | RAM-aware scheduling, priority queues | Not specified (host concern) | NanoClaw is stronger here |
| **Hierarchical teams** | team_hierarchy table, sub-team formation | Not built-in (flat peer model) | NanoClaw is stronger here |
| **Role-based agents** | 8 typed roles with model tier selection | Skills-based capability description | Different paradigms |
| **Persistence** | SQLite with full audit trail | Not specified (implementation choice) | NanoClaw is more opinionated |
| **External interop** | None (closed system) | Core design goal | A2A's primary advantage |
| **Artifacts** | IPC response files | Typed Artifacts with metadata | A2A is more structured |
| **Error handling** | Custom per-IPC-type | Standardized error codes (-32001, -32002, etc.) | A2A is more robust |
| **Protocol spec** | Undocumented internal protocol | Formal spec with proto definitions | A2A is production-grade |
| **Cancellation** | Not supported | `tasks/cancel` operation | NanoClaw lacks graceful cancel |
| **Pagination** | Not applicable | Cursor-based pagination for task lists | A2A scales to many tasks |

### What A2A Provides That Current System Lacks

1. **Standardized discovery**: Any A2A-compliant agent can find and communicate with NanoClaw agents without custom integration code.
2. **External interoperability**: NanoClaw agents could collaborate with agents built on LangChain, CrewAI, ADK, or any A2A-compliant framework.
3. **Streaming responses**: Real-time progress updates instead of file polling.
4. **Formal authentication**: Proper auth between agents, critical if NanoClaw agents ever serve external clients.
5. **Task cancellation**: Graceful abort mechanism with proper state transitions.
6. **Typed content model**: Parts (text, file, data) with MIME types instead of unstructured JSON.
7. **Industry backing**: 50+ launch partners, Linux Foundation governance, SDKs in 5 languages.

### What Current System Provides That A2A Lacks

1. **Resource orchestration**: RAM-aware scheduling, priority queuing, critical-RAM preemption. A2A is transport-only and says nothing about resource management.
2. **Hierarchical team structure**: Parent/child team relationships, sub-team delegation. A2A assumes flat peer topology.
3. **Task dependency graphs**: Explicit blocking dependencies with critical path computation. A2A tasks are independent units.
4. **Goal decomposition**: Automated breakdown of high-level goals into sub-goals and tasks. A2A has no planning layer.
5. **Model tier selection**: Automatic model selection based on agent role and system resources. A2A is model-agnostic by design.
6. **Container isolation**: Per-agent filesystem isolation with read-only project mounts. A2A doesn't address execution environments.
7. **Integrated persistence**: Full SQLite audit trail with lifecycle tracking. A2A leaves storage to implementations.

### Conceptual Alignment vs Mismatches

**Aligned:**
- Both use task-based models with state machines
- Both support async communication patterns
- Both separate message content from transport
- NanoClaw's `ContainerInput.sessionId` maps to A2A's `contextId`
- NanoClaw's IPC message types map roughly to A2A operations

**Mismatched:**
- NanoClaw is **orchestrator-centric** (host controls everything); A2A is **peer-to-peer** (agents communicate directly)
- NanoClaw agents are **ephemeral containers**; A2A agents are **persistent services**
- NanoClaw uses **file-based IPC**; A2A uses **HTTP/gRPC**
- NanoClaw teams are **hierarchical**; A2A relationships are **flat**
- NanoClaw assigns work **top-down**; A2A agents **negotiate** via message exchange

---

## 4. ADK Compatibility Assessment

### Does Google's ADK Support Claude Models?

**Yes, confirmed.** Multiple integration paths:

| Method | Language | Example |
|--------|----------|---------|
| LiteLLM wrapper | Python | `LiteLlm(model="anthropic/claude-sonnet-4-20250514")` |
| Native Claude class | Java | `com.google.adk.models.Claude` with `AnthropicOkHttpClient` |
| Vertex AI | All | Access Anthropic models through Google Cloud |
| Multi-provider | Go | Unified interface supporting Gemini + Claude |

ADK is explicitly model-agnostic: "you can use any large language model (LLM) with it."

### Can NanoClaw Agents Be A2A-Compliant While Using Claude SDK?

**Yes, but with architectural changes.** The key challenge is NanoClaw's ephemeral container model vs A2A's assumption of persistent agent services.

Two approaches:

**Approach 1: Host as A2A proxy** — The NanoClaw host process exposes A2A endpoints and translates between A2A protocol messages and internal IPC. Agents remain ephemeral containers; the host maintains A2A task state.

```
External Agent ──A2A──► NanoClaw Host (A2A server)
                              │
                        translates to IPC
                              │
                              ▼
                        Container Agent (Claude SDK)
```

**Approach 2: Per-agent A2A servers** — Each agent runs its own A2A HTTP server inside the container. Requires persistent containers (not ephemeral).

Approach 1 is far more compatible with the current architecture.

### What ADK Components Would Be Needed vs Custom

| Component | ADK Provides | Custom Needed |
|-----------|-------------|---------------|
| A2A server scaffold | Yes (Python/Go) | TypeScript wrapper needed |
| Agent Card generation | Yes | Mapping from roles to skills |
| Task state machine | Yes | Integration with existing DB schema |
| Streaming (SSE) | Yes | Integration with IPC watcher |
| Multi-agent orchestration | Yes (SequentialAgent, etc.) | Already have TeamOrchestrator |
| Resource management | No | Keep existing ResourceOrchestrator |
| Container execution | No | Keep existing ContainerRunner |
| Claude model integration | Yes | Already using Claude SDK directly |

**Verdict**: ADK's value for NanoClaw is primarily in the A2A server/client scaffolding. The orchestration, resource management, and execution components are better served by NanoClaw's existing systems. Using the **`@a2a-js/sdk`** TypeScript SDK directly (without ADK) is likely the most practical path.

---

## 5. Migration Path Options

### Option A: Full Migration to A2A

**What changes:**
- Replace IPC file-based messaging with A2A JSON-RPC endpoints
- Convert TeamOrchestrator to use A2A `message/send` for task dispatch
- Replace custom task states with A2A task lifecycle
- Expose Agent Cards for all agent roles
- Add HTTP server to NanoClaw host for A2A endpoints

**Implementation steps:**
1. Add `@a2a-js/sdk` dependency
2. Create A2A HTTP server in NanoClaw host process (port 9100+)
3. Generate Agent Cards from existing role definitions
4. Implement `message/send` handler that translates to container spawning
5. Implement `tasks/get` handler that queries existing tasks table
6. Map existing task states to A2A states (`pending`→`submitted`, `in_progress`→`working`, etc.)
7. Replace IPC watcher with A2A streaming responses
8. Update container agents to communicate via A2A client SDK
9. Migrate database schema (add A2A-specific fields)
10. Remove legacy IPC system

**Breaking changes:**
- All container-side IPC code must be rewritten
- Container agents need HTTP client capability (network access)
- Task state values change in database
- GroupQueue needs redesign (no more file polling)
- desktop_claude IPC handler needs A2A wrapper

**Estimated effort:** 3-4 weeks for one developer. High risk of regression.

**Risks:**
- Container networking adds complexity (currently containers communicate via mounted filesystem only)
- Persistent HTTP connections consume more resources than file-based IPC
- Debugging HTTP-based IPC is harder than reading JSON files on disk
- A2A v1.0 has breaking changes from v0.x; the spec may continue evolving
- Loss of NanoClaw-specific features (hierarchical teams, dependency graphs) unless custom extensions are added

### Option B: Hybrid Approach (Recommended)

**What changes:**
- Keep internal team system as-is
- Add A2A compatibility layer as a new module (`src/a2a-bridge.ts`)
- Expose Agent Cards for external discovery
- Internal teams use current IPC; external agents use A2A
- A2A bridge translates between protocols

**Implementation steps:**
1. Add `@a2a-js/sdk` dependency
2. Create `src/a2a-bridge.ts` — A2A HTTP server on configurable port
3. Generate Agent Cards from TeamOrchestrator role definitions:
   ```typescript
   // Map NanoClaw roles to A2A skills
   const roleToSkill: Record<AgentRole, AgentSkill> = {
     researcher: { id: 'research', name: 'Web Research', ... },
     developer: { id: 'code', name: 'Code Development', ... },
     // ...
   };
   ```
4. Implement `message/send` → internal task creation bridge:
   ```typescript
   // A2A message/send handler
   async handleSendMessage(message: A2AMessage): Promise<A2ATask> {
     // Create internal task
     const taskId = await createTask({
       description: extractText(message.parts),
       source: 'a2a',
       priority: 50,
     });
     // Return A2A task reference
     return { id: taskId, status: { state: 'submitted' } };
   }
   ```
5. Implement `tasks/get` → internal task state query
6. Implement `tasks/cancel` → internal task status update
7. Add SSE streaming for real-time updates (optional, phase 2)
8. Serve Agent Card at `/.well-known/agent-card.json`
9. Add API key authentication for A2A endpoints

**What stays the same:**
- TeamOrchestrator, GoalDecompositionEngine, ResourceOrchestrator — untouched
- IPC file-based system for internal agent communication — untouched
- Container execution model — untouched
- Database schema — minor additions only (add `source: 'a2a'` tracking)

**Estimated effort:** 1-2 weeks for one developer. Low risk.

**Architecture diagram:**
```
                    ┌──────────────────────────────┐
                    │        NanoClaw Host          │
                    │                               │
External Agent ─A2A─► A2A Bridge (src/a2a-bridge.ts)│
                    │     │                         │
                    │     ▼                         │
                    │  TaskOrchestrator (existing)   │
                    │     │                         │
                    │     ▼                         │
WhatsApp ──────────►│  GroupQueue (existing)         │
                    │     │                         │
                    │     ▼                         │
                    │  ContainerRunner (existing)    │
                    │     │                         │
                    │     ▼                         │
                    │  IPC Watcher (existing)        │
                    └──────────────────────────────┘
```

### Option C: Stay with Current System

**When this makes sense:**
- NanoClaw remains a single-user personal assistant with no external agent consumers
- No need to interoperate with LangChain, CrewAI, or other frameworks
- The current IPC system meets all performance and reliability requirements
- Development time is better spent on agent capabilities than protocol compliance

**What we sacrifice:**
- No external agent discovery or interoperability
- No participation in the emerging A2A ecosystem
- Custom protocol knowledge stays locked in the codebase
- If A2A becomes the industry standard, retrofitting later is costlier than building incrementally now

**Future-proofing considerations:**
- A2A has strong institutional backing (Linux Foundation, Google, Anthropic, AWS, OpenAI)
- 50+ launch partners including major enterprise vendors
- ~35% of AI-focused enterprises actively exploring A2A adoption
- Claude Code, Claude Desktop, and Claude on the web already support A2A natively
- The protocol is stabilizing (v1.0 released March 2026)

---

## 6. Recommendation

### Option B: Hybrid Approach

**Rationale:**

1. **Preserves investment**: NanoClaw's ResourceOrchestrator, hierarchical teams, dependency graphs, and goal decomposition are genuinely more advanced than what A2A specifies. Discarding them for A2A compliance would be a net loss.

2. **Enables interoperability at low cost**: A thin A2A bridge (estimated ~500 lines of TypeScript) opens NanoClaw to the entire A2A ecosystem without disrupting internals.

3. **Incremental risk**: The bridge is additive. If A2A doesn't pan out, remove one file. If it succeeds, expand the bridge.

4. **Anthropic alignment**: Anthropic is an AAIF co-founder. Claude's native A2A support means NanoClaw agents could eventually participate in cross-platform agent collaboration natively.

5. **External use case**: If NanoClaw ever exposes agents as services (for Lexios integration, or multi-user scenarios), A2A is the right protocol for that boundary.

6. **Internal use case preserved**: The file-based IPC system is simple, debuggable (you can `cat` the JSON files), and perfectly adequate for same-host container communication. No reason to replace it.

**When to escalate to Option A (full migration):**
- NanoClaw agents need to communicate across network boundaries (multi-host deployment)
- External agents need to join NanoClaw teams as first-class members
- The IPC file system becomes a bottleneck (unlikely at current scale)

**Timeline (if proceeding with Option B):**

| Phase | Scope | Duration |
|-------|-------|----------|
| Phase 1 | Agent Card generation + `message/send` + `tasks/get` | 3-5 days |
| Phase 2 | `tasks/cancel` + API key auth + error handling | 2-3 days |
| Phase 3 | SSE streaming for task updates | 2-3 days |
| Phase 4 | Testing with external A2A client (e.g., ADK sample) | 1-2 days |

Total: ~2 weeks with testing.

---

## 7. Implementation Checklist (If Migrating)

### Agent Card Generation

- [ ] Define skill mappings for all 8 agent roles
- [ ] Generate Agent Card JSON from TeamOrchestrator role definitions
- [ ] Serve at `/.well-known/agent-card.json` on A2A HTTP port
- [ ] Include `capabilities.streaming: true` if implementing SSE
- [ ] Declare `protocolVersions: ["1.0.0"]`

### Protocol Binding Selection

**Recommended: JSON-RPC 2.0** over HTTP

Rationale:
- Matches NanoClaw's existing JSON-centric IPC patterns
- Simplest to implement in Node.js (Express/Fastify + `@a2a-js/sdk`)
- No proto compilation needed (vs gRPC)
- Most A2A implementations use JSON-RPC as primary binding
- REST is an option but JSON-RPC has better tooling support in the A2A ecosystem

### Authentication Scheme

- [ ] Phase 1: API Key auth (simple, sufficient for local/trusted agents)
- [ ] Phase 2: Bearer token auth (for Cloudflare tunnel exposure)
- [ ] Phase 3: OAuth 2.0 with PKCE (if exposing to untrusted external agents)
- [ ] Store API keys in `.env` (existing secrets management pattern)
- [ ] Validate every request per A2A spec requirement

### Task State Mapping

| NanoClaw State | A2A State | Notes |
|---------------|-----------|-------|
| `pending` | `submitted` | Task created, not yet assigned |
| `in_progress` | `working` | Agent actively processing |
| `completed` | `completed` | Terminal success |
| `blocked` | `input-required` | Closest match; blocked on dependency |
| *(new)* | `canceled` | Add cancel support |
| *(new)* | `failed` | Distinguish from blocked |
| *(new)* | `rejected` | Agent refuses task (e.g., capability mismatch) |

- [ ] Add `canceled`, `failed`, `rejected` to tasks table status enum
- [ ] Create bidirectional mapping functions in `src/a2a-bridge.ts`
- [ ] Ensure state transitions follow A2A rules (no terminal → non-terminal)

### Streaming Support

- [ ] Use SSE (Server-Sent Events) for `message/stream` and `tasks/resubscribe`
- [ ] Emit `TaskStatusUpdateEvent` on task state changes
- [ ] Emit `TaskArtifactUpdateEvent` when agent produces output
- [ ] Hook into IPC watcher to detect state changes and push to SSE clients
- [ ] Set `Content-Type: text/event-stream` on streaming responses

### Testing Strategy

- [ ] Unit tests for Agent Card generation
- [ ] Unit tests for state mapping (NanoClaw ↔ A2A)
- [ ] Integration test: send A2A `message/send`, verify task creation
- [ ] Integration test: poll `tasks/get`, verify state updates
- [ ] Integration test: `tasks/cancel`, verify graceful termination
- [ ] E2E test: ADK sample client → NanoClaw A2A bridge → container agent → response
- [ ] Load test: concurrent A2A requests alongside WhatsApp messages
- [ ] Security test: unauthenticated requests rejected, invalid payloads handled

### Deployment Rollout

- [ ] Phase 1: A2A server runs alongside existing system (no changes to WhatsApp flow)
- [ ] Phase 2: Expose via Cloudflare tunnel (alongside DashClaw)
- [ ] Phase 3: Register NanoClaw agents in external A2A registries (if applicable)
- [ ] Feature flag: `A2A_ENABLED=true` in `.env` to toggle bridge
- [ ] Monitor: log all A2A requests separately for debugging

---

## References

- [A2A Protocol Specification v1.0](https://a2a-protocol.org/latest/specification/)
- [A2A GitHub Repository](https://github.com/a2aproject/A2A)
- [A2A and MCP Relationship](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)
- [What's New in A2A v1.0](https://a2a-protocol.org/latest/whats-new-v1/)
- [Google ADK Documentation](https://google.github.io/adk-docs/)
- [ADK Anthropic/Claude Support](https://google.github.io/adk-docs/agents/models/anthropic/)
- [ADK A2A Integration](https://google.github.io/adk-docs/a2a/)
- [A2A JS/TypeScript SDK](https://www.npmjs.com/package/@a2a-js/sdk)
- [AWS Bedrock AgentCore A2A Contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a-protocol-contract.html)
- [IBM: What Is Agent2Agent Protocol?](https://www.ibm.com/think/topics/agent2agent-protocol)
- [Auth0: MCP vs A2A Guide](https://auth0.com/blog/mcp-vs-a2a/)
- [CrewAI A2A Agent Delegation](https://docs.crewai.com/en/learn/a2a-agent-delegation)
- [Semgrep: Security Guide to A2A](https://semgrep.dev/blog/2025/a-security-engineers-guide-to-the-a2a-protocol/)
