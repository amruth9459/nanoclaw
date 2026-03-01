#!/bin/bash
# lexios-prep — Convert construction PDF pages to PNG images for analysis
#
# Uses poppler-utils (pdftoppm, pdftotext, pdfinfo) which are pre-installed
# in the NanoClaw container.
#
# Usage:
#   lexios-prep <pdf>                  # Convert all pages to PNGs (200 DPI, max 10 pages)
#   lexios-prep <pdf> --pages 20       # Convert up to 20 pages
#   lexios-prep <pdf> --dpi 300        # Higher resolution (for detailed drawings)
#   lexios-prep <pdf> --text           # Extract selectable text only (fast)
#   lexios-prep <pdf> --info           # Show page count + metadata
#   lexios-prep <pdf> --page 5         # Convert a single page only
#
# Output: PNG files written to $LEXIOS_WORK_DIR (default: /workspace/group/lexios-work)
# File paths are printed to stdout (one per line) for the agent to read.
#
# Why this exists:
#   Claude's Read tool caps at 20 PDF pages per request. Construction docs are
#   50-200+ pages. Converting to individual PNGs lets the agent selectively
#   analyze specific pages using Claude's vision capabilities.

set -e

if [ $# -lt 1 ]; then
  echo "Usage: lexios-prep <pdf> [options]" >&2
  echo "" >&2
  echo "Options:" >&2
  echo "  --pages N     Max pages to convert (default: 10)" >&2
  echo "  --dpi N       Resolution in DPI (default: 200)" >&2
  echo "  --text        Extract selectable text only" >&2
  echo "  --info        Show page count and metadata" >&2
  echo "  --page N      Convert a single page" >&2
  exit 1
fi

PDF="$1"
shift

if [ ! -f "$PDF" ]; then
  echo "Error: File not found: $PDF" >&2
  exit 1
fi

# Defaults
MAX_PAGES=10
DPI=200
MODE="convert"  # convert | text | info | single
SINGLE_PAGE=""

# Parse options
while [ $# -gt 0 ]; do
  case "$1" in
    --pages)
      MAX_PAGES="$2"
      shift 2
      ;;
    --dpi)
      DPI="$2"
      shift 2
      ;;
    --text)
      MODE="text"
      shift
      ;;
    --info)
      MODE="info"
      shift
      ;;
    --page)
      MODE="single"
      SINGLE_PAGE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Get PDF info
TOTAL_PAGES=$(pdfinfo "$PDF" 2>/dev/null | grep "^Pages:" | awk '{print $2}')
if [ -z "$TOTAL_PAGES" ]; then
  echo "Error: Could not read PDF. Is this a valid PDF file?" >&2
  exit 1
fi

# --- Mode: info ---
if [ "$MODE" = "info" ]; then
  echo "Pages: $TOTAL_PAGES"
  pdfinfo "$PDF" 2>/dev/null | grep -E "^(Title|Author|Subject|Creator|Producer|Page size|File size):"
  exit 0
fi

# --- Mode: text ---
if [ "$MODE" = "text" ]; then
  pdftotext -layout "$PDF" - 2>/dev/null
  exit 0
fi

# Output directory — env-configurable
OUTDIR="${LEXIOS_WORK_DIR:-/workspace/group/lexios-work}"
mkdir -p "$OUTDIR"

# Clean previous run's files
rm -f "$OUTDIR"/page-*.png

# Base name from PDF filename (strip path and extension)
BASENAME=$(basename "$PDF" .pdf)
BASENAME=$(echo "$BASENAME" | tr ' ' '-' | tr '[:upper:]' '[:lower:]')

# --- Mode: single page ---
if [ "$MODE" = "single" ]; then
  if [ -z "$SINGLE_PAGE" ] || [ "$SINGLE_PAGE" -lt 1 ] || [ "$SINGLE_PAGE" -gt "$TOTAL_PAGES" ]; then
    echo "Error: Page $SINGLE_PAGE out of range (1-$TOTAL_PAGES)" >&2
    exit 1
  fi
  OUTFILE="$OUTDIR/page-$(printf '%03d' "$SINGLE_PAGE").png"
  pdftoppm -r "$DPI" -png -f "$SINGLE_PAGE" -l "$SINGLE_PAGE" -singlefile "$PDF" "$OUTDIR/page-$(printf '%03d' "$SINGLE_PAGE")"
  echo "$OUTFILE"
  echo "Converted page $SINGLE_PAGE of $TOTAL_PAGES (${DPI} DPI)" >&2
  exit 0
fi

# --- Mode: convert (default) ---
PAGES_TO_CONVERT=$((TOTAL_PAGES < MAX_PAGES ? TOTAL_PAGES : MAX_PAGES))

echo "Converting $PAGES_TO_CONVERT of $TOTAL_PAGES pages at ${DPI} DPI..." >&2

pdftoppm -r "$DPI" -png -f 1 -l "$PAGES_TO_CONVERT" "$PDF" "$OUTDIR/page"

# List output files (sorted)
for f in "$OUTDIR"/page-*.png; do
  if [ -f "$f" ]; then
    echo "$f"
  fi
done

echo "Done. $PAGES_TO_CONVERT pages converted to $OUTDIR/" >&2
if [ "$PAGES_TO_CONVERT" -lt "$TOTAL_PAGES" ]; then
  echo "Note: $((TOTAL_PAGES - PAGES_TO_CONVERT)) pages skipped. Use --pages $TOTAL_PAGES to convert all." >&2
fi
