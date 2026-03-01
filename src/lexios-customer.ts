/**
 * Lexios Customer Management
 *
 * Handles both:
 * - 1:1 DMs: auto-creates Lexios customer groups when a DM arrives on the Lexios WhatsApp channel
 * - Group JIDs (@g.us): auto-registers WhatsApp groups as Lexios buildings (per-building model)
 *
 * Lexios groups get:
 * - Persistent registration (not ephemeral like guest groups)
 * - Product-focused agent template (groups/lexios-template/CLAUDE.md)
 * - Longer container timeout for PDF/DWG analysis
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getChatName, registerLexiosBuilding, registerLexiosCustomer, setRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/**
 * Get or create a Lexios customer group for a 1:1 DM chat JID.
 * Unlike guest groups, Lexios groups are persisted to DB and survive restarts.
 */
export function getOrCreateLexiosCustomer(
  chatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
  registerGroupFn: (jid: string, group: RegisteredGroup) => void,
): RegisteredGroup {
  // Already registered
  if (registeredGroups[chatJid]) return registeredGroups[chatJid];

  const jidPrefix = chatJid.split('@')[0];
  const folder = `lexios-${jidPrefix}`;
  const chatName = getChatName(chatJid) || jidPrefix;

  const group: RegisteredGroup = {
    name: `Lexios: ${chatName}`,
    folder,
    trigger: '', // No trigger needed — every DM is processed
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    containerConfig: {
      timeout: 600000, // 10 min for large PDF analysis
    },
  };

  // Persist via the normal group registration path
  registerGroupFn(chatJid, group);

  // Create group directory and copy Lexios template
  setupLexiosGroupDir(folder);

  // Register in lexios_customers table
  registerLexiosCustomer(chatJid, jidPrefix, chatName);

  logger.info({ chatJid, folder, name: chatName }, 'Lexios customer registered');
  return group;
}

/**
 * Get or create a Lexios building group for a WhatsApp group JID (@g.us).
 * Per-building model: a GC creates a project, uploads blueprints, workers query Lexios.
 */
export function getOrCreateLexiosBuilding(
  chatJid: string,
  senderPhone: string,
  registeredGroups: Record<string, RegisteredGroup>,
  registerGroupFn: (jid: string, group: RegisteredGroup) => void,
): RegisteredGroup {
  // Already registered
  if (registeredGroups[chatJid]) return registeredGroups[chatJid];

  const jidPrefix = chatJid.split('@')[0];
  const folder = `lexios-${jidPrefix}`;
  const chatName = getChatName(chatJid) || 'Building';

  const group: RegisteredGroup = {
    name: `Lexios Building: ${chatName}`,
    folder,
    trigger: '@Lexios', // Groups require @Lexios trigger
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    containerConfig: {
      timeout: 600000, // 10 min for large PDF/DWG analysis
      env: { LEXIOS_BUILDING_JID: chatJid },
    },
  };

  // Persist via the normal group registration path
  registerGroupFn(chatJid, group);

  // Create group directory and copy Lexios template
  setupLexiosGroupDir(folder);

  // Register in lexios_buildings table (sender becomes owner)
  registerLexiosBuilding(chatJid, senderPhone, chatName);

  logger.info({ chatJid, folder, name: chatName, owner: senderPhone }, 'Lexios building registered');
  return group;
}

/** Create the group directory and copy the Lexios template CLAUDE.md */
function setupLexiosGroupDir(folder: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const templatePath = path.join(GROUPS_DIR, 'lexios-template', 'CLAUDE.md');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, claudeMdPath);
    } else {
      logger.warn('Lexios template CLAUDE.md not found at groups/lexios-template/CLAUDE.md');
    }
  }
}
