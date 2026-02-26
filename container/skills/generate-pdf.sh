#!/bin/bash
# HTML to PDF converter using weasyprint
# Usage: generate-pdf input.html [output.pdf]

HTML_FILE="$1"
PDF_FILE="${2:-output.pdf}"

if [ -z "$HTML_FILE" ]; then
    echo "Usage: generate-pdf <input.html> [output.pdf]"
    exit 1
fi

if [ ! -f "$HTML_FILE" ]; then
    echo "Error: HTML file not found: $HTML_FILE"
    exit 1
fi

python3 -m weasyprint "$HTML_FILE" "$PDF_FILE" 2>/dev/null

if [ -f "$PDF_FILE" ]; then
    echo "PDF generated: $PDF_FILE"
    ls -lh "$PDF_FILE"
else
    echo "Error: PDF generation failed"
    exit 1
fi
