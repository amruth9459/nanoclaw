# Google ADK: Pausable & Resumable Agents — Analysis for NanoClaw

**Source:** Google Developers Blog — "Building Pausable & Resumable Agents with ADK"
**Analyzed by:** Identity Graph Operator (specialized) via Auto-Dispatch
**Date:** 2026-05-28
**Task:** task_1778778057698_j69ys9i

---

## 1. Article Summary

Google's Agent Development Kit (ADK) reframes long-running agent reliability as a *state-machine engineering problem*, not a prompting problem. The core thesis:

> **"Agents should read their current step from session state, not chat history."**

Conversation replay is fragile: as transcripts grow, models hallucinate completed steps, skip required actions, or repeat finished work. ADK's response is to externalize the step pointer into a durable session store and treat every transition as an explicit, persisted event.

## 2. Key Technical Insights

### 2.1 State Machine Grounding
Each workflow is modeled as a finite state machine with explicit transitions. The agent's *prompt context* includes the current state slug, not a 200-message log. Decisions are: "given state `awaiting_signature`, what's the next legal transition?" — never "scan history to figure out where I am."

### 2.2 Durable Sessions (SQLite / Cloud SQL)
ADK ships with a `SessionService` abstraction. State writes via `ToolContext.state["key"] = value` are *immediately persisted* — not buffered until end-of-turn. This means a crash mid-tool-call leaves the session in a recoverable, consistent state.

### 2.3 Event-Driven Resumption via Webhooks
Pausing is first-class. When the agent calls `pause()`, the framework stores a continuation token. An inbound webhook (e.g., a human approval, a Stripe payment, a doc-signing callback) carries the token + a `state_delta` payload. The framework merges the delta atomically and re-enters the state machine at the precise step.

### 2.4 Multi-Agent Delegation
Sub-agents inherit the parent's `SessionService` and write into namespaced state keys. Parent reads delegated results via state lookup, not via "ask the sub-agent what it did." This eliminates the "telephone game" failure mode in hierarchical teams.

### 2.5 Atomic state_delta Pattern
All transitions are merged via a single state-delta blob: `{ "key.a": newVal, "key.b": null }`. No partial writes. Reads after a write see the merged view. Critical for concurrency safety when webhooks fire while the agent is mid-step.

---

## 3. Comparison to NanoClaw's Current Architecture

| Dimension | Google ADK | NanoClaw (today) |
|---|---|---|
| **Where is workflow state stored?** | `SessionService` (SQLite/CloudSQL), keyed `state["step"]` | Reconstructed from WhatsApp message history + `tasks` table |
| **How does agent know "where it is"?** | Reads `state["step"]` from session | Reads recent messages + KANBAN.md injection |
| **Atomic transitions?** | `state_delta` merge — one write per event | Per-tool DB writes; no transactional grouping |
| **Pausing model?** | First-class `pause()` + continuation token | Container exit; agent re-spawned with full history replay |
| **Sub-agent results?** | Read from namespaced state keys | `SendMessage` / `TaskUpdate` (conversation-based) |
| **Webhook resumption?** | Native — webhook delivers `state_delta` | None — external events route through WhatsApp inbound or scheduled tasks |
| **Identity (agent)?** | Implicit via ADK runtime | ✅ Built — `src/identity/` (Ed25519, evidence chains, trust scoring) |
| **Identity (entity — people/companies)?** | Out of scope for ADK | ❌ **Not implemented** — no entity resolution layer |

### What NanoClaw Has That ADK Doesn't
- **Agent identity layer** (`src/identity/`): cryptographic signing, tamper-evident evidence chains, outcome-based trust scoring (`AgentTrustScore`). ADK relies on the framework boundary; NanoClaw can verify "agent X actually performed action Y."
- **Multi-channel surface**: WhatsApp + Telegram + email vs ADK's webhook-only model.
- **Per-group isolation**: Container-per-group filesystem + memory isolation. ADK assumes a single tenant context.

### What ADK Has That NanoClaw Doesn't
- **State machine grounding.** NanoClaw teams currently reconstruct "what step are we on?" from `tasks.md` + conversation. This works for short workflows but degrades on multi-day delegations.
- **Pausable continuations.** When a NanoClaw team waits on a human (HITL gate, bounty approval), the container exits and the team is re-formed on next inbound. State is implicit in `tasks` table rows.
- **Atomic state_delta.** Today, a tool call that updates 3 task rows + 1 group memory file is 4 separate writes. A crash mid-sequence leaves inconsistent state.
- **Entity resolution.** When two messages reference "Sarah from Acme" and "Sarah Chen at Acme Corp," NanoClaw has no graph that says these are the same person. Each agent must re-derive.

---

## 4. Implementation Gaps

### Gap A — State Machine Layer (Workflow State)
NanoClaw needs a `WorkflowState` table keyed by `(team_id, workflow_id)` storing `current_step`, `state_blob`, `version`. Tools must read from this — not from `getRecentMessages()`.

### Gap B — Atomic Transition API
A `transitionState(workflowId, delta, newStep)` IPC handler that wraps the write in a SQLite transaction and bumps a version counter. Optimistic concurrency control rejects stale writes.

### Gap C — Pause / Resume Primitives
Container agents need a `pause(continuation_token, expected_event)` tool. Host stores the token. Inbound webhook handlers (Twilio, Cloudflare Worker, etc.) look up the token and re-spawn the container with `state_delta` pre-applied.

### Gap D — Entity Resolution Graph (NEW — distinct from agent identity)
A separate `entity_graph` subsystem to canonicalize references to people, companies, and resources across messages, tasks, and tools. **Must not be confused with `src/identity/` which authenticates agents.** Different problem, different data, different SLA.

### Gap E — Hierarchical State Namespacing
Sub-teams must inherit parent state with a namespace prefix (e.g., `parent.research.findings`). Reads bubble up via inheritance chain. Today, sub-teams `SendMessage` results back, which is lossy.

---

## 5. Recommended Architecture (Summary)

Detailed design lives in `IDENTITY_GRAPH_PROPOSAL.md`. High-level:

1. **`src/workflow-state.ts`** — durable state machine for multi-step team workflows. Backed by new `workflow_states` SQLite table.
2. **`src/entity-graph/`** — entity resolution subsystem. New tables: `entities`, `entity_aliases`, `entity_evidence`, `match_proposals`. Sits beside `src/identity/`; **does not share types**.
3. **IPC additions** — `workflow_get`, `workflow_transition`, `workflow_pause`, `workflow_resume`, `entity_resolve`, `entity_link`, `entity_propose_merge`.
4. **Webhook surface** — `src/channels/webhook.ts` accepts `{ continuation_token, state_delta }` from Cloudflare Worker; resumes paused workflows.
5. **Team coordination upgrade** — `TeamOrchestrator` reads/writes `workflow_states` instead of relying on `SendMessage` for handoffs.

---

## 6. Why Both Layers Matter

The ADK article focuses on **workflow state** (where am I in this process?). NanoClaw's existing `src/identity/` covers **agent identity** (who is acting?). The missing third leg is **entity identity** (who/what is the action *about*?).

Without entity resolution, a multi-agent team handling "Sarah's onboarding" can correctly know *which agent is speaking* (identity) and *which step they're on* (workflow state) but still produce two onboarding records because Agent A called her "Sarah Chen" and Agent B called her "S. Chen, Acme."

The proposal in `IDENTITY_GRAPH_PROPOSAL.md` addresses both gaps as a coordinated upgrade: state machines + entity graph, sharing the same atomic-write discipline that ADK pioneered.
