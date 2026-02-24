/**
 * DashClaw — local-only web dashboard on port 8080.
 * Shows active containers, tasks, groups, HITL events, security log, and memory files.
 * Integrated into the main NanoClaw process — call startDashboard() from main().
 */

import fs from 'fs';
import http from 'http';
import path from 'path';

import { EARNING_GOAL, GROUPS_DIR, STORE_DIR } from './config.js';
import {
  getAllBounties,
  getAllRegisteredGroups,
  getAllTasks,
  getEconomicsSummary,
  getAllUsageRecent,
  getActiveClawworkTasks,
  getTotalUsage,
  getUsageSince,
} from './db.js';
import { getSurvivalTier } from './economics.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import { getIndexStats } from './semantic-index.js';

const PORT = parseInt(process.env.DASHCLAW_PORT || '8080', 10);
const LOG_PATH = path.join(process.cwd(), 'logs', 'nanoclaw.log');

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

  const activeContainers = Object.entries(groups).map(([jid, g]) => ({
    jid,
    name: g.name,
    folder: g.folder,
    hasActiveContainer: queue.isActive(jid),
  }));

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
  };
}

function apiEconomics() {
  const summary = getEconomicsSummary();
  const recentUsage = getAllUsageRecent(20);
  const activeTasks = getActiveClawworkTasks();

  // Calculate time-based usage
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const totalUsage = getTotalUsage();
  const todayUsage = getUsageSince(todayStart);
  const weekUsage = getUsageSince(weekStart);
  const monthUsage = getUsageSince(monthStart);

  return {
    groups: summary.groups.map(g => ({
      group_id: g.group_id,
      balance: g.balance,
      total_earned: g.total_earned,
      total_spent: g.total_spent,
      tier: getSurvivalTier(g.balance),
    })),
    recentUsage: recentUsage.map(u => ({
      run_at: u.run_at,
      group_id: u.group_id,
      cost_usd: u.cost_usd,
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      duration_ms: u.duration_ms,
    })),
    activeTasks: activeTasks.map(t => ({
      id: t.id,
      group_id: t.group_id,
      occupation: t.occupation,
      max_payment: t.max_payment,
      status: t.status,
    })),
    totals: {
      all_earned: summary.all_earned,
      all_spent: summary.all_spent,
      net: summary.net,
    },
    goal: {
      target: EARNING_GOAL,
      earned: summary.all_earned,
      pct: Math.min(100, (summary.all_earned / EARNING_GOAL) * 100),
      remaining: Math.max(0, EARNING_GOAL - summary.all_earned),
    },
    claudeUsage: {
      total: totalUsage,
      today: todayUsage,
      week: weekUsage,
      month: monthUsage,
    },
  };
}

