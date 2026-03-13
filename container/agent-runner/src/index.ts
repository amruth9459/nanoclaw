/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { SafetyPulse } from './safety-pulse.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  maxTurns?: number;
  personaId?: string;
  /** Full persona markdown content (read from ~/.claude/agents/ on host) */
  personaContent?: string;
}

interface ContainerOutput {
  status: 'success' | 'error' | 'streaming';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isPartial?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_DIR = '/workspace/ipc';
const IPC_MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/** Detect OAuth/authentication errors from SDK exceptions. */
function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /401|authentication|unauthorized|oauth|token.expired|invalid.{0,10}token/i.test(msg);
}

/**
 * Request a fresh OAuth token from the host via IPC.
 * Writes a token_refresh request, polls for the response.
 * Returns the new token value, or null if refresh failed/timed out.
 */
async function requestTokenRefresh(currentToken: string | undefined): Promise<string | null> {
  const requestId = `token-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(IPC_MESSAGES_DIR, `${requestId}.json`);
  const responseFile = path.join(IPC_MESSAGES_DIR, `${requestId}.response.json`);

  const payload = {
    type: 'token_refresh',
    requestId,
    responseFile,
    currentTokenPrefix: currentToken?.slice(0, 20), // for host to detect if token changed
    timestamp: new Date().toISOString(),
  };

  fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
  const tmp = `${requestFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, requestFile);

  log('Requested token refresh via IPC');

  // Poll for response (10s timeout — host IPC polls every ~1s)
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 400));
    if (fs.existsSync(responseFile)) {
      try {
        const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        fs.unlinkSync(responseFile);
        if (result.token && result.token !== currentToken) {
          log('Received fresh token from host');
          return result.token;
        }
        if (result.error) {
          log(`Token refresh failed: ${result.error}`);
        } else {
          log('Token unchanged — host returned same token');
        }
        return null;
      } catch {
        return null;
      }
    }
  }
  log('Token refresh timed out');
  return null;
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const HEARTBEAT_MARKER = '---NANOCLAW_HEARTBEAT---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

/** Emit periodic heartbeats to stdout so the host resets its container timeout. */
function startHeartbeat(intervalMs = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    console.log(HEARTBEAT_MARKER);
  }, intervalMs);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Secrets to strip from Bash tool subprocess environments.
// These are needed by claude-code for API auth but should never
// be visible to commands Kit runs.
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Write a security alert IPC message so the host sends it to the user via WhatsApp.
 */
