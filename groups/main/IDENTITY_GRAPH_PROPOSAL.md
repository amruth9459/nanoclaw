# Identity Graph + Workflow State Machine — Implementation Proposal

**For:** NanoClaw
**Author:** Identity Graph Operator (specialized) via Auto-Dispatch
**Companion doc:** `GOOGLE_ADK_ANALYSIS.md`
**Date:** 2026-05-28
**Task:** task_1778778057698_j69ys9i

---

## 0. TL;DR

Add two new, *independent* subsystems to NanoClaw:

1. **Entity Resolution Graph** (`src/entity-graph/`) — canonical IDs for people, companies, and external resources referenced across messages, tasks, and tools. Distinct from agent identity (`src/identity/`).
2. **Workflow State Machine** (`src/workflow-state.ts`) — durable per-team workflow state, atomic transitions, pause/resume primitives. Inspired by Google ADK's `SessionService` pattern.

Both share an **atomic state-delta** discipline: every transition is one DB transaction, version-checked, audit-logged via the existing `evidence-chain`.

**Why both, why now:**
- Teams already produce duplicate records when entities are referenced ambiguously (gap D in analysis).
- Multi-day workflows degrade as conversation history grows (gap A).
- The two share a write primitive — building them together amortizes cost.

---

## 1. Scope Boundaries (read this first)

| System | Purpose | File location | Auth model |
|---|---|---|---|
| **`src/identity/`** (exists) | Authenticate *agents*. "Did agent X actually do Y?" | `src/identity/*.ts` | Ed25519 keypairs, evidence chains, trust scores |
| **`src/entity-graph/`** (new) | Canonicalize *entities* mentioned in agent work. "Is 'Sarah from Acme' the same as 'S. Chen'?" | `src/entity-graph/*.ts` | Provenance + match-confidence + HITL approval |
| **`src/workflow-state.ts`** (new) | Persist *workflow position*. "What step is this team on?" | `src/workflow-state.ts` | Optimistic concurrency via version counter |

**Non-goals:**
- The entity graph is **not** a CRM. No marketing, no enrichment APIs in v1.
- The workflow state is **not** a BPMN engine. Linear-ish DAGs with explicit transitions, not visual orchestration.
- We do **not** rename or extend `src/identity/`. The naming overlap is unfortunate but the systems must stay independent — touching one should never break the other.

---

## 2. Entity Resolution Graph

### 2.1 Data Model

```sql
-- The canonical entity. Stable ID, conservative attribute set.
CREATE TABLE entities (
  id TEXT PRIMARY KEY,              -- entity_<ulid>
  kind TEXT NOT NULL,               -- 'person' | 'company' | 'resource'
  canonical_name TEXT NOT NULL,     -- best-confidence name
  attributes JSON NOT NULL,         -- {email, phone, domain, ...}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 -- bumped on every write
);

-- Aliases: every observed surface form for an entity.
CREATE TABLE entity_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  surface_form TEXT NOT NULL,       -- "Sarah Chen", "S. Chen", "sarah@acme.com"
  normalized TEXT NOT NULL,         -- lowercased, NFKC, whitespace-collapsed
  source TEXT NOT NULL,             -- 'whatsapp_msg', 'task', 'tool_output'
  source_ref TEXT,                  -- message_id, task_id, etc.
  observed_at INTEGER NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);
CREATE INDEX idx_alias_normalized ON entity_aliases(normalized);
CREATE INDEX idx_alias_entity ON entity_aliases(entity_id);

-- Provenance: every claim made about an entity, with the agent that made it.
CREATE TABLE entity_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,           -- joins to src/identity/ agents table
  claim_type TEXT NOT NULL,         -- 'email', 'role', 'company_member'
  claim_value TEXT NOT NULL,
  confidence REAL NOT NULL,         -- 0.0-1.0
  signature TEXT,                   -- optional Ed25519 sig from agent
  observed_at INTEGER NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entities(id)
);

-- Match proposals: when the resolver is unsure, a proposal sits here for HITL.
CREATE TABLE match_proposals (
  id TEXT PRIMARY KEY,              -- proposal_<ulid>
  entity_a TEXT NOT NULL,
  entity_b TEXT NOT NULL,
  score REAL NOT NULL,              -- 0.0-1.0 combined match score
  reasons JSON NOT NULL,            -- {name_match: 0.9, email_match: 1.0, ...}
  status TEXT NOT NULL,             -- 'pending' | 'approved' | 'rejected' | 'expired'
  proposed_by_agent TEXT NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT,                 -- agent_id or 'human:user_id'
  created_at INTEGER NOT NULL,
  FOREIGN KEY (entity_a) REFERENCES entities(id),
  FOREIGN KEY (entity_b) REFERENCES entities(id)
);

-- The graph: typed relationships between entities.
CREATE TABLE entity_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity TEXT NOT NULL,
  to_entity TEXT NOT NULL,
  edge_type TEXT NOT NULL,          -- 'works_at', 'owns', 'reports_to'
  attributes JSON,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (from_entity) REFERENCES entities(id),
  FOREIGN KEY (to_entity) REFERENCES entities(id),
  UNIQUE (from_entity, to_entity, edge_type)
);
```

