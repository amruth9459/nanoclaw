/**
 * GSD (Get Shit Done) — Type definitions
 *
 * Spec-driven development system that keeps autonomous agents
 * on-task through context preservation, drift detection, and
 * auto-checkpointing.
 */

// ── Spec types ──────────────────────────────────────────────────────────────────

export interface SpecFrontmatter {
  goal: string;
  target_value?: number;
  deadline?: string;
  success_criteria: string[];
  constraints: string[];
  priorities: string[];
  jira_id?: string;
  branch_type?: 'feature' | 'bugfix' | 'hotfix';
}

export interface SpecChecklistItem {
  text: string;
  done: boolean;
}

export interface SpecPhase {
  name: string;
  items: SpecChecklistItem[];
}

export interface Spec {
  id: string;
  projectPath: string;
  frontmatter: SpecFrontmatter;
  body: string;
  phases: SpecPhase[];
  createdAt: number;
  updatedAt: number;
  status: 'active' | 'completed' | 'paused' | 'abandoned';
}

// ── Checkpoint types ────────────────────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  specId: string;
  agentId: string;
  summary: string;
  completedItems: string[];
  nextItems: string[];
  blockers: string[];
  timestamp: number;
}

// ── Drift types ─────────────────────────────────────────────────────────────────

export type DriftSeverity = 'low' | 'medium' | 'high';

export interface DriftAlert {
  id: string;
  specId: string;
  description: string;
  taskDescription: string;
  severity: DriftSeverity;
  timestamp: number;
}

// ── Progress types ──────────────────────────────────────────────────────────────

export interface SpecProgress {
  completed: number;
  total: number;
  next: string | null;
  blockers: string[];
  phases: Array<{
    name: string;
    completed: number;
    total: number;
  }>;
}

// ── Meta-prompt types ───────────────────────────────────────────────────────────

export type AgentRole = 'developer' | 'reviewer' | 'tester' | 'planner';

export interface MetaPromptOptions {
  role: AgentRole;
  specId: string;
  currentTask?: string;
  turnNumber?: number;
  checkpointInterval?: number;
}

// ── GSD Tool types ──────────────────────────────────────────────────────────────

export type GsdAction =
  | 'init'
  | 'status'
  | 'checkpoint'
  | 'validate'
  | 'update'
  | 'complete_item'
  | 'list'
  | 'gen_branch'
  | 'gen_commit'
  | 'gen_pr'
  | 'validate_branch'
  | 'validate_commit';

export interface GsdToolInput {
  action: GsdAction;
  spec_id?: string;
  project_path?: string;
  goal?: string;
  summary?: string;
  task_description?: string;
  item_text?: string;
  success_criteria?: string[];
  constraints?: string[];
  priorities?: string[];
  jira_id?: string;
  branch_type?: 'feature' | 'bugfix' | 'hotfix';
  gitmoji?: string;
  description?: string;
  testing_notes?: string;
  risk_notes?: string;
  branch_name?: string;
  commit_message?: string;
}

// ── DB row types ────────────────────────────────────────────────────────────────

export interface GsdSpecRow {
  spec_id: string;
  project_path: string;
  goal: string;
  frontmatter_json: string;
  body: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface GsdCheckpointRow {
  checkpoint_id: string;
  spec_id: string;
  agent_id: string;
  summary: string;
  completed_json: string;
  next_json: string;
  blockers_json: string;
  timestamp: number;
}

export interface GsdDriftAlertRow {
  alert_id: string;
  spec_id: string;
  drift_description: string;
  task_description: string;
  severity: string;
  timestamp: number;
}
