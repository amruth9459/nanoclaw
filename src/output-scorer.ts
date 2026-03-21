/**
 * Output Scorer — Quality scoring from agent_quality_reviews
 *
 * Karpathy-inspired Phase 2: measures agent output quality using the existing
 * agent_quality_reviews table. Provides baseline measurement and comparison
 * for A/B personality tuning experiments.
 */

import { getDb } from './db.js';
import { logger } from './logger.js';

export interface QualityScore {
  avgApprovalRate: number;   // 0-1 (fraction of approved outputs)
  avgConsensus: number;      // 0-1 (judge agreement)
  totalIssues: number;
  criticalIssues: number;
  sampleSize: number;
}

/**
 * Compute quality score from the last N reviews for a group.
 * Returns null if insufficient data (< 3 reviews).
 */
export function getBaselineQuality(groupId: string, limit = 20): QualityScore | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT approved, consensus, issues_found, critical_issues
    FROM agent_quality_reviews
    WHERE group_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(groupId, limit) as Array<{
    approved: number;
    consensus: number;
    issues_found: number;
    critical_issues: number;
  }>;

  if (rows.length < 3) {
    logger.debug({ groupId, count: rows.length }, 'Insufficient quality reviews for baseline');
    return null;
  }

  const avgApprovalRate = rows.reduce((sum, r) => sum + r.approved, 0) / rows.length;
  const avgConsensus = rows.reduce((sum, r) => sum + r.consensus, 0) / rows.length;
  const totalIssues = rows.reduce((sum, r) => sum + r.issues_found, 0);
  const criticalIssues = rows.reduce((sum, r) => sum + r.critical_issues, 0);

  return {
    avgApprovalRate: Math.round(avgApprovalRate * 1000) / 1000,
    avgConsensus: Math.round(avgConsensus * 1000) / 1000,
    totalIssues,
    criticalIssues,
    sampleSize: rows.length,
  };
}

/**
 * Compute quality score from reviews created after a specific timestamp.
 * Used to measure quality during an experiment window.
 */
export function getQualitySince(groupId: string, sinceTimestamp: string, limit = 20): QualityScore | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT approved, consensus, issues_found, critical_issues
    FROM agent_quality_reviews
    WHERE group_id = ? AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(groupId, sinceTimestamp, limit) as Array<{
    approved: number;
    consensus: number;
    issues_found: number;
    critical_issues: number;
  }>;

  if (rows.length < 3) {
    return null;
  }

  const avgApprovalRate = rows.reduce((sum, r) => sum + r.approved, 0) / rows.length;
  const avgConsensus = rows.reduce((sum, r) => sum + r.consensus, 0) / rows.length;
  const totalIssues = rows.reduce((sum, r) => sum + r.issues_found, 0);
  const criticalIssues = rows.reduce((sum, r) => sum + r.critical_issues, 0);

  return {
    avgApprovalRate: Math.round(avgApprovalRate * 1000) / 1000,
    avgConsensus: Math.round(avgConsensus * 1000) / 1000,
    totalIssues,
    criticalIssues,
    sampleSize: rows.length,
  };
}

/**
 * Compute a single composite quality score (0-100) for comparison.
 * Weights: approval rate (60%), consensus (20%), issue-free rate (20%).
 */
export function compositeScore(quality: QualityScore): number {
  const issueFreeRate = quality.sampleSize > 0
    ? Math.max(0, 1 - quality.totalIssues / (quality.sampleSize * 3)) // normalize: 3 issues/output = 0
    : 0;

  const score =
    quality.avgApprovalRate * 60 +
    quality.avgConsensus * 20 +
    issueFreeRate * 20;

  return Math.round(score * 100) / 100;
}
