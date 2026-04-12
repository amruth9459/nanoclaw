/**
 * Claw Mobile API Server — REST + WebSocket gateway for the React Native app.
 *
 * Runs alongside DashClaw on a separate port (default 3001).
 * Auth: Bearer token (NANOCLAW_DASH_TOKEN) on all routes.
 * WebSocket: /ws — real-time event stream.
 */

import http from 'http';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
// ws is a transitive dep (Baileys). @types/ws not in package.json, load via createRequire.
const _require = createRequire(import.meta.url);
const wsModule = _require('ws') as {
  Server: new (opts: { server: http.Server; path: string }) => WsServer;
  OPEN: number;
};

interface WsSocket {
  readyState: number;
  send(data: string): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (raw: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
}

interface WsServer {
  on(event: 'connection', cb: (ws: WsSocket, req: http.IncomingMessage) => void): void;
}

import os from 'os';
import fs from 'fs';
import path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';
import { DASH_TOKEN, GROUPS_DIR, ASSISTANT_NAME } from './config.js';
import {
  getAllRegisteredGroups,
  getAllTasks,
  getDb,
  getKanbanItems,
  updateTask,
  createTaskRecord,
} from './db.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import { ResourceOrchestrator } from './resource-orchestrator.js';
import {
  PRESET_COMMANDS,
  validateCommand,
  executeRemoteCommand,
} from './remote-shell.js';
import {
  createElevatedToken,
  validateElevatedToken,
  revokeAllTokens,
  ALLOWED_WORKING_DIRS,
} from './security-config.js';
import { TerminalSession } from './terminal-session.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const API_PORT = parseInt(process.env.NANOCLAW_API_PORT || '3002', 10);
const START_TIME = Date.now();

// ── Event bus ─────────────────────────────────────────────────────────────────
// Call apiEvents.emit(...) from index.ts to push real-time events to WS clients.

export const apiEvents = new EventEmitter();
apiEvents.setMaxListeners(50);

// Event types the bus handles:
// new_message    — { jid, message }
// task_started   — { taskId, groupFolder }
// task_completed — { taskId, groupFolder, result }
// container_event — { jid, event: 'started' | 'stopped' | 'warmup' }
// status_change  — { connected: boolean }

// ── Auth helper ───────────────────────────────────────────────────────────────

function authenticate(req: http.IncomingMessage): boolean {
  if (!DASH_TOKEN) return true; // No token configured — open (dev mode only)
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  return token === DASH_TOKEN;
}

// ── Response helpers ──────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Security-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Route handlers ────────────────────────────────────────────────────────────

function handleStatus(queue: GroupQueue): unknown {
  const groups = getAllRegisteredGroups();
  const detailed = queue.getDetailedStatus();
  const statusMap = new Map(detailed.map((s) => [s.jid, s]));

  const activeContainers = Object.entries(groups).map(([jid, g]) => {
    const qs = statusMap.get(jid);
    return {
      jid,
      name: g.name,
      folder: g.folder,
      active: qs?.active ?? false,
      activeTask: qs?.activeTask ?? false,
      containerName: qs?.containerName ?? null,
      startedAt: qs?.startedAt ?? null,
    };
  });

  return {
    ok: true,
    uptimeMs: Date.now() - START_TIME,
    activeContainers: activeContainers.filter((c) => c.active).length,
    totalGroups: activeContainers.length,
    groups: activeContainers,
  };
}

function handleGroups(): unknown {
  const groups = getAllRegisteredGroups();
  return Object.entries(groups).map(([jid, g]) => ({
    jid,
    name: g.name,
    folder: g.folder,
    trigger: g.trigger,
    requiresTrigger: g.requiresTrigger ?? true,
    displayName: g.displayName ?? null,
    addedAt: g.added_at,
  }));
}

function handleMessages(
  jid: string,
  url: URL,
): unknown {
  const db = getDb();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const before = url.searchParams.get('before') || '';

  const rows = before
    ? db.prepare(
        `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, media_type
         FROM messages WHERE chat_jid = ? AND timestamp < ?
         ORDER BY timestamp DESC LIMIT ?`,
      ).all(jid, before, limit)
    : db.prepare(
        `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, media_type
         FROM messages WHERE chat_jid = ?
         ORDER BY timestamp DESC LIMIT ?`,
      ).all(jid, limit);

  return { messages: (rows as unknown[]).reverse(), total: rows.length };
}

async function handleSendMessage(
  jid: string,
  req: http.IncomingMessage,
  sendFn: (jid: string, text: string) => Promise<void>,
): Promise<unknown> {
  const body = await readBody(req);
  const text = String(body.text || '').trim();
  if (!text) throw new Error('text is required');
  await sendFn(jid, text);
  return { ok: true };
}

function handleTasks(): unknown {
  const tasks = getAllTasks();
  return tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    chatJid: t.chat_jid,
    prompt: t.prompt,
    scheduleType: t.schedule_type,
    scheduleValue: t.schedule_value,
    status: t.status,
    nextRun: t.next_run,
    lastRun: t.last_run,
    lastResult: t.last_result,
  }));
}

