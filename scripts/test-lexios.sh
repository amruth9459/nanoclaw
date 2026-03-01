#!/bin/bash
# test-lexios.sh — Automated end-to-end test for Lexios construction analysis
#
# Usage:
#   ./scripts/test-lexios.sh                    # Quick mode (default)
#   ./scripts/test-lexios.sh comprehensive      # All 4 specialists
#   ./scripts/test-lexios.sh quick              # Extraction only
#
# What it does:
#   1. Downloads a sample blueprint PDF (if not cached)
#   2. Cleans previous lexios-work outputs
#   3. Spawns a container with the right mounts + auth
#   4. Waits for completion (watches for Result marker)
#   5. Validates all expected JSON files exist and parse
#   6. Checks output quality (structure, field presence, false positive rules)
#   7. Prints pass/fail report with timing
#
# Exit codes: 0 = all pass, 1 = failures

set -euo pipefail

MODE="${1:-quick}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MEDIA_DIR="$PROJECT_ROOT/store/media"
WORK_DIR="$PROJECT_ROOT/groups/main/lexios-work"
RESULTS_DIR="$PROJECT_ROOT/groups/main/lexios-results"
SESSIONS_DIR="$PROJECT_ROOT/data/sessions/main/.claude"
IPC_DIR="$PROJECT_ROOT/data/ipc/main"
CONTAINER_NAME="nanoclaw-lexios-test-$$"
STDERR_LOG="/tmp/lexios-test-$$.log"
INPUT_FILE="/tmp/lexios-test-$$.json"
SAMPLE_PDF="$MEDIA_DIR/sample-blueprint.pdf"
SAMPLE_PDF_URL="https://permitsonoma.org/Microsites/Permit%20Sonoma/Documents/Instructions%20and%20Forms/_BPC%20Building%20Plan%20Check/BPC-022-Sample-House-Plans.pdf"

PASS=0
FAIL=0
WARN=0
START_TIME=$(date +%s)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

