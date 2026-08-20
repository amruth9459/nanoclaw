"""
Extract text from PVR Narasimha Rao's PDF materials and chunk for RAG indexing.
These are text-based PDFs (not scanned), so direct text extraction works.
"""
import os
import fitz

KNOWLEDGE_DIR = os.path.expanduser("~/nanoclaw/data/jyotish-knowledge/pvr-materials")
OUTPUT_DIR = os.path.expanduser("~/nanoclaw/groups/main/output/jyotish")

PVR_PDFS = [
    "pvr-lessons-book1.pdf",
    "pvr-lessons-book2.pdf",
    "pvr-transit-vimshottari.pdf",
    "pvr-integrated-approach.pdf",
    "pvr-vedic-wisdom.pdf",
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
            stripped.startswith("Lesson") or
            stripped.startswith("LESSON") or
            (stripped.isupper() and 10 < len(stripped) < 100) or
            stripped.startswith("Part ") or
            stripped.startswith("PART ") or
            stripped.startswith("Topic:") or
            stripped.startswith("Section") or
            stripped.startswith("SECTION")
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


def extract_pdf(pdf_path):
    """Extract text from a text-based PDF using PyMuPDF."""
    doc = fitz.open(pdf_path)
    all_text = []
    for page in doc:
        text = page.get_text()
        if text.strip():
            all_text.append(text)
    doc.close()

    full_text = "\n\n".join(all_text)

    # If very little text extracted, try OCR fallback
    if len(full_text) < 500 and len(doc) > 5:
        print(f"  Low text yield ({len(full_text)} chars), attempting OCR...")
        doc = fitz.open(pdf_path)
        all_text = []
        for page in doc:
            mat = fitz.Matrix(2, 2)
            pix = page.get_pixmap(matrix=mat)
            try:
                ocr_bytes = pix.pdfocr_tobytes(language="eng")
                ocr_doc = fitz.open("pdf", ocr_bytes)
                if len(ocr_doc) > 0:
                    text = ocr_doc[0].get_text()
                    if text.strip():
                        all_text.append(text)
                ocr_doc.close()
            except Exception:
                pass
        doc.close()
        full_text = "\n\n".join(all_text)

    return full_text


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    total_chunks = 0

    for pdf_file in PVR_PDFS:
        pdf_path = os.path.join(KNOWLEDGE_DIR, pdf_file)
        if not os.path.exists(pdf_path):
            print(f"SKIP: {pdf_file} not found")
            continue

        source_name = "PVR " + pdf_file.replace("pvr-", "").replace(".pdf", "").replace("-", " ").title()
        print(f"\nExtracting: {pdf_file}", flush=True)

        text = extract_pdf(pdf_path)
        print(f"  Extracted {len(text)} chars")

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

    print(f"\nDone. {total_chunks} new PVR chunks in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
