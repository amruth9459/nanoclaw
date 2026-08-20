"""
OCR scanned Jyotish PDFs using PyMuPDF's pdfocr_tobytes + Tesseract.
"""
import os
import sys
import fitz

KNOWLEDGE_DIR = os.path.expanduser("~/nanoclaw/data/jyotish-knowledge")
OUTPUT_DIR = os.path.expanduser("~/nanoclaw/groups/main/output/jyotish")

SCANNED_PDFS = [
    "phaladeepika-sastri.pdf",
    "brihat-jataka-sastri.pdf",
    "jaimini-sutras-rao.pdf",
    "saravali-santhanam.pdf",
]


def chunk_text(text, source_name, max_chunk=3000):
    chunks = []
    current = []
    size = 0
    chunk_title = f"{source_name} - Section"

    for line in text.split("\n"):
        stripped = line.strip()
        is_header = (
            stripped.startswith("Chapter") or
            stripped.startswith("CHAPTER") or
            (stripped.isupper() and 10 < len(stripped) < 100) or
            stripped.startswith("Part ") or
            stripped.startswith("PART ") or
            stripped.startswith("SLOKA") or
            stripped.startswith("Sloka") or
            stripped.startswith("STANZA") or
            stripped.startswith("Adhyaya")
        )

        if is_header and size > 500:
            chunks.append((chunk_title, "\n".join(current)))
            current = [line]
            chunk_title = f"{source_name} - {stripped[:80]}"
            size = len(line)
        else:
            current.append(line)
            size += len(line)
            if size > max_chunk:
                chunks.append((chunk_title, "\n".join(current)))
                current = []
                size = 0

    if current:
        chunks.append((chunk_title, "\n".join(current)))
    return chunks


def ocr_pdf(pdf_path):
    """OCR a scanned PDF page by page using pdfocr_tobytes."""
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    all_text = []

    for i, page in enumerate(doc):
        if (i + 1) % 50 == 0 or i == 0:
            print(f"  Page {i+1}/{total_pages}...", flush=True)

        # Render page to pixmap at 2x for better OCR
        mat = fitz.Matrix(2, 2)
        pix = page.get_pixmap(matrix=mat)

        # Use pdfocr_tobytes to OCR the pixmap into a PDF with text layer
        try:
            ocr_bytes = pix.pdfocr_tobytes(language="eng", tessdata=None)
            ocr_doc = fitz.open("pdf", ocr_bytes)
            if len(ocr_doc) > 0:
                text = ocr_doc[0].get_text()
                if text.strip():
                    all_text.append(text)
            ocr_doc.close()
        except Exception as e:
            # Fallback: try at lower resolution
            try:
                pix2 = page.get_pixmap()
                ocr_bytes = pix2.pdfocr_tobytes(language="eng")
                ocr_doc = fitz.open("pdf", ocr_bytes)
                if len(ocr_doc) > 0:
                    text = ocr_doc[0].get_text()
                    if text.strip():
                        all_text.append(text)
                ocr_doc.close()
            except Exception:
                pass

    doc.close()
    return "\n\n".join(all_text)


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    total_chunks = 0

    for pdf_file in SCANNED_PDFS:
        pdf_path = os.path.join(KNOWLEDGE_DIR, pdf_file)
        if not os.path.exists(pdf_path):
            print(f"SKIP: {pdf_file} not found")
            continue

        source_name = pdf_file.replace(".pdf", "").replace("-", " ").title()
        print(f"\nOCR: {pdf_file}", flush=True)

        text = ocr_pdf(pdf_path)
        print(f"  Extracted {len(text)} chars via OCR")

        if len(text) < 100:
            print(f"  WARNING: Very little text extracted, skipping")
            continue

        # Write full text
        full_path = os.path.join(OUTPUT_DIR, pdf_file.replace(".pdf", ".txt"))
        with open(full_path, "w") as f:
            f.write(text)

        # Write chunks
        chunks = chunk_text(text, source_name)
        for i, (title, content) in enumerate(chunks):
            chunk_path = os.path.join(
                OUTPUT_DIR,
                f"{pdf_file.replace('.pdf', '')}-chunk-{i:03d}.txt"
            )
            with open(chunk_path, "w") as f:
                f.write(f"# {title}\n\n{content}")
            total_chunks += 1

        print(f"  Created {len(chunks)} chunks")

    print(f"\nDone. {total_chunks} new OCR chunks in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