function handleUpdateTask(id: string, body: Record<string, unknown>): unknown {
  type TaskUpdates = Parameters<typeof updateTask>[1];
  const updates: TaskUpdates = {};
  if (body.status !== undefined) updates.status = body.status as TaskUpdates['status'];
  if (body.next_run !== undefined) updates.next_run = body.next_run as string;
  updateTask(id, updates);
  return { ok: true };
}

function handleKanban(url: URL): unknown {
  const project = url.searchParams.get('project') || 'nanoclaw';
  const items = getKanbanItems(project);
  return { items, project };
}

async function handleCreateKanban(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  const record = createTaskRecord({
    description: String(body.description || ''),
    complexity: (body.complexity as 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert') || 'moderate',
    priority: typeof body.priority === 'number' ? body.priority : 3,
    project: String(body.project || 'nanoclaw'),
    source: 'user',
  });
  return { ok: true, id: record.id };
}

function handlePlcSites(): unknown {
  try {
    const db = getDb();
    const sites = db.prepare(`SELECT * FROM plc_sites ORDER BY site_name`).all();
    return { sites };
  } catch {
    return { sites: [] };
  }
}

function handlePlcReports(url: URL): unknown {
  try {
    const db = getDb();
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
    const reports = db.prepare(
      `SELECT * FROM plc_daily_reports WHERE date = ? ORDER BY created_at DESC`,
    ).all(date);
    return { reports, date };
  } catch {
    return { reports: [], date: '' };
  }
}

function handlePlcRoster(): unknown {
  try {
    const db = getDb();
    const roster = db.prepare(`SELECT * FROM plc_crew_roster ORDER BY crew_name`).all();
    return { roster };
  } catch {
    return { roster: [] };
  }
}

// ── Shell handlers ────────────────────────────────────────────────────────────

function handleShellPresets(): unknown {
  const presets = Object.entries(PRESET_COMMANDS).map(([key, command]) => {
    const name = key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    let category = 'System';
    if (key.includes('disk') || key.includes('large') || key.includes('space') || key.includes('cache') || key.includes('node_modules') || key.includes('xcode') || key.includes('ios_sim') || key.includes('homebrew') || key.includes('docker_space') || key.includes('downloads')) category = 'Disk';
    else if (key.includes('nanoclaw') || key.includes('container') || key.includes('logs')) category = 'NanoClaw';
    else if (key.includes('wifi') || key.includes('tailscale')) category = 'Network';
    return { key, name, command, category };
  });
  return { presets };
}

async function handleShellExecute(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  let command = String(body.command || '').trim();
  if (!command) throw new Error('command is required');

  const isPreset = Boolean(body.isPreset);
  const workingDir = body.workingDir ? String(body.workingDir) : undefined;

  // Resolve preset key to actual command
  if (isPreset && command in PRESET_COMMANDS) {
    command = PRESET_COMMANDS[command as keyof typeof PRESET_COMMANDS];
  }

  // Non-preset commands require elevated security token
  if (!isPreset) {
    const secToken = req.headers['x-security-token'] as string;
    if (!secToken || !validateElevatedToken(secToken)) {
      return { success: false, output: '', error: 'Security elevation required for custom commands', exitCode: 1, duration: 0 };
    }
  }

  const result = await executeRemoteCommand({
    command,
    workingDir,
    requester: 'mobile-app',
    isPreset,
  });

  return result;
}

function handleShellHistory(): unknown {
  const logPath = path.join(process.cwd(), 'logs', 'remote-shell.log');
  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries = lines.slice(-50).reverse().map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return { entries };
  } catch {
    return { entries: [] };
  }
}

