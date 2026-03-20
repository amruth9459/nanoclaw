/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group. Main group agents can send to other groups using target_jid (get JIDs from list_groups).",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    target_jid: z.string().optional().describe('(Main group only) Send to a different group by JID. Get JIDs from list_groups. Defaults to current group.'),
  },
  async (args) => {
    // Main group can target other groups; non-main always sends to own group
    const targetJid = (isMain && args.target_jid) ? args.target_jid : chatJid;

    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: targetJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    const targetNote = targetJid !== chatJid ? ` (to ${targetJid})` : '';
    return { content: [{ type: 'text' as const, text: `Message sent${targetNote}.` }] };
  },
);

server.tool(
  'list_groups',
  'List all registered WhatsApp groups with their JIDs. Use this to find the target_jid for cross-group messaging via send_message.',
  {},
  async () => {
    const groupsFile = path.join(IPC_DIR, 'available_groups.json');
    try {
      if (!fs.existsSync(groupsFile)) {
        return { content: [{ type: 'text' as const, text: 'No groups data available. The host may not have synced yet.' }] };
      }
      const data = JSON.parse(fs.readFileSync(groupsFile, 'utf-8'));
      const groups = (data.groups || []) as Array<{ jid: string; name: string; isRegistered: boolean; lastActivity: string }>;
      const registered = groups.filter(g => g.isRegistered);
      if (registered.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No registered groups found.' }] };
      }
      const formatted = registered.map(g =>
        `- ${g.name}: ${g.jid}${g.lastActivity ? ` (last active: ${g.lastActivity})` : ''}`
      ).join('\n');
      return { content: [{ type: 'text' as const, text: `Registered groups:\n${formatted}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error reading groups: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

server.tool(
  'react',
  "React to a specific message with an emoji. Use this to acknowledge messages positively (👍), show agreement, or give non-verbal feedback without sending a full reply.",
  {
    message_id: z.string().describe('The ID of the message to react to (from the conversation context)'),
    sender_jid: z.string().optional().describe('The JID of the message sender (from the conversation context)'),
    emoji: z.string().default('👍').describe('The emoji to react with, e.g. "👍", "❤️", "😂", "🎉"'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'react',
      chatJid,
      messageId: args.message_id,
      senderJid: args.sender_jid || '',
      emoji: args.emoji || '👍',
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: `Reacted with ${args.emoji || '👍'}` }] };
  },
);

server.tool(
  'send_file',
  `Send a file (PDF report, image, spreadsheet, etc.) to the user's WhatsApp directly.
Use this to share reports, analysis results, drafts, or any output file you've created.
The file must exist at the given path inside the container (e.g. /workspace/group/outputs/report.pdf).`,
  {
    file_path: z.string().describe('Absolute path to the file inside the container, e.g. /workspace/group/outputs/report.pdf'),
    filename: z.string().describe('Display name for the file, e.g. "OSHA_Report_2025.pdf"'),
    mimetype: z.string().optional().describe('MIME type, e.g. "application/pdf", "image/png". Auto-detected from extension if omitted.'),
    caption: z.string().optional().describe('Optional caption shown with the file'),
  },
  async (args) => {
    // Auto-detect mimetype from extension if not provided
    const ext = path.extname(args.file_path).toLowerCase();
    const mimetypeMap: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.csv': 'text/csv',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.zip': 'application/zip',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
    };
    const mimetype = args.mimetype || mimetypeMap[ext] || 'application/octet-stream';

    if (!fs.existsSync(args.file_path)) {
      return { content: [{ type: 'text' as const, text: `Error: file not found at ${args.file_path}` }], isError: true };
    }

    writeIpcFile(MESSAGES_DIR, {
      type: 'send_file',
      chatJid,
      groupFolder,
      filePath: args.file_path,
      filename: args.filename,
      mimetype,
      caption: args.caption || undefined,
      timestamp: new Date().toISOString(),
    });

    return { content: [{ type: 'text' as const, text: `File queued for delivery: ${args.filename}` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'semantic_search',
  `Search your indexed documents and conversation history using semantic similarity.
Searches OCR output, conversation archives, and any other indexed documents.
Returns the most relevant text chunks for your query.`,
  {
    query: z.string().describe('Natural language search query, e.g. "cardamom recipe" or "Naren contact info"'),
    top_k: z.number().int().min(1).max(20).default(5).describe('Number of results to return (default: 5)'),
    group_folder: z.string().optional().describe('Limit search to a specific group folder (e.g. "ocr"). Omit to search all groups.'),
  },
  async (args) => {
    // Write a search IPC request and wait for the host to process it
    const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestFile = path.join(IPC_DIR, `${requestId}.search.json`);
    const responseFile = path.join(IPC_DIR, `${requestId}.result.json`);

    const request = {
      type: 'semantic_search',
      requestId,
      query: args.query,
      topK: args.top_k ?? 5,
      groupFolder: args.group_folder,
      responseFile,
    };

    // Write request
    const tmp = `${requestFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(request, null, 2));
    fs.renameSync(tmp, requestFile);

    // Poll for response (host processes and writes responseFile)
    const timeout = Date.now() + 30000;
    while (Date.now() < timeout) {
      await new Promise(r => setTimeout(r, 300));
      if (fs.existsSync(responseFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);
          if (result.error) {
            return { content: [{ type: 'text' as const, text: `Search error: ${result.error}` }], isError: true };
          }
          const formatted = (result.results as Array<{ source: string; content: string; distance: number }>)
            .map((r, i) =>
              `[${i + 1}] ${r.source} (distance: ${r.distance.toFixed(3)})\n${r.content.slice(0, 400)}`
            ).join('\n\n---\n\n');
          return {
            content: [{ type: 'text' as const, text: formatted || 'No results found.' }],
          };
        } catch {
          return { content: [{ type: 'text' as const, text: 'Failed to parse search results.' }], isError: true };
        }
      }
    }
    return { content: [{ type: 'text' as const, text: 'Search timed out. Is the host semantic index running?' }], isError: true };
  },
);

server.tool(
  'index_document',
  'Index a text document for semantic search. Use after processing OCR output or saving important notes.',
  {
    source: z.string().describe('Unique identifier for this document, e.g. "ocr/scan_001.json"'),
    content: z.string().describe('The text content to index'),
  },
  async (args) => {
    const requestId = `index-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestFile = path.join(IPC_DIR, `${requestId}.index.json`);

    const request = {
      type: 'index_document',
      requestId,
      source: args.source,
      groupFolder,
      content: args.content,
    };

    const tmp = `${requestFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(request, null, 2));
    fs.renameSync(tmp, requestFile);

    return { content: [{ type: 'text' as const, text: `Indexing requested for "${args.source}". Processing in background.` }] };
  },
);

// ── ClawWork tools ─────────────────────────────────────────────────────────────

function writeClawworkRequest(data: object): { requestFile: string; responseFile: string } {
  const requestId = `clawwork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(MESSAGES_DIR, `${requestId}.json`);
  const responseFile = path.join(MESSAGES_DIR, `${requestId}.response.json`);

  const payload = { ...data, requestId, responseFile, groupFolder, timestamp: new Date().toISOString() };
  const tmp = `${requestFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, requestFile);

  return { requestFile, responseFile };
}

async function pollResponse(responseFile: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    if (fs.existsSync(responseFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        fs.unlinkSync(responseFile);
        return result;
      } catch {
        return null;
      }
    }
  }
  return null;
}

server.tool(
  'clawwork_get_status',
  'Get your current economic status: balance, earnings, spending, survival tier, and active task.',
  {},
  async () => {
    const { responseFile } = writeClawworkRequest({ type: 'clawwork_get_status' });
    const result = await pollResponse(responseFile, 10000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: status request timed out' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    const text = JSON.stringify(result, null, 2);
    return { content: [{ type: 'text' as const, text }] };
  },
);

server.tool(
  'clawwork_decide_activity',
  'Declare your chosen activity: work (complete assigned tasks for payment) or learn (study to improve skills). Records your decision for the economic system.',
  {
    activity: z.enum(['work', 'learn']).describe('Your chosen activity mode'),
    reasoning: z.string().describe('Why you chose this activity'),
  },
  async (args) => {
    writeClawworkRequest({ type: 'clawwork_decide_activity', activity: args.activity, reasoning: args.reasoning });
    return {
      content: [{ type: 'text' as const, text: `Activity set to "${args.activity}". ${args.reasoning}` }],
    };
  },
);

server.tool(
  'learn',
  'Record knowledge you have acquired. This persists to your group memory and helps you improve. Minimum 200 characters.',
  {
    topic: z.string().describe('Topic or subject area of the knowledge'),
    knowledge: z.string().min(200).describe('The knowledge content to record (min 200 characters)'),
    domain: z.string().describe('Which project this learning applies to (e.g. "nanoclaw" or integration name)'),
  },
  async (args) => {
    const { responseFile } = writeClawworkRequest({ type: 'learn', topic: args.topic, knowledge: args.knowledge, domain: args.domain });
    const result = await pollResponse(responseFile, 10000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: learn request timed out' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    return {
      content: [{ type: 'text' as const, text: `Knowledge recorded: topic="${args.topic}", length=${args.knowledge.length} chars` }],
    };
  },
);

server.tool(
  'clawwork_submit_work',
  'Submit completed work for evaluation and payment. You will receive a score (0.0–1.0) and payment if score ≥ 0.6.',
  {
    work_output: z.string().describe('Your completed work output'),
    artifact_file_paths: z.array(z.string()).default([]).describe('Paths to any files you created as artifacts'),
  },
  async (args) => {
    const { responseFile } = writeClawworkRequest({
      type: 'clawwork_submit_work',
      work_output: args.work_output,
      artifact_file_paths: args.artifact_file_paths,
    });
    const result = await pollResponse(responseFile, 60000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: work evaluation timed out (60s)' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    const text = result.accepted
      ? `Work accepted! Score: ${result.evaluation_score}, Payment: $${result.payment}\nFeedback: ${result.feedback}`
      : `Work not accepted (score: ${result.evaluation_score} < 0.6). No payment.\nFeedback: ${result.feedback}`;
    return { content: [{ type: 'text' as const, text }] };
  },
);

// ── Bounty hunting tools ───────────────────────────────────────────────────────

function writeBountyRequest(data: object): { responseFile: string } {
  const requestId = `bounty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(MESSAGES_DIR, `${requestId}.json`);
  const responseFile = path.join(MESSAGES_DIR, `${requestId}.response.json`);

  const payload = { ...data, requestId, responseFile, groupFolder, timestamp: new Date().toISOString() };
  const tmp = `${requestFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, requestFile);

  return { responseFile };
}

server.tool(
  'find_bounties',
  `Find open bounties from Algora.io and GitHub. Returns a list of bounties sorted by reward (highest first).
Each bounty has an id, platform, title, url, reward_usd, and repo.
Use the id when calling propose_bounty to nominate one for approval.`,
  {
    limit: z.number().int().min(1).max(50).default(20).describe('Maximum number of bounties to return'),
  },
  async (args) => {
    const { responseFile } = writeBountyRequest({ type: 'find_bounties', limit: args.limit ?? 20 });
    const result = await pollResponse(responseFile, 30000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: find_bounties request timed out (30s)' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    const bounties = result.bounties as Array<Record<string, unknown>>;
    if (!bounties || bounties.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No bounties found.' }] };
    }
    const formatted = bounties.map((b, i) =>
      `[${i + 1}] ${b.platform} | ${b.title}\n    Reward: ${b.reward_usd != null ? `$${b.reward_usd}` : b.reward_raw} | ID: ${b.id}\n    URL: ${b.url}${b.repo ? `\n    Repo: ${b.repo}` : ''}`
    ).join('\n\n');
    return { content: [{ type: 'text' as const, text: formatted }] };
  },
);

server.tool(
  'propose_bounty',
  `Propose a bounty opportunity for the user to approve. The user will receive a WhatsApp message with the bounty details and approval token.
Approval is asynchronous — the user replies "approve-bounty <token>" or "reject-bounty <token>".
You must call find_bounties first to get valid bounty IDs.`,
  {
    bounty_id: z.string().describe('The bounty ID from find_bounties (e.g. "algora:12345")'),
    reason: z.string().optional().describe('Why you recommend this bounty (skills match, reward amount, etc.)'),
  },
  async (args) => {
    const { responseFile } = writeBountyRequest({
      type: 'propose_bounty',
      bounty_id: args.bounty_id,
      reason: args.reason,
    });
    const result = await pollResponse(responseFile, 15000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: propose_bounty request timed out' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    return {
      content: [{ type: 'text' as const, text: `Bounty proposed (token: ${result.token}). Waiting for user approval via WhatsApp.` }],
    };
  },
);

server.tool(
  'submit_bounty',
  `Submit completed work for a bounty. Notifies the user and records PayPal email for payment.
Include your work summary and any PR/patch URLs. The host will update the bounty status to "submitted".`,
  {
    bounty_id: z.string().describe('The bounty ID (e.g. "algora:12345")'),
    work_summary: z.string().describe('Brief summary of the work completed'),
    pr_url: z.string().optional().describe('URL to the pull request or patch'),
    submission_notes: z.string().optional().describe('Any notes for the bounty provider'),
  },
  async (args) => {
    const { responseFile } = writeBountyRequest({
      type: 'submit_bounty',
      bounty_id: args.bounty_id,
      work_summary: args.work_summary,
      pr_url: args.pr_url,
      submission_notes: args.submission_notes,
    });
    const result = await pollResponse(responseFile, 20000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: submit_bounty request timed out' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    const paypalLine = result.paypal_email ? `\nPayPal email for payment: ${result.paypal_email}` : '';
    return {
      content: [{ type: 'text' as const, text: `Bounty submitted successfully.${paypalLine}\nInclude your PayPal email in communications with the bounty provider.` }],
    };
  },
);

// ── Freelance gig tools ────────────────────────────────────────────────────────

server.tool(
  'find_freelance_gigs',
  `Find freelance gigs from Reddit r/forhire, Freelancer.com, Algora, and GitHub.
Returns gigs sorted by reward (highest first). Broader than find_bounties — includes paid freelance work, not just open-source bounties.
Each gig has an id, platform, title, url, reward_usd, and description.
Use the id when calling propose_deliverable to submit completed work for approval.`,
  {
    limit: z.number().int().min(1).max(50).default(30).describe('Maximum number of gigs to return'),
  },
  async (args) => {
    const { responseFile } = writeBountyRequest({ type: 'find_freelance_gigs', limit: args.limit ?? 30 });
    const result = await pollResponse(responseFile, 30000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: find_freelance_gigs request timed out (30s)' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    const bounties = result.bounties as Array<Record<string, unknown>>;
    if (!bounties || bounties.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No freelance gigs found.' }] };
    }
    const formatted = bounties.map((b, i) =>
      `[${i + 1}] ${b.platform} | ${b.title}\n    Reward: ${b.reward_usd != null ? `$${b.reward_usd}` : b.reward_raw} | ID: ${b.id}\n    URL: ${b.url}${b.description ? `\n    ${String(b.description).slice(0, 150)}...` : ''}`
    ).join('\n\n');
    return { content: [{ type: 'text' as const, text: formatted }] };
  },
);

server.tool(
  'propose_deliverable',
  `Submit completed freelance work for user approval before delivering to the client.
The user will receive a WhatsApp message with the work summary and can reply "approve-delivery <token>" or "reject-delivery <token>".
NEVER deliver work to a client without approval through this gate.`,
  {
    gig_id: z.string().describe('The gig ID (e.g. "reddit:abc123", "freelancer:456")'),
    gig_title: z.string().describe('Title of the gig/project'),
    work_summary: z.string().describe('Summary of the completed work — what was done, quality notes, anything the reviewer should know'),
    client_info: z.string().optional().describe('Client username, contact info, or platform profile'),
    deliverable_path: z.string().optional().describe('Path to the deliverable file in the container (e.g. /workspace/group/deliverables/report.pdf)'),
  },
  async (args) => {
    const { responseFile } = writeBountyRequest({
      type: 'propose_deliverable',
      gig_id: args.gig_id,
      gig_title: args.gig_title,
      work_summary: args.work_summary,
      client_info: args.client_info,
      deliverable_path: args.deliverable_path,
    });
    const result = await pollResponse(responseFile, 15000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: propose_deliverable request timed out' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    return {
      content: [{ type: 'text' as const, text: `Deliverable proposed (token: ${result.token}). Waiting for user approval via WhatsApp. Do NOT deliver to client until approved.` }],
    };
  },
);

server.tool(
  'remote_shell',
  `Execute a command on the Mac host from WhatsApp. Use this when the user asks you to run something on their computer remotely.

**Security**: Only main group can execute commands. All commands are audited.

**Common use cases:**
- Restart services: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
- Check logs: tail -50 logs/nanoclaw.log
- System info: uptime, df -h, vm_stat
- Network: tailscale ip -4, networksetup -getairportnetwork en0
- Docker: docker ps, docker logs <container>

**Presets** (use preset name instead of full command):
- restart_nanoclaw
- check_nanoclaw_status
- view_recent_logs
- get_tailscale_ip
- check_disk_space
- system_uptime

Output is returned formatted for WhatsApp.`,
  {
    command: z.string().describe('Command to execute, or preset name (e.g. "restart_nanoclaw")'),
    working_dir: z.string().optional().describe('Working directory (defaults to project root)'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default 30000, max 60000)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Error: remote_shell is only available in the main group' }],
        isError: true,
      };
    }

    const { responseFile } = writeRemoteShellRequest({
      type: 'remote_shell',
      command: args.command,
      working_dir: args.working_dir,
      timeout: args.timeout,
    });

    const result = await pollResponse(responseFile, (args.timeout || 30000) + 5000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: remote_shell request timed out' }], isError: true };
    }

    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }

    const formatted = String(result.formatted_output || result.output || 'Command completed with no output.');
    return { content: [{ type: 'text' as const, text: formatted }] };
  },
);

// Helper for remote shell IPC
function writeRemoteShellRequest(data: {
  type: string;
  command: string;
  working_dir?: string;
  timeout?: number;
}): { responseFile: string } {
  const filename = writeIpcFile(MESSAGES_DIR, data);
  const responseFile = path.join(MESSAGES_DIR, filename.replace('.json', '.response.json'));
  return { responseFile };
}

server.tool(
  'spawn_team',
  `Spawn a multi-agent team to work on a complex goal. Use this for tasks that benefit from specialized agents working together.

When to use:
- Complex, multi-step goals requiring different expertise (research + development + testing)
- Tasks that will take significant time and benefit from parallel work
- Projects requiring specialized roles (e.g., researcher, developer, analyst)

The team system will:
1. Decompose the goal into sub-goals and tasks
2. Form specialized agent teams based on requirements
3. Manage resources (64GB RAM shared across all products)
4. Provide progress updates
5. Return results when complete`,
  {
    goal: z.string().describe('The high-level goal description (e.g., "Build OSHA Violation Predictor MVP")'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).default('high').describe('Task priority (critical=paying customer, high=user task, medium=scheduled, low=background)'),
    target_value: z.number().optional().describe('Optional numeric target (e.g., 5250 for "$5,250 goal")'),
    deadline: z.string().optional().describe('Optional deadline in ISO 8601 format (e.g., "2026-06-30T00:00:00Z")'),
  },
  async (args) => {
    // Main group only - teams require elevated permissions
    if (!isMain) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Error: Team spawning is only available in the main group for security reasons.',
        }],
        isError: true,
      };
    }

    const taskData: Record<string, unknown> = {
      type: 'spawn_team',
      chatJid,
      groupFolder,
      goal: args.goal,
      priority: args.priority,
      targetValue: args.target_value,
      deadline: args.deadline,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, taskData);

    return {
      content: [{
        type: 'text' as const,
        text: `✅ Team spawn request queued: ${filename}\n\n` +
              `*Goal:* ${args.goal}\n` +
              `*Priority:* ${args.priority}\n\n` +
              `The team orchestrator will:\n` +
              `• Decompose into sub-goals and tasks\n` +
              `• Form specialized agent teams\n` +
              `• Manage 64GB RAM resources\n` +
              `• Provide progress updates\n\n` +
              `You'll receive updates as teams work on this.`,
      }],
    };
  },
);

