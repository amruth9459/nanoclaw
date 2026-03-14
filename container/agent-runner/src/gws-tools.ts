/**
 * Google Workspace MCP tools — registered conditionally for main group.
 * Provides gmail_search, gmail_send, calendar_events, drive_search,
 * gmail_categorize (read-only), gmail_cleanup (HITL-gated via IPC),
 * and Google Keep read-only tools (keep_list_notes, keep_get_note, keep_list_items, keep_search).
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

export function registerTools(server: McpServer, ctx: GwsToolsContext): void {
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

  // --- Google Keep tools (Phase 1: read-only) ---

  server.tool(
    'keep_list_notes',
    `List Google Keep notes. Optionally filter by label. Returns note IDs, titles, and timestamps.
Requires Google Workspace OAuth setup with Keep API scope.`,
    {
      max_results: z.number().int().min(1).max(100).default(20).describe('Maximum number of notes to return'),
      label: z.string().optional().describe('Filter by label name'),
      archived: z.boolean().default(false).describe('Include trashed/archived notes'),
    },
    async (args) => {
      const params: Record<string, string> = {
        max_results: String(args.max_results ?? 20),
        archived: String(args.archived ?? false),
      };
      if (args.label) params.label = args.label;
      const result = await runGwsHelper('keep_list_notes', params);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'keep_get_note',
    `Get full content of a Google Keep note by ID. Returns title, text content or checklist items.
Note IDs are in format "notes/<id>" (as returned by keep_list_notes).
Requires Google Workspace OAuth setup with Keep API scope.`,
    {
      note_id: z.string().describe('Note ID, e.g. "notes/abc123" or just "abc123"'),
    },
    async (args) => {
      const result = await runGwsHelper('keep_get_note', {
        note_id: args.note_id,
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'keep_list_items',
    `Extract task/checklist items from a Google Keep list note. By default returns only unchecked items.
Useful for getting TODO items from Keep checklists.
Requires Google Workspace OAuth setup with Keep API scope.`,
    {
      note_id: z.string().describe('Note ID, e.g. "notes/abc123" or just "abc123"'),
      unchecked_only: z.boolean().default(true).describe('Only return unchecked items (default: true)'),
    },
    async (args) => {
      const result = await runGwsHelper('keep_list_items', {
        note_id: args.note_id,
        unchecked_only: String(args.unchecked_only ?? true),
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'keep_search',
    `Search Google Keep notes by text content. Searches both titles and body text.
Returns matching notes with snippets. Requires Google Workspace OAuth setup with Keep API scope.`,
    {
      query: z.string().describe('Search text to find in note titles and content'),
      max_results: z.number().int().min(1).max(50).default(10).describe('Maximum number of results'),
    },
    async (args) => {
      const result = await runGwsHelper('keep_search', {
        query: args.query,
        max_results: String(args.max_results ?? 10),
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  // TODO Phase 2: keep_check_item — toggle checklist item (write operation, needs keep scope)
  // TODO Phase 2: keep_add_item — add item to checklist note (write operation, needs keep scope)

  // --- Cleanup tools ---

  server.tool(
    'gmail_categorize',
    `Categorize Gmail messages by sender domain for cleanup review. Read-only — does not modify any messages.
Groups messages by domain, detects newsletters (List-Unsubscribe header), shows example subjects.
Use this before gmail_cleanup to build a cleanup proposal.`,
    {
      query: z.string().describe('Gmail search query, e.g. "category:promotions older_than:30d" or "is:unread from:newsletter"'),
      max_results: z.number().int().min(1).max(100).default(50).describe('Maximum messages to scan (max 100)'),
    },
    async (args) => {
      const result = await runGwsHelper('gmail_categorize', {
        query: args.query,
        max_results: String(args.max_results ?? 50),
      });
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  server.tool(
    'gmail_cleanup',
    `Request approval to trash or archive Gmail messages. This does NOT execute immediately —
it sends a WhatsApp notification to the user who must reply "approve-cleanup <token>" to proceed.
Safety: max 100 messages per batch, no permanent delete, 30-minute expiry.
Use gmail_categorize first to identify messages, then pass IDs here.`,
    {
      action: z.enum(['trash', 'archive']).describe('Cleanup action: "trash" (recoverable) or "archive" (remove from inbox)'),
      message_ids: z.array(z.string()).min(1).max(100).describe('Gmail message IDs to act on (max 100)'),
      summary: z.string().describe('Human-readable summary of what is being cleaned up, e.g. "47 promotional emails from newsletters older than 30 days"'),
      breakdown: z.string().describe('Domain-grouped breakdown for the approval message, e.g. "  - marketing.example.com: 15 msgs"'),
    },
    async (args) => {
      // Hard cap enforcement at container level
      if (args.message_ids.length > 100) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Exceeds hard cap of 100 messages' }) }] };
      }

      // Write IPC to host for HITL approval
      const responseFile = `/workspace/ipc/messages/gmail-cleanup-${Date.now()}.response.json`;
      ctx.writeIpcFile(ctx.MESSAGES_DIR, {
        type: 'gmail_cleanup',
        action: args.action,
        message_ids: args.message_ids,
        summary: args.summary,
        breakdown: args.breakdown,
        chatJid: ctx.chatJid,
        responseFile,
      });

      // Poll for host response
      const response = await ctx.pollResponse(responseFile, 30_000);
      if (!response) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Host did not respond to cleanup request in time' }) }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}