pass() { ((PASS++)); echo -e "  ${GREEN}✓${NC} $1"; }
fail() { ((FAIL++)); echo -e "  ${RED}✗${NC} $1"; }
warn() { ((WARN++)); echo -e "  ${YELLOW}!${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }

cleanup() {
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  rm -f "$INPUT_FILE" "$STDERR_LOG" "/tmp/lexios-test-$$-stdout.log"
}
trap cleanup EXIT

# ── Step 1: Ensure test PDF exists ──────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Lexios E2E Test — $MODE mode"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Step 1: Test PDF"

if [ -f "$SAMPLE_PDF" ]; then
  pass "Sample blueprint cached ($SAMPLE_PDF)"
else
  info "Downloading sample blueprint from Permit Sonoma..."
  curl -sL -o "$SAMPLE_PDF" "$SAMPLE_PDF_URL"
  if [ -f "$SAMPLE_PDF" ] && [ "$(stat -f%z "$SAMPLE_PDF" 2>/dev/null || stat -c%s "$SAMPLE_PDF")" -gt 10000 ]; then
    pass "Downloaded sample blueprint ($(du -h "$SAMPLE_PDF" | cut -f1))"
  else
    fail "Failed to download sample blueprint"
    exit 1
  fi
fi

# ── Step 2: Clean previous outputs ──────────────────────────────────────────

echo ""
echo "Step 2: Clean workspace"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$RESULTS_DIR" "$IPC_DIR/messages" "$IPC_DIR/tasks" "$IPC_DIR/input"
pass "Cleaned lexios-work directory"

# ── Step 3: Sync skill files ────────────────────────────────────────────────

echo ""
echo "Step 3: Sync skills"

SKILL_SRC="$PROJECT_ROOT/container/skills/lexios"
SKILL_DST="$SESSIONS_DIR/skills/lexios"
if [ -d "$SKILL_SRC" ]; then
  mkdir -p "$SKILL_DST"
  cp -r "$SKILL_SRC/"* "$SKILL_DST/"
  pass "Synced lexios skill to sessions"
else
  fail "Skill source not found: $SKILL_SRC"
  exit 1
fi

# ── Step 4: Build container input ───────────────────────────────────────────

echo ""
echo "Step 4: Build input"

if [ "$MODE" = "comprehensive" ]; then
  PROMPT_TEXT="[document: /workspace/media/sample-blueprint.pdf] comprehensive analysis — extraction, compliance, conflicts, quantities. Use subagents for each specialist, dispatch compliance+conflicts+quantities in parallel."
else
  PROMPT_TEXT="[document: /workspace/media/sample-blueprint.pdf] analyze this blueprint"
fi

export PROJECT_ROOT INPUT_FILE PROMPT_TEXT

# Build input JSON using Python to avoid shell interpolation issues with tokens
python3 << 'PYEOF'
import json, sys, os

project_root = os.environ.get("PROJECT_ROOT", "")
input_file = os.environ.get("INPUT_FILE", "")
prompt_text = os.environ.get("PROMPT_TEXT", "")

# Read auth from .env
secrets = {}
env_path = os.path.join(project_root, ".env")
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                key, val = line.split("=", 1)
                if key in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"):
                    secrets[key] = val

if not secrets:
    print("FAIL: No auth token found in .env", file=sys.stderr)
    sys.exit(1)

data = {
    "prompt": f'<messages>\n<message from="Test" timestamp="2026-01-01T00:00:00Z" id="test-e2e" sender_jid="test@s.whatsapp.net">\n{prompt_text}\n</message>\n</messages>',
    "groupFolder": "main",
    "chatJid": "test@g.us",
    "isMain": True,
    "isScheduledTask": False,
    "secrets": secrets,
}
with open(input_file, "w") as f:
    json.dump(data, f)
print("OK")
PYEOF

if [ $? -ne 0 ]; then
  fail "Failed to build input JSON (auth missing?)"
  exit 1
fi
pass "Input JSON created ($MODE mode)"

# ── Step 5: Run container ───────────────────────────────────────────────────

echo ""
echo "Step 5: Run container"
info "Container: $CONTAINER_NAME"
info "Timeout: 10 minutes"

docker run -i --rm --name "$CONTAINER_NAME" \
  -v "$PROJECT_ROOT:/workspace/project" \
  -v "$PROJECT_ROOT/groups/main:/workspace/group" \
  -v "$SESSIONS_DIR:/home/node/.claude" \
  -v "$IPC_DIR:/workspace/ipc" \
  -v "$MEDIA_DIR:/workspace/media:ro" \
  nanoclaw-agent:latest < "$INPUT_FILE" >/tmp/lexios-test-$$-stdout.log 2>"$STDERR_LOG" &

CONTAINER_PID=$!

# Wait for completion by watching for "Result #1" in stderr
TIMEOUT=600
ELAPSED=0
POLL=5
RESULT_FOUND=false

while [ $ELAPSED -lt $TIMEOUT ]; do
  if ! kill -0 $CONTAINER_PID 2>/dev/null; then
    # Container exited
    break
  fi
  if grep -q "Result #1" "$STDERR_LOG" 2>/dev/null; then
    RESULT_FOUND=true
    info "Result marker detected at ${ELAPSED}s"
    # Give it a few more seconds to write files
    sleep 5
    break
  fi
  # Progress indicator
  MSG_COUNT=$(grep -c "type=assistant" "$STDERR_LOG" 2>/dev/null || echo 0)
  if [ $((ELAPSED % 15)) -eq 0 ] && [ $ELAPSED -gt 0 ]; then
    info "Waiting... ${ELAPSED}s elapsed, $MSG_COUNT agent messages"
  fi
  sleep $POLL
  ELAPSED=$((ELAPSED + POLL))
done

# Stop container
docker stop "$CONTAINER_NAME" 2>/dev/null || true
wait $CONTAINER_PID 2>/dev/null || true

CONTAINER_TIME=$(($(date +%s) - START_TIME))

if $RESULT_FOUND; then
  pass "Container completed in ${CONTAINER_TIME}s"
elif [ $ELAPSED -ge $TIMEOUT ]; then
  fail "Container timed out after ${TIMEOUT}s"
else
  # Check if it produced output before exiting
  if grep -q "Result #1" "$STDERR_LOG" 2>/dev/null; then
    pass "Container completed in ${CONTAINER_TIME}s"
    RESULT_FOUND=true
  else
    fail "Container exited without producing results"
  fi
fi

# ── Step 6: Validate outputs ───────────────────────────────────────────────

echo ""
echo "Step 6: Validate outputs"

# 6a: Page images
PNG_COUNT=$(ls "$WORK_DIR"/page-*.png 2>/dev/null | wc -l | tr -d ' ')
if [ "$PNG_COUNT" -ge 1 ]; then
  pass "Page images generated: $PNG_COUNT PNGs"
else
  fail "No page images found in lexios-work/"
fi

# 6b: Extraction JSON
if [ -f "$WORK_DIR/extraction.json" ]; then
  if python3 -c "import json; json.load(open('$WORK_DIR/extraction.json'))" 2>/dev/null; then
    EXTRACTION_SIZE=$(du -h "$WORK_DIR/extraction.json" | cut -f1)
    pass "extraction.json valid ($EXTRACTION_SIZE)"
  else
    fail "extraction.json is not valid JSON"
  fi
else
  fail "extraction.json not found"
fi

if [ "$MODE" = "comprehensive" ]; then
  # 6c: Compliance JSON
  if [ -f "$WORK_DIR/compliance.json" ]; then
    if python3 -c "import json; json.load(open('$WORK_DIR/compliance.json'))" 2>/dev/null; then
      COMPLIANCE_SIZE=$(du -h "$WORK_DIR/compliance.json" | cut -f1)
      pass "compliance.json valid ($COMPLIANCE_SIZE)"
    else
      fail "compliance.json is not valid JSON"
    fi
  else
    fail "compliance.json not found"
  fi

  # 6d: Conflicts JSON
  if [ -f "$WORK_DIR/conflicts.json" ]; then
    if python3 -c "import json; json.load(open('$WORK_DIR/conflicts.json'))" 2>/dev/null; then
      CONFLICTS_SIZE=$(du -h "$WORK_DIR/conflicts.json" | cut -f1)
      pass "conflicts.json valid ($CONFLICTS_SIZE)"
    else
      fail "conflicts.json is not valid JSON"
    fi
  else
    fail "conflicts.json not found"
  fi

  # 6e: Quantities JSON
  if [ -f "$WORK_DIR/quantities.json" ]; then
    if python3 -c "import json; json.load(open('$WORK_DIR/quantities.json'))" 2>/dev/null; then
      QUANTITIES_SIZE=$(du -h "$WORK_DIR/quantities.json" | cut -f1)
      pass "quantities.json valid ($QUANTITIES_SIZE)"
    else
      fail "quantities.json is not valid JSON"
    fi
  else
    fail "quantities.json not found"
  fi
fi

# ── Step 7: Quality checks ─────────────────────────────────────────────────

echo ""
echo "Step 7: Ground truth validation"

GROUND_TRUTH="$SCRIPT_DIR/lexios-tests/sample-blueprint.ground-truth.json"
if [ ! -f "$GROUND_TRUTH" ]; then
  warn "No ground truth file found, running basic checks only"
  GROUND_TRUTH=""
fi

# Run all quality checks via Python, reading ground truth
export WORK_DIR GROUND_TRUTH MODE STDERR_LOG RESULTS_DIR

while IFS=: read -r status msg; do
  case "$status" in
    PASS) pass "$msg" ;;
    WARN) warn "$msg" ;;
    FAIL) fail "$msg" ;;
  esac
