import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = parseInt(
  process.env.NANOCLAW_POLL_INTERVAL || '500',
  10,
); // 500ms for faster response (was 2000ms)
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const MEDIA_DIR = path.resolve(STORE_DIR, 'media');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '4', 10) || 4,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Performance optimizations
export const ENABLE_STREAMING =
  process.env.NANOCLAW_ENABLE_STREAMING !== '0'; // Default: enabled
export const MIN_CHUNK_SIZE = parseInt(
  process.env.NANOCLAW_MIN_CHUNK_SIZE || '200',
  10,
);
export const ENABLE_PROMPT_CACHING =
  process.env.NANOCLAW_ENABLE_PROMPT_CACHING !== '0'; // Default: enabled
export const CACHE_MIN_TOKENS = parseInt(
  process.env.NANOCLAW_CACHE_MIN_TOKENS || '1024',
  10,
);
export const INSTANT_ACK =
  process.env.NANOCLAW_INSTANT_ACK === '1'; // Send "👀" on message receipt

// Pre-warm containers for registered groups on startup so the first user
// message hits a running container instead of a cold start.
export const WARMUP_ON_START =
  process.env.NANOCLAW_WARMUP_ON_START !== '0'; // Default: enabled

// When enabled, respond to @-mentions from any WhatsApp chat, not just
// registered groups. Each new chat gets an isolated guest agent.
export const OPEN_MENTIONS =
  process.env.NANOCLAW_OPEN_MENTIONS === '1'; // Default: disabled

// When enabled, connect a second WhatsApp account (auth stored in store/auth2/).
// Authenticate it first with: npm run auth -- --slot 2
export const WA2_ENABLED =
  process.env.NANOCLAW_WA2 === '1'; // Default: disabled

// Dashboard authentication token. Required for all API routes when accessing
// via Cloudflare tunnel (remote). Set in .env: NANOCLAW_DASH_TOKEN=<random hex>
// Access dashboard at: https://<tunnel>.trycloudflare.com/?token=<token>
export const DASH_TOKEN =
  process.env.NANOCLAW_DASH_TOKEN || '';

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Media settings
export const MAX_MEDIA_SIZE_MB = parseInt(
  process.env.NANOCLAW_MAX_MEDIA_SIZE_MB || '50',
  10,
); // 50MB default
export const MEDIA_RETENTION_DAYS = parseInt(
  process.env.NANOCLAW_MEDIA_RETENTION_DAYS || '30',
  10,
); // 30 days default

// Notification routing — topic-specific WhatsApp groups
export const DESKTOP_NOTIFY_JID = process.env.NANOCLAW_DESKTOP_NOTIFY_JID || '120363408175994341@g.us';

// Freelance agent — Ishita's dedicated WhatsApp group JID
export const FREELANCE_AGENT_JID = process.env.NANOCLAW_FREELANCE_AGENT_JID || '';