### 2.2 Resolution Algorithm

When an agent observes a surface form like `"Sarah Chen (sarah@acme.com)"`:

1. **Normalize** — NFKC, lowercase, strip punctuation. Extract structured atoms (email, phone).
2. **Exact-match lookup** — query `entity_aliases.normalized`. If unique hit → return entity_id.
3. **Strong-signal match** — if email or phone matches exactly → return entity_id.
4. **Fuzzy candidate scan** — generate candidate set by name-prefix + domain match. Score each via:
   - Levenshtein on name (weight 0.4)
   - Domain match on email (weight 0.3)
   - Co-occurrence in same conversation/task (weight 0.2)
   - Time recency (weight 0.1)
5. **Threshold decision:**
   - `score >= 0.85` → auto-link, insert alias, write `entity_evidence`.
   - `0.55 <= score < 0.85` → create `match_proposal`, return temporary entity, surface to HITL.
   - `score < 0.55` → create new entity, fresh ID.

### 2.3 API (TypeScript signatures)

```typescript
// src/entity-graph/resolver.ts
export interface ResolveRequest {
  kind: 'person' | 'company' | 'resource';
  surface_form: string;
  hints?: {
    email?: string;
    phone?: string;
    domain?: string;
    context_message_id?: string;
  };
  agent_id: string;  // who is asking
}

export interface ResolveResult {
  entity_id: string;
  confidence: number;
  is_new: boolean;
  proposal_id?: string;  // set if HITL pending
}

export class EntityResolver {
  resolve(req: ResolveRequest): Promise<ResolveResult>;
  link(entityA: string, entityB: string, agent_id: string): Promise<void>;
  addEvidence(entity_id: string, claim: EvidenceClaim): Promise<void>;
  getEntity(id: string): Promise<Entity | null>;
  searchByAlias(query: string): Promise<Entity[]>;
}
```

### 2.4 IPC Tools (container-facing)

| Tool | Purpose |
|---|---|
| `entity_resolve` | Wraps `EntityResolver.resolve()` — most common call from agents |
| `entity_link` | Merge two entities (requires confidence > 0.85 or HITL approval) |
| `entity_get` | Fetch entity by ID — includes aliases + recent evidence |
| `entity_propose_merge` | Submit a HITL proposal — appears in DashClaw UI |
| `entity_search` | Fuzzy search by name fragment |

### 2.5 HITL Integration

Match proposals appear in DashClaw's existing HITL queue (`src/hitl.ts`). User sees side-by-side comparison:

```
Proposal proposal_01HF... [score: 0.72]
  A: Sarah Chen | aliases: [Sarah, sarah@acme.com] | seen 4×
  B: S. Chen    | aliases: [S. Chen]               | seen 1×
  Reasons: name_match=0.85, domain_overlap=0.0, co_occurrence=0.6
  [Merge] [Reject] [Snooze]
```

---

## 3. Workflow State Machine

### 3.1 Data Model

```sql
CREATE TABLE workflow_states (
  workflow_id TEXT PRIMARY KEY,     -- wf_<ulid>
  team_id TEXT,                     -- nullable; not all workflows are team-owned
  group_id TEXT NOT NULL,           -- isolation boundary
  workflow_type TEXT NOT NULL,      -- 'onboarding' | 'bounty_pursuit' | 'extraction_review'
  current_step TEXT NOT NULL,       -- state machine node
  state_blob JSON NOT NULL,         -- atomic state payload
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,             -- 'active' | 'paused' | 'completed' | 'failed'
  paused_at INTEGER,
  continuation_token TEXT,          -- random hex, used to resume
  expected_event TEXT,              -- 'webhook' | 'human_approval' | 'scheduled'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_wf_group ON workflow_states(group_id);
CREATE INDEX idx_wf_token ON workflow_states(continuation_token) WHERE continuation_token IS NOT NULL;

CREATE TABLE workflow_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  from_step TEXT NOT NULL,
  to_step TEXT NOT NULL,
  delta JSON NOT NULL,              -- what changed in state_blob
  actor_agent_id TEXT NOT NULL,
  evidence_record_id TEXT,          -- joins to src/identity/ evidence chain
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflow_states(workflow_id)
);
```

