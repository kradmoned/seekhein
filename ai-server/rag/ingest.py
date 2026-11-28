
import json
from pathlib import Path
from typing import Any

from rag.document_processor import extract_text
from rag.chunker import chunk_pages, chunk_lab_json
from rag.embedding import generate_embeddings
from rag.vector_store import VectorStore


def ingest_pdf(
    pdf_path: str | Path,
    lab_id: str,
    task_id: str | None = None,
    db_path: str = "./chroma_db",
) -> int:
    """Process a PDF and store its chunks in ChromaDB."""

    pages = extract_text(pdf_path)
    chunks = chunk_pages(pages)

    if not chunks:
        return 0

    for chunk in chunks:
        chunk["metadata"]["lab_id"] = lab_id
        if task_id:
            chunk["metadata"]["task_id"] = task_id

    texts = [chunk["text"] for chunk in chunks]
    embeddings = generate_embeddings(texts)

    store = VectorStore(db_path=db_path)
    store.add_chunks(chunks, embeddings)

    return len(chunks)


def ingest_lab_json(
    lab_content: dict[str, Any],
    db_path: str = "./chroma_db",
) -> int:
    """Process the backend's JSON lab content and store it in ChromaDB."""

    if not isinstance(lab_content, dict) or not lab_content:
        raise ValueError("Lab content must be a non-empty JSON object.")

    # Convert structured JSON into readable text while preserving its fields.
    chunks = chunk_lab_json(lab_content)

    if not chunks:
        return 0

    texts = [chunk["text"] for chunk in chunks]
    embeddings = generate_embeddings(texts)

    store = VectorStore(db_path=db_path)
    store.add_chunks(chunks, embeddings)

    return len(chunks)
