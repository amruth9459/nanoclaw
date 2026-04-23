/**
 * Avoice (YC W26) Competitive Intelligence Monitor.
 *
 * Automated quarterly check-ins: web search for B2G signals,
 * classify severity, generate reports, send WhatsApp alerts.
 */
import { logger } from '../logger.js';

import { logIntelCheck, getLatestIntelCheck } from './persistence.js';
import type {
  CompetitorConfig,
  CompetitorSignal,
  IntelCheck,
  IntelReport,
  SignalSeverity,
} from './types.js';

// ---------------------------------------------------------------------------
// Avoice Configuration
// ---------------------------------------------------------------------------

export const AVOICE_CONFIG: CompetitorConfig = {
  name: 'Avoice',
  search_queries: [
    'Avoice government',
    'Avoice plan review',
    'Avoice municipality',
    'Avoice building department',
    'Avoice ICC code council',
    'Avoice B2G',
  ],
  trigger_keywords: [
    'government',
    'plan review',
    'ICC',
    'municipality',
    'building department',
    'public sector',
    'city',
    'county',
    'AHJ',
    'authority having jurisdiction',
    'GovTech',
    'civic',
    'permitting',
  ],
  baseline_status: 'B2B focused — no government/B2G product announced. Platform serves architecture firms across 5 countries with $300M+ projects.',
  next_review: '2026-06-27',
};

// ---------------------------------------------------------------------------
// Signal Detection
// ---------------------------------------------------------------------------

/**
 * Classify severity based on keyword and context.
 * CRITICAL: direct plan review product or ICC partnership
 * HIGH: government customers, B2G positioning
 * MEDIUM: expanded compliance scope, funding
 * LOW: general mentions, industry news
 */
export function classifySignalSeverity(
  keyword: string,
  snippet: string,
): SignalSeverity {
  const lower = snippet.toLowerCase();

  // CRITICAL: direct plan review or ICC partnership
  if (
    (keyword === 'plan review' && (lower.includes('launch') || lower.includes('announce') || lower.includes('product'))) ||
    (keyword === 'ICC' && (lower.includes('partner') || lower.includes('certif')))
  ) {
    return 'CRITICAL';
  }

  // HIGH: government customers or B2G pivot
  if (
    (lower.includes('government') && (lower.includes('customer') || lower.includes('pilot') || lower.includes('contract'))) ||
    (lower.includes('building department') && (lower.includes('deploy') || lower.includes('adopt'))) ||
    lower.includes('b2g')
  ) {
    return 'HIGH';
  }

  // MEDIUM: compliance expansion or significant funding
  if (
    lower.includes('compliance') ||
    lower.includes('series a') ||
    lower.includes('funding') ||
    lower.includes('government tier') ||
    lower.includes('public sector')
  ) {
    return 'MEDIUM';
  }

  return 'LOW';
}

/**
 * Detect signals from search result snippets.
 * Matches trigger keywords against each snippet and classifies severity.
 */
export function detectSignals(
  searchResults: Array<{ query: string; snippets: Array<{ source: string; text: string }> }>,
  triggerKeywords: string[],
): CompetitorSignal[] {
  const signals: CompetitorSignal[] = [];
  const now = new Date().toISOString();

  for (const result of searchResults) {
    for (const snippet of result.snippets) {
      const lower = snippet.text.toLowerCase();

      for (const keyword of triggerKeywords) {
        if (lower.includes(keyword.toLowerCase())) {
          signals.push({
            keyword,
            source: snippet.source,
            snippet: snippet.text.slice(0, 500),
            severity: classifySignalSeverity(keyword, snippet.text),
            detected_at: now,
          });
          break; // One signal per snippet (avoid duplicates)
        }
      }
    }
  }

  return signals;
}

/**
 * Get the highest severity from a list of signals.
 */
