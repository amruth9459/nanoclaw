/**
 * Claw API client — thin wrapper around the NanoClaw REST + WebSocket API.
 * Base URL and token are configurable via Settings screen.
 */

export const DEFAULT_BASE_URL = 'http://100.116.199.120:3002';

let baseUrl = DEFAULT_BASE_URL;
let token = '';

export function configure(url: string, t: string) {
  baseUrl = url.replace(/\/$/, '');
  token = t;
}

/** Expose current connection config for WebSocket-based screens (e.g. terminal) */
export function getConnectionConfig(): { baseUrl: string; token: string; wsUrl: string } {
  return {
    baseUrl,
    token,
    wsUrl: `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`,
  };
}

// ── Theme ────────────────────────────────────────────────────────────────────

export const theme = {
  primary: '#C15F3C',
  bg: '#F4F3EE',
  bgSecondary: '#ECEAE3',
  bgInput: '#FFFFFF',
  textPrimary: '#1A1A1A',
  textSecondary: '#6B6560',
  textTertiary: '#9C958E',
  bubbleUser: '#C15F3C',
  bubbleBot: '#FFFFFF',
  border: '#E4E1D8',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
} as const;

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Group {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requiresTrigger: boolean;
  displayName: string | null;
  addedAt: string;
}

export interface Message {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
  media_type: string | null;
}

export interface Task {
  id: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  status: string;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
}

export interface KanbanItem {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  source: string;
  project: string;
  priority: number;
  createdAt: string;
}

export interface ServiceStatus {
  ok: boolean;
  uptimeMs: number;
  activeContainers: number;
  totalGroups: number;
  groups: Array<{
    jid: string;
    name: string;
    folder: string;
    active: boolean;
    activeTask: boolean;
    containerName: string | null;
    startedAt: number | null;
  }>;
}

// ── Shell types ────────────────────────────────────────────────────────────────

export interface ShellPreset {
  key: string;
  name: string;
  command: string;
  category: string;
}

export interface ShellResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  duration: number;
}

// ── File types ─────────────────────────────────────────────────────────────────

export interface FileEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: string;
}

export interface FileReadResult {
  path: string;
  content: string;
  totalLines: number;
  size: number;
  offset: number;
  limit: number;
}

// ── System types ───────────────────────────────────────────────────────────────

export interface SystemStats {
  cpu: { cores: number; model: string; loadAvg1: number; loadAvg5: number; loadAvg15: number; usagePercent: number };
  memory: { total: number; free: number; used: number; usagePercent: number };
  disk: { total: string; used: string; available: string; usagePercent: number };
  uptime: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  image: string;
  createdAt: string;
}

export interface ServiceHealth {
  name: string;
  status: 'running' | 'stopped' | 'error';
  detail?: string;
}

// ── Security types ─────────────────────────────────────────────────────────────

export interface ElevationResult {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  error?: string;
}

// ── Endpoints ──────────────────────────────────────────────────────────────────