// ── Integration tool modules (loaded from NANOCLAW_TOOL_MODULES env var) ──
// Each module must export registerTools(server, ctx).
const toolModules = (process.env.NANOCLAW_TOOL_MODULES || '').split(',').filter(Boolean);
for (const mod of toolModules) {
  try {
    const { registerTools } = await import(`./${mod}.js`);
    if (typeof registerTools === 'function') {
      registerTools(server, { groupFolder, chatJid, writeIpcFile, pollResponse, MESSAGES_DIR });
    }
  } catch {
    // Tool module not available in this image — skip
  }
}

// Task System (evolved from TodoWrite)
server.tool(
  'task_tool',
  `Manage tasks with multi-agent coordination support. Replaces TodoWrite with more powerful features.

Actions:
- create: Create a new task with description, priority, dependencies
- update: Update task status, priority, or assigned agent
- list: List all tasks (optionally filtered by status or agent)
- get: Get details of a specific task
- delete: Delete a task
- available: List tasks available to work on (dependencies met)

Tasks support:
- Dependencies: Tasks can depend on other tasks
- Assignment: Tasks can be assigned to specific agents
- Priority: 1-100 scale (100 = highest)
- Status tracking: pending → in_progress → completed
- Complexity estimation: trivial, simple, moderate, complex, expert`,
  {
    action: z.enum(['create', 'update', 'list', 'get', 'delete', 'available']).describe('Action to perform'),
    description: z.string().optional().describe('Task description (for create)'),
    complexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'expert']).optional().describe('Task complexity'),
    priority: z.number().min(1).max(100).optional().describe('Priority 1-100 (100=highest)'),
    dependencies: z.array(z.string()).optional().describe('Task IDs this depends on'),
    assignedAgent: z.string().optional().describe('Agent name to assign'),
    estimatedHours: z.number().optional().describe('Estimated hours'),
    taskId: z.string().optional().describe('Task ID (for update/get/delete)'),
    status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']).optional().describe('New status (for update)'),
    newPriority: z.number().min(1).max(100).optional().describe('New priority (for update)'),
    newAgent: z.string().optional().describe('New assigned agent (for update)'),
    filterStatus: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']).optional().describe('Filter by status (for list)'),
    filterAgent: z.string().optional().describe('Filter by agent (for list/available)'),
  },
  async (args) => {
    const { responseFile } = writeClawworkRequest({
      type: 'task_tool',
      ...args,
    });

    const result = await pollResponse(responseFile, 10000);
    if (!result) return { content: [{ type: 'text' as const, text: 'Error: task_tool request timed out' }], isError: true };
    if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    return { content: [{ type: 'text' as const, text: String(result.result) }] };
  },
);

