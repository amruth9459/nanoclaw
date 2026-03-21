/**
 * Tamper-evident evidence chain.
 *
 * Every agent action is recorded as a hash-linked, signed evidence record.
 * Chain integrity can be verified at any time — if any record is modified
 * or deleted, the chain breaks.
 */
import crypto from 'node:crypto';

import { getDb } from '../db.js';
import { signData, verifySignature } from './keypair.js';
import { getIdentity, loadSecretKey } from './identity-store.js';
import { getScopeForAction } from './types.js';
import type {
  ActionType,
  EvidenceAuthorization,
  EvidenceOutcome,
  EvidenceRecord,
} from './types.js';

// ---------------------------------------------------------------------------
// Genesis hash (no previous record)
// ---------------------------------------------------------------------------

const GENESIS_HASH = '0'.repeat(64);

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Build a canonical JSON representation of a record (excluding record_hash
 * and signature). Keys are sorted alphabetically.
 */
function canonicalRecord(record: Omit<EvidenceRecord, 'record_hash' | 'signature'>): string {
  // Sort keys deterministically
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    ordered[key] = (record as Record<string, unknown>)[key];
  }
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a new evidence record to the chain for a given agent.
 * Computes hash, signs with agent key, and persists to SQLite.
 */
export async function createEvidence(
  agentId: string,
  actionType: ActionType,
  actionDetails: Record<string, unknown>,
  intent: string,
  outcome: EvidenceOutcome,
  delegatedBy?: string,
): Promise<EvidenceRecord> {
  const identity = getIdentity(agentId);
  if (!identity) throw new Error(`Unknown agent: ${agentId}`);

  const secretKey = loadSecretKey(agentId);
  if (!secretKey) throw new Error(`Cannot load secret key for agent: ${agentId}`);

  // Get the previous record's hash for chain linking
  const prevHash = getLatestHash(agentId);

  const authorization: EvidenceAuthorization = {
    scope_required: getScopeForAction(actionType),
    scope_verified: identity.scopes.includes(getScopeForAction(actionType)),
    authorized_by: delegatedBy,
  };

  const partial: Omit<EvidenceRecord, 'record_hash' | 'signature'> = {
    record_id: crypto.randomUUID(),
    agent_id: agentId,
    agent_name: identity.agent_name,
    action_type: actionType,
    action_details: actionDetails,
    intent,
    authorization,
    outcome,
    timestamp: new Date().toISOString(),
    prev_record_hash: prevHash,
  };

  // Hash the canonical representation
  const canonical = canonicalRecord(partial);
  const recordHash = crypto.createHash('sha256').update(canonical).digest('hex');

  // Sign the canonical representation
  const signature = await signData(canonical, secretKey);

  const record: EvidenceRecord = {
    ...partial,
    record_hash: recordHash,
    signature,
  };

  // Persist
  const db = getDb();
  db.prepare(`
    INSERT INTO evidence_chain
      (record_id, agent_id, agent_name, action_type, action_details, intent,
       authorization, outcome, timestamp, prev_record_hash, record_hash, signature)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.record_id,
    record.agent_id,
    record.agent_name,
    record.action_type,
    JSON.stringify(record.action_details),
    record.intent,
    JSON.stringify(record.authorization),
    JSON.stringify(record.outcome),
    record.timestamp,
    record.prev_record_hash,
    record.record_hash,
    record.signature,
  );

  return record;
}

/**
 * Verify the integrity of an agent's entire evidence chain.
 * Returns { valid: true } if all hashes, signatures, and links check out.
 */
export async function verifyChain(agentId: string): Promise<{ valid: boolean; broken_at?: number; reason?: string }> {
  const chain = getChain(agentId);
  if (chain.length === 0) return { valid: true };

  for (let i = 0; i < chain.length; i++) {
    const record = chain[i];

    // Reconstruct the partial record (without record_hash and signature)
    const { record_hash, signature, ...rest } = record;
    const canonical = canonicalRecord(rest);

    // 1. Verify hash
    const computedHash = crypto.createHash('sha256').update(canonical).digest('hex');
    if (computedHash !== record_hash) {
      return { valid: false, broken_at: i, reason: 'hash_mismatch' };
    }

    // 2. Verify signature
    const identity = getIdentity(record.agent_id);
    if (!identity) {
      return { valid: false, broken_at: i, reason: 'unknown_agent' };
    }
    const sigValid = await verifySignature(canonical, signature, identity.public_key);
    if (!sigValid) {
      return { valid: false, broken_at: i, reason: 'invalid_signature' };
    }

    // 3. Verify chain link
    if (i === 0) {
      if (record.prev_record_hash !== GENESIS_HASH) {
        return { valid: false, broken_at: i, reason: 'invalid_genesis' };
      }
    } else {
      if (record.prev_record_hash !== chain[i - 1].record_hash) {
        return { valid: false, broken_at: i, reason: 'broken_link' };
      }
    }
  }

  return { valid: true };
}

/** Retrieve all evidence records for an agent, ordered by timestamp. */
export function getChain(agentId: string): EvidenceRecord[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM evidence_chain WHERE agent_id = ? ORDER BY rowid ASC'
  ).all(agentId) as EvidenceRow[];
  return rows.map(rowToRecord);
}

/** Get outcome counts for an agent (succeeded / total). */
export function getOutcomes(agentId: string): { succeeded: number; total: number } {
  const db = getDb();
  const total = (db.prepare(
    'SELECT COUNT(*) as cnt FROM evidence_chain WHERE agent_id = ?'
  ).get(agentId) as { cnt: number }).cnt;

  const succeeded = (db.prepare(
    `SELECT COUNT(*) as cnt FROM evidence_chain WHERE agent_id = ? AND json_extract(outcome, '$.success') = 1`
  ).get(agentId) as { cnt: number }).cnt;

  return { succeeded, total };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function getLatestHash(agentId: string): string {
  const db = getDb();
  const row = db.prepare(
    'SELECT record_hash FROM evidence_chain WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1'
  ).get(agentId) as { record_hash: string } | undefined;
  return row?.record_hash ?? GENESIS_HASH;
}

interface EvidenceRow {
  record_id: string;
  agent_id: string;
  agent_name: string;
  action_type: string;
  action_details: string;
  intent: string;
  authorization: string;
  outcome: string;
  timestamp: string;
  prev_record_hash: string;
  record_hash: string;
  signature: string;
}

function rowToRecord(row: EvidenceRow): EvidenceRecord {
  return {
    record_id: row.record_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    action_type: row.action_type as ActionType,
    action_details: JSON.parse(row.action_details),
    intent: row.intent,
    authorization: JSON.parse(row.authorization),
    outcome: JSON.parse(row.outcome),
    timestamp: row.timestamp,
    prev_record_hash: row.prev_record_hash,
    record_hash: row.record_hash,
    signature: row.signature,
  };
}
