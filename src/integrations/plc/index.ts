/**
 * PLC Site Report — Integration module
 *
 * Automates daily crew reporting for PLC site managers.
 * Each site gets its own CHECK-IN message so reactions/replies map 1:1 to sites
 * without requiring JID-based manager identification.
 */
import type { NanoClawIntegration, IntegrationContext } from '../../integration-types.js';
import type { NewMessage } from '../../types.js';
import { initPlcSchema, getReportsByPrefillMessageId, getSiteByManagerJid, confirmReport } from './db.js';
import { PLC_IPC_TYPES, handlePlcIpc } from './ipc-handlers.js';
import { logger } from '../../logger.js';

const PLC_GROUP_JID = '120363404678903841@g.us';
const PLC_GROUP_FOLDER = 'plc-site-managers';

// Text replies that mean "same as yesterday"
const SAME_KEYWORDS = new Set(['same', 'ok', 'yes', 'no change', 'no changes', 'good', 'correct', '👍']);
// Text replies that mean "not on site"
const OFF_KEYWORDS = new Set(['off', 'no work', 'not on site', 'day off', 'no']);

// Thumbs up in all skin tones
const THUMBS_UP = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿']);

const integration: NanoClawIntegration = {
  name: 'plc',

  initDatabase(database) {
    initPlcSchema(database);
  },

  ownsGroup(folder: string): boolean {
    return folder === PLC_GROUP_FOLDER;
  },

  autoRegisterGroups() {
    return [{
      jid: PLC_GROUP_JID,
      name: 'plc-site-managers',
      folder: PLC_GROUP_FOLDER,
      trigger: '@PLC Site Report',
      requiresTrigger: true,
      displayName: 'PLC Site Report',
      containerConfig: { isolatedPersona: true },
    }];
  },

  ipcMessageTypes: PLC_IPC_TYPES,

  async handleIpcMessage(data, groupFolder, ctx) {
    await handlePlcIpc(data, groupFolder, ctx);
  },

  /**
   * Reaction handler — per-site messages mean each prefill_message_id maps to exactly one report.
   * No JID matching needed: reacting to Site X's message = confirming Site X.
   */
  async handleReaction(chatJid: string, reactedMessageId: string, _senderJid: string, emoji: string) {
    if (chatJid !== PLC_GROUP_JID) return;

    const report = getReportByPrefillMessageId(reactedMessageId);
    if (!report || report.status !== 'pending') return;

    if (THUMBS_UP.has(emoji) || emoji === '✅') {
      confirmReport(report.id, null, 'confirmed_same');
      logger.info({ siteId: report.site_id, emoji }, 'PLC report confirmed via reaction (same)');
    } else if (emoji === '❌') {
      confirmReport(report.id, null, 'off');
      logger.info({ siteId: report.site_id, emoji }, 'PLC report confirmed via reaction (off)');
    }
  },

  /**
   * Quote-reply handler — the quoted message identifies the site (per-site messages).
   * Any reply to that message updates that site's report.
   */
  async handleQuoteReply(chatJid: string, quotedMessageId: string, message: NewMessage): Promise<boolean> {
    if (chatJid !== PLC_GROUP_JID) return false;

    const report = getReportByPrefillMessageId(quotedMessageId);
    if (!report) return false;

    // Already confirmed — don't overwrite
    if (report.status !== 'pending') return true;

    const text = message.content.trim().toLowerCase();

    if (SAME_KEYWORDS.has(text)) {
      confirmReport(report.id, null, 'confirmed_same');
      logger.info({ siteId: report.site_id }, 'PLC report confirmed via reply (same)');
    } else if (OFF_KEYWORDS.has(text)) {
      confirmReport(report.id, null, 'off');
      logger.info({ siteId: report.site_id }, 'PLC report confirmed via reply (off)');
    } else {
      confirmReport(report.id, { raw_changes: message.content }, 'confirmed_changed');
      logger.info({ siteId: report.site_id, preview: message.content.slice(0, 100) }, 'PLC report confirmed via reply (changes)');
    }

    return true; // handled — skip normal agent processing
  },

  async onStartup(ctx: IntegrationContext) {
    await ensureScheduledTasks(ctx);
  },

  determinePurpose(groupFolder: string) {
    return groupFolder === PLC_GROUP_FOLDER ? 'plc-report' : undefined;
  },

  getSkillDirs() {
    return ['plc-report'];
  },
};

