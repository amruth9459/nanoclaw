#!/bin/bash
#
# Lexios Autoresearch — Karpathy-style Nightly Loop (v2.1, 2026-07-16)
#
# ARCHITECTURE (v2 — supersedes the session-runs-everything design):
#   Sessions form a hypothesis and EDIT experiment.py's CONFIG section. Nothing
#   else. The ORCHESTRATOR measures: the untrusted process (experiment.py,
#   which executes agent-authored CONFIG code) only DUMPS extraction artifacts;
#   a TRUSTED scorer (score_eval.py, guard-hashed, never executes CONFIG code)
#   recomputes every number the gate uses. Why:
#     - 5/10 sessions on 2026-07-16 produced no result because they backgrounded
#       the long run and exited (print-mode sessions can't wait).
#     - Sessions self-reporting scores was the trust hole behind months of
#       false "kept" rows.
#     - Adversarial grade of v2.0 (2026-07-16) showed in-process CONFIG code
#       could forge scores computed in the same process — hence the artifact
#       dump + trusted re-scorer split, randomized probe sentinels, GT-source
#       hashing, and snapshot-restore on violations.
#
# Gate: keep iff tonight's effective eval F1 (TRUSTED scorer) strictly
# improves. Baseline is measured fresh each night (2026-07-15 ratchet fix —
# never read all-time history; cross-night numbers aren't comparable).
#
# RESIDUAL RISK (documented, accepted): CONFIG code runs unsandboxed during
# measurement. It can no longer control the arithmetic, but it could still
# write GT-derived CONTENT into the artifacts (injection). Randomized probes +
# the raw/post split target that, and every "kept" config is committed for
# review — but a deliberately adversarial session is not fully contained
# without a real sandbox. The sessions are instruction-following optimizers,
# not adversaries; review kept commits before trusting milestone claims.
#
# Usage:
#   bash run_nightly.sh              # Full nightly run (2AM-6AM)
#   bash run_nightly.sh --test       # Single experiment for testing
#   bash run_nightly.sh --max 2     # Cap experiment count
#

set -uo pipefail
# Note: -e deliberately omitted — Claude CLI may exit non-zero, which shouldn't abort the loop.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
RESULTS_FILE="$SCRIPT_DIR/results.tsv"
EXPERIMENT_FILE="$SCRIPT_DIR/experiment.py"
TRUSTED_SCORER="$SCRIPT_DIR/score_eval.py"
GT_SOURCES_GLOB="$HOME/Lexios/work/eval-*"   # prepare.py copy sources — guarded

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

# ── Guard: hash of everything the measurement's integrity depends on ────────
# Covers: the non-CONFIG zones of experiment.py (exact-line, unique markers),
# the trusted scorer, evaluate.py/prepare.py, the production scorer
# (~/Lexios/lexios/eval.py), and ALL prepare.py GT copy-sources (JSON + PNG)
# so a tampered GT source can't silently inflate every future night.
guard_hash() {
    python3 - "$EXPERIMENT_FILE" <<'PY' 2>/dev/null
import sys, hashlib
from pathlib import Path

MARK_START = "# ── EXPERIMENT CONFIG (agent edits this section) ─────────────────────────────"
MARK_END = "# ── END EXPERIMENT CONFIG ────────────────────────────────────────────────────"

lines = open(sys.argv[1]).read().splitlines()
starts = [i for i, l in enumerate(lines) if l == MARK_START]
ends = [i for i, l in enumerate(lines) if l == MARK_END]
if len(starts) != 1 or len(ends) != 1 or ends[0] <= starts[0]:
    sys.exit(1)  # missing/duplicated/reordered markers → violation
protected = "\n".join(lines[:starts[0] + 1] + lines[ends[0]:])
h = hashlib.sha256(protected.encode())

script_dir = Path(sys.argv[1]).resolve().parent
extras = [Path.home() / "Lexios" / "lexios" / "eval.py",
          script_dir / "score_eval.py",
          script_dir / "evaluate.py",
          script_dir / "prepare.py"]
extras += sorted((Path.home() / "Lexios" / "work").glob("eval-*/**/*"))
for extra in extras:
    if extra.is_file() and extra.suffix in {".py", ".json", ".png", ".jpg"}:
        h.update(str(extra).encode())
        h.update(extra.read_bytes())
print(h.hexdigest())
PY
}

