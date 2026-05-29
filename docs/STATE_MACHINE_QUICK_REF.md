# State Machine — Quick Reference

Companion to [`ADK_STATE_MACHINE_ANALYSIS.md`](./ADK_STATE_MACHINE_ANALYSIS.md). Cheat sheet
for deciding when to use explicit state machines, how the three models compare, and
copy-paste snippets for the common patterns.

---

## 1. Side-by-side: Current NanoClaw vs Google ADK vs Proposed Hybrid

| Dimension | **Current NanoClaw** | **Google ADK** | **Proposed Hybrid** |
|---|---|---|---|
| Workflow position | implicit (4-value `task.status` + transcript) | explicit `state["current_step"]` | explicit `state_machine.current_step` |
| Durable store | `sessions` (session_id only); `tasks` status | `DatabaseSessionService` (SQLite/Cloud SQL) | `state_machine` table in `store/messages.db` |
| Resume mechanism | replay transcript via Claude SDK | read state, apply next `state_delta` | read `current_step`+`step_data`, no replay |
| Transition atomicity | direct `UPDATE`s, in-memory map | atomic `state_delta` on event append | atomic upsert + chained transition |
| Who made the change | not recorded for status changes | `Event.author` (**self-asserted, unsigned**) | Ed25519 **signed** by `agent_id` key |
| Tamper detection | none for state | **none** (no hash/sig over deltas) | `prev_step_hash` chain + signature + evidence chain |
| Authorization | scopes (for IPC actions) | infra-level (DB/IAM/webhook auth) | scope-checked per transition (`task.update`) |
| Replay protection | `seen_nonces` (messages) | not applicable | `seen_nonces` on transitions |
| Multi-agent coordination | in-memory `activeTeams` map (lost on restart) | shared session state | durable state row, map as cache |
| Trust feedback | outcome + chain integrity | none | broken state chain → `chain_integrity` penalty |

**One-line takeaway:** ADK shape (explicit, durable, atomic, webhook-resumable) + NanoClaw trust
(signed, hash-linked, scope-checked, attributable) = the hybrid.

> **Already-built shortcut:** `src/gsd/` is an ADK-shaped progress engine *today* — phased
> specs, durable checkpoints (`completedItems`/`nextItems`/`blockers`/`agentId`), drift
> detection, pause/resume `status`. It just isn't signed or hash-linked. Prefer **extending
> GSD** (sign its checkpoints) or **referencing GSD from `state_machine.step_data`** over
> building a third system. See analysis §1.4 and §3 build-vs-reuse callout.

---

## 2. Decision tree — state machine vs conversation-based coordination

```
Is the work multi-step AND expected to outlive a single container run
(pause/resume, scheduled, webhook-triggered, or handed between agents)?
│
├─ NO ─► Conversation-based is fine. Let the Claude SDK session
│        (sessions table → session_id) carry context. Don't add state.
│        e.g. a one-shot Q&A, a single message reply, a quick lookup.
│
└─ YES ─► Use an explicit state machine (state_machine table).
          │
          ├─ Does more than one agent touch it (coordinator → sub-agent),
          │  OR does a wrong/forged step have real consequences
          │  (spend money, delete data, mark compliance "passed")?
          │   │
          │   ├─ YES ─► Sign the transitions (Phase 3).
          │   │         recordStateTransition() → durable row + signed
          │   │         evidence record + trust-feeding chain link.
          │   │
          │   └─ NO  ─► Unsigned durable state is enough (Phase 1).
          │             advanceTaskState() upsert; revisit signing if
          │             privilege/consequence grows.
          │
          └─ Always: keep task.status (coarse, public) AND
             state_machine.current_step (fine, internal) — they answer
             different questions.
```

**Rules of thumb**

- **Transcript = context, state = position.** Never infer "where am I" from chat; read the row.
- **Coarse status stays.** `task.status` is the dashboard/Kanban signal; `current_step` is the
  agent's GPS. Don't collapse them.