done < <(python3 << 'GTEOF2'
import json, os, sys, re, glob

work = os.environ["WORK_DIR"]
gt_path = os.environ.get("GROUND_TRUTH", "")
mode = os.environ["MODE"]
stderr_log = os.environ["STDERR_LOG"]
results_dir = os.environ["RESULTS_DIR"]

results = []

def check(condition, pass_msg, fail_msg, warn_on_fail=False):
    if condition:
        results.append(("PASS", pass_msg))
    elif warn_on_fail:
        results.append(("WARN", fail_msg))
    else:
        results.append(("FAIL", fail_msg))

extraction = None
ext_path = os.path.join(work, "extraction.json")
if os.path.exists(ext_path):
    try: extraction = json.load(open(ext_path))
    except: results.append(("FAIL", "extraction.json is not valid JSON"))

gt = None
if gt_path and os.path.exists(gt_path):
    gt = json.load(open(gt_path))

if extraction:
    expected_keys = ['rooms', 'doors', 'windows', 'dimensions', 'notes', 'title_block']
    found = [k for k in expected_keys if k in extraction and extraction[k] is not None]
    check(len(found) >= 3, f"Extraction has {len(found)}/6 keys: {found}", f"Extraction only has {len(found)}/6 keys")

    rooms = extraction.get('rooms', [])
    room_names = [r.get('content', {}).get('name', '').upper().strip() for r in rooms]

    if gt:
        required_rooms = gt["rooms"]["required"]
        found_rooms = [req for req in required_rooms if any(req.upper() in rn for rn in room_names)]
        missing_rooms = [req for req in required_rooms if req not in found_rooms]
        check(len(found_rooms) >= len(required_rooms) - 1,
              f"Found {len(found_rooms)}/{len(required_rooms)} required rooms",
              f"Missing rooms: {missing_rooms}")
        min_r, max_r = gt["rooms"]["min_count"], gt["rooms"]["max_count"]
        check(min_r <= len(rooms) <= max_r,
              f"Room count {len(rooms)} in range [{min_r}-{max_r}]",
              f"Room count {len(rooms)} outside [{min_r}-{max_r}]", warn_on_fail=True)
    else:
        check(len(rooms) >= 3, f"{len(rooms)} rooms extracted", f"Only {len(rooms)} rooms")

    has_conf = sum(1 for r in rooms if 'confidence' in r)
    check(has_conf >= len(rooms) * 0.8, f"{has_conf}/{len(rooms)} have confidence scores",
          f"Only {has_conf}/{len(rooms)} have confidence", warn_on_fail=True)

    if gt:
        doors = extraction.get('doors', [])
        windows = extraction.get('windows', [])
        check(len(doors) >= gt["doors"]["min_count"],
              f"{len(doors)} doors (min {gt['doors']['min_count']})",
              f"Only {len(doors)} doors", warn_on_fail=True)
        check(len(windows) >= gt["windows"]["min_count"],
              f"{len(windows)} windows (min {gt['windows']['min_count']})",
              f"Only {len(windows)} windows", warn_on_fail=True)
        tb = extraction.get('title_block', None)
        if isinstance(tb, list) and tb:
            tb = tb[0].get('content', {}) if 'content' in tb[0] else tb[0]
        elif isinstance(tb, dict) and 'content' in tb:
            tb = tb['content']
        if tb:
            check(gt["title_block"]["project_name"].upper() in json.dumps(tb).upper(),
                  "Title block matches", "Title block mismatch", warn_on_fail=True)

if mode == "comprehensive":
    comp_path = os.path.join(work, "compliance.json")
    if os.path.exists(comp_path):
        try:
            findings = json.load(open(comp_path)).get('findings', [])
            check(len(findings) >= 3, f"Compliance: {len(findings)} findings", f"Only {len(findings)} findings")
            if gt:
                ft = json.dumps(findings).lower()
                for exp in gt["compliance_expected"]["should_flag"]:
                    kws = exp.lower().split()
                    check(sum(1 for kw in kws if kw in ft) >= len(kws) * 0.5,
                          f"Compliance flagged: {exp}", f"Compliance missed: {exp}", warn_on_fail=True)
        except: results.append(("FAIL", "compliance.json parse error"))

    confl_path = os.path.join(work, "conflicts.json")
    if os.path.exists(confl_path):
        try:
            cdata = json.load(open(confl_path))
            conflicts = cdata.get('conflicts', cdata if isinstance(cdata, list) else [])
            fps = [c.get('description','')[:80] for c in conflicts
                   if 'rafter' in c.get('description','').lower()
                   and 'joist' in c.get('description','').lower()
                   and c.get('severity') == 'critical']
            check(not fps, "No rafter/joist false positives",
                  f"False positive: {fps[0] if fps else 'unknown'}")
        except Exception as e:
            results.append(("FAIL", f"conflicts.json error: {e}"))

    spec_files = ['compliance.json', 'conflicts.json', 'quantities.json']
    times = {f: os.path.getmtime(os.path.join(work, f))
             for f in spec_files if os.path.exists(os.path.join(work, f))}
    if len(times) >= 3:
        spread = max(times.values()) - min(times.values())
        check(spread < 120, f"Parallel: {spread:.0f}s spread",
              f"Sequential: {spread:.0f}s spread", warn_on_fail=(spread < 300))

    qty_path = os.path.join(work, "quantities.json")
    if os.path.exists(qty_path) and gt:
        try:
            qt = json.dumps(json.load(open(qty_path)))
            ar = gt["quantities_expected"].get("building_area_sqft_range", [])
            if ar:
                nums = [int(x) for x in re.findall(r'\b(\d{3,5})\b', qt) if ar[0] <= int(x) <= ar[1]*2]
                check(len(nums) > 0, "Quantities: area in range", "No area values in expected range", warn_on_fail=True)
        except: results.append(("WARN", "quantities parse issue"))

try:
    stderr = open(stderr_log).read()
    check("Lexios" in stderr and "Analysis" in stderr, "WhatsApp summary emitted", "No summary in output")
except: results.append(("FAIL", "Can't read stderr"))

rfiles = sorted(glob.glob(os.path.join(results_dir, "analysis-*.json")), key=os.path.getmtime, reverse=True)
if rfiles:
    try:
        json.load(open(rfiles[0]))
        check(True, f"Saved: {os.path.basename(rfiles[0])}", "")
    except: results.append(("FAIL", "Result file invalid JSON"))
else:
    results.append(("WARN", "No result file saved"))

for s, m in results:
    print(f"{s}:{m}")
GTEOF2
)

