#!/bin/bash
# Safety Gate — PreToolUse hook for Claude Code
# Blocks destructive commands and explains what was attempted in plain language.
# Works for both interactive (desktop) and host-runner (NanoClaw) sessions.
#
# Input: JSON on stdin with tool_name, tool_input
# Output: JSON with permissionDecision (allow/ask/deny) and reason

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null || echo "")
MODE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('permission_mode',''))" 2>/dev/null || echo "")

# Only gate Bash commands — Read/Write/Edit have their own permission model
if [ "$TOOL_NAME" != "Bash" ]; then
  echo '{}'
  exit 0
fi

COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('tool_input',{})))" 2>/dev/null || echo "{}")

if [ -z "$COMMAND" ]; then
  echo '{}'
  exit 0
fi

# Pass command and cwd to Python via env vars (safe from shell injection)
RESULT=$(CMD="$COMMAND" CWD_PATH="$CWD" PERMISSION_MODE="$MODE" TOOL_INPUT="$TOOL_INPUT" python3 << 'PYEOF'
import sys, json, re, os, shlex, subprocess

command = os.environ.get("CMD", "")
cwd = os.environ.get("CWD_PATH", "")
mode = os.environ.get("PERMISSION_MODE", "")
tool_input = json.loads(os.environ.get("TOOL_INPUT") or "{}")

# CRITICAL — immediate block, no exceptions
CRITICAL = [
    (r'\brm\s+-[a-zA-Z]*r[a-zA-Z]*f', "Recursively force-delete files — could wipe entire directories"),
    (r'\brm\s+-rf\s+[/~]', "Delete from root or home — extremely dangerous"),
    (r'\bgit\s+push\s+--force', "Force-push overwrites remote history — teammates lose work"),
    (r'\bgit\s+push\s+-f\b', "Force-push overwrites remote history — teammates lose work"),
    (r'\bgit\s+reset\s+--hard', "Hard reset throws away all uncommitted changes permanently"),
    (r'\bgit\s+clean\s+-[a-zA-Z]*f', "Force-clean deletes untracked files permanently"),
    (r'\bdrop\s+table\b', "Drop table deletes an entire database table and all its data"),
    (r'\bdrop\s+database\b', "Drop database deletes the entire database"),
    (r'\btruncate\s+table\b', "Truncate empties all rows from a table — data gone"),
    (r'\bdelete\s+from\b.*\bwhere\b.*\b1\s*=\s*1', "Delete all rows from a table"),
    (r'\bkubectl\s+delete\b', "Delete Kubernetes resources — could take down services"),
    (r'\bchmod\s+777\b', "Make files world-writable — major security hole"),
    (r'\bchown\s+-R\b', "Recursively change file ownership"),
    (r'\bmkfs\b', "Format a filesystem — destroys all data on the drive"),
    (r'\bdd\s+if=', "Low-level disk write — can overwrite drives"),
    (r'>\s*/dev/sd[a-z]', "Write directly to disk device — destroys data"),
    (r'\bsudo\s+rm\b', "Delete files as root — no safety net"),
    (r'\bkill\s+-9\s+(-1|1)\b', "Kill all processes — system crash"),
    (r'\blaunchctl\s+unload\b.*nanoclaw', "Stop NanoClaw service — you would lose WhatsApp connection"),
]

# HIGH RISK — block with explanation
HIGH = [
    (r'\brm\s', "Delete files"),
    (r'\bunlink\s', "Remove a file"),
    (r'\bgit\s+push\b', "Push code to remote repository"),
    (r'\bgit\s+reset\b', "Reset git history — may lose changes"),
    (r'\bgit\s+checkout\s+--\s', "Discard local file changes"),
    (r'\bgit\s+branch\s+-[dD]\b', "Delete a git branch"),
    (r'\bgit\s+rebase\b', "Rewrite git history"),
    (r'\bgit\s+stash\s+drop\b', "Delete stashed changes"),
    (r'\bnpm\s+publish\b', "Publish package to npm — goes public"),
    (r'\bnpm\s+unpublish\b', "Remove package from npm"),
    (r'\bpip\s+uninstall\b', "Uninstall a Python package"),
    (r'\bbrew\s+(uninstall|remove)\b', "Uninstall a program from your Mac"),
    (r'\bcurl\b.*-X\s*(DELETE|PUT|PATCH)', "Send a destructive request to a server"),
    (r'\bsystemctl\s+(stop|disable|restart)\b', "Change a system service"),
    (r'\blaunchctl\s+(unload|remove)\b', "Stop a macOS background service"),
    (r'\bdocker\s+(rm|rmi|system\s+prune)\b', "Remove Docker containers or images"),
]

# ENDING A PROCESS asks instead (owner pick 2026-10-25): an approval card in the Claude app,
# also on the phone. Only in the modes the docs say always show it; any other mode, or none
# given, keeps the old block. Quoted text and data heredocs are left out of the match so a
# note that only mentions the word does not ask; text handed to something that runs it stays.
STOP = r'\b(kill|pkill|killall)\b'
STOP_ASK_MODES = {"default", "auto"}
RUNS_TEXT = r'\s-[ce]\s|\bssh\b|\beval\b'
INTERPRETER = r'\b(bash|sh|zsh|python3?|node|ruby|perl|osascript|ssh)\b[^|;&\n]*$'
# Quote marks written as \x27 and \x22: /bin/bash 3.2 miscounts them inside this $( ) heredoc.
HEREDOC = re.compile(r"<<-?\s*([\x27\x22]?)(\w+)\1[^\n]*\n.*?\n\s*\2\s*(?=\n|$)", re.S)
QUOTED = re.compile(r"\x27[^\x27]*\x27|\x22(?:[^\x22\\]|\\.)*\x22")


def shell_view(cmd):
    def body(m):
        line = cmd[:m.start()].rsplit("\n", 1)[-1]
        return m.group(0) if re.search(INTERPRETER, line) else ""
    cmd = re.sub(r"(?m)^\s*#.*$", "", cmd)
    cmd = HEREDOC.sub(body, cmd)
    return cmd if re.search(RUNS_TEXT, cmd) else QUOTED.sub("", cmd)


# The card on the phone shows only "Allow Claude to run?" and the command text (screenshot
# 2026-10-25), so what the command ends and what that breaks go at its top as comment lines
# (owner ask 2026-10-25: the card must say what the action is and what the impact is).
# Patterns are the process lines of this Mac seen in ps on 2026-10-25.
KNOWN = [
    (r"sessions serve", "the session board on your phone (8446) stops until restarted"),
    (r"pulse\.py serve", "Pulse on your phone (8447) stops until restarted"),
    (r"New session opener", "you cannot start new sessions from the Claude app until it is restarted"),
    (r"--remote-control|--sdk-url", "a Claude session you use from the app closes mid-work"),
    (r"(^|/)claude(\s|$)|/claude/versions/", "a Claude session closes mid-work"),
    (r"colima|limactl", "Buzz prod and the Lexios databases go down"),
    (r"cmux\.app|(^|/)cmux(\s|$)", "every terminal tab closes, with the sessions in them"),
    (r"Tailscale|IPNExtension|tailscaled", "phone access to the Mac drops"),
    (r"tesla-watch|tesla-http-proxy", "the Tesla inventory watcher stops"),
    (r"qemu-system", "the Android test phone stops"),
    (r"screensharingd", "screen sharing to the Mac drops"),
]
UNKNOWN_TARGET = "# ACTION: end a process picked when the command runs (the gate cannot list it now)\n# IMPACT: unknown. Deny unless you know what it is."


def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=2).stdout


