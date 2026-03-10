/**
 * Google Workspace MCP tools — registered conditionally for main group.
 * Provides gmail_search, gmail_send, calendar_events, drive_search.
 * Shells out to a Python helper that uses Google API client with OAuth tokens.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execFileAsync = promisify(execFile);

const GWS_HELPER = '/workspace/gws/gws_helper.py';
const GWS_TOKEN_DIR = '/workspace/gws/tokens';

interface GwsToolsContext {
  groupFolder: string;
  chatJid: string;
  writeIpcFile: (dir: string, data: object) => string;
  pollResponse: (responseFile: string, timeoutMs: number) => Promise<Record<string, unknown> | null>;
  MESSAGES_DIR: string;
}

async function runGwsHelper(action: string, args: Record<string, string>): Promise<string> {
  if (!fs.existsSync(GWS_HELPER)) {
    return JSON.stringify({ error: 'GWS helper not found. Google Workspace OAuth setup required.' });
  }
  if (!fs.existsSync(GWS_TOKEN_DIR)) {
    return JSON.stringify({ error: 'GWS token directory not found. Run OAuth setup first.' });
  }

  const cmdArgs = [GWS_HELPER, action, ...Object.entries(args).flatMap(([k, v]) => [`--${k}`, v])];
  try {
    const { stdout, stderr } = await execFileAsync('python3', cmdArgs, {
      timeout: 30000,
      env: { ...process.env, GWS_TOKEN_DIR },
    });
    if (stderr) {
      return JSON.stringify({ error: stderr.trim() });
    }
    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: `GWS helper failed: ${msg}` });
  }
}

export function registerTools(server: McpServer, _ctx: GwsToolsContext): void {
  server.tool(
    'gmail_search',
    `Search Gmail messages. Returns subject, sender, date, and snippet for matching messages.
Requires Google Workspace OAuth setup on the host.`,
    {
      query: z.string().describe('Gmail search query (same syntax as Gmail search bar), e.g. "from:boss@company.com after:2026/03/01"'),
      max_results: z.number().int().min(1).max(50).default(10).describe('Maximum number of results to return'),
    },
    async (args) => {
      const result = await runGwsHelper('gmail_search', {
        query: args.query,
        max_results: String(args.max_results ?? 10),
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'gmail_send',
    `Send an email via Gmail. Requires Google Workspace OAuth setup.`,
    {
      to: z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.string().optional().describe('CC recipients (comma-separated)'),
    },
    async (args) => {
      const params: Record<string, string> = {
        to: args.to,
        subject: args.subject,
        body: args.body,
      };
      if (args.cc) params.cc = args.cc;
      const result = await runGwsHelper('gmail_send', params);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'calendar_events',
    `List upcoming Google Calendar events. Requires Google Workspace OAuth setup.`,
    {
      days: z.number().int().min(1).max(30).default(7).describe('Number of days ahead to look'),
      calendar_id: z.string().default('primary').describe('Calendar ID (default: primary)'),
    },
    async (args) => {
      const result = await runGwsHelper('calendar_events', {
        days: String(args.days ?? 7),
        calendar_id: args.calendar_id ?? 'primary',
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'drive_search',
    `Search Google Drive files. Returns file names, types, and links. Requires Google Workspace OAuth setup.`,
    {
      query: z.string().describe('Drive search query, e.g. "name contains \'report\'" or "mimeType=\'application/pdf\'"'),
      max_results: z.number().int().min(1).max(50).default(10).describe('Maximum number of results'),
    },
    async (args) => {
      const result = await runGwsHelper('drive_search', {
        query: args.query,
        max_results: String(args.max_results ?? 10),
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );
}
