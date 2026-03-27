/**
 * PLC Site Report — IPC handlers for container agent ↔ host communication
 */
import { writeIpcResponse, toHostIpcPath } from '../../ipc.js';
import {
  getSites,
  getLatestReportForSite,
  getReportsForDate,
  setPrefillMessageId,
  storeReportHistory,
  createDailyReport,
} from './db.js';
import { logger } from '../../logger.js';
import type { IpcHandlerContext } from '../../integration-types.js';

export const PLC_IPC_TYPES = new Set([
  'plc_get_prefill',
  'plc_store_prefill_id',
  'plc_get_reports',
  'plc_store_history',
  'plc_create_reports',
]);

export async function handlePlcIpc(
  data: Record<string, unknown>,
  groupFolder: string,
  _ctx: IpcHandlerContext,
): Promise<void> {
  const rawRF = data.responseFile as string | undefined;
  const responseFile = rawRF ? toHostIpcPath(rawRF, groupFolder) : undefined;

  switch (data.type) {
    case 'plc_get_prefill': {
      // Return latest report data for all sites (for building the pre-fill message)
      const sites = getSites();
      const prefillData: Record<string, unknown> = {};
      for (const site of sites) {
        const latest = getLatestReportForSite(site.site_id);
        prefillData[site.site_id] = {
          site_name: site.site_name,
          manager_name: site.manager_name,
          manager_jid: site.manager_jid,
          last_report: latest ? JSON.parse(latest.report_data) : null,
        };
      }
      if (responseFile) {
        writeIpcResponse(responseFile, { sites: prefillData });
      }
      break;
    }

    case 'plc_create_reports': {
      // Create pending daily report entries for all sites (with dedup)
      const date = data.date as string;
      const sitePrefills = data.sitePrefills as Record<string, object> | undefined;
      const sites = getSites();
      const reportIds: Record<string, string> = {};
      const status: Record<string, string> = {};
      for (const site of sites) {
        const prefill = sitePrefills?.[site.site_id] ?? {};
        const result = createDailyReport(date, site.site_id, prefill);
        reportIds[site.site_id] = result.id;
        status[site.site_id] = result.created ? 'created' : 'already_exists';
      }
      if (responseFile) {
        writeIpcResponse(responseFile, { reportIds, status });
      }
      break;
    }

    case 'plc_store_prefill_id': {
      // Store the WhatsApp message ID for reaction tracking.
      // Supports per-site linking: { reportId, messageId } or batch: { reportIds, messageId }
      const messageId = data.messageId as string;
      const singleReportId = data.reportId as string | undefined;
      const reportIds = data.reportIds as Record<string, string> | undefined;

      if (messageId && singleReportId) {
        // Per-site: one message = one report
        setPrefillMessageId(singleReportId, messageId);
        logger.info({ messageId, reportId: singleReportId }, 'PLC prefill message ID stored (single)');
      } else if (messageId && reportIds) {
        // Batch: one message = all reports (legacy)
        for (const reportId of Object.values(reportIds)) {
          setPrefillMessageId(reportId, messageId);
        }
        logger.info({ messageId, reportCount: Object.keys(reportIds).length }, 'PLC prefill message ID stored (batch)');
      }
      if (responseFile) {
        writeIpcResponse(responseFile, { success: true });
      }
      break;
    }

    case 'plc_get_reports': {
      // Return today's report statuses for compilation
      const date = data.date as string;
      const reports = getReportsForDate(date);
      const sites = getSites();
      const siteMap = new Map(sites.map(s => [s.site_id, s]));

      const result = reports.map(r => ({
        ...r,
        prefill_data: r.prefill_data ? JSON.parse(r.prefill_data) : null,
        confirmed_data: r.confirmed_data ? JSON.parse(r.confirmed_data) : null,
        site: siteMap.get(r.site_id) ?? null,
      }));

      if (responseFile) {
        writeIpcResponse(responseFile, { reports: result });
      }
      break;
    }

    case 'plc_store_history': {
      // Store final confirmed data in history table (feeds next day's pre-fill)
      const entries = data.entries as Array<{ date: string; site_id: string; report_data: object }>;
      if (entries) {
        for (const entry of entries) {
          storeReportHistory(entry.date, entry.site_id, entry.report_data);
        }
        logger.info({ count: entries.length }, 'PLC report history stored');
      }
      if (responseFile) {
        writeIpcResponse(responseFile, { success: true });
      }
      break;
    }
  }
}
