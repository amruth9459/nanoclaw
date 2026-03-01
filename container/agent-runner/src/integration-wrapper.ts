/**
 * Integration Wrapper for Container Agent
 *
 * Provides simple functions to wrap SDK query() execution with:
 * - Response Time Manager (acknowledgments, progress, estimation)
 * - Judge System (quality review before delivery)
 *
 * This is a lightweight adapter that works within the container's constraints.
 */

import fs from 'fs';
import path from 'path';

// IPC directories for communication with host
const IPC_MESSAGES_DIR = '/workspace/ipc/messages';

/**
 * Write streaming message to IPC so host sends it via WhatsApp
 */
export function sendStreamingMessage(chatJid: string, text: string, groupFolder: string): void {
  try {
    fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
    const filepath = path.join(IPC_MESSAGES_DIR, `${Date.now()}-streaming.json`);
    const data = {
      type: 'streaming_message',
      chatJid,
      text,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    const tmp = `${filepath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filepath);
  } catch (err) {
    console.error(`[integration] Failed to send streaming message: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Send immediate acknowledgment with task estimation
 */
export function sendAcknowledgment(
  chatJid: string,
  userQuery: string,
  groupFolder: string
): void {
  const estimate = estimateTaskDuration(userQuery);
  const emoji = getTaskEmoji(estimate.complexity);

  let message = `${emoji} Got it! `;

  if (estimate.durationMs >= 30000) {
    message += `This will take ${estimate.durationHuman}. `;
  }

  message += `I'll notify you when done!`;

  sendStreamingMessage(chatJid, message, groupFolder);
}

/**
 * Estimate task duration from user query
 */
function estimateTaskDuration(userQuery: string): {
  durationMs: number;
  durationHuman: string;
  complexity: 'simple' | 'moderate' | 'complex' | 'very-complex';
} {
  const query = userQuery.toLowerCase();

  // Very complex tasks (>5 minutes)
  if (/build.*system|implement.*architecture|create.*infrastructure/.test(query)) {
    return { durationMs: 300000, durationHuman: '~5 minutes', complexity: 'very-complex' };
  }

  // Complex tasks (2-5 minutes)
  if (/analyze.*codebase|review.*files|comprehensive|multi-step/.test(query)) {
    return { durationMs: 180000, durationHuman: '~3 minutes', complexity: 'complex' };
  }

  // Moderate tasks (30s-2min)
  if (/search|find|read.*files|check|review/.test(query)) {
    return { durationMs: 60000, durationHuman: '~1 minute', complexity: 'moderate' };
  }

  // Simple tasks (<30s)
  return { durationMs: 10000, durationHuman: '~30 seconds', complexity: 'simple' };
}

/**
 * Get emoji based on task complexity
 */
function getTaskEmoji(complexity: string): string {
  switch (complexity) {
    case 'simple': return '⚡';
    case 'moderate': return '🔍';
    case 'complex': return '🛠️';
    case 'very-complex': return '🏗️';
    default: return '⚡';
  }
}

/**
 * Determine if this looks like a code-related task
 */
export function isCodeTask(userQuery: string): boolean {
  const query = userQuery.toLowerCase();
  return /\b(code|function|class|implement|build|create|fix|bug|error|test)\b/.test(query) ||
         /\.(ts|js|py|java|go|rs|cpp)\b/.test(query);
}

/**
 * Determine if this is a revenue product task
 */
export function isRevenueTask(userQuery: string): boolean {
  const query = userQuery.toLowerCase();
  return /\b(osha|grant|report|customer|client|paid)\b/.test(query);
}

/**
 * Check if response time features are enabled
 */
export function isResponseTimeEnabled(): boolean {
  return process.env.NANOCLAW_RESPONSE_TIME !== '0';
}

/**
 * Check if judge system is enabled
 */
export function isJudgeSystemEnabled(): boolean {
  return process.env.NANOCLAW_JUDGE_SYSTEM === '1';
}

/**
 * Get judge threshold from environment
 */
export function getJudgeThreshold(): 'always' | 'code-only' | 'revenue-only' | 'never' {
  const threshold = process.env.NANOCLAW_JUDGE_THRESHOLD;
  if (threshold === 'always' || threshold === 'code-only' || threshold === 'revenue-only' || threshold === 'never') {
    return threshold;
  }
  return 'code-only'; // Default
}

/**
 * Determine if judges should review this task
 */
export function shouldUseJudges(userQuery: string): boolean {
  if (!isJudgeSystemEnabled()) {
    return false;
  }

  const threshold = getJudgeThreshold();

  switch (threshold) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'code-only':
      return isCodeTask(userQuery);
    case 'revenue-only':
      return isRevenueTask(userQuery);
    default:
      return false;
  }
}

/**
 * Simple judge review (placeholder - actual implementation would use judge-system.ts)
 *
 * For now, this just checks for obvious issues in the response.
 * Full integration would spawn actual LLM judges.
 */
export function quickJudgeReview(response: string): {
  approved: boolean;
  issues: string[];
  recommendation: string;
} {
  const issues: string[] = [];

  // Check for common issues
  if (response.includes('I tested') || response.includes('I ran')) {
    issues.push('⚠️ Claims to have run code without evidence');
  }

  if (response.includes('I don\'t know') && response.length < 100) {
    issues.push('ℹ️ Very short response - may be incomplete');
  }

  if (/\d+%/.test(response) && !response.includes('estimate')) {
    issues.push('⚠️ Contains percentages without marking as estimate');
  }

  // Auto-approve if no critical issues
  const approved = issues.length === 0 || issues.every(i => i.startsWith('ℹ️'));

  const recommendation = approved
    ? '✅ APPROVED: No critical issues found'
    : `⚠️ REVIEW RECOMMENDED: ${issues.length} issue(s) found`;

  return { approved, issues, recommendation };
}

/**
 * Send judge verdict
 */
export function sendJudgeVerdict(
  chatJid: string,
  approved: boolean,
  issues: string[],
  recommendation: string,
  groupFolder: string
): void {
  if (!approved && issues.length > 0) {
    let message = `🔍 *Quality Review*\n\n${recommendation}\n\n*Issues:*\n`;
    issues.forEach((issue, i) => {
      message += `${i + 1}. ${issue}\n`;
    });

    sendStreamingMessage(chatJid, message, groupFolder);
  }
}

/**
 * Wrapper for task execution with integrated features
 *
 * Usage in index.ts:
 * ```typescript
 * import { wrapTaskExecution } from './integration-wrapper.js';
 *
 * const { shouldProceed, finalResponse } = await wrapTaskExecution({
 *   chatJid,
 *   groupFolder,
 *   userQuery,
 *   executeTask: async () => {
 *     // Run SDK query() here
 *     return assistantResponse;
 *   }
 * });
 *
 * if (shouldProceed) {
 *   // Send finalResponse to user
 * }
 * ```
 */
export async function wrapTaskExecution(config: {
  chatJid: string;
  groupFolder: string;
  userQuery: string;
  executeTask: () => Promise<string>;
}): Promise<{
  shouldProceed: boolean;
  finalResponse: string;
  judgeResult?: { approved: boolean; issues: string[]; recommendation: string };
}> {
  const { chatJid, groupFolder, userQuery, executeTask } = config;

  // Step 1: Send acknowledgment if enabled
  if (isResponseTimeEnabled()) {
    sendAcknowledgment(chatJid, userQuery, groupFolder);
  }

  // Step 2: Execute the task
  const response = await executeTask();

  // Step 3: Judge review if applicable
  const useJudges = shouldUseJudges(userQuery);

  if (useJudges) {
    const judgeResult = quickJudgeReview(response);

    sendJudgeVerdict(
      chatJid,
      judgeResult.approved,
      judgeResult.issues,
      judgeResult.recommendation,
      groupFolder
    );

    return {
      shouldProceed: judgeResult.approved,
      finalResponse: response,
      judgeResult,
    };
  }

  // No judges, proceed
  return {
    shouldProceed: true,
    finalResponse: response,
  };
}
