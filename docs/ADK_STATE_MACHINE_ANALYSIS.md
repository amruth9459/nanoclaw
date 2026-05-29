# Google ADK State-Machine Patterns → NanoClaw Identity & Trust Architecture

**Author:** Agentic Identity & Trust Architect (research dispatch)
**Date:** 2026-05-29
**Status:** Analysis / design proposal — no production code changed
**Scope:** How Google ADK's explicit-state-machine + persistent-session model maps onto
NanoClaw's existing cryptographic identity, evidence-chain, and multi-agent coordination
layers, and how to fuse the two so that *every state transition is a signed, attributable,
tamper-evident event.*

> Companion: [`STATE_MACHINE_QUICK_REF.md`](./STATE_MACHINE_QUICK_REF.md) — side-by-side
> comparison table, decision tree, and copy-paste snippets.

---

## 0. TL;DR

NanoClaw already has two of the three pillars Google ADK preaches, and they are *stronger*
than ADK's versions:

| Pillar | Google ADK | NanoClaw today |
|---|---|---|
| **Durable session storage** | `DatabaseSessionService` (SQLite / Cloud SQL) | `sessions` table maps `group_folder → session_id`; Claude SDK replays the transcript |
| **Explicit state machine** | typed state schema, `state_delta` transitions | **Missing** — task state is a 4-value status enum; mid-task progress is *not* durable |
| **Trust / identity on transitions** | **Missing** — `state_delta` is unauthenticated | Ed25519 identities + hash-linked, signed `evidence_chain` + outcome-based trust scores |

The opportunity is precise: **adopt ADK's explicit-state-machine grounding, but make each
transition a first-class signed evidence record** instead of an unauthenticated `state_delta`.
That closes ADK's biggest gap (no cryptographic attribution of *who* advanced the workflow)
while curing NanoClaw's biggest gap (no durable "where was I?" state for long-running,
pause/resume work).

The schema groundwork already exists at [`src/schemas/state-machine.sql`](../src/schemas/state-machine.sql)
but is **not yet wired into** [`src/db.ts`](../src/db.ts) (verified: `state_machine` appears in
no `.ts` file). This document specifies how to wire it in *and* harden it.

---

## 1. Current NanoClaw Architecture Assessment

### 1.1 How we handle agent identity today

Agent identity is real, cryptographic, and already integrated — this is NanoClaw's
differentiator and the foundation everything below builds on.

- **Keys.** Every agent gets an Ed25519 keypair (`@noble/ed25519`). Generation in
  [`src/identity/keypair.ts:23`](../src/identity/keypair.ts):

  ```ts
  export async function generateKeypair(): Promise<Keypair> {
    const { publicKey, secretKey } = await ed.keygenAsync();
    return { publicKey, secretKey };   // 32-byte pk, 32-byte seed
  }
  ```

- **Key custody.** Private keys are AES-256-GCM encrypted at rest under a host key stored
  at `STORE_DIR/.host-key` (mode `0o600`), *outside* the DB and *outside* any container
  mount — so a container agent can request signatures via IPC but can never exfiltrate the
  raw key ([`src/identity/keypair.ts:33-74`](../src/identity/keypair.ts)).

- **Identity records.** `agent_identities` (defined in
  [`src/db.ts:454`](../src/db.ts)) stores `agent_id` (`agent-${uuid}`), `agent_name`,
  `agent_type`, `public_key`, encrypted private key, `issued_at`/`expires_at` (90-day default),
  `scopes` (JSON array), and `issuer` (`"nanoclaw-root"` or a parent `agent_id`, giving a
  delegation chain).

- **Scopes.** Capability-based authorization. `AgentScope` enumerates `task.create`,
  `message.send`, `agent.spawn`, `file.write`, `destructive.execute`, `bounty.submit`, etc.
  ([`src/identity/types.ts:12`](../src/identity/types.ts)). Defaults per agent type via
  `getDefaultScopes()` — e.g. an `Explore` agent gets only `['file.read','task.read']`.

- **Injection.** At container spawn, `ensureAgentIdentity(groupFolder, designation)` creates
  or retrieves the identity and the runner passes `NANOCLAW_AGENT_ID=<id>` into the container
  env (`src/container-runner.ts`, identity IPC handlers in
  [`src/identity/ipc-handlers.ts`](../src/identity/ipc-handlers.ts)). Enforcement is gated by
  `NANOCLAW_IDENTITY_ENFORCEMENT` (`warn` | `strict`), so the system degrades gracefully during
  migration.

