/**
 * NanoClaw Integration Interface
 *
 * Defines the contract for integrations to plug into NanoClaw's core
 * without the core knowing about their domain specifics.
 */
import type Database from 'better-sqlite3';
import type http from 'http';
import type { RegisteredGroup, NewMessage, Channel, OnInboundMessage, OnChatMetadata } from './types.js';
import type { GroupQueue } from './group-queue.js';
import type { RoutingRule } from './router/types.js';

export interface IntegrationContext {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  channels: Channel[];
  queue: GroupQueue;
  sendMessage: (jid: string, text: string, senderName?: string) => Promise<void>;
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
  /** Environment variable that gates this channel (e.g. 'NANOCLAW_WA3_MYAPP') */
  enabledEnvVar: string;
}

export interface IpcHandlerContext {
  sendMessage: (jid: string, text: string, senderName?: string) => Promise<void>;
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

  /**
   * Handle a scheduled task host-side (no container/LLM needed).
   * Return a result string if handled, or undefined to fall through to container execution.
   */
  handleScheduledTask?(taskId: string, chatJid: string, sendMessage: (jid: string, text: string, senderName?: string) => Promise<void>, sendMessageGetId: (jid: string, text: string, senderName?: string) => Promise<string | undefined>): Promise<string | undefined>;

  /** Set of IPC message type strings this integration handles */
  ipcMessageTypes?: Set<string>;

  /** Handle an IPC message from a container */
  handleIpcMessage?(
    data: Record<string, unknown>,
    groupFolder: string,
    ctx: IpcHandlerContext,
  ): Promise<void>;

  /** Handle a WhatsApp reaction on a message */
  handleReaction?(chatJid: string, reactedMessageId: string, senderJid: string, emoji: string): Promise<void>;

  /** Handle a quote-reply to a message. Return true if handled (prevents normal processing). */
  handleQuoteReply?(chatJid: string, quotedMessageId: string, message: NewMessage): Promise<boolean>;

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
  getContainerMounts?(isMain: boolean, homeDir: string, groupFolder?: string): VolumeMount[];

  /** Check if an inbound message is an approval/rejection for this integration's gates */
  tryHandleApproval?(message: string, notifyFn: (text: string) => Promise<void>): Promise<boolean>;

  /** Dashboard tabs to inject */
  dashboardTabs?: DashboardTab[];

  /** Dashboard JavaScript to inject into the HTML page */
  dashboardScript?: string;

  /** API routes to inject into the dashboard server */
  apiRoutes?: Map<string, ApiRouteHandler>;

  /** Extra WhatsApp (Baileys) channels to create */
  channels?: ChannelConfig[];

  /** Create non-Baileys channel instances. Called with shared channel callbacks. */
  createChannels?(channelOpts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  }): Channel[];

  /** Determine the purpose string for usage tracking */
  determinePurpose?(groupFolder: string): string | undefined;

  /** Determine the designation for container/orchestrator tracking */
  determineDesignation?(groupFolder: string): string | undefined;

  /** Determine the orchestrator type for a group */
  determineOrchestratorType?(groupFolder: string): string | undefined;

  /** Determine the project for kanban task tagging */
  determineProject?(groupFolder: string): string | undefined;

  // ── Decoupling hooks ────────────────────────────────────────────

  /** Topic name → JID for notification routing (e.g. { myapp: '120363...@g.us' }) */
  notifyTopics?: Record<string, string>;

  /** Emoji ACK keyword rules to append to the core emoji list */
  emojiRules?: Array<{ pattern: RegExp; emojis: string[] }>;

  /** Routing rules to inject into the routing engine */
  routingRules?: RoutingRule[];

  /** Groups to auto-register at startup */
  autoRegisterGroups?(): Array<{
    jid: string;
    name: string;
    folder: string;
    trigger: string;
    requiresTrigger: boolean;
    displayName?: string;
    containerConfig?: import('./types.js').ContainerConfig;
  }>;

  /** Contribute to the main group kanban context summary */
  getKanbanSummary?(kanbanContent: string): string | undefined;

  /** Context injection for integration-owned groups */
  enrichPromptContext?(groupFolder: string, groupsDir: string): string | undefined;

  /** IPC desktop_claude authorization + config for integration-owned groups */
  getDesktopClaudeConfig?(groupFolder: string): {
    workdir: string;
    allowedRoots: string[];
    notifyTopic: string;
  } | undefined;

  /** Claim a userId for task source routing (e.g. integration customers) */
  claimsUserId?(userId: string): { source: string; agentType: string } | undefined;

  /** Scripts to bind-mount into /usr/local/bin/ for groups owned by this integration */
  getContainerScripts?(): Array<{ hostPath: string; containerName: string }>;

  /** Skill directory names (under container/skills/) owned by this integration */
  getSkillDirs?(): string[];

  /** Absolute path to the learnings file for this integration (used by the learn IPC handler) */
  getLearningsPath?(): string;

  /** Container-side MCP tool module to load (e.g. 'my-tools' → import('./my-tools.js')) */
  getContainerToolModule?(): string;
}
