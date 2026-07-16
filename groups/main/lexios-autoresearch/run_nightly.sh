#!/bin/bash
#
# Lexios Autoresearch — Karpathy-style Nightly Loop (v2, 2026-07-16)
#
# ARCHITECTURE (v2 — supersedes the session-runs-everything design):
#   Sessions form a hypothesis and EDIT experiment.py's CONFIG section. Nothing
#   else. The ORCHESTRATOR measures: it runs experiment.py in real-vision eval
#   mode on a fixed doc set, foreground with a timeout. Why:
#     - 5/10 sessions on 2026-07-16 produced no result because they backgrounded
#       the 25-84 min run and exited (print-mode sessions can't wait).
#     - Sessions self-reporting scores was the trust hole behind months of
#       false "kept" rows.
#     - The old corpus metric was injection-saturated at F1=1.0 (fake); the
#       eval mode scores raw vision + phantom-probed postprocess instead.
#
# Gate: keep iff tonight's effective eval F1 strictly improves. Baseline is
# measured fresh each night (2026-07-15 ratchet fix — never read all-time
# history; cross-night numbers aren't comparable).
#
# Usage:
#   bash run_nightly.sh              # Full nightly run (2AM-6AM)
#   bash run_nightly.sh --test       # Single experiment for testing
#   bash run_nightly.sh --max 2      # Cap experiment count
#

set -uo pipefail
# Note: -e deliberately omitted — Claude CLI may exit non-zero, which shouldn't abort the loop.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
RESULTS_FILE="$SCRIPT_DIR/results.tsv"
EXPERIMENT_FILE="$SCRIPT_DIR/experiment.py"

mkdir -p "$LOG_DIR"

# ── Configuration ────────────────────────────────────────────────────────────
END_HOUR=6                        # Stop at 6 AM
MAX_EXPERIMENTS=4                 # Fewer, deeper cycles: edit (~10m) + measured run (~20-40m)
BUDGET_TOTAL=30                   # $ safety ceiling (eval runs are $0 via Max CLI)
MEASURE_TIMEOUT=2400              # Hard cap per measurement run (seconds)
EVAL_DOCS="Duplex_A_20110907,NBU_MedicalClinic_Arch"   # program.md targets: 0.70 / 0.50
BEST_F1=0.0

# Parse args
TEST_MODE=false
for arg in "$@"; do
    case $arg in
        --test) TEST_MODE=true; MAX_EXPERIMENTS=1 ;;
    esac
done
while [[ $# -gt 0 ]]; do
    case $1 in
        --max) MAX_EXPERIMENTS="$2"; shift 2 ;;
        *) shift ;;
    esac
done

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_DIR/nightly.log"
}

# ── Time check ───────────────────────────────────────────────────────────────
is_past_end() {
    if $TEST_MODE; then return 1; fi
    local hour=$(date +%H)
    if [ "$hour" -ge "$END_HOUR" ] && [ "$hour" -lt 22 ]; then
        return 0
    fi
    return 1
}

# ── Guard: hash of the PROTECTED (non-CONFIG) zones of experiment.py ────────
# Sessions may only edit between the CONFIG markers. Any change to run(),
# scoring, arg parsing, or the markers themselves is a gate edit → rejected.
guard_hash() {
    python3 - "$EXPERIMENT_FILE" <<'PY' 2>/dev/null
import sys, hashlib
lines = open(sys.argv[1]).read().splitlines(keepends=True)
try:
    start = next(i for i, l in enumerate(lines) if "EXPERIMENT CONFIG (agent edits" in l)
    end = next(i for i, l in enumerate(lines) if "END EXPERIMENT CONFIG" in l)
except StopIteration:
    sys.exit(1)  # markers missing/mangled → caller treats as violation
protected = "".join(lines[:start + 1] + lines[end:])
print(hashlib.sha256(protected.encode()).hexdigest())
PY
}

# ── Measurement: orchestrator-run, foreground, timed ─────────────────────────
# Writes parsed JSON to $RESULT_JSON (global) or empty on failure.
measure() {
    local run_log="$1"
    RESULT_JSON=""
    rm -f "$SCRIPT_DIR/last-result.json" "$(pwd)/last-result.json"
    timeout "$MEASURE_TIMEOUT" python3 "$EXPERIMENT_FILE" --eval-docs "$EVAL_DOCS" >> "$run_log" 2>&1
    local rc=$?
    if [ $rc -eq 124 ]; then
        log "Measurement TIMED OUT after ${MEASURE_TIMEOUT}s"
        return 1
    fi
    for RESULT_FILE in "$SCRIPT_DIR/last-result.json" "$(pwd)/last-result.json"; do
        if [ -f "$RESULT_FILE" ]; then
            RESULT_JSON=$(cat "$RESULT_FILE")
            rm -f "$RESULT_FILE"
            return 0
        fi
    done
    log "Measurement produced no last-result.json (exit=$rc)"
    return 1
}

jget() {  # jget "$json" key default
    echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$2', $3))" 2>/dev/null || echo "$3"
}

