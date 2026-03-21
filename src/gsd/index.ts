/**
 * GSD (Get Shit Done) — Main exports
 *
 * Spec-driven development system for autonomous agents.
 * Keeps agents on-task through context preservation, drift detection,
 * and auto-checkpointing.
 */

// Types
export type {
  Spec,
  SpecFrontmatter,
  SpecPhase,
  SpecChecklistItem,
  SpecProgress,
  Checkpoint,
  DriftAlert,
  DriftSeverity,
  AgentRole,
  MetaPromptOptions,
  GsdAction,
  GsdToolInput,
} from './types.js';

// Database
export { initGsdSchema } from './db.js';

// Spec management
export {
  initSpec,
  loadSpec,
  completeItem,
  completeSpec,
  syncSpecToFile,
  getActiveSpecs,
  parseSpecFile,
  serializeSpec,
  validateFrontmatter,
  generateSpecId,
} from './spec-manager.js';

// Context preservation
export {
  generateSpecReminder,
  generateSpecReminderByProject,
  generateCompactStatus,
  getRelevantSection,
} from './context-keeper.js';

// Checkpointing
export {
  checkpoint,
  calculateProgress,
  shouldCheckpoint,
  getLastCheckpoint,
  getCheckpointHistory,
  formatCheckpoint,
} from './checkpoint.js';

// Drift detection
export {
  detectDrift,
  validateTask,
  getRecentDrift,
} from './drift-detector.js';

// Meta-prompting
export {
  generateMetaPrompt,
  generateAntiDriftReminder,
} from './meta-prompter.js';