// ── File handlers ─────────────────────────────────────────────────────────────

const FILE_ALLOWED_ROOTS = [process.cwd(), os.homedir()];

function isPathAllowed(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return FILE_ALLOWED_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + '/'),
  );
}

function handleFilesList(url: URL): unknown {
  const dirPath = url.searchParams.get('path') || process.cwd();
  if (!isPathAllowed(dirPath)) {
    throw new Error('Path outside allowed directories');
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => {
    const fullPath = path.join(dirPath, entry.name);
    let size = 0;
    let modified = '';
    try {
      const stat = fs.statSync(fullPath);
      size = stat.size;
      modified = stat.mtime.toISOString();
    } catch { /* skip */ }
    return {
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
      size,
      modified,
    };
  });

  // Sort: directories first, then by name
  entries.sort((a, b) => {
    if (a.type === 'directory' && b.type !== 'directory') return -1;
    if (a.type !== 'directory' && b.type === 'directory') return 1;
    return a.name.localeCompare(b.name);
  });

  return { path: dirPath, entries };
}

function handleFilesRead(url: URL): unknown {
  const filePath = url.searchParams.get('path');
  if (!filePath) throw new Error('path is required');
  if (!isPathAllowed(filePath)) throw new Error('Path outside allowed directories');

  const offset = parseInt(url.searchParams.get('offset') || '0', 10);
  const limit = parseInt(url.searchParams.get('limit') || '2000', 10);

  const stat = fs.statSync(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const sliced = lines.slice(offset, offset + limit).join('\n');

  return {
    path: filePath,
    content: sliced,
    totalLines: lines.length,
    size: stat.size,
    offset,
    limit,
  };
}

async function handleFilesWrite(req: http.IncomingMessage): Promise<unknown> {
  const secToken = req.headers['x-security-token'] as string;
  if (!secToken || !validateElevatedToken(secToken)) {
    throw new Error('Security elevation required to write files');
  }

  const body = await readBody(req);
  const filePath = String(body.path || '').trim();
  const content = String(body.content ?? '');
  if (!filePath) throw new Error('path is required');
  if (!isPathAllowed(filePath)) throw new Error('Path outside allowed directories');

  // Create .bak backup
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, filePath + '.bak');
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  return { ok: true, path: filePath };
}

// ── System handlers ───────────────────────────────────────────────────────────

function handleSystemStats(): unknown {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const loadAvg = os.loadavg();

  return {
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || 'unknown',
      loadAvg1: loadAvg[0],
      loadAvg5: loadAvg[1],
      loadAvg15: loadAvg[2],
      usagePercent: Math.round((loadAvg[0] / cpus.length) * 100),
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem,
      usagePercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    },
    disk: { usagePercent: 0, total: 0, used: 0 }, // filled async below
    uptime: os.uptime(),
  };
}

async function handleSystemStatsAsync(): Promise<unknown> {
  const stats = handleSystemStats() as Record<string, unknown>;

  // Get disk usage via df
  return new Promise((resolve) => {
    exec('df -h / | tail -1', (err, stdout) => {
      if (!err && stdout) {
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 5) {
          stats.disk = {
            total: parts[1],
            used: parts[2],
            available: parts[3],
            usagePercent: parseInt(parts[4], 10) || 0,
          };
        }
      }
      resolve(stats);
    });
  });
}

async function handleSystemContainers(): Promise<unknown> {
  return new Promise((resolve) => {
    exec('docker ps -a --format json 2>/dev/null || container ls -a --format json 2>/dev/null', (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve({ containers: [] });
        return;
      }
      const containers = stdout.trim().split('\n').map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean).map((c: Record<string, string>) => ({
        id: c.ID || c.Id || '',
        name: c.Names || c.Name || '',
        status: c.Status || c.State || '',
        image: c.Image || '',
        createdAt: c.CreatedAt || '',
      }));
      resolve({ containers });
    });
  });
}

async function handleContainerLogs(name: string, tail: number): Promise<unknown> {
  return new Promise((resolve) => {
    exec(`docker logs --tail ${tail} ${name} 2>&1 || container logs --tail ${tail} ${name} 2>&1`, (err, stdout) => {
      resolve({
        containerName: name,
        lines: (stdout || '').trim().split('\n'),
      });
    });
  });
}

