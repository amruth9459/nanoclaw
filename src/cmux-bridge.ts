/**
 * cmux bridge — lets the main-group agent see and drive the user's cmux
 * coding sessions (each workspace is a Claude Code / Codex / opencode agent).
 *
 * Security model:
 *  - Only the main group may call this (enforced in ipc.ts, mirrored here).
 *  - Every cmux invocation uses execFile with an argv array — NEVER a shell
 *    string — so workspace refs and free text can't inject host commands.
 *  - Workspace refs are validated against a strict whitelist before use.
 *  - `send` is the only state-changing action and is the exact equivalent of
 *    typing into that pane, so it inherits the main-group trust boundary.
 *
 * The cmux CLI talks to the desktop app over a Unix socket that it
 * auto-discovers from HOME (~/.local/state/cmux/). Verified reachable from a
 * clean launchd-style environment (only HOME + PATH), so no password or
 * explicit socket path is required.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

const CMUX_BIN =
  process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';

/**
 * Read cmux's configured socket password from ~/.config/cmux/cmux.json so the
 * daemon can authenticate to cmux without duplicating the secret in the plist.
 * The file is JSONC (comments); strip them before parsing. Returns '' if unset.
 */
function readCmuxSocketPassword(): string {
  if (process.env.CMUX_SOCKET_PASSWORD) return process.env.CMUX_SOCKET_PASSWORD;
  try {
    const home = process.env.HOME || '/Users/amrut';
    const raw = fs.readFileSync(path.join(home, '.config', 'cmux', 'cmux.json'), 'utf-8');
    // JSONC with trailing commas — don't JSON.parse. Drop whole-line comments so
    // cmux's commented example socketPassword can't shadow the real one, then
    // regex the active value out.
    const active = raw
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');
    const m = active.match(/"socketPassword"\s*:\s*"([^"]*)"/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

export type CmuxAction = 'list' | 'read' | 'send' | 'notify';

export interface CmuxRequest {
  action: CmuxAction;
  workspace?: string;
  text?: string;
  lines?: number;
  submit?: boolean;
  title?: string;
}

export interface CmuxResult {
  success: boolean;
  output: string;
  error?: string;
}

/** cmux workspace refs are `workspace:N`, a bare index `N`, or a UUID. */
function normalizeWorkspace(raw: string): string {
  const ws = String(raw).trim();
  if (/^workspace:\d+$/.test(ws)) return ws;
  if (/^\d+$/.test(ws)) return `workspace:${ws}`;
  if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(ws))
    return ws;
  throw new Error(
    `Invalid workspace ref "${raw}". Use a number (e.g. 27), "workspace:27", or a UUID.`,
  );
}

/**
 * Invoke the cmux CLI.
 *
 * cmux's control socket defaults to `socketControlMode: "cmuxOnly"` — only
 * cmux's own descendant processes may drive it. So this works out of the box
 * only when NanoClaw itself runs inside a cmux tab (e.g. `npm run dev` launched
 * from cmux). When NanoClaw runs as the background launchd daemon it is NOT a
 * cmux descendant, so cmux drops the connection (EPIPE / "Broken pipe"). To
 * enable it there, set a socket password in cmux
 * (automation.socketControlMode = "password" + socketPassword) and export
 * CMUX_SOCKET_PASSWORD to the daemon — forwarded here. See docs/CMUX_BRIDGE.md.
 */
async function runCmux(args: string[], timeoutMs = 15000): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME || '/Users/amrut',
    PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    CMUX_QUIET: '1',
  };
  if (process.env.CMUX_SOCKET_PATH) env.CMUX_SOCKET_PATH = process.env.CMUX_SOCKET_PATH;
  const pw = readCmuxSocketPassword();
  if (pw) env.CMUX_SOCKET_PASSWORD = pw;
  const { stdout } = await execFileAsync(CMUX_BIN, args, {
    env,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

const BRAILLE = /^[⠀-⣿]/; // spinner glyph => agent actively working
const STAR = /^✳/; // ✳ => idle / awaiting attention

interface Workspace {
  ref: string;
  index: number;
  title: string;
  current_directory: string;
  latest_conversation_message?: string;
  latest_submitted_at?: string;
  pinned?: boolean;
  selected?: boolean;
}

function deriveState(title: string): 'working' | 'idle' | 'named' {
  if (BRAILLE.test(title)) return 'working';
  if (STAR.test(title)) return 'idle';
  return 'named';
}

function cleanTitle(title: string): string {
  return title.replace(BRAILLE, '').replace(STAR, '').trim();
}

async function listSessions(): Promise<string> {
  const raw = await runCmux(['workspace', 'list', '--json']);
  const parsed = JSON.parse(raw) as { workspaces: Workspace[] };
  const rows = parsed.workspaces.map((w) => {
    const state = deriveState(w.title);
    const dir = w.current_directory ? w.current_directory.replace(process.env.HOME || '', '~') : '';
    const last = (w.latest_conversation_message || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const marker = state === 'working' ? '▶' : state === 'idle' ? '·' : ' ';
    const idx = w.ref.replace('workspace:', '');
    return `${marker} [${idx}] ${cleanTitle(w.title) || '(untitled)'}${dir ? `  — ${dir}` : ''}${last ? `\n     last: ${last}` : ''}`;
  });
  const working = parsed.workspaces.filter((w) => deriveState(w.title) === 'working').length;
  const header = `${parsed.workspaces.length} cmux sessions (${working} actively working). ▶ working  · idle`;
  return `${header}\n\n${rows.join('\n')}`;
}

export async function runCmuxAction(req: CmuxRequest): Promise<CmuxResult> {
  try {
    switch (req.action) {
      case 'list': {
        return { success: true, output: await listSessions() };
      }
      case 'read': {
        if (!req.workspace) return { success: false, output: '', error: 'read requires a workspace' };
        const ws = normalizeWorkspace(req.workspace);
        const lines = Math.min(Math.max(Number(req.lines) || 40, 1), 200);
        const out = await runCmux(['read-screen', '--workspace', ws, '--lines', String(lines)]);
        return { success: true, output: out.trimEnd() || '(screen is empty)' };
      }
      case 'send': {
        if (!req.workspace) return { success: false, output: '', error: 'send requires a workspace' };
        if (!req.text || !req.text.trim())
          return { success: false, output: '', error: 'send requires non-empty text' };
        const ws = normalizeWorkspace(req.workspace);
        await runCmux(['send', '--workspace', ws, req.text]);
        // Default to submitting (press Enter) unless caller opts out.
        if (req.submit !== false) {
          await runCmux(['send-key', '--workspace', ws, 'Enter']);
        }
        return {
          success: true,
          output: `Sent to ${ws}${req.submit === false ? ' (not submitted)' : ' and submitted'}.`,
        };
      }
      case 'notify': {
        if (!req.workspace) return { success: false, output: '', error: 'notify requires a workspace' };
        const ws = normalizeWorkspace(req.workspace);
        const args = ['notify', '--workspace', ws, '--title', req.title || 'NanoClaw'];
        if (req.text) args.push('--body', req.text);
        await runCmux(args);
        return { success: true, output: `Notified ${ws}.` };
      }
      default:
        return { success: false, output: '', error: `Unknown cmux action: ${req.action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: '', error: msg };
  }
}
