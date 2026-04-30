import fs from 'fs';
import pino from 'pino';
import path from 'path';

const LOGS_DIR = path.join(process.cwd(), 'logs');
// pino-roll uses this as the base: creates nanoclaw.1.log, nanoclaw.2.log, ...
// and maintains current.log -> nanoclaw.1.log symlink automatically.
// We create nanoclaw.log -> current.log at startup so `tail -f nanoclaw.log` always works.
const LOG_BASE = path.join(LOGS_DIR, 'nanoclaw.log');
const IS_TTY = Boolean(process.stdout.isTTY);

// Ensure logs dir exists
fs.mkdirSync(LOGS_DIR, { recursive: true });

// Create nanoclaw.log -> current.log convenience symlink (if not already a symlink)
const NAMED_LINK = LOG_BASE;
try {
  const stat = fs.existsSync(NAMED_LINK) ? fs.lstatSync(NAMED_LINK) : null;
  if (stat && !stat.isSymbolicLink()) {
    // Plain file from old plist stdout redirect — move it out of the way
    fs.renameSync(NAMED_LINK, path.join(LOGS_DIR, `nanoclaw.log.bak.${Date.now()}`));
  }
  if (!fs.existsSync(NAMED_LINK)) {
    fs.symlinkSync('current.log', NAMED_LINK);
  }
} catch {
  // Non-fatal
}

const targets: pino.TransportTargetOptions[] = [
  {
    target: 'pino-roll',
    options: {
      file: LOG_BASE,       // base path; pino-roll creates nanoclaw.1.log, etc.
      frequency: 'daily',   // rotate daily
      mkdir: true,
      size: '100m',         // also rotate if log exceeds 100MB
      symlink: true,        // pino-roll maintains current.log -> nanoclaw.N.log
      limit: { count: 7 },  // keep 7 rotated files
    },
    level: process.env.LOG_LEVEL || 'info',
  },
];

if (IS_TTY) {
  targets.push({
    target: 'pino-pretty',
    options: { colorize: true },
    level: process.env.LOG_LEVEL || 'info',
  });
}

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.transport({ targets }),
);

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  // EPIPE is non-fatal — just means a write target disconnected (e.g. container stdin).
  if (err.code === 'EPIPE') {
    logger.warn({ err }, 'EPIPE (non-fatal, write target disconnected)');
    return;
  }
  // EADDRINUSE is non-fatal — another instance holds the port, we'll retry
  if (err.code === 'EADDRINUSE') {
    logger.warn({ err }, 'EADDRINUSE (port in use, non-fatal)');
    return;
  }
  logger.fatal({ err }, 'Uncaught exception');
  // Don't exit immediately — let active agents finish via SIGTERM handler
  process.kill(process.pid, 'SIGTERM');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
