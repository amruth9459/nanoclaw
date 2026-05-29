-- state_machine: durable per-task state for long-running, pause/resume agent work.
--
-- Inspired by Google ADK's "state machine grounding" pattern: a task's
-- authoritative state lives in a typed row, NOT in reconstructed conversation
-- history. An agent waking from scale-to-zero (or a fresh container) reads its
-- current_step + step_data and resumes deterministically — no need to replay or
-- re-summarize the chat transcript to figure out "where was I?".
--
-- Conventions match src/db.ts:
--   * SQLite, CREATE TABLE IF NOT EXISTS
--   * timestamps are INTEGER (Unix epoch milliseconds), e.g. Date.now()
--   * JSON columns are TEXT with a json_valid() guard
--   * SQLite has no native ENUM — emulated with a CHECK constraint
--
-- This file is the canonical definition. To activate, fold the CREATE statements
-- into the database.exec(`...`) migration block in src/db.ts (see Phase 1 of
-- groups/main/ADK_ANALYSIS.md).

CREATE TABLE IF NOT EXISTS state_machine (
  -- One row per task. task_id is both the PK and the FK to the tasks table,
  -- giving a strict 1:1 between a unit of work and its durable state.
  task_id      TEXT PRIMARY KEY,

  -- The workflow step the task is currently parked at. Enum emulated via CHECK.
  -- Transitions: pending -> research -> implementation -> testing -> review -> completed
  -- (steps may be skipped, but the value must always be one of these).
  current_step TEXT NOT NULL DEFAULT 'pending'
    CHECK (current_step IN (
      'pending',
      'research',
      'implementation',
      'testing',
      'review',
      'completed'
    )),

  -- Arbitrary, step-scoped state as a JSON object. This is the payload an agent
  -- writes before pausing and reads on resume (e.g. research findings, file
  -- diffs in progress, sub-agent assignments, retry counts). Kept as TEXT with
  -- a validity guard so malformed JSON can never be persisted.
  step_data    TEXT
    CHECK (step_data IS NULL OR json_valid(step_data)),

  -- When this state row was last advanced (Unix epoch ms, matches src/db.ts).
  updated_at   INTEGER NOT NULL,

  -- Identity of the agent that last wrote this state — ties each transition to a
  -- verifiable actor in the agent_identities trust graph (see src/db.ts).
  agent_id     TEXT,

  FOREIGN KEY (task_id)  REFERENCES tasks(id),
  FOREIGN KEY (agent_id) REFERENCES agent_identities(agent_id)
);

-- Fast lookup of all tasks parked at a given step (e.g. "what is awaiting
-- review?" or sweeping for resumable work after a restart).
CREATE INDEX IF NOT EXISTS idx_state_machine_step ON state_machine(current_step);

-- Order resumable work by recency of last activity.
CREATE INDEX IF NOT EXISTS idx_state_machine_updated ON state_machine(updated_at);

-- Attribute / audit state transitions per agent.
CREATE INDEX IF NOT EXISTS idx_state_machine_agent ON state_machine(agent_id);