### 1.2 How we handle state today (the gap)

There are **three separate, partial notions of "state"**, none of which gives an agent a
durable, fine-grained "where am I in this workflow?":

1. **Task status enum** — `tasks.status ∈ {pending, in_progress, completed, blocked}`
   ([`src/db.ts:166`](../src/db.ts)). This is *coarse*: it tells you a task is "in progress"
   but not *which step* of the work, what was already done, or what to do on resume.

2. **Claude SDK sessions** — the `sessions` table maps `group_folder → session_id`
   ([`src/db.ts:72`, `:957`](../src/db.ts)). On a new message, the host passes the saved
   `sessionId` back to the container and the Claude Agent SDK *replays the transcript* to
   reconstruct context. This is conversation-based grounding — the exact pattern ADK warns
   against (see §2.1).

3. **Team coordination state** — `team-orchestrator.ts` keeps an **in-memory**
   `private activeTeams: Map<string, Team>` ([`src/team-orchestrator.ts:78`](../src/team-orchestrator.ts))
   layered over persisted `teams` / `team_members` / `team_hierarchy` tables. Member status
   (`idle|working|blocked|completed`) and `current_task` are written to SQLite, but **the
   orchestrator's live map is lost on host restart** and there is no rehydrate-on-boot path.

### 1.3 Current limitations

- **Conversation-based coordination & reconstruction.** Resuming a long task means replaying
  the transcript through the Claude SDK. That is (a) token-expensive — the whole point of
  context windows is they are finite and re-summarized; and (b) hallucination-prone — the
  agent infers "where was I?" from prose rather than reading an authoritative state row.

- **No durable mid-task checkpoint.** If a container is killed at "implementation 60% done,"
  nothing records that. The 4-value status enum cannot express it; the SDK session can only
  replay what was *said*, not the structured progress.

- **In-memory orchestration state.** `TeamOrchestrator.activeTeams` and
  `getTeam()` ([`src/team-orchestrator.ts:551`](../src/team-orchestrator.ts)) return `null`
  after a restart even though the DB rows survive — there's a persistence/rehydration seam.

- **State changes are not evidence.** When a task moves `pending → in_progress`, *no signed
  evidence record is created*. The evidence chain captures `task_created`, `message_sent`,
  `file_modified`, etc. ([`ActionType` in `src/identity/types.ts:100`](../src/identity/types.ts)),
  but **not workflow-step transitions** — so we cannot cryptographically attribute "who moved
  this task to `review`?"

### 1.4 Where we already have the right patterns

We are not starting from zero. The hard parts are built:

- **Tamper-evident, signed, hash-linked ledger.** The `evidence_chain`
  ([`src/identity/evidence-chain.ts`](../src/identity/evidence-chain.ts)) is exactly the
  substrate a signed state machine needs (detail in §3.4). Each record carries
  `prev_record_hash`, a SHA-256 `record_hash` over canonical JSON, and an Ed25519 `signature`.

- **Request/response IPC.** Container tools already do durable, atomic, file-based RPC to the
  host (`task_tool`, `gsd_tool`, `identity_*`, `semantic_search`) using a temp-file +
  `rename()` write and a `.response.json` poll ([`src/ipc.ts`](../src/ipc.ts),
  [`container/agent-runner/src/ipc-mcp-stdio.ts`](../container/agent-runner/src/ipc-mcp-stdio.ts)).
  A `state_tool` slots straight into this pattern.

- **Outcome-based trust.** `agent_trust_scores` already penalizes broken chains and failed
  outcomes ([`src/identity/trust-scoring.ts`](../src/identity/trust-scoring.ts), factors in
  [`types.ts:143`](../src/identity/types.ts)). Signed state transitions feed this directly.

