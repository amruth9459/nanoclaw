/**
 * Outcome-based trust scoring.
 *
 * Trust is computed from evidence chain integrity, outcome reliability,
 * credential freshness, and delegation depth — never self-reported.
 */
import { getDb } from '../db.js';
import { getIdentity, getDelegationHops } from './identity-store.js';
import { verifyChain, getOutcomes } from './evidence-chain.js';
import type { AgentTrustScore, TrustFactors, TrustLevel, AuthorizationResult } from './types.js';
import { getScopeForAction } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CREDENTIAL_STALE_DAYS = 90;

// Trust thresholds
const TRUST_HIGH = 0.9;
const TRUST_MODERATE = 0.5;

// Penalties
const CHAIN_BREAK_PENALTY = 0.5;
const OUTCOME_FAILURE_WEIGHT = 0.4;
const CREDENTIAL_STALE_PENALTY = 0.1;
const DELEGATION_HOP_PENALTY = 0.05;
const MAX_DELEGATION_FREE_HOPS = 2;

// Trust level thresholds
const LEVEL_HIGH_THRESHOLD = 0.9;
const LEVEL_MODERATE_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compute the trust score for an agent. */
export async function computeTrustScore(agentId: string): Promise<AgentTrustScore> {
  const identity = getIdentity(agentId);
  if (!identity) {
    return {
      agent_id: agentId,
      score: 0,
      level: 'NONE',
      factors: { chain_integrity: 0, outcome_reliability: 0, credential_freshness: 0, delegation_depth: 0 },
      last_computed: new Date().toISOString(),
    };
  }

  let score = 1.0;
  const factors: TrustFactors = {
    chain_integrity: 0,
    outcome_reliability: 0,
    credential_freshness: 0,
    delegation_depth: 0,
  };

  // 1. Evidence chain integrity (heaviest penalty)
  const chainCheck = await verifyChain(agentId);
  if (!chainCheck.valid) {
    factors.chain_integrity = -CHAIN_BREAK_PENALTY;
    score -= CHAIN_BREAK_PENALTY;
  }

  // 2. Outcome reliability
  const outcomes = getOutcomes(agentId);
  if (outcomes.total > 0) {
    const failureRate = 1.0 - (outcomes.succeeded / outcomes.total);
    factors.outcome_reliability = -(failureRate * OUTCOME_FAILURE_WEIGHT) || 0;
    score += factors.outcome_reliability;
  }

  // 3. Credential freshness
  const ageDays = (Date.now() - new Date(identity.issued_at).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays > CREDENTIAL_STALE_DAYS) {
    factors.credential_freshness = -CREDENTIAL_STALE_PENALTY;
    score -= CREDENTIAL_STALE_PENALTY;
  }

  // 4. Delegation depth
  const hops = getDelegationHops(agentId);
  if (hops > MAX_DELEGATION_FREE_HOPS) {
    factors.delegation_depth = -((hops - MAX_DELEGATION_FREE_HOPS) * DELEGATION_HOP_PENALTY);
    score += factors.delegation_depth;
  }

  score = Math.max(score, 0.0);

  const level = getTrustLevel(score);

  const trustScore: AgentTrustScore = {
    agent_id: agentId,
    score: Math.round(score * 10000) / 10000,
    level,
    factors,
    last_computed: new Date().toISOString(),
  };

  // Persist
  saveTrustScore(trustScore);

  return trustScore;
}

/** Convert a numeric score to a trust level. */
export function getTrustLevel(score: number): TrustLevel {
  if (score >= LEVEL_HIGH_THRESHOLD) return 'HIGH';
  if (score >= LEVEL_MODERATE_THRESHOLD) return 'MODERATE';
  if (score > 0) return 'LOW';
  return 'NONE';
}

/**
 * Check whether an agent is authorized to perform an action.
 * Checks scope, credential expiry, and trust threshold.
 */
export async function authorizeAction(agentId: string, action: string): Promise<AuthorizationResult> {
  const identity = getIdentity(agentId);
  if (!identity) {
    return { authorized: false, reason: 'unknown_agent' };
  }

  // Check scope
  const requiredScope = getScopeForAction(action);
  if (!identity.scopes.includes(requiredScope)) {
    return { authorized: false, reason: 'insufficient_scope' };
  }

  // Check credential expiry
  if (new Date(identity.expires_at) <= new Date()) {
    return { authorized: false, reason: 'credential_expired' };
  }

  // Check trust threshold
  const trustScore = await computeTrustScore(agentId);
  const isHighRisk = action.includes('destructive') || action.includes('payment');

  if (isHighRisk) {
    if (trustScore.score < TRUST_HIGH) {
      return { authorized: false, reason: `trust_too_low (${trustScore.score} < ${TRUST_HIGH} required for high-risk actions)` };
    }
  } else {
    if (trustScore.score < TRUST_MODERATE) {
      return { authorized: false, reason: `trust_too_low (${trustScore.score} < ${TRUST_MODERATE})` };
    }
  }

  return { authorized: true };
}

/** Retrieve the cached trust score from the DB (may be stale). */
export function getCachedTrustScore(agentId: string): AgentTrustScore | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_trust_scores WHERE agent_id = ?').get(agentId) as TrustScoreRow | undefined;
  if (!row) return null;
  return {
    agent_id: row.agent_id,
    score: row.score,
    level: row.level as TrustLevel,
    factors: JSON.parse(row.factors),
    last_computed: row.last_computed,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function saveTrustScore(ts: AgentTrustScore): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_trust_scores (agent_id, score, level, factors, last_computed)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      score = excluded.score,
      level = excluded.level,
      factors = excluded.factors,
      last_computed = excluded.last_computed
  `).run(ts.agent_id, ts.score, ts.level, JSON.stringify(ts.factors), ts.last_computed);
}

interface TrustScoreRow {
  agent_id: string;
  score: number;
  level: string;
  factors: string;
  last_computed: string;
}
