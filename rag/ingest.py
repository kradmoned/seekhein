from pathlib import Path

from rag.document_processor import extract_text
from rag.chunker import chunk_pages
from rag.embedding import generate_embeddings
from rag.vector_store import VectorStore


def ingest_pdf(
    pdf_path: str | Path,
    lab_id: str,
    task_id: str | None = None,
    db_path: str ="./chroma_db"
) -> int:
    """Process a PDF and store its chunks in ChromaDB."""

    pages = extract_text(pdf_path)
    chunks = chunk_pages(pages)

    if not chunks:
        return 0

    # Attach course/lab identifiers to every chunk
    for chunk in chunks:
        chunk["metadata"]["lab_id"] = lab_id
        if task_id:
            chunk["metadata"]["task_id"] = task_id

    texts = [chunk["text"] for chunk in chunks]
    embeddings = generate_embeddings(texts)

    store = VectorStore(db_path=db_path)
    store.add_chunks(chunks, embeddings)

    return len(chunks)

