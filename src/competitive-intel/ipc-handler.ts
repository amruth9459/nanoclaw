/**
 * Competitive Intelligence IPC Handler — Host-side processing of intel check requests.
 *
 * Receives IPC messages from container agents and runs the Avoice monitor.
 * Returns results via response files.
 */
import { logger } from '../logger.js';

import {
  runAvoiceCheck,
  isQuarterlyReviewDue,
  getPreviousCheck,
  AVOICE_CONFIG,
} from './avoice-monitor.js';
import { getIntelChecks, getIntelStats } from './persistence.js';

// ---------------------------------------------------------------------------
// IPC Message Types
// ---------------------------------------------------------------------------

export const COMPETITIVE_INTEL_IPC_TYPE = 'competitive_intel_check';

export interface CompetitiveIntelIpcMessage {
  type: 'competitive_intel_check';
  action: string;
  search_results?: Array<{
    query: string;
    snippets: Array<{ source: string; text: string }>;
  }>;
  check_type?: 'quarterly' | 'manual' | 'triggered';
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a competitive intel IPC message from a container agent.
 * Returns the result as a plain object to be written to the response file.
 */
export async function handleCompetitiveIntelIpc(
  data: CompetitiveIntelIpcMessage,
): Promise<Record<string, unknown>> {
  const { action } = data;

  try {
    switch (action) {
      case 'check': {
        const searchResults = data.search_results;
        if (!searchResults || !Array.isArray(searchResults)) {
          return { error: 'check requires search_results array' };
        }

        const checkType = data.check_type || 'manual';
        const { check, report, alertMessage } = runAvoiceCheck(searchResults, checkType);

        return {
          status: 'completed',
          check_id: check.id,
          signal_count: check.signal_count,
          max_severity: check.max_severity,
          alert_sent: check.alert_sent,
          alert_message: alertMessage,
          report_summary: report.summary,
          recommended_actions: report.recommended_actions,
        };
      }

      case 'status': {
        const isDue = isQuarterlyReviewDue();
        const previous = getPreviousCheck();
        const stats = getIntelStats();

        return {
          competitor: AVOICE_CONFIG.name,
          next_review: AVOICE_CONFIG.next_review,
          is_review_due: isDue,
          baseline_status: AVOICE_CONFIG.baseline_status,
          last_check: previous ? {
            checked_at: previous.checked_at,
            signal_count: previous.signal_count,
            max_severity: previous.max_severity,
            alert_sent: previous.alert_sent,
          } : null,
          stats,
        };
      }

      case 'history': {
        const limit = (data.limit as number) ?? 10;
        const checks = getIntelChecks('Avoice', limit);
        return { checks };
      }

      case 'config': {
        return {
          competitor: AVOICE_CONFIG.name,
          search_queries: AVOICE_CONFIG.search_queries,
          trigger_keywords: AVOICE_CONFIG.trigger_keywords,
          baseline_status: AVOICE_CONFIG.baseline_status,
          next_review: AVOICE_CONFIG.next_review,
        };
      }

      default:
        return { error: `Unknown competitive_intel_check action: ${action}` };
    }
  } catch (err) {
    logger.error({ err, action }, 'Competitive intel IPC handler error');
    return { error: String(err instanceof Error ? err.message : err) };
  }
}
