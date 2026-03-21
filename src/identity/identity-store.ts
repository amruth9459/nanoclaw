/**
 * Agent identity storage and retrieval.
 *
 * Persists agent identities to SQLite and manages lifecycle
 * (create, get, expire).
 */
import crypto from 'node:crypto';

import { getDb } from '../db.js';
import {
  generateKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
  publicKeyToBase64,
} from './keypair.js';
import type { AgentIdentity, AgentScope, StoredIdentity } from './types.js';
import { getDefaultScopes } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_EXPIRY_DAYS = 90;
const ROOT_ISSUER = 'nanoclaw-root';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new agent identity with a fresh Ed25519 keypair.
 * The private key is encrypted with the host key and stored alongside.
 */
export async function createIdentity(
  agentName: string,
  agentType: string,
  scopes?: AgentScope[],
  issuer?: string,
): Promise<{ identity: AgentIdentity; secretKey: Uint8Array }> {
  const keypair = await generateKeypair();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const identity: StoredIdentity = {
    agent_id: `agent-${crypto.randomUUID()}`,
    agent_name: agentName,
    agent_type: agentType,
    public_key: publicKeyToBase64(keypair.publicKey),
    private_key_encrypted: encryptPrivateKey(keypair.secretKey),
    issued_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    scopes: scopes ?? getDefaultScopes(agentType),
    issuer: issuer ?? ROOT_ISSUER,
  };

  const db = getDb();
  db.prepare(`
    INSERT INTO agent_identities
      (agent_id, agent_name, agent_type, public_key, private_key_encrypted,
       issued_at, expires_at, scopes, issuer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    identity.agent_id,
    identity.agent_name,
    identity.agent_type,
    identity.public_key,
    identity.private_key_encrypted,
    identity.issued_at,
    identity.expires_at,
    JSON.stringify(identity.scopes),
    identity.issuer,
  );

  return {
    identity: toPublicIdentity(identity),
    secretKey: keypair.secretKey,
  };
}

/** Retrieve an agent identity by agent_id. Returns null if not found. */
export function getIdentity(agentId: string): AgentIdentity | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_identities WHERE agent_id = ?').get(agentId) as StoredIdentityRow | undefined;
  if (!row) return null;
  return rowToIdentity(row);
}

/** Retrieve an agent identity by name. Returns null if not found. */
export function getIdentityByName(agentName: string): AgentIdentity | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_identities WHERE agent_name = ? ORDER BY issued_at DESC LIMIT 1').get(agentName) as StoredIdentityRow | undefined;
  if (!row) return null;
  return rowToIdentity(row);
}

/** List all agent identities. */
export function listIdentities(): AgentIdentity[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_identities ORDER BY issued_at DESC').all() as StoredIdentityRow[];
  return rows.map(rowToIdentity);
}

/** Load the decrypted secret key for an agent (host-only operation). */
export function loadSecretKey(agentId: string): Uint8Array | null {
  const db = getDb();
  const row = db.prepare('SELECT private_key_encrypted FROM agent_identities WHERE agent_id = ?').get(agentId) as { private_key_encrypted: string } | undefined;
  if (!row) return null;
  return decryptPrivateKey(row.private_key_encrypted);
}

/** Mark an identity as expired (sets expires_at to now). */
export function expireIdentity(agentId: string): boolean {
  const db = getDb();
  const result = db.prepare('UPDATE agent_identities SET expires_at = ? WHERE agent_id = ?')
    .run(new Date().toISOString(), agentId);
  return result.changes > 0;
}

/** Check if an identity exists by agent_id. */
export function hasIdentity(agentId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM agent_identities WHERE agent_id = ?').get(agentId);
  return row !== undefined;
}

/** Count delegation hops from an agent back to the root issuer. */
export function getDelegationHops(agentId: string): number {
  let hops = 0;
  let currentId = agentId;
  const visited = new Set<string>();

  while (hops < 10) { // Safety limit
    const identity = getIdentity(currentId);
    if (!identity) break;
    if (identity.issuer === ROOT_ISSUER) break;
    if (visited.has(identity.issuer)) break; // Cycle detection
    visited.add(currentId);
    currentId = identity.issuer;
    hops++;
  }

  return hops;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface StoredIdentityRow {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  public_key: string;
  private_key_encrypted: string;
  issued_at: string;
  expires_at: string;
  scopes: string;
  issuer: string;
}

function rowToIdentity(row: StoredIdentityRow): AgentIdentity {
  return {
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    agent_type: row.agent_type,
    public_key: row.public_key,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    scopes: JSON.parse(row.scopes) as AgentScope[],
    issuer: row.issuer,
  };
}

function toPublicIdentity(stored: StoredIdentity): AgentIdentity {
  const { private_key_encrypted: _, ...pub } = stored;
  return pub;
}
