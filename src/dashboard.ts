/**
 * DashClaw — local-only web dashboard on port 8080.
 * Shows active containers, tasks, groups, HITL events, security log, and memory files.
 * Integrated into the main NanoClaw process — call startDashboard() from main().
 */

import fs from 'fs';
import http from 'http';
import path from 'path';

import { DASH_TOKEN, GROUPS_DIR } from './config.js';
import {
  getAllRegisteredGroups,
  getAllTasks,
  getDb,
  getKanbanItems,
  createTaskRecord,
  updateTaskRecord,
  syncKanbanFile,
} from './db.js';
import { getIntegrations } from './integration-loader.js';
import { logger } from './logger.js';
import { observerGuard } from './observer-guard.js';
import { GroupQueue } from './group-queue.js';
import { ResourceOrchestrator } from './resource-orchestrator.js';
import type { UniversalRouter } from './router/index.js';
import { routeNotification } from './notification-router.js';
import { getIndexStats } from './semantic-index.js';
import { getCurrentThroughput, getHourlyThroughput } from './throughput-monitor.js';
import { getActiveAlerts, acknowledgeAlert } from './throughput-alerts.js';
import { getAgentGraphData, getBlastRadiusData } from './agent-graph/api.js';
import type { BlastDirection } from './agent-graph/blast-radius.js';

const PORT = parseInt(process.env.DASHCLAW_PORT || '8080', 10);
const LOG_PATH = path.join(process.cwd(), 'logs', 'nanoclaw.log');

// ── Rate Limiter ─────────────────────────────────────────────────────────────

class RateLimiter {
  private requests = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  check(jid: string): { allowed: boolean; remaining: number; resetMs: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const timestamps = (this.requests.get(jid) || []).filter(t => t > cutoff);

    if (timestamps.length >= this.limit) {
      const oldestTs = timestamps[0];
      return {
        allowed: false,
        remaining: 0,
        resetMs: oldestTs + this.windowMs - now,
      };
    }

    timestamps.push(now);
    this.requests.set(jid, timestamps);

    return {
      allowed: true,
      remaining: this.limit - timestamps.length,
      resetMs: this.windowMs,
    };
  }

  cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [jid, timestamps] of this.requests.entries()) {
      const filtered = timestamps.filter(t => t > cutoff);
      if (filtered.length === 0) {
        this.requests.delete(jid);
      } else {
        this.requests.set(jid, filtered);
      }
    }
  }
}