async function ensureScheduledTasks(_ctx: IntegrationContext): Promise<void> {
  const { getTaskById, createTask } = await import('../../db.js');
  const { CronExpressionParser } = await import('cron-parser');

  const tasks = [
    {
      id: 'plc-daily-checkin',
      group_folder: PLC_GROUP_FOLDER,
      chat_jid: PLC_GROUP_JID,
      prompt: `You are PLC Site Report. It's time for the daily check-in.

1. Call plc_get_prefill IPC to get the latest report data for all sites.
2. Call plc_create_reports IPC with today's date to create pending report entries. If it returns "already_exists" for a site, skip that site (check-in already sent today).
3. For EACH site that needs a check-in, send a SEPARATE message via send_message (use responseFile to get the messageId back).
4. After EACH send, call plc_store_prefill_id IPC with that site's messageId and reportId.

IMPORTANT: Send one message PER SITE so reactions/replies map directly to the correct site.

Per-site message format:
📋 [Site] — [Day] [M/D]
[AYS crew with counts]
[Contractors with counts]
[Equipment list]
👍 same | ❌ off | Reply with changes

If a site has no previous data, use:
📋 [Site] — [Day] [M/D]
No previous data. Reply with today's crew.`,
      schedule_type: 'cron' as const,
      schedule_value: '0 16 * * 1-5',
      context_mode: 'isolated' as const,
    },
    {
      id: 'plc-daily-compilation',
      group_folder: PLC_GROUP_FOLDER,
      chat_jid: PLC_GROUP_JID,
      prompt: `You are PLC Site Report. It's time for the daily compilation.

1. Call plc_get_reports IPC for today's date to get report statuses.
2. If no reports exist for today, send: "⚠️ No check-in was sent today — skipping compilation." and stop.
3. For each site:
   - confirmed_same: use the prefill_data as final
   - confirmed_changed: parse the raw_changes to update the prefill_data
   - off: show "No work"
   - pending (not reported): show "⚠️ Not reported"
4. Format and send the DAILY REPORT message.
5. Call plc_store_history IPC with final data for each confirmed site (feeds tomorrow's pre-fill).

Format:
✅ DAILY REPORT — [Day] [M/D]

*[Site]* — [Manager] [✅|⚠️ Not reported|🚫 No work]
AYS: [names with counts]
Contractors: [names with counts]
Equipment: [list]

[Next site...]`,
      schedule_type: 'cron' as const,
      schedule_value: '0 18 * * 1-5',
      context_mode: 'isolated' as const,
    },
    {
      id: 'plc-weekly-report',
      group_folder: PLC_GROUP_FOLDER,
      chat_jid: PLC_GROUP_JID,
      prompt: `You are PLC Site Report. Generate the weekly summary report.

1. Call plc_get_reports IPC with the past 7 day dates to gather data.
2. Call plc_get_prefill IPC to get site info.
3. Format a text summary of the week's crew counts and trends.
4. Send the summary to the group via send_message.

Include for each site: days active, average crew size, notable changes.
If no data exists for the week, send: "📊 No report data available for the past week."`,
      schedule_type: 'cron' as const,
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated' as const,
    },
  ];

  for (const task of tasks) {
    const existing = getTaskById(task.id);
    if (!existing) {
      const cron = CronExpressionParser.parse(task.schedule_value, { tz: 'America/New_York' });
      createTask({
        ...task,
        next_run: cron.next().toISOString(),
        status: 'active',
        created_at: new Date().toISOString(),
      });
      logger.info({ taskId: task.id, schedule: task.schedule_value }, 'PLC scheduled task created');
    }
  }
}

export default integration;
