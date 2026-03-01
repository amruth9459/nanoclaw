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
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
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

// When enabled, connect a third WhatsApp account dedicated to Lexios (auth stored in store/auth3/).
// Authenticate it first with: npm run auth -- --slot 3
export const WA3_LEXIOS_ENABLED =
  process.env.NANOCLAW_WA3_LEXIOS === '1'; // Default: disabled

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Media settings
export const MAX_MEDIA_SIZE_MB = parseInt(
  process.env.NANOCLAW_MAX_MEDIA_SIZE_MB || '50',
  10,
); // 50MB default
export const LEXIOS_MAX_MEDIA_SIZE_MB = parseInt(
  process.env.NANOCLAW_LEXIOS_MAX_MEDIA_SIZE_MB || '100',
  10,
); // 100MB for large construction PDFs
export const MEDIA_RETENTION_DAYS = parseInt(
  process.env.NANOCLAW_MEDIA_RETENTION_DAYS || '30',
  10,
); // 30 days default

// Economics / ClawWork settings
export const INITIAL_BALANCE = parseFloat(process.env.NANOCLAW_INITIAL_BALANCE || '1000');
export const TOKEN_PRICE_INPUT = parseFloat(process.env.NANOCLAW_TOKEN_PRICE_INPUT || '3.0');
export const TOKEN_PRICE_OUTPUT = parseFloat(process.env.NANOCLAW_TOKEN_PRICE_OUTPUT || '15.0');
export const TOKEN_PRICE_CACHE_READ = parseFloat(process.env.NANOCLAW_TOKEN_PRICE_CACHE_READ || '0.30');
export const TOKEN_PRICE_CACHE_WRITE = parseFloat(process.env.NANOCLAW_TOKEN_PRICE_CACHE_WRITE || '3.75');
export const COST_FOOTER = process.env.NANOCLAW_COST_FOOTER !== '0'; // on by default

// Auto-task creation: automatically create ClawWork tasks for substantive @Claw messages
export const AUTO_CLAWWORK = process.env.NANOCLAW_AUTO_CLAWWORK !== '0'; // on by default

// Bounty hunting
export const PAYPAL_EMAIL = process.env.NANOCLAW_PAYPAL_EMAIL || '';
export const GITHUB_TOKEN = process.env.NANOCLAW_GITHUB_TOKEN || '';

// Earning goal: target amount in USD
// $5000 for Mac Studio + $250 already spent (Claude Max + extra usage) = $5250 total
export const EARNING_GOAL = parseFloat(process.env.NANOCLAW_EARNING_GOAL || '5250');

// How often the agent auto-hunts for opportunities (default: every 6 hours)
export const BOUNTY_HUNT_INTERVAL_MS = parseInt(
  process.env.NANOCLAW_BOUNTY_HUNT_INTERVAL_MS || String(6 * 60 * 60 * 1000),
  10,
);

// Claw's outreach identity — separate from the owner's personal accounts
// Set these in .env and plist. The agent uses them for cold outreach,
// Reddit posts, and any external-facing communication.
export const CLAW_NAME = process.env.CLAW_NAME || '';
export const CLAW_EMAIL = process.env.CLAW_EMAIL || '';
export const CLAW_EMAIL_APP_PASSWORD = process.env.CLAW_EMAIL_APP_PASSWORD || '';
export const CLAW_REDDIT_USER = process.env.CLAW_REDDIT_USER || '';
export const CLAW_REDDIT_PASS = process.env.CLAW_REDDIT_PASS || '';
export const CLAW_REDDIT_CLIENT_ID = process.env.CLAW_REDDIT_CLIENT_ID || '';
export const CLAW_REDDIT_CLIENT_SECRET = process.env.CLAW_REDDIT_CLIENT_SECRET || '';
