import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';

import { _initTestDatabase } from '../../db.js';
import { _setHostKey } from '../keypair.js';

// Modules under test
import {
  generateKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
  signData,
  verifySignature,
  publicKeyToBase64,
} from '../keypair.js';
import {
  createIdentity,
  getIdentity,
  getIdentityByName,
  listIdentities,
  loadSecretKey,
  expireIdentity,
  hasIdentity,
  getDelegationHops,
} from '../identity-store.js';
import {
  signMessage,
  verifyMessage,
  generateNonce,
  canonicalPayload,
} from '../message-signing.js';
import {
  createEvidence,
  verifyChain,
  getChain,
  getOutcomes,
} from '../evidence-chain.js';
import {
  computeTrustScore,
  getTrustLevel,
  authorizeAction,
} from '../trust-scoring.js';
import type { UnsignedMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_HOST_KEY = crypto.randomBytes(32);

beforeEach(() => {
  _initTestDatabase();
  _setHostKey(TEST_HOST_KEY);
});

// ---------------------------------------------------------------------------
// Keypair tests
// ---------------------------------------------------------------------------

describe('keypair', () => {
  it('generates valid Ed25519 keypair', async () => {
    const { publicKey, secretKey } = await generateKeypair();
    expect(publicKey).toBeInstanceOf(Uint8Array);
    expect(secretKey).toBeInstanceOf(Uint8Array);
    expect(publicKey.length).toBe(32);
    expect(secretKey.length).toBe(32);
  });

  it('encrypts and decrypts private key round-trip', async () => {
    const { secretKey } = await generateKeypair();
    const encrypted = encryptPrivateKey(secretKey);
    expect(typeof encrypted).toBe('string');
    expect(encrypted).not.toBe('');

    const decrypted = decryptPrivateKey(encrypted);
    expect(decrypted).toEqual(secretKey);
  });

  it('signs and verifies data', async () => {
    const { publicKey, secretKey } = await generateKeypair();
    const data = 'hello world';
    const signature = await signData(data, secretKey);
    expect(typeof signature).toBe('string');

    const valid = await verifySignature(data, signature, publicKeyToBase64(publicKey));
    expect(valid).toBe(true);
  });

  it('rejects tampered data', async () => {
    const { publicKey, secretKey } = await generateKeypair();
    const signature = await signData('original', secretKey);
    const valid = await verifySignature('tampered', signature, publicKeyToBase64(publicKey));
    expect(valid).toBe(false);
  });

  it('rejects wrong public key', async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const signature = await signData('hello', kp1.secretKey);
    const valid = await verifySignature('hello', signature, publicKeyToBase64(kp2.publicKey));
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identity store tests
// ---------------------------------------------------------------------------

describe('identity-store', () => {
  it('creates and retrieves identity', async () => {
    const { identity } = await createIdentity('team-lead', 'general-purpose');
    expect(identity.agent_id).toMatch(/^agent-/);
    expect(identity.agent_name).toBe('team-lead');
    expect(identity.agent_type).toBe('general-purpose');
    expect(identity.public_key).toBeTruthy();
    expect(identity.scopes.length).toBeGreaterThan(0);
    expect(identity.issuer).toBe('nanoclaw-root');

    const retrieved = getIdentity(identity.agent_id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.agent_id).toBe(identity.agent_id);
  });

  it('retrieves by name', async () => {
    await createIdentity('researcher', 'Explore');
    const found = getIdentityByName('researcher');
    expect(found).not.toBeNull();
    expect(found!.agent_name).toBe('researcher');
  });

  it('lists all identities', async () => {
    await createIdentity('a', 'general-purpose');
    await createIdentity('b', 'Explore');
    const all = listIdentities();
    expect(all.length).toBe(2);
  });

  it('loads secret key', async () => {
    const { identity, secretKey } = await createIdentity('loader', 'general-purpose');
    const loaded = loadSecretKey(identity.agent_id);
    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(secretKey);
  });

  it('expires identity', async () => {
    const { identity } = await createIdentity('expiring', 'general-purpose');
    const result = expireIdentity(identity.agent_id);
    expect(result).toBe(true);
    const updated = getIdentity(identity.agent_id);
    expect(new Date(updated!.expires_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('checks identity existence', async () => {
    const { identity } = await createIdentity('checker', 'general-purpose');
    expect(hasIdentity(identity.agent_id)).toBe(true);
    expect(hasIdentity('nonexistent')).toBe(false);
  });

  it('assigns default scopes by agent type', async () => {
    const { identity: explore } = await createIdentity('e', 'Explore');
    expect(explore.scopes).toContain('file.read');
    expect(explore.scopes).not.toContain('file.write');

    const { identity: gp } = await createIdentity('g', 'general-purpose');
    expect(gp.scopes).toContain('agent.spawn');
    expect(gp.scopes).toContain('file.write');
  });

  it('accepts custom scopes', async () => {
    const { identity } = await createIdentity('custom', 'general-purpose', ['task.read']);
    expect(identity.scopes).toEqual(['task.read']);
  });

  it('computes delegation hops', async () => {
    // Root-issued agent
    const { identity: root } = await createIdentity('root', 'general-purpose');
    expect(getDelegationHops(root.agent_id)).toBe(0);

    // Child issued by root
    const { identity: child } = await createIdentity('child', 'general-purpose', undefined, root.agent_id);
    expect(getDelegationHops(child.agent_id)).toBe(1);

    // Grandchild
    const { identity: grandchild } = await createIdentity('grandchild', 'general-purpose', undefined, child.agent_id);
    expect(getDelegationHops(grandchild.agent_id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Message signing tests
// ---------------------------------------------------------------------------

describe('message-signing', () => {
  async function createTestAgent() {
    const { identity, secretKey } = await createIdentity('signer', 'general-purpose');
    const kp = await generateKeypair();
    // We need the public key bytes — re-derive from secret key
    return { identity, secretKey, publicKey: Buffer.from(identity.public_key, 'base64') };
  }

  it('signs and verifies a message', async () => {
    const { identity, secretKey, publicKey } = await createTestAgent();

    const msg: UnsignedMessage = {
      type: 'message',
      sender_agent_id: identity.agent_id,
      content: 'test content',
      summary: 'test summary',
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };

    const signed = await signMessage(msg, secretKey, publicKey);
    expect(signed.signature).toBeTruthy();
    expect(signed.public_key).toBe(identity.public_key);

    const result = await verifyMessage(signed);
    expect(result.authorized).toBe(true);
    expect(result.checks.signature_valid).toBe(true);
    expect(result.checks.timestamp_fresh).toBe(true);
    expect(result.checks.nonce_unique).toBe(true);
    expect(result.checks.scope_sufficient).toBe(true);
    expect(result.checks.identity_current).toBe(true);
  });

  it('rejects tampered message content', async () => {
    const { identity, secretKey, publicKey } = await createTestAgent();

    const msg: UnsignedMessage = {
      type: 'message',
      sender_agent_id: identity.agent_id,
      content: 'original',
      summary: 'test',
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };

    const signed = await signMessage(msg, secretKey, publicKey);
    // Tamper
    signed.content = 'tampered';

    const result = await verifyMessage(signed);
    expect(result.authorized).toBe(false);
    expect(result.checks.signature_valid).toBe(false);
  });

  it('rejects expired timestamp', async () => {
    const { identity, secretKey, publicKey } = await createTestAgent();

    const msg: UnsignedMessage = {
      type: 'message',
      sender_agent_id: identity.agent_id,
      content: 'test',
      summary: 'test',
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      nonce: generateNonce(),
    };

    const signed = await signMessage(msg, secretKey, publicKey);
    const result = await verifyMessage(signed);
    expect(result.authorized).toBe(false);
    expect(result.checks.timestamp_fresh).toBe(false);
  });

  it('rejects replayed nonce', async () => {
    const { identity, secretKey, publicKey } = await createTestAgent();
    const nonce = generateNonce();

    const msg1: UnsignedMessage = {
      type: 'message',
      sender_agent_id: identity.agent_id,
      content: 'test',
      summary: 'test',
      timestamp: new Date().toISOString(),
      nonce,
    };

    const signed1 = await signMessage(msg1, secretKey, publicKey);
    const result1 = await verifyMessage(signed1);
    expect(result1.authorized).toBe(true);

    // Replay with same nonce
    const msg2: UnsignedMessage = {
      ...msg1,
      timestamp: new Date().toISOString(), // fresh timestamp
    };
    const signed2 = await signMessage(msg2, secretKey, publicKey);
    const result2 = await verifyMessage(signed2);
    expect(result2.authorized).toBe(false);
    expect(result2.checks.nonce_unique).toBe(false);
  });

  it('rejects forged sender identity', async () => {
    const { identity: agentA, secretKey: keyA, publicKey: pkA } = await createTestAgent();
    const { identity: agentB } = await createIdentity('impersonator', 'general-purpose');

    // agentB signs but claims to be agentA
    const msg: UnsignedMessage = {
      type: 'message',
      sender_agent_id: agentA.agent_id, // Claims to be agentA
      content: 'forged',
      summary: 'forged',
      timestamp: new Date().toISOString(),
      nonce: generateNonce(),
    };

    // Sign with agentB's key, but attach agentA's public key
    // The signature won't match because the keys are different
    const { secretKey: keyB } = await createIdentity('malicious', 'general-purpose');
    const signed = await signMessage(msg, keyB, pkA);

    const result = await verifyMessage(signed);
    expect(result.authorized).toBe(false);
    expect(result.checks.signature_valid).toBe(false);
  });

  it('canonical payload has sorted keys', () => {
    const msg: UnsignedMessage = {
      type: 'message',
      sender_agent_id: 'agent-1',
      content: 'hello',
      summary: 'greet',
      timestamp: '2026-01-01T00:00:00.000Z',
      nonce: 'abc123',
    };

    const canonical = canonicalPayload(msg);
    const parsed = JSON.parse(canonical);
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// Evidence chain tests
// ---------------------------------------------------------------------------

describe('evidence-chain', () => {
  async function makeAgent() {
    const { identity } = await createIdentity('evidence-agent', 'general-purpose');
    return identity;
  }

  it('creates evidence record with genesis hash', async () => {
    const agent = await makeAgent();
    const record = await createEvidence(
      agent.agent_id,
      'task_created',
      { task_id: 't1' },
      'Create a task',
      { success: true },
    );

    expect(record.record_id).toBeTruthy();
    expect(record.agent_id).toBe(agent.agent_id);
    expect(record.prev_record_hash).toBe('0'.repeat(64));
    expect(record.record_hash).toHaveLength(64);
    expect(record.signature).toBeTruthy();
  });

  it('chains records with hash linking', async () => {
    const agent = await makeAgent();
    const r1 = await createEvidence(agent.agent_id, 'task_created', { id: '1' }, 'intent1', { success: true });
    const r2 = await createEvidence(agent.agent_id, 'message_sent', { id: '2' }, 'intent2', { success: true });

    expect(r2.prev_record_hash).toBe(r1.record_hash);
  });

  it('verifies intact chain', async () => {
    const agent = await makeAgent();
    await createEvidence(agent.agent_id, 'task_created', { id: '1' }, 'intent1', { success: true });
    await createEvidence(agent.agent_id, 'message_sent', { id: '2' }, 'intent2', { success: true });
    await createEvidence(agent.agent_id, 'file_modified', { id: '3' }, 'intent3', { success: true });

    const result = await verifyChain(agent.agent_id);
    expect(result.valid).toBe(true);
    expect(result.broken_at).toBeUndefined();
  });

  it('detects hash tampering', async () => {
    const agent = await makeAgent();
    await createEvidence(agent.agent_id, 'task_created', { id: '1' }, 'intent1', { success: true });
    await createEvidence(agent.agent_id, 'message_sent', { id: '2' }, 'intent2', { success: true });

    // Tamper: modify the outcome of the first record directly in DB
    const { getDb } = await import('../../db.js');
    const db = getDb();
    const chain = getChain(agent.agent_id);
    db.prepare('UPDATE evidence_chain SET outcome = ? WHERE record_id = ?')
      .run(JSON.stringify({ success: false }), chain[0].record_id);

    const result = await verifyChain(agent.agent_id);
    expect(result.valid).toBe(false);
    expect(result.broken_at).toBe(0);
    expect(result.reason).toBe('hash_mismatch');
  });

  it('retrieves chain in order', async () => {
    const agent = await makeAgent();
    await createEvidence(agent.agent_id, 'task_created', { step: 1 }, 'first', { success: true });
    await createEvidence(agent.agent_id, 'task_created', { step: 2 }, 'second', { success: true });
    await createEvidence(agent.agent_id, 'task_created', { step: 3 }, 'third', { success: true });

    const chain = getChain(agent.agent_id);
    expect(chain.length).toBe(3);
    expect(chain[0].intent).toBe('first');
    expect(chain[2].intent).toBe('third');
  });

  it('tracks outcome counts', async () => {
    const agent = await makeAgent();
    await createEvidence(agent.agent_id, 'task_created', {}, 'ok', { success: true });
    await createEvidence(agent.agent_id, 'task_created', {}, 'ok', { success: true });
    await createEvidence(agent.agent_id, 'task_created', {}, 'fail', { success: false, error: 'oops' });

    const outcomes = getOutcomes(agent.agent_id);
    expect(outcomes.total).toBe(3);
    expect(outcomes.succeeded).toBe(2);
  });

  it('empty chain is valid', async () => {
    const agent = await makeAgent();
    const result = await verifyChain(agent.agent_id);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Trust scoring tests
// ---------------------------------------------------------------------------

describe('trust-scoring', () => {
  it('computes high trust for reliable agent', async () => {
    const { identity } = await createIdentity('reliable', 'general-purpose');

    // 10 successful actions
    for (let i = 0; i < 10; i++) {
      await createEvidence(identity.agent_id, 'task_created', { i }, 'work', { success: true });
    }

    const score = await computeTrustScore(identity.agent_id);
    expect(score.score).toBe(1.0);
    expect(score.level).toBe('HIGH');
    expect(score.factors.chain_integrity).toBe(0);
    expect(score.factors.outcome_reliability).toBe(0);
  });

  it('penalizes outcome failures', async () => {
    const { identity } = await createIdentity('mixed', 'general-purpose');

    // 10 successes, 2 failures → failure rate = 2/12
    for (let i = 0; i < 10; i++) {
      await createEvidence(identity.agent_id, 'task_created', { i }, 'ok', { success: true });
    }
    for (let i = 0; i < 2; i++) {
      await createEvidence(identity.agent_id, 'task_created', { i: i + 10 }, 'fail', { success: false, error: 'err' });
    }

    const score = await computeTrustScore(identity.agent_id);
    // 1.0 - (2/12 * 0.4) ≈ 0.9333
    expect(score.score).toBeCloseTo(0.9333, 2);
    expect(score.level).toBe('HIGH');
  });

  it('returns NONE for unknown agent', async () => {
    const score = await computeTrustScore('nonexistent');
    expect(score.score).toBe(0);
    expect(score.level).toBe('NONE');
  });

  it('getTrustLevel maps correctly', () => {
    expect(getTrustLevel(1.0)).toBe('HIGH');
    expect(getTrustLevel(0.9)).toBe('HIGH');
    expect(getTrustLevel(0.89)).toBe('MODERATE');
    expect(getTrustLevel(0.5)).toBe('MODERATE');
    expect(getTrustLevel(0.49)).toBe('LOW');
    expect(getTrustLevel(0.01)).toBe('LOW');
    expect(getTrustLevel(0.0)).toBe('NONE');
  });

  it('authorizes standard action for trusted agent', async () => {
    const { identity } = await createIdentity('trusted', 'general-purpose');
    await createEvidence(identity.agent_id, 'task_created', {}, 'work', { success: true });

    const result = await authorizeAction(identity.agent_id, 'task_created');
    expect(result.authorized).toBe(true);
  });

  it('rejects unknown agent', async () => {
    const result = await authorizeAction('nonexistent', 'task_created');
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('unknown_agent');
  });

  it('rejects insufficient scope', async () => {
    const { identity } = await createIdentity('limited', 'Explore'); // Only file.read, task.read
    await createEvidence(identity.agent_id, 'task_created', {}, 'work', { success: true });

    const result = await authorizeAction(identity.agent_id, 'destructive_op');
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('insufficient_scope');
  });

  it('rejects expired credentials', async () => {
    const { identity } = await createIdentity('expired', 'general-purpose');
    expireIdentity(identity.agent_id);

    const result = await authorizeAction(identity.agent_id, 'task_created');
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('credential_expired');
  });

  it('requires higher trust for destructive operations', async () => {
    const { identity } = await createIdentity('risky', 'general-purpose', [
      'task.create', 'task.read', 'destructive.execute',
    ]);

    // Create a mix: 8 success, 2 failures → score = 1.0 - (2/10 * 0.4) = 0.92
    for (let i = 0; i < 8; i++) {
      await createEvidence(identity.agent_id, 'task_created', { i }, 'work', { success: true });
    }
    for (let i = 0; i < 2; i++) {
      await createEvidence(identity.agent_id, 'task_created', { i: i + 8 }, 'fail', { success: false, error: 'err' });
    }

    // Standard action (threshold 0.5) should pass
    const standard = await authorizeAction(identity.agent_id, 'task_created');
    expect(standard.authorized).toBe(true);

    // Destructive action (threshold 0.9) — score ≈ 0.92, should also pass
    const destructive = await authorizeAction(identity.agent_id, 'destructive_op');
    expect(destructive.authorized).toBe(true);

    // Now add more failures to drop below 0.9
    for (let i = 0; i < 3; i++) {
      await createEvidence(identity.agent_id, 'task_created', { i: i + 10 }, 'fail', { success: false, error: 'err' });
    }
    // 8 success, 5 failures → score = 1.0 - (5/13 * 0.4) ≈ 0.846
    const destructive2 = await authorizeAction(identity.agent_id, 'destructive_op');
    expect(destructive2.authorized).toBe(false);
    expect(destructive2.reason).toContain('trust_too_low');
  });
});
