# CatchMe → Whimsy: Technical Analysis

**Task:** `task_1775011658229_x854c30`
**Source:** HKUDS/CatchMe personalization research
**Companion:** [../WHIMSY_PERSONALIZATION_FRAMEWORK.md](../WHIMSY_PERSONALIZATION_FRAMEWORK.md)
**Author:** Whimsy Injector (design subagent)

This document is the *technical* counterpart to the framework. The framework
specifies *what* the whimsy system should do; this document specifies *what
in CatchMe makes that possible* and *how to adapt the techniques without
copying the substrate wholesale.*

---

## 1. Why CatchMe is the right reference for a whimsy system

CatchMe is not a delight system. It's an activity-capture and grounding
system: it turns a user's multi-app workflow into a structured stream that
an LLM can query for context. The reason it matters for whimsy is that *every
plausible whimsy system requires the same upstream substrate* — a queryable
record of what the user is doing, has been doing, and how that maps to
recurring patterns.

Most delight systems skip the substrate and inject whimsy on a flat random
draw. That is the source of the "uncanny customer-service chatbot" feel:
delight uncorrelated with context reads as performance. CatchMe's
contribution, transposed, is *the structural argument that context must come
first.*

We do **not** want to import CatchMe's full apparatus. NanoClaw is a single
host process talking to WhatsApp; we do not have OS-level activity capture
and we do not want it. The adaptation problem is: which CatchMe primitives
can be reconstructed from signals NanoClaw already has?

---

## 2. The four primitives — analysis and adaptation

### 2.1 Hierarchical activity tree

**CatchMe form.** Activity is decomposed top-down: session → task → action →
event. Each node carries timestamps, source app, and structured metadata.
Queries hit the tree at the appropriate level — "what was the user doing
today" hits the task level, "what file did they touch in the last 5 minutes"
hits the event level.

**Why this matters for whimsy.** Whimsy decisions are made at *different
levels* depending on the trigger. "Should this acknowledgment be playful"
needs event-level context (just this message). "Has the user been grinding on
this all day" needs session-level. "Are they on a streak" needs cross-day.
A flat log can't serve all three cheaply.

**NanoClaw adaptation.**

```
group
├── session (one per active conversation window, ~30min gap = new session)
│   ├── thread (consecutive messages on the same intent)
│   │   ├── exchange (one user turn + one agent turn)
│   │   │   └── signals: task_type, frustration, stakes, length, latency
```

- **Session boundary detection:** existing 30-min message gap heuristic.
- **Thread boundary detection:** topic-shift detection via keyword overlap
  drop between consecutive exchanges (cheap, lossy, sufficient).
- **Exchange-level signals:** computed by the detectors in framework §6
  Phase 1.

**Storage.** Not a literal tree in memory. Materialized as
`data/whimsy/events.ndjson` (append-only, one line per exchange) plus a small
in-memory rollup per group. Tree *queries* are implemented as filtered
linear scans over the recent window — at NanoClaw's message volume (<10k
exchanges per group per quarter) this is trivially fast and avoids a
schema-migration tax.

### 2.2 Event-driven capture vs time-based polling

**CatchMe form.** CatchMe captures on *events* (window focus change, file
open, etc.), not on a polling interval. The reason: time-based polling
either over-captures (noise, privacy) or under-captures (misses the
informative state change).

**Why this matters for whimsy.** Whimsy injection has the same asymmetry.
If you inject on a *cadence* ("one joke per 5 messages") you'll mistime it
constantly. The right moments are *event-triggered*: task completion, error
resolution, return after a gap, end-of-session, first-time-this-week.

**NanoClaw adaptation — the whimsy trigger taxonomy.**

| Trigger event             | Detection signal                                       | Whimsy posture             |
|---------------------------|--------------------------------------------------------|----------------------------|
| Task completion (clean)   | Kanban status → done; or agent's last action succeeded | Allow celebration          |
| Task completion (recovered) | Resolved after frustration window                    | One warm note, no fanfare  |
| Return after gap          | First message ≥7 days since last                       | Brief recognition          |
| Session open              | First message of a session window                      | Greeting calibrated to tier|
| Session close             | 30-min silence trigger                                 | None — silence is fine     |
| Streak detected           | Same project touched ≥3 consecutive days               | One callback per streak    |
| New skill / first use     | Skill never invoked by this group before               | Encouragement              |

Triggers are detected at *exchange close* (after agent reply is composed,
before send). This is cheap and avoids any retrofit to the message loop.

### 2.3 Cross-day reasoning

**CatchMe form.** Reasoning across days is what makes the system feel like
it *knows* you. Patterns that repeat across days (Monday morning routine,
end-of-quarter scramble) are first-class.

**Why this matters for whimsy.** Familiarity (framework §2.3) and Recognition
(§5.2) both require cross-day state. Without it, the agent's personality is
permanently frozen at "stranger."

**NanoClaw adaptation.**

`data/whimsy/state.json` per group, updated at session close:

```json
{
  "session_count": 47,
  "first_seen": "2026-03-12",
  "last_seen": "2026-05-27",
  "longest_streak_days": 9,
  "current_streak_days": 3,
  "current_streak_project": "Lexios",
  "rapport_phrases_count": 12,
  "emerged_nicknames": ["claw"],
  "recurring_topics": {"Lexios": 34, "HPM 523": 18, "astrology": 7},
  "tier": "regular"
}
```