- **GSD ("Get Shit Done") checkpointing — the closest existing pattern, by far.** The
  [`src/gsd/`](../src/gsd/) subsystem is *already an ADK-shaped explicit-progress engine*, it
  simply isn't signed or treated as the canonical task state. It has:
  - A `Spec` with named **`phases`**, each a checklist of `{text, done}` items, and a lifecycle
    `status: 'active' | 'completed' | 'paused' | 'abandoned'`
    ([`src/gsd/types.ts:30-39`](../src/gsd/types.ts)). "Paused" + "phases" ≈ ADK's
    `current_step` + pause/resume.
  - Durable **`Checkpoint`** rows (`specId`, **`agentId`**, `summary`, `completedItems`,
    `nextItems`, `blockers`, `timestamp`) persisted in a `gsd_checkpoints` table
    ([`src/gsd/types.ts:43-52`, `src/gsd/db.ts`](../src/gsd/db.ts)). This is exactly the
    "what's done / what's next / what's blocked" snapshot ADK reconstructs from state.
  - `calculateProgress()` derives the **`next`** item — a literal "where am I?" answer —
    without replaying the transcript ([`src/gsd/checkpoint.ts:18-55`](../src/gsd/checkpoint.ts)).
  - Auto-checkpointing every N turns (`shouldCheckpoint`,
    [`src/gsd/checkpoint.ts:99`](../src/gsd/checkpoint.ts)) and **drift detection** (`DriftAlert`).
  - An IPC surface: `gsd_tool` exposes `init/status/checkpoint/validate/complete_item/list`
    ([`src/mcp/tools/gsd-tool.ts`](../src/mcp/tools/gsd-tool.ts)).

  **What GSD lacks is precisely the trust layer:** checkpoints record `agentId` but it is
  *unverified* (no signature), checkpoints are *not hash-linked* (delete/reorder is
  undetectable), and GSD is *separate* from the `tasks`/`state_machine` model. This makes GSD
  the natural host for explicit state — see the unification recommendation in §3 and §4.

---

## 2. Google ADK State-Machine Patterns

> Grounded in the ADK article's four stated insights and the two quoted principles, plus
> ADK's documented `Session` / `State` / `EventActions.state_delta` model. Where I extend
> beyond the article I say so.

### 2.1 State-machine grounding (the core idea)

> *"Define an explicit state schema that tells the agent exactly where it is in the workflow
> at all times."*

ADK separates **conversation** from **state**. The agent does not infer its position from
chat history; it reads a typed state object (e.g. `state["current_step"]`) that is the single
source of truth. This prevents the classic failure where a re-prompted agent re-does or skips
a step because the transcript was ambiguous or summarized away.

### 2.2 Persistent sessions — `DatabaseSessionService`

> *"Switch in-memory sessions for ADK's DatabaseSessionService backed by SQLite (locally) or
> Cloud SQL (in production)."*

ADK's `SessionService` is the storage abstraction for a session's `events` (the append-only
log) and `state` (the key/value working set). Swapping `InMemorySessionService` for
`DatabaseSessionService` makes both survive process death:

```python
# ADK — durable sessions
from google.adk.sessions import DatabaseSessionService

session_service = DatabaseSessionService(db_url="sqlite:///./sessions.db")
# production: db_url="postgresql+psycopg://.../adk"  (Cloud SQL)

runner = Runner(agent=root_agent, session_service=session_service, app_name="claw")
```

State keys carry scope prefixes (`app:`, `user:`, `temp:`, or unprefixed = session-scoped),
which controls persistence/visibility. The unprefixed/`user:`/`app:` keys persist; `temp:` does
not.

### 2.3 Event-driven resumption & atomic `state_delta`

> *"Webhooks trigger wake-ups with atomic state_delta transitions."*

State is **never mutated in place.** A transition is expressed as a `state_delta` attached to
an `Event`'s `actions`; the `SessionService` applies it atomically when the event is appended:

```python
# ADK — atomic state transition
from google.adk.events import Event, EventActions

actions = EventActions(state_delta={
    "current_step": "review",
    "review:assigned_to": "reviewer-agent",
})
session_service.append_event(session, Event(author="coordinator", actions=actions))
```

A webhook (payment confirmed, build finished, human approval received) is what *triggers* the
runner to wake, read `current_step`, apply the next `state_delta`, and either continue or park
again. This is "park cheaply, resume deterministically."

### 2.4 Multi-agent delegation

> A **coordinator** agent owns the workflow and delegates focused work to **sub-agents** (one
> job each) rather than carrying a monolithic prompt. Sub-agents read/write the *shared session
> state*, so the coordinator's view and the sub-agent's view never diverge — state is the
> coordination bus, not a chat thread.

