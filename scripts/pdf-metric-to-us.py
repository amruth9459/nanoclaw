#!/usr/bin/env python3
"""
Convert metric measurements in a PDF to US customary units.

Reads text positions from the original PDF, finds metric values (mm, kg, kgf·m),
calculates US equivalents (in, lb, ft·lb), redacts original text, and inserts
converted text at the same position. Engineering drawings (vector graphics) are
preserved untouched.

Usage:
    python3 scripts/pdf-metric-to-us.py input.pdf output.pdf

Requires: pymupdf (fitz)
    pip install pymupdf
"""
import re
import sys

try:
    import fitz  # pymupdf
except ImportError:
    print("Error: pymupdf not installed. Run: pip install pymupdf", file=sys.stderr)
    sys.exit(1)


# Conversion factors
MM_TO_IN = 1 / 25.4
KG_TO_LB = 2.20462
KGF_M_TO_FT_LB = 7.23301


# Patterns for metric values
PATTERNS = [
    # mm values: "123 mm", "123mm", "123.5 mm"
    (re.compile(r'(\d+(?:\.\d+)?)\s*mm\b', re.IGNORECASE),
     lambda m: f'{float(m.group(1)) * MM_TO_IN:.2f} in',
     'mm', 'in'),
    # kg values: "12.3 kg", "12.3kg" (but not kgf)
    (re.compile(r'(\d+(?:\.\d+)?)\s*kg(?!f)\b', re.IGNORECASE),
     lambda m: f'{float(m.group(1)) * KG_TO_LB:.1f} lb',
     'kg', 'lb'),
    # kgf·m / kgf.m / kgfm values: "1.5 kgf·m"
    (re.compile(r'(\d+(?:\.\d+)?)\s*kgf[·.\s]*m\b', re.IGNORECASE),
     lambda m: f'{float(m.group(1)) * KGF_M_TO_FT_LB:.1f} ft·lb',
     'kgf·m', 'ft·lb'),
]


def convert_page(page: fitz.Page) -> int:
    """Convert metric values on a single page. Returns count of conversions."""
    conversions = 0
    text_dict = page.get_text("dict")

    for block in text_dict.get("blocks", []):
        if block.get("type") != 0:  # text blocks only
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text", "")
                if not text.strip():
                    continue

                for pattern, converter, _from_unit, _to_unit in PATTERNS:
                    match = pattern.search(text)
                    if not match:
                        continue

                    # Get the bounding box of the span
                    bbox = fitz.Rect(span["bbox"])
                    font_size = span.get("size", 10)
                    font_name = span.get("font", "helv")

                    # Convert the text
                    original = match.group(0)
                    converted = converter(match)
                    new_text = text.replace(original, converted, 1)

                    # Redact original text
                    page.add_redact_annot(bbox, fill=(1, 1, 1))
                    page.apply_redactions()

                    # Insert converted text at same position
                    # Use a slightly smaller font to fit if needed
                    insert_point = fitz.Point(bbox.x0, bbox.y1 - 1)
                    page.insert_text(
                        insert_point,
                        new_text,
                        fontsize=font_size * 0.95,
                        fontname=font_name if font_name in ("helv", "cour", "tiro") else "helv",
                        color=(0, 0, 0),
                    )
                    conversions += 1

    return conversions


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} input.pdf output.pdf", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    doc = fitz.open(input_path)
    total_conversions = 0

    for page_num in range(len(doc)):
        page = doc[page_num]
        count = convert_page(page)
        if count > 0:
            print(f"Page {page_num + 1}: {count} conversion(s)")
        total_conversions += count

    doc.save(output_path, garbage=4, deflate=True)
    doc.close()

    print(f"\nDone: {total_conversions} total conversions across {len(doc)} pages")
    print(f"Output: {output_path}")


if __name__ == "__main__":
    main()