# ── Snapshot / restore of the small protected files ──────────────────────────
SNAPSHOT_DIR="$LOG_DIR/protected-snapshot"
snapshot_protected() {
    rm -rf "$SNAPSHOT_DIR"
    mkdir -p "$SNAPSHOT_DIR/gt-sources"
    cp "$TRUSTED_SCORER" "$SCRIPT_DIR/evaluate.py" "$SCRIPT_DIR/prepare.py" "$SNAPSHOT_DIR/" 2>/dev/null
    # GT source JSONs are small; images are detection-only (abort, human repairs)
    find "$HOME/Lexios/work" -maxdepth 2 -path "*eval-*" -name "*.json" 2>/dev/null | while read -r f; do
        mkdir -p "$SNAPSHOT_DIR/gt-sources$(dirname "$f")"
        cp "$f" "$SNAPSHOT_DIR/gt-sources$f"
    done
}
restore_protected() {
    cp "$SNAPSHOT_DIR/score_eval.py" "$TRUSTED_SCORER" 2>/dev/null
    cp "$SNAPSHOT_DIR/evaluate.py" "$SCRIPT_DIR/evaluate.py" 2>/dev/null
    cp "$SNAPSHOT_DIR/prepare.py" "$SCRIPT_DIR/prepare.py" 2>/dev/null
    if [ -d "$SNAPSHOT_DIR/gt-sources" ]; then
        (cd "$SNAPSHOT_DIR/gt-sources" && find . -name "*.json" | while read -r f; do
            cp "$f" "/${f#./}" 2>/dev/null
        done)
    fi
    git -C "$HOME/Lexios" checkout -- lexios/eval.py 2>/dev/null || true
}

# ── Measurement: orchestrator-run, foreground, timed, trusted re-score ──────
# Sets TRUSTED_JSON (gate numbers, from score_eval.py) and UNTRUSTED_JSON
# (labels only: experiment name/description). Empty on failure.
measure() {
    local run_log="$1"
    TRUSTED_JSON=""
    UNTRUSTED_JSON=""
    local sentinel
    sentinel=$(openssl rand -hex 8 2>/dev/null || date +%s%N)
    local artifacts="$SCRIPT_DIR/eval-artifacts.json"
    # Re-copy ground truth from the (guarded) Lexios sources before every
    # measurement so working-copy GT tampering can never inflate a score.
    python3 "$SCRIPT_DIR/prepare.py" >> "$run_log" 2>&1
    rm -f "$SCRIPT_DIR/last-result.json" "$(pwd)/last-result.json" "$artifacts"
    timeout "$MEASURE_TIMEOUT" python3 "$EXPERIMENT_FILE" \
        --eval-docs "$EVAL_DOCS" \
        --probe-sentinel "$sentinel" \
        --artifacts-out "$artifacts" >> "$run_log" 2>&1
    local rc=$?
    # Reap any stragglers the untrusted process may have detached
    pkill -9 -f "$EXPERIMENT_FILE" 2>/dev/null
    if [ $rc -eq 124 ]; then
        log "Measurement TIMED OUT after ${MEASURE_TIMEOUT}s"
        return 1
    fi
    if [ ! -f "$artifacts" ]; then
        log "Measurement produced no artifacts dump (exit=$rc)"
        return 1
    fi
    # Labels from the untrusted summary (display only, never gate input)
    if [ -f "$SCRIPT_DIR/last-result.json" ]; then
        UNTRUSTED_JSON=$(cat "$SCRIPT_DIR/last-result.json")
        rm -f "$SCRIPT_DIR/last-result.json"
    fi
    # THE numbers: trusted re-score from artifacts + GT
    TRUSTED_JSON=$(python3 "$TRUSTED_SCORER" "$artifacts" "$SCRIPT_DIR/ground-truth" "$sentinel" "$EVAL_DOCS" 2>>"$run_log" | tail -1)
    rm -f "$artifacts"
    if [ -z "$TRUSTED_JSON" ] || [ "$(echo "$TRUSTED_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("ok", False))' 2>/dev/null)" != "True" ]; then
        log "Trusted re-score FAILED"
        return 1
    fi
    return 0
}

