/**
 * PLC Site Report — Integration module
 *
 * Automates daily crew reporting for PLC site managers.
 * Single compact CHECK-IN message; reactions/replies matched via JID → site
 * with fallback for unrecognized senders when only one report is pending.
 */
import type { NanoClawIntegration, IntegrationContext } from '../../integration-types.js';
import type { NewMessage } from '../../types.js';
import {
  initPlcSchema, getReportsByPrefillMessageId, getSiteByManagerJid, confirmReport,
  getSites, getLatestReportForSite, createDailyReport, setPrefillMessageId,
  getReportsForDate, storeReportHistory,
} from './db.js';
import type { PlcDailyReport } from './db.js';
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

  async handleScheduledTask(taskId, chatJid, sendMessage, sendMessageGetId) {
    if (taskId === 'plc-daily-checkin') return runCheckin(chatJid, sendMessage, sendMessageGetId);
    if (taskId === 'plc-daily-compilation') return runCompilation(chatJid, sendMessage);
    return undefined; // fall through to container for other tasks
  },

  determinePurpose(groupFolder: string) {
    return groupFolder === PLC_GROUP_FOLDER ? 'plc-report' : undefined;
  },

  getSkillDirs() {
    return ['plc-report'];
  },
};

// ── Host-side task runners (local LLM for change parsing) ───────────

type SendFn = (jid: string, text: string, senderName?: string) => Promise<void>;
type SendGetIdFn = (jid: string, text: string, senderName?: string) => Promise<string | undefined>;

const MLX_URL = 'http://127.0.0.1:8800/v1/completions';
const MLX_MODEL = 'mlx-community/Qwen2.5-7B-Instruct-4bit';

/** Call local Qwen to apply free-text changes to structured crew data. */
async function parseChanges(prefill: Record<string, string>, rawChanges: string): Promise<Record<string, string>> {
  const current = [
    prefill.ays ? `AYS: ${prefill.ays}` : '',
    prefill.contractors ? `Contractors: ${prefill.contractors}` : '',
    prefill.equipment ? `Equipment: ${prefill.equipment}` : '',
  ].filter(Boolean).join('\n');

  const prompt = `<|im_start|>system\nYou parse construction crew changes. Given the current data and a change description, output the updated data. Output ONLY the three lines (AYS/Contractors/Equipment), nothing else.<|im_end|>\n<|im_start|>user\nCurrent:\n${current}\n\nChanges: ${rawChanges}\n\nOutput updated data:<|im_end|>\n<|im_start|>assistant\n`;

  try {
    const body = JSON.stringify({ model: MLX_MODEL, prompt, temperature: 0, max_tokens: 300, stop: ['<|im_end|>'] });
    const resp = await fetch(MLX_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`MLX ${resp.status}`);
    const data = await resp.json() as { choices: Array<{ text: string }> };
    const text = data.choices[0]?.text?.trim() ?? '';

    const result: Record<string, string> = { ...prefill };
    for (const line of text.split('\n')) {
      if (line.startsWith('AYS:')) result.ays = line.slice(4).trim();
      else if (line.startsWith('Contractors:')) result.contractors = line.slice(12).trim();
      else if (line.startsWith('Equipment:')) result.equipment = line.slice(10).trim();
    }
    return result;
  } catch (err) {
    logger.warn({ err, rawChanges }, 'PLC: local LLM failed, using raw changes as-is');
    return { ...prefill, changes: rawChanges };
  }
}

function todayET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function dayLabel(): string {
  const d = new Date();
  const day = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const month = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'numeric' });
  const date = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', day: 'numeric' });
  return `${day} ${month}/${date}`;
}

function formatPrefillBlock(site: { site_id: string; site_name: string; manager_name: string }, data: Record<string, unknown> | null): string {
  const label = `${site.site_name} (${site.manager_name})`;
  if (!data) return `${label}\nNo previous data`;
  const ays = (data.ays as string) || '';
  const contractors = (data.contractors as string) || '';
  const equipment = (data.equipment as string) || '';
  const lines = [label];
  if (ays) lines.push(ays);
  if (contractors) lines.push(contractors);
  if (equipment) lines.push(equipment);
  return lines.join('\n');
}

