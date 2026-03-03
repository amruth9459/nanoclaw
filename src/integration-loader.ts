/**
 * Integration Loader
 *
 * Discovers and loads integrations from dist/integrations/{name}/index.js.
 * Each integration must default-export a NanoClawIntegration object.
 */
import fs from 'fs';
import path from 'path';

import type { NanoClawIntegration } from './integration-types.js';
import { logger } from './logger.js';

const integrations = new Map<string, NanoClawIntegration>();

/**
 * Scan dist/integrations/ for integration modules and load them.
 * Each subdirectory should contain an index.js that default-exports
 * a NanoClawIntegration object.
 */
export async function loadIntegrations(): Promise<void> {
  const integrationsDir = path.join(process.cwd(), 'dist', 'integrations');

  if (!fs.existsSync(integrationsDir)) {
    logger.info('No integrations directory found — running without integrations');
    return;
  }

  let dirs: string[];
  try {
    dirs = fs.readdirSync(integrationsDir).filter((f) => {
      const stat = fs.statSync(path.join(integrationsDir, f));
      return stat.isDirectory();
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to read integrations directory');
    return;
  }

  for (const dir of dirs) {
    const indexPath = path.join(integrationsDir, dir, 'index.js');
    if (!fs.existsSync(indexPath)) {
      logger.debug({ dir }, 'Skipping integration directory — no index.js');
      continue;
    }

    try {
      const mod = await import(indexPath);
      const integration: NanoClawIntegration = mod.default;

      if (!integration || !integration.name || typeof integration.initDatabase !== 'function') {
        logger.warn({ dir }, 'Invalid integration module — missing name or initDatabase');
        continue;
      }

      integrations.set(integration.name, integration);
      logger.info({ name: integration.name, dir }, 'Integration loaded');
    } catch (err) {
      logger.error({ err, dir }, 'Failed to load integration');
    }
  }

  logger.info(
    { count: integrations.size, names: Array.from(integrations.keys()) },
    'Integrations loaded',
  );
}

/** Get all loaded integrations */
export function getIntegrations(): NanoClawIntegration[] {
  return Array.from(integrations.values());
}

/** Get a specific integration by name */
export function getIntegration(name: string): NanoClawIntegration | undefined {
  return integrations.get(name);
}
