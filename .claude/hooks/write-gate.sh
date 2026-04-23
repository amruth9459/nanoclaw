#!/bin/bash
# Write Gate — PreToolUse hook for Write and Edit tools
# Blocks writes to sensitive file paths (credentials, system files, SSH keys)
#
# Input: JSON on stdin with tool_name, tool_input
# Output: JSON with permissionDecision or empty {}

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")

# Only gate Write and Edit
if [ "$TOOL_NAME" != "Write" ] && [ "$TOOL_NAME" != "Edit" ]; then
  echo '{}'
  exit 0
fi

FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; ti=json.load(sys.stdin).get('tool_input',{}); print(ti.get('file_path','') or ti.get('filePath',''))" 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  echo '{}'
  exit 0
fi

RESULT=$(FPATH="$FILE_PATH" python3 << 'PYEOF'
import json, re, os

fpath = os.environ.get("FPATH", "")

# Normalize path
fpath_norm = os.path.normpath(os.path.expanduser(fpath))

BLOCKED_PATTERNS = [
    # Credentials and secrets
    (r'\.env$', "Write to .env file — contains API keys and secrets"),
    (r'\.env\.\w+$', "Write to .env variant — may contain secrets"),
    (r'credentials\.json$', "Write to credentials file"),
    (r'\.pem$', "Write to PEM certificate/key file"),
    (r'id_rsa', "Write to SSH private key"),
    (r'id_ed25519', "Write to SSH private key"),
    (r'\.key$', "Write to private key file"),
    (r'\.p12$', "Write to PKCS12 keystore"),
    (r'token\.json$', "Write to OAuth token file"),

    # System directories
    (r'^/etc/', "Write to system configuration directory"),
    (r'^/usr/', "Write to system directory"),
    (r'^/var/', "Write to system variable directory"),
    (r'^/System/', "Write to macOS system directory"),
    (r'^/Library/', "Write to macOS system library"),

    # Other users
    (r'^/Users/(?!amrut)', "Write to another user's home directory"),

    # SSH config
    (r'\.ssh/', "Write to SSH directory"),

    # Claude settings (prevent self-modification of safety hooks)
    (r'\.claude/hooks/', "Write to Claude Code hooks — safety configuration"),
    (r'\.claude/settings\.json$', "Write to Claude Code settings — safety configuration"),
]

decision = "allow"
reason = ""

for pattern, desc in BLOCKED_PATTERNS:
    if re.search(pattern, fpath_norm):
        decision = "deny"
        reason = f"BLOCKED: {desc}.\n\nTarget file: {fpath_norm}\n\nIf you need to modify this file, tell me what you want to change and I will do it safely."
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