def target_pids(cmd):
    view = shell_view(cmd)
    pids, unknown = [], False
    for m in re.finditer(r"\bkill\b([^;&|\n]*)", view):
        words, skip = m.group(1).split(), False
        found = False
        for w in words:
            if skip:
                skip = False
            elif w in ("-s", "-n"):
                skip = True
            elif w.isdigit():
                pids.append(w)
                found = True
        unknown = unknown or not found
    # the name to match is often quoted, which shell_view drops, so read these from the command
    for m in re.finditer(r"\b(pkill|killall)\b([^;&|\n]*)", re.sub(r"(?m)^\s*#.*$", "", cmd)):
        try:
            words = shlex.split(m.group(2))
        except ValueError:
            unknown = True
            continue
        names = [w for w in words if not w.startswith("-")]
        if not names:
            unknown = True
            continue
        flag = "-x" if m.group(1) == "killall" else ("-f" if "-f" in words else None)
        pids += run(["pgrep"] + ([flag] if flag else []) + [names[-1]]).split()
    return pids, unknown


def running_for(etime):
    parts = re.split(r"[-:]", etime.strip())
    nums = [int(p) for p in parts]
    days = nums[0] if "-" in etime else 0
    hms = nums[1:] if "-" in etime else nums
    hours, minutes = (hms[0], hms[1]) if len(hms) == 3 else (0, hms[0])
    if days:
        return f"{days} days"
    if hours:
        return f"{hours} h"
    return f"{max(minutes, 1)} min"