tget() {  # tget "$json" key default
    echo "$1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$2', $3))" 2>/dev/null || echo "$3"
}
sanitize() {  # strip tabs/newlines so agent-authored strings can't corrupt the TSV
    echo "$1" | tr '\t\n' '  ' | cut -c1-60
}

# ── Init ─────────────────────────────────────────────────────────────────────
if [ ! -f "$RESULTS_FILE" ]; then
    echo -e "timestamp\texperiment_id\tdescription\tprev_f1\tnew_f1\tcost_usd\tstatus" > "$RESULTS_FILE"
fi

cd "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR")"

snapshot_protected
log "Protected-file snapshot taken"

# ── Tonight's baseline (real-vision eval, trusted scorer) ────────────────────
TOTAL_COST=0
log "Measuring tonight's baseline: eval docs = $EVAL_DOCS ..."
BASELINE_LOG="$LOG_DIR/baseline-$(date +%Y%m%d-%H%M%S).log"
if ! measure "$BASELINE_LOG"; then
    log "FATAL: baseline measurement failed — aborting tonight's loop (measurement path broken; fix before experimenting)"
    exit 1
fi
BEST_F1=$(tget "$TRUSTED_JSON" overall_f1 0)
BASELINE_DETAIL=$(echo "$TRUSTED_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d.get('results', []):
    print(f\"- {r['doc_id']}: raw F1={r.get('raw_f1','?')}, postprocessed F1={r.get('post_f1','?')}, effective F1={r['f1']}\")
print(f\"- phantom probes: fabricated={d.get('phantom_fabricated','?')} (clean={d.get('phantom_clean','?')}) — if not clean, postprocess is scored as RAW\")
" 2>/dev/null)
log "Baseline effective F1 (trusted): $BEST_F1"
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
    if [ -z "$PRE_GUARD" ]; then
        log "FATAL: guard hash unavailable before session (markers mangled?) — aborting"
        exit 1
    fi
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
   anything — you have no shell. The orchestrator runs the measurement with a
   trusted scorer, applies the keep/discard gate, and reverts your edit if it
   doesn't improve.

## Hard rules
- Touching anything outside the CONFIG markers (or the markers, or any scorer
  or ground-truth file) = the whole edit is auto-rejected before measurement.
- Do NOT add ground-truth-derived injections to postprocess(). Measurement
  probes postprocess with empty and randomized decoy inputs, and an
  independent scorer recounts everything; fabricated elements disqualify your
  postprocess and the run is scored on RAW vision output only. postprocess may
  TRANSFORM what vision returned (rename, dedupe, normalize, split) — never
  invent elements. Gaming the measurement instead of improving extraction is
  a wasted night-slot: kept configs are reviewed.
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
            --disallowedTools "Bash,Write,NotebookEdit,WebFetch,WebSearch,Task,Agent" \
            2>&1 | tee "$EXPERIMENT_LOG" || true
    else
        log "ERROR: claude CLI not found at $CLAUDE_BIN"
        break
    fi

    # ── Guards before spending a measurement run ────────────────────────────
    POST_FULL=$(shasum -a 256 "$EXPERIMENT_FILE" | cut -d' ' -f1)
    if [ "$POST_FULL" = "$PRE_FULL" ] && [ "$(guard_hash)" = "$PRE_GUARD" ]; then
        log "Session made no edit — skipping measurement"
        echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tno-edit\t$BEST_F1\t0\t0\tno-edit" >> "$RESULTS_FILE"
        rm -f "$EXPERIMENT_FILE.bak"
        continue
    fi
    POST_GUARD=$(guard_hash)
    if [ -z "$POST_GUARD" ] || [ "$POST_GUARD" != "$PRE_GUARD" ]; then
        log "GUARD VIOLATION: protected zone/scorer/GT modified by session — restoring"
        cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
        restore_protected
        if [ "$(guard_hash)" != "$PRE_GUARD" ]; then
            log "FATAL: restore did not converge — human attention required"
            echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tguard-violation-unrestored\t$BEST_F1\t0\t0\trejected-guard" >> "$RESULTS_FILE"
            exit 1
        fi
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

    # ── Orchestrator-run measurement (trusted scorer) ────────────────────────
    log "Measuring edited config (real vision, eval docs)..."
    if ! measure "$EXPERIMENT_LOG"; then
        log "Measurement failed — reverting edit"
        cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
        echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tmeasurement-failed\t$BEST_F1\t0\t0\terror" >> "$RESULTS_FILE"
        rm -f "$EXPERIMENT_FILE.bak"
        continue
    fi

    # CONFIG code ran during measurement — re-verify every protected file. On
    # violation: restore what we can and ABORT fail-closed with a nonzero exit
    # (the scorer/GT may be poisoned; no further measurement is trustworthy).
    if [ "$(guard_hash)" != "$PRE_GUARD" ]; then
        log "GUARD VIOLATION (post-measurement): protected files changed DURING the run — restoring and ABORTING tonight"
        cp "$EXPERIMENT_FILE.bak" "$EXPERIMENT_FILE"
        restore_protected
        echo -e "$(date -u +%Y-%m-%dT%H:%M:%SZ)\t$EXPERIMENT_ID\tguard-violation-postmeasure\t$BEST_F1\t0\t0\trejected-guard" >> "$RESULTS_FILE"
        rm -f "$EXPERIMENT_FILE.bak"
        exit 1
    fi

    NEW_F1=$(tget "$TRUSTED_JSON" overall_f1 0)
    PHANTOM_CLEAN=$(tget "$TRUSTED_JSON" phantom_clean "''")
    EXP_NAME=$(sanitize "$(echo "$UNTRUSTED_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('experiment', 'unknown'))" 2>/dev/null || echo unknown)")
    EXP_DESC=$(sanitize "$(echo "$UNTRUSTED_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description', ''))" 2>/dev/null || echo '')")
    COST=$(tget "$UNTRUSTED_JSON" total_cost_usd 0)
    TOTAL_COST=$(echo "$TOTAL_COST + $COST" | bc -l)

    log "Result (trusted): effective F1=$NEW_F1 (phantom clean=$PHANTOM_CLEAN), experiment=$EXP_NAME"

    PREV_BEST=$BEST_F1
    IS_IMPROVEMENT=$(echo "$NEW_F1 > $BEST_F1" | bc -l 2>/dev/null || echo 0)
    if [ "${IS_IMPROVEMENT:-0}" -eq 1 ] 2>/dev/null; then
        # -f REQUIRED: groups/main/* is gitignored; plain add exits 1 even for
        # tracked files (verified 2026-07-15). Commit is scoped to this file
        # and a failed commit downgrades the logged status — never a silent lie.
        git add -f "$EXPERIMENT_FILE"
        if git commit -m "autoresearch: $EXP_NAME (eval F1=$NEW_F1)" -- "$EXPERIMENT_FILE" >/dev/null 2>&1; then
            STATUS="kept"
        else
            STATUS="kept-uncommitted"
            log "WARNING: improvement kept on disk but git commit FAILED"
        fi
        log "IMPROVEMENT! F1 $PREV_BEST → $NEW_F1 — keeping changes ($STATUS)"
        BEST_F1=$NEW_F1
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
log "Best eval F1 tonight (trusted): $BEST_F1  (eval docs: $EVAL_DOCS)"
log "Results: $RESULTS_FILE"
