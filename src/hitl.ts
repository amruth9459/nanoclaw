/**
 * Human-in-the-Loop (HITL) approval gate.
 *
 * Intercepts outbound messages to unregistered JIDs and holds them
 * until the user approves or rejects via WhatsApp.
 *
 * Attack vector addressed: prompt injection via untrusted content
 * (email, web pages) making the main agent write IPC files targeting
 * external JIDs. The Bash tool can write arbitrary IPC files, so we
 * enforce approval at the host IPC layer, not in the container.
 */

import crypto from 'crypto';

import { logger } from './logger.js';

// Matches "approve <8-hex-id>" or "reject <8-hex-id>" anywhere in a message
// (handles @mention prefix, surrounding text, case-insensitive)
const APPROVAL_PATTERN = /\b(approve|reject)\s+([a-f0-9]{8})\b/i;

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

interface PendingApproval {
  id: string;
  targetJid: string;
  text: string;
  sourceGroup: string;
  expiresAt: Date;
  execute: () => Promise<void>;
}

export class HitlGate {
  private readonly pending = new Map<string, PendingApproval>();

  /**
   * Hold a send to an unregistered JID until the user approves.
   * Sends an approval request notification via notifyFn.
   */
  async requestApproval(
    targetJid: string,
    text: string,
    sourceGroup: string,
    notifyFn: (msg: string) => Promise<void>,
    executeFn: () => Promise<void>,
  ): Promise<void> {
    this.cleanup();
    const id = crypto.randomBytes(4).toString('hex'); // 8-char hex token
    const expiresAt = new Date(Date.now() + EXPIRY_MS);

    this.pending.set(id, {
      id,
      targetJid,
      text,
      sourceGroup,
      expiresAt,
      execute: executeFn,
    });

    const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;
    const msg = [
      '🛡️ *HITL Gate — Approval Required*',
      '',
      `An agent wants to send a message to an *unregistered* contact.`,
      '',
      `*Target JID:* ${targetJid}`,
      `*From agent:* ${sourceGroup}`,
      `*Preview:* "${preview}"`,
      '',
      `Reply *approve ${id}* to send, or *reject ${id}* to cancel.`,
      `_(expires in 10 minutes)_`,
    ].join('\n');

    await notifyFn(msg);
    logger.warn(
      { id, targetJid, sourceGroup },
      'HITL: approval requested for unregistered JID',
    );
  }

  /**
   * Check if a message contains an approval/rejection token.
   * Executes the pending action if approved.
   * Returns true if the message was an approval command (handled or not).
   */
  async tryHandleApproval(
    message: string,
    notifyFn: (msg: string) => Promise<void>,
  ): Promise<boolean> {
    this.cleanup();
    const match = message.match(APPROVAL_PATTERN);
    if (!match) return false;

    const [, action, id] = match;
    const approval = this.pending.get(id.toLowerCase());

    if (!approval) {
      await notifyFn(`No pending approval found for ID *${id}*. It may have expired.`);
      return true;
    }

    this.pending.delete(id.toLowerCase());

    if (action.toLowerCase() === 'approve') {
      try {
        await approval.execute();
        await notifyFn(`✅ Approved. Message sent to ${approval.targetJid}.`);
        logger.info({ id, targetJid: approval.targetJid }, 'HITL: approved');
      } catch (err) {
        await notifyFn(`❌ Approval granted but send failed: ${err instanceof Error ? err.message : String(err)}`);
        logger.error({ id, err }, 'HITL: execute failed after approval');
      }
    } else {
      await notifyFn(`❌ Rejected. Message to ${approval.targetJid} cancelled.`);
      logger.info({ id, targetJid: approval.targetJid }, 'HITL: rejected');
    }

    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, a] of this.pending) {
      if (a.expiresAt.getTime() < now) {
        this.pending.delete(id);
        logger.info({ id, targetJid: a.targetJid }, 'HITL: approval expired');
      }
    }
  }
}
