#!/usr/bin/env tsx
/**
 * Development file watcher - auto-restarts NanoClaw when dist/ changes
 *
 * Usage: npm run watch (runs in background)
 *
 * This eliminates manual `./deploy.sh --host` after code changes.
 */
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');

let restartTimer: NodeJS.Timeout | null = null;

console.log('👀 Watching dist/ for changes...');
console.log(`    Path: ${DIST_DIR}`);
console.log('    Auto-restart enabled');

fs.watch(DIST_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename || !filename.endsWith('.js')) return;

  console.log(`📝 Change detected: ${filename}`);

  // Debounce: wait 500ms for multiple file changes to settle
  if (restartTimer) clearTimeout(restartTimer);

  restartTimer = setTimeout(() => {
    console.log('🔄 Restarting NanoClaw...');

    exec('launchctl kickstart -k gui/$(id -u)/com.nanoclaw', (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Restart failed:', error.message);
        if (stderr) console.error(stderr);
        return;
      }
      console.log('✅ NanoClaw restarted successfully');
      if (stdout) console.log(stdout);
    });
  }, 500);
});

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n👋 File watcher stopped');
  process.exit(0);
});
