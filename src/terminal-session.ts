/**
 * TerminalSession — persistent interactive terminal via tmux + node-pty.
 *
 * Multi-client broadcast: all connected clients see the same output in real-time.
 * TerminalSessionManager holds a pool of named sessions — multiple tmux sessions
 * can be active simultaneously, and each session broadcasts to all its subscribers.
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { logger } from './logger.js';

const _require = createRequire(import.meta.url);

interface IPty {
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pid: number;
}

interface NodePty {
  spawn(
    file: string,
    args: string[],
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): IPty;
}

const pty: NodePty = _require('node-pty');

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
  size: string;
}

/** List all tmux sessions. Returns empty array if tmux server is not running. */
export function listTmuxSessions(): TmuxSessionInfo[] {
  try {
    const raw = execSync(
      "tmux list-sessions -F '#{session_name}|#{session_windows}|#{session_activity}|#{session_attached}|#{window_width}x#{window_height}'",
      { encoding: 'utf-8', timeout: 3000 },
    ).trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => {
      const [name, windows, activity, attached, size] = line.split('|');
      const ts = parseInt(activity, 10);
      const created = ts ? new Date(ts * 1000).toLocaleString() : '';
      return {
        name,
        windows: parseInt(windows, 10) || 1,
        created,
        attached: attached === '1',
        size: size || '',
      };
    });
  } catch {
    return [];
  }
}

/** Callback pair for a single WS client subscribed to a terminal session. */
export interface TerminalClient {
  id: string;
  onData: (data: string) => void;
  onExit: (info: { exitCode: number; signal?: number; reason?: string }) => void;
}

/**
 * A single terminal session backed by node-pty + tmux.
 * Broadcasts output to all subscribed clients.
 */
class TerminalSession {
  private ptyProcess: IPty | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private dataDisposable: { dispose: () => void } | null = null;
  private exitDisposable: { dispose: () => void } | null = null;
  private clients = new Map<string, TerminalClient>();
  readonly sessionName: string;

  constructor(sessionName: string) {
    this.sessionName = sessionName;
  }

  get active(): boolean {
    return this.ptyProcess !== null;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Subscribe a client. If PTY isn't running yet, starts it. */
  addClient(client: TerminalClient, cols: number, rows: number): void {
    this.clients.set(client.id, client);

    if (!this.ptyProcess) {
      this.startPty(cols, rows);
    }

    this.resetInactivityTimer();
    logger.info({ session: this.sessionName, clientId: client.id, totalClients: this.clients.size }, 'Terminal client added');
  }

  /** Unsubscribe a client. PTY stays alive for remaining clients / future reconnect. */
  removeClient(clientId: string): void {
    this.clients.delete(clientId);
    logger.info({ session: this.sessionName, clientId, totalClients: this.clients.size }, 'Terminal client removed');

    // Reset inactivity timer — if no clients, PTY will eventually time out
    if (this.clients.size > 0) {
      this.resetInactivityTimer();
    }
    // Don't kill PTY immediately — other clients may reconnect or tmux persists
  }

  write(data: string): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.write(data);
    this.resetInactivityTimer();
  }

  resize(cols: number, rows: number): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.resize(cols, rows);
  }

  stop(): void {
    this.cleanup();
  }

  private startPty(cols: number, rows: number): void {
    const shell = process.env.SHELL || '/bin/zsh';

    try {
      this.ptyProcess = pty.spawn('tmux', ['new-session', '-A', '-s', this.sessionName], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME || '/Users/amrut',
        env: {
          ...process.env as Record<string, string>,
          TERM: 'xterm-256color',
          SHELL: shell,
        },
      });

      this.dataDisposable = this.ptyProcess.onData((data: string) => {
        // Broadcast to all subscribed clients
        for (const client of this.clients.values()) {
          try { client.onData(data); } catch { /* client send failed, ignore */ }
        }
      });

      this.exitDisposable = this.ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info({ exitCode, signal, session: this.sessionName }, 'Terminal PTY exited');
        const exitInfo = { exitCode, signal };
        for (const client of this.clients.values()) {
          try { client.onExit(exitInfo); } catch { /* ignore */ }
        }
        this.cleanup();
      });

      this.resetInactivityTimer();
      logger.info({ cols, rows, pid: this.ptyProcess.pid, session: this.sessionName }, 'Terminal PTY started');
    } catch (err) {
      logger.error({ err, session: this.sessionName }, 'Failed to start terminal PTY');
      throw err;
    }
  }

  private cleanup(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
    if (this.dataDisposable) {
      this.dataDisposable.dispose();
      this.dataDisposable = null;
    }
    if (this.exitDisposable) {
      this.exitDisposable.dispose();
      this.exitDisposable = null;
    }
    if (this.ptyProcess) {
      try { this.ptyProcess.kill(); } catch { /* already dead */ }
      this.ptyProcess = null;
    }
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    this.inactivityTimer = setTimeout(() => {
      logger.info({ session: this.sessionName, clients: this.clients.size }, 'Terminal session timed out due to inactivity');
      const exitInfo = { exitCode: 0, signal: undefined, reason: 'inactivity' };
      for (const client of this.clients.values()) {
        try { client.onExit(exitInfo as { exitCode: number; signal?: number; reason?: string }); } catch { /* ignore */ }
      }
      this.cleanup();
    }, INACTIVITY_TIMEOUT_MS);
  }
}

/**
 * Manages a pool of named terminal sessions.
 * Multiple clients can subscribe to the same session for real-time broadcast.
 */
export class TerminalSessionManager {
  private sessions = new Map<string, TerminalSession>();

  /**
   * Subscribe a client to a named tmux session.
   * Creates PTY if not already running; otherwise joins the existing broadcast.
   */
  join(sessionName: string, client: TerminalClient, cols: number, rows: number): void {
    const safeName = sessionName.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!safeName) throw new Error('Invalid session name');

    let session = this.sessions.get(safeName);
    if (!session) {
      session = new TerminalSession(safeName);
      this.sessions.set(safeName, session);
    }

    session.addClient(client, cols, rows);
  }

  /** Remove a client from all sessions it may be in. */
  leave(clientId: string): void {
    for (const [name, session] of this.sessions) {
      session.removeClient(clientId);
      // Clean up session object if PTY is dead and no clients
      if (!session.active && session.clientCount === 0) {
        this.sessions.delete(name);
      }
    }
  }

  /** Write input to a named session's PTY. */
  write(sessionName: string, data: string): void {
    this.sessions.get(sessionName)?.write(data);
  }

  /** Resize a named session's PTY. */
  resize(sessionName: string, cols: number, rows: number): void {
    this.sessions.get(sessionName)?.resize(cols, rows);
  }

  /** Stop a named session's PTY. */
  stop(sessionName: string): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.stop();
      this.sessions.delete(sessionName);
    }
  }

  /** Check if a named session has an active PTY. */
  isActive(sessionName: string): boolean {
    return this.sessions.get(sessionName)?.active ?? false;
  }
}
