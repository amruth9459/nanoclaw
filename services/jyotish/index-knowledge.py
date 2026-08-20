"""
Extract text from Jyotish PDFs and write as plain text files
for NanoClaw's RAG indexing pipeline to pick up.
"""

import sys
import os
import fitz  # pymupdf

KNOWLEDGE_DIR = os.path.expanduser("~/nanoclaw/data/jyotish-knowledge")
OUTPUT_DIR = os.path.expanduser("~/nanoclaw/groups/main/output/jyotish")


def extract_pdf(pdf_path: str) -> str:
    """Extract text from PDF."""
    doc = fitz.open(pdf_path)
    text = []
    for page in doc:
        text.append(page.get_text())
    doc.close()
    return "\n\n".join(text)


def chunk_by_chapter(text: str, source_name: str) -> list[tuple[str, str]]:
    """Split text into chapter-based chunks for better retrieval."""
    chunks = []
    current_chunk = []
    current_title = f"{source_name} - Introduction"
    chunk_size = 0

    for line in text.split("\n"):
        # Detect chapter/section headers
        stripped = line.strip()
        is_header = (
            stripped.startswith("Chapter") or
            stripped.startswith("CHAPTER") or
            (stripped.isupper() and len(stripped) > 10 and len(stripped) < 100) or
            stripped.startswith("Part ") or
            stripped.startswith("PART ")
        )

        if is_header and chunk_size > 500:
            # Save current chunk
            chunks.append((current_title, "\n".join(current_chunk)))
            current_chunk = [line]
            current_title = f"{source_name} - {stripped[:80]}"
            chunk_size = len(line)
        else:
            current_chunk.append(line)
            chunk_size += len(line)

            # Split if chunk gets too big (keep under ~3000 chars for better retrieval)
            if chunk_size > 3000:
                chunks.append((current_title, "\n".join(current_chunk)))
                current_chunk = []
                chunk_size = 0

    if current_chunk:
        chunks.append((current_title, "\n".join(current_chunk)))

    return chunks


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    pdfs = [f for f in os.listdir(KNOWLEDGE_DIR) if f.endswith(".pdf")]
    if not pdfs:
        print("No PDFs found in knowledge directory")
        return

    total_chunks = 0
    for pdf_file in pdfs:
        pdf_path = os.path.join(KNOWLEDGE_DIR, pdf_file)
        source_name = pdf_file.replace(".pdf", "").replace("-", " ").title()

        print(f"Extracting: {pdf_file}")
        text = extract_pdf(pdf_path)
        print(f"  Extracted {len(text)} chars")

        # Write full text
        full_path = os.path.join(OUTPUT_DIR, pdf_file.replace(".pdf", ".txt"))
        with open(full_path, "w") as f:
            f.write(text)
        print(f"  Written: {full_path}")

        # Write chapter chunks
        chunks = chunk_by_chapter(text, source_name)
        for i, (title, content) in enumerate(chunks):
            chunk_path = os.path.join(OUTPUT_DIR, f"{pdf_file.replace('.pdf', '')}-chunk-{i:03d}.txt")
            with open(chunk_path, "w") as f:
                f.write(f"# {title}\n\n{content}")
            total_chunks += 1

        print(f"  Created {len(chunks)} chunks")

    print(f"\nDone. {total_chunks} total chunks in {OUTPUT_DIR}")
    print("NanoClaw will auto-index these on next indexing cycle.")
    print("Or trigger manual indexing via the container agent.")


if __name__ == "__main__":
    main()
