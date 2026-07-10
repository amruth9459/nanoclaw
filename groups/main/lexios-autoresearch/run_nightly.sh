#!/bin/bash
#
# Lexios Autoresearch — Karpathy-style Nightly Loop
#
# Spawns Claude Code sessions in a loop. Each session:
# 1. Reads program.md + results.tsv + experiment.py
# 2. Forms a hypothesis, edits experiment.py
# 3. Runs extraction, gets F1 score
# 4. Orchestrator keeps (git commit) or discards (git restore)
# 5. Loop until END_HOUR or budget exhausted
#
# Usage:
#   bash run_nightly.sh              # Full nightly run (2AM-6AM)
#   bash run_nightly.sh --test       # Single experiment for testing
#   bash run_nightly.sh --max 5      # Cap at 5 experiments
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
MAX_EXPERIMENTS=10                # Max experiments per night
BUDGET_PER_EXPERIMENT=3           # $ per Claude Code session
BUDGET_TOTAL=30                   # $ total budget per night
BEST_F1=0.0                       # Track best F1 this session

# Parse args
TEST_MODE=false
MAX_OVERRIDE=""
for arg in "$@"; do
    case $arg in
        --test) TEST_MODE=true; MAX_EXPERIMENTS=1 ;;
        --max) shift ;;
        [0-9]*) MAX_EXPERIMENTS=$arg ;;
    esac
done
# Handle --max N
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
    # Past end if hour >= END_HOUR and hour < 22 (i.e., daytime)
    if [ "$hour" -ge "$END_HOUR" ] && [ "$hour" -lt 22 ]; then
        return 0
    fi
    return 1
}

# ── Initialize results file ─────────────────────────────────────────────────
if [ ! -f "$RESULTS_FILE" ]; then
    echo -e "timestamp\texperiment_id\tdescription\tprev_f1\tnew_f1\tcost_usd\tstatus" > "$RESULTS_FILE"
fi

# ── Git setup ────────────────────────────────────────────────────────────────
# Work from the nanoclaw repo root (don't create nested .git)
cd "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR")"

# ── Prepare ground truth ─────────────────────────────────────────────────────
log "Preparing ground truth..."
python3 "$SCRIPT_DIR/prepare.py" 2>&1 | tee -a "$LOG_DIR/prepare.log"

# ── Read current best F1 ─────────────────────────────────────────────────────
if [ -f "$RESULTS_FILE" ] && [ "$(wc -l < "$RESULTS_FILE")" -gt 1 ]; then
    # BUG FIX (2026-07-10): was max() over ALL "kept" rows ever, which pins BEST_F1
    # at 1.0 forever once any experiment on any (smaller) corpus hits it — after
    # that, no future experiment on a larger/harder corpus can mathematically
    # satisfy new_f1 > 1.0, so every session's real improvements get "discarded"
    # and reverted. Use the F1 of the MOST RECENT kept row instead — that's the
    # actual current on-disk baseline (current corpus size), which is what a new
    # experiment should be compared against. Confirmed dead since ~2026-03-27
    # across 40+ discarded/no-result sessions in results.tsv.
    BEST_F1=$(tail -n +2 "$RESULTS_FILE" | awk -F'\t' '$7=="kept" {last=$5+0} END {print last+0}')
    log "Current best F1: $BEST_F1"
fi

# ── Experiment loop ──────────────────────────────────────────────────────────
EXPERIMENT_COUNT=0
TOTAL_COST=0

log "Starting autoresearch loop (max $MAX_EXPERIMENTS experiments, budget \$$BUDGET_TOTAL)"

while [ "$EXPERIMENT_COUNT" -lt "$MAX_EXPERIMENTS" ]; do
    # Time check
    if is_past_end; then
        log "Past $END_HOUR:00 — stopping"
        break
    fi

    # Budget check
    if (( $(echo "$TOTAL_COST >= $BUDGET_TOTAL" | bc -l) )); then
        log "Budget exhausted (\$$TOTAL_COST >= \$$BUDGET_TOTAL) — stopping"
        break
    fi

    EXPERIMENT_COUNT=$((EXPERIMENT_COUNT + 1))
    EXPERIMENT_ID="exp-$(date +%Y%m%d-%H%M%S)"
    EXPERIMENT_LOG="$LOG_DIR/${EXPERIMENT_ID}.log"

    log "─── Experiment $EXPERIMENT_COUNT/$MAX_EXPERIMENTS: $EXPERIMENT_ID ───"

    # Save current experiment.py state (for rollback)
    cp "$EXPERIMENT_FILE" "$EXPERIMENT_FILE.bak"

    # Build the prompt for Claude Code
    RESULTS_HISTORY=""
    if [ -f "$RESULTS_FILE" ] && [ "$(wc -l < "$RESULTS_FILE")" -gt 1 ]; then
        RESULTS_HISTORY="## Previous Experiment Results

$(cat "$RESULTS_FILE")
"
    fi

    CURRENT_EXPERIMENT="## Current experiment.py