- **Sign when privilege differs.** If agents have unequal scopes or a step has irreversible
  side effects, the transition must be attributable — sign it.
- **One canonicalizer.** Reuse `canonicalRecord()` from `evidence-chain.ts`; never write a
  second JSON canonicalizer.

---

## 3. Common-pattern snippets

### 3.1 Read current position on resume (state-grounded)

```ts
import { getTaskState } from './db.js';
const st = getTaskState(taskId);
if (st) {
  // Tell the agent exactly where it is — no transcript replay.
  prompt = `Resume task ${taskId} at step "${st.current_step}".\n` +
           `Prior step data:\n${st.step_data}`;
}
```

### 3.2 Advance a step (Phase 1 — durable, unsigned)

```ts
// src/db.ts — atomic upsert, integer-ms timestamp (matches existing convention)
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

### 3.3 Advance a step (Phase 3 — signed transition)

```ts
// src/identity/evidence-chain.ts (proposed) — reuses canonicalRecord + signData
export async function recordStateTransition(p: {
  taskId: string; step: string; stepData: object; agentId: string;
}): Promise<void> {
  const secretKey = loadSecretKey(p.agentId);
  const prev = getLatestStepHash(p.taskId);                 // "0"*64 genesis
  const partial = {
    task_id: p.taskId, current_step: p.step,
    step_data: p.stepData, agent_id: p.agentId,
    updated_at: Date.now(), prev_step_hash: prev,
  };
  const canonical = canonicalRecord(partial);               // sorted keys, shared impl
  const transition_hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const signature = await signData(canonical, secretKey);   // Ed25519
  // upsert row with transition_hash + signature, then:
  await createEvidence(p.agentId, 'state_transition',
    { task_id: p.taskId, step: p.step }, `advance to ${p.step}`,
    { success: true });                                     // pairs into the global chain
}
```

### 3.4 Verify a task's transition chain (tamper check)

```ts
const res = await verifyStateChain(taskId);   // mirrors verifyChain()
if (!res.valid) {
  logger.warn({ taskId, broken_at: res.broken_at, reason: res.reason },
    'State chain tampered — transition rejected / flagged');
}
// reasons: 'hash_mismatch' | 'invalid_signature' | 'broken_link' | 'invalid_genesis'
```

### 3.5 ADK equivalent (for reference / porting mental model)

```python
# ADK: same intent, NO signature/attribution guarantees
actions = EventActions(state_delta={"current_step": "review"})
session_service.append_event(session, Event(author="coordinator", actions=actions))
# author is self-asserted; no hash chain; DB-writer can forge. (see analysis §2.5)
```

---

## 4. Step vocabulary (from `src/schemas/state-machine.sql`)

```
pending → research → implementation → testing → review → completed
```

Steps may be skipped, but `current_step` must always be one of the above (enforced by a
`CHECK` constraint). Extend the enum in
[`src/schemas/state-machine.sql`](../src/schemas/state-machine.sql) if new workflows need
different stages.

---

## 5. File map (where each change lands)

| Want to… | Touch |
|---|---|
| Create the table | `src/db.ts` `createSchema()` ← fold in `src/schemas/state-machine.sql` |
| Read/advance state | `src/db.ts` (`getTaskState`, `advanceTaskState`) |
| Sign/verify transitions | `src/identity/evidence-chain.ts` + `src/identity/types.ts` (`'state_transition'`) |
| Expose to container agents | `container/agent-runner/src/ipc-mcp-stdio.ts` (`state_get`/`state_advance`) + `src/ipc.ts` handler |
| Coordinate teams via state | `src/team-orchestrator.ts` (rehydrate map, advance steps) |
| Reuse existing checkpoints | `src/gsd/` (`checkpoint.ts`, `db.ts`, `types.ts`) — sign these instead of duplicating |