# ── Init ─────────────────────────────────────────────────────────────────────
if [ ! -f "$RESULTS_FILE" ]; then
    echo -e "timestamp\texperiment_id\tdescription\tprev_f1\tnew_f1\tcost_usd\tstatus" > "$RESULTS_FILE"
fi

cd "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR")"

log "Preparing ground truth..."
python3 "$SCRIPT_DIR/prepare.py" 2>&1 | tee -a "$LOG_DIR/prepare.log"

# ── Tonight's baseline (real-vision eval on the fixed doc set) ──────────────
TOTAL_COST=0
log "Measuring tonight's baseline: eval docs = $EVAL_DOCS ..."
BASELINE_LOG="$LOG_DIR/baseline-$(date +%Y%m%d-%H%M%S).log"
if ! measure "$BASELINE_LOG"; then
    log "FATAL: baseline measurement failed — aborting tonight's loop (measurement path broken; fix before experimenting)"
    exit 1
fi
BEST_F1=$(jget "$RESULT_JSON" overall_f1 0)
BASELINE_COST=$(jget "$RESULT_JSON" total_cost_usd 0)
TOTAL_COST=$(echo "$TOTAL_COST + $BASELINE_COST" | bc -l)
BASELINE_DETAIL=$(echo "$RESULT_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('results', []):
    print(f\"- {r['doc_id']}: raw F1={r.get('raw_f1','?')}, postprocessed F1={r.get('post_f1','?')}, effective F1={r['f1']}\")
p = d.get('phantom') or {}
print(f\"- phantom probes: fabricated={p.get('fabricated','?')} (clean={p.get('clean','?')}) — if not clean, postprocess is scored as RAW\")
" 2>/dev/null)
log "Baseline effective F1: $BEST_F1"
log "$BASELINE_DETAIL"

# ── Experiment loop ──────────────────────────────────────────────────────────
EXPERIMENT_COUNT=0

log "Starting autoresearch loop (max $MAX_EXPERIMENTS experiments)"

while [ "$EXPERIMENT_COUNT" -lt "$MAX_EXPERIMENTS" ]; do
    if is_past_end; then
        log "Past $END_HOUR:00 — stopping"
        break
    fi
    if (( $(echo "$TOTAL_COST >= $BUDGET_TOTAL" | bc -l) )); then
        log "Budget exhausted (\$$TOTAL_COST >= \$$BUDGET_TOTAL) — stopping"
        break
    fi

    EXPERIMENT_COUNT=$((EXPERIMENT_COUNT + 1))
    EXPERIMENT_ID="exp-$(date +%Y%m%d-%H%M%S)"
    EXPERIMENT_LOG="$LOG_DIR/${EXPERIMENT_ID}.log"

    log "─── Experiment $EXPERIMENT_COUNT/$MAX_EXPERIMENTS: $EXPERIMENT_ID ───"

    cp "$EXPERIMENT_FILE" "$EXPERIMENT_FILE.bak"
    PRE_GUARD=$(guard_hash)
    PRE_FULL=$(shasum -a 256 "$EXPERIMENT_FILE" | cut -d' ' -f1)

    RESULTS_HISTORY=""
    if [ -f "$RESULTS_FILE" ] && [ "$(wc -l < "$RESULTS_FILE")" -gt 1 ]; then
        RESULTS_HISTORY="## Recent experiment results (last 30)

$(head -1 "$RESULTS_FILE")
$(tail -n +2 "$RESULTS_FILE" | tail -30)
"
    fi

    PROMPT="You are the hypothesis step of Lexios autoresearch experiment #${EXPERIMENT_COUNT} tonight.

## Research Program
$(cat "$SCRIPT_DIR/program.md")

## Tonight's measured baseline (real vision, eval docs: ${EVAL_DOCS})
Effective F1 to beat: ${BEST_F1}
${BASELINE_DETAIL}

${RESULTS_HISTORY}

## Your job (EDIT ONLY — the orchestrator measures after you finish)
1. Read ${EXPERIMENT_FILE} and form ONE hypothesis that could raise real-vision
   F1 on the eval docs above (prompt wording, preprocessing, honest
   normalization in postprocess).
2. Edit ONLY the section between the 'EXPERIMENT CONFIG' and
   'END EXPERIMENT CONFIG' markers: EXPERIMENT_NAME, DESCRIPTION,
   SYSTEM_PROMPT_OVERRIDE, PARAMS, preprocess(), postprocess().
3. Set EXPERIMENT_NAME and DESCRIPTION to describe tonight's hypothesis.
4. End your turn with a one-line summary of the hypothesis. Do NOT run
   anything — you have no shell. The orchestrator runs the measurement,
   applies the keep/discard gate, and reverts your edit if it doesn't improve.

## Hard rules
- Touching anything outside the CONFIG markers (or the markers) = the whole
  edit is auto-rejected before measurement.
- Do NOT add ground-truth-derived injections to postprocess(). Measurement
  probes postprocess with empty and decoy inputs; if it manufactures elements
  from nothing, your postprocess is disqualified and the run is scored on RAW
  vision output only. postprocess may TRANSFORM what vision returned
  (rename, dedupe, normalize, split) — never invent elements.
- One hypothesis per night-slot. Don't repeat rows from the history above.
"

    log "Spawning edit-only Claude session..."
    CLAUDE_BIN="${CLAUDE_BIN:-/opt/homebrew/bin/claude}"
    if [ -x "$CLAUDE_BIN" ]; then
        unset ANTHROPIC_API_KEY
        echo "$PROMPT" | "$CLAUDE_BIN" --print \
            --dangerously-skip-permissions \
            --no-session-persistence \
            --model sonnet \
            --allowedTools "Read,Edit,Grep,Glob" \
            2>&1 | tee "$EXPERIMENT_LOG" || true
    else
        log "ERROR: claude CLI not found at $CLAUDE_BIN"
        break
    fi

    # ── Guards before spending a measurement run ────────────────────────────
    POST_FULL=$(shasum -a 256 "$EXPERIMENT_FILE" | cut -d' ' -f1)
    if [ "$POST_FULL" = "$PRE_FULL" ]; then
        log "Session made no edit — skipping measurement"
        echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tno-edit\t$BEST_F1\t0\t0\tno-edit" >> "$RESULTS_FILE"
        rm -f "$EXPERIMENT_FILE.bak"
        continue
    fi
    POST_GUARD=$(guard_hash)
    if [ -z "$POST_GUARD" ] || [ "$POST_GUARD" != "$PRE_GUARD" ]; then
        log "GUARD VIOLATION: protected zone (or markers) modified — reverting"
        cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
        echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tguard-violation\t$BEST_F1\t0\t0\trejected-guard" >> "$RESULTS_FILE"
        rm -f "$EXPERIMENT_FILE.bak"
        continue
    fi
    if ! python3 -m py_compile "$EXPERIMENT_FILE" 2>>"$EXPERIMENT_LOG"; then
        log "Edit does not compile — reverting"
        cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
        echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tsyntax-error\t$BEST_F1\t0\t0\trejected-syntax" >> "$RESULTS_FILE"
        rm -f "$EXPERIMENT_FILE.bak"
        continue
    fi

    # ── Orchestrator-run measurement ─────────────────────────────────────────
    log "Measuring edited config (real vision, eval docs)..."
    if ! measure "$EXPERIMENT_LOG"; then
        log "Measurement failed — reverting edit"
        cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
        echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tmeasurement-failed\t$BEST_F1\t0\t0\terror" >> "$RESULTS_FILE"
        rm -f "$EXPERIMENT_FILE.bak"
        continue
    fi

    NEW_F1=$(jget "$RESULT_JSON" overall_f1 0)
    COST=$(jget "$RESULT_JSON" total_cost_usd 0)
    EXP_NAME=$(echo "$RESULT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('experiment', 'unknown'))" 2>/dev/null || echo "unknown")
    EXP_DESC=$(echo "$RESULT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description', '')[:60])" 2>/dev/null || echo "")
    PHANTOM_CLEAN=$(echo "$RESULT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('phantom', {}).get('clean', ''))" 2>/dev/null || echo "")
    TOTAL_COST=$(echo "$TOTAL_COST + $COST" | bc -l)

    log "Result: effective F1=$NEW_F1 (phantom clean=$PHANTOM_CLEAN), experiment=$EXP_NAME"

    PREV_BEST=$BEST_F1
    IS_IMPROVEMENT=$(echo "$NEW_F1 > $BEST_F1" | bc -l)
    if [ "$IS_IMPROVEMENT" -eq 1 ]; then
        log "IMPROVEMENT! F1 $PREV_BEST → $NEW_F1 — keeping changes"
        BEST_F1=$NEW_F1
        STATUS="kept"
        # -f REQUIRED: groups/main/* is gitignored; plain add exits 1 even for
        # tracked files (verified 2026-07-15).
        git add -f "$EXPERIMENT_FILE"
        git commit -m "autoresearch: $EXP_NAME (eval F1=$NEW_F1)" 2>/dev/null || true
    else
        log "No improvement (F1=$NEW_F1 vs best=$BEST_F1) — discarding changes"
        STATUS="discarded"
        cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
    fi

    echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\t$EXP_DESC\t$PREV_BEST\t$NEW_F1\t$COST\t$STATUS" >> "$RESULTS_FILE"
    rm -f "$EXPERIMENT_FILE.bak"

    log "Running total: $EXPERIMENT_COUNT experiments, \$$TOTAL_COST spent, best eval F1=$BEST_F1"
    echo ""
done

# ── Summary ──────────────────────────────────────────────────────────────────
log "═══ Nightly autoresearch complete ═══"
log "Experiments: $EXPERIMENT_COUNT"
log "Total cost: \$$TOTAL_COST"
log "Best eval F1 tonight: $BEST_F1  (eval docs: $EVAL_DOCS)"
log "Results: $RESULTS_FILE"
