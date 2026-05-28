/**
 * Cloudflare Integration for NanoClaw
 *
 * Enables agents to deploy to Cloudflare (Pages, Workers, Tunnels), manage DNS,
 * and register domains. Container-side MCP tools (cloudflare_*) make most
 * Cloudflare API calls directly. Domain registration is HITL-gated through
 * the host because it costs money.
 *
 * Account creation is NOT possible via the Cloudflare API — the user must
 * sign up once at https://dash.cloudflare.com/sign-up. Afterwards, every
 * operation here is fully programmatic. cloudflare_whoami documents this.
 */
import type { NanoClawIntegration } from '../../integration-types.js';
import { CLOUDFLARE_IPC_TYPES, handleIpcMessage } from './ipc-handlers.js';
import { domainPurchaseGate } from './domain-purchase-gate.js';

const integration: NanoClawIntegration = {
  name: 'cloudflare',

  initDatabase(_db) {
    // No tables required — pending proposals live in memory (in the gate),
    // and audit log is file-based under data/audit/cloudflare-domains/.
  },

  ipcMessageTypes: CLOUDFLARE_IPC_TYPES,

  async handleIpcMessage(data, groupFolder, ctx) {
    await handleIpcMessage(data, groupFolder, ctx);
  },

  async tryHandleApproval(message, notifyFn) {
    return domainPurchaseGate.tryHandleApproval(message, notifyFn);
  },

  /** Container-side MCP tool module — loaded for main group + any owned groups. */
  getContainerToolModule(): string {
    return 'cloudflare-tools';
  },
};

export default integration;
