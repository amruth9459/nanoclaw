/**
 * GSD Spec Manager — Create/read/update .gsd/spec.md files
 *
 * Handles the lifecycle of spec files: parsing YAML frontmatter,
 * validating required fields, and syncing to the database.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { logger } from '../logger.js';
import type { Spec, SpecFrontmatter } from './types.js';
import {
  createSpec as dbCreateSpec,
  getSpec,
  getSpecByProject,
  updateSpec as dbUpdateSpec,
  listSpecs,
  toggleChecklistItem,
} from './db.js';

const GSD_DIR = '.gsd';
const SPEC_FILENAME = 'spec.md';

// ── Validation ──────────────────────────────────────────────────────────────────

const REQUIRED_FRONTMATTER_FIELDS: (keyof SpecFrontmatter)[] = [
  'goal',
  'success_criteria',
  'constraints',
  'priorities',
];

export interface ValidationError {
  field: string;
  message: string;
}

export function validateFrontmatter(fm: Partial<SpecFrontmatter>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!fm.goal || typeof fm.goal !== 'string' || fm.goal.trim().length === 0) {
    errors.push({ field: 'goal', message: 'Goal is required and must be a non-empty string' });
  }
  if (!Array.isArray(fm.success_criteria) || fm.success_criteria.length === 0) {
    errors.push({ field: 'success_criteria', message: 'At least one success criterion is required' });
  }
  if (!Array.isArray(fm.constraints)) {
    errors.push({ field: 'constraints', message: 'Constraints must be an array' });
  }
  if (!Array.isArray(fm.priorities)) {
    errors.push({ field: 'priorities', message: 'Priorities must be an array' });
  }
  if (fm.deadline && isNaN(Date.parse(fm.deadline))) {
    errors.push({ field: 'deadline', message: 'Deadline must be a valid date string (YYYY-MM-DD)' });
  }
  if (fm.target_value !== undefined && typeof fm.target_value !== 'number') {
    errors.push({ field: 'target_value', message: 'Target value must be a number' });
  }

  return errors;
}

// ── Spec file I/O ───────────────────────────────────────────────────────────────

/** Parse a spec.md file into frontmatter + body */
export function parseSpecFile(content: string): { frontmatter: SpecFrontmatter; body: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error('Invalid spec file: missing YAML frontmatter (wrap with ---)');
  }

  const frontmatter = yaml.parse(fmMatch[1]) as SpecFrontmatter;
  const body = fmMatch[2].trim();

  const errors = validateFrontmatter(frontmatter);
  if (errors.length > 0) {
    const msg = errors.map(e => `  - ${e.field}: ${e.message}`).join('\n');
    throw new Error(`Invalid spec frontmatter:\n${msg}`);
  }

  return { frontmatter, body };
}

/** Serialize frontmatter + body back to spec.md format */
export function serializeSpec(frontmatter: SpecFrontmatter, body: string): string {
  const fm = yaml.stringify(frontmatter, { lineWidth: 0 }).trim();
  return `---\n${fm}\n---\n\n${body}\n`;
}

/** Generate a spec ID from goal text */
export function generateSpecId(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

// ── Spec lifecycle ──────────────────────────────────────────────────────────────

/** Initialize a new spec from parameters (creates .gsd/spec.md and DB record) */
export function initSpec(opts: {
  projectPath: string;
  goal: string;
  successCriteria: string[];
  constraints?: string[];
  priorities?: string[];
  targetValue?: number;
  deadline?: string;
  body?: string;
}): Spec {
  const specId = generateSpecId(opts.goal);

  // Check for existing active spec
  const existing = getSpecByProject(opts.projectPath);
  if (existing) {
    throw new Error(`Active spec already exists for ${opts.projectPath}: "${existing.frontmatter.goal}" (${existing.id})`);
  }

  const frontmatter: SpecFrontmatter = {
    goal: opts.goal,
    success_criteria: opts.successCriteria,
    constraints: opts.constraints ?? [],
    priorities: opts.priorities ?? [],
    ...(opts.targetValue !== undefined && { target_value: opts.targetValue }),
    ...(opts.deadline && { deadline: opts.deadline }),
  };

  const body = opts.body ?? generateDefaultBody(opts.goal);

  // Write .gsd/spec.md file
  const gsdDir = path.join(opts.projectPath, GSD_DIR);
  fs.mkdirSync(gsdDir, { recursive: true });
  const specPath = path.join(gsdDir, SPEC_FILENAME);
  fs.writeFileSync(specPath, serializeSpec(frontmatter, body));

  // Create DB record
  const spec = dbCreateSpec({ id: specId, projectPath: opts.projectPath, frontmatter, body });

  logger.info({ specId, projectPath: opts.projectPath }, 'GSD spec initialized');
  return spec;
}

/** Load spec from a project directory (reads .gsd/spec.md, syncs to DB) */
export function loadSpec(projectPath: string): Spec | null {
  const specPath = path.join(projectPath, GSD_DIR, SPEC_FILENAME);
  if (!fs.existsSync(specPath)) return null;

  const content = fs.readFileSync(specPath, 'utf-8');
  const { frontmatter, body } = parseSpecFile(content);
  const specId = generateSpecId(frontmatter.goal);

  // Check if already in DB
  const existing = getSpec(specId);
  if (existing) {
    // Sync file changes to DB
    dbUpdateSpec(specId, { frontmatter, body });
    return getSpec(specId)!;
  }

  // Create new DB record from file
  return dbCreateSpec({ id: specId, projectPath, frontmatter, body });
}

/** Update spec body (e.g., mark a checklist item done) and sync to file */
export function completeItem(specId: string, itemText: string): Spec | null {
  const spec = getSpec(specId);
  if (!spec) return null;

  const newBody = toggleChecklistItem(spec.body, itemText, true);
  const updated = dbUpdateSpec(specId, { body: newBody });
  if (!updated) return null;

  // Sync to file
  syncSpecToFile(updated);
  return updated;
}

/** Sync DB state back to .gsd/spec.md file */
export function syncSpecToFile(spec: Spec): void {
  const specPath = path.join(spec.projectPath, GSD_DIR, SPEC_FILENAME);
  const dir = path.dirname(specPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(specPath, serializeSpec(spec.frontmatter, spec.body));
}

/** Get all active specs */
export function getActiveSpecs(): Spec[] {
  return listSpecs('active');
}

/** Mark a spec as completed */
export function completeSpec(specId: string): Spec | null {
  return dbUpdateSpec(specId, { status: 'completed' });
}

// ── Default body template ───────────────────────────────────────────────────────

function generateDefaultBody(goal: string): string {
  return `# ${goal}

## Requirements
1. [Define requirements here]

## Architecture
[Describe system design]

## Implementation Plan
### Phase 1: Setup
- [ ] Define project structure
- [ ] Set up development environment

### Phase 2: Core
- [ ] Implement core functionality
- [ ] Write unit tests

### Phase 3: Polish
- [ ] Integration testing
- [ ] Documentation
- [ ] Deploy
`;
}
