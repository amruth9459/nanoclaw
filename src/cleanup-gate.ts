/**
 * CleanupGate — HITL approval gate for Gmail cleanup operations.
 *
 * The agent proposes a cleanup via IPC; the host stores it and sends a
 * WhatsApp notification. The user replies "approve-cleanup <token>" or
 * "reject-cleanup <token>" in the main group.
 *
 * Safety: 100-message hard cap, trash/archive only (no permanent delete),
 * 30-minute token expiry, audit logging.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const APPROVAL_PATTERN = /\b(approve-cleanup|reject-cleanup)\s+([a-f0-9]{8})\b/i;
const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGES = 100;
const __dirname_esm = path.dirname(new URL(import.meta.url).pathname);
const GWS_HELPER = path.join(__dirname_esm, '..', 'container', 'skills', 'gws', 'gws_helper.py');
const GWS_TOKEN_DIR = path.join(process.env.HOME ?? '', '.config', 'gws');
const AUDIT_DIR = path.join(DATA_DIR, 'audit', 'gmail-cleanup');

export type CleanupAction = 'trash' | 'archive';

export interface CleanupProposal {
  action: CleanupAction;
  messageIds: string[];
  summary: string;
  breakdown: string;
  groupFolder: string;
}

interface PendingCleanup {
  token: string;
  proposal: CleanupProposal;
  expiresAt: Date;
}

export class CleanupGate {
  private readonly pending = new Map<string, PendingCleanup>();

  /**
   * Register a cleanup proposal and return the approval token.
   * Throws if messageIds exceeds hard cap.
   */
  propose(proposal: CleanupProposal): string {
    this.cleanup();

    if (proposal.messageIds.length > MAX_MESSAGES) {
      throw new Error(`Cleanup batch exceeds hard cap of ${MAX_MESSAGES} messages (got ${proposal.messageIds.length})`);
    }
    if (proposal.messageIds.length === 0) {
      throw new Error('Cleanup batch is empty');
    }
    if (proposal.action !== 'trash' && proposal.action !== 'archive') {
      throw new Error(`Invalid cleanup action: ${proposal.action}. Only trash/archive allowed.`);
    }

    const token = crypto.randomBytes(4).toString('hex');
    this.pending.set(token, {
      token,
      proposal,
      expiresAt: new Date(Date.now() + EXPIRY_MS),
    });

    logger.info(
      { token, action: proposal.action, count: proposal.messageIds.length },
      'CleanupGate: proposal registered',
    );
    return token;
  }

  /**
   * Format the HITL notification message for WhatsApp.
   */
  static formatProposalMessage(proposal: CleanupProposal, token: string): string {
    const actionEmoji = proposal.action === 'trash' ? '🗑️' : '📦';
    const actionLabel = proposal.action === 'trash' ? 'Trash' : 'Archive';
    return [
      `${actionEmoji} *Gmail Cleanup — Approval Required*`,
      '',
      `*Action:* ${actionLabel} ${proposal.messageIds.length} messages`,
      `*Summary:* ${proposal.summary}`,
      '',
      `*Breakdown:*`,
      proposal.breakdown,
      '',
      `Reply:  *approve-cleanup ${token}*`,
      `        *reject-cleanup ${token}*`,
      `_(expires in 30 minutes)_`,
    ].join('\n');
  }

  /**
   * Check if a message contains an approve/reject-cleanup token.
   * Returns true if the message was a cleanup command (even if expired).
   */
  async tryHandleApproval(
    message: string,
    notifyFn: (text: string) => Promise<void>,
  ): Promise<boolean> {
    this.cleanup();
    const match = message.match(APPROVAL_PATTERN);
    if (!match) return false;

    const [, action, token] = match;
    const pending = this.pending.get(token.toLowerCase());

    if (!pending) {
      await notifyFn('⚠️ No pending cleanup found for that token (expired or already handled).');
      logger.warn({ token }, 'CleanupGate: no pending approval found');
      return true;
    }

    this.pending.delete(token.toLowerCase());

    if (action.toLowerCase() === 'approve-cleanup') {
      await notifyFn(`⏳ Executing cleanup: ${pending.proposal.action} ${pending.proposal.messageIds.length} messages...`);
      try {
        await this.executeCleanup(pending.proposal);
        this.writeAuditLog(pending, 'approved');
        const actionLabel = pending.proposal.action === 'trash' ? 'trashed' : 'archived';
        await notifyFn(`✅ Done — ${pending.proposal.messageIds.length} messages ${actionLabel}.`);
        logger.info({ token, action: pending.proposal.action, count: pending.proposal.messageIds.length }, 'CleanupGate: approved and executed');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.writeAuditLog(pending, 'error', errMsg);
        await notifyFn(`❌ Cleanup failed: ${errMsg}`);
        logger.error({ token, err }, 'CleanupGate: execution failed');
      }
    } else {
      this.writeAuditLog(pending, 'rejected');
      await notifyFn('❌ Cleanup rejected.');
      logger.info({ token }, 'CleanupGate: rejected');
    }

    return true;
  }

  /**
   * Execute the cleanup by running gws_helper.py on the host.
   */
  private async executeCleanup(proposal: CleanupProposal): Promise<void> {
    const action = proposal.action === 'trash' ? 'gmail_batch_trash' : 'gmail_batch_archive';
    const idsJson = JSON.stringify(proposal.messageIds);

    const { stdout, stderr } = await execFileAsync('python3', [
      GWS_HELPER, action,
      '--message_ids', idsJson,
    ], {
      timeout: 60_000,
      env: { ...process.env, GWS_TOKEN_DIR },
    });

    if (stderr?.trim()) {
      logger.warn({ stderr: stderr.trim() }, 'CleanupGate: gws_helper stderr');
    }

    const result = JSON.parse(stdout.trim());
    if (result.error) {
      throw new Error(result.error);
    }
  }

  /**
   * Write an audit log entry to data/audit/gmail-cleanup/.
   */
  private writeAuditLog(pending: PendingCleanup, decision: string, error?: string): void {
    try {
      fs.mkdirSync(AUDIT_DIR, { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        token: pending.token,
        decision,
        action: pending.proposal.action,
        messageCount: pending.proposal.messageIds.length,
        messageIds: pending.proposal.messageIds,
        summary: pending.proposal.summary,
        groupFolder: pending.proposal.groupFolder,
        ...(error && { error }),
      };
      const filename = `${Date.now()}-${pending.token}.json`;
      fs.writeFileSync(path.join(AUDIT_DIR, filename), JSON.stringify(entry, null, 2));
    } catch (err) {
      logger.error({ err }, 'CleanupGate: failed to write audit log');
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [token, p] of this.pending) {
      if (p.expiresAt.getTime() < now) {
        this.pending.delete(token);
        logger.info({ token }, 'CleanupGate: proposal expired');
      }
    }
  }
}