function apiBounties() {
  const bounties = getAllBounties(100);
  return { bounties };
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
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1rem; }
  .card.full { grid-column: 1 / -1; }
  .card h2 { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
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
  .memory-tabs { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
  .tab { padding: 0.3rem 0.75rem; border-radius: 0.375rem; font-size: 0.78rem; cursor: pointer; background: var(--bg); border: 1px solid var(--border); color: var(--muted); }
  .tab.active { background: var(--accent); color: white; border-color: var(--accent); }
  .memory-content { background: #07070d; border: 1px solid var(--border); border-radius: 0.5rem; padding: 0.75rem; font-family: var(--mono); font-size: 0.75rem; color: #94a3b8; max-height: 320px; overflow-y: auto; white-space: pre-wrap; }
  .empty { color: var(--muted); font-size: 0.82rem; padding: 0.5rem 0; }
  #live-dot { animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
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
let dashTab = 'overview'; // 'overview' | 'economics' | 'bounties'

function fmt(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function tierBadge(tier) {
  const colors = { thriving: 'green', stable: 'green', struggling: 'yellow', critical: 'red', bankrupt: 'red' };
  return \`<span class="pill \${colors[tier] || 'yellow'}">\${tier}</span>\`;
}

function renderEvent(e) {
  const cls = e.event === 'HITL' ? 'hitl' : e.event === 'Security Block' ? 'block' : '';
  return \`<tr class="event-row \${cls}"><td>\${e.event}</td><td class="mono">\${e.time ? new Date(e.time*1000||e.time).toLocaleTimeString() : ''}</td><td>\${e.detail.slice(0,80)}</td></tr>\`;
}

async function refreshBounties() {
  try {
    const data = await fetch('/api/bounties').then(r => r.json());
    const bounties = data.bounties || [];
    const statusColors = { proposed: 'yellow', approved: 'green', rejected: 'red', working: 'green', submitted: 'green' };
    document.getElementById('main').innerHTML = \`
      <div class="card full" style="margin-bottom:0.5rem">
        <div class="memory-tabs">
          <span class="tab" onclick="dashTab='overview';refresh()">Overview</span>
          <span class="tab" onclick="dashTab='economics';refresh()">Economics</span>
          <span class="tab active">Bounties</span>
        </div>
      </div>
      <div class="card full">
        <h2>💰 Bounty Opportunities <span class="pill yellow">\${bounties.length}</span></h2>
        \${bounties.length === 0 ? '<p class="empty">No bounties yet. Ask the agent to find_bounties.</p>' : \`
        <table>
          <thead><tr><th>Platform</th><th>Title</th><th>Reward</th><th>Status</th><th>Proposed</th><th>URL</th></tr></thead>
          <tbody>\${bounties.map(b => \`
            <tr>
              <td><span class="pill yellow">\${b.platform}</span></td>
              <td>\${b.title.slice(0, 60)}\${b.title.length > 60 ? '…' : ''}</td>
              <td class="mono">\${b.reward_usd != null ? '$' + b.reward_usd : (b.reward_raw || '?')}</td>
              <td><span class="pill \${statusColors[b.status] || 'yellow'}">\${b.status}</span></td>
              <td class="mono">\${fmt(b.proposed_at)}</td>
              <td><a href="\${b.url}" target="_blank" style="color:var(--accent2);font-size:0.75rem">link</a></td>
            </tr>
          \`).join('')}</tbody>
        </table>\`}
      </div>
    \`;
  } catch(e) {
    console.error('Bounties refresh failed', e);
  }
}

async function refreshEconomics() {
  try {
    const econ = await fetch('/api/economics').then(r => r.json());
    const goal = econ.goal || { target: 5000, earned: 0, pct: 0, remaining: 5000 };
    const barFilled = Math.round(goal.pct / 5); // 20 segments
    const bar = '█'.repeat(barFilled) + '░'.repeat(20 - barFilled);
    const usage = econ.claudeUsage || { total: {}, today: {}, week: {}, month: {} };
    document.getElementById('main').innerHTML = \`
      <div class="card full" style="margin-bottom:0.5rem">
        <div class="memory-tabs">
          <span class="tab" onclick="dashTab='overview';refresh()">Overview</span>
          <span class="tab active">Economics</span>
          <span class="tab" onclick="dashTab='bounties';refresh()">Bounties</span>
        </div>
      </div>
      <!-- Computer Fund Goal -->
      <div class="card full" style="border-color:var(--accent);background:linear-gradient(135deg,#12121a,#1a1228)">
        <h2>🖥️ Computer Fund Goal</h2>
        <div style="margin:0.5rem 0">
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:0.4rem">
            <span>$\${goal.earned.toFixed(2)} earned</span>
            <span style="color:var(--muted)">Goal: $\${goal.target.toLocaleString()}</span>
            <span style="color:var(--accent)">\${goal.pct.toFixed(1)}%</span>
          </div>
          <div style="background:#1e1e2e;border-radius:4px;height:20px;overflow:hidden">
            <div style="background:linear-gradient(90deg,var(--accent),var(--accent2));height:100%;width:\${goal.pct}%;transition:width 0.5s;border-radius:4px"></div>
          </div>
          <div style="text-align:right;font-size:0.78rem;color:var(--muted);margin-top:0.3rem">$\${goal.remaining.toFixed(2)} remaining</div>
        </div>
        <div class="mono" style="color:var(--muted);font-size:0.7rem;margin-top:0.25rem">\${bar} \${goal.pct.toFixed(1)}%</div>
      </div>
      <!-- Claude Usage Costs -->
      <div class="card full" style="border-color:var(--accent2);background:linear-gradient(135deg,#12121a,#1a2228)">
        <h2>☁️ Claude Usage & Costs</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-top:0.75rem">
          <div style="background:#07070d;border:1px solid var(--border);border-radius:0.5rem;padding:0.75rem">
            <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Total (All Time)</div>
            <div style="font-size:1.5rem;font-weight:700;color:var(--accent2);margin:0.25rem 0">$\${(usage.total.total_cost || 0).toFixed(2)}</div>
            <div style="font-size:0.7rem;color:var(--muted)">\${((usage.total.total_tokens || 0) / 1000000).toFixed(2)}M tokens</div>
            <div style="font-size:0.7rem;color:var(--muted)">\${(usage.total.run_count || 0).toLocaleString()} runs</div>
          </div>
          <div style="background:#07070d;border:1px solid var(--border);border-radius:0.5rem;padding:0.75rem">
            <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">This Month</div>
            <div style="font-size:1.5rem;font-weight:700;color:var(--green);margin:0.25rem 0">$\${(usage.month.total_cost || 0).toFixed(2)}</div>
            <div style="font-size:0.7rem;color:var(--muted)">\${((usage.month.total_tokens || 0) / 1000000).toFixed(2)}M tokens</div>
            <div style="font-size:0.7rem;color:var(--muted)">\${(usage.month.run_count || 0).toLocaleString()} runs</div>
          </div>
          <div style="background:#07070d;border:1px solid var(--border);border-radius:0.5rem;padding:0.75rem">
            <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Last 7 Days</div>
            <div style="font-size:1.5rem;font-weight:700;color:var(--yellow);margin:0.25rem 0">$\${(usage.week.total_cost || 0).toFixed(2)}</div>
            <div style="font-size:0.7rem;color:var(--muted)">\${((usage.week.total_tokens || 0) / 1000000).toFixed(2)}M tokens</div>
            <div style="font-size:0.7rem;color:var(--muted)">\${(usage.week.run_count || 0).toLocaleString()} runs</div>
          </div>
          <div style="background:#07070d;border:1px solid var(--border);border-radius:0.5rem;padding:0.75rem">
            <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Today</div>
            <div style="font-size:1.5rem;font-weight:700;color:var(--accent);margin:0.25rem 0">$\${(usage.today.total_cost || 0).toFixed(2)}</div>
            <div style="font-size:0.7rem;color:var(--muted)">\${((usage.today.total_tokens || 0) / 1000000).toFixed(2)}M tokens</div>
            <div style="font-size:0.7rem;color:var(--muted)">\${(usage.today.run_count || 0).toLocaleString()} runs</div>
          </div>
        </div>
      </div>
      <!-- Summary -->
      <div class="card">
        <h2>💵 Economic Summary</h2>
        <table><tbody>
          <tr><td>Total Earned</td><td class="mono">$\${econ.totals.all_earned.toFixed(4)}</td></tr>
          <tr><td>Total Spent</td><td class="mono">$\${econ.totals.all_spent.toFixed(4)}</td></tr>
          <tr><td>Net</td><td class="mono">$\${econ.totals.net.toFixed(4)}</td></tr>
          <tr><td>Active Tasks</td><td class="mono">\${econ.activeTasks.length}</td></tr>
        </tbody></table>
      </div>
      <!-- Group balances -->
      <div class="card">
        <h2>🏦 Group Balances</h2>
        \${econ.groups.length === 0 ? '<p class="empty">No economic data yet</p>' : \`
        <table>
          <thead><tr><th>Group</th><th>Balance</th><th>Earned</th><th>Spent</th><th>Tier</th></tr></thead>
          <tbody>\${econ.groups.map(g => \`
            <tr>
              <td class="mono">\${g.group_id}</td>
              <td class="mono">$\${g.balance.toFixed(2)}</td>
              <td class="mono">$\${g.total_earned.toFixed(4)}</td>
              <td class="mono">$\${g.total_spent.toFixed(4)}</td>
              <td>\${tierBadge(g.tier)}</td>
            </tr>
          \`).join('')}</tbody>
        </table>\`}
      </div>
      <!-- Recent usage -->
      <div class="card full">
        <h2>📊 Recent Usage (last 20 runs)</h2>
        \${econ.recentUsage.length === 0 ? '<p class="empty">No usage data yet</p>' : \`
        <table>
          <thead><tr><th>Time</th><th>Group</th><th>Cost</th><th>Input Tok</th><th>Output Tok</th><th>Duration</th></tr></thead>
          <tbody>\${econ.recentUsage.map(u => \`
            <tr>
              <td class="mono">\${fmt(u.run_at)}</td>
              <td class="mono">\${u.group_id}</td>
              <td class="mono">$\${u.cost_usd.toFixed(4)}</td>
              <td class="mono">\${u.input_tokens.toLocaleString()}</td>
              <td class="mono">\${u.output_tokens.toLocaleString()}</td>
              <td class="mono">\${u.duration_ms ? (u.duration_ms/1000).toFixed(1)+'s' : '—'}</td>
            </tr>
          \`).join('')}</tbody>
        </table>\`}
      </div>
      <!-- Active ClawWork tasks -->
      <div class="card full">
        <h2>🛠️ ClawWork Tasks</h2>
        \${econ.activeTasks.length === 0 ? '<p class="empty">No active tasks</p>' : \`
        <table>
          <thead><tr><th>ID</th><th>Group</th><th>Occupation</th><th>Max Pay</th><th>Status</th></tr></thead>
          <tbody>\${econ.activeTasks.map(t => \`
            <tr>
              <td class="mono">\${t.id.slice(0,14)}…</td>
              <td class="mono">\${t.group_id}</td>
              <td>\${t.occupation}</td>
              <td class="mono">$\${t.max_payment.toFixed(2)}</td>
              <td><span class="pill yellow">\${t.status}</span></td>
            </tr>
          \`).join('')}</tbody>
        </table>\`}
      </div>
    \`;
  } catch(e) {
    console.error('Economics refresh failed', e);
  }
}

async function refresh() {
  if (dashTab === 'economics') { await refreshEconomics(); return; }
  if (dashTab === 'bounties') { await refreshBounties(); return; }
  try {
    const [status, memory, econ] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/memory?file=' + encodeURIComponent(memTab)).then(r => r.text()),
      fetch('/api/economics').then(r => r.json()),
    ]);

    const totalGroups = status.groups.length;
    const activeGroups = status.groups.filter(g => g.hasActiveContainer).length;
    const activeTasks = status.tasks.filter(t => t.status === 'active').length;
    const secCount = status.securityEvents.length;
    const goal = econ.goal || { target: 5000, earned: 0, pct: 0 };

    document.getElementById('main').innerHTML = \`
      <div class="card full" style="margin-bottom:0.5rem">
        <div class="memory-tabs">
          <span class="tab active">Overview</span>
          <span class="tab" onclick="dashTab='economics';refresh()">Economics</span>
          <span class="tab" onclick="dashTab='bounties';refresh()">Bounties</span>
          <span class="pill yellow" style="margin-left:auto">🖥️ $\${goal.earned.toFixed(2)}/$\${goal.target} (\${goal.pct.toFixed(1)}%)</span>
        </div>
      </div>
      <!-- Groups -->
      <div class="card">
        <h2>🤖 Agents <span class="pill \${activeGroups > 0 ? 'green' : 'yellow'}">\${activeGroups} active</span></h2>
        \${status.groups.length === 0 ? '<p class="empty">No groups registered</p>' : \`
        <table>
          <thead><tr><th>Group</th><th>Status</th><th>Folder</th></tr></thead>
          <tbody>\${status.groups.map(g => \`
            <tr>
              <td>\${g.name}</td>
              <td><span class="dot \${g.hasActiveContainer ? 'green' : 'red'}"></span> \${g.hasActiveContainer ? 'Running' : 'Idle'}</td>
              <td class="mono">\${g.folder}</td>
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
          status.recentErrors.map(e => \`<div class="log-box" style="max-height:60px;margin-bottom:4px">\${e.time} \${e.msg}</div>\`).join('')
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
          try { const o = JSON.parse(l); return (o.time?new Date(o.time*1000||o.time).toLocaleTimeString():'') + ' ' + (o.msg||l); } catch { return l; }
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

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

// ── HTTP server ────────────────────────────────────────────────────────────────

export function startDashboard(queue: GroupQueue): void {
  const server = http.createServer((req, res) => {
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

    if (url.pathname === '/api/economics') {
      try {
        const data = apiEconomics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/bounties') {
      try {
        const data = apiBounties();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
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

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  // Listen on all interfaces (0.0.0.0) to allow Tailscale access
  // Security: localhost check in request handler ensures only local/Tailscale access
  server.listen(PORT, '0.0.0.0', () => {
    logger.info({ port: PORT }, 'DashClaw running at http://localhost:8080 (accessible via Tailscale)');
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port: PORT }, 'DashClaw port already in use — skipping dashboard');
    } else {
      logger.error({ err }, 'DashClaw server error');
    }
  });
}
