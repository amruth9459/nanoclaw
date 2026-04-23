/**
 * Competitive Intelligence Monitoring — Type definitions.
 *
 * Tracks competitor signals via web search, classifies severity,
 * and generates quarterly reports with WhatsApp alerts.
 */

// ---------------------------------------------------------------------------
// Signal Severity
// ---------------------------------------------------------------------------

export type SignalSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

// ---------------------------------------------------------------------------
// Competitor Signal
// ---------------------------------------------------------------------------

export interface CompetitorSignal {
  keyword: string;
  source: string;
  snippet: string;
  severity: SignalSeverity;
  detected_at: string;
}

// ---------------------------------------------------------------------------
// Intel Check (DB row)
// ---------------------------------------------------------------------------

export interface IntelCheck {
  id: string;
  competitor: string;
  check_type: 'quarterly' | 'manual' | 'triggered';
  signals_found: CompetitorSignal[];
  signal_count: number;
  max_severity: SignalSeverity;
  report: string;
  alert_sent: boolean;
  checked_at: string;
}

export interface IntelCheckRow {
  id: string;
  competitor: string;
  check_type: string;
  signals_found: string; // JSON
  signal_count: number;
  max_severity: string;
  report: string;
  alert_sent: number; // SQLite boolean
  checked_at: string;
}

// ---------------------------------------------------------------------------
// Monitor Config
// ---------------------------------------------------------------------------

export interface CompetitorConfig {
  name: string;
  search_queries: string[];
  trigger_keywords: string[];
  baseline_status: string;
  next_review: string;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface IntelReport {
  competitor: string;
  check_date: string;
  baseline_status: string;
  signals: CompetitorSignal[];
  max_severity: SignalSeverity;
  summary: string;
  recommended_actions: string[];
}
