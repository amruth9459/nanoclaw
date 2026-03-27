/**
 * PLC Site Report — Integration module
 *
 * Automates daily crew reporting for PLC site managers.
 * Single compact CHECK-IN message; reactions/replies matched via JID → site
 * with fallback for unrecognized senders when only one report is pending.
 */
import type { NanoClawIntegration, IntegrationContext } from '../../integration-types.js';
import type { NewMessage } from '../../types.js';
import { initPlcSchema, getReportsByPrefillMessageId, getSiteByManagerJid, confirmReport } from './db.js';
import { PLC_IPC_TYPES, handlePlcIpc } from './ipc-handlers.js';
import { logger } from '../../logger.js';

const PLC_GROUP_JID = '120363404678903841@g.us';
const PLC_GROUP_FOLDER = 'plc-site-managers';

const SAME_KEYWORDS = new Set(['same', 'ok', 'yes', 'no change', 'no changes', 'good', 'correct', '👍']);
const OFF_KEYWORDS = new Set(['off', 'no work', 'not on site', 'day off', 'no']);
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
      containerConfig: { isolatedPersona: true, networkRestricted: false },
    }];
  },

  ipcMessageTypes: PLC_IPC_TYPES,

  async handleIpcMessage(data, groupFolder, ctx) {
    await handlePlcIpc(data, groupFolder, ctx);
  },

  async handleReaction(chatJid: string, reactedMessageId: string, senderJid: string, emoji: string) {
    if (chatJid !== PLC_GROUP_JID) return;

    const reports = getReportsByPrefillMessageId(reactedMessageId);
    if (reports.length === 0) return;

    // Match sender JID → their site's pending report
    const site = getSiteByManagerJid(senderJid);
    let report = site ? reports.find(r => r.site_id === site.site_id && r.status === 'pending') : undefined;

    // Fallback: if JID didn't match but only one report is still pending, use it
    if (!report) {
      const pending = reports.filter(r => r.status === 'pending');
      if (pending.length === 1) {
        report = pending[0];
        logger.info({ senderJid, siteId: report.site_id }, 'PLC reaction: JID unrecognized, using last pending report');
      }
    }
    if (!report) return;

    if (THUMBS_UP.has(emoji) || emoji === '✅') {
      confirmReport(report.id, null, 'confirmed_same');
      logger.info({ siteId: report.site_id, emoji }, 'PLC report confirmed via reaction (same)');
    } else if (emoji === '❌') {
      confirmReport(report.id, null, 'off');
      logger.info({ siteId: report.site_id, emoji }, 'PLC report confirmed via reaction (off)');
    }
  },

  async handleQuoteReply(chatJid: string, quotedMessageId: string, message: NewMessage): Promise<boolean> {
    if (chatJid !== PLC_GROUP_JID) return false;

    const reports = getReportsByPrefillMessageId(quotedMessageId);
    if (reports.length === 0) return false;

    const site = getSiteByManagerJid(message.sender);
    let report = site ? reports.find(r => r.site_id === site.site_id) : undefined;

    // Fallback: if JID didn't match but only one report is still pending, use it
    if (!report) {
      const pending = reports.filter(r => r.status === 'pending');
      if (pending.length === 1) {
        report = pending[0];
        logger.info({ sender: message.sender, siteId: report.site_id }, 'PLC reply: JID unrecognized, using last pending report');
      }
    }
    if (!report) return false;

    if (report.status !== 'pending') return true; // already confirmed

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

    return true;
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
2. Call plc_create_reports IPC with today's date to create pending report entries. If it returns "already_exists" for a site, that means the check-in already ran today — do NOT send another message.
3. Format a single compact CHECK-IN message using yesterday's data as the pre-fill.
4. Send the message to the group via send_message (use responseFile to get the messageId back).
5. Call plc_store_prefill_id IPC with the messageId and reportIds so reactions can be tracked.

If ALL sites returned "already_exists", do nothing (check-in already sent).

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
