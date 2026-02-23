#!/bin/bash
# ocr.sh — Best-effort OCR for any file type
#
# Usage:
#   ocr.sh <file>              # Auto-detect language
#   ocr.sh <file> <lang>       # Specify language(s), e.g. hin, ara, chi_sim+eng
#   ocr.sh <file> list         # List available Tesseract languages
#
# For PDFs with selectable text: uses pdftotext (fast, lossless)
# For scanned/image PDFs and images: uses Tesseract (100+ languages, LSTM engine)
# Handwritten text: Tesseract --oem 1 (LSTM neural net) or pass lang explicitly
#
# Examples:
#   ocr.sh /workspace/media/invoice.pdf
#   ocr.sh /workspace/media/scan.pdf hin          # Hindi
#   ocr.sh /workspace/media/photo.jpg ara          # Arabic
#   ocr.sh /workspace/media/doc.pdf chi_sim+eng   # Chinese + English
#   ocr.sh /workspace/media/form.png deu           # German

set -e

if [ $# -lt 1 ]; then
  echo "Usage: ocr.sh <file> [lang|list]" >&2
  exit 1
fi

FILE="$1"
LANG="${2:-eng}"

if [ "$LANG" = "list" ]; then
  echo "Available Tesseract languages:"
  tesseract --list-langs 2>&1 | tail -n +2 | sort
  exit 0
fi

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE" >&2
  exit 1
fi

EXT="${FILE##*.}"
EXT="${EXT,,}"  # lowercase

# For PDFs: try digital text extraction first (fast, perfect quality)
if [ "$EXT" = "pdf" ]; then
  DIGITAL_TEXT=$(pdftotext -q "$FILE" - 2>/dev/null || true)
  # Check if we got meaningful text (not just whitespace)
  MEANINGFUL=$(echo "$DIGITAL_TEXT" | tr -d '[:space:]' | wc -c)
  if [ "$MEANINGFUL" -gt 50 ]; then
    echo "$DIGITAL_TEXT"
    exit 0
  fi
  # Fall through to image-based OCR for scanned PDFs
fi

# Convert PDF/image to temporary PNG images and run Tesseract
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

if [ "$EXT" = "pdf" ]; then
  # Convert each PDF page to 300dpi PNG
  pdftoppm -r 300 -png "$FILE" "$TMP/page" 2>/dev/null
  IMAGES=("$TMP"/page-*.png)
else
  # For images: copy directly
  cp "$FILE" "$TMP/input.${EXT}"
  IMAGES=("$TMP/input.${EXT}")
fi

if [ ${#IMAGES[@]} -eq 0 ] || [ ! -f "${IMAGES[0]}" ]; then
  echo "Error: Could not process file for OCR" >&2
  exit 1
fi

# Run Tesseract on each image with LSTM engine (best for handwriting)
for IMG in "${IMAGES[@]}"; do
  tesseract "$IMG" stdout -l "$LANG" --oem 1 --psm 3 2>/dev/null || \
  tesseract "$IMG" stdout -l "$LANG" --psm 3 2>/dev/null || \
  tesseract "$IMG" stdout 2>/dev/null
done
