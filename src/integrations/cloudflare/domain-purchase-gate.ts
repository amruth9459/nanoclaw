/**
 * DomainPurchaseGate — HITL approval gate for Cloudflare domain registrations.
 *
 * The container's cloudflare_register_domain MCP tool sends an IPC request to
 * the host. The host:
 *   1. Validates the request against price/year caps.
 *   2. Registers a pending proposal here and returns a token.
 *   3. Sends a WhatsApp message to the user with the token.
 *   4. The user replies "approve-domain <token>" or "reject-domain <token>".
 *   5. tryHandleApproval() executes the registration via CloudflareClient.
 *
 * Mirrors the CleanupGate / SandboxGate pattern. 30-minute token expiry.
 * Audit log per decision under data/audit/cloudflare-domains/.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { CloudflareClient, formatCfErrors } from './cloudflare-client.js';
import {
  CLOUDFLARE_API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_MAX_DOMAIN_PRICE_USD,
  CLOUDFLARE_MAX_REGISTRATION_YEARS,
} from './config.js';

const APPROVAL_PATTERN = /\b(approve-domain|reject-domain)\s+([a-f0-9]{8})\b/i;
const EXPIRY_MS = 30 * 60 * 1000;
const AUDIT_DIR = path.join(DATA_DIR, 'audit', 'cloudflare-domains');

export interface DomainProposal {
  domain: string;
  years: number;
  estimatedPriceUsd: number;
  privacy: boolean;
  autoRenew: boolean;
  groupFolder: string;
  chatJid: string;
  /** Called when execution completes (success or failure). Used to satisfy the IPC response. */
  onResult: (result: { success: boolean; message: string; details?: unknown }) => void;
}

interface PendingDomain {
  token: string;
  proposal: DomainProposal;
  expiresAt: Date;
}

export class DomainPurchaseGate {
  private readonly pending = new Map<string, PendingDomain>();
  private readonly clientFactory: () => CloudflareClient | null;

