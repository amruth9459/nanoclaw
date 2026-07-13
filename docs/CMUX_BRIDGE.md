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

## Enabling it for the always-on daemon

cmux's control socket defaults to `socketControlMode: "cmuxOnly"` — **only
cmux's own descendant processes may drive the socket.** Consequences:

- **Works today, no setup:** if NanoClaw runs *inside a cmux tab* (e.g.
  `npm run dev` started from cmux), its process is a cmux descendant and the
  bridge works immediately. Verified: `list`/`read` return live data.
- **The launchd daemon (`com.nanoclaw`) is NOT a cmux descendant**, so cmux
  accepts then drops its connection (`Failed to write to socket (Broken pipe)`).
  The IPC round-trip itself is verified working end-to-end; only this final hop
  is gated by cmux.

To let the background daemon drive cmux, switch cmux to password-authed socket
control (keeps random local processes out — they'd need the password):

1. In `~/.config/cmux/cmux.json` (back it up first — cmux keeps a `.bak`), add an
   uncommented `automation` block:
   ```json
   "automation": {
     "socketControlMode": "password",
     "socketPassword": "<a long random string>"
   }
   ```
2. Reload without restarting the app: `cmux reload-config`.
3. Give the daemon the password. In `~/Library/LaunchAgents/com.nanoclaw.plist`
   `EnvironmentVariables`, add `CMUX_SOCKET_PASSWORD=<same string>`, then
   `launchctl unload` + `launchctl load` the agent.

`src/cmux-bridge.ts` forwards `CMUX_SOCKET_PASSWORD` to every cmux call, so once
those are set the daemon can list/read/drive sessions.

Alternative (no cmux security change): run NanoClaw from a cmux tab in dev mode.
