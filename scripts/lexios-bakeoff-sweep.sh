#!/bin/zsh
# Lexios OCR bake-off — sweep version.
#
# Runs `lexios benchmark-nemotron` against a representative sample of the corpus
# PDFs, aggregates F1 / WER / cost into one CSV. Built on top of the existing
# single-PDF benchmark CLI (lexios/benchmark_nemotron_ocr.py) — no new model
# code; just orchestration and aggregation.
#
# Requires: NVIDIA_API_KEY in env (NIM endpoint for Nemotron OCR v1)
# Optional: ANTHROPIC_API_KEY (already-available — used by Lexios extract.py)
#
# Usage:
#   NVIDIA_API_KEY=nvapi-... ./scripts/lexios-bakeoff-sweep.sh [N_DOCS]
# Default N_DOCS=5.
set -u

CORPUS=/Users/amrut/Lexios/lexios/corpus
N="${1:-5}"
OUT=/Users/amrut/nanoclaw/data/lexios-bakeoff
mkdir -p "$OUT"
SUMMARY="$OUT/sweep-$(date +%Y%m%d-%H%M%S).csv"

if [ -z "${NVIDIA_API_KEY:-}" ]; then
  echo "NVIDIA_API_KEY not set — get one from build.nvidia.com (free tier ok)"
  echo "Then re-run: NVIDIA_API_KEY=nvapi-... $0 [N]"
  exit 1
fi

echo "doc_id,pages,nemotron_wer,lexios_wer,nemotron_cost_usd,lexios_cost_usd,nemotron_seconds,lexios_seconds" > "$SUMMARY"

# Pick N representative PDFs — prefer architectural plans (the F1 weak spot).
# Sort by name so the same N is reproducible across runs.
PDFS=$(find "$CORPUS" -maxdepth 3 -name "*.pdf" | grep -iE "architectural|plan|drawing|holabird" | sort | head -n "$N")

if [ -z "$PDFS" ]; then
  PDFS=$(find "$CORPUS" -maxdepth 3 -name "*.pdf" | sort | head -n "$N")
fi

i=0
for pdf in $(echo "$PDFS"); do
  i=$((i+1))
  doc_id=$(basename "$(dirname "$pdf")")
  doc_out="$OUT/$doc_id"
  mkdir -p "$doc_out"
  echo "[$i/$N] $doc_id"

  cd /Users/amrut/Lexios
  /usr/bin/env python3 -m lexios benchmark-nemotron "$pdf" \
    --out-dir "$doc_out" \
    --pages 5 \
    --dpi 200 2>&1 | tee "$doc_out/run.log" || true

  # Aggregate from the per-doc summary file the benchmark writes.
  if [ -f "$doc_out/summary.json" ]; then
    /usr/bin/env python3 -c "
import json, sys
s = json.load(open('$doc_out/summary.json'))
n = s.get('nemotron', {})
l = s.get('lexios', {})
print(','.join([
    '$doc_id',
    str(s.get('pages', '')),
    f\"{n.get('wer', '')}\",
    f\"{l.get('wer', '')}\",
    f\"{n.get('cost_usd', '')}\",
    f\"{l.get('cost_usd', '')}\",
    f\"{n.get('seconds', '')}\",
    f\"{l.get('seconds', '')}\",
]))" >> "$SUMMARY"
  else
    echo "$doc_id,,err,err,err,err,err,err" >> "$SUMMARY"
  fi
done

echo
echo "===== SWEEP DONE ====="
echo "Summary: $SUMMARY"
column -t -s , "$SUMMARY"