def card_header(cmd):
    view = shell_view(cmd)
    pids, unknown = target_pids(cmd)
    force = " (forced: it cannot save or clean up)" if re.search(r"\s-(9|KILL|SIGKILL)\b", view) else ""
    lines, impacts = [], []
    rows = run(["ps", "-o", "pid=,etime=,command=", "-p", ",".join(pids)]).splitlines() if pids else []
    for row in rows[:4]:
        pid, etime, what = row.split(None, 2)
        words = what.split()
        short = " ".join([words[0].rsplit("/", 1)[-1]] + [w.rsplit("/", 1)[-1] for w in words[1:] if len(w) <= 40])
        lines.append(f"# ACTION: end {short[:70]} (pid {pid}, running {running_for(etime)}){force}")
        hit = next((i for p, i in KNOWN if re.search(p, what)), None)
        impacts.append(hit or "not one of the known services on this Mac")
    if len(rows) > 4:
        lines.append(f"# ... and {len(rows) - 4} more")
    if pids and not rows:
        lines.append(f"# ACTION: end pid {', '.join(pids)}, which is not running")
        impacts.append("none, nothing will happen")
    out = lines + [f"# IMPACT: {i}" for i in dict.fromkeys(impacts)]
    if unknown or not pids:
        out.append(UNKNOWN_TARGET)
    return "\n".join(out)

# CREDENTIAL EXPOSURE — block reading/printing sensitive files
CREDENTIAL = [
    (r'\bcat\b.*\.env\b', "Read .env file — may contain API keys and secrets"),
    (r'\bcat\b.*credentials', "Read credentials file"),
    (r'\bcat\b.*\.pem\b', "Read private key file"),
    (r'\bcat\b.*id_rsa', "Read SSH private key"),
    (r'\bcat\b.*\.key\b', "Read private key file"),
    (r'\bprintenv\b', "Print all environment variables — may leak secrets"),
    (r'\benv\b\s*$', "Print all environment variables — may leak secrets"),
    (r'\bexport\b.*(_KEY|_SECRET|_TOKEN|PASSWORD)=', "Set sensitive environment variable in command history"),
    (r'\bcurl\b.*(-H|--header)\s*"?(Authorization|Bearer|X-Api-Key)', "Send authorization headers — could leak tokens"),
    (r'\becho\b.*\$\{?(ANTHROPIC|OPENAI|AWS_SECRET|STRIPE|TWILIO|GITHUB_TOKEN)', "Print API key to stdout"),
]

decision = "allow"
reason = ""

for pattern, desc in CRITICAL:
    if re.search(pattern, command, re.IGNORECASE):
        decision = "deny"
        reason = f"BLOCKED: {desc}.\n\nThe command was: {command[:200]}"
        break

if decision == "allow":
    for pattern, desc in CREDENTIAL:
        if re.search(pattern, command, re.IGNORECASE):
            decision = "deny"
            reason = f"BLOCKED: This command would {desc.lower()}.\n\nThe command was: {command[:200]}\n\nUse the Read tool instead for safe file access, or ask me to check credentials safely."
            break

if decision == "allow":
    for pattern, desc in HIGH:
        if re.search(pattern, command, re.IGNORECASE):
            decision = "deny"
            reason = f"BLOCKED: This command would {desc.lower()}.\n\nThe command was: {command[:200]}\n\nIf you need this done, tell me exactly what and why — I will find the safest way."
            break

if decision == "allow" and re.search(STOP, shell_view(command), re.IGNORECASE):
    if mode in STOP_ASK_MODES:
        decision = "ask"
        reason = f"This command ends a running process. Allow only if you meant it.\n\nThe command was: {command[:200]}"
    else:
        decision = "deny"
        reason = f"BLOCKED: This command would kill a running process (mode {mode or None}, so no approval card can show).\n\nThe command was: {command[:200]}\n\nIf you need this done, tell me exactly what and why, and I will find the safest way."

if decision in ("deny", "ask"):
    out = {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason
    }
    if decision == "ask" and not command.startswith("# ACTION:"):
        try:
            header = card_header(command)
        except Exception:
            header = "# ACTION: end a process (the gate could not read which)\n# IMPACT: unknown. Deny unless you know what it is."
        out["updatedInput"] = dict(tool_input, command=header + "\n" + command)
    print(json.dumps({"hookSpecificOutput": out}))
else:
    print("{}")
PYEOF
)

echo "$RESULT"