// ── Shared Items Inbox ──────────────────────────────────────────────────────────

server.tool(
  'shared_items',
  `Query and manage your shared items inbox. Items are auto-captured when the user shares links, images, documents, or strategic ideas via WhatsApp.

Actions:
- list: List items by status (default: "new"). Returns formatted list.
- get: Get a single item's full details by ID.
- triage: Mark an item as triaged — add notes describing what it is and what action to take.
- act: Mark an item as acted_on (you've finished working on it).
- archive: Dismiss/archive an item you don't need to act on.`,
  {
    action: z.enum(['list', 'get', 'triage', 'act', 'archive']).describe('Action to perform'),
    id: z.string().optional().describe('Item ID (required for get, triage, act, archive)'),
    status: z.string().optional().describe('Filter by status for list action (default: "new"). Options: new, triaged, acted_on, archived'),
    notes: z.string().optional().describe('Notes to attach (for triage action — describe what it is and what to do)'),
    limit: z.number().optional().describe('Max items to return for list (default: 20)'),
  },
  async (args) => {
    const { responseFile } = writeClawworkRequest({
      type: 'shared_items',
      action: args.action,
      id: args.id,
      status: args.status,
      notes: args.notes,
      limit: args.limit,
    });

    const result = await pollResponse(responseFile, 10000);
    if (!result) return { content: [{ type: 'text' as const, text: 'Error: shared_items request timed out' }], isError: true };
    if (result.error) return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    return { content: [{ type: 'text' as const, text: String(result.result) }] };
  },
);

