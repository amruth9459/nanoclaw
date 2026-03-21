/**
 * Agent Identity & Trust Layer — public API.
 */
export type {
  AgentIdentity,
  StoredIdentity,
  AgentScope,
  SignedMessage,
  UnsignedMessage,
  SignedMessageType,
  VerificationResult,
  VerificationChecks,
  EvidenceRecord,
  EvidenceAuthorization,
  EvidenceOutcome,
  ActionType,
  AgentTrustScore,
  TrustLevel,
  TrustFactors,
  AuthorizationResult,
} from './types.js';

export {
  getScopeForMessageType,
  getScopeForAction,
  getDefaultScopes,
} from './types.js';

export {
  generateKeypair,
  encryptPrivateKey,
  decryptPrivateKey,
  signData,
  verifySignature,
  publicKeyToBase64,
} from './keypair.js';

export {
  createIdentity,
  getIdentity,
  getIdentityByName,
  listIdentities,
  loadSecretKey,
  expireIdentity,
  hasIdentity,
  getDelegationHops,
} from './identity-store.js';

export {
  signMessage,
  verifyMessage,
  generateNonce,
  cleanupNonces,
  canonicalPayload,
} from './message-signing.js';

export {
  createEvidence,
  verifyChain,
  getChain,
  getOutcomes,
} from './evidence-chain.js';

export {
  computeTrustScore,
  getTrustLevel,
  authorizeAction,
  getCachedTrustScore,
} from './trust-scoring.js';