### 2.5 ADK's security model — and its gap

This is the crucial finding for an *identity & trust* architecture:

- **What ADK authenticates:** transport/credential security is at the *infrastructure* layer —
  the DB connection string to Cloud SQL, IAM on the service, and whatever auth the developer
  bolts onto the webhook endpoint. ADK's tool layer also supports per-tool auth (OAuth/API
  keys) for *outbound* calls.
- **What ADK does *not* authenticate:** the `state_delta` itself. There is **no cryptographic
  signature on a state transition** and **no built-in proof of which agent authored it** beyond
  the `Event.author` string, which is *self-asserted* and unsigned. Anyone (or any bug) with
  write access to the sessions DB can forge `current_step = "completed"` and there is no
  tamper-evidence: no hash chain, no signature, no verifiable "who did this and were they
  allowed to?"

> **Architectural conclusion.** ADK gives us the *shape* (explicit state, durable store, atomic
> deltas, webhook resumption). NanoClaw's identity layer gives us the *trust* (signed,
> hash-linked, scope-checked, attributable transitions). The proposed design is the
> intersection: **ADK-shaped state machine, NanoClaw-grade signatures.**

---

## 3. Application to NanoClaw Identity & Trust Architecture

### 3.1 What explicit state machines buy our multi-agent coordination

Replace "the coordinator messages a sub-agent and hopes the transcript stays coherent" with
"the coordinator advances a typed `current_step` and writes `step_data`; any sub-agent (and the
orchestrator after a restart) reads the authoritative row."

Concretely this fixes the three gaps from §1.2:

1. The `TeamOrchestrator.activeTeams` in-memory map becomes a *cache* over a durable
   `state_machine` row — `getTeam()` can rehydrate after restart by reading state.
2. A killed container resumes from `current_step` + `step_data` instead of replaying the
   transcript (cheaper, no hallucinated progress).
3. `task.status` stays the coarse public signal; `state_machine.current_step` carries the
   fine-grained workflow position.

> **Build-vs-reuse decision (important).** Because [`src/gsd/`](../src/gsd/) already implements
> phased progress + durable checkpoints + drift detection (§1.4), the recommended path is **not**
> a parallel system. Two viable options:
> - **(A) `state_machine` as the canonical row, GSD checkpoints as the rich per-step payload.**
>   `state_machine.current_step` ≈ the active GSD phase; `step_data` references the latest
>   `gsd_checkpoints` row. One source of truth for "where", GSD for "what's done."
> - **(B) Add the trust layer directly to GSD checkpoints** — sign + hash-link the existing
>   `Checkpoint` rows and skip `state_machine` entirely for GSD-managed work.
>
> Option (A) keeps a clean separation between *task lifecycle* (`tasks`/`state_machine`) and
> *spec execution* (GSD) and is the default recommendation; Option (B) is lighter if GSD ends
> up being the only producer of fine-grained state. Either way: **sign once, don't duplicate.**

### 3.2 Integration with existing evidence chains and trust scoring

The key design decision: **a state transition IS an evidence event.** We do not invent a
parallel audit log; we extend the one we have.

- Add a new `ActionType` value `'state_transition'` to
  [`src/identity/types.ts:100`](../src/identity/types.ts) and map it to a scope (proposal:
  reuse `task.update`) in `ACTION_SCOPE_MAP`.
- Whenever `current_step` advances, call `createEvidence(agentId, 'state_transition', {...})`.
  This automatically gives the transition a hash-linked, Ed25519-signed record and an entry in
  `verifyChain()`.
- Trust scoring then "just works": a forged or out-of-order transition breaks the chain →
  `chain_integrity = -0.5` → the offending agent's trust score drops
  ([`src/identity/trust-scoring.ts`](../src/identity/trust-scoring.ts)).

### 3.3 State-based identity attribution

The schema already anticipates this. `state_machine.agent_id` is a foreign key to
`agent_identities` ([`src/schemas/state-machine.sql:55,60`](../src/schemas/state-machine.sql)):

```sql
agent_id TEXT,
FOREIGN KEY (agent_id) REFERENCES agent_identities(agent_id)
```

