/**
 * BountyGate — HITL approval gate for bounty opportunities.
 *
 * The agent proposes a bounty via IPC; the host stores it in DB and sends a
 * WhatsApp notification. The user replies "approve-bounty <token>" or
 * "reject-bounty <token>" in the main group.
 */

import crypto from 'crypto';

import { Bounty } from './bounty-hunter.js';
import { logger } from './logger.js';

const APPROVAL_PATTERN = /\b(approve-bounty|reject-bounty)\s+([a-f0-9]{8})\b/i;
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

interface PendingBounty {
  token: string;
  bounty: Bounty;
  groupFolder: string;
  expiresAt: Date;
  onApprove: () => void;
  onReject: () => void;
}

export class BountyGate {
  private readonly pending = new Map<string, PendingBounty>();

  /**
   * Register a bounty proposal and return the approval token.
   * Caller is responsible for sending the HITL message to the user.
   */
  proposeBounty(
    bounty: Bounty,
    groupFolder: string,
    onApprove: () => void,
    onReject: () => void,
  ): string {
    this.cleanup();
    const token = crypto.randomBytes(4).toString('hex'); // 8-char hex
    this.pending.set(token, {
      token,
      bounty,
      groupFolder,
      expiresAt: new Date(Date.now() + EXPIRY_MS),
      onApprove,
      onReject,
    });
    logger.info({ token, bountyId: bounty.id, platform: bounty.platform }, 'BountyGate: proposal registered');
    return token;
  }

  /**
   * Format the HITL notification message for the user.
   */
  static formatProposalMessage(bounty: Bounty, token: string): string {
    const reward = bounty.reward_usd != null
      ? `$${bounty.reward_usd} USD`
      : bounty.reward_raw;
    const repoLine = bounty.repo ? `\nRepo: ${bounty.repo}` : '';
    return [
      `💰 *Bounty Opportunity [${bounty.platform}]*`,
      `Title: ${bounty.title}`,
      `Reward: ${reward}${repoLine}`,
      `URL: ${bounty.url}`,
      '',
      `Reply:  approve-bounty ${token}`,
      `        reject-bounty ${token}`,
    ].join('\n');
  }

  /**
   * Check if a message contains an approve/reject-bounty token.
   * Calls onApprove or onReject callbacks as appropriate.
   * Returns true if the message was a bounty approval command.
   */
  async tryHandleApproval(
    message: string,
    onApprove: (token: string, bounty: Bounty) => void,
    onReject: (token: string, bounty: Bounty) => void,
  ): Promise<boolean> {
    this.cleanup();
    const match = message.match(APPROVAL_PATTERN);
    if (!match) return false;

    const [, action, token] = match;
    const pending = this.pending.get(token.toLowerCase());

    if (!pending) {
      logger.warn({ token }, 'BountyGate: no pending approval found (expired?)');
      return true;
    }

    this.pending.delete(token.toLowerCase());

    if (action.toLowerCase() === 'approve-bounty') {
      pending.onApprove();
      onApprove(token, pending.bounty);
      logger.info({ token, bountyId: pending.bounty.id }, 'BountyGate: approved');
    } else {
      pending.onReject();
      onReject(token, pending.bounty);
      logger.info({ token, bountyId: pending.bounty.id }, 'BountyGate: rejected');
    }

    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [token, p] of this.pending) {
      if (p.expiresAt.getTime() < now) {
        this.pending.delete(token);
        logger.info({ token, bountyId: p.bounty.id }, 'BountyGate: proposal expired');
      }
    }
  }
}
