/**
 * Host-side IPC handlers for agent identity operations.
 *
 * These handlers process identity-related IPC requests from containers,
 * which don't have direct access to the SQLite database or host key.
 * All crypto and DB operations happen here on the host.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

import { createIdentity, getIdentity, getIdentityByName, listIdentities, loadSecretKey } from './identity-store.js';
import { signMessage, verifyMessage, generateNonce } from './message-signing.js';
import { createEvidence, verifyChain, getChain } from './evidence-chain.js';
import { computeTrustScore, getCachedTrustScore } from './trust-scoring.js';
import { getDefaultScopes } from './types.js';
import type { ActionType, EvidenceOutcome, SignedMessageType, UnsignedMessage } from './types.js';

// ---------------------------------------------------------------------------
// IPC response utility (inlined to avoid circular dependency with ipc.ts)
// ---------------------------------------------------------------------------

function writeIpcResponse(responseFile: string, data: object): void {
  const tmp = `${responseFile}.tmp`;
  fs.mkdirSync(path.dirname(responseFile), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, responseFile);
}

// ---------------------------------------------------------------------------
// Enforcement mode
// ---------------------------------------------------------------------------

type EnforcementMode = 'warn' | 'strict';

function getEnforcementMode(): EnforcementMode {
  const mode = process.env.NANOCLAW_IDENTITY_ENFORCEMENT || 'warn';
  return mode === 'strict' ? 'strict' : 'warn';
}

// ---------------------------------------------------------------------------
// Message signing (called by host when processing outgoing IPC messages)
// ---------------------------------------------------------------------------

/**
 * Sign an outgoing IPC message on behalf of an agent.
 * Called by the host IPC handler when it receives a `type: 'message'`
 * with an `agent_id` field.
 *
 * Returns the signature metadata to attach to the message, or null
 * if the agent has no identity (migration mode: unsigned messages allowed).
 */
export async function signOutgoingMessage(
  agentId: string,
  text: string,
  targetJid: string,
): Promise<{ signature: string; public_key: string; nonce: string; timestamp: string } | null> {
  const identity = getIdentity(agentId);
  if (!identity) {
    logger.warn({ agentId }, 'Identity: no identity found for agent, sending unsigned');
    return null;
  }

  const secretKey = loadSecretKey(agentId);
  if (!secretKey) {
    logger.warn({ agentId }, 'Identity: cannot load secret key, sending unsigned');
    return null;
  }

  const unsigned: UnsignedMessage = {
    type: 'message' as SignedMessageType,
    sender_agent_id: agentId,
    recipient_agent_id: targetJid,
    content: text,
    summary: text.slice(0, 100),
    timestamp: new Date().toISOString(),
    nonce: generateNonce(),
  };

  const signed = await signMessage(unsigned, secretKey, new Uint8Array(Buffer.from(identity.public_key, 'base64')));

  // Record evidence of message sent
  try {
    await createEvidence(
      agentId,
      'message_sent',
      { target: targetJid, content_preview: text.slice(0, 200) },
      `Send message to ${targetJid}`,
      { success: true },
    );
  } catch (err) {
    logger.error({ err, agentId }, 'Identity: failed to record message_sent evidence');
  }

  return {
    signature: signed.signature,
    public_key: signed.public_key,
    nonce: signed.nonce,
    timestamp: signed.timestamp,
  };
}

/**
 * Verify an incoming signed message.
 * Called when a cross-agent message arrives with signature metadata.
 */