So "which agent wrote which transition" is answerable by design. But an FK alone is *not*
tamper-evident — a direct `UPDATE state_machine SET agent_id=...` could lie. That's why we
also (a) emit a signed evidence record per transition (§3.2) and (b) sign the row itself (§3.4).

### 3.4 Cryptographic signatures on state transitions (tamper detection)

This is the heart of the proposal and the part ADK lacks entirely. We reuse the *exact*
canonical-JSON + SHA-256 + Ed25519 recipe already proven in the evidence chain.

**How the evidence chain signs today** ([`src/identity/evidence-chain.ts:88-93`](../src/identity/evidence-chain.ts)):

```ts
// Sort keys deterministically, then hash + sign the canonical bytes
const canonical = canonicalRecord(partial);                 // JSON, keys sorted
const recordHash = crypto.createHash('sha256')
  .update(canonical).digest('hex');
const signature = await signData(canonical, secretKey);     // Ed25519 (base64)
```

and verifies with hash-recompute + `verifySignature()` + `prev_record_hash` link check
([`evidence-chain.ts:130-170`](../src/identity/evidence-chain.ts)).

**Proposed: sign each state transition the same way.** Add two columns to `state_machine` so a
row carries its own integrity proof, *and* chain transitions per task so reordering/deletion is
detectable:

```sql
-- ADDED to src/schemas/state-machine.sql (Phase 3)
prev_step_hash TEXT,          -- hash of the previous transition for this task ("0"*64 genesis)
transition_hash TEXT,         -- SHA-256 over canonical {task_id,current_step,step_data,agent_id,updated_at,prev_step_hash}
signature      TEXT           -- Ed25519 signature of the same canonical bytes, by agent_id's key
```

Because private keys live host-side and the container signs via IPC (§3.5), a container agent
cannot forge a transition for an `agent_id` whose key it doesn't control, and a host-side tamper
(`UPDATE`) is caught by `verifyChain()` / a new `verifyStateChain(taskId)`.

### 3.5 Where the work lands (file map)

| Concern | File | Change |
|---|---|---|
| Schema | [`src/schemas/state-machine.sql`](../src/schemas/state-machine.sql) | add hash/signature columns (Phase 3) |
| Migration wiring | [`src/db.ts`](../src/db.ts) `createSchema()` | fold `state_machine` CREATE into the `database.exec()` block + accessors |
| Transition + sign | [`src/identity/evidence-chain.ts`](../src/identity/evidence-chain.ts) | add `recordStateTransition()` / `verifyStateChain()` reusing `canonicalRecord`/`signData` |
| Action type | [`src/identity/types.ts`](../src/identity/types.ts) | add `'state_transition'` to `ActionType` + `ACTION_SCOPE_MAP` |
| Host IPC | [`src/ipc.ts`](../src/ipc.ts) | handle `state_tool` (get/advance) like `task_tool`/`gsd_tool` |
| Container tool | [`container/agent-runner/src/ipc-mcp-stdio.ts`](../container/agent-runner/src/ipc-mcp-stdio.ts) | expose `state_get` / `state_advance` MCP tools |
| Orchestrator | [`src/team-orchestrator.ts`](../src/team-orchestrator.ts) | rehydrate `activeTeams` from state on boot; advance steps instead of mutating the in-memory map only |

---

## 4. Implementation Roadmap

Four phases, each shippable and reversible. Complexity/risk noted per phase.

### Phase 1 — Wire up the `state_machine` table

**Goal:** make durable per-task step state exist and be readable/writable.

- Fold the `CREATE TABLE state_machine` + indexes from
  [`src/schemas/state-machine.sql`](../src/schemas/state-machine.sql) into the
  `database.exec()` block in `createSchema()` ([`src/db.ts:13`](../src/db.ts)). Follow the
  existing convention (`CREATE TABLE IF NOT EXISTS`, integer ms timestamps).
