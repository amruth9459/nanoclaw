/**
 * Security Configuration for NanoClaw
 * Centralized security policies and controls
 */

import { readEnvFile } from './env.js';

// Read security-related env vars from .env file (they aren't in process.env
// because readEnvFile intentionally doesn't pollute process.env).
const secEnv = readEnvFile([
  'NANOCLAW_REMOTE_SHELL_ENABLED',
  'NANOCLAW_REMOTE_SHELL_WHITELIST_ONLY',
  'NANOCLAW_REMOTE_SHELL_REQUIRE_APPROVAL',
  'NANOCLAW_REMOTE_SHELL_RATE_LIMIT',
  'NANOCLAW_SECURITY_ALERTS',
  'NANOCLAW_PARANOID_MODE',
]);

function secVal(key: string): string {
  return process.env[key] || secEnv[key] || '';
}

/**
 * Environment-based security toggle
 * Set NANOCLAW_REMOTE_SHELL_ENABLED=1 to enable remote shell
 * Disabled by default — must be explicitly opted in
 */
export const REMOTE_SHELL_ENABLED = secVal('NANOCLAW_REMOTE_SHELL_ENABLED') === '1';

/**
 * Command whitelist mode
 * When true, only preset commands are allowed (no custom commands)
 * Set NANOCLAW_REMOTE_SHELL_WHITELIST_ONLY=1 for maximum security
 */
export const REMOTE_SHELL_WHITELIST_ONLY = secVal('NANOCLAW_REMOTE_SHELL_WHITELIST_ONLY') === '1';

/**
 * Require approval for remote shell commands
 * When true, all remote shell commands go through HITL approval
 * Set NANOCLAW_REMOTE_SHELL_REQUIRE_APPROVAL=1 for extra safety
 */
export const REMOTE_SHELL_REQUIRE_APPROVAL = secVal('NANOCLAW_REMOTE_SHELL_REQUIRE_APPROVAL') === '1';

/**
 * Maximum commands per minute (rate limit)
 * Set NANOCLAW_REMOTE_SHELL_RATE_LIMIT=5 to tighten
 */
export const REMOTE_SHELL_RATE_LIMIT =
  parseInt(secVal('NANOCLAW_REMOTE_SHELL_RATE_LIMIT') || '10', 10);

/**
 * Alert on suspicious patterns
 * Set NANOCLAW_SECURITY_ALERTS=1 to enable WhatsApp security alerts
 */
export const SECURITY_ALERTS_ENABLED = secVal('NANOCLAW_SECURITY_ALERTS') === '1';

/**
 * Allowed working directories (whitelist)
 * Commands can only run in these directories
 */
export const ALLOWED_WORKING_DIRS = [
  process.cwd(), // Project root
  '/tmp',
  '/var/tmp',
];

/**
 * IP whitelist for DashClaw (in addition to localhost + Tailscale)
 * Add trusted IPs here if needed
 */
export const DASHCLAW_ALLOWED_IPS: string[] =
  process.env.NANOCLAW_DASHCLAW_ALLOWED_IPS
    ? process.env.NANOCLAW_DASHCLAW_ALLOWED_IPS.split(',')
    : [];

/**
 * Maximum file size for media uploads (bytes)
 * Default: 10MB
 */
export const MAX_MEDIA_UPLOAD_SIZE =
  parseInt(process.env.NANOCLAW_MAX_MEDIA_SIZE || '10485760', 10);

/**
 * Session timeout for inactive groups (milliseconds)
 * Default: 1 hour
 */
export const SESSION_TIMEOUT =
  parseInt(process.env.NANOCLAW_SESSION_TIMEOUT || '3600000', 10);

/**
 * Enable paranoid mode (strictest security)
 * - Whitelist-only commands
 * - Require approval for all remote shell
 * - Lower rate limits
 * - Extra logging
 */
export const PARANOID_MODE = secVal('NANOCLAW_PARANOID_MODE') === '1';

if (PARANOID_MODE) {
  console.warn('⚠️  PARANOID MODE ENABLED - Strict security policies active');
}

/**
 * Security policy summary for logging
 */
export function getSecuritySummary(): string {
  return `
Security Configuration:
- Remote Shell: ${REMOTE_SHELL_ENABLED ? 'ENABLED' : 'DISABLED'}
- Whitelist Only: ${REMOTE_SHELL_WHITELIST_ONLY || PARANOID_MODE ? 'YES' : 'NO'}
- Require Approval: ${REMOTE_SHELL_REQUIRE_APPROVAL || PARANOID_MODE ? 'YES' : 'NO'}
- Rate Limit: ${PARANOID_MODE ? Math.floor(REMOTE_SHELL_RATE_LIMIT / 2) : REMOTE_SHELL_RATE_LIMIT} commands/min
- Security Alerts: ${SECURITY_ALERTS_ENABLED ? 'ENABLED' : 'DISABLED'}
- Paranoid Mode: ${PARANOID_MODE ? 'ENABLED ⚠️' : 'DISABLED'}
  `.trim();
}
