/**
 * Competitive Intelligence Monitoring — Public API.
 *
 * Automated quarterly check-ins for competitor tracking:
 * web search for signals, classify severity, generate reports,
 * WhatsApp alerts for CRITICAL/HIGH threats.
 */

// Types
export type {
  SignalSeverity,
  CompetitorSignal,
  IntelCheck,
  IntelCheckRow,
  CompetitorConfig,
  IntelReport,
} from './types.js';

// Persistence
export { initCompetitiveIntelSchema } from './persistence.js';
export {
  logIntelCheck,
  getIntelChecks,
  getLatestIntelCheck,
  getIntelCheckById,
  getIntelStats,
} from './persistence.js';

// Avoice Monitor
export {
  AVOICE_CONFIG,
  classifySignalSeverity,
  detectSignals,
  getMaxSeverity,
  generateReport,
  formatReportText,
  shouldAlert,
  formatAlertMessage,
  runAvoiceCheck,
  isQuarterlyReviewDue,
  getPreviousCheck,
} from './avoice-monitor.js';

// IPC Handler
export {
  handleCompetitiveIntelIpc,
  COMPETITIVE_INTEL_IPC_TYPE,
  type CompetitiveIntelIpcMessage,
} from './ipc-handler.js';