- Add accessors mirroring the existing style:

  ```ts
  // src/db.ts (proposed)
  export function getTaskState(taskId: string): StateRow | undefined { /* SELECT */ }
  export function advanceTaskState(taskId: string, step: string,
      stepData: object, agentId?: string): void {
    db.prepare(`
      INSERT INTO state_machine (task_id, current_step, step_data, updated_at, agent_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        current_step = excluded.current_step,
        step_data    = excluded.step_data,
        updated_at   = excluded.updated_at,
        agent_id     = excluded.agent_id
    `).run(taskId, step, JSON.stringify(stepData), Date.now(), agentId ?? null);
  }
  ```

- **Complexity:** Low (additive schema + 2–3 functions; `state-machine.sql` is pre-written).
- **Risk:** Low. Purely additive; nothing reads it yet. Main pitfall: the `task_id` FK to
  `tasks(id)` — backfill or make the FK soft for `scheduled_tasks`/`clawwork_tasks` ids which
  live in different tables.

### Phase 2 — Migrate team coordination from in-memory to state-based

**Goal:** kill the "lost on restart" seam; coordinate via state, not just an in-memory map.

- On boot, rehydrate `TeamOrchestrator.activeTeams` from `teams`/`team_members` (already
  persisted) and attach each active task's `state_machine` row.
- Replace direct `member.status`/`currentTask` mutations
  ([`src/team-orchestrator.ts:443-450`](../src/team-orchestrator.ts)) with
  `advanceTaskState()` calls so the durable row is the source of truth and the map is a cache.
- Introduce a coordinator→sub-agent handoff via `step_data` (e.g.
  `{ "assigned_to": "<agent_id>", "handoff_note": "..." }`) instead of an IPC message the
  sub-agent must parse from prose.
- **Complexity:** Medium (touches live orchestration + boot path).
- **Risk:** Medium. Behavioral change to a running subsystem; needs the
  [`src/team-orchestrator`-adjacent tests] plus a feature flag to roll back to map-only mode.

### Phase 3 — Cryptographic signatures on state transitions

**Goal:** make every transition tamper-evident and attributable (the ADK gap-closer).

- Add `prev_step_hash`, `transition_hash`, `signature` columns (§3.4).
- Implement `recordStateTransition()` + `verifyStateChain(taskId)` in
  [`src/identity/evidence-chain.ts`](../src/identity/evidence-chain.ts), reusing
  `canonicalRecord()` / `signData()` / `verifySignature()` verbatim.
- Route signing through host IPC so container agents never see private keys; the host signs
  with the row's `agent_id` key (same path `identity_record_evidence` uses today).
- Add `'state_transition'` to `ActionType` and emit a paired evidence record.
- **Complexity:** Medium-High (crypto correctness + IPC round-trip + dual-write to evidence
  chain).
- **Risk:** Medium. Crypto must be canonical-stable (sorted keys, stable number/`null`
  encoding). Mitigation: golden-vector tests, and reuse the *existing* `canonicalRecord` so we
  inherit its battle-tested behavior rather than writing a second canonicalizer.

### Phase 4 — State-aware evidence recording

**Goal:** unify the audit story — evidence records reference the state they were produced in.

- Stamp each `createEvidence()` call made *during* a task with the `task_id` + `current_step`
  in `action_details` (e.g. `{ task_id, step: "implementation" }`), so the trust/audit view can
  answer "what did agent X do *while in the review step*?"
- Extend `identity_audit_evidence` / trust reporting
  ([`src/identity/ipc-handlers.ts`](../src/identity/ipc-handlers.ts)) to group evidence by
  workflow step.
- **Complexity:** Low-Medium (mostly plumbing context into existing calls).
- **Risk:** Low. Additive metadata; no change to verification semantics.

---

## 5. Security Considerations

### 5.1 Authentication gaps in the ADK approach

As established in §2.5: ADK's `state_delta` is **unauthenticated and unsigned**. `Event.author`
is a self-asserted string. There is no hash chain over transitions, so deletion/reordering of
historical state events is undetectable, and a DB-write-capable actor can forge any
`current_step`. ADK leans on *infrastructure* auth (Cloud SQL IAM, webhook auth the developer
adds) rather than *payload* auth. For a multi-agent system where agents have differing
privilege, that is insufficient — you cannot prove which agent advanced a workflow, nor that it
was allowed to.

### 5.2 Adding agent identity verification to transitions

NanoClaw closes this by construction:

- **Authorship is signed, not asserted.** The transition's `signature` is an Ed25519 signature
  by the `agent_id`'s key; `verifySignature()` against the stored `public_key` proves authorship.
  A forged `agent_id` fails because the forger lacks the key (kept host-side, AES-GCM-encrypted).
- **Authorization is scope-checked.** Before accepting a transition, verify the agent holds the
  required scope (`task.update` for `state_transition`) exactly as `createEvidence()` records
  `authorization.scope_verified` today ([`evidence-chain.ts:69-73`](../src/identity/evidence-chain.ts)).
- **Replay is blocked.** Reuse the `seen_nonces` mechanism ([`src/db.ts:493`](../src/db.ts);
  5-minute freshness window in `message-signing.ts`) so a captured "advance to completed"
  transition can't be replayed.
- **Enforcement is staged.** Honor `NANOCLAW_IDENTITY_ENFORCEMENT` (`warn`→`strict`) so
  unsigned transitions are logged during migration and rejected once coverage is complete.

### 5.3 Tamper detection for state records

Two independent layers:

1. **Per-task transition chain** — `prev_step_hash` links transitions for a `task_id`; deleting
   or reordering breaks the link (same mechanism as `evidence_chain.prev_record_hash`, genesis
   `'0'.repeat(64)`).
2. **Cross-cutting evidence chain** — the paired `'state_transition'` evidence record is part
   of the agent's global hash-linked chain, so tampering also breaks `verifyChain(agentId)` and
   is surfaced by trust scoring.

A `verifyStateChain(taskId)` mirrors `verifyChain()`: recompute `transition_hash`, verify the
signature, verify the `prev_step_hash` link, return `{valid, broken_at, reason}`.

### 5.4 Trust-scoring implications

State-based architecture *strengthens* trust scoring:

- A broken state chain feeds the same `chain_integrity` penalty (`-0.5`) as a broken evidence
  chain ([`trust-scoring.ts`](../src/identity/trust-scoring.ts), factors in
  [`types.ts:143`](../src/identity/types.ts)).
- `step_data.outcome` per step gives finer-grained `outcome_reliability` than the current
  whole-task success flag — we can detect an agent that reliably fails at, say, the `testing`
  step.
- Attribution-by-step (Phase 4) lets trust be computed *per capability* in future (an agent
  trusted to `research` but not yet to `review`), enabling progressive autonomy.

### 5.5 Residual risks to track

- **Host-key compromise** remains the single point of failure (it can decrypt any private key);
  signatures are only as good as `.host-key` custody. Out of scope here, but note it.
- **Canonicalization drift** — if the state canonicalizer and the evidence canonicalizer ever
  diverge, cross-verification breaks. Mitigation: share one `canonicalRecord()` implementation.
- **FK across task tables** — `state_machine.task_id` references `tasks(id)`, but work also
  flows through `scheduled_tasks` and `clawwork_tasks`. Decide one canonical task id space or
  relax the FK before Phase 2.

---

## Appendix A — Current vs Proposed, in code

**Current: resume = replay the transcript (conversation-grounded).**

```ts
// host passes the saved session id; Claude SDK replays chat to reconstruct "where was I"
const sessionId = getSession(groupFolder);          // src/db.ts:957
runContainer({ prompt, sessionId, groupFolder });   // SDK re-reads transcript
```

**Proposed: resume = read the authoritative state row (state-grounded, ADK-style).**

```ts
const st = getTaskState(taskId);                     // {current_step, step_data}
// agent is told exactly where it is — no transcript replay needed
runContainer({ prompt: `Resume task at step "${st.current_step}". State: ${st.step_data}`,
               sessionId, groupFolder });
```

**Current: team handoff mutates an in-memory map (lost on restart).**

```ts
member.status = 'working'; member.currentTask = taskId;   // src/team-orchestrator.ts:443
this.db.prepare(`UPDATE team_members SET status='working', current_task=? WHERE agent_id=?`)
  .run(taskId, member.agentId);
```

**Proposed: team handoff is a signed, durable transition.**

```ts
await recordStateTransition({
  taskId, step: 'implementation',
  stepData: { assigned_to: member.agentId, handoff_note },
  agentId: leadAgentId,            // signed by lead's key, host-side
});  // → durable row + signed evidence record + trust-feeding chain link
```

---

## Appendix B — Verification commands used to ground this analysis

```
# state_machine is defined but NOT wired into any TypeScript yet:
rg 'state_machine' src        # → only src/schemas/state-machine.sql

# identity/evidence/trust layer is real and integrated:
rg 'createEvidence|verifyChain|signData|agent_identities' src/identity src/db.ts
```