export const api = {
  auth: () =>
    request<{ ok: boolean; assistantName: string }>('/api/auth', { method: 'POST' }),

  status: () => request<ServiceStatus>('/api/status'),

  groups: () => request<Group[]>('/api/groups'),

  messages: (jid: string, limit = 50, before?: string) =>
    request<{ messages: Message[]; total: number }>(
      `/api/groups/${encodeURIComponent(jid)}/messages?limit=${limit}${before ? `&before=${before}` : ''}`,
    ),

  sendMessage: (jid: string, text: string) =>
    request<{ ok: boolean }>(`/api/groups/${encodeURIComponent(jid)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  tasks: () => request<Task[]>('/api/tasks'),

  pauseTask: (id: string) =>
    request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/pause`, { method: 'POST' }),

  resumeTask: (id: string) =>
    request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/resume`, { method: 'POST' }),

  triggerTask: (id: string) =>
    request<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/trigger`, { method: 'POST' }),

  kanban: (project = 'nanoclaw') =>
    request<{ items: KanbanItem[]; project: string }>(`/api/kanban?project=${project}`),

  createKanbanItem: (description: string, project = 'nanoclaw') =>
    request<{ ok: boolean; id: string }>('/api/kanban', {
      method: 'POST',
      body: JSON.stringify({ description, project }),
    }),

  plcSites: () => request<{ sites: unknown[] }>('/api/plc/sites'),
  plcReports: (date?: string) =>
    request<{ reports: unknown[]; date: string }>(`/api/plc/reports${date ? `?date=${date}` : ''}`),
  plcRoster: () => request<{ roster: unknown[] }>('/api/plc/roster'),

  // ── Shell ──────────────────────────────────────────────────────────────────
  shellPresets: () =>
    request<{ presets: ShellPreset[] }>('/api/shell/presets'),

  shellExecute: (command: string, isPreset = false, workingDir?: string, securityToken?: string) =>
    request<ShellResult>('/api/shell/execute', {
      method: 'POST',
      body: JSON.stringify({ command, isPreset, workingDir }),
      headers: securityToken ? { 'X-Security-Token': securityToken } : undefined,
    }),

  shellHistory: () =>
    request<{ entries: Array<{ timestamp: string; command: string; requester: string; success: boolean; exitCode: number; duration: number }> }>('/api/shell/history'),

  // ── Files ──────────────────────────────────────────────────────────────────
  filesList: (dirPath?: string) =>
    request<{ path: string; entries: FileEntry[] }>(`/api/files/list${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`),

  filesRead: (filePath: string, offset = 0, limit = 2000) =>
    request<FileReadResult>(`/api/files/read?path=${encodeURIComponent(filePath)}&offset=${offset}&limit=${limit}`),

  filesWrite: (filePath: string, content: string, securityToken: string) =>
    request<{ ok: boolean; path: string }>('/api/files/write', {
      method: 'POST',
      body: JSON.stringify({ path: filePath, content }),
      headers: { 'X-Security-Token': securityToken },
    }),

  // ── System ─────────────────────────────────────────────────────────────────
  systemStats: () =>
    request<SystemStats>('/api/system/stats'),

  systemContainers: () =>
    request<{ containers: ContainerInfo[] }>('/api/system/containers'),

  systemContainerLogs: (name: string, tail = 100) =>
    request<{ containerName: string; lines: string[] }>(`/api/system/containers/${encodeURIComponent(name)}/logs?tail=${tail}`),

  systemServices: () =>
    request<{ services: ServiceHealth[] }>('/api/system/services'),

  // ── Terminal ───────────────────────────────────────────────────────────────
  terminalSessions: () =>
    request<{ sessions: Array<{ name: string; windows: number; created: string; attached: boolean; size: string }> }>('/api/terminal/sessions'),

  // ── Security ───────────────────────────────────────────────────────────────
  securityElevate: (pin: string) =>
    request<ElevationResult>('/api/security/elevate', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),
};

// ── WebSocket ──────────────────────────────────────────────────────────────────

export type WsEvent =
  | { event: 'new_message'; data: { jid: string; message: Message }; ts: number }
  | { event: 'task_started'; data: { taskId: string; groupFolder: string }; ts: number }
  | { event: 'task_completed'; data: { taskId: string; groupFolder: string; result: string }; ts: number }
  | { event: 'container_event'; data: { jid: string; event: string }; ts: number }
  | { event: 'status_change'; data: { connected: boolean }; ts: number }
  | { event: 'container_log'; data: { containerName: string; line: string }; ts: number }
  | { event: 'ack'; data: unknown; ts: number };

type WsHandler = (event: WsEvent) => void;

export function connectWebSocket(onEvent: WsHandler): () => void {
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data as string) as WsEvent;
        onEvent(parsed);
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      if (!stopped) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}
