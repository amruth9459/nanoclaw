/**
 * GSD Drift Detector — Detects when an agent is doing work not in the spec
 *
 * Uses keyword matching and constraint checking to identify off-spec work.
 * Severity levels: low (tangential), medium (unrelated), high (violates constraints).
 */

import { logger } from '../logger.js';
import type { DriftAlert, DriftSeverity, Spec } from './types.js';
import { createDriftAlert, getDriftAlerts, getSpec } from './db.js';

// ── Drift detection ─────────────────────────────────────────────────────────────

export interface DriftResult {
  isDrift: boolean;
  severity: DriftSeverity;
  reason: string;
}

/** Check if a task description is within the spec's scope */
export function detectDrift(specId: string, taskDescription: string): DriftResult {
  const spec = getSpec(specId);
  if (!spec) {
    return { isDrift: false, severity: 'low', reason: 'No spec found — cannot detect drift' };
  }

  // 1. Check constraint violations (high severity)
  const constraintViolation = checkConstraints(spec, taskDescription);
  if (constraintViolation) {
    return { isDrift: true, severity: 'high', reason: constraintViolation };
  }

  // 2. Check if task is in spec content (not drift)
  if (isInSpec(spec, taskDescription)) {
    return { isDrift: false, severity: 'low', reason: 'Task aligns with spec' };
  }

  // 3. Check if task is related to spec goal (low severity drift)
  if (isRelated(spec, taskDescription)) {
    return { isDrift: true, severity: 'low', reason: 'Task is tangentially related but not in spec. Consider adding to spec if needed.' };
  }

  // 4. Unrelated work (medium severity)
  return {
    isDrift: true,
    severity: 'medium',
    reason: `Task "${taskDescription}" does not appear in the spec. Focus on: ${spec.frontmatter.goal}`,
  };
}

/** Validate a task against the spec and record drift if detected */
export function validateTask(specId: string, taskDescription: string): {
  valid: boolean;
  reason: string;
  alert?: DriftAlert;
} {
  const result = detectDrift(specId, taskDescription);

  if (!result.isDrift) {
    return { valid: true, reason: result.reason };
  }

  // Record the drift alert
  const alert = createDriftAlert({
    specId,
    description: result.reason,
    taskDescription,
    severity: result.severity,
  });

  logger.warn(
    { specId, severity: result.severity, task: taskDescription },
    'GSD drift detected',
  );

  return { valid: false, reason: result.reason, alert };
}

/** Get recent drift alerts for a spec */
export function getRecentDrift(specId: string, limit = 10): DriftAlert[] {
  return getDriftAlerts(specId, limit);
}

// ── Internal matching ───────────────────────────────────────────────────────────

/** Extract keywords from text (lowercase, deduplicated) */
function extractKeywords(text: string): Set<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
    'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'and', 'or', 'but', 'not', 'no', 'so', 'if', 'then', 'than', 'that',
    'this', 'it', 'its', 'add', 'create', 'build', 'make', 'implement',
    'update', 'fix', 'set', 'up', 'get', 'use',
  ]);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w)),
  );
}

/** Check if task description matches spec content (goal, criteria, body) */
function isInSpec(spec: Spec, task: string): boolean {
  const taskKeywords = extractKeywords(task);
  if (taskKeywords.size === 0) return true; // Empty task is fine

  // Build spec keywords from all parts
  const specText = [
    spec.frontmatter.goal,
    ...spec.frontmatter.success_criteria,
    ...spec.frontmatter.priorities,
    spec.body,
  ].join(' ');

  const specKeywords = extractKeywords(specText);

  // Calculate overlap ratio
  let matches = 0;
  for (const kw of taskKeywords) {
    if (specKeywords.has(kw)) matches++;
  }

  const ratio = matches / taskKeywords.size;
  return ratio >= 0.4; // 40%+ keyword overlap → in spec
}

/** Check if task is related to spec goal (looser match) */
function isRelated(spec: Spec, task: string): boolean {
  const taskKeywords = extractKeywords(task);
  const goalKeywords = extractKeywords(spec.frontmatter.goal);

  let matches = 0;
  for (const kw of taskKeywords) {
    if (goalKeywords.has(kw)) matches++;
  }

  return matches > 0;
}

/** Check if task violates any constraints */
function checkConstraints(spec: Spec, task: string): string | null {
  const taskLower = task.toLowerCase();

  for (const constraint of spec.frontmatter.constraints) {
    const constraintLower = constraint.toLowerCase();

    // "No X" or "Don't X" constraints
    const noMatch = constraintLower.match(/^(?:no|don'?t|never|avoid)\s+(.+)/i);
    if (noMatch) {
      const forbidden = noMatch[1].trim();
      const forbiddenKeywords = extractKeywords(forbidden);
      const taskKeywords = extractKeywords(taskLower);

      let overlap = 0;
      for (const kw of forbiddenKeywords) {
        if (taskKeywords.has(kw)) overlap++;
      }

      if (forbiddenKeywords.size > 0 && overlap / forbiddenKeywords.size >= 0.5) {
        return `Constraint violation: "${constraint}" — task appears to involve forbidden activity`;
      }
    }

    // "Use only X" or "Only X" constraints
    const onlyMatch = constraintLower.match(/^(?:use\s+)?only\s+(.+)/i);
    if (onlyMatch) {
      // These are informational — we can't easily detect violations
      // without deeper analysis, so skip for now
    }
  }

  return null;
}
