/**
 * PLC Site Report — Integration module
 *
 * Automates daily crew reporting for PLC site managers.
 * Handles reaction-based confirmations, quote-reply parsing, and scheduled reports.
 */
import type { NanoClawIntegration, IntegrationContext } from '../../integration-types.js';
import type { NewMessage } from '../../types.js';
import { initPlcSchema, getReportByPrefillMessageId, getSiteByManagerJid, confirmReport } from './db.js';
import { PLC_IPC_TYPES, handlePlcIpc } from './ipc-handlers.js';
import { logger } from '../../logger.js';

const PLC_GROUP_JID = '120363404678903841@g.us';
const PLC_GROUP_FOLDER = 'plc-site-managers';

// Text replies that mean "same as yesterday"
const SAME_KEYWORDS = new Set(['same', 'ok', 'yes', 'no change', 'no changes', 'good', 'correct', '👍']);
// Text replies that mean "not on site"
const OFF_KEYWORDS = new Set(['off', 'no work', 'not on site', 'day off', 'no']);

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

  async handleReaction(chatJid: string, reactedMessageId: string, senderJid: string, emoji: string) {
    if (chatJid !== PLC_GROUP_JID) return;

    const report = getReportByPrefillMessageId(reactedMessageId);
    if (!report || report.status !== 'pending') return;

    const site = getSiteByManagerJid(senderJid);
    if (!site || site.site_id !== report.site_id) return;

    // 👍 or ✅ = confirmed same as yesterday
    if (emoji === '👍' || emoji === '👍🏻' || emoji === '👍🏼' || emoji === '👍🏽' || emoji === '👍🏾' || emoji === '👍🏿' || emoji === '✅') {
      confirmReport(report.id, null, 'confirmed_same');
      logger.info({ siteId: site.site_id, emoji }, 'PLC report confirmed via reaction (same)');
    } else if (emoji === '❌') {
      confirmReport(report.id, null, 'off');
      logger.info({ siteId: site.site_id, emoji }, 'PLC report confirmed via reaction (off)');
    }
    // Ignore other emojis
  },

  async handleQuoteReply(chatJid: string, quotedMessageId: string, message: NewMessage): Promise<boolean> {
    if (chatJid !== PLC_GROUP_JID) return false;

    const report = getReportByPrefillMessageId(quotedMessageId);
    if (!report) return false;

    const site = getSiteByManagerJid(message.sender);
    if (!site || site.site_id !== report.site_id) return false;

    // Already confirmed — don't overwrite
    if (report.status !== 'pending') return true;

    const text = message.content.trim().toLowerCase();

    if (SAME_KEYWORDS.has(text)) {
      confirmReport(report.id, null, 'confirmed_same');
      logger.info({ siteId: site.site_id }, 'PLC report confirmed via reply (same)');
    } else if (OFF_KEYWORDS.has(text)) {
      confirmReport(report.id, null, 'off');
      logger.info({ siteId: site.site_id }, 'PLC report confirmed via reply (off)');
    } else {
      // Free-text changes — store raw for AI parsing at compilation time
      confirmReport(report.id, { raw_changes: message.content }, 'confirmed_changed');
      logger.info({ siteId: site.site_id, preview: message.content.slice(0, 100) }, 'PLC report confirmed via reply (changes)');
    }

    return true; // handled — skip normal agent processing
  },

  async onStartup(ctx: IntegrationContext) {
    // Ensure scheduled tasks exist
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
  // Import DB functions lazily to avoid circular deps
  const { getTaskById, createTask } = await import('../../db.js');
  const { CronExpressionParser } = await import('cron-parser');

  const tasks = [
    {
      id: 'plc-daily-checkin',
      group_folder: PLC_GROUP_FOLDER,
      chat_jid: PLC_GROUP_JID,
      prompt: `You are PLC Site Report. It's time for the 4 PM daily check-in.

1. Call plc_get_prefill IPC to get the latest report data for all sites.
2. Format a compact CHECK-IN message using yesterday's data as the pre-fill.
3. Send the message to the group via send_message (use responseFile to get the messageId back).
4. Call plc_create_reports IPC with today's date to create pending report entries.
5. Call plc_store_prefill_id IPC with the messageId and reportIds so reactions can be tracked.

Use the exact format:
📋 CHECK-IN — [Day] [M/D]

[Site] ([Manager])
[AYS crew with counts]
[Contractors with counts]
[Equipment list]

[Next site...]

👍 same | ❌ off | Reply with changes`,
      schedule_type: 'cron' as const,
      schedule_value: '0 16 * * 1-5',
      context_mode: 'isolated' as const,
    },
    {
      id: 'plc-daily-compilation',
      group_folder: PLC_GROUP_FOLDER,
      chat_jid: PLC_GROUP_JID,
      prompt: `You are PLC Site Report. It's time for the 6 PM daily compilation.

1. Call plc_get_reports IPC for today's date to get report statuses.
2. For each site:
   - confirmed_same: use the prefill_data as final
   - confirmed_changed: parse the raw_changes to update the prefill_data
   - off: show "No work"
   - pending (not reported): show "⚠️ Not reported"
3. Format the DAILY REPORT message.
4. Send to group via send_message.
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

1. Query plc_report_history for the past 7 days.
2. Generate an Excel file using openpyxl with:
   - Summary sheet: all sites, all days (Date, Site, AYS Count, AYS Names, Contractors, Equipment)
   - Per-site sheets with daily breakdown
3. Save to /workspace/output/weekly-report-[date].xlsx
4. Send the Excel file to the group via send_file.
5. Also send a text summary of the week's crew counts and trends.`,
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