This file is the *only* persistent whimsy state. Everything else
re-derives from `events.ndjson`. Keeping the state surface this small means
schema drift is cheap.

**Tier promotion** runs at session close as a pure function of this state.
Never mid-session.

### 2.4 Privacy-preserving design

**CatchMe form.** Activity capture is local by default; aggregation
respects per-app boundaries; no raw event stream leaves the device without
explicit user action.

**Why this matters for whimsy.** Whimsy seems harmless but the *substrate*
(behavioral log) is not. A whimsy log that records frustration scores and
mood trajectories is exactly the kind of data a careless implementation
would ship to an analytics endpoint and regret.

**NanoClaw adaptation — non-negotiable rules.**

1. **No message content** in `events.ndjson`. Only categorical features
   (`task_type`, `frustration_score`, `stakes_flag`, `tier`, `injected`).
   Content stays in `store/messages.db`; whimsy log stays distinct.
2. **No network egress.** Whimsy state never leaves the host. No telemetry,
   no "anonymous usage stats", no exceptions. This must be enforced by
   review — there is no allowlist that won't drift.
3. **Per-group isolation.** A guest group's whimsy state is not readable by
   main group code. Mirrors the existing isolation boundary.
4. **User-visible delete.** `nanoclaw whimsy reset <group>` removes
   `events.ndjson` and `state.json` for that group. No archive, no
   tombstone.
5. **Frustration scores are not displayed back.** The user should never see
   "we detected you were frustrated." That's surveillance UX. Use the score
   internally; show the user a *quieter agent*, not a label.

---

## 3. Techniques deliberately *not* imported from CatchMe

- **OS-level instrumentation.** Out of scope. NanoClaw signals are
  message-stream-only.
- **LLM-based event summarization.** CatchMe uses LLM passes to summarize
  activity. For whimsy this is overkill and expensive. Heuristic detectors
  are sufficient (framework §6 Phase 1).
- **Cross-app correlation.** CatchMe correlates across browser, editor,
  shell. NanoClaw's "apps" are channels (WhatsApp, Telegram); correlation is
  trivial and already implicit in the group abstraction.
- **Embedding-based retrieval.** Tempting for "recurring topics" but a
  simple keyword-count map (see `state.json`) is adequate at NanoClaw's
  scale. Skip until it demonstrably fails.

---

## 4. Risks and failure modes

### 4.1 Detector miscalibration

The detectors are heuristic. A high frustration false-positive rate means
NanoClaw goes silent on engaged users; a high false-negative means it
cheers a frustrated user (worse failure mode). **Tune asymmetrically: bias
toward suppression.** A missed delight moment is invisible; a tone-deaf
delight moment damages trust.

### 4.2 Tier-promotion churn

If familiarity threshold is too low, users get promoted then demoted by
detection noise. **Mitigation:** promotions are sticky — once a user reaches
Regular, they don't drop back to Acquaintance from inactivity. They can be
context-pulled to Stranger (framework §3.3) but the underlying tier holds.

### 4.3 Cross-day staleness

`state.json` can become stale if a group goes silent for months. **Rule:**
on first message after ≥30 days, treat as a "soft reintroduction" —
maintain tier but suppress callbacks for the first session, since the
user's context has likely shifted.

### 4.4 Personality drift in long-running groups

Companion-tier groups (60+ sessions) accumulate inside references that may
no longer be appropriate. **Mitigation:** `emerged_nicknames` and recurring
in-jokes have a 90-day TTL of last-use. If not reinforced, they age out
silently.

### 4.5 Multi-user groups

Some NanoClaw groups have multiple humans. Personality calibrated to one
user can feel intrusive when a second human reads back the transcript.
**Mitigation:** if a group's message stream shows ≥2 distinct human
identities (detectable via phone JID), cap tier at Acquaintance regardless
of session count. This is conservative but correct.

---

## 5. Minimum viable wiring

What it would take to ship Phases 0–2 (framework §6):

1. New module `src/whimsy/` with: `detectors.ts`, `state.ts`, `log.ts`.
2. Single integration point: `src/router.ts` outbound path calls
   `whimsy.gate(message, context)` → returns possibly-rewritten message.
3. `data/whimsy/` added to `.gitignore` and the per-group isolation boundary.
4. CLI: `nanoclaw whimsy status <group>` (debug), `nanoclaw whimsy reset
   <group>` (user-facing).
5. No model changes, no prompt changes, no schema migrations.

Phases 0–2 are the high-leverage subset. They ship the suppression behavior
— which is most of the perceived improvement — without committing to the
generative side.

---

## 6. Open questions

- **Frustration detection on non-English messages.** Current heuristics
  assume English markers ("ugh", "still", "why"). Multi-language groups need
  per-language marker sets. Defer until needed.
- **Whimsy and scheduled tasks.** Tasks dispatched by the scheduler aren't
  user-initiated. Should they ever carry whimsy? Lean: no, scheduled output
  stays neutral. The user didn't ask for the message; they shouldn't get
  cheer.
- **Whimsy in agent-swarm subagents.** When a Telegram swarm subagent
  replies, does it inherit the parent's tier? Probably yes, but each subagent
  may need its own *voice* within that tier. Out of scope for v0.1.

---

*End of analysis.*
