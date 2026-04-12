#!/bin/bash
# Safety Gate — PreToolUse hook for Claude Code
# Blocks destructive commands and explains what was attempted in plain language.
# Works for both interactive (desktop) and host-runner (NanoClaw) sessions.
#
# Input: JSON on stdin with tool_name, tool_input
# Output: JSON with permissionDecision (allow/deny) and reason

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null || echo "")

# Only gate Bash commands — Read/Write/Edit have their own permission model
if [ "$TOOL_NAME" != "Bash" ]; then
  echo '{}'
  exit 0
fi

COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")

if [ -z "$COMMAND" ]; then
  echo '{}'
  exit 0
fi

# Pass command and cwd to Python via env vars (safe from shell injection)
RESULT=$(CMD="$COMMAND" CWD_PATH="$CWD" python3 << 'PYEOF'
import sys, json, re, os

command = os.environ.get("CMD", "")
cwd = os.environ.get("CWD_PATH", "")

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
    (r'\bkill\b', "Kill a running process"),
    (r'\bpkill\b', "Kill processes by name"),
]

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

if decision == "deny":
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason
        }
    }))
else:
    print("{}")
PYEOF
)

echo "$RESULT"
