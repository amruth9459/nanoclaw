/**
 * Ed25519 key generation and management.
 *
 * Uses @noble/ed25519 for key generation and Node.js crypto for
 * AES-256-GCM encryption of private keys at rest.
 */
import * as ed from '@noble/ed25519';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { STORE_DIR } from '../config.js';

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export interface Keypair {
  publicKey: Uint8Array;   // 32 bytes
  secretKey: Uint8Array;   // 32 bytes (seed)
}

export async function generateKeypair(): Promise<Keypair> {
  const { publicKey, secretKey } = await ed.keygenAsync();
  return { publicKey, secretKey };
}

// ---------------------------------------------------------------------------
// Host key — derived from a persistent secret on the host machine.
// Stored outside the DB so agents in containers cannot access it.
// ---------------------------------------------------------------------------

const HOST_KEY_PATH = path.join(STORE_DIR, '.host-key');

function getOrCreateHostKey(): Buffer {
  if (fs.existsSync(HOST_KEY_PATH)) {
    return fs.readFileSync(HOST_KEY_PATH);
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(HOST_KEY_PATH), { recursive: true });
  fs.writeFileSync(HOST_KEY_PATH, key, { mode: 0o600 });
  return key;
}

/** Lazy-initialized host key. */
let _hostKey: Buffer | null = null;
function hostKey(): Buffer {
  if (!_hostKey) _hostKey = getOrCreateHostKey();
  return _hostKey;
}

// ---------------------------------------------------------------------------
// AES-256-GCM encrypt/decrypt for private key storage
// ---------------------------------------------------------------------------

export function encryptPrivateKey(secretKey: Uint8Array): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', hostKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secretKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv | tag | ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptPrivateKey(encoded: string): Uint8Array {
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', hostKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return new Uint8Array(decrypted);
}

// ---------------------------------------------------------------------------
// Signing & verification (thin wrappers around @noble/ed25519)
// ---------------------------------------------------------------------------

export async function signData(data: string, secretKey: Uint8Array): Promise<string> {
  const sig = await ed.signAsync(new TextEncoder().encode(data), secretKey);
  return Buffer.from(sig).toString('base64');
}

export async function verifySignature(data: string, signature: string, publicKey: string): Promise<boolean> {
  try {
    const sigBytes = Buffer.from(signature, 'base64');
    const pkBytes = Buffer.from(publicKey, 'base64');
    return await ed.verifyAsync(sigBytes, new TextEncoder().encode(data), pkBytes);
  } catch {
    return false;
  }
}

/** Encode a public key to base64. */
export function publicKeyToBase64(pk: Uint8Array): string {
  return Buffer.from(pk).toString('base64');
}

/** Reset cached host key (for testing). */
export function _resetHostKey(): void {
  _hostKey = null;
}

/** Set a fixed host key (for testing — avoids filesystem). */
export function _setHostKey(key: Buffer): void {
  _hostKey = key;
}
