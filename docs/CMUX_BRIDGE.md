# cmux Session Bridge

Lets the WhatsApp agent (main group only) see and drive your cmux coding
sessions — list them, read a session's screen, send it a prompt/answer, or ping
it with a desktop notification.

## Usage (from WhatsApp, to Claw)

- "list my cmux sessions" → every workspace with its number, title, directory,
  working/idle state, and the last thing each session said.
- "what's session 27 doing" / "read session 27" → the current screen (e.g. shows
  a session sitting on a prompt waiting for your input).
- "tell session 27 to run the tests" / "answer session 27 with 1" → types into
  that session and presses Enter.
- "notify session 12 that the deploy is done" → desktop notification on it.

Under the hood: MCP tool `cmux_sessions` (container) → IPC `type:"cmux"` →
host handler in `src/ipc.ts` (main-group gated) → `src/cmux-bridge.ts` shells
out to the cmux CLI with an argv array (no shell string; workspace refs are
whitelisted to `workspace:N` / `N` / UUID, so free text can't inject).

## The session boundary (important)

cmux's control socket only serves processes **inside the cmux GUI session** —
in practice, processes descended from the cmux app. Verified exhaustively
2026-07-13:

- **Works today, no setup:** when NanoClaw runs *inside a cmux tab* (e.g.
  `npm run dev` launched from cmux), it's a cmux descendant → the bridge works
  immediately. Verified end-to-end: `list` returns all sessions with state,
  `read` returns a session's live screen.
- **The always-on launchd daemon (`com.nanoclaw`) is NOT a cmux descendant.**
  cmux accepts its socket connection then drops it (`Failed to write to socket
  (Broken pipe, errno 32)`). The NanoClaw IPC round-trip itself is verified
  working; only cmux's final socket hop rejects the daemon.
- **`socketControlMode: "password"` does NOT fix this** — tested and confirmed.
  The password is a second factor on top of the session check, not a bypass; the
  daemon is rejected before auth. `launchctl asuser` and explicit
  `CMUX_SOCKET_PATH` also don't bridge the daemon in. Both live sockets
  (`~/.local/state/cmux/cmux-501.sock`, `cmux.sock`) work for descendants and
  reject the daemon.

There is **no cmux config flag** that lets the background daemon drive the socket.

## Options for daemon-mode

1. **Run NanoClaw inside a cmux tab** (dev mode). Zero extra components; the
   bridge just works. Trade-off: not the launchd always-on setup.
2. **A cmux-resident relay (future work, not built).** A tiny long-running
   process started *inside a cmux tab* watches a queue dir; the daemon writes
   cmux requests there and reads back results. Because the relay is a cmux
   descendant, its cmux calls succeed. Trade-off: requires keeping that relay tab
   open; if it dies the bridge goes idle. Ask if you want this built.

`src/cmux-bridge.ts` still forwards `CMUX_SOCKET_PASSWORD` (from env or
`cmux.json`) when a password is configured, so it's ready for any setup that
needs one — no code change required to adopt option 1 or 2.