# ── Step 7b: Evaluation framework scoring ────────────────────────────────

echo ""
echo "Step 7b: Eval framework (P/R/F1)"

EVAL_SCRIPT="$SCRIPT_DIR/lexios-eval.py"
if [ -f "$EVAL_SCRIPT" ] && [ -f "$WORK_DIR/extraction.json" ]; then
  EVAL_OUT=$(python3 "$EVAL_SCRIPT" score permit-sonoma-bpc022 2>&1 | grep -v DeprecationWarning)
  OVERALL_F1=$(echo "$EVAL_OUT" | grep "Overall F1:" | awk '{print $NF}')
  MISSED=$(echo "$EVAL_OUT" | grep "Missed:" | sed 's/.*Missed: \([0-9]*\).*/\1/')

  if [ -n "$OVERALL_F1" ]; then
    # F1 >= 0.8 is passing
    F1_INT=$(echo "$OVERALL_F1" | sed 's/\.//' | sed 's/^0*//')
    if [ "${F1_INT:-0}" -ge 80 ]; then
      pass "Overall F1=$OVERALL_F1 (threshold: 0.80)"
    else
      fail "Overall F1=$OVERALL_F1 (below threshold 0.80)"
    fi

    # Print category breakdown
    echo "$EVAL_OUT" | grep -E "^\s+(rooms|doors|windows|dimensions|notes)" | while read -r line; do
      info "$line"
    done

    if [ "${MISSED:-0}" -gt 0 ]; then
      warn "Missed $MISSED ground truth elements"
    fi
  else
    warn "Could not parse eval output"
  fi
