# Lexios beta outreach pipeline — build spec (`lex-coldcall-beta-01`)

Date: 2026-07-16 · Author: Opus/Fable planning session · Executor: codex-build
Repo: `~/nanoclaw` (this repo). New code lives in `src/outreach/` + small, feature-flagged daemon hooks.

## 1. Goal

Convert the five ready-to-send Lexios outreach drafts (written 2026-07-15, copy is FINAL) into fired outreach where **every human touchpoint is a WhatsApp reply** — approve, edit-flag, skip, or "I'll send via LinkedIn". The pipeline: import verified contacts → propose each personalized email in a WhatsApp group → on approval, send from the lexios.ai Google Workspace mailbox with the Holabird card PNG attached → watch for replies/bounces and post them back to the group within minutes → schedule the one allowed follow-up at +5 business days (also approval-gated) → ledger everything.

Design constraint (load-bearing): the known failure mode is not tooling, it's activation energy — this package has been ready since April and never fired. Anything that requires the user to open a tool and perform a multi-step task will not happen. WhatsApp reply or it doesn't ship.

## 2. Context — read these before writing code

- `~/Brain/Inbox/synthesis/2026-07-15-coldcall-drafts.md` — the 5 final drafts + claims policy + send mechanics. Copy is final; only personalization slots may be inserted.
- `~/Brain/Inbox/synthesis/2026-04-29-cold-call-shortlist.md` — role targets per firm, competitive framing.
- `~/nanoclaw/data/lexios-card-sample/render-branded.html` — attachment source (render to PNG).
- NanoClaw internals to mirror (do not restructure): `src/channels/whatsapp.ts`, `src/task-scheduler.ts`, `src/daily-digest.ts` (the existing proactive-send pattern), the incoming-message dispatch path (`src/router.ts` / `src/index.ts`), `src/db.ts` (SQLite idioms).
- Sender domain **lexios.ai**: Google Workspace MX records are live. As of 2026-07-16 SPF, DKIM (google selector), and DMARC records are ALL ABSENT — preflight must verify them and block live mode until they exist.

Firm keys used everywhere: `zgf`, `stantec`, `pw`, `hks`, `sg`.

## 3. Decisions already made — do not re-open

