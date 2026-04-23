import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getDb } from '../../db.js';
import { initMonitoringSchema } from '../../agent-monitoring-system.js';

import { initCompetitiveIntelSchema } from '../persistence.js';
import {
  logIntelCheck,
  getIntelChecks,
  getLatestIntelCheck,
  getIntelCheckById,
  getIntelStats,
} from '../persistence.js';

import {
  classifySignalSeverity,
  detectSignals,
  getMaxSeverity,
  generateReport,
  formatReportText,
  shouldAlert,
  formatAlertMessage,
  runAvoiceCheck,
  isQuarterlyReviewDue,
  AVOICE_CONFIG,
} from '../avoice-monitor.js';

import {
  handleCompetitiveIntelIpc,
} from '../ipc-handler.js';

import type { CompetitorSignal, SignalSeverity } from '../types.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  _initTestDatabase();
  const db = getDb();
  initMonitoringSchema(db);
  initCompetitiveIntelSchema(db);
});

// ---------------------------------------------------------------------------
// Signal Detection Tests
// ---------------------------------------------------------------------------

describe('signal-detection', () => {
  it('classifies CRITICAL severity for plan review launch', () => {
    const severity = classifySignalSeverity(
      'plan review',
      'Avoice announces the launch of their new plan review automation product for government agencies',
    );
    expect(severity).toBe('CRITICAL');
  });

  it('classifies CRITICAL severity for ICC partnership', () => {
    const severity = classifySignalSeverity(
      'ICC',
      'Avoice partners with the International Code Council to bring AI-powered certification',
    );
    expect(severity).toBe('CRITICAL');
  });

  it('classifies HIGH severity for government customer pilot', () => {
    const severity = classifySignalSeverity(
      'government',
      'Avoice signs first government customer pilot with San Francisco building department',
    );
    expect(severity).toBe('HIGH');
  });

  it('classifies MEDIUM severity for compliance expansion', () => {
    const severity = classifySignalSeverity(
      'compliance',
      'Avoice expands compliance checking capabilities to cover more building codes',
    );
    expect(severity).toBe('MEDIUM');
  });

  it('classifies LOW severity for general mention', () => {
    const severity = classifySignalSeverity(
      'plan review',
      'Avoice helps architects prepare better documentation for plan reviews',
    );
    expect(severity).toBe('LOW');
  });

  it('detects signals from search results', () => {
    const searchResults = [
      {
        query: 'Avoice government',
        snippets: [
          { source: 'techcrunch.com', text: 'Avoice, the AI workspace for architects, helps firms prepare government submissions faster' },
          { source: 'archdaily.com', text: 'Architecture firms use Avoice for internal documentation' },
        ],
      },
      {
        query: 'Avoice plan review',
        snippets: [
          { source: 'dezeen.com', text: 'Avoice launches plan review product for building departments nationwide' },
        ],
      },
    ];

    const signals = detectSignals(searchResults, AVOICE_CONFIG.trigger_keywords);

    expect(signals.length).toBeGreaterThan(0);
    // The "government" snippet should produce a signal
    const govSignal = signals.find(s => s.keyword === 'government');
    expect(govSignal).toBeDefined();
    expect(govSignal!.source).toBe('techcrunch.com');
  });

  it('avoids duplicate signals per snippet', () => {
    const searchResults = [
      {
        query: 'Avoice government plan review',
        snippets: [
          {
            source: 'example.com',
            text: 'Avoice government plan review for municipality building department',
          },
        ],
      },
    ];

    const signals = detectSignals(searchResults, AVOICE_CONFIG.trigger_keywords);
    // Should only produce one signal per snippet (first matching keyword)
    expect(signals.length).toBe(1);
  });

  it('returns empty signals for no matches', () => {
    const searchResults = [
      {
        query: 'Avoice architecture',
        snippets: [
          { source: 'example.com', text: 'Avoice helps architects with AI-powered design tools' },
        ],
      },
    ];

    const signals = detectSignals(searchResults, AVOICE_CONFIG.trigger_keywords);
    expect(signals.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Severity Tests
// ---------------------------------------------------------------------------

describe('severity', () => {
  it('getMaxSeverity returns CRITICAL when present', () => {
    const signals: CompetitorSignal[] = [
      { keyword: 'test', source: 'a', snippet: 'x', severity: 'LOW', detected_at: '' },
      { keyword: 'test', source: 'b', snippet: 'x', severity: 'CRITICAL', detected_at: '' },
      { keyword: 'test', source: 'c', snippet: 'x', severity: 'MEDIUM', detected_at: '' },
    ];
    expect(getMaxSeverity(signals)).toBe('CRITICAL');
  });

  it('getMaxSeverity returns HIGH when no CRITICAL', () => {
    const signals: CompetitorSignal[] = [
      { keyword: 'test', source: 'a', snippet: 'x', severity: 'LOW', detected_at: '' },
      { keyword: 'test', source: 'b', snippet: 'x', severity: 'HIGH', detected_at: '' },
    ];
    expect(getMaxSeverity(signals)).toBe('HIGH');
  });

  it('getMaxSeverity returns LOW for empty signals', () => {
    expect(getMaxSeverity([])).toBe('LOW');
  });
});

// ---------------------------------------------------------------------------
// Report Generation Tests
// ---------------------------------------------------------------------------

describe('report-generation', () => {
  it('generates report with no signals', () => {
    const report = generateReport(AVOICE_CONFIG, []);

    expect(report.competitor).toBe('Avoice');
    expect(report.max_severity).toBe('LOW');
    expect(report.summary).toContain('No B2G signals detected');
    expect(report.recommended_actions).toContain('Continue quarterly monitoring');
  });

  it('generates report with CRITICAL signals', () => {
    const signals: CompetitorSignal[] = [
      {
        keyword: 'plan review',
        source: 'techcrunch.com',
        snippet: 'Avoice launches plan review product for government agencies',
        severity: 'CRITICAL',
        detected_at: new Date().toISOString(),
      },
    ];

    const report = generateReport(AVOICE_CONFIG, signals);

    expect(report.max_severity).toBe('CRITICAL');
    expect(report.summary).toContain('CRITICAL');
    expect(report.recommended_actions).toContain('Escalate to leadership immediately');
    expect(report.recommended_actions).toContain('Accelerate ICC partnership timeline');
  });

  it('generates report with mixed severity signals', () => {
    const signals: CompetitorSignal[] = [
      { keyword: 'government', source: 'a.com', snippet: 'test', severity: 'HIGH', detected_at: '' },
      { keyword: 'compliance', source: 'b.com', snippet: 'test', severity: 'MEDIUM', detected_at: '' },
      { keyword: 'general', source: 'c.com', snippet: 'test', severity: 'LOW', detected_at: '' },
    ];

    const report = generateReport(AVOICE_CONFIG, signals);
    expect(report.max_severity).toBe('HIGH');
    expect(report.summary).toContain('HIGH');
    expect(report.summary).toContain('MEDIUM');
  });

  it('formats report text with structure', () => {
    const report = generateReport(AVOICE_CONFIG, []);
    const text = formatReportText(report);

    expect(text).toContain('=== Competitive Intelligence Report: Avoice ===');
    expect(text).toContain('Threat Level: LOW');
    expect(text).toContain('Baseline:');
    expect(text).toContain('--- Summary ---');
    expect(text).toContain('--- Recommended Actions ---');
  });
});

// ---------------------------------------------------------------------------
// Alert Logic Tests
// ---------------------------------------------------------------------------

describe('alert-escalation', () => {
  it('alerts on CRITICAL severity', () => {
    expect(shouldAlert('CRITICAL')).toBe(true);
  });

  it('alerts on HIGH severity', () => {
    expect(shouldAlert('HIGH')).toBe(true);
  });

  it('does not alert on MEDIUM severity', () => {
    expect(shouldAlert('MEDIUM')).toBe(false);
  });

  it('does not alert on LOW severity', () => {
    expect(shouldAlert('LOW')).toBe(false);
  });

  it('formats alert message for urgent signals', () => {
    const signals: CompetitorSignal[] = [
      {
        keyword: 'plan review',
        source: 'techcrunch.com',
        snippet: 'Avoice launches plan review for government',
        severity: 'CRITICAL',
        detected_at: '',
      },
    ];

    const report = generateReport(AVOICE_CONFIG, signals);
    const alert = formatAlertMessage(report);

    expect(alert).toContain('Competitive Intel Alert: Avoice');
    expect(alert).toContain('CRITICAL');
    expect(alert).toContain('plan review');
  });
});

// ---------------------------------------------------------------------------
// Persistence Tests
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('logs and retrieves an intel check', () => {
    const check = logIntelCheck({
      competitor: 'Avoice',
      check_type: 'quarterly',
      signals: [],
      max_severity: 'LOW',
      report: 'No signals found',
      alert_sent: false,
    });

    expect(check.id).toBeTruthy();
    expect(check.competitor).toBe('Avoice');
    expect(check.signal_count).toBe(0);
    expect(check.alert_sent).toBe(false);

    const retrieved = getIntelCheckById(check.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.competitor).toBe('Avoice');
  });

  it('retrieves latest check for a competitor', () => {
    logIntelCheck({
      competitor: 'Avoice',
      check_type: 'quarterly',
      signals: [],
      max_severity: 'LOW',
      report: 'First check',
      alert_sent: false,
    });

    const second = logIntelCheck({
      competitor: 'Avoice',
      check_type: 'manual',
      signals: [{ keyword: 'test', source: 'a', snippet: 'b', severity: 'MEDIUM', detected_at: '' }],
      max_severity: 'MEDIUM',
      report: 'Second check',
      alert_sent: false,
    });

    const latest = getLatestIntelCheck('Avoice');
    expect(latest).not.toBeNull();
    expect(latest!.id).toBe(second.id);
    expect(latest!.signal_count).toBe(1);
  });

  it('lists checks with limit', () => {
    for (let i = 0; i < 5; i++) {
      logIntelCheck({
        competitor: 'Avoice',
        check_type: 'quarterly',
        signals: [],
        max_severity: 'LOW',
        report: `Check ${i}`,
        alert_sent: false,
      });
    }

    const checks = getIntelChecks('Avoice', 3);
    expect(checks.length).toBe(3);
  });

  it('computes aggregate stats', () => {
    logIntelCheck({
      competitor: 'Avoice',
      check_type: 'quarterly',
      signals: [{ keyword: 'gov', source: 'a', snippet: 'b', severity: 'HIGH', detected_at: '' }],
      max_severity: 'HIGH',
      report: 'Alert check',
      alert_sent: true,
    });

    logIntelCheck({
      competitor: 'Avoice',
      check_type: 'quarterly',
      signals: [],
      max_severity: 'LOW',
      report: 'Quiet check',
      alert_sent: false,
    });

    const stats = getIntelStats();
    expect(stats.total_checks).toBe(2);
    expect(stats.checks_with_signals).toBe(1);
    expect(stats.alerts_sent).toBe(1);
    expect(stats.latest_check).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Run Check (End-to-End) Tests
// ---------------------------------------------------------------------------

describe('runAvoiceCheck', () => {
  it('runs a check with no signals', () => {
    const searchResults = [
      {
        query: 'Avoice government',
        snippets: [
          { source: 'example.com', text: 'Avoice is an AI workspace for architecture firms' },
        ],
      },
    ];

    const { check, report, alertMessage } = runAvoiceCheck(searchResults, 'quarterly');

    expect(check.competitor).toBe('Avoice');
    expect(check.signal_count).toBe(0);
    expect(check.max_severity).toBe('LOW');
    expect(check.alert_sent).toBe(false);
    expect(report.max_severity).toBe('LOW');
    expect(alertMessage).toBeNull();
  });

  it('runs a check with CRITICAL signals and generates alert', () => {
    const searchResults = [
      {
        query: 'Avoice plan review',
        snippets: [
          {
            source: 'techcrunch.com',
            text: 'Avoice announces the launch of their new plan review automation platform for city building departments',
          },
        ],
      },
    ];

    const { check, report, alertMessage } = runAvoiceCheck(searchResults, 'triggered');

    expect(check.signal_count).toBeGreaterThan(0);
    expect(check.max_severity).toBe('CRITICAL');
    expect(check.alert_sent).toBe(true);
    expect(report.recommended_actions).toContain('Escalate to leadership immediately');
    expect(alertMessage).not.toBeNull();
    expect(alertMessage).toContain('CRITICAL');
  });

  it('persists check to database', () => {
    const searchResults = [
      {
        query: 'Avoice government',
        snippets: [
          { source: 'example.com', text: 'No relevant content' },
        ],
      },
    ];

    runAvoiceCheck(searchResults);

    const latest = getLatestIntelCheck('Avoice');
    expect(latest).not.toBeNull();
    expect(latest!.competitor).toBe('Avoice');
  });
});

// ---------------------------------------------------------------------------
// IPC Handler Tests
// ---------------------------------------------------------------------------

describe('ipc-handler', () => {
  it('handles check action with search results', async () => {
    const result = await handleCompetitiveIntelIpc({
      type: 'competitive_intel_check',
      action: 'check',
      search_results: [
        {
          query: 'Avoice government',
          snippets: [
            { source: 'example.com', text: 'Avoice focuses on architecture firms' },
          ],
        },
      ],
      check_type: 'manual',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    expect(result.check_id).toBeTruthy();
    expect(result.signal_count).toBe(0);
    expect(result.max_severity).toBe('LOW');
    expect(result.alert_sent).toBe(false);
  });

  it('handles check action missing search_results', async () => {
    const result = await handleCompetitiveIntelIpc({
      type: 'competitive_intel_check',
      action: 'check',
    });

    expect(result.error).toContain('search_results');
  });

  it('handles status action', async () => {
    const result = await handleCompetitiveIntelIpc({
      type: 'competitive_intel_check',
      action: 'status',
    });

    expect(result.error).toBeUndefined();
    expect(result.competitor).toBe('Avoice');
    expect(result.next_review).toBe('2026-06-27');
    expect(result.is_review_due).toBeDefined();
    expect(result.stats).toBeDefined();
  });

  it('handles history action', async () => {
    // Create a check first
    await handleCompetitiveIntelIpc({
      type: 'competitive_intel_check',
      action: 'check',
      search_results: [{ query: 'test', snippets: [] }],
    });

    const result = await handleCompetitiveIntelIpc({
      type: 'competitive_intel_check',
      action: 'history',
      limit: 5,
    });

    expect(result.error).toBeUndefined();
    const checks = result.checks as unknown[];
    expect(checks.length).toBe(1);
  });

  it('handles config action', async () => {
    const result = await handleCompetitiveIntelIpc({
      type: 'competitive_intel_check',
      action: 'config',
    });

    expect(result.error).toBeUndefined();
    expect(result.competitor).toBe('Avoice');
    expect(result.search_queries).toBeDefined();
    expect(result.trigger_keywords).toBeDefined();
  });

  it('returns error for unknown action', async () => {
    const result = await handleCompetitiveIntelIpc({
      type: 'competitive_intel_check',
      action: 'nonexistent',
    });

    expect(result.error).toContain('Unknown competitive_intel_check action');
  });
});