### 3.2 Atomic Transition Primitive

```typescript
// src/workflow-state.ts
export interface TransitionRequest {
  workflow_id: string;
  expected_version: number;         // optimistic concurrency
  from_step: string;
  to_step: string;
  delta: Record<string, unknown>;   // merged into state_blob
  actor_agent_id: string;
}

export interface TransitionResult {
  success: boolean;
  new_version?: number;
  reason?: 'stale_version' | 'illegal_transition' | 'workflow_paused';
}

export class WorkflowStateMachine {
  // ONE transaction: read version, validate, merge delta, write, increment, log.
  transition(req: TransitionRequest): TransitionResult;
  pause(workflow_id: string, expected_event: string): { continuation_token: string };
  resume(continuation_token: string, delta: Record<string, unknown>): TransitionResult;
  get(workflow_id: string): WorkflowState | null;
}
```

The implementation wraps everything in `db.transaction(() => { ... })` (better-sqlite3). On version mismatch, return `stale_version` — the caller retries with fresh state. This is the ADK `state_delta` discipline ported to SQLite.

### 3.3 IPC Tools (container-facing)

| Tool | Purpose |
|---|---|
| `workflow_get` | Returns current step + state_blob. Agents read this *instead of* scanning messages. |
| `workflow_transition` | Atomic step + delta write. Rejects stale versions. |
| `workflow_pause` | Returns continuation token; container can safely exit. |
| `workflow_resume` | Host-only — invoked by webhook handler with token + delta. |
| `workflow_list_active` | For team leads — what workflows is my team driving? |

### 3.4 Pause / Resume Flow

```
Container Agent              Host                       External
     |                        |                            |
     |--workflow_pause()----->|                            |
     |<-{token: "abc123"}-----|                            |
     |                        |                            |
     | (container exits)      |                            |
     |                        |                            |
     |                        |<--webhook POST {token,-----|
     |                        |    state_delta}            |
     |                        |                            |
     |                        |--workflow_resume()         |
     |                        |   (atomic merge)           |
     |                        |                            |
     |                        |--spawn container w/--------|
     |                        |   resumed workflow_id      |
     |<-(re-spawned, reads----|                            |
     |   current_step)        |                            |
```

### 3.5 Webhook Surface

New file `src/channels/webhook.ts`:

```typescript
// POST /webhook/workflow/resume
// Body: { continuation_token, state_delta, signature? }
// Optional HMAC verification via shared secret per external system.
app.post('/webhook/workflow/resume', async (req, res) => {
  const { continuation_token, state_delta } = req.body;
  const result = await workflowSM.resume(continuation_token, state_delta);
  if (!result.success) return res.status(409).json({ error: result.reason });
  await containerRunner.spawnForWorkflow(result.workflow_id);
  res.json({ accepted: true });
});
```

Exposed via Cloudflare quick tunnel (already in use for DashClaw).

---

## 4. Integration with Existing Systems

### 4.1 With `src/identity/` (Agent Identity)
- Every `workflow_transition` writes to the evidence chain (`recordEvidence()` in `evidence-chain.ts`).
- `entity_evidence.signature` field is optional Ed25519 sig — when present, verified via `verifySignature()` from `message-signing.ts`.
- Trust scores from `trust-scoring.ts` weight match-proposal confidence: a low-trust agent's proposals require HITL even at score 0.9.

### 4.2 With `TeamOrchestrator`
- Replace ad-hoc `SendMessage`-based handoffs with `workflow_transition`.
- Sub-teams inherit parent workflow_id; their state writes to namespaced keys (`state.subteam.<id>.findings`).
- `Team.status` derives from `workflow_states.status` (single source of truth).

### 4.3 With `task-system.ts` / `goal-decomposition.ts`
- A `Goal` may own zero or more workflows. A `Task` can be linked to a workflow step.
- `tasks.status` transitions trigger `workflow_transition` automatically (DB trigger or app-level hook).
- KANBAN.md generator reads workflow current_step alongside task list.

