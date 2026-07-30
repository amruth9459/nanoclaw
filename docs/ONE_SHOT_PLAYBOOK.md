# One-Shot Playbook

*How to get agent output right the first time, distilled from an audit of this repo's
full history (300 commits, build log, changelog) and sibling projects' recorded
post-mortems. 2026-07-30.*

## The finding in one sentence

Round count tracks the quality of the verification target, not the capability of the
agent: work with a machine-checkable bar converged in 0–2 rounds; work graded by taste,
by a broken metric, or by nothing took 5+ rounds or never converged.

Evidence from this repo:

- Five 400–965-line analysis documents (SDK_DEEP_DIVE, HARDENING_CHECKLIST, etc.) each
  landed in **one commit** — the agent could read the ground truth in-session.
- A 3-line message-cursor bug was fixed **four times over 5 weeks** (BUILD_LOG:950,
  1212, 1213, 1230) and is still listed open in DEBUG_CHECKLIST.md — its ground truth
  was a 30-minute wall-clock race no test could express.
- `skills-engine/` (17 tests : 20 source files) appears **zero** times in the top-40
  churn list. `src/index.ts` and `container/agent-runner/` (0 direct tests) are churn
  ranks 1, 5, and 7 and host every recurring bug. Churn correlates with absence of
  tests, not intrinsic complexity.
- 30% of all build-log entries are fixes; the top fix clusters (WhatsApp channel: 19,
  container lifecycle: 16) are exactly the untestable I/O boundaries.

## The five root causes of repeated refinement rounds

1. **Broken or blind measuring instruments.** A metric that cannot go down is worse
   than no metric — it manufactures confidence and funds the next wrong round.
   Before trusting any eval, test, or gate: feed it garbage and confirm the score
   collapses; validate the instrument on a known-positive before trusting a null.
2. **Gates written but never wired.** This repo contains a 330-line QA agent spec that
   nothing invokes, three hooks that unconditionally `exit 0`, CI that runs on PRs only
   (91% of commits were direct `auto-backup` pushes that bypassed it), and a test
   config with no npm script. Writing the checklist is the part agents do well;
   wiring it is what determines whether round 2 happens.
3. **Wrong-layer iteration.** Long sagas are always a plausible fix-loop running
   against the wrong object. The stop-rule: **two failed fixes on the same symptom ⇒
   stop tuning, enumerate the full candidate set, and measure the composite artifact
   the user actually sees.** The trigger is 2, not 5.
4. **Self-referential loops.** The builder must not define the ground truth, write the
   fix, and grade the result. The executor may never edit the gate. Verification of a
   substantive deliverable goes to a fresh, context-free grader prompted to *prove
   failure* — every recorded use of this mechanism found real defects the builder's
   own harness missed. A prompt rule ("Do NOT …") is a hypothesis, not a fix: if a
   failure is mechanically detectable, write the check, not the scold.
5. **Memory that propagates conclusions instead of doubts.** Auto-generated logs
   recorded volume, not signal (969 DEVLOG entries ≈ 29 lines of prose). Handoffs that
   record a narrowed hypothesis ("probably X") make the next session inherit the
   error. Memory must carry: open unknowns ("complaint not yet reproduced"),
   ruled-out branches with the evidence that killed them, and falsifiable proof of
   what worked.

## Standing rules for agent sessions in this repo

- **Gate-invention is the first deliverable.** If no observable bar exists for the
  dimension that matters, stop building and create the bar first (a test, a check
  command, a binary checklist against a reference). Never accept an adjective bar.
- **Restate acceptance criteria before acting** on any implementation task: "Done
  means X compiles, Y observably behaves like Z, nothing outside W changed." Ask one
  clarifying question up front when the restatement is uncertain — it is 10x cheaper
  than a refinement round after.
- **When integrating against a black-box surface** (WhatsApp/Baileys, container
  runtime, any vendor API), build the oracle before the feature: the check that
  proves the effect actually happened end-to-end. Stubs encode the author's
  assumptions; every stub-tested integration needs one live contract smoke.
- **One-shot ≠ one internal pass.** Iterate inside the turn: build → run the gates →
  adversarial self-review of the diff → then deliver. The user should see one
  delivery, not the iteration.
- **Verify claimed state by running commands**, never by summarizing from memory or
  context. "Built and wired" ≠ "working" — unproven until the gate actually runs.
- **As each prose rule becomes an enforced gate, delete the prose.** Instruction
  files decay (groups/main/CLAUDE.md sits at ~98% of its 400-line auto-trim cap);
  hooks do not.

## NanoClaw action checklist (ordered, from the 2026-07-30 audit)

- [ ] **Fix the red test suite.** `npm test` fails on a clean checkout: 31 tests
      (28 in `src/channels/whatsapp.test.ts`, 3 in `src/container-runner.test.ts`).
      Cause: `whatsapp.ts` changed in 3 commits after the test file's last update
      (QR-fail no longer exits the process; watchdog strike logic; reconnect backoff
      is now exponential-from-2s while a test expects a flat 5s retry). Decide the
      intended behavior first, then update tests to match — on the machine where the
      service runs.
- [ ] **Run CI on push, not just PRs** (`.github/workflows/test.yml`), so direct
      pushes cannot bypass typecheck + tests.
- [ ] **Gate commits on message content**: reject content-free messages
      (`auto-backup <timestamp>`) — 273 of 300 commits carried zero information and
      destroyed the audit trail. If hourly snapshots are needed, use a separate
      branch or stash, not main history.
- [ ] **Wire or delete the orphans**: `.claude/agents/auto-qa-security.md` (no
      invocation path), the three `.claude/hooks/*.sh` (all non-blocking, unregistered
      in any tracked settings file — they also hardcode `/Users/amrut` paths).
- [ ] **Close the three known open bugs in `docs/DEBUG_CHECKLIST.md`** — each is a
      few lines (stale resume branch; `IDLE_TIMEOUT == CONTAINER_TIMEOUT` forcing
      SIGKILL exits; cursor advancing before agent success). Write the failing test
      first; that is what kept the cursor bug alive through four "fixes".
- [ ] **Add a test harness for the two churn leaders**: a mock Baileys connection
      state machine and a container-lifecycle spawn/kill/count test, so
      WhatsApp/container bugs stop costing production round-trips.
- [ ] **Convert `groups/main/CLAUDE.md` rules to gates** and trim the prose: the
      "verify by running commands" and "search existing code before building" rules
      are mechanically checkable (PreToolUse hooks); the mental QA checklist should
      be the executable one (`npm run build && npm run test:all` + secret scan)
      before any auto-deploy.
- [ ] **Enforce the layer-shift rule mechanically**: a Stop/PostToolUse hook that
      counts failed fix→test cycles against the same file/symptom and blocks the
      third attempt with "enumerate candidates, measure the composite".