  /**
   * @param clientFactory  Returns a configured CloudflareClient, or null if
   *                       credentials aren't set. Injectable for tests.
   */
  constructor(clientFactory?: () => CloudflareClient | null) {
    this.clientFactory = clientFactory ?? (() => {
      if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID) return null;
      return new CloudflareClient({
        apiToken: CLOUDFLARE_API_TOKEN,
        accountId: CLOUDFLARE_ACCOUNT_ID,
      });
    });
  }

  /**
   * Validate the proposal against safety caps and register a pending approval.
   * Returns the approval token on success.
   * Throws with a human-readable message on validation failure — the host
   * surfaces this back to the agent via the IPC response.
   */
  propose(proposal: DomainProposal): string {
    this.expire();

    if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i.test(proposal.domain)) {
      throw new Error(`Invalid domain name: "${proposal.domain}"`);
    }
    if (proposal.years < 1 || proposal.years > CLOUDFLARE_MAX_REGISTRATION_YEARS) {
      throw new Error(
        `Registration period ${proposal.years}y exceeds cap of ${CLOUDFLARE_MAX_REGISTRATION_YEARS}y. ` +
          `Adjust CLOUDFLARE_MAX_REGISTRATION_YEARS in .env to raise it.`,
      );
    }
    const totalCost = proposal.estimatedPriceUsd * proposal.years;
    if (totalCost > CLOUDFLARE_MAX_DOMAIN_PRICE_USD) {
      throw new Error(
        `Total cost $${totalCost.toFixed(2)} exceeds cap of $${CLOUDFLARE_MAX_DOMAIN_PRICE_USD}. ` +
          `Adjust CLOUDFLARE_MAX_DOMAIN_PRICE_USD in .env to raise it.`,
      );
    }

    // One pending registration per domain — replace any prior proposal.
    for (const [token, p] of this.pending) {
      if (p.proposal.domain === proposal.domain) {
        this.pending.delete(token);
      }
    }

    const token = crypto.randomBytes(4).toString('hex');
    this.pending.set(token, {
      token,
      proposal,
      expiresAt: new Date(Date.now() + EXPIRY_MS),
    });
    logger.info({ token, domain: proposal.domain, totalCost }, 'DomainPurchaseGate: proposal registered');
    return token;
  }

  /** Format the WhatsApp notification for the user. */
  static formatProposalMessage(proposal: DomainProposal, token: string): string {
    const totalCost = (proposal.estimatedPriceUsd * proposal.years).toFixed(2);
    return [
      '🌐 *Domain Registration — Approval Required*',
      '',
      `*Domain:* ${proposal.domain}`,
      `*Period:* ${proposal.years} year${proposal.years > 1 ? 's' : ''}`,
      `*Estimated cost:* $${proposal.estimatedPriceUsd.toFixed(2)}/yr × ${proposal.years} = *$${totalCost} USD*`,
      `*WHOIS privacy:* ${proposal.privacy ? 'enabled' : 'disabled'}`,
      `*Auto-renew:* ${proposal.autoRenew ? 'enabled' : 'disabled'}`,
      '',
      '_Charges your Cloudflare payment method immediately on approval._',
      '',
      `Reply:  *approve-domain ${token}*`,
      `        *reject-domain ${token}*`,
      '_(expires in 30 minutes)_',
    ].join('\n');
  }

  /**
   * Inspect an inbound WhatsApp message; if it matches the approval pattern,
   * execute the registration or reject. Returns true if handled.
   */
  async tryHandleApproval(
    message: string,
    notifyFn: (text: string) => Promise<void>,
  ): Promise<boolean> {
    this.expire();
    const match = message.match(APPROVAL_PATTERN);
    if (!match) return false;

    const [, action, token] = match;
    const pending = this.pending.get(token.toLowerCase());
    if (!pending) {
      await notifyFn('⚠️ No pending domain registration found for that token (expired or already handled).');
      logger.warn({ token }, 'DomainPurchaseGate: no pending approval found');
      return true;
    }
    this.pending.delete(token.toLowerCase());

    if (action.toLowerCase() === 'reject-domain') {
      this.writeAuditLog(pending, 'rejected');
      await notifyFn(`❌ Domain registration rejected: ${pending.proposal.domain}`);
      pending.proposal.onResult({ success: false, message: 'User rejected the registration.' });
      return true;
    }

    // Approve path — execute registration via Cloudflare API.
    await notifyFn(`⏳ Registering ${pending.proposal.domain} via Cloudflare...`);
    const client = this.clientFactory();
    if (!client) {
      const msg = 'Cloudflare API not configured on host (missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID).';
      this.writeAuditLog(pending, 'error', msg);
      await notifyFn(`❌ ${msg}`);
      pending.proposal.onResult({ success: false, message: msg });
      return true;
    }

    try {
      const result = await client.registerDomain({
        domain: pending.proposal.domain,
        years: pending.proposal.years,
        privacy: pending.proposal.privacy,
        autoRenew: pending.proposal.autoRenew,
      });
      if (!result.success) {
        const errMsg = formatCfErrors(result.errors);
        this.writeAuditLog(pending, 'error', errMsg);
        await notifyFn(`❌ Registration failed: ${errMsg}`);
        pending.proposal.onResult({ success: false, message: errMsg, details: result.errors });
        return true;
      }
      this.writeAuditLog(pending, 'approved');
      await notifyFn(`✅ Registered: ${pending.proposal.domain}`);
      pending.proposal.onResult({
        success: true,
        message: `Domain ${pending.proposal.domain} registered for ${pending.proposal.years} year(s).`,
        details: result.result,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.writeAuditLog(pending, 'error', errMsg);
      await notifyFn(`❌ Registration failed: ${errMsg}`);
      pending.proposal.onResult({ success: false, message: errMsg });
    }
    return true;
  }

  /** For tests / introspection. */
  pendingCount(): number {
    this.expire();
    return this.pending.size;
  }

  private writeAuditLog(pending: PendingDomain, decision: string, error?: string): void {
    try {
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        token: pending.token,
        decision,
        domain: pending.proposal.domain,
        years: pending.proposal.years,
        estimatedPriceUsd: pending.proposal.estimatedPriceUsd,
        privacy: pending.proposal.privacy,
        autoRenew: pending.proposal.autoRenew,
        groupFolder: pending.proposal.groupFolder,
        ...(error && { error }),
      };
      const filename = `${Date.now()}-${pending.token}.json`;
      fs.writeFileSync(path.join(AUDIT_DIR, filename), JSON.stringify(entry, null, 2));
    } catch (err) {
      logger.error({ err }, 'DomainPurchaseGate: failed to write audit log');
    }
  }

  private expire(): void {
    const now = Date.now();
    for (const [token, p] of this.pending) {
      if (p.expiresAt.getTime() < now) {
        this.pending.delete(token);
        p.proposal.onResult({
          success: false,
          message: 'Approval token expired before user response.',
        });
        logger.info({ token, domain: p.proposal.domain }, 'DomainPurchaseGate: proposal expired');
      }
    }
  }
}

/** Singleton instance shared by the integration. */
export const domainPurchaseGate = new DomainPurchaseGate();