async function runCheckin(chatJid: string, sendMessage: SendFn, sendMessageGetId: SendGetIdFn): Promise<string> {
  const date = todayET();
  const sites = getSites();
  if (sites.length === 0) return 'No sites configured';

  // Create reports (dedup: skips if already exist)
  const reportIds: Record<string, string> = {};
  let anyCreated = false;
  for (const site of sites) {
    const latest = getLatestReportForSite(site.site_id);
    const prefill = latest ? JSON.parse(latest.report_data) : {};
    const result = createDailyReport(date, site.site_id, prefill);
    reportIds[site.site_id] = result.id;
    if (result.created) anyCreated = true;
  }

  if (!anyCreated) return 'Check-in already sent today';

  // Build message
  const blocks: string[] = [];
  for (const site of sites) {
    const latest = getLatestReportForSite(site.site_id);
    const data = latest ? JSON.parse(latest.report_data) : null;
    blocks.push(formatPrefillBlock(site, data));
  }

  const message = `📋 CHECK-IN — ${dayLabel()}\n\n${blocks.join('\n\n')}\n\n👍 same | ❌ off | Reply with changes`;

  // Send and capture message ID for reaction tracking
  const messageId = await sendMessageGetId(chatJid, message, 'PLC Site Report');

  if (messageId) {
    for (const reportId of Object.values(reportIds)) {
      setPrefillMessageId(reportId, messageId);
    }
    logger.info({ messageId, date }, 'PLC check-in sent, prefill IDs stored');
  } else {
    logger.warn({ date }, 'PLC check-in sent but no message ID returned — reactions won\'t track');
  }

  return `Check-in sent for ${sites.length} sites`;
}

async function runCompilation(chatJid: string, sendMessage: SendFn): Promise<string> {
  const date = todayET();
  const reports = getReportsForDate(date);
  const sites = getSites();
  const siteMap = new Map(sites.map(s => [s.site_id, s]));

  if (reports.length === 0) {
    await sendMessage(chatJid, '⚠️ No check-in was sent today — skipping compilation.', 'PLC Site Report');
    return 'No reports to compile';
  }

  const lines: string[] = [`✅ DAILY REPORT — ${dayLabel()}`];

  for (const report of reports) {
    const site = siteMap.get(report.site_id);
    if (!site) continue;

    let statusEmoji: string;
    let dataBlock = '';

    switch (report.status) {
      case 'confirmed_same': {
        statusEmoji = '✅';
        const data = report.prefill_data ? JSON.parse(report.prefill_data) as Record<string, string> : null;
        if (data) {
          if (data.ays) dataBlock += `\nAYS: ${data.ays}`;
          if (data.contractors) dataBlock += `\nContractors: ${data.contractors}`;
          if (data.equipment) dataBlock += `\nEquipment: ${data.equipment}`;
        }
        // Store in history for tomorrow's prefill
        if (data) storeReportHistory(date, report.site_id, data);
        break;
      }
      case 'confirmed_changed': {
        statusEmoji = '✅';
        const confirmed = report.confirmed_data ? JSON.parse(report.confirmed_data) as Record<string, string> : null;
        if (confirmed?.raw_changes) {
          const prefill = report.prefill_data ? JSON.parse(report.prefill_data) as Record<string, string> : {};
          // Use local LLM to parse free-text changes into structured data
          const parsed = await parseChanges(prefill, confirmed.raw_changes);
          if (parsed.ays) dataBlock += `\nAYS: ${parsed.ays}`;
          if (parsed.contractors) dataBlock += `\nContractors: ${parsed.contractors}`;
          if (parsed.equipment) dataBlock += `\nEquipment: ${parsed.equipment}`;
          // Store parsed structured data as history (feeds tomorrow's prefill)
          storeReportHistory(date, report.site_id, parsed);
        }
        break;
      }
      case 'off':
        statusEmoji = '🚫 No work';
        break;
      case 'pending':
      default:
        statusEmoji = '⚠️ Not reported';
        break;
    }

    lines.push(`\n*${site.site_name}* — ${site.manager_name} ${statusEmoji}${dataBlock}`);
  }

  const message = lines.join('');
  await sendMessage(chatJid, message, 'PLC Site Report');

  const confirmed = reports.filter(r => r.status !== 'pending').length;
  return `Daily report compiled: ${confirmed}/${reports.length} sites reported`;
}

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
