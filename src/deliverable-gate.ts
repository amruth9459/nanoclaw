/**
 * DeliverableGate — HITL approval gate for freelance deliverables.
 *
 * The agent proposes a deliverable via IPC; the host stores it and sends a
 * WhatsApp notification. The user replies "approve-delivery <token>" or
 * "reject-delivery <token>" in the freelance group.
 */

import crypto from 'crypto';

import { logger } from './logger.js';

const APPROVAL_PATTERN = /\b(approve-delivery|reject-delivery)\s+([a-f0-9]{8})\b/i;
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours — deliverables need review time

export interface PendingDeliverable {
  token: string;
  gigId: string;
  gigTitle: string;
  clientInfo?: string;
  workSummary: string;
  deliverablePath?: string;
  groupFolder: string;
  expiresAt: Date;
  onApprove: () => void;
  onReject: () => void;
}

export class DeliverableGate {
  private readonly pending = new Map<string, PendingDeliverable>();

  /**
   * Register a deliverable proposal and return the approval token.
   * Caller is responsible for sending the HITL message to the user.
   */
  proposeDeliverable(
    gigId: string,
    gigTitle: string,
    workSummary: string,
    groupFolder: string,
    onApprove: () => void,
    onReject: () => void,
    clientInfo?: string,
    deliverablePath?: string,
  ): string {
    this.cleanup();
    const token = crypto.randomBytes(4).toString('hex'); // 8-char hex
    this.pending.set(token, {
      token,
      gigId,
      gigTitle,
      clientInfo,
      workSummary,
      deliverablePath,
      groupFolder,
      expiresAt: new Date(Date.now() + EXPIRY_MS),
      onApprove,
      onReject,
    });
    logger.info({ token, gigId }, 'DeliverableGate: proposal registered');
    return token;
  }

  /**
   * Format the HITL notification message for the user.
   */
  static formatProposalMessage(
    gigId: string,
    gigTitle: string,
    workSummary: string,
    token: string,
    clientInfo?: string,
    deliverablePath?: string,
  ): string {
    const clientLine = clientInfo ? `\nClient: ${clientInfo}` : '';
    const pathLine = deliverablePath ? `\nFile: ${deliverablePath}` : '';
    return [
      `📦 *Deliverable Ready for Review*`,
      `Gig: ${gigTitle}`,
      `ID: ${gigId}${clientLine}${pathLine}`,
      '',
      `Work Summary:`,
      workSummary.slice(0, 500),
      '',
      `Reply:  approve-delivery ${token}`,
      `        reject-delivery ${token}`,
    ].join('\n');
  }

  /**
   * Check if a message contains an approve/reject-delivery token.
   * Returns true if the message was a delivery approval command.
   */
  async tryHandleApproval(
    message: string,
    onApprove: (token: string, deliverable: PendingDeliverable) => void,
    onReject: (token: string, deliverable: PendingDeliverable) => void,
  ): Promise<boolean> {
    this.cleanup();
    const match = message.match(APPROVAL_PATTERN);
    if (!match) return false;

    const [, action, token] = match;
    const pending = this.pending.get(token.toLowerCase());

    if (!pending) {
      logger.warn({ token }, 'DeliverableGate: no pending approval found (expired?)');
      return true;
    }

    this.pending.delete(token.toLowerCase());

    if (action.toLowerCase() === 'approve-delivery') {
      pending.onApprove();
      onApprove(token, pending);
      logger.info({ token, gigId: pending.gigId }, 'DeliverableGate: approved');
    } else {
      pending.onReject();
      onReject(token, pending);
      logger.info({ token, gigId: pending.gigId }, 'DeliverableGate: rejected');
    }

    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [token, p] of this.pending) {
      if (p.expiresAt.getTime() < now) {
        this.pending.delete(token);
        logger.info({ token, gigId: p.gigId }, 'DeliverableGate: proposal expired');
      }
    }
  }
}