export async function verifyIncomingMessage(
  agentId: string,
  text: string,
  targetJid: string,
  signatureData: { signature: string; public_key: string; nonce: string; timestamp: string },
): Promise<{ verified: boolean; reason?: string }> {
  const signed = {
    type: 'message' as SignedMessageType,
    sender_agent_id: agentId,
    recipient_agent_id: targetJid,
    content: text,
    summary: text.slice(0, 100),
    timestamp: signatureData.timestamp,
    nonce: signatureData.nonce,
    signature: signatureData.signature,
    public_key: signatureData.public_key,
  };

  const result = await verifyMessage(signed);

  if (!result.authorized) {
    const failedChecks = Object.entries(result.checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const reason = `Verification failed: ${failedChecks.join(', ')}`;

    // Record evidence of failed verification
    try {
      await createEvidence(
        agentId,
        'unsigned_message_received',
        { target: targetJid, failed_checks: failedChecks },
        `Failed verification from ${agentId}`,
        { success: false, error: reason },
      );
    } catch (err) {
      logger.error({ err, agentId }, 'Identity: failed to record verification failure evidence');
    }

    const mode = getEnforcementMode();
    if (mode === 'strict') {
      return { verified: false, reason };
    }
    // warn mode: log but allow
    logger.warn({ agentId, failedChecks }, 'Identity: message verification failed (warn mode, allowing)');
  }

  return { verified: true };
}

/**
 * Record an unsigned message in the evidence chain.
 * Used during migration when messages arrive without identity metadata.
 */
export async function recordUnsignedMessage(
  sourceGroup: string,
  text: string,
  targetJid: string,
): Promise<void> {
  // Try to find identity for this group's agent
  const identity = getIdentityByName(`agent-${sourceGroup}`);
  if (!identity) return; // No identity to record against

  try {
    await createEvidence(
      identity.agent_id,
      'unsigned_message_received',
      { source_group: sourceGroup, target: targetJid, content_preview: text.slice(0, 200) },
      `Unsigned message from ${sourceGroup}`,
      { success: true, result: 'accepted_unsigned' },
    );
  } catch (err) {
    logger.error({ err, sourceGroup }, 'Identity: failed to record unsigned message evidence');
  }
}

// ---------------------------------------------------------------------------
// IPC request handlers (container → host)
// ---------------------------------------------------------------------------

/**
 * Process identity-related IPC requests from containers.
 * Routes to the appropriate handler based on `data.type`.
 */
export async function processIdentityIpc(
  data: Record<string, unknown>,
  groupFolder: string,
  responseFile?: string,
): Promise<void> {
  switch (data.type) {
    case 'identity_create': {
      try {
        const agentName = data.agent_name as string;
        const agentType = data.agent_type as string;
        const scopes = data.scopes as string[] | undefined;
        const issuer = data.issuer as string | undefined;

        const typedScopes = scopes ? scopes as import('./types.js').AgentScope[] : undefined;
        const result = await createIdentity(agentName, agentType, typedScopes, issuer);

        if (responseFile) {
          writeIpcResponse(responseFile, {
            agent_id: result.identity.agent_id,
            agent_name: result.identity.agent_name,
            agent_type: result.identity.agent_type,
            public_key: result.identity.public_key,
            scopes: result.identity.scopes,
            issued_at: result.identity.issued_at,
            expires_at: result.identity.expires_at,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder }, 'Identity: create failed');
      }
      break;
    }

    case 'identity_verify_agent': {
      try {
        const agentId = data.agent_id as string;
        const identity = getIdentity(agentId);
        if (!identity) {
          if (responseFile) writeIpcResponse(responseFile, { error: 'Agent not found' });
          break;
        }

        const trustScore = await computeTrustScore(agentId);
        const chainResult = await verifyChain(agentId);

        if (responseFile) {
          writeIpcResponse(responseFile, {
            identity: {
              agent_id: identity.agent_id,
              agent_name: identity.agent_name,
              agent_type: identity.agent_type,
              scopes: identity.scopes,
              issued_at: identity.issued_at,
              expires_at: identity.expires_at,
              issuer: identity.issuer,
            },
            trust: trustScore,
            chain: chainResult,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder }, 'Identity: verify_agent failed');
      }
      break;
    }

    case 'identity_audit_evidence': {
      try {
        const agentId = data.agent_id as string;
        const chainResult = await verifyChain(agentId);
        const chain = getChain(agentId);

        if (responseFile) {
          writeIpcResponse(responseFile, {
            agent_id: agentId,
            chain_length: chain.length,
            ...chainResult,
            recent_actions: chain.slice(-10).map(r => ({
              action_type: r.action_type,
              intent: r.intent,
              timestamp: r.timestamp,
              outcome_success: r.outcome.success,
            })),
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder }, 'Identity: audit_evidence failed');
      }
      break;
    }

    case 'identity_trust_report': {
      try {
        const identities = listIdentities();
        const report = await Promise.all(
          identities.map(async (id) => {
            const cached = getCachedTrustScore(id.agent_id);
            const trust = cached || await computeTrustScore(id.agent_id);
            return {
              agent_id: id.agent_id,
              agent_name: id.agent_name,
              agent_type: id.agent_type,
              scopes: id.scopes,
              expired: new Date(id.expires_at) <= new Date(),
              trust_score: trust.score,
              trust_level: trust.level,
              factors: trust.factors,
              last_computed: trust.last_computed,
            };
          }),
        );

        if (responseFile) writeIpcResponse(responseFile, { agents: report });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder }, 'Identity: trust_report failed');
      }
      break;
    }

    case 'identity_record_evidence': {
      try {
        const agentId = data.agent_id as string;
        const actionType = data.action_type as ActionType;
        const actionDetails = data.action_details as Record<string, unknown>;
        const intent = data.intent as string;
        const outcome = data.outcome as EvidenceOutcome;
        const delegatedBy = data.delegated_by as string | undefined;

        await createEvidence(agentId, actionType, actionDetails, intent, outcome, delegatedBy);
        if (responseFile) writeIpcResponse(responseFile, { success: true });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (responseFile) writeIpcResponse(responseFile, { error: errMsg });
        logger.error({ err, groupFolder }, 'Identity: record_evidence failed');
      }
      break;
    }

    default:
      logger.warn({ type: data.type, groupFolder }, 'Identity: unknown IPC type');
      if (responseFile) writeIpcResponse(responseFile, { error: `Unknown identity IPC type: ${data.type}` });
  }
}

// ---------------------------------------------------------------------------
// Safety brief integration
// ---------------------------------------------------------------------------

/**
 * Generate identity-related findings for the daily safety brief.
 * Called by the agent monitoring system.
 */
export async function getIdentitySafetyFindings(): Promise<string[]> {
  const findings: string[] = [];
  const identities = listIdentities();

  if (identities.length === 0) {
    findings.push('No agent identities registered.');
    return findings;
  }

  // Check all chains
  let brokenChains = 0;
  for (const id of identities) {
    const chainResult = await verifyChain(id.agent_id);
    if (!chainResult.valid) {
      brokenChains++;
      findings.push(`BROKEN CHAIN: Agent "${id.agent_name}" (${id.agent_id}) — ${chainResult.reason} at record ${chainResult.broken_at}`);
    }
  }
  if (brokenChains === 0) {
    findings.push(`All ${identities.length} agent evidence chains verified intact.`);
  }

  // Trust score drops
  for (const id of identities) {
    const trust = getCachedTrustScore(id.agent_id);
    if (trust && trust.score < 0.5) {
      findings.push(`LOW TRUST: Agent "${id.agent_name}" — score ${trust.score} (${trust.level})`);
    }
  }

  // Expired credentials
  const now = new Date();
  const expired = identities.filter(id => new Date(id.expires_at) <= now);
  if (expired.length > 0) {
    findings.push(`EXPIRED: ${expired.length} agent credentials expired: ${expired.map(e => e.agent_name).join(', ')}`);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Agent spawning identity creation
// ---------------------------------------------------------------------------

/**
 * Create or retrieve an identity for an agent being spawned.
 * Called by container-runner.ts before spawning a container.
 */
export async function ensureAgentIdentity(
  groupFolder: string,
  designation: string,
  parentAgentId?: string,
): Promise<string> {
  const agentName = `agent-${groupFolder}-${designation}`;

  // Check if this agent already has an identity
  const existing = getIdentityByName(agentName);
  if (existing && new Date(existing.expires_at) > new Date()) {
    return existing.agent_id;
  }

  // Create a new identity
  const agentType = designation === 'task' ? 'general-purpose' : 'general-purpose';
  const scopes = getDefaultScopes(agentType);
  const issuer = parentAgentId || 'nanoclaw-root';

  const { identity } = await createIdentity(agentName, agentType, scopes, issuer);

  // Record spawn evidence
  if (parentAgentId) {
    try {
      await createEvidence(
        parentAgentId,
        'agent_spawned',
        { spawned_agent_id: identity.agent_id, spawned_name: agentName, scopes },
        `Spawn agent ${agentName} for ${designation}`,
        { success: true, result: identity.agent_id },
      );
    } catch (err) {
      logger.error({ err, parentAgentId }, 'Identity: failed to record spawn evidence');
    }
  }

  logger.info(
    { agentId: identity.agent_id, agentName, groupFolder, designation },
    'Identity: created agent identity for container',
  );

  return identity.agent_id;
}
