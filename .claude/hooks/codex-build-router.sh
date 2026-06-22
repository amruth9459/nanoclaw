#!/bin/bash
# Codex-build Router — UserPromptSubmit hook for Claude Code
# Fires when a prompt looks like a SUBSTANTIAL build/implementation task and injects
# a routing reminder so the work goes to Codex (own quota) or a Sonnet sub-agent
# instead of being ground out inline on Opus (the top quota cost; see token-routing
# policy in ~/.claude/CLAUDE.md).
#
# Quality-safe by design: it NUDGES (additionalContext), never blocks, and explicitly
# keeps planning / spec authoring / final review / small surgical edits on Opus.
#
# Kill switch:  export CODEX_ROUTER_OFF=1   (disables the nudge entirely)
#
# Input : JSON on stdin with .prompt and .cwd
# Output: UserPromptSubmit additionalContext JSON, or {} for no-op.

set -euo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd',''))" 2>/dev/null || echo "")

if [ -z "$PROMPT" ]; then
  echo '{}'
  exit 0
fi

PROMPT="$PROMPT" CWD_PATH="$CWD" python3 << 'PYEOF'
import os, re, json

prompt = os.environ.get("PROMPT", "")
p = prompt.strip()
low = p.lower()

def noop():
    print("{}")
    raise SystemExit(0)

# --- kill switch ---
if os.environ.get("CODEX_ROUTER_OFF") == "1":
    noop()

# --- skip non-tasks: too short, slash commands, shell-bang lines ---
# (low floor only filters chat like "thanks"/"yes do it"; the build-intent
#  regexes below do the real gating)
if len(p) < 30 or p.startswith("/") or p.startswith("!"):
    noop()

# --- skip if the user is already steering routing / models ---
if re.search(r'\b(codex|sonnet|haiku|fable|sub-?agents?|delegat\w*|orchestrat\w*)\b', low):
    noop()

# --- verb + explicit code artifact -> self-sufficient build signal ---
BUILD_ARTIFACT = re.compile(r'''\b
      (create|add|write|generate|make|build|scaffold|implement)\s+
      (a|an|the|some|me\s+a|me\s+an|my)?\s*\w*\s*
      (feature|endpoint|route|component|module|page|screen|test|script|function|
       class|api|command|app|tool|parser|server|cli|hook|migration|schema|
       dashboard|integration|wrapper|pipeline|bot|extension|plugin|webhook|daemon)s?
    \b''', re.IGNORECASE | re.VERBOSE)

# --- bare engineering verbs -> need a code/context signal or real length ---
BUILD_BARE = re.compile(r'''\b(
      implement | build | scaffold | refactor | migrate | re-?write | port |
      integrate | wire\s+up | set\s+up | fix\s+(all|the|these|every|this)
    )\b''', re.IGNORECASE | re.VERBOSE)

# --- code / engineering context signal ---
CODE = re.compile(r'''(
      \.(py|ts|tsx|js|jsx|go|rs|rb|java|swift|sql|sh|html|css|vue|svelte)\b |
      \b(function|class|module|component|endpoint|api|schema|migration|repo|codebase|
         backend|frontend|database|server|cli|parser|pipeline|refactor|feature|
         script|app|webapp|daemon|webhook|service)\b
    )''', re.IGNORECASE | re.VERBOSE)

substantial = len(p) >= 120
fire = bool(BUILD_ARTIFACT.search(low)) or (
    bool(BUILD_BARE.search(low)) and (bool(CODE.search(low)) or substantial)
)

if fire:
    msg = (
        "[token-routing check] This looks like a substantial build/implementation task. "
        "Before grinding it out inline on Opus (your single biggest quota cost — ~91% of Opus "
        "output is whole-task execution), default to routing per ~/.claude/CLAUDE.md:\n"
        "  - Non-trivial code, esp. in a git repo -> /codex-build (Codex builds on its OWN "
        "quota; you author the spec and review the diff).\n"
        "  - Otherwise / gated execution -> spawn a Sonnet sub-agent (Agent tool, model:'sonnet') "
        "against a clear spec, then review its output at full fidelity.\n"
        "Keep on Opus: planning, spec authoring, ambiguity resolution, final review, and small "
        "surgical edits (handoff-cost rule: if speccing the handoff costs more than just doing it, "
        "do it directly). If this is trivial / Q&A / faster done inline, ignore this and proceed."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": msg
        }
    }))
else:
    print("{}")
PYEOF