1. **Language/home**: TypeScript inside this repo, matching existing lint/test config. New module `src/outreach/`, own DB `store/outreach.db` (WAL). Never write to `store/messages.db`.
2. **Two-process split**: the **daemon** (NanoClaw) does WhatsApp only — an outbox announcer + a strict-grammar incoming hook. A separate host-side **worker CLI** does everything Gmail. Gmail credentials never enter the daemon or any container.
3. **No LinkedIn automation** (ToS/ban risk). `li <firm>` produces a copy-paste package; the human sends it.
4. **No tracking pixels / read receipts.** Reply detection only.
5. **Reply classification is rule-based v1** (bounce/OOO headers); drafting responses to human replies is done conversationally by the existing group agent, then imported as a `reply` draft and approval-gated like everything else. No new model integration in this build.
6. **`edit <firm>` flags, it does not regenerate.** A revised draft is imported via CLI (by a Claude session or human), re-linted, re-hashed, re-proposed.
7. **Approvals bind to a content hash.** Any change to subject/body/attachment invalidates prior approval.
8. **Mode ladder**: `mock` (no creds; writes `.eml` files — used by all tests) → `dry` (real creds; sends only to the operator's own address with `[DRY]` subject prefix) → `live` (requires env flag AND fresh preflight pass AND hash-bound approval).
9. **Feature flag**: all daemon behavior is keyed on `NANOCLAW_OUTREACH_GROUP_JID`. Unset ⇒ daemon behavior is byte-identical to today.

## 4. Non-goals

Sequencer/warmup infra, new domains, more than these 5 firms, HTML email templating (plain text + one PNG attachment), auto-sent follow-ups, LinkedIn API, CRM integration beyond the ledger + kanban note, deliverability analytics.

## 5. Hard lines — violating any one = failed build

- Executor never sends a live email and never handles real credentials. All tests run with the mock transport, zero network.
- With `NANOCLAW_OUTREACH_GROUP_JID` unset, the existing daemon test suite passes unchanged and no new code paths execute.
- The claims-lint rule set and the tests asserting the invariants in §8 are the gate: executor may not weaken, skip, or rewrite their assertions. (Gate changes are Opus-only per house policy.)
- Template copy is as provided in the drafts file; only `{{slots}}` may be inserted. Lint enforces this cannot drift (§11).
- Secrets: only via documented env/file paths (§12), `chmod 600`, gitignored. Nothing secret in the repo, ever.

## 6. Architecture

```
┌────────────────────────── host ──────────────────────────┐
│  worker CLI (npm run outreach -- <cmd>)                   │
│   preflight · import-contacts · render-card · propose     │
│   watch [--loop] · followups · import-draft · status      │
│   └── Gmail via MailTransport (real | dry | mock)         │
│                        │  reads/writes                    │
│                 store/outreach.db (SQLite, WAL)           │
│                        │  reads/writes                    │
│  NanoClaw daemon                                          │
│   ├─ announcer: scheduled task (pattern: daily-digest)    │
│   │    polls notifications outbox → sends to group JID    │
│   └─ incoming hook: messages from OUTREACH_GROUP_JID      │
│        matching grammar → approval/command rows + ack,    │
│        NOT routed to the agent; non-matching → normal     │
│        agent flow (so the group doubles as a chat with    │
│        the agent about the campaign)                      │
└───────────────────────────────────────────────────────────┘
```

Concurrency: worker and daemon both touch `outreach.db` — use WAL + busy_timeout (match `src/db.ts` idioms); every state transition is a single transaction.

## 7. Data model (`store/outreach.db`)

```sql
CREATE TABLE contacts (
  firm_key TEXT PRIMARY KEY,             -- zgf|stantec|pw|hks|sg
  firm_name TEXT NOT NULL,
  person_name TEXT, person_title TEXT, linkedin_url TEXT,
  email TEXT,
  email_confidence TEXT CHECK(email_confidence IN ('verified','pattern','unknown')),
  evidence_url TEXT,
  imported_at TEXT NOT NULL
);
CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  firm_key TEXT NOT NULL REFERENCES contacts(firm_key),
  kind TEXT NOT NULL CHECK(kind IN ('first_touch','follow_up','reply')),
  thread_id TEXT,                        -- required for kind='reply'
  subject TEXT NOT NULL, body TEXT NOT NULL,
  attachment_sha TEXT,                   -- sha256 of the PNG, null for reply kind
  content_hash TEXT NOT NULL,            -- sha256(subject + '\n' + body + '\n' + (attachment_sha ?? ''))
  lint_passed_at TEXT,                   -- set only by claims-lint
  superseded_by INTEGER,                 -- edit flow: old draft points at new
  created_at TEXT NOT NULL
);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  content_hash TEXT NOT NULL,            -- must equal drafts.content_hash at send time
  action TEXT NOT NULL CHECK(action IN ('send','linkedin','skip')),
  note TEXT,                             -- skip reason / edit notes
  approved_by_jid TEXT NOT NULL, wa_message_id TEXT,
  approved_at TEXT NOT NULL
);
CREATE TABLE sends (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  approval_id INTEGER NOT NULL REFERENCES approvals(id),
  mode TEXT NOT NULL CHECK(mode IN ('mock','dry','live')),
  gmail_message_id TEXT, thread_id TEXT,
  sent_at TEXT NOT NULL
);
CREATE TABLE replies (
  id INTEGER PRIMARY KEY,
  firm_key TEXT NOT NULL, gmail_message_id TEXT UNIQUE, thread_id TEXT,
  from_addr TEXT, subject TEXT, body_text TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('bounce','ooo','human','unknown')),
  received_at TEXT NOT NULL, posted_at TEXT
);
CREATE TABLE followups (
  id INTEGER PRIMARY KEY,
  firm_key TEXT NOT NULL, due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','proposed','done','cancelled'))
);
CREATE TABLE notifications (                -- daemon outbox
  id INTEGER PRIMARY KEY,
  group_jid TEXT NOT NULL, body TEXT NOT NULL, media_path TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')),
  created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE events (                       -- append-only ledger
  id INTEGER PRIMARY KEY,
  firm_key TEXT, type TEXT NOT NULL, detail TEXT,   -- JSON detail
  created_at TEXT NOT NULL
);
```

## 8. Per-firm state machine + invariants

`discovered → proposed → (approved | linkedin_manual | skipped) → sent → (replied | followup_due) → followup_proposed → … → closed(reason)`

Invariants — each gets a dedicated test that proves the violation is impossible (operation throws / transaction rolls back):

- **I1** No `sends` row without an `approvals` row whose `action='send'` AND `approvals.content_hash == drafts.content_hash` AND `drafts.lint_passed_at IS NOT NULL`.
- **I2** `mode='live'` additionally requires `OUTREACH_MODE=live` in env AND an `events` row `type='preflight_pass'` created within the last 24h.
- **I3** Lifetime max one `first_touch` send per firm and max one `follow_up` send per firm. Enforced in the DB layer, not just the CLI.
- **I4** Claims-lint runs again at send time on the exact outgoing bytes; failure aborts the send even if `lint_passed_at` was set earlier.
- **I5** A reply classified `bounce` or a human reply that the operator marks negative (`skip <firm>: <reason>` after a reply) transitions the firm to `closed` — no further sends possible (I3 + status check).
- **I6** All notifications posted to WhatsApp go through the outbox table; the worker never talks to Baileys, the daemon never talks to Gmail.

## 9. Worker CLI surface

`npm run outreach -- <cmd>` (thin bin wrapper is fine):

| cmd | behavior | acceptance |
|---|---|---|
| `preflight` | Runs checks P1–P8 (§15), prints table, writes `events:preflight_pass/fail` with per-check JSON | exit 0 only if all pass; `--allow-partial` documented for mock/dry work |
| `import-contacts <file.json>` | Validates against the contacts schema (all 5 firm keys, confidence enum, evidence_url present), upserts | invalid file ⇒ exit ≠0, nothing written |
| `render-card` | Headless Chrome (`--headless --screenshot`) renders `render-branded.html` → `data/outreach/holabird-card.png` | PNG exists, >40KB, sha recorded |
| `propose [firm]` | Renders template + contact into a draft (lint, hash), queues the approval card (§10 format) to the outbox | draft row + notification row; re-propose supersedes |
| `watch [--loop --interval 300]` | Polls Gmail for replies in sent threads + bounces to the mailbox; classifies by headers (mailer-daemon/failed-recipient ⇒ bounce; Auto-Submitted/X-Autoreply ⇒ ooo; else human); inserts `replies` + outbox notification with full text | reply visible in WhatsApp ≤15 min while looping |
| `followups` | Creates `followups` rows at send time (+5 business days, weekends skipped, holidays ignored); when due, renders follow-up template and proposes it like a first touch | never auto-sends |
| `import-draft --firm k --kind d --file f [--thread t]` | Path for edits and reply drafts: lint, hash, supersede, re-propose | |
| `status` | One line per firm: state, last event, next action | |
| `e2e-dry` | The G2 gate script (§14) | |

## 10. WhatsApp grammar (daemon incoming hook)

Strict, deterministic, case-insensitive; parsed BEFORE agent routing, only for messages in `NANOCLAW_OUTREACH_GROUP_JID`:

```
send <firm>              → approvals(action='send') for the firm's current proposed draft
li <firm>                → approvals(action='linkedin') + outbox reply with copy-paste package
                           (subject line + body + LinkedIn profile URL; note if body >1900 chars)
edit <firm>: <notes>     → flags draft needs-edit, records notes, notifies (no regeneration)
skip <firm>: <reason>    → approvals(action='skip'), reason into ledger (a "no with a reason"
                           is a scored discovery datapoint — reason is REQUIRED)
status                   → outbox message with the status table
```

Anything else in the group falls through to the normal NanoClaw agent (campaign chat). Every accepted command gets an ack via the outbox (e.g. "✅ send queued for zgf — will fire on next worker run"). Unknown firm key or no proposed draft ⇒ helpful error ack, no state change. The approval row records the sender JID + WA message id (provenance).

## 11. Templates + claims lint

Executor converts the 5 drafts from the Brain file into `data/outreach/templates/<firm>.md` with YAML frontmatter (`subject:`) and body with slots: `{{first_name}}` (fallback if contact name missing: render blocked — proposing without a person_name is an error, never "Hi there"). Follow-up template `follow_up.md` per the mechanics note: one short message referencing the attachment ("did the card render for you?"). Signature appended from `data/outreach/config.json` (`signature` field, user-filled; see P7).

**Claims lint** (`src/outreach/claims-lint.ts`) — deliberate honest-claims policy from the drafts file, enforced mechanically on every outgoing subject+body:

- Banned (regex, case-insensitive): `/\bF1\b/`, `/\d+(\.\d+)?\s*%/` (any percentage), `/air.?gap/`, `/\baccurac/`, `/guarantee/`, `/100\s*percent/`, `/\bTODO\b|\[name\]|\{\{/` (unrendered slots).
- Required: signature block present containing a street-number-style postal line (CAN-SPAM hygiene) and no `TODO`.
- Template-drift guard: for `first_touch` drafts, the rendered body minus slot substitutions must equal the checked-in template body (normalize whitespace). Test includes a poisoned fixture ("99% accuracy, air-gapped") that MUST fail lint.

## 12. Gmail transport

```ts
interface MailTransport {
  send(msg: {to: string; subject: string; textBody: string; attachmentPath?: string; threadId?: string}): Promise<{gmailMessageId: string; threadId: string}>;
  listInboxSince(marker: string|null): Promise<{messages: InboundMessage[]; nextMarker: string}>;
}
```

- **real**: `googleapis` Gmail API. Scopes `gmail.send` + `gmail.readonly` (add `gmail.modify` only if labeling processed replies — preferred over a marker file). OAuth desktop flow; token at `~/.config/lexios-outreach/token.json` (600, gitignored); account from `OUTREACH_MAILBOX` env (expected: an `@lexios.ai` Workspace mailbox). Fallback path documented in runbook only (app password + SMTP/IMAP) — do NOT implement it.
- **dry**: wraps real; rewrites `to` → `OUTREACH_SELF_ADDR`, prefixes subject `[DRY→original@dest]`.
- **mock**: writes RFC822 `.eml` files to `data/outreach/outbox-dry/`, returns synthetic ids; `listInboxSince` reads fixture files from a test-provided dir. All tests and `e2e-dry` use mock only.

Mode resolution: no token file ⇒ mock; token + `OUTREACH_MODE!=live` ⇒ dry; `live` per I2.

## 13. Daemon additions (smallest possible diff)

- **Announcer**: register a scheduled task (reuse `task-scheduler.ts` patterns) that every 2 min drains `notifications` where `status='pending'` → sends via the existing WhatsApp channel (with `media_path` as image attachment when set) → marks `sent`/`failed`. Registered ONLY when `NANOCLAW_OUTREACH_GROUP_JID` is set.
- **Incoming hook**: in the message dispatch path, a narrow pre-agent intercept per §10. Same flag guard.
- Both live in `src/outreach/daemon-hooks.ts` with a single call-site touch in the daemon wiring — keep the diff to existing files under ~20 lines total.

## 14. The gate (observable bar — all must hold)

- **G1** `npm test` green (existing runner/config), including new tests: grammar parser table (≥12 cases incl. unknown firm, missing reason, mixed case, non-command fallthrough), claims-lint positive + poisoned fixtures, invariant tests I1–I6 (each proves the forbidden transition throws), business-day math (Fri+5 ⇒ Fri; crossing weekends), contacts-schema rejection cases, bounce/OOO header classification fixtures.
- **G2** `npm run outreach -- e2e-dry` (zero network, mock transport): fresh temp DB → import fixture contacts → render-card (may be stubbed with a fixture PNG if Chrome absent in CI — detect and note) → propose all 5 → assert 5 notifications → inject approval rows (simulating the hook) for send×3, linkedin×1, skip×1 → worker send pass ⇒ 3 `.eml` files with correct to/subject/attachment + sends rows → inject a bounce fixture + a human-reply fixture → watch pass ⇒ replies rows classified correctly + notifications queued + bounced firm closed → followups created for the 3 sends at +5 business days. Script exits 0 only if every assertion holds.
- **G3** With `NANOCLAW_OUTREACH_GROUP_JID` unset: full pre-existing daemon test suite passes unchanged; grep-level check that no outreach code path is reachable from daemon startup.
- **G4** Fresh-grader pass (context-free grader, per codex-build): grader gets ONLY the repo, this spec §8+§14, and the commands for G1–G3; instructed to prove failure, including three explicit bypass attempts: (a) forge an approval whose hash doesn't match the current draft → send must throw; (b) live-mode send without a preflight_pass event → throw; (c) sneak "99% accuracy" into a template → lint must fail. Grader verdict must be 0 FAIL.
- **G5** `docs/OUTREACH_RUNBOOK.md` exists and contains: the user-gated setup checklist (§15 verbatim DNS records, Workspace mailbox + OAuth client creation steps, WhatsApp group creation + JID registration + env), the day-1 operating sequence (preflight → import contacts → render-card → propose → approve in WhatsApp → send → watch --loop), the dry-run rehearsal procedure, and recovery procedures (re-propose after edit, cancel a firm, what to do on `failed` notifications).

**Loop-until-bar**: iterate biggest-gap-first until G1–G5 all pass; max 4 rounds; if still short, return with the specific failing gate + diff of what remains, never a "mostly done" claim.

## 15. Preflight checks (P1–P8) and user-gated setup

Preflight CLI verifies, each with a machine check:

- **P1** MX for lexios.ai includes google.com hosts (dig).
- **P2** SPF TXT on `lexios.ai` contains `include:_spf.google.com`. *(Absent as of 2026-07-16 — record to add at Cloudflare: `v=spf1 include:_spf.google.com ~all`.)*
- **P3** DKIM TXT exists at `google._domainkey.lexios.ai` *(absent — generate in Workspace Admin → Gmail → Authenticate email, then publish).* 
- **P4** DMARC TXT exists at `_dmarc.lexios.ai` *(absent — start with `v=DMARC1; p=none; rua=mailto:postmaster@lexios.ai`).*
- **P5** OAuth token valid and Gmail profile address == `OUTREACH_MAILBOX`.
- **P6** Card PNG present, >40KB, sha matches drafts' `attachment_sha`.
- **P7** `config.json` signature filled (postal line present, no TODO); all 5 templates pass lint.
- **P8** `NANOCLAW_OUTREACH_GROUP_JID` set + outbox roundtrip: write a test notification, observe `sent` within 2×announcer interval (marked `manual/optional` when daemon isn't running).

User-gated (cannot be done by executor; runbook material): choose/create the `@lexios.ai` sender mailbox; create the GCP OAuth desktop client + first token consent; publish P2–P4 DNS records in Cloudflare; create the "Lexios Outreach" WhatsApp group, register it, set env vars (`NANOCLAW_OUTREACH_GROUP_JID`, `OUTREACH_MAILBOX`, `OUTREACH_SELF_ADDR`, `OUTREACH_MODE`); fill the signature block.

## 16. Deliverables

```
src/outreach/{db.ts, grammar.ts, claims-lint.ts, contacts.ts, templates.ts,
              transport.ts, gmail-real.ts, worker.ts, followups.ts,
              classify.ts, daemon-hooks.ts, cli.ts}
src/outreach/__tests__/…            (or repo's test-location convention)
data/outreach/templates/{zgf,stantec,pw,hks,sg,follow_up}.md
data/outreach/config.json           (signature placeholder, group jid placeholder)
data/outreach/fixtures/…            (contacts fixture, poisoned template, reply/bounce .eml fixtures)
docs/OUTREACH_RUNBOOK.md
package.json script: "outreach"
```

Executor notes: match repo TS/lint/test conventions exactly; no new heavy deps beyond `googleapis` (and reuse existing sqlite dep); keep daemon-file diffs minimal (§13); commit on a feature branch; do not touch `store/messages.db` code paths.

This repo ships a `.claude/skills/add-gmail` skill with GCP OAuth desktop-client setup steps — reuse its guidance for the runbook's OAuth section and any OAuth-flow plumbing, but do NOT adopt its channel/tool wiring: the §3.2 split (Gmail host-side only, never in daemon or containers) overrides it.