async function handleSystemServices(): Promise<unknown> {
  const services: Array<{ name: string; status: string; detail?: string }> = [];

  // Check NanoClaw launchd
  await new Promise<void>((resolve) => {
    exec('launchctl list | grep nanoclaw', (err, stdout) => {
      if (stdout?.includes('nanoclaw')) {
        services.push({ name: 'NanoClaw', status: 'running', detail: 'launchd service active' });
      } else {
        services.push({ name: 'NanoClaw', status: 'stopped' });
      }
      resolve();
    });
  });

  // Check Tailscale
  await new Promise<void>((resolve) => {
    exec('tailscale status --json 2>/dev/null', (err, stdout) => {
      if (!err && stdout) {
        try {
          const ts = JSON.parse(stdout);
          services.push({ name: 'Tailscale', status: ts.BackendState === 'Running' ? 'running' : 'stopped', detail: ts.BackendState });
        } catch {
          services.push({ name: 'Tailscale', status: 'error' });
        }
      } else {
        services.push({ name: 'Tailscale', status: 'stopped' });
      }
      resolve();
    });
  });

  // Check container runtime
  await new Promise<void>((resolve) => {
    exec('docker info --format json 2>/dev/null || container info 2>/dev/null', (err, stdout) => {
      if (!err && stdout) {
        services.push({ name: 'Container Runtime', status: 'running' });
      } else {
        services.push({ name: 'Container Runtime', status: 'stopped' });
      }
      resolve();
    });
  });

  return { services };
}

// ── Security handlers ─────────────────────────────────────────────────────────

async function handleSecurityElevate(req: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  const pin = String(body.pin || '').trim();
  if (!pin) throw new Error('pin is required');

  const result = createElevatedToken(pin);
  if (!result) {
    return { ok: false, error: 'Invalid PIN' };
  }
  return { ok: true, token: result.token, expiresAt: result.expiresAt };
}

// ── Router ────────────────────────────────────────────────────────────────────