export function getMaxSeverity(signals: CompetitorSignal[]): SignalSeverity {
  const order: SignalSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  for (const level of order) {
    if (signals.some(s => s.severity === level)) return level;
  }
  return 'LOW';
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

/**
 * Generate a quarterly intelligence report comparing current signals to baseline.
 */
export function generateReport(
  config: CompetitorConfig,
  signals: CompetitorSignal[],
): IntelReport {
  const maxSeverity = getMaxSeverity(signals);
  const checkDate = new Date().toISOString().split('T')[0];

  const criticalSignals = signals.filter(s => s.severity === 'CRITICAL');
  const highSignals = signals.filter(s => s.severity === 'HIGH');
  const mediumSignals = signals.filter(s => s.severity === 'MEDIUM');
  const lowSignals = signals.filter(s => s.severity === 'LOW');

  const summaryParts: string[] = [];
  if (criticalSignals.length > 0) {
    summaryParts.push(`${criticalSignals.length} CRITICAL signal(s) detected — immediate action required`);
  }
  if (highSignals.length > 0) {
    summaryParts.push(`${highSignals.length} HIGH signal(s) detected — escalate within 48 hours`);
  }
  if (mediumSignals.length > 0) {
    summaryParts.push(`${mediumSignals.length} MEDIUM signal(s) — note for next review`);
  }
  if (lowSignals.length > 0) {
    summaryParts.push(`${lowSignals.length} LOW signal(s) — general mentions`);
  }
  if (signals.length === 0) {
    summaryParts.push('No B2G signals detected. Competitor remains B2B focused.');
  }

  const actions: string[] = [];
  if (maxSeverity === 'CRITICAL') {
    actions.push('Escalate to leadership immediately');
    actions.push('Accelerate ICC partnership timeline');
    actions.push('Conduct deep competitive feature comparison');
    actions.push('Develop counter-positioning strategy');
  } else if (maxSeverity === 'HIGH') {
    actions.push('Escalate within 48 hours');
    actions.push('Monitor closely for follow-up announcements');
    actions.push('Review competitive positioning');
  } else if (maxSeverity === 'MEDIUM') {
    actions.push('Note for next quarterly review');
    actions.push('Continue monitoring');
  } else {
    actions.push('Continue quarterly monitoring');
    actions.push('No action required');
  }

  return {
    competitor: config.name,
    check_date: checkDate,
    baseline_status: config.baseline_status,
    signals,
    max_severity: maxSeverity,
    summary: summaryParts.join('. '),
    recommended_actions: actions,
  };
}

/**
 * Format a report as a readable text string.
 */
export function formatReportText(report: IntelReport): string {
  const lines: string[] = [
    `=== Competitive Intelligence Report: ${report.competitor} ===`,
    `Date: ${report.check_date}`,
    `Threat Level: ${report.max_severity}`,
    '',
    `Baseline: ${report.baseline_status}`,
    '',
    `--- Summary ---`,
    report.summary,
    '',
  ];

  if (report.signals.length > 0) {
    lines.push('--- Signals Detected ---');
    for (const signal of report.signals) {
      lines.push(`[${signal.severity}] "${signal.keyword}" — ${signal.source}`);
      lines.push(`  ${signal.snippet.slice(0, 200)}`);
    }
    lines.push('');
  }

  lines.push('--- Recommended Actions ---');
  for (const action of report.recommended_actions) {
    lines.push(`• ${action}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Alert Logic
// ---------------------------------------------------------------------------

/**
 * Determine if a WhatsApp alert should be sent based on severity.
 */
export function shouldAlert(maxSeverity: SignalSeverity): boolean {
  return maxSeverity === 'CRITICAL' || maxSeverity === 'HIGH';
}

/**
 * Format a WhatsApp alert message for urgent signals.
 */
export function formatAlertMessage(report: IntelReport): string {
  const urgentSignals = report.signals.filter(
    s => s.severity === 'CRITICAL' || s.severity === 'HIGH',
  );

  const lines: string[] = [
    `🚨 *Competitive Intel Alert: ${report.competitor}*`,
    `Threat Level: *${report.max_severity}*`,
    '',
  ];

  for (const signal of urgentSignals) {
    lines.push(`[${signal.severity}] ${signal.keyword}: ${signal.snippet.slice(0, 150)}`);
  }

  lines.push('');
  lines.push('*Actions Required:*');
  for (const action of report.recommended_actions) {
    lines.push(`• ${action}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Run Check (orchestrator)
// ---------------------------------------------------------------------------

/**
 * Run a competitive intelligence check for Avoice.
 *
 * @param searchResults - Pre-fetched search results (from web search tool)
 * @param checkType - Type of check (quarterly, manual, triggered)
 * @returns The logged check result and formatted report
 */
export function runAvoiceCheck(
  searchResults: Array<{ query: string; snippets: Array<{ source: string; text: string }> }>,
  checkType: IntelCheck['check_type'] = 'quarterly',
): { check: IntelCheck; report: IntelReport; alertMessage: string | null } {
  const config = AVOICE_CONFIG;

  // Detect signals from search results
  const signals = detectSignals(searchResults, config.trigger_keywords);
  const maxSeverity = getMaxSeverity(signals);

  // Generate report
  const report = generateReport(config, signals);
  const reportText = formatReportText(report);

  // Determine if alert needed
  const needsAlert = shouldAlert(maxSeverity);
  const alertMessage = needsAlert ? formatAlertMessage(report) : null;

  // Log to database
  const check = logIntelCheck({
    competitor: config.name,
    check_type: checkType,
    signals,
    max_severity: maxSeverity,
    report: reportText,
    alert_sent: needsAlert,
  });

  logger.info(
    {
      competitor: config.name,
      signalCount: signals.length,
      maxSeverity,
      alertSent: needsAlert,
      checkId: check.id,
    },
    'Competitive intel check completed',
  );

  return { check, report, alertMessage };
}

/**
 * Check if a quarterly review is due based on the configured next_review date.
 */
export function isQuarterlyReviewDue(): boolean {
  const now = new Date();
  const nextReview = new Date(AVOICE_CONFIG.next_review);
  return now >= nextReview;
}

/**
 * Get the previous check for comparison.
 */
export function getPreviousCheck(): IntelCheck | null {
  return getLatestIntelCheck('Avoice');
}
