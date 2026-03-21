/**
 * Message signing and verification protocol.
 *
 * Signs inter-agent messages with Ed25519 and verifies them with
 * timestamp freshness, nonce uniqueness, scope checks, and identity
 * currency. Fail-closed: all checks must pass.
 */
import crypto from 'node:crypto';

import { getDb } from '../db.js';
import { signData, verifySignature, publicKeyToBase64 } from './keypair.js';
import { getIdentity } from './identity-store.js';
import { getScopeForMessageType } from './types.js';
import type {
  SignedMessage,
  UnsignedMessage,
  VerificationResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum age (in ms) for a message to be considered fresh. */
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Build a canonical JSON representation of the message payload.
 * Keys are always sorted alphabetically for deterministic hashing.
 */
export function canonicalPayload(msg: UnsignedMessage): string {
  const obj: Record<string, unknown> = {
    content: msg.content,
    nonce: msg.nonce,
    recipient_agent_id: msg.recipient_agent_id,
    sender_agent_id: msg.sender_agent_id,
    summary: msg.summary,
    timestamp: msg.timestamp,
    type: msg.type,
  };
  // JSON.stringify with sorted keys
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// ---------------------------------------------------------------------------
// Nonce management
// ---------------------------------------------------------------------------

function recordNonce(nonce: string): void {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO seen_nonces (nonce, seen_at) VALUES (?, ?)')
    .run(nonce, new Date().toISOString());
}

function isNonceSeen(nonce: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM seen_nonces WHERE nonce = ?').get(nonce);
  return row !== undefined;
}

/** Generate a cryptographically random 32-byte hex nonce. */
export function generateNonce(): string {
  return crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/**
 * Sign an unsigned message with the sender's private key.
 * Returns a fully signed message ready for transmission.
 */
export async function signMessage(
  message: UnsignedMessage,
  secretKey: Uint8Array,
  publicKey: Uint8Array,
): Promise<SignedMessage> {
  const canonical = canonicalPayload(message);
  const signature = await signData(canonical, secretKey);

  return {
    ...message,
    signature,
    public_key: publicKeyToBase64(publicKey),
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a signed message. All checks must pass (fail-closed).
 *
 * Checks:
 * 1. Ed25519 signature matches canonical payload
 * 2. Timestamp is within MAX_MESSAGE_AGE_MS
 * 3. Nonce has not been seen before
 * 4. Sender has required scope for the message type
 * 5. Sender's identity has not expired
 */
export async function verifyMessage(signed: SignedMessage): Promise<VerificationResult> {
  const checks = {
    signature_valid: false,
    timestamp_fresh: false,
    nonce_unique: false,
    scope_sufficient: false,
    identity_current: false,
  };

  // 1. Verify Ed25519 signature
  const payload: UnsignedMessage = {
    type: signed.type,
    sender_agent_id: signed.sender_agent_id,
    recipient_agent_id: signed.recipient_agent_id,
    content: signed.content,
    summary: signed.summary,
    timestamp: signed.timestamp,
    nonce: signed.nonce,
  };
  const canonical = canonicalPayload(payload);
  checks.signature_valid = await verifySignature(canonical, signed.signature, signed.public_key);

  // 2. Timestamp freshness
  const messageTime = new Date(signed.timestamp).getTime();
  const now = Date.now();
  checks.timestamp_fresh = (now - messageTime) < MAX_MESSAGE_AGE_MS;

  // 3. Nonce uniqueness
  checks.nonce_unique = !isNonceSeen(signed.nonce);
  if (checks.nonce_unique) {
    recordNonce(signed.nonce);
  }

  // 4 & 5. Scope + identity currency
  const identity = getIdentity(signed.sender_agent_id);
  if (identity) {
    const requiredScope = getScopeForMessageType(signed.type);
    checks.scope_sufficient = identity.scopes.includes(requiredScope);
    checks.identity_current = new Date(identity.expires_at) > new Date();
  }

  // Fail-closed: ALL checks must pass
  const authorized = Object.values(checks).every(v => v === true);

  return { authorized, checks };
}

// ---------------------------------------------------------------------------
// Nonce cleanup
// ---------------------------------------------------------------------------

/** Remove nonces older than the given age (in ms). */
export function cleanupNonces(maxAgeMs: number = MAX_MESSAGE_AGE_MS * 2): void {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const db = getDb();
  db.prepare('DELETE FROM seen_nonces WHERE seen_at < ?').run(cutoff);
}