export function startApiServer(
  queue: GroupQueue,
  sendFn: (jid: string, text: string) => Promise<void>,
  orchestrator?: ResourceOrchestrator,
): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${API_PORT}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Security-Token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    // Auth — WebSocket upgrade is authed separately below
    if (!authenticate(req)) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    const path = url.pathname;
    const method = req.method || 'GET';

    try {
      // POST /api/auth — token exchange (client just validates token is correct)
      if (path === '/api/auth' && method === 'POST') {
        json(res, 200, { ok: true, assistantName: ASSISTANT_NAME });
        return;
      }

      // GET /api/status
      if (path === '/api/status' && method === 'GET') {
        json(res, 200, handleStatus(queue));
        return;
      }

      // GET /api/groups
      if (path === '/api/groups' && method === 'GET') {
        json(res, 200, handleGroups());
        return;
      }

      // GET /api/groups/:jid/messages  (jid is URL-encoded)
      const msgMatch = path.match(/^\/api\/groups\/(.+)\/messages$/);
      if (msgMatch) {
        const jid = decodeURIComponent(msgMatch[1]);
        if (method === 'GET') {
          json(res, 200, handleMessages(jid, url));
          return;
        }
        if (method === 'POST') {
          const result = await handleSendMessage(jid, req, sendFn);
          json(res, 200, result);
          return;
        }
      }

      // GET /api/tasks
      if (path === '/api/tasks' && method === 'GET') {
        json(res, 200, handleTasks());
        return;
      }

      // POST /api/tasks/:id/trigger | pause | resume
      const taskActionMatch = path.match(/^\/api\/tasks\/(.+)\/(trigger|pause|resume)$/);
      if (taskActionMatch && method === 'POST') {
        const id = decodeURIComponent(taskActionMatch[1]);
        const action = taskActionMatch[2];
        if (action === 'pause') {
          handleUpdateTask(id, { status: 'paused' });
          apiEvents.emit('task_updated', { taskId: id, status: 'paused' });
        } else if (action === 'resume') {
          handleUpdateTask(id, { status: 'active' });
          apiEvents.emit('task_updated', { taskId: id, status: 'active' });
        } else if (action === 'trigger') {
          // Emit so the scheduler picks it up (it polls; for now just ack)
          apiEvents.emit('task_trigger_requested', { taskId: id });
        }
        json(res, 200, { ok: true });
        return;
      }

      // GET /api/kanban
      if (path === '/api/kanban' && method === 'GET') {
        json(res, 200, handleKanban(url));
        return;
      }

      // POST /api/kanban
      if (path === '/api/kanban' && method === 'POST') {
        const result = await handleCreateKanban(req);
        json(res, 201, result);
        return;
      }

      // GET /api/plc/sites
      if (path === '/api/plc/sites' && method === 'GET') {
        json(res, 200, handlePlcSites());
        return;
      }

      // GET /api/plc/reports
      if (path === '/api/plc/reports' && method === 'GET') {
        json(res, 200, handlePlcReports(url));
        return;
      }

      // GET /api/plc/roster
      if (path === '/api/plc/roster' && method === 'GET') {
        json(res, 200, handlePlcRoster());
        return;
      }

      // ── Shell endpoints ──────────────────────────────────────────────────

      // GET /api/shell/presets
      if (path === '/api/shell/presets' && method === 'GET') {
        json(res, 200, handleShellPresets());
        return;
      }

      // POST /api/shell/execute
      if (path === '/api/shell/execute' && method === 'POST') {
        const result = await handleShellExecute(req);
        json(res, 200, result);
        return;
      }

      // GET /api/shell/history
      if (path === '/api/shell/history' && method === 'GET') {
        json(res, 200, handleShellHistory());
        return;
      }

      // ── File endpoints ───────────────────────────────────────────────────

      // GET /api/files/list
      if (path === '/api/files/list' && method === 'GET') {
        json(res, 200, handleFilesList(url));
        return;
      }

      // GET /api/files/read
      if (path === '/api/files/read' && method === 'GET') {
        json(res, 200, handleFilesRead(url));
        return;
      }

      // POST /api/files/write
      if (path === '/api/files/write' && method === 'POST') {
        const result = await handleFilesWrite(req);
        json(res, 200, result);
        return;
      }

      // ── System endpoints ─────────────────────────────────────────────────

      // GET /api/system/stats
      if (path === '/api/system/stats' && method === 'GET') {
        const stats = await handleSystemStatsAsync();
        json(res, 200, stats);
        return;
      }

      // GET /api/system/containers
      if (path === '/api/system/containers' && method === 'GET') {
        const result = await handleSystemContainers();
        json(res, 200, result);
        return;
      }

      // GET /api/system/containers/:name/logs
      const logMatch = path.match(/^\/api\/system\/containers\/(.+)\/logs$/);
      if (logMatch && method === 'GET') {
        const name = decodeURIComponent(logMatch[1]);
        const tail = parseInt(url.searchParams.get('tail') || '100', 10);
        const result = await handleContainerLogs(name, Math.min(tail, 500));
        json(res, 200, result);
        return;
      }

      // GET /api/system/services
      if (path === '/api/system/services' && method === 'GET') {
        const result = await handleSystemServices();
        json(res, 200, result);
        return;
      }

      // ── Security endpoints ───────────────────────────────────────────────

      // POST /api/security/elevate
      if (path === '/api/security/elevate' && method === 'POST') {
        const result = await handleSecurityElevate(req);
        json(res, 200, result);
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error({ err }, 'API server error');
      json(res, 500, { error: String(err) });
    }
  });

  // ── WebSocket ──────────────────────────────────────────────────────────────

  // ── Persistent terminal (shared across all WS clients, last-wins) ────────
  const terminalSession = new TerminalSession();

  const wss = new wsModule.Server({ server, path: '/ws' });

  wss.on('connection', (ws: WsSocket, req: http.IncomingMessage) => {
    // Auth via ?token=... or Authorization header
    const wsUrl = new URL(req.url || '/', `http://localhost:${API_PORT}`);
    const tokenFromQuery = wsUrl.searchParams.get('token') || '';
    const tokenFromHeader = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (DASH_TOKEN && tokenFromQuery !== DASH_TOKEN && tokenFromHeader !== DASH_TOKEN) {
      ws.close(4401, 'Unauthorized');
      return;
    }

    logger.info({ addr: req.socket.remoteAddress }, 'API WebSocket client connected');

    function send(event: string, data: unknown): void {
      if (ws.readyState === wsModule.OPEN) {
        ws.send(JSON.stringify({ event, data, ts: Date.now() }));
      }
    }

    // Forward bus events to this client
    const handlers: Record<string, (data: unknown) => void> = {
      new_message:      (d) => send('new_message', d),
      task_started:     (d) => send('task_started', d),
      task_completed:   (d) => send('task_completed', d),
      task_updated:     (d) => send('task_updated', d),
      container_event:  (d) => send('container_event', d),
      status_change:    (d) => send('status_change', d),
    };

    for (const [event, handler] of Object.entries(handlers)) {
      apiEvents.on(event, handler);
    }

    // Heartbeat
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30_000);

    // Container log streaming
    let logProcess: ChildProcess | null = null;

    ws.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; jid?: string; text?: string; taskId?: string; containerName?: string };
        if (msg.type === 'send_message' && msg.jid && msg.text) {
          await sendFn(msg.jid, msg.text);
          send('ack', { type: 'send_message', ok: true });
        } else if (msg.type === 'trigger_task' && msg.taskId) {
          apiEvents.emit('task_trigger_requested', { taskId: msg.taskId });
          send('ack', { type: 'trigger_task', ok: true });
        } else if (msg.type === 'subscribe_container_logs' && msg.containerName) {
          // Kill any existing log stream
          if (logProcess) { logProcess.kill(); logProcess = null; }
          const name = msg.containerName.replace(/[^a-zA-Z0-9_.-]/g, '');
          logProcess = spawn('docker', ['logs', '-f', '--tail', '100', name], { stdio: ['ignore', 'pipe', 'pipe'] });
          const onData = (chunk: Buffer) => {
            const lines = chunk.toString().split('\n').filter(Boolean);
            for (const line of lines) {
              send('container_log', { containerName: name, line });
            }
          };
          logProcess.stdout?.on('data', onData);
          logProcess.stderr?.on('data', onData);
          logProcess.on('close', () => { logProcess = null; });
          send('ack', { type: 'subscribe_container_logs', ok: true });
        } else if (msg.type === 'unsubscribe_container_logs') {
          if (logProcess) { logProcess.kill(); logProcess = null; }
          send('ack', { type: 'unsubscribe_container_logs', ok: true });

        // ── Terminal messages ──────────────────────────────────────────────
        } else if (msg.type === 'start_terminal') {
          const secToken = (msg as Record<string, unknown>).securityToken as string;
          if (!secToken || !validateElevatedToken(secToken)) {
            send('terminal_error', { error: 'Security elevation required' });
          } else {
            const cols = (msg as Record<string, unknown>).cols as number || 80;
            const rows = (msg as Record<string, unknown>).rows as number || 24;
            try {
              // Wire up output before starting (start may emit immediately)
              terminalSession.removeAllListeners();
              terminalSession.on('data', (data: string) => send('terminal_output', { data }));
              terminalSession.on('exit', (info: unknown) => send('terminal_exit', info));
              terminalSession.start(cols, rows);
              send('ack', { type: 'start_terminal', ok: true });
            } catch (err) {
              send('terminal_error', { error: String(err) });
            }
          }
        } else if (msg.type === 'terminal_input') {
          const data = (msg as Record<string, unknown>).data as string;
          if (data && terminalSession.active) {
            terminalSession.write(data);
          }
        } else if (msg.type === 'terminal_resize') {
          const cols = (msg as Record<string, unknown>).cols as number;
          const rows = (msg as Record<string, unknown>).rows as number;
          if (cols && rows && terminalSession.active) {
            terminalSession.resize(cols, rows);
          }
        } else if (msg.type === 'stop_terminal') {
          terminalSession.stop();
          send('ack', { type: 'stop_terminal', ok: true });
        }
      } catch (err) {
        logger.warn({ err }, 'API WS message parse error');
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      if (logProcess) { logProcess.kill(); logProcess = null; }
      for (const [event, handler] of Object.entries(handlers)) {
        apiEvents.off(event, handler);
      }
      // Remove terminal listeners for this client (tmux session persists)
      terminalSession.removeAllListeners();
      logger.info('API WebSocket client disconnected');
    });
  });

  server.listen(API_PORT, '0.0.0.0', () => {
    logger.info({ port: API_PORT }, 'Claw API server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'API server error');
  });
}
