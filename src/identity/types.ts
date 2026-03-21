/**
 * Agent Identity & Trust Layer — Type definitions.
 *
 * Follows the RFC: cryptographic agent identity with Ed25519 signing,
 * tamper-evident evidence chains, and outcome-based trust scoring.
 */

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export type AgentScope =
  // Task management
  | 'task.create'
  | 'task.update'
  | 'task.read'
  | 'task.delete'
  // Messaging
  | 'message.send'
  | 'message.broadcast'
  // Agent spawning
  | 'agent.spawn'
  | 'agent.shutdown'
  // File operations
  | 'file.read'
  | 'file.write'
  | 'file.delete'
  // Destructive operations
  | 'destructive.execute'
  // Financial
  | 'bounty.submit'
  | 'payment.request';

// ---------------------------------------------------------------------------
// Agent Identity
// ---------------------------------------------------------------------------

export interface AgentIdentity {
  agent_id: string;
  agent_name: string;
  agent_type: string;
  public_key: string;           // Ed25519 public key (base64)
  issued_at: string;            // ISO timestamp
  expires_at: string;           // ISO timestamp
  scopes: AgentScope[];
  issuer: string;               // "nanoclaw-root" or parent agent_id
}

/** Internal representation that includes the encrypted private key. */
export interface StoredIdentity extends AgentIdentity {
  private_key_encrypted: string; // AES-256-GCM encrypted private key (base64)
}

// ---------------------------------------------------------------------------
// Signed Messages
// ---------------------------------------------------------------------------

export type SignedMessageType =
  | 'message'
  | 'broadcast'
  | 'shutdown_request'
  | 'task_delegation';

export interface UnsignedMessage {
  type: SignedMessageType;
  sender_agent_id: string;
  recipient_agent_id?: string;
  content: string;
  summary: string;
  timestamp: string;            // ISO timestamp
  nonce: string;                // Random 32-byte hex (replay protection)
}

export interface SignedMessage extends UnsignedMessage {
  signature: string;            // Ed25519 signature (base64)
  public_key: string;           // Sender's public key (base64)
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationChecks {
  signature_valid: boolean;
  timestamp_fresh: boolean;
  nonce_unique: boolean;
  scope_sufficient: boolean;
  identity_current: boolean;
}

export interface VerificationResult {
  authorized: boolean;
  checks: VerificationChecks;
}

// ---------------------------------------------------------------------------
// Evidence Chain
// ---------------------------------------------------------------------------

export type ActionType =
  | 'task_created'
  | 'message_sent'
  | 'file_modified'
  | 'bounty_submitted'
  | 'destructive_op'
  | 'agent_spawned'
  | 'agent_shutdown'
  | 'unsigned_message_received';

export interface EvidenceAuthorization {
  scope_required: string;
  scope_verified: boolean;
  authorized_by?: string;
}

export interface EvidenceOutcome {
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface EvidenceRecord {
  record_id: string;
  agent_id: string;
  agent_name: string;
  action_type: ActionType;
  action_details: Record<string, unknown>;
  intent: string;
  authorization: EvidenceAuthorization;
  outcome: EvidenceOutcome;
  timestamp: string;            // ISO timestamp
  prev_record_hash: string;     // SHA-256 of previous record ("0"×64 for genesis)
  record_hash: string;          // SHA-256 of this record
  signature: string;            // Ed25519 signature of this record
}

// ---------------------------------------------------------------------------
// Trust Scoring
// ---------------------------------------------------------------------------

export type TrustLevel = 'NONE' | 'LOW' | 'MODERATE' | 'HIGH';

export interface TrustFactors {
  chain_integrity: number;      // -0.5 if chain broken
  outcome_reliability: number;  // -0.4 * failure_rate
  credential_freshness: number; // -0.1 if > 90 days old
  delegation_depth: number;     // -0.05 per hop beyond 2
}

export interface AgentTrustScore {
  agent_id: string;
  score: number;                // 0.0 to 1.0
  level: TrustLevel;
  factors: TrustFactors;
  last_computed: string;        // ISO timestamp
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export interface AuthorizationResult {
  authorized: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Scope mapping helpers
// ---------------------------------------------------------------------------

const MESSAGE_TYPE_SCOPE_MAP: Record<SignedMessageType, AgentScope> = {
  message: 'message.send',
  broadcast: 'message.broadcast',
  shutdown_request: 'agent.shutdown',
  task_delegation: 'task.create',
};

const ACTION_SCOPE_MAP: Record<string, AgentScope> = {
  task_created: 'task.create',
  message_sent: 'message.send',
  file_modified: 'file.write',
  bounty_submitted: 'bounty.submit',
  destructive_op: 'destructive.execute',
  agent_spawned: 'agent.spawn',
  agent_shutdown: 'agent.shutdown',
  unsigned_message_received: 'message.send',
};

export function getScopeForMessageType(type: SignedMessageType): AgentScope {
  return MESSAGE_TYPE_SCOPE_MAP[type];
}

export function getScopeForAction(action: string): AgentScope {
  return ACTION_SCOPE_MAP[action] ?? 'task.read';
}

/** Default scopes assigned to an agent based on its type. */
export function getDefaultScopes(agentType: string): AgentScope[] {
  switch (agentType) {
    case 'Explore':
      return ['file.read', 'task.read'];
    case 'general-purpose':
      return ['task.create', 'task.update', 'task.read', 'message.send', 'agent.spawn', 'file.read', 'file.write'];
    case 'Plan':
      return ['task.create', 'task.update', 'task.read', 'file.read'];
    default:
      return ['task.read', 'message.send', 'file.read'];
  }
}