else
  warn "Eval script or extraction.json not found, skipping"
fi

# ── Step 8: Token usage ────────────────────────────────────────────────────

echo ""
echo "Step 8: Cost"

# Extract usage from stdout output
USAGE=$(grep -o '"usage":{[^}]*}' /tmp/lexios-test-$$.log 2>/dev/null || true)
if [ -z "$USAGE" ]; then
  # Try from the background task output
  STDOUT_FILE="/private/tmp/claude-501/-Users-amrut-nanoclaw/tasks/*.output"
  USAGE=$(grep -o '"usage":{[^}]*}' $STDOUT_FILE 2>/dev/null | tail -1 || true)
fi
if [ -n "$USAGE" ]; then
  info "Usage: $USAGE"
else
  info "Usage data not captured (normal for background runs)"
fi

# ── Report ──────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
DURATION=$(($(date +%s) - START_TIME))

if [ $FAIL -eq 0 ]; then
  echo -e "  ${GREEN}ALL PASS${NC}: $PASS passed, $WARN warnings in ${DURATION}s"
else
  echo -e "  ${RED}FAILURES${NC}: $PASS passed, $FAIL failed, $WARN warnings in ${DURATION}s"
fi

echo ""
echo "  Mode:      $MODE"
echo "  Duration:  ${DURATION}s (container: ${CONTAINER_TIME}s)"
echo "  Messages:  $(grep -c 'type=assistant' "$STDERR_LOG" 2>/dev/null || echo '?') agent turns"
echo ""

# Output files summary
echo "  Output files:"
for f in extraction.json compliance.json conflicts.json quantities.json; do
  if [ -f "$WORK_DIR/$f" ]; then
    echo "    $f  $(du -h "$WORK_DIR/$f" | cut -f1)"
  fi
done
echo "════════════════════════════════════════════════"
echo ""

exit $FAIL
