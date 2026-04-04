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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      logger.error({ err }, 'API server error');
      json(res, 500, { error: String(err) });
    }
  });

  // ── WebSocket ──────────────────────────────────────────────────────────────

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

    ws.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; jid?: string; text?: string; taskId?: string };
        if (msg.type === 'send_message' && msg.jid && msg.text) {
          await sendFn(msg.jid, msg.text);
          send('ack', { type: 'send_message', ok: true });
        } else if (msg.type === 'trigger_task' && msg.taskId) {
          apiEvents.emit('task_trigger_requested', { taskId: msg.taskId });
          send('ack', { type: 'trigger_task', ok: true });
        }
      } catch (err) {
        logger.warn({ err }, 'API WS message parse error');
      }
    });

    ws.on('close', () => {
      clearInterval(ping);
      for (const [event, handler] of Object.entries(handlers)) {
        apiEvents.off(event, handler);
      }
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
