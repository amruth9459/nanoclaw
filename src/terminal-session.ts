/**
 * TerminalSession — persistent interactive terminal via tmux + node-pty.
 *
 * tmux manages session persistence (survives disconnects/server restarts).
 * node-pty creates a PTY attached to `tmux new-session -A -s claw-mobile`.
 * Single-connection enforcement: new start() kills old PTY first.
 */

import { EventEmitter } from 'events';
import { createRequire } from 'module';
import { logger } from './logger.js';

const _require = createRequire(import.meta.url);

// node-pty is a native module, load via createRequire
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

const TMUX_SESSION = 'claw-mobile';
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class TerminalSession extends EventEmitter {
  private ptyProcess: IPty | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private dataDisposable: { dispose: () => void } | null = null;
  private exitDisposable: { dispose: () => void } | null = null;

  /** True if a PTY is currently alive */
  get active(): boolean {
    return this.ptyProcess !== null;
  }

  /**
   * Start or reattach to the tmux session.
   * If an existing PTY is open, it's killed first (single-connection).
   */
  start(cols: number, rows: number): void {
    // Kill existing PTY if any (single-connection enforcement)
    if (this.ptyProcess) {
      this.cleanup();
    }

    const shell = process.env.SHELL || '/bin/zsh';

    try {
      this.ptyProcess = pty.spawn('tmux', ['new-session', '-A', '-s', TMUX_SESSION], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: process.env.HOME || '/Users/amrut',
        env: {
          ...process.env as Record<string, string>,
          TERM: 'xterm-256color',
          // Ensure tmux uses the user's shell
          SHELL: shell,
        },
      });

      this.dataDisposable = this.ptyProcess.onData((data: string) => {
        this.emit('data', data);
      });

      this.exitDisposable = this.ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info({ exitCode, signal }, 'Terminal PTY exited');
        this.cleanup();
        this.emit('exit', { exitCode, signal });
      });

      this.resetInactivityTimer();
      logger.info({ cols, rows, pid: this.ptyProcess.pid }, 'Terminal session started');
    } catch (err) {
      logger.error({ err }, 'Failed to start terminal session');
      throw err;
    }
  }

  /** Write data to PTY stdin (keystrokes from client) */
  write(data: string): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.write(data);
    this.resetInactivityTimer();
  }

  /** Resize PTY dimensions */
  resize(cols: number, rows: number): void {
    if (!this.ptyProcess) return;
    this.ptyProcess.resize(cols, rows);
  }

  /** Stop the PTY (tmux session persists for next reconnect) */
  stop(): void {
    this.cleanup();
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
      try {
        this.ptyProcess.kill();
      } catch {
        // already dead
      }
      this.ptyProcess = null;
    }
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
    }
    this.inactivityTimer = setTimeout(() => {
      logger.info('Terminal session timed out due to inactivity');
      this.cleanup();
      this.emit('exit', { exitCode: 0, signal: undefined, reason: 'inactivity' });
    }, INACTIVITY_TIMEOUT_MS);
  }
}
