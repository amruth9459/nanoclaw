import fs from 'fs';
import path from 'path';

import { MEDIA_DIR, MEDIA_RETENTION_DAYS } from './config.js';
import { logger } from './logger.js';

/**
 * Clean up media files older than the retention period.
 * Called periodically by the task scheduler.
 */
export function cleanupOldMedia(): void {
  try {
    if (!fs.existsSync(MEDIA_DIR)) {
      logger.debug('Media directory does not exist, skipping cleanup');
      return;
    }

    const now = Date.now();
    const retentionMs = MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const cutoffTime = now - retentionMs;

    const files = fs.readdirSync(MEDIA_DIR);
    let deletedCount = 0;
    let freedBytes = 0;

    for (const file of files) {
      const filePath = path.join(MEDIA_DIR, file);

      try {
        const stats = fs.statSync(filePath);

        // Skip directories
        if (stats.isDirectory()) continue;

        // Delete files older than retention period
        if (stats.mtimeMs < cutoffTime) {
          const fileSize = stats.size;
          fs.unlinkSync(filePath);
          deletedCount++;
          freedBytes += fileSize;
          logger.debug({ file, age: Math.floor((now - stats.mtimeMs) / 86400000) + ' days' }, 'Deleted old media file');
        }
      } catch (err) {
        logger.warn({ file, err }, 'Failed to process media file during cleanup');
      }
    }

    if (deletedCount > 0) {
      logger.info({
        deletedCount,
        freedMB: (freedBytes / 1024 / 1024).toFixed(2),
        retentionDays: MEDIA_RETENTION_DAYS
      }, 'Media cleanup completed');
    } else {
      logger.debug({ retentionDays: MEDIA_RETENTION_DAYS }, 'No old media files to clean up');
    }
  } catch (err) {
    logger.error({ err }, 'Media cleanup failed');
  }
}
