/**
 * NanoClaw Integration Interface
 *
 * Defines the contract for integrations (e.g., Lexios) to plug into
 * NanoClaw's core without the core knowing about their domain specifics.
 */
import type Database from 'better-sqlite3';
import type http from 'http';
import type { RegisteredGroup, NewMessage, Channel } from './types.js';
import type { GroupQueue } from './group-queue.js';

export interface IntegrationContext {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  channels: Channel[];
  queue: GroupQueue;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export interface ValidationResult {
  safe: boolean;
  reason?: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface DashboardTab {
  id: string;
  label: string;
  /** JS function name to call when this tab is selected (must be defined in dashboardScript) */
  refreshFn: string;
}

export interface ApiRouteHandler {
  method: 'GET' | 'POST';
  handler: (
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>;
}

export interface ChannelConfig {
  name: string;
  authDir: string;
  /** Environment variable that gates this channel (e.g. 'NANOCLAW_WA3_LEXIOS') */
  enabledEnvVar: string;
}

export interface IpcHandlerContext {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export interface NanoClawIntegration {
  name: string;

  /** Create tables and run migrations on the main DB */
  initDatabase(db: Database.Database): void;

  /** Called after channels connect and state is loaded */
  onStartup?(ctx: IntegrationContext): Promise<void>;

  /** Returns true if this integration owns the given group folder */
  ownsGroup?(folder: string): boolean;

  /** Set of IPC message type strings this integration handles */
  ipcMessageTypes?: Set<string>;

  /** Handle an IPC message from a container */
  handleIpcMessage?(
    data: Record<string, unknown>,
    groupFolder: string,
    ctx: IpcHandlerContext,
  ): Promise<void>;

  /**
   * Called each message loop tick. Returns JIDs to enqueue for processing.
   * Used for auto-registration of customers/groups from new messages.
   */
  onMessageLoopTick?(
    lastTimestamp: string,
    registeredJids: string[],
    ctx: IntegrationContext,
  ): Promise<string[]>;

  /** Security gate — validate user input before processing */
  validateMessage?(text: string): ValidationResult;

  /** Extra container mounts for groups owned by this integration */
  getContainerMounts?(isMain: boolean, homeDir: string): VolumeMount[];

  /** Dashboard tabs to inject */
  dashboardTabs?: DashboardTab[];

  /** Dashboard JavaScript to inject into the HTML page */
  dashboardScript?: string;

  /** API routes to inject into the dashboard server */
  apiRoutes?: Map<string, ApiRouteHandler>;

  /** Extra WhatsApp channels to create */
  channels?: ChannelConfig[];

  /** Determine the purpose string for usage tracking */
  determinePurpose?(groupFolder: string): string | undefined;

  /** Determine the designation for container/orchestrator tracking */
  determineDesignation?(groupFolder: string): string | undefined;

  /** Determine the orchestrator type for a group */
  determineOrchestratorType?(groupFolder: string): string | undefined;

  /** Determine the project for kanban task tagging */
  determineProject?(groupFolder: string): string | undefined;
}
