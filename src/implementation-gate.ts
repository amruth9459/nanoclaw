/**
 * Implementation Gate — HITL approval for autonomous code implementations.
 *
 * When an auto-dispatch agent implements changes on a branch, this gate
 * holds the merge until the user approves via WhatsApp.
 *
 * Flow:
 * 1. Agent creates branch `claw/{task-id}` in target repo
 * 2. Agent calls `propose_implementation` IPC tool
 * 3. Host pushes branch, sends approval message to WhatsApp
 * 4. User replies "approve {task-id}" or "reject {task-id}"
 * 5. Host merges or deletes the branch accordingly
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const APPROVAL_PATTERN = /\b(approve|reject)\s+([\w-]+)\b/i;
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PendingImplementation {
  taskId: string;
  branch: string;
  repoPath: string;
  summary: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  expiresAt: Date;
}

export class ImplementationGate {
  private readonly pending = new Map<string, PendingImplementation>();

  /**
   * Register a proposed implementation for approval.
   * Returns the formatted WhatsApp message to send to the user.
   */
  propose(opts: {
    taskId: string;
    branch: string;
    repoPath: string;
    summary: string;
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
  }): string {
    this.cleanup();

    const impl: PendingImplementation = {
      taskId: opts.taskId,
      branch: opts.branch,
      repoPath: opts.repoPath,
      summary: opts.summary,
      filesChanged: opts.filesChanged ?? 0,
      insertions: opts.insertions ?? 0,
      deletions: opts.deletions ?? 0,
      expiresAt: new Date(Date.now() + EXPIRY_MS),
    };

    this.pending.set(opts.taskId, impl);

    const diffStats = impl.filesChanged > 0
      ? `\n*Files:* ${impl.filesChanged} changed (+${impl.insertions}, -${impl.deletions})`
      : '';

    return [
      `*Implementation Ready — ${opts.taskId}*`,
      `*Branch:* ${opts.branch}${diffStats}`,
      `*Summary:* ${opts.summary}`,
      '',
      `Reply \`approve ${opts.taskId}\` to merge to main.`,
      `Reply \`reject ${opts.taskId}\` to discard branch.`,
    ].join('\n');
  }

  /**
   * Check if a message contains an approve/reject command for a pending implementation.
   * Returns true if the message was handled.
   */
  async tryHandleApproval(
    message: string,
    onResult: (text: string) => Promise<void>,
  ): Promise<boolean> {
    this.cleanup();
    const match = message.match(APPROVAL_PATTERN);
    if (!match) return false;

    const [, action, taskId] = match;
    const impl = this.pending.get(taskId);

    if (!impl) return false;

    this.pending.delete(taskId);

    if (action.toLowerCase() === 'approve') {
      try {
        await this.mergeBranch(impl);
        await onResult(`*${taskId}* merged to main.`);
        logger.info({ taskId, branch: impl.branch }, 'Implementation approved and merged');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await onResult(`*${taskId}* merge failed: ${msg}`);
        logger.error({ taskId, err }, 'Implementation merge failed');
      }
    } else {
      try {
        await this.deleteBranch(impl);
        await onResult(`*${taskId}* rejected — branch deleted.`);
        logger.info({ taskId, branch: impl.branch }, 'Implementation rejected');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await onResult(`*${taskId}* branch deletion failed: ${msg}`);
        logger.warn({ taskId, err }, 'Implementation branch deletion failed');
      }
    }

    return true;
  }

  /** Get all pending implementations (for digest) */
  getPending(): PendingImplementation[] {
    this.cleanup();
    return Array.from(this.pending.values());
  }

  private async mergeBranch(impl: PendingImplementation): Promise<void> {
    const { repoPath, branch } = impl;
    await execFileAsync('git', ['checkout', 'main'], { cwd: repoPath });
    await execFileAsync('git', ['merge', branch, '--no-edit'], { cwd: repoPath });
    await execFileAsync('git', ['branch', '-d', branch], { cwd: repoPath });
    logger.info({ branch, repoPath }, 'Branch merged and deleted');
  }

  private async deleteBranch(impl: PendingImplementation): Promise<void> {
    const { repoPath, branch } = impl;
    // Force delete since it's unmerged
    await execFileAsync('git', ['branch', '-D', branch], { cwd: repoPath });
    logger.info({ branch, repoPath }, 'Branch force-deleted');
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [taskId, impl] of this.pending) {
      if (impl.expiresAt.getTime() < now) {
        this.pending.delete(taskId);
        logger.info({ taskId, branch: impl.branch }, 'Implementation proposal expired');
      }
    }
  }
}