// 5 messages per minute per JID
const sendRateLimiter = new RateLimiter(5, 60_000);
setInterval(() => sendRateLimiter.cleanup(), 5 * 60_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

function readLogTail(n = 200): string[] {
  try {
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    return content.split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function parseSecurityEvents(lines: string[]): Array<{ time: string; event: string; detail: string }> {
  const events: Array<{ time: string; event: string; detail: string }> = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const msg: string = obj.msg || '';
      if (/HITL|SECURITY BLOCK|Unauthorized IPC|security/i.test(msg)) {
        events.push({
          time: obj.time || '',
          event: msg.includes('HITL') ? 'HITL' : msg.includes('SECURITY') ? 'Security Block' : 'Auth',
          detail: msg,
        });
      }
    } catch { /* non-JSON log line */ }
  }
  return events.slice(-50);
}

function readMemoryFile(groupFolder: string, filename: string): string {
  const p = path.join(GROUPS_DIR, groupFolder, filename);
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

export function listGroupFiles(groupFolder: string): Array<{ path: string; size: number; mtime: string }> {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const results: Array<{ path: string; size: number; mtime: string }> = [];
  const SKIP_DIRS = new Set(['logs', 'conversations', '.git', 'node_modules', 'ipc', 'ggml', 'gguf']);
  const TEXT_EXTS = new Set([
    '.md', '.txt', '.json', '.js', '.ts', '.sh', '.csv',
    '.html', '.yaml', '.yml', '.py', '.toml', '.sql', '.xml',
    '.log', '.env', '.email', '.mjs', '.cjs',
    '.pdf',
  ]);

  function scan(dir: string, prefix: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          scan(full, rel);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!TEXT_EXTS.has(ext)) continue;
          try {
            const stat = fs.statSync(full);
            results.push({ path: rel, size: stat.size, mtime: stat.mtime.toISOString() });
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }
  scan(groupDir, '');
  results.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return results;
}

function getGroupLogs(groupFolder: string): string[] {
  const logsDir = path.join(GROUPS_DIR, groupFolder, 'logs');
  try {
    return fs.readdirSync(logsDir)
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 5);
  } catch { return []; }
}

// ── API handlers ───────────────────────────────────────────────────────────────

function apiStatus(queue: GroupQueue) {
  const groups = getAllRegisteredGroups();
  const tasks = getAllTasks();
  const logLines = readLogTail(500);
  const secEvents = parseSecurityEvents(logLines);

  const detailedStatus = queue.getDetailedStatus();
  const statusMap = new Map(detailedStatus.map(s => [s.jid, s]));

  const activeContainers = Object.entries(groups).map(([jid, g]) => {
    const qs = statusMap.get(jid);
    return {
      jid,
      name: g.name,
      folder: g.folder,
      hasActiveContainer: queue.isActive(jid),
      active: qs?.active ?? false,
      activeTask: qs?.activeTask ?? false,
      isWarmup: qs?.isWarmup ?? false,
      containerName: qs?.containerName ?? null,
      pendingMessages: qs?.pendingMessages ?? false,
      pendingTaskCount: qs?.pendingTaskCount ?? 0,
      spawnReason: qs?.spawnReason ?? null,
      taskSpawnReason: qs?.taskSpawnReason ?? null,
      startedAt: qs?.startedAt ?? null,
      taskStartedAt: qs?.taskStartedAt ?? null,
      designation: qs?.designation ?? null,
      taskDesignation: qs?.taskDesignation ?? null,
    };
  });

  const recentErrors = logLines
    .filter(l => { try { const o = JSON.parse(l); return o.level >= 50; } catch { return false; } })
    .slice(-20)
    .map(l => { try { const o = JSON.parse(l); return { time: o.time, msg: o.msg }; } catch { return null; } })
    .filter(Boolean);

  const indexStats = getIndexStats();

  return {
    groups: activeContainers,
    indexStats,
    tasks: tasks.map(t => ({
      id: t.id,
      group: t.group_folder,
      schedule: `${t.schedule_type}:${t.schedule_value}`,
      status: t.status,
      nextRun: t.next_run,
      lastRun: t.last_run,
    })),
    securityEvents: secEvents,
    recentErrors,
    logLines: logLines.slice(-100),
    observerGuard: observerGuard.getStats(),
  };
}

// ── HTML ──────────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DashClaw</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --border: #1e1e2e;
    --accent: #7c3aed;
    --accent2: #06b6d4;
    --green: #10b981;
    --red: #ef4444;
    --yellow: #f59e0b;
    --text: #e2e8f0;
    --muted: #64748b;
    --mono: 'JetBrains Mono', 'Fira Code', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; min-height: 100vh; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 1rem 1.5rem; display: flex; align-items: center; gap: 1rem; }
  header h1 { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
  header h1 span { color: var(--accent); }
  .pill { padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .pill.green { background: #052e16; color: var(--green); border: 1px solid #166534; }
  .pill.red { background: #450a0a; color: var(--red); border: 1px solid #991b1b; }
  .pill.yellow { background: #451a03; color: var(--yellow); border: 1px solid #92400e; }
  .refresh { margin-left: auto; font-size: 0.8rem; color: var(--muted); }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; padding: 1rem 1.5rem; max-width: 1400px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; padding: 0.75rem; } }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1rem; }
  .card.full { grid-column: 1 / -1; }
  .card h2 { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; padding: 0.4rem 0.5rem; color: var(--muted); font-weight: 500; font-size: 0.75rem; border-bottom: 1px solid var(--border); }
  td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #0d0d14; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: var(--mono); font-size: 0.78rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .dot.green { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .dot.red { background: var(--red); }
  .dot.yellow { background: var(--yellow); }
  .log-box { background: #07070d; border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.75rem; font-family: var(--mono); font-size: 0.72rem; color: #94a3b8; max-height: 280px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
  .event-row td:first-child { color: var(--yellow); }
  .event-row.hitl td:first-child { color: var(--accent2); }
  .event-row.block td:first-child { color: var(--red); }
  .memory-tabs { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; align-items: center; }
  .tab { padding: 0.3rem 0.75rem; border-radius: 0.375rem; font-size: 0.78rem; cursor: pointer; background: var(--bg); border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .tab.active { background: var(--accent); color: white; border-color: var(--accent); }
  .memory-content { background: #07070d; border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.75rem; font-family: var(--mono); font-size: 0.75rem; color: #94a3b8; max-height: 320px; overflow-y: auto; white-space: pre-wrap; }
  .empty { color: var(--muted); font-size: 0.82rem; padding: 0.5rem 0; }
  #live-dot { animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  /* Files tab: side-by-side on desktop, stacked on mobile */
  #files-layout { display: grid; grid-template-columns: 280px 1fr; gap: 1rem; }
  @media (max-width: 700px) {
    #files-layout { grid-template-columns: 1fr; }
    #file-list { max-height: 35vh !important; }
    #file-viewer { max-height: none !important; min-height: 55vh !important; }
    header h1 { font-size: 1rem; }
    header { padding: 0.75rem 1rem; }
    .tab { padding: 0.25rem 0.5rem; font-size: 0.72rem; }
    td, th { padding: 0.3rem 0.3rem; font-size: 0.75rem; }
    .card { padding: 0.75rem; }
    .log-box { max-height: 180px; }
  }
</style>
</head>
<body>
<header>
  <h1>Dash<span>Claw</span></h1>
  <span class="pill green"><span class="dot green" id="live-dot"></span> &nbsp;Live</span>
  <span class="refresh" id="refresh-label">Refreshing every 10s</span>
</header>
<main id="main">
  <div class="card full"><p class="empty">Loading...</p></div>
</main>

<script>
let memTab = 'global/MEMORY.md';
let dashTab = 'overview'; // 'overview' | 'kanban' | 'files' | 'router' | integration tabs

function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function renderEvent(e) {
  const cls = e.event === 'HITL' ? 'hitl' : e.event === 'Security Block' ? 'block' : '';
  return \`<tr class="event-row \${cls}"><td>\${e.event}</td><td class="mono">\${e.time ? new Date(e.time).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : ''}</td><td>\${e.detail.slice(0,80)}</td></tr>\`;
}

function agentStatus(g) {
  var parts = [];
  if (g.isWarmup) parts.push('<span class="dot yellow"></span> Warmup');
  else if (g.active) parts.push('<span class="dot green"></span> Message');
  if (g.activeTask) parts.push('<span class="dot" style="background:#60a5fa"></span> Task');
  if (parts.length === 0) parts.push('<span class="dot red"></span> Idle');
  return parts.join(' + ');
}

function agentQueue(g) {
  var parts = [];
  if (g.pendingMessages) parts.push('msgs');
  if (g.pendingTaskCount > 0) parts.push(g.pendingTaskCount + ' task' + (g.pendingTaskCount > 1 ? 's' : ''));
  return parts.length ? parts.join(', ') : '—';
}

function elapsed(startMs) {
  if (!startMs) return '';
  var sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return sec + 's';
  var min = Math.floor(sec / 60);
  sec = sec % 60;
  return min + 'm ' + sec + 's';
}

function designationBadge(g) {
  var d = g.designation || g.taskDesignation;
  if (!d) return '<span style="color:var(--muted);font-size:0.7rem">—</span>';
  var colors = { conversation: 'var(--green)', task: '#60a5fa', bounty: '#f59e0b', guest: '#a78bfa', warmup: 'var(--yellow)', indexing: '#6b7280', judge: '#ef4444' };
  return '<span class="pill" style="background:' + (colors[d] || 'var(--muted)') + ';color:#fff;font-size:0.65rem">' + d + '</span>';
}

function agentReason(g) {
  var parts = [];
  if (g.spawnReason) {
    var t = elapsed(g.startedAt);
    parts.push((g.spawnReason.length > 80 ? g.spawnReason.slice(0, 80) + '…' : g.spawnReason) + (t ? ' <span class="mono" style="color:var(--muted);font-size:0.7rem">(' + t + ')</span>' : ''));
  }
  if (g.taskSpawnReason) {
    var t2 = elapsed(g.taskStartedAt);
    parts.push('<span style="color:#60a5fa">⏰</span> ' + (g.taskSpawnReason.length > 80 ? g.taskSpawnReason.slice(0, 80) + '…' : g.taskSpawnReason) + (t2 ? ' <span class="mono" style="color:var(--muted);font-size:0.7rem">(' + t2 + ')</span>' : ''));
  }
  return parts.length ? parts.join('<br>') : '—';
}

function tabBar() {
  var tabs = ['overview', 'kanban', 'files'].concat(window._integrationTabIds || []).concat(['router']);
  var labels = Object.assign({ overview: 'Overview', kanban: 'Kanban', files: 'Files', router: 'Router' }, window._integrationTabLabels || {});
  return tabs.map(function(t) {
    return '<span class="tab' + (dashTab === t ? ' active' : '') + '" onclick="dashTab=\\'' + t + '\\';refresh()">' + labels[t] + '</span>';
  }).join('') + '<a class="tab" href="/agent-graph" style="text-decoration:none">Agent Graph &#8599;</a>';
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function fileTypeInfo(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  if (ext === 'md') return { label: 'MD', color: '#7c3aed', group: 0 };
  if (ext === 'txt') return { label: 'TXT', color: '#6b7280', group: 0 };
  if (ext === 'py') return { label: 'PY', color: '#16a34a', group: 1 };
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') return { label: 'JS', color: '#d97706', group: 1 };
  if (ext === 'sh') return { label: 'SH', color: '#b45309', group: 1 };
  if (ext === 'ts') return { label: 'TS', color: '#0284c7', group: 1 };
  if (ext === 'json') return { label: 'JSON', color: '#0369a1', group: 2 };
  if (ext === 'csv') return { label: 'CSV', color: '#0369a1', group: 2 };
  if (ext === 'html') return { label: 'HTML', color: '#dc2626', group: 1 };
  if (ext === 'sql') return { label: 'SQL', color: '#0891b2', group: 2 };
  return { label: ext.toUpperCase(), color: '#6b7280', group: 3 };
}

function renderFileSection(label, sectionFiles) {
  if (sectionFiles.length === 0) return '';
  // Note: use \\ before ' inside template-literal-embedded JS so TS emits \' in browser JS
  const items = sectionFiles.map(function(f) {
    const parts = f.path.split('/');
    const basename = parts[parts.length - 1];
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
    const t = fileTypeInfo(f.path);
    // data-path holds the raw path; onclick reads it back via this.dataset.path (browser decodes HTML entities)
    return '<div class="file-entry" data-path="' + escHtml(f.path) + '" onclick="openGroupFile(\\'main\\', this.dataset.path)" style="display:flex;align-items:flex-start;gap:0.5rem;padding:0.4rem 0.5rem;border-radius:0.25rem;cursor:pointer;border-bottom:1px solid #0d0d14" onmouseover="this.style.background=\\'#1e1e2e\\'" onmouseout="this.style.background=\\'\\'">'+
      '<span style="flex-shrink:0;font-size:0.6rem;font-weight:700;padding:0.1rem 0.3rem;border-radius:3px;background:' + t.color + '22;color:' + t.color + ';margin-top:0.15rem">' + t.label + '</span>' +
      '<div style="min-width:0;flex:1">' +
        '<div style="font-size:0.77rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + escHtml(f.path) + '">' + escHtml(basename) + '</div>' +
        (dir ? '<div style="font-size:0.64rem;color:var(--muted)">' + escHtml(dir) + '</div>' : '') +
      '</div>' +
      '<div style="flex-shrink:0;font-size:0.63rem;color:var(--muted);white-space:nowrap">' + fmtSize(f.size) + '</div>' +
    '</div>';
  }).join('');
  return '<div style="padding:0.3rem 0.5rem;font-size:0.68rem;color:var(--muted);font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-top:0.5rem;border-bottom:1px solid #1a1a2e">' + label + ' <span style="font-weight:400;opacity:0.7">(' + sectionFiles.length + ')</span></div>' + items;
}

function renderMd(raw) {
  // Line-by-line renderer: avoids regex escape sequences that break in TS template literals
  const lines = raw.split('\\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let s = escHtml(lines[i]);
    if (s.startsWith('### ')) { out.push('<h3 style="font-size:0.9rem;color:var(--accent2);margin:0.5rem 0 0.2rem">' + s.slice(4) + '</h3>'); continue; }
    if (s.startsWith('## ')) { out.push('<h2 style="font-size:1rem;color:var(--accent);margin:0.7rem 0 0.3rem">' + s.slice(3) + '</h2>'); continue; }
    if (s.startsWith('# ')) { out.push('<h1 style="font-size:1.15rem;font-weight:700;margin:0.9rem 0 0.4rem">' + s.slice(2) + '</h1>'); continue; }
    if (s === '---' || s === '----' || s === '-----') { out.push('<hr style="border-color:var(--border);margin:0.6rem 0">'); continue; }
    if (s.startsWith('- ') || s.startsWith('* ')) { out.push('<li style="margin-left:1.5rem;margin-bottom:0.15rem">' + bolden(s.slice(2)) + '</li>'); continue; }
    if (!s) { out.push('<div style="height:0.4rem"></div>'); continue; }
    out.push('<p style="margin:0.2rem 0 0.3rem">' + bolden(s) + '</p>');
  }
  return out.join('');
}
function bolden(s) {
  // Replace **text** with bold using indexOf (no regex needed)
  let r = '';
  while (true) {
    const a = s.indexOf('**');
    if (a === -1) { r += s; break; }
    const b = s.indexOf('**', a + 2);
    if (b === -1) { r += s; break; }
    r += s.slice(0, a) + '<strong>' + s.slice(a + 2, b) + '</strong>';
    s = s.slice(b + 2);
  }
  return r;
}

async function openGroupFile(group, filePath) {
  const viewer = document.getElementById('file-viewer');
  if (!viewer) return;
  document.querySelectorAll('.file-entry').forEach(function(el) { el.style.background = ''; });
  const entry = document.querySelector('.file-entry[data-path="' + filePath + '"]');
  if (entry) entry.style.background = '#1a1a2e';
  const ext = filePath.split('.').pop().toLowerCase();
  const viewUrl = '/files/view?group=' + group + '&path=' + encodeURIComponent(filePath);
  const header = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;padding-bottom:0.5rem;border-bottom:1px solid var(--border)">' +
    '<span style="font-size:0.75rem;color:var(--muted);font-family:var(--mono)">' + escHtml(filePath) + '</span>' +
    '<a href="' + viewUrl + '" target="_blank" style="font-size:0.7rem;color:var(--accent2);text-decoration:none;flex-shrink:0">↗ Open in tab</a>' +
    '</div>';
  // PDF and HTML: render inline via iframe
  if (ext === 'pdf' || ext === 'html' || ext === 'htm') {
    viewer.innerHTML = header +
      '<iframe src="' + viewUrl + '" style="width:100%;height:calc(100vh - 280px);min-height:400px;border:1px solid var(--border);border-radius:0.375rem;background:white"></iframe>';
    return;
  }
  viewer.innerHTML = header + '<p class="empty" style="padding:0.5rem">Loading...</p>';
  try {
    const resp = await fetch('/api/file?group=' + group + '&path=' + encodeURIComponent(filePath));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const content = await resp.text();
    if (ext === 'md') {
      viewer.innerHTML = header + '<div style="line-height:1.65">' + renderMd(content) + '</div>';
    } else {
      viewer.innerHTML = header + '<pre style="white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:0.75rem;color:#94a3b8">' + escHtml(content) + '</pre>';
    }
  } catch(err) {
    viewer.innerHTML = header + '<p style="color:var(--red);padding:0.5rem">Error: ' + escHtml(err.message) + '</p>';
  }
}

function filterFileList(query) {
  const q = query.toLowerCase();
  document.querySelectorAll('.file-entry').forEach(function(el) {
    el.style.display = (el.dataset.path || '').toLowerCase().includes(q) ? '' : 'none';
  });
}

async function refreshFiles() {
  try {
    const filesData = await fetch('/api/files?group=main').then(r => r.json());
    const files = filesData.files || [];
    document.getElementById('main').innerHTML = \`
      <div class="card full" style="margin-bottom:0.5rem">
        <div class="memory-tabs">\${tabBar()}</div>
      </div>
      <div class="card full" style="padding:0.75rem">
        <div id="files-layout" style="align-items:start">
          <div>
            <input id="file-search" type="text" placeholder="Filter files…"
              style="width:100%;box-sizing:border-box;background:#07070d;border:1px solid var(--border);border-radius:0.375rem;padding:0.35rem 0.6rem;color:var(--text);font-size:0.78rem;outline:none;margin-bottom:0.4rem"
              oninput="filterFileList(this.value)">
            <div id="file-list" style="max-height:calc(100vh - 240px);overflow-y:auto;border:1px solid var(--border);border-radius:0.4rem">
              \${files.length === 0 ? '<p class="empty">No files found in groups/main/</p>' : (function() {
                const pdfs = files.filter(f => f.path.split('.').pop().toLowerCase() === 'pdf');
                const docs = files.filter(f => { const e = f.path.split('.').pop().toLowerCase(); return e === 'md' || e === 'txt'; });
                const web = files.filter(f => { const e = f.path.split('.').pop().toLowerCase(); return e === 'html' || e === 'htm'; });
                const scripts = files.filter(f => { const e = f.path.split('.').pop().toLowerCase(); return ['py','js','mjs','cjs','sh','ts'].includes(e); });
                const data = files.filter(f => { const e = f.path.split('.').pop().toLowerCase(); return ['json','csv','sql','xml','yaml','yml'].includes(e); });
                const other = files.filter(f => { const e = f.path.split('.').pop().toLowerCase(); return !['pdf','md','txt','html','htm','py','js','mjs','cjs','sh','ts','json','csv','sql','xml','yaml','yml'].includes(e); });
                return renderFileSection('📄 PDFs', pdfs) + renderFileSection('🌐 Web', web) + renderFileSection('📝 Documents', docs) + renderFileSection('🔧 Scripts', scripts) + renderFileSection('📊 Data', data) + renderFileSection('📁 Other', other);
              })()}
            </div>
          </div>
          <div id="file-viewer" style="background:#07070d;border:1px solid var(--border);border-radius:0.5rem;padding:1rem;min-height:300px;max-height:calc(100vh - 180px);overflow-y:auto;font-size:0.82rem;line-height:1.6">
            <p class="empty" style="padding:2rem;text-align:center">Select a file to view its contents</p>
          </div>
        </div>
      </div>
    \`;
  } catch(e) {
    console.error('Files refresh failed', e);
  }
}

async function refreshRouter() {
  try {
    var data = await fetch('/api/router').then(function(r) { return r.json(); });
    var el = document.getElementById('content');
    if (!el) return;

    var metrics = data.metrics;
    var topModels = data.topModels || [];
    var efficiency = data.efficiency;

    if (!metrics) {
      el.innerHTML = '<div class="card"><h2>Router</h2><p style="color:var(--muted)">Router not initialized — no metrics yet.</p></div>';
      return;
    }

    var modelsHtml = topModels.length ? topModels.map(function(m) {
      return '<tr><td>' + (m.modelId || m.model || '—') + '</td><td>' + (m.requests || m.count || 0) + '</td><td>' + (m.avgLatencyMs ? Math.round(m.avgLatencyMs) + 'ms' : '—') + '</td></tr>';
    }).join('') : '<tr><td colspan="3" style="color:var(--muted)">No routing data yet</td></tr>';

    el.innerHTML = '<div class="card"><h2>Router Metrics (24h)</h2>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.75rem;margin-bottom:1rem">' +
      '<div class="stat"><div class="stat-value">' + (metrics.totalRequests || 0) + '</div><div class="stat-label">Total Requests</div></div>' +
      '<div class="stat"><div class="stat-value">' + (metrics.avgLatencyMs ? Math.round(metrics.avgLatencyMs) + 'ms' : '—') + '</div><div class="stat-label">Avg Latency</div></div>' +
      '<div class="stat"><div class="stat-value">' + (metrics.cacheHitRate ? (metrics.cacheHitRate * 100).toFixed(1) + '%' : '—') + '</div><div class="stat-label">Cache Hit</div></div>' +
      '</div>' +
      '<h3>Top Models</h3><table class="tbl"><thead><tr><th>Model</th><th>Requests</th><th>Avg Latency</th></tr></thead><tbody>' + modelsHtml + '</tbody></table>' +
      (efficiency ? '<h3>Efficiency</h3><div style="color:var(--muted);font-size:0.85rem">' +
        '<p>Estimated cost savings: $' + (efficiency.costSavings || 0).toFixed(4) + '</p>' +
        '<p>Local routing rate: ' + (efficiency.localRoutingRate ? (efficiency.localRoutingRate * 100).toFixed(1) + '%' : 'N/A') + '</p>' +
      '</div>' : '') +
    '</div>';
  } catch(e) {
    console.error('Router refresh failed', e);
  }
}

function kanbanSourceBadge(source) {
  var colors = { scheduled: '#60a5fa', clawwork: '#a78bfa', bounty: '#f59e0b', building: '#10b981', document: '#06b6d4', user: '#ef4444', task: '#8b5cf6' };
  return '<span class="pill" style="background:' + (colors[source] || '#6b7280') + ';color:#fff;font-size:0.65rem">' + source + '</span>';
}

function kanbanCard(item) {
  var meta = '';
  if (item.metadata) {
    if (item.metadata.schedule) meta += '<div style="font-size:0.7rem;color:var(--muted)">' + item.metadata.schedule + '</div>';
    if (item.metadata.reward) meta += '<div style="font-size:0.7rem;color:var(--green)">$' + item.metadata.reward + '</div>';
    if (item.metadata.maxPayment) meta += '<div style="font-size:0.7rem;color:var(--green)">max $' + item.metadata.maxPayment.toFixed(2) + '</div>';
  }
  // Status action buttons for user tasks
  var actions = '';
  if (item.source === 'user' || item.source === 'task') {
    var nextStatus = item.status === 'todo' ? 'in_progress' : item.status === 'in_progress' ? 'completed' : '';
    var nextLabel = item.status === 'todo' ? 'Start' : item.status === 'in_progress' ? 'Done' : '';
    if (nextStatus) {
      actions = '<div style="margin-top:0.4rem"><button onclick="updateKanbanTask(\\'' + item.id + '\\',\\'' + nextStatus + '\\')" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:0.2rem 0.5rem;font-size:0.65rem;cursor:pointer">' + nextLabel + '</button></div>';
    }
  }
  return '<div style="background:var(--surface);border:1px solid ' + (item.source === 'user' ? '#ef4444' : 'var(--border)') + ';border-radius:8px;padding:0.6rem;margin-bottom:0.5rem">' +
    '<div style="display:flex;gap:0.4rem;align-items:center;margin-bottom:0.3rem">' + kanbanSourceBadge(item.source) + '</div>' +
    '<div style="font-size:0.8rem;line-height:1.3">' + (item.title.length > 80 ? item.title.slice(0, 80) + '\\u2026' : item.title) + '</div>' +
    meta + actions +
  '</div>';
}

async function updateKanbanTask(id, status) {
  try {
    await fetch('/api/kanban/task/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, status: status }) });
    refresh();
  } catch(e) { console.error('Update failed', e); }
}

async function addKanbanTask(project) {
  var input = document.getElementById('kanban-new-task');
  var desc = input ? input.value.trim() : '';
  if (!desc) return;
  try {
    await fetch('/api/kanban/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: desc, project: project || 'nanoclaw', priority: 3 }) });
    if (input) input.value = '';
    refresh();
  } catch(e) { console.error('Add task failed', e); }
}

function kanbanColumn(label, color, items, maxItems) {
  var shown = maxItems ? items.slice(0, maxItems) : items;
  return '<div>' +
    '<div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:0.5rem;border-bottom:2px solid ' + color + ';padding-bottom:0.3rem">' + label + ' <span class="pill" style="background:' + color + ';color:#fff">' + items.length + '</span></div>' +
    (shown.length === 0 ? '<p class="empty" style="font-size:0.8rem">No items</p>' : shown.map(kanbanCard).join('')) +
  '</div>';
}

function kanbanAddForm(project) {
  return '<div style="display:flex;gap:0.5rem;margin-bottom:1rem">' +
    '<input id="kanban-new-task" type="text" placeholder="Add a task..." style="flex:1;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:0.5rem 0.75rem;color:#e2e8f0;font-size:0.85rem;outline:none" onkeydown="if(event.key===\\'Enter\\')addKanbanTask(\\'' + project + '\\')">' +
    '<button onclick="addKanbanTask(\\'' + project + '\\')" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:0.5rem 1rem;font-size:0.85rem;cursor:pointer;white-space:nowrap">+ Add</button>' +
  '</div>';
}

async function refreshKanban() {
  try {
    var data = await fetch('/api/kanban?project=nanoclaw').then(function(r) { return r.json(); });
    var items = data.items || [];
    var userItems = items.filter(function(i) { return i.source === 'user'; });
    var systemItems = items.filter(function(i) { return i.source !== 'user'; });
    var userTodo = userItems.filter(function(i) { return i.status === 'todo'; });
    var userProg = userItems.filter(function(i) { return i.status === 'in_progress'; });
    var userDone = userItems.filter(function(i) { return i.status === 'done'; });
    var sysTodo = systemItems.filter(function(i) { return i.status === 'todo'; });
    var sysProg = systemItems.filter(function(i) { return i.status === 'in_progress'; });
    var sysDone = systemItems.filter(function(i) { return i.status === 'done'; });
    document.getElementById('main').innerHTML =
      '<div class="card full" style="margin-bottom:0.5rem"><div class="memory-tabs">' + tabBar() + '</div></div>' +
      // My Tasks section
      '<div class="card full" style="border-color:#ef4444">' +
        '<h2>📌 My Tasks <span class="pill" style="background:#ef4444;color:#fff">' + userItems.length + '</span></h2>' +
        kanbanAddForm('nanoclaw') +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem">' +
          kanbanColumn('Todo', '#f59e0b', userTodo) +
          kanbanColumn('In Progress', 'var(--green)', userProg) +
          kanbanColumn('Done', '#6b7280', userDone, 10) +
        '</div>' +
      '</div>' +
      // System board
      '<div class="card full">' +
        '<h2>⚙️ System Tasks <span class="pill yellow">' + systemItems.length + '</span></h2>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-top:0.75rem">' +
          kanbanColumn('Todo', '#f59e0b', sysTodo) +
          kanbanColumn('In Progress', 'var(--green)', sysProg) +
          kanbanColumn('Done', '#6b7280', sysDone, 20) +
        '</div>' +
      '</div>';
  } catch(e) {
    console.error('Kanban refresh failed', e);
  }
}

async function refresh() {
  if (dashTab === 'kanban') { await refreshKanban(); return; }
  if (window._integrationRefreshFns && window._integrationRefreshFns[dashTab]) { await window._integrationRefreshFns[dashTab](); return; }
  if (dashTab === 'router') { await refreshRouter(); return; }
  if (dashTab === 'files') {
    // If a file is currently open (viewer has content), only refresh the file list
    // sidebar without re-rendering the whole tab — avoids losing scroll position
    const viewer = document.getElementById('file-viewer');
    const fileOpen = viewer && !viewer.querySelector('.empty');
    if (fileOpen) {
      try {
        const filesData = await fetch('/api/files?group=main').then(function(r) { return r.json(); });
        const files = filesData.files || [];
        const docs = files.filter(function(f) { var e = f.path.split('.').pop().toLowerCase(); return e === 'md' || e === 'txt'; });
        const scripts = files.filter(function(f) { var e = f.path.split('.').pop().toLowerCase(); return ['py','js','mjs','cjs','sh','ts','html'].includes(e); });
        const data = files.filter(function(f) { var e = f.path.split('.').pop().toLowerCase(); return ['json','csv','sql','xml','yaml','yml'].includes(e); });
        const other = files.filter(function(f) { var e = f.path.split('.').pop().toLowerCase(); return !['md','txt','py','js','mjs','cjs','sh','ts','html','json','csv','sql','xml','yaml','yml'].includes(e); });
        const list = document.getElementById('file-list');
        if (list) list.innerHTML = renderFileSection('📝 Documents', docs) + renderFileSection('🔧 Scripts', scripts) + renderFileSection('📊 Data', data) + renderFileSection('📁 Other', other);
      } catch(e) { /* silent */ }
      return;
    }
    await refreshFiles();
    return;
  }
  try {
    const [status, memory, resources] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/memory?file=' + encodeURIComponent(memTab)).then(r => r.text()),
      fetch('/api/resources').then(r => r.json()),
    ]);

    const totalGroups = status.groups.length;
    const activeGroups = status.groups.filter(g => g.hasActiveContainer).length;
    const activeTasks = status.tasks.filter(t => t.status === 'active').length;
    const secCount = status.securityEvents.length;

    document.getElementById('main').innerHTML = \`
      <div class="card full" style="margin-bottom:0.5rem">
        <div class="memory-tabs">
          \${tabBar()}
        </div>
      </div>
      <!-- Resources -->
      \${resources.status ? (function() {
        var rs = resources.status;
        var ramPct = rs.usedPercent.toFixed(1);
        var ramColor = rs.usedPercent < 70 ? 'var(--green)' : rs.usedPercent < 85 ? 'var(--yellow)' : '#ef4444';
        var typeEntries = Object.entries(rs.agentsByType || {});
        return '<div class="card full" style="border-color:' + ramColor + '">' +
          '<h2>💻 System Resources</h2>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;margin-top:0.75rem">' +
            '<div>' +
              '<div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">RAM Usage</div>' +
              '<div style="font-size:1.3rem;font-weight:700;color:' + ramColor + ';margin:0.25rem 0">' + rs.usedRamGB.toFixed(1) + ' / ' + rs.totalRamGB.toFixed(0) + ' GB</div>' +
              '<div style="background:#1e1e2e;border-radius:4px;height:12px;overflow:hidden;margin-top:0.3rem">' +
                '<div style="background:' + ramColor + ';height:100%;width:' + ramPct + '%;transition:width 0.5s;border-radius:4px"></div>' +
              '</div>' +
              '<div style="font-size:0.7rem;color:var(--muted);margin-top:0.25rem">' + ramPct + '% used — ' + rs.availableRamGB.toFixed(1) + ' GB free</div>' +
            '</div>' +
            '<div>' +
              '<div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Active Agents</div>' +
              '<div style="font-size:1.3rem;font-weight:700;color:var(--accent);margin:0.25rem 0">' + rs.activeAgents + '</div>' +
              (typeEntries.length > 0 ? '<div style="font-size:0.7rem;color:var(--muted)">' + typeEntries.map(function(e) { return e[0] + ': ' + e[1]; }).join(', ') + '</div>' : '') +
            '</div>' +
            '<div>' +
              '<div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Queue</div>' +
              '<div style="font-size:1.3rem;font-weight:700;color:' + (rs.queuedAgents > 0 ? 'var(--yellow)' : 'var(--green)') + ';margin:0.25rem 0">' + rs.queuedAgents + ' waiting</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      })() : ''}
      <!-- Observer Guard -->
      \${status.observerGuard ? (function() {
        var og = status.observerGuard;
        var cap = og.config.maxConcurrentTasks;
        var act = og.activeExecutions;
        var actColor = act < cap * 0.75 ? 'var(--green)' : act < cap ? 'var(--yellow)' : '#ef4444';
        var b = og.blocks;
        var c = og.counters;
        return '<div class="card full">' +
          '<h2>🛡️ Observer Guard <span class="pill ' + (act > 0 ? 'green' : 'yellow') + '">' + act + ' / ' + cap + ' active</span></h2>' +
          '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-top:0.75rem">' +
            '<div>' +
              '<div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Active Tasks</div>' +
              '<div style="font-size:1.3rem;font-weight:700;color:' + actColor + ';margin:0.25rem 0">' + act + ' / ' + cap + '</div>' +
              '<div style="font-size:0.7rem;color:var(--muted)">per-group cap ' + og.config.maxConcurrentPerGroup + '</div>' +
            '</div>' +
            '<div>' +
              '<div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Blocks</div>' +
              '<div style="font-size:1.3rem;font-weight:700;color:' + (b.total > 0 ? 'var(--yellow)' : 'var(--green)') + ';margin:0.25rem 0">' + b.total + '</div>' +
              '<div style="font-size:0.7rem;color:var(--muted)">re-entry ' + b.reentrancy + ' · cap ' + (b.globalLimit + b.groupLimit) + ' · shed ' + b.tailSample + ' · throttle ' + b.failureThrottle + '</div>' +
            '</div>' +
            '<div>' +
              '<div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Throttled</div>' +
              '<div style="font-size:1.3rem;font-weight:700;color:' + (og.throttledTasks.length > 0 ? '#ef4444' : 'var(--green)') + ';margin:0.25rem 0">' + og.throttledTasks.length + '</div>' +
              '<div style="font-size:0.7rem;color:var(--muted)">timeouts ' + c.timeouts + '</div>' +
            '</div>' +
            '<div>' +
              '<div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Runs</div>' +
              '<div style="font-size:1.3rem;font-weight:700;color:var(--accent);margin:0.25rem 0">' + c.completed + ' ✓</div>' +
              '<div style="font-size:0.7rem;color:var(--muted)">' + c.started + ' started · ' + c.failed + ' failed</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      })() : ''}
      <!-- Groups -->
      <div class="card">
        <h2>🤖 Agents <span class="pill \${activeGroups > 0 ? 'green' : 'yellow'}">\${activeGroups} active</span></h2>
        \${status.groups.length === 0 ? '<p class="empty">No groups registered</p>' : \`
        <table>
          <thead><tr><th>Group</th><th>Status</th><th>Type</th><th>Reason</th><th>Queue</th></tr></thead>
          <tbody>\${status.groups.map(g => \`
            <tr>
              <td>\${g.name}</td>
              <td>\${agentStatus(g)}</td>
              <td>\${designationBadge(g)}</td>
              <td style="font-size:0.78rem;max-width:400px;word-break:break-word">\${agentReason(g)}</td>
              <td class="mono">\${agentQueue(g)}</td>
            </tr>
          \`).join('')}</tbody>
        </table>\`}
      </div>

      <!-- Scheduled Tasks -->
      <div class="card">
        <h2>⏰ Tasks <span class="pill \${activeTasks > 0 ? 'green' : 'yellow'}">\${activeTasks} active</span></h2>
        \${status.tasks.length === 0 ? '<p class="empty">No scheduled tasks</p>' : \`
        <table>
          <thead><tr><th>ID</th><th>Group</th><th>Schedule</th><th>Next Run</th></tr></thead>
          <tbody>\${status.tasks.map(t => \`
            <tr>
              <td class="mono">\${t.id.slice(0,12)}…</td>
              <td>\${t.group}</td>
              <td class="mono">\${t.schedule}</td>
              <td class="mono">\${fmt(t.nextRun)}</td>
            </tr>
          \`).join('')}</tbody>
        </table>\`}
      </div>

      <!-- Semantic Index -->
      <div class="card">
        <h2>🔍 Semantic Index</h2>
        <table>
          <tbody>
            <tr><td>Total chunks</td><td class="mono">\${status.indexStats.totalChunks}</td></tr>
            <tr><td>Sources indexed</td><td class="mono">\${status.indexStats.sources}</td></tr>
            <tr><td>Groups</td><td class="mono">\${status.indexStats.groups.join(', ') || '—'}</td></tr>
          </tbody>
        </table>
      </div>

      <!-- Security Events -->
      <div class="card">
        <h2>🛡️ Security Events <span class="pill \${secCount > 0 ? 'yellow' : 'green'}">\${secCount}</span></h2>
        \${secCount === 0 ? '<p class="empty">No recent events</p>' : \`
        <table>
          <thead><tr><th>Type</th><th>Time</th><th>Detail</th></tr></thead>
          <tbody>\${status.securityEvents.map(renderEvent).join('')}</tbody>
        </table>\`}
      </div>

      <!-- Errors -->
      <div class="card">
        <h2>⚠️ Recent Errors <span class="pill \${status.recentErrors.length > 0 ? 'red' : 'green'}">\${status.recentErrors.length}</span></h2>
        \${status.recentErrors.length === 0 ? '<p class="empty">No errors</p>' :
          status.recentErrors.map(e => \`<div class="log-box" style="max-height:60px;margin-bottom:4px">\${e.time ? new Date(e.time).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '?'} \${e.msg}</div>\`).join('')
        }
      </div>

      <!-- Memory Viewer -->
      <div class="card full">
        <h2>🧠 Memory</h2>
        <div class="memory-tabs" id="tabs">
          \${['global/MEMORY.md','global/CLAUDE.md','main/CLAUDE.md'].map(f =>
            \`<span class="tab \${memTab===f?'active':''}" onclick="switchTab('\${f}')">\${f}</span>\`
          ).join('')}
        </div>
        <div class="memory-content">\${memory || '(empty)'}</div>
      </div>

      <!-- Log Tail -->
      <div class="card full">
        <h2>📋 Log Tail</h2>
        <div class="log-box" id="log">\${status.logLines.map(l => {
          try { const o = JSON.parse(l); return (o.time?new Date(o.time).toLocaleString(undefined, {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'') + ' ' + (o.msg||l); } catch { return l; }
        }).join('\\n')}</div>
      </div>
    \`;

    // Auto-scroll log to bottom
    const log = document.getElementById('log');
    if (log) log.scrollTop = log.scrollHeight;

  } catch(e) {
    console.error('Refresh failed', e);
  }
}

function switchTab(file) {
  memTab = file;
  refresh();
}

// Integration tab/script injection
window._integrationTabIds = [];
window._integrationTabLabels = {};
window._integrationRefreshFns = {};
${getIntegrations().map(i => {
  const parts: string[] = [];
  if (i.dashboardTabs) {
    for (const tab of i.dashboardTabs) {
      parts.push(`window._integrationTabIds.push('${tab.id}');`);
      parts.push(`window._integrationTabLabels['${tab.id}'] = '${tab.label}';`);
      parts.push(`window._integrationRefreshFns['${tab.id}'] = ${tab.refreshFn};`);
    }
  }
  if (i.dashboardScript) parts.push(i.dashboardScript);
  return parts.join('\\n');
}).join('\\n')}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

// ── Agent Call Graph page (standalone DashClaw UI component) ─────────────────────
// Self-contained: vanilla canvas force-directed graph + blast-radius side panel.
// Client JS deliberately avoids template literals / embedded newlines in string
// literals so it survives being nested inside this TS template string.
const AGENT_GRAPH_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Call Graph · DashClaw</title>
<style>
  :root {
    --bg:#0a0a0f; --surface:#13131a; --border:#26263a; --text:#e2e8f0;
    --muted:#64748b; --accent:#7c3aed; --accent2:#06b6d4; --green:#22c55e;
    --mono:'SF Mono',ui-monospace,Menlo,monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:system-ui,sans-serif; height:100vh; display:flex; flex-direction:column; overflow:hidden; }
  header { background:var(--surface); border-bottom:1px solid var(--border); padding:0.7rem 1.2rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
  header h1 { font-size:1.05rem; margin:0; font-weight:600; }
  header h1 span { color:var(--accent); }
  header a.back { color:var(--muted); text-decoration:none; font-size:0.8rem; }
  .controls { display:flex; gap:0.5rem; align-items:center; margin-left:auto; flex-wrap:wrap; }
  select, button { background:#07070d; color:var(--text); border:1px solid var(--border); border-radius:6px; padding:0.3rem 0.6rem; font-size:0.78rem; cursor:pointer; }
  button:hover, select:hover { border-color:var(--accent); }
  .stats { display:flex; gap:1.2rem; padding:0.5rem 1.2rem; background:var(--surface); border-bottom:1px solid var(--border); font-size:0.75rem; color:var(--muted); flex-wrap:wrap; }
  .stats b { color:var(--text); }
  main { flex:1; display:flex; min-height:0; }
  #canvasWrap { flex:1; position:relative; }
  canvas { display:block; width:100%; height:100%; }
  #legend { position:absolute; left:12px; bottom:12px; background:rgba(19,19,26,0.85); border:1px solid var(--border); border-radius:8px; padding:0.5rem 0.7rem; font-size:0.7rem; }
  #legend div { display:flex; align-items:center; gap:0.4rem; margin:0.15rem 0; }
  .swatch { width:10px; height:10px; border-radius:50%; display:inline-block; }
  aside { width:340px; border-left:1px solid var(--border); background:var(--surface); padding:1rem; overflow-y:auto; }
  aside h2 { font-size:0.9rem; margin:0.8rem 0 0.4rem; }
  aside h2:first-child { margin-top:0; }
  .muted { color:var(--muted); font-size:0.78rem; }
  .summary { background:#07070d; border:1px solid var(--border); border-radius:8px; padding:0.6rem 0.7rem; font-size:0.82rem; margin:0.6rem 0; }
  .pill { display:inline-block; font-size:0.62rem; padding:0.1rem 0.4rem; border-radius:4px; background:var(--accent); color:#fff; margin-right:0.4rem; }
  .chain { font-family:var(--mono); font-size:0.7rem; color:#94a3b8; padding:0.25rem 0; border-bottom:1px solid var(--border); word-break:break-word; }
  .edge-row { font-size:0.74rem; padding:0.35rem 0; border-bottom:1px solid var(--border); }
  .edge-row .intent { color:var(--muted); display:block; margin-top:0.15rem; }
</style>
</head>
<body>
<header>
  <h1>Dash<span>Claw</span> · Agent Call Graph</h1>
  <a class="back" href="/">&#8592; dashboard</a>
  <div class="controls">
    <label class="muted">Window</label>
    <select id="window">
      <option value="24h">24h</option>
      <option value="7d" selected>7d</option>
      <option value="30d">30d</option>
      <option value="all">All</option>
    </select>
    <label class="muted">Blast</label>
    <select id="direction">
      <option value="downstream">Downstream</option>
      <option value="upstream">Upstream</option>
      <option value="both">Both</option>
    </select>
    <select id="hops">
      <option value="1">1 hop</option>
      <option value="2">2 hops</option>
      <option value="3">3 hops</option>
      <option value="4" selected>4 hops</option>
      <option value="6">6 hops</option>
    </select>
    <button id="reload">Refresh</button>
  </div>
</header>
<div class="stats" id="stats"></div>
<main>
  <div id="canvasWrap">
    <canvas id="cv"></canvas>
    <div id="legend">
      <div><span class="swatch" style="background:#f59e0b"></span> root</div>
      <div><span class="swatch" style="background:#7c3aed"></span> agent</div>
      <div><span class="swatch" style="background:#a78bfa"></span> team</div>
      <div><span class="swatch" style="background:#06b6d4"></span> destination</div>
    </div>
  </div>
  <aside id="panel">
    <h2>Agent Call Graph</h2>
    <p class="muted">Loading graph&#8230;</p>
  </aside>
</main>
<script>
(function(){
  var COLORS = { root:'#f59e0b', agent:'#7c3aed', team:'#a78bfa', destination:'#06b6d4' };
  var EDGE_COLORS = { message:'#3b3b55', delegation:'#f59e0b', team:'#a78bfa' };
  var cv = document.getElementById('cv');
  var ctx = cv.getContext('2d');
  var state = { graph:null, stats:null, blast:null, selected:null };
  var sim = { nodes:[], edges:[], byId:{}, alpha:1 };
  var drag = null, hover = null;
  var W=0, H=0, DPR = window.devicePixelRatio || 1;

  function resize(){
    var wrap = document.getElementById('canvasWrap');
    W = wrap.clientWidth; H = wrap.clientHeight;
    cv.width = W*DPR; cv.height = H*DPR;
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  window.addEventListener('resize', function(){ resize(); sim.alpha = 0.5; });

  function api(path){
    return fetch(path).then(function(r){
      return r.json().then(function(j){
        if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
        return j;
      });
    });
  }

  function buildSim(graph){
    var nodes = graph.nodes.map(function(n, i){
      var ang = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      var rad = Math.min(W,H)/3 || 200;
      return {
        id:n.id, label:n.label, kind:n.kind, data:n,
        x: W/2 + Math.cos(ang)*rad, y: H/2 + Math.sin(ang)*rad,
        vx:0, vy:0, r: 6 + Math.min(14, Math.sqrt((n.outCount+n.inCount)||1))
      };
    });
    var byId = {}; nodes.forEach(function(n){ byId[n.id]=n; });
    var edges = graph.edges.filter(function(e){ return byId[e.source] && byId[e.target]; });
    sim = { nodes:nodes, edges:edges, byId:byId, alpha:1 };
  }

  function tick(){
    var n = sim.nodes, i, j, a, b, dx, dy, d, f, ux, uy;
    var rep = 1400;
    for(i=0;i<n.length;i++){
      a=n[i];
      for(j=i+1;j<n.length;j++){
        b=n[j];
        dx=a.x-b.x; dy=a.y-b.y; d=Math.sqrt(dx*dx+dy*dy)||0.01;
        if(d<280){ f=rep/(d*d); ux=dx/d; uy=dy/d; a.vx+=ux*f; a.vy+=uy*f; b.vx-=ux*f; b.vy-=uy*f; }
      }
      a.vx += (W/2 - a.x)*0.0016;
      a.vy += (H/2 - a.y)*0.0016;
    }
    for(i=0;i<sim.edges.length;i++){
      var e=sim.edges[i]; a=sim.byId[e.source]; b=sim.byId[e.target];
      dx=b.x-a.x; dy=b.y-a.y; d=Math.sqrt(dx*dx+dy*dy)||0.01;
      var rest = e.kind==='message'?130:95;
      f=(d-rest)*0.012; ux=dx/d; uy=dy/d;
      a.vx+=ux*f; a.vy+=uy*f; b.vx-=ux*f; b.vy-=uy*f;
    }
    for(i=0;i<n.length;i++){
      a=n[i];
      if(drag && drag.node===a) continue;
      a.vx*=0.85; a.vy*=0.85;
      a.x+=a.vx*sim.alpha; a.y+=a.vy*sim.alpha;
      a.x=Math.max(20,Math.min(W-20,a.x)); a.y=Math.max(20,Math.min(H-20,a.y));
    }
    sim.alpha *= 0.992;
    if(sim.alpha<0.02) sim.alpha=0.02;
  }

  function affectedSet(){ var s={}; if(state.blast){ state.blast.affectedNodes.forEach(function(id){ s[id]=true; }); } return s; }
  function affectedEdgeSet(){ var s={}; if(state.blast){ state.blast.affectedEdges.forEach(function(e){ s[e.id]=true; }); } return s; }

  function draw(){
    ctx.clearRect(0,0,W,H);
    var aff = affectedSet(), affE = affectedEdgeSet();
    var hasBlast = !!state.blast;
    sim.edges.forEach(function(e){
      var a=sim.byId[e.source], b=sim.byId[e.target];
      var on = !hasBlast || affE[e.id];
      ctx.beginPath();
      ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
      ctx.strokeStyle = on ? (EDGE_COLORS[e.kind]||'#3b3b55') : '#1c1c2a';
      ctx.globalAlpha = on ? 0.85 : 0.25;
      ctx.lineWidth = Math.min(5, 0.6+Math.log(1+e.count));
      ctx.stroke();
      if(on && e.kind!=='message'){ drawArrow(a,b); }
    });
    ctx.globalAlpha=1;
    sim.nodes.forEach(function(nd){
      var isSel = state.selected===nd.id;
      var on = !hasBlast || aff[nd.id] || isSel;
      ctx.beginPath();
      ctx.arc(nd.x,nd.y,nd.r,0,Math.PI*2);
      ctx.fillStyle = on ? (COLORS[nd.kind]||'#7c3aed') : '#23233a';
      ctx.globalAlpha = on?1:0.35;
      ctx.fill();
      if(isSel){ ctx.lineWidth=3; ctx.strokeStyle='#fff'; ctx.stroke(); }
      else if(hasBlast && aff[nd.id]){ ctx.lineWidth=2; ctx.strokeStyle='#22c55e'; ctx.stroke(); }
      ctx.globalAlpha=1;
      if(nd.r>9 || isSel || hover===nd){
        ctx.fillStyle = on ? '#e2e8f0' : '#475569';
        ctx.font='10px system-ui';
        var lbl = nd.label.length>22 ? nd.label.slice(0,22)+'\\u2026' : nd.label;
        ctx.fillText(lbl, nd.x+nd.r+3, nd.y+3);
      }
    });
  }

  function drawArrow(a,b){
    var dx=b.x-a.x, dy=b.y-a.y, d=Math.sqrt(dx*dx+dy*dy)||1;
    var ux=dx/d, uy=dy/d;
    var px=b.x-ux*(b.r+4), py=b.y-uy*(b.r+4);
    var ang=Math.atan2(uy,ux);
    ctx.beginPath();
    ctx.moveTo(px,py);
    ctx.lineTo(px-8*Math.cos(ang-0.4), py-8*Math.sin(ang-0.4));
    ctx.lineTo(px-8*Math.cos(ang+0.4), py-8*Math.sin(ang+0.4));
    ctx.closePath();
    ctx.fillStyle='#f59e0b'; ctx.fill();
  }

  function loop(){ tick(); draw(); requestAnimationFrame(loop); }

  function pick(mx,my){
    for(var i=sim.nodes.length-1;i>=0;i--){
      var nd=sim.nodes[i]; var dx=mx-nd.x, dy=my-nd.y;
      if(dx*dx+dy*dy <= (nd.r+4)*(nd.r+4)) return nd;
    }
    return null;
  }

  cv.addEventListener('mousedown', function(ev){
    var rect=cv.getBoundingClientRect();
    var nd=pick(ev.clientX-rect.left, ev.clientY-rect.top);
    if(nd){ drag={node:nd, moved:false}; }
  });
  cv.addEventListener('mousemove', function(ev){
    var rect=cv.getBoundingClientRect();
    var mx=ev.clientX-rect.left, my=ev.clientY-rect.top;
    if(drag){ drag.node.x=mx; drag.node.y=my; drag.node.vx=0; drag.node.vy=0; drag.moved=true; sim.alpha=Math.max(sim.alpha,0.3); }
    else { hover=pick(mx,my); cv.style.cursor=hover?'pointer':'default'; }
  });
  window.addEventListener('mouseup', function(){
    if(drag){ if(!drag.moved){ selectNode(drag.node.id); } drag=null; }
  });

  function selectNode(id){
    state.selected=id;
    var dir=document.getElementById('direction').value;
    var hops=document.getElementById('hops').value;
    var win=document.getElementById('window').value;
    api('/api/agent-graph/blast-radius?node='+encodeURIComponent(id)+'&window='+win+'&direction='+dir+'&hops='+hops)
      .then(function(d){ state.blast=d.blastRadius; renderPanel(); sim.alpha=Math.max(sim.alpha,0.15); })
      .catch(function(err){ panelError(err.message); });
  }

  function el(tag, cls, text){
    var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e;
  }

  function renderStats(){
    var s=state.stats, m=state.graph.meta;
    var box=document.getElementById('stats'); box.textContent='';
    function stat(label,val){ var sp=el('span'); sp.appendChild(el('b',null,String(val))); sp.appendChild(document.createTextNode(' '+label)); return sp; }
    box.appendChild(stat('agents', s.agentCount));
    box.appendChild(stat('destinations', s.destinationCount));
    box.appendChild(stat('edges', s.edgeCount));
    box.appendChild(stat('messages', s.totalMessages));
    box.appendChild(stat('delegations', s.totalDelegations));
    box.appendChild(el('span','muted','sources: evidence '+m.sources.evidence+' / identities '+m.sources.identities+' / team '+m.sources.teamEdges));
  }

  function renderPanel(){
    var p=document.getElementById('panel'); p.textContent='';
    if(!state.selected){
      p.appendChild(el('h2',null,'Agent Call Graph'));
      p.appendChild(el('p','muted','Click any node to trace its blast radius — who is affected if it fails. Drag nodes to rearrange.'));
      p.appendChild(el('h2',null,'Busiest agents'));
      state.stats.busiestAgents.forEach(function(a){
        p.appendChild(el('div','edge-row', a.label+' — '+a.outCount+' out'));
      });
      p.appendChild(el('h2',null,'Top destinations'));
      state.stats.topDestinations.forEach(function(a){
        p.appendChild(el('div','edge-row', a.label+' — '+a.inCount+' in'));
      });
      return;
    }
    var nd=sim.byId[state.selected];
    p.appendChild(el('h2',null, nd ? nd.label : state.selected));
    if(nd){
      var meta = nd.kind + (nd.data.agentType ? ' / '+nd.data.agentType : '') + (nd.data.instanceCount>1 ? ' / '+nd.data.instanceCount+' instances' : '');
      p.appendChild(el('div','muted', meta));
    }
    if(state.blast){
      var b=state.blast;
      p.appendChild(el('div','summary', b.summary));
      b.levels.forEach(function(lv){
        var h=el('div');
        h.appendChild(el('span','pill','hop '+lv.hop));
        h.appendChild(document.createTextNode(lv.nodes.length+' node'+(lv.nodes.length===1?'':'s')));
        p.appendChild(h);
      });
      if(b.chains.length){
        p.appendChild(el('h2',null,'Chains'));
        b.chains.forEach(function(ch){
          var labels = ch.map(function(id){ var x=sim.byId[id]; return x?x.label:id; });
          p.appendChild(el('div','chain', labels.join('  \\u2192  ')));
        });
      }
    }
    var outs = state.graph.edges.filter(function(e){ return e.source===state.selected; });
    if(outs.length){
      p.appendChild(el('h2',null,'Outgoing edges ('+outs.length+')'));
      outs.slice(0,20).forEach(function(e){
        var tgt=sim.byId[e.target]; var row=el('div','edge-row');
        row.appendChild(document.createTextNode('\\u2192 '+(tgt?tgt.label:e.target)+'  ('+e.kind+', '+e.count+')'));
        (e.sampleIntents||[]).forEach(function(si){ row.appendChild(el('span','intent','\\u2022 '+si)); });
        p.appendChild(row);
      });
    }
    var clr=el('button',null,'Clear selection'); clr.style.marginTop='0.7rem';
    clr.onclick=function(){ state.selected=null; state.blast=null; renderPanel(); };
    p.appendChild(clr);
  }

  function panelError(msg){
    var p=document.getElementById('panel'); p.textContent='';
    p.appendChild(el('h2',null,'Error')); p.appendChild(el('p','muted',msg));
  }

  function load(){
    var win=document.getElementById('window').value;
    state.selected=null; state.blast=null;
    api('/api/agent-graph?window='+win).then(function(d){
      state.graph=d.graph; state.stats=d.stats;
      resize(); buildSim(d.graph); renderStats(); renderPanel();
    }).catch(function(err){ panelError(err.message); });
  }

  document.getElementById('reload').onclick=load;
  document.getElementById('window').onchange=load;
  document.getElementById('direction').onchange=function(){ if(state.selected) selectNode(state.selected); };
  document.getElementById('hops').onchange=function(){ if(state.selected) selectNode(state.selected); };

  resize(); load(); loop();
})();
</script>
</body>
</html>`;

// ── HTTP server ────────────────────────────────────────────────────────────────

export function startDashboard(queue: GroupQueue, sendFn?: (jid: string, text: string) => Promise<void>, resourceOrchestrator?: ResourceOrchestrator, universalRouter?: UniversalRouter): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    // Only accept connections from localhost or Tailscale network
    const remoteAddr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1';
    const isTailscale = remoteAddr.startsWith('100.'); // Tailscale CGNAT range: 100.64.0.0/10

    if (!isLocalhost && !isTailscale) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // SECURITY: Token authentication for remote access (Cloudflare tunnel).
    // Localhost requests from the machine itself skip token check.
    // Cloudflare tunnel proxies through localhost, so we check the
    // CF-Connecting-IP header to detect tunneled requests.
    // Webhook paths (/webhooks/*) are exempt — they use their own signature validation.
    const cfIp = req.headers['cf-connecting-ip'] as string | undefined;
    const isTunneled = !!cfIp;
    const isWebhook = url.pathname.startsWith('/webhooks/');
    const isUpload = url.pathname === '/upload';
    if (DASH_TOKEN && isTunneled && !isWebhook && !isUpload) {
      const tokenFromQuery = url.searchParams.get('token');
      const tokenFromHeader = (req.headers.authorization || '').replace('Bearer ', '');
      if (tokenFromQuery !== DASH_TOKEN && tokenFromHeader !== DASH_TOKEN) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized — add ?token=<NANOCLAW_DASH_TOKEN> to the URL');
        return;
      }
    }

    if (url.pathname === '/api/status') {
      try {
        const data = apiStatus(queue);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // ── Throughput API ──────────────────────────────────────────────────────
    if (url.pathname === '/api/throughput/current') {
      try {
        const data = getCurrentThroughput();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/throughput/hourly') {
      try {
        const data = getHourlyThroughput();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/throughput/alerts') {
      try {
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const data = getActiveAlerts(limit);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ alerts: data }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/throughput/ack-alert' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          if (!id) { res.writeHead(400); res.end('Missing alert id'); return; }
          const ok = acknowledgeAlert(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ acknowledged: ok }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (url.pathname === '/api/kanban') {
      try {
        const project = url.searchParams.get('project') || 'nanoclaw';
        const items = getKanbanItems(project);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // ── Agent Call Graph API ─────────────────────────────────────────────────
    if (url.pathname === '/api/agent-graph') {
      const result = getAgentGraphData({ window: url.searchParams.get('window') || '7d' });
      res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.ok ? result.data : { error: result.error }));
      return;
    }

    if (url.pathname === '/api/agent-graph/blast-radius') {
      const node = url.searchParams.get('node') || '';
      const hopsRaw = url.searchParams.get('hops');
      const result = getBlastRadiusData({
        window: url.searchParams.get('window') || '7d',
        node,
        hops: hopsRaw ? parseInt(hopsRaw, 10) : undefined,
        direction: (url.searchParams.get('direction') as BlastDirection) || 'downstream',
      });
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.ok ? result.data : { error: result.error }));
      return;
    }

    if (url.pathname === '/agent-graph') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(AGENT_GRAPH_HTML);
      return;
    }

    // Integration API routes
    {
      let handled = false;
      for (const integration of getIntegrations()) {
        if (integration.apiRoutes) {
          const route = integration.apiRoutes.get(url.pathname);
          if (route) {
            await route.handler(url, req, res);
            handled = true;
            break;
          }
        }
      }
      if (handled) return;
    }

    if (url.pathname === '/api/resources') {
      if (!resourceOrchestrator) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: null, queue: [] }));
        return;
      }
      try {
        const status = await resourceOrchestrator.getStatus();
        const queue = resourceOrchestrator.getQueue();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status, queue }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/dispatch') {
      try {
        const { PersonaRegistry } = await import('./persona-registry.js');
        const { AutoDispatcher } = await import('./auto-dispatch.js');
        const db = getDb();

        const registry = new PersonaRegistry(db);
        registry.initSchema();
        // Load from DB (already scanned at startup)
        const personas = registry.getAll();
        const departments = registry.getDepartmentSummary();
        const recentDispatches = registry.getRecentDispatches(20);

        // Get dispatch stats from dispatch_log table
        let dispatchStats = { total: 0, queued: 0, running: 0, completed: 0, failed: 0 };
        try {
          const row = db.prepare(`
            SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
              SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
            FROM dispatch_log
          `).get() as any;
          if (row) dispatchStats = row;
        } catch { /* table may not exist yet */ }

        // Get recent dispatch log
        let recentDispatchLog: any[] = [];
        try {
          recentDispatchLog = db.prepare(`
            SELECT task_id, persona_id, persona_name, department, description, confidence,
                   dispatched_at, completed_at, status
            FROM dispatch_log ORDER BY dispatched_at DESC LIMIT 20
          `).all();
        } catch { /* table may not exist */ }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          personas: personas.length,
          departments,
          recentDispatches,
          recentDispatchLog,
          stats: dispatchStats,
        }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ personas: 0, departments: {}, recentDispatches: [], recentDispatchLog: [], stats: {} }));
      }
      return;
    }

    if (url.pathname === '/api/personas') {
      try {
        const { PersonaRegistry } = await import('./persona-registry.js');
        const db = getDb();
        const registry = new PersonaRegistry(db);
        registry.initSchema();
        const personas = registry.getAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(personas));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
      return;
    }

    if (url.pathname === '/api/router') {
      if (!universalRouter) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ metrics: null, topModels: [], efficiency: null }));
        return;
      }
      try {
        const metrics = universalRouter.getMetrics('24h');
        const topModels = universalRouter.getTopModels(5);
        const efficiency = universalRouter.getEfficiencyReport();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ metrics, topModels, efficiency }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/memory') {
      const file = url.searchParams.get('file') || 'global/MEMORY.md';
      // Security: only allow reading from GROUPS_DIR, no path traversal
      const resolved = path.resolve(GROUPS_DIR, file);
      if (!resolved.startsWith(GROUPS_DIR) || file.includes('..')) {
        res.writeHead(400);
        res.end('Invalid path');
        return;
      }
      const content = readMemoryFile(
        path.dirname(file),
        path.basename(file),
      );
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
      return;
    }

    if (url.pathname === '/api/files') {
      const group = url.searchParams.get('group') || 'main';
      if (!group.match(/^[a-zA-Z0-9_-]+$/)) { res.writeHead(400); res.end('Invalid group'); return; }
      try {
        const files = listGroupFiles(group);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/file') {
      const group = url.searchParams.get('group') || 'main';
      const filePath = url.searchParams.get('path') || '';
      if (!group.match(/^[a-zA-Z0-9_-]+$/) || !filePath || filePath.includes('..') || filePath.startsWith('/')) {
        res.writeHead(400); res.end('Invalid path'); return;
      }
      const resolved = path.resolve(GROUPS_DIR, group, filePath);
      const groupRoot = path.resolve(GROUPS_DIR, group);
      if (!resolved.startsWith(groupRoot + path.sep) && resolved !== groupRoot) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      try {
        const content = fs.readFileSync(resolved, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    if (url.pathname === '/files/view') {
      const group = url.searchParams.get('group') || 'main';
      const filePath = url.searchParams.get('path') || '';
      if (!group.match(/^[a-zA-Z0-9_-]+$/) || !filePath || filePath.includes('..') || filePath.startsWith('/')) {
        res.writeHead(400); res.end('Invalid path'); return;
      }
      const resolved = path.resolve(GROUPS_DIR, group, filePath);
      const groupRoot = path.resolve(GROUPS_DIR, group);
      if (!resolved.startsWith(groupRoot + path.sep) && resolved !== groupRoot) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      const MIME: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.html': 'text/html; charset=utf-8',
        '.htm': 'text/html; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
      };
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      try {
        const content = fs.readFileSync(resolved);
        res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' });
        res.end(content);
      } catch {
        res.writeHead(404); res.end('Not found');
      }
      return;
    }

    if (url.pathname === '/api/kanban/task' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { description, project, priority } = JSON.parse(body);
          if (!description) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing description' })); return; }
          const task = createTaskRecord({
            description,
            project: project || 'nanoclaw',
            source: 'user',
            priority: priority || 3,
          });
          syncKanbanFile();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, task }));
        } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
      });
      return;
    }

    if (url.pathname === '/api/kanban/task/update' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const { id, status } = JSON.parse(body);
          if (!id || !status) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing id or status' })); return; }
          const task = updateTaskRecord(id, { status });
          syncKanbanFile();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, task }));
        } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })); }
      });
      return;
    }

    if (url.pathname === '/api/send' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { jid, message } = JSON.parse(body);

          if (!jid || !message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing jid or message' }));
            return;
          }

          // Security: JID must be a registered group
          const registeredGroups = getAllRegisteredGroups();
          if (!registeredGroups[jid]) {
            logger.warn({ jid, remoteAddr: req.socket.remoteAddress }, 'SECURITY: /api/send attempted with unregistered JID');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'jid not registered' }));
            return;
          }

          // Security: rate limit per JID
          const rateLimitResult = sendRateLimiter.check(jid);
          if (!rateLimitResult.allowed) {
            const retryAfterSec = Math.ceil(rateLimitResult.resetMs / 1000);
            logger.warn({ jid, remaining: rateLimitResult.remaining }, 'SECURITY: /api/send rate limit exceeded');
            res.writeHead(429, {
              'Content-Type': 'application/json',
              'Retry-After': String(retryAfterSec),
            });
            res.end(JSON.stringify({ error: 'rate limit exceeded', retryAfterSec }));
            return;
          }

          if (!sendFn) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sendFn not configured' }));
            return;
          }

          await sendFn(jid, message);
          logger.info({ jid, remaining: rateLimitResult.remaining }, '/api/send message sent');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, remaining: rateLimitResult.remaining }));
        } catch (err) {
          logger.error({ error: err }, '/api/send error');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (url.pathname === '/api/notify' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { title, body: notifBody, source } = JSON.parse(body);
          if (!title || !source) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing title or source' }));
            return;
          }
          await routeNotification({ title, body: notifBody || '', source });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          logger.error({ error: err }, '/api/notify error');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // Agent quality review stats
    if (url.pathname === '/api/quality/stats' && req.method === 'GET') {
      const groupId = url.searchParams.get('group_id') || undefined;
      const days = parseInt(url.searchParams.get('days') || '30', 10);
      const { getQualityStats } = await import('./db.js');
      const stats = getQualityStats(groupId, days);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (url.pathname === '/api/quality/reviews' && req.method === 'GET') {
      const groupId = url.searchParams.get('group_id') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const { getRecentReviews } = await import('./db.js');
      const reviews = getRecentReviews(groupId, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reviews));
      return;
    }

    // Fieldy webhook endpoint — log all requests to this path
    if (url.pathname.startsWith('/webhooks/fieldy')) {
      logger.info({ method: req.method, pathname: url.pathname, headers: req.headers }, 'Fieldy webhook request received');
    }
    if (url.pathname === '/webhooks/fieldy' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          // Dynamically import Fieldy integration
          const { fieldyIntegration } = await import('./integrations/fieldy-integration.js');
          const result = await fieldyIntegration.handleWebhook(payload);

          if (result.success) {
            logger.info({ transcriptId: payload.id }, 'Fieldy webhook processed successfully');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } else {
            logger.warn({ payload, result }, 'Fieldy webhook processing failed');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }
        } catch (err) {
          logger.error({ error: err }, 'Error in Fieldy webhook handler');
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    if (url.pathname === '/office' || url.pathname === '/office/') {
      try {
        const officePath = path.join(GROUPS_DIR, 'main', 'nanoclaw-office', 'index.html');
        const content = fs.readFileSync(officePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      } catch {
        res.writeHead(404); res.end('Office dashboard not found');
      }
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // Bind to 127.0.0.1 only. Remote access goes through Cloudflare tunnel
  // (which connects to localhost) with token auth, or through Tailscale
  // (which also proxies to localhost). No reason to bind to 0.0.0.0.
  server.listen(PORT, '127.0.0.1', () => {
    logger.info({ port: PORT }, 'DashClaw running at http://localhost:8080');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port: PORT }, 'DashClaw port already in use — skipping dashboard');
    } else {
      logger.error({ err }, 'DashClaw server error');
    }
  });
}