// ── Desktop Claude Code remote control ─────────────────────────────────────────

server.tool(
  'desktop_claude',
  `Run Claude Code on the host Mac as a remote control. This spawns a non-interactive Claude Code session
on the desktop with full access to the NanoClaw codebase (or any specified directory).

Use this when:
- The user asks you to make code changes to NanoClaw itself (project source is read-only in your container)
- You need to run host-side commands (brew, launchctl, git push, etc.)
- Tasks that require desktop-level access (file system, network, etc.)

The desktop agent runs with full permissions. You get back its text output.
Only available to the main group.`,
  {
    prompt: z.string().describe('The task/prompt for the desktop Claude Code agent'),
    workdir: z.string().optional().describe('Working directory (default: ~/nanoclaw)'),
    max_budget_usd: z.number().optional().describe('Max spend in USD (default: unlimited, set 0 for no limit)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Error: desktop_claude is only available in the main group.' }],
        isError: true,
      };
    }

    const { responseFile } = writeClawworkRequest({
      type: 'desktop_claude',
      prompt: args.prompt,
      workdir: args.workdir,
      max_budget_usd: args.max_budget_usd,
    });

    // Desktop Claude sessions can take a while — poll with 90 min timeout
    const result = await pollResponse(responseFile, 5_400_000);
    if (!result) {
      return { content: [{ type: 'text' as const, text: 'Error: desktop_claude request timed out (90 min limit)' }], isError: true };
    }
    if (result.error) {
      return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: String(result.output || 'Desktop agent completed with no output.') }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