function writeSecurityAlert(text: string, chatJid: string, groupFolder: string): void {
  try {
    fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
    const filepath = path.join(IPC_MESSAGES_DIR, `${Date.now()}-security.json`);
    const data = { type: 'message', chatJid, text, groupFolder, timestamp: new Date().toISOString() };
    const tmp = `${filepath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filepath);
  } catch (err) {
    log(`Failed to write security alert: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Security hook: intercepts destructive and exfiltration-prone Bash commands.
 *
 * Blocks:
 *   1. Writes to /workspace/project/src/ or /workspace/project/container/ (self-mutation)
 *   2. rm -rf targeting /workspace/project/src/ or /workspace/project/container/
 *   3. curl/wget to external hosts when NANOCLAW_NETWORK_RESTRICTED=1
 *
 * When blocked: replaces the command with an informative echo AND sends a
 * WhatsApp alert via IPC so the user is notified immediately.
 */
function createSecurityHook(chatJid: string, groupFolder: string): HookCallback {
  const isNetworkRestricted = process.env.NANOCLAW_NETWORK_RESTRICTED === '1';

  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    // ── Check 1: Self-mutation (writes to project source code via shell redirects) ──
    // Targets: echo/printf/cat/tee redirected into src/ or container/ subdirs
    const SELF_MUTATION = /(?:>>?\s*|tee\s+(?:-a\s+)?)['"]?\/workspace\/project\/(?:src|container)\//;
    if (SELF_MUTATION.test(command)) {
      const preview = command.slice(0, 120);
      const alert = `🛡️ *Security Block — Self-Mutation*\n\nAn agent attempted to write to project source code and was blocked.\n\n\`${preview}\`\n\n_Incident logged._`;
      writeSecurityAlert(alert, chatJid, groupFolder);
      log(`[SECURITY] Self-mutation blocked: ${preview}`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            ...(preInput.tool_input as Record<string, unknown>),
            command: `echo "[SECURITY BLOCK] Writing to project source code is not permitted. This incident has been reported."`,
          },
        },
      };
    }

    // ── Check 2: Destructive delete of project source ──────────────────────────
    const hasRm = /\brm\b/.test(command);
    if (hasRm) {
      const hasRecursive = /-[a-zA-Z]*r[a-zA-Z]*\b|--recursive/.test(command);
      const hasForce = /-[a-zA-Z]*f[a-zA-Z]*\b|--force/.test(command);
      const targetsSource = /\/workspace\/project\/(?:src|container)/.test(command);
      if (hasRecursive && hasForce && targetsSource) {
        const preview = command.slice(0, 120);
        const alert = `🛡️ *Security Block — Destructive Delete*\n\nAn agent attempted \`rm -rf\` on project source code and was blocked.\n\n\`${preview}\`\n\n_Incident logged._`;
        writeSecurityAlert(alert, chatJid, groupFolder);
        log(`[SECURITY] Destructive rm blocked: ${preview}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: {
              ...(preInput.tool_input as Record<string, unknown>),
              command: `echo "[SECURITY BLOCK] Recursive force-delete of project source code is not permitted. This incident has been reported."`,
            },
          },
        };
      }
    }

    // ── Check 3: Network exfiltration in restricted containers ─────────────────
    if (isNetworkRestricted) {
      // Match curl/wget/nc with an HTTP/HTTPS/FTP target, excluding api.anthropic.com
      const EXFIL = /\b(?:curl|wget|nc|ncat)\b/;
      const EXTERNAL_URL = /https?:\/\/(?!api\.anthropic\.com)|ftp:\/\//;
      if (EXFIL.test(command) && EXTERNAL_URL.test(command)) {
        const preview = command.slice(0, 120);
        const alert = `🛡️ *Security Block — Network Exfiltration*\n\nAn agent in a restricted container attempted to contact an external host and was blocked.\n\n\`${preview}\`\n\n_Incident logged._`;
        writeSecurityAlert(alert, chatJid, groupFolder);
        log(`[SECURITY] Network exfiltration blocked: ${preview}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: {
              ...(preInput.tool_input as Record<string, unknown>),
              command: `echo "[SECURITY BLOCK] Network access to external hosts is blocked in this container. This incident has been reported."`,
            },
          },
        };
      }
    }

    return {};
  };
}

function createSanitizeBashHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Check if text ends with a sentence boundary
 */
function isSentenceBoundary(text: string): boolean {
  return /[.!?]\s*$/.test(text.trim());
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Buffer for streaming text chunks
  let textBuffer = '';
  const enableStreaming = process.env.NANOCLAW_ENABLE_STREAMING !== '0';
  const minChunkSize = parseInt(process.env.NANOCLAW_MIN_CHUNK_SIZE || '80', 10);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Load persona from dispatch (passed via ContainerInput.personaContent)
  // or from PERSONA.md file. Dispatch personas take precedence.
  const personaMdPath = '/workspace/group/PERSONA.md';
  let personaMd: string | undefined;
  let personaPulseRules: string[] | undefined;
  if (containerInput.personaContent) {
    personaMd = containerInput.personaContent;
    log(`Loaded dispatched persona '${containerInput.personaId}' (${personaMd.length} chars) — injecting into system prompt`);
  } else if (fs.existsSync(personaMdPath)) {
    personaMd = fs.readFileSync(personaMdPath, 'utf-8');
    log(`Loaded PERSONA.md (${personaMd.length} chars) — injecting into system prompt`);
    personaPulseRules = [
      '⚠️ PERSONA REMINDER (Auto-injected — re-read your PERSONA.md rules):',
      '',
      'You MUST follow your PERSONA.md behavioral rules. Key reminders:',
      '• You are an NPA Defense Strategist for the DEBTOR — not a coding assistant',
      '• NO fabrication of case law, judgments, or citations',
      '• NO hype, NO padding — every sentence must add legal value',
      '• Read EVERY document word-to-word before forming any opinion',
      '• Extract verbatim evidence, catalog chronologically',
      '• Play devil\'s advocate — anticipate opponent\'s counter-arguments',
      '• Apply ALL relevant laws, not just the obvious one',
      '• WhatsApp formatting only — no markdown',
      '',
      '--- End Persona Pulse ---',
    ];
  }
  const safetyPulse = new SafetyPulse({}, personaPulseRules);

  // Inject Claw's outreach identity if configured
  const clawName = process.env.CLAW_NAME;
  const clawEmail = process.env.CLAW_EMAIL;
  const clawRedditUser = process.env.CLAW_REDDIT_USER;
  const clawRedditClientId = process.env.CLAW_REDDIT_CLIENT_ID;
  // Secrets come through stdin (containerInput.secrets)
  const clawEmailAppPassword = (containerInput.secrets as Record<string, string> | undefined)?.['CLAW_EMAIL_APP_PASSWORD'] || '';
  const clawRedditPass = (containerInput.secrets as Record<string, string> | undefined)?.['CLAW_REDDIT_PASS'] || '';
  const clawRedditClientSecret = (containerInput.secrets as Record<string, string> | undefined)?.['CLAW_REDDIT_CLIENT_SECRET'] || '';
  if (clawName || clawEmail || clawRedditUser) {
    const identityLines: string[] = ['\n\n## Your Outreach Identity'];
    identityLines.push('You have a separate human-sounding identity for all external communications.');
    identityLines.push('Use this identity — not your own name — for Reddit posts, cold emails, and any public-facing work.');
    if (clawName) identityLines.push(`- **Name**: ${clawName}`);
    if (clawEmail) identityLines.push(`- **Email**: ${clawEmail}${clawEmailAppPassword ? ' (SMTP app password available — use smtplib/nodemailer to send)' : ''}`);
    if (clawRedditUser) {
      identityLines.push(`- **Reddit username**: u/${clawRedditUser}`);
      if (clawRedditPass && clawRedditClientId && clawRedditClientSecret) {
        identityLines.push(`- **Reddit API**: client_id=${clawRedditClientId} — use PRAW (Python) or snoowrap (Node) to post autonomously`);
        identityLines.push(`  \`\`\`python`);
        identityLines.push(`  import praw`);
        identityLines.push(`  reddit = praw.Reddit(client_id='${clawRedditClientId}', client_secret='${clawRedditClientSecret}', username='${clawRedditUser}', password='${clawRedditPass}', user_agent='${clawName || 'Claw'}/1.0')`);
        identityLines.push(`  \`\`\``);
      }
    }
    identityLines.push('Always write as a human professional — never reveal you are an AI unless directly asked.');
    const identityBlock = identityLines.join('\n');
    globalClaudeMd = (globalClaudeMd || '') + identityBlock;
  }

  // Prompt caching configuration
  const enableCaching = process.env.NANOCLAW_ENABLE_PROMPT_CACHING !== '0';

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      ...(containerInput.maxTurns ? { maxTurns: containerInput.maxTurns } : {}),
      systemPrompt: (globalClaudeMd || personaMd)
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: [personaMd, globalClaudeMd].filter(Boolean).join('\n\n') }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      // PERFORMANCE: Prompt caching is enabled automatically by the SDK
      // when using resume (session persistence). The SDK caches:
      // - System prompts (CLAUDE.md files)
      // - Conversation history
      // - Tool definitions
      // Caching can be disabled via NANOCLAW_ENABLE_PROMPT_CACHING=0
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            ...(clawName ? { CLAW_NAME: clawName } : {}),
            ...(clawEmail ? { CLAW_EMAIL: clawEmail } : {}),
            ...(clawRedditUser ? { CLAW_REDDIT_USER: clawRedditUser } : {}),
          },
        },
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook()] }],
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [
            createSanitizeBashHook(),
            createSecurityHook(containerInput.chatJid, containerInput.groupFolder),
          ],
        }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
      // Safety pulse: re-inject safety rules every 5 assistant turns to prevent
      // context-loss-induced rule forgetting during long sessions.
      const pulseMsg = safetyPulse.tick();
      if (pulseMsg) {
        log('[safety-pulse] Injecting safety reminder into stream');
        stream.push(pulseMsg);
      }
    }

    // Streaming: Detect assistant text content and emit partial results
    if (enableStreaming && message.type === 'assistant' && (message as any).message?.content) {
      const content = (message as any).message.content;
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          textBuffer += block.text;

          // Emit chunk if we hit a sentence boundary and meet min size
          if (textBuffer.length >= minChunkSize && isSentenceBoundary(textBuffer)) {
            log(`[streaming] Emitting chunk (${textBuffer.length} chars)`);
            writeOutput({
              status: 'streaming',
              result: textBuffer,
              isPartial: true,
              newSessionId
            });
            textBuffer = '';
          }
        }
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      // Flush any remaining buffered text before the result
      if (textBuffer.length > 0) {
        log(`[streaming] Flushing final buffer (${textBuffer.length} chars)`);
        writeOutput({
          status: 'streaming',
          result: textBuffer,
          isPartial: true,
          newSessionId
        });
        textBuffer = '';
      }

      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      const rawUsage = (message as any).usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      } | undefined;

      writeOutput({
        status: 'success',
        result: textResult || null,
        newSessionId,
        usage: rawUsage ? {
          inputTokens: rawUsage.input_tokens ?? 0,
          outputTokens: rawUsage.output_tokens ?? 0,
          cacheReadTokens: rawUsage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: rawUsage.cache_creation_input_tokens ?? 0,
        } : undefined,
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Build SDK env: merge secrets into process.env for the SDK only.
  // Secrets never touch process.env itself, so Bash subprocesses can't see them.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(containerInput.secrets || {})) {
    sdkEnv[key] = value;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Skip session resume for warmup — fresh start is much faster
  let sessionId = containerInput.maxTurns ? undefined : containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  // Auth errors trigger IPC-based token refresh and in-place retry (no container restart).
  const AUTH_RETRY_MAX = 2;
  let resumeAt: string | undefined;
  try {
    while (true) {
      let authRetries = 0;
      let lastAuthError: string | undefined;

      // Auth-retry loop: on OAuth failure, request fresh token via IPC and retry in-place
      let queryResult: { newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean };
      while (true) {
        try {
          log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

          const hb = startHeartbeat();
          try {
          queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
          } finally { clearInterval(hb); }
          if (queryResult.newSessionId) {
            sessionId = queryResult.newSessionId;
          }
          if (queryResult.lastAssistantUuid) {
            resumeAt = queryResult.lastAssistantUuid;
          }
          break; // Query succeeded — exit auth-retry loop
        } catch (err) {
          if (!isAuthError(err) || authRetries >= AUTH_RETRY_MAX) {
            throw err; // Not auth or exhausted retries — propagate
          }

          authRetries++;
          const errorMessage = err instanceof Error ? err.message : String(err);
          log(`Auth error on attempt ${authRetries}/${AUTH_RETRY_MAX + 1}: ${errorMessage}`);

          // Ask host for a fresh token via IPC
          const currentToken = sdkEnv.CLAUDE_CODE_OAUTH_TOKEN;
          const newToken = await requestTokenRefresh(currentToken);
          if (!newToken) {
            log('No fresh token available — giving up');
            throw err; // Propagate the original auth error
          }

          // Hot-swap the token and retry the query in-place
          sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = newToken;
          log(`Token refreshed, retrying query (attempt ${authRetries + 1})`);
        }
      }

      if (authRetries > 0) {
        log(`Recovered from auth error after ${authRetries} retries`);
      }

      // If maxTurns is set (warmup), exit after the first query — no IPC loop.
      if (containerInput.maxTurns) {
        log(`maxTurns=${containerInput.maxTurns} — exiting after query`);
        writeOutput({ status: 'success', result: null, newSessionId: sessionId });
        process.exit(0);
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