\`\`\`python
$(cat "$EXPERIMENT_FILE")
\`\`\`"

    PROMPT="You are running Lexios autoresearch experiment #${EXPERIMENT_COUNT}.

## Research Program
$(cat "$SCRIPT_DIR/program.md")

${RESULTS_HISTORY}

${CURRENT_EXPERIMENT}

## Instructions

1. Based on the research directions in program.md and the results history above, form a hypothesis for what to try next.
2. Edit experiment.py — ONLY the EXPERIMENT CONFIG section (between the markers).
3. Run: \`python3 ${EXPERIMENT_FILE}\`
4. Report the overall F1 score from the ---EXPERIMENT_RESULT--- output.

Important:
- Test ONE hypothesis per experiment
- Don't repeat experiments that already appear in the results
- Focus on the highest-impact research direction that hasn't been tried
- The experiment.py file is at: ${EXPERIMENT_FILE}
- ALWAYS use the full path when running: python3 ${EXPERIMENT_FILE}
"

    # Run Claude Code session
    log "Spawning Claude Code session (budget: \$$BUDGET_PER_EXPERIMENT)..."

    CLAUDE_BIN="${CLAUDE_BIN:-/opt/homebrew/bin/claude}"
    if [ -x "$CLAUDE_BIN" ]; then
        # Pipe prompt via stdin because --allowedTools is variadic and would
        # consume the positional prompt argument.
        # Unset ANTHROPIC_API_KEY so ALL Claude CLI calls (orchestrator +
        # experiment.py extraction) use the Max subscription = $0 cost.
        unset ANTHROPIC_API_KEY
        echo "$PROMPT" | "$CLAUDE_BIN" --print \
            --dangerously-skip-permissions \
            --no-session-persistence \
            --model sonnet \
            --allowedTools "Bash,Edit,Read,Write,Glob,Grep" \
            2>&1 | tee "$EXPERIMENT_LOG" || true
    else
        log "ERROR: claude CLI not found at $CLAUDE_BIN"
        break
    fi

    # Parse results — prefer last-result.json (written by experiment.py),
    # fall back to parsing stdout markers from the experiment log.
    # Check both script dir and repo root (Claude Code cwd) for the result file.
    RESULT_JSON=""
    for RESULT_FILE in "$SCRIPT_DIR/last-result.json" "$(pwd)/last-result.json"; do
        if [ -f "$RESULT_FILE" ]; then
            RESULT_JSON=$(cat "$RESULT_FILE")
            rm -f "$RESULT_FILE"
            log "Read results from $RESULT_FILE"
            break
        fi
    done
    if [ -z "$RESULT_JSON" ] && grep -q "EXPERIMENT_RESULT" "$EXPERIMENT_LOG"; then
        RESULT_JSON=$(sed -n '/---EXPERIMENT_RESULT---/,/---END_EXPERIMENT_RESULT---/p' "$EXPERIMENT_LOG" | grep -v "^---" | head -1)
        log "Read results from experiment log markers"
    fi

    if [ -n "$RESULT_JSON" ]; then
            NEW_F1=$(echo "$RESULT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('overall_f1', 0))" 2>/dev/null || echo "0")
            COST=$(echo "$RESULT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('total_cost_usd', 0))" 2>/dev/null || echo "0")
            EXP_NAME=$(echo "$RESULT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('experiment', 'unknown'))" 2>/dev/null || echo "unknown")
            EXP_DESC=$(echo "$RESULT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description', '')[:60])" 2>/dev/null || echo "")

            TOTAL_COST=$(echo "$TOTAL_COST + $COST" | bc -l)

            log "Result: F1=$NEW_F1, cost=\$$COST, experiment=$EXP_NAME"

            # Compare with best F1
            IS_IMPROVEMENT=$(echo "$NEW_F1 > $BEST_F1" | bc -l)

            if [ "$IS_IMPROVEMENT" -eq 1 ]; then
                log "IMPROVEMENT! F1 $BEST_F1 → $NEW_F1 — keeping changes"
                BEST_F1=$NEW_F1
                STATUS="kept"

                # Git commit the improvement.
                # BUG FIX (2026-07-10): experiment.py/results.tsv are already-tracked
                # files inside a directory now covered by .gitignore (groups/main/*).
                # Plain `git add` on an ignored path fails silently ("ignored by
                # .gitignore, use -f"), so this commit was capturing nothing — the
                # improvement only survived by accident if the 15-min auto-backup
                # cron happened to run before the next discard-revert cycle. -f
                # forces staging of the (already-tracked, intentionally-kept) file.
                git add -f "$EXPERIMENT_FILE" "$RESULTS_FILE"
                git commit -m "autoresearch: $EXP_NAME (F1=$NEW_F1)" 2>/dev/null || true
            else
                log "No improvement (F1=$NEW_F1 <= best=$BEST_F1) — discarding changes"
                STATUS="discarded"

                # Restore experiment.py
                cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
            fi

            # Append to results.tsv
            echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\t$EXP_DESC\t$BEST_F1\t$NEW_F1\t$COST\t$STATUS" >> "$RESULTS_FILE"
    else
        log "WARNING: No experiment result found (no last-result.json or stdout markers)"
        cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
        echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tno-result\t$BEST_F1\t0\t0\terror" >> "$RESULTS_FILE"
    fi

    # Clean up backup
    rm -f "$EXPERIMENT_FILE.bak"

    log "Running total: $EXPERIMENT_COUNT experiments, \$$TOTAL_COST spent, best F1=$BEST_F1"
    echo ""
done

# ── Summary ──────────────────────────────────────────────────────────────────
log "═══ Nightly autoresearch complete ═══"
log "Experiments: $EXPERIMENT_COUNT"
log "Total cost: \$$TOTAL_COST"
log "Best F1: $BEST_F1"
log "Results: $RESULTS_FILE"
log "Best F1 this session: $BEST_F1"