### 4.4 With `groups/main/MEMORY.md`
- Add a `## Active Workflows` section, auto-populated by a memory hook.
- Each workflow row: `wf_xxx | type | step | last_actor | paused?`

### 4.5 With DashClaw UI
- New "Entities" tab: search graph, view match proposals, approve/reject merges.
- New "Workflows" tab: list of active/paused workflows, current step, recent transitions.

---

## 5. Implementation Phases

### Phase 1 — Foundations (week 1)
- [ ] `src/workflow-state.ts` — table, `transition()`, `get()`, unit tests.
- [ ] `src/entity-graph/` skeleton — tables, `EntityResolver.resolve()` with exact-match only.
- [ ] IPC handlers in `container/agent-runner/src/ipc-mcp-stdio.ts`: `workflow_get`, `workflow_transition`, `entity_resolve`.
- [ ] Migration: `scripts/migrate-workflow-state.ts` adds tables to `store/messages.db`.

### Phase 2 — Resolution Intelligence (week 2)
- [ ] Fuzzy matching + scoring in `EntityResolver`.
- [ ] `match_proposals` flow + HITL surface in DashClaw.
- [ ] `entity_evidence` writes from existing agent tool outputs.
- [ ] Backfill from `messages` table to seed initial entities.

### Phase 3 — Pause/Resume (week 3)
- [ ] `workflow_pause` + `workflow_resume` IPC tools.
- [ ] `src/channels/webhook.ts` with HMAC verification.
- [ ] Container relaunch path for resumed workflows in `container-runner.ts`.
- [ ] Integration test: pause workflow → POST webhook → container relaunches at correct step.

### Phase 4 — Team Orchestrator Migration (week 4)
- [ ] Refactor `TeamOrchestrator` handoffs to use `workflow_transition`.
- [ ] Sub-team namespaced state inheritance.
- [ ] Update `goal-decomposition` to mint a workflow per goal.
- [ ] Backwards-compat shim: old `SendMessage` handoffs still work during transition.

### Phase 5 — Polish (week 5)
- [ ] DashClaw Entities + Workflows tabs.
- [ ] Memory bridge: `groups/{name}/MEMORY.md` auto-section for active workflows.
- [ ] Documentation in `docs/WORKFLOW_STATE.md` and `docs/ENTITY_GRAPH.md`.
- [ ] Performance: index tuning on `entity_aliases.normalized`, `workflow_states.continuation_token`.

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Naming collision** between `identity/` (agents) and `entity-graph/` (people) confuses contributors | Hard rule in CLAUDE.md: never cross-import. Separate test directories. Module-level header comments cite each other to spell out the distinction. |
| **Entity merges are destructive** — wrong merge corrupts history | All merges record `entity_merges` audit row with both pre-merge JSON blobs. `entity_unmerge` operation supported (writes inverse). |
| **Workflow state grows unbounded** | TTL on `workflow_transitions` (90d), archived to JSONL files. Active state_blob capped at 64KB per workflow. |
| **Webhook spoofing** | HMAC signature required. Secret per external system, rotated quarterly. |
| **Stale continuation tokens** after host restart | Tokens stored in SQLite (not memory). Survive restarts. TTL: 7 days default, per-workflow override. |
| **Concurrent transitions race** | Optimistic concurrency via `expected_version`. Caller retries on `stale_version`. |

---

## 7. Success Criteria

- A team can pause mid-workflow for human approval, the container exits, and resumes at the exact step when the webhook fires. Zero duplicate tool calls.
- Two agents observing "Sarah Chen" and "sarah@acme.com" in different contexts resolve to the same `entity_id` on first read, without HITL.
- Multi-day workflow state survives a host crash + restart.
- Evidence chain shows every state transition signed by the originating agent.
- Trust scores for agents that propose high-confidence merges that humans approve trend upward; agents whose proposals are rejected trend down.

---

## 8. Open Questions

1. **Do we need cross-group entity sharing?** A "person" referenced in `main` and `lawyer` groups — same entity or isolated? Default: isolated (matches group isolation). Cross-group merges require explicit user opt-in.
2. **Workflow definition language?** Should `workflow_type` be backed by declarative JSON state-machine specs, or remain code-defined? Recommend: code-defined for v1, JSON specs in v2.
3. **Versioning of state schemas?** When a workflow_type's shape changes, do we migrate existing rows? Recommend: per-workflow `schema_version` field, migration scripts per type.
4. **Integration with Cloudflare integration?** Webhook tunnel already exists for DashClaw — reuse the same tunnel or stand up a separate one for workflow webhooks?
