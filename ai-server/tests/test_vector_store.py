
from rag.vector_store import VectorStore


def test_store_chunks(tmp_path):
    store = VectorStore(db_path=str(tmp_path / "test_db"))

    chunks = [{
        "text": "A pointer stores a memory address.",
        "metadata": {
            "document_name": "test.pdf",
            "page_number": 1,
            "chunk_id": 0
        }
    }]

    embeddings = [[0.1] * 384]

    store.add_chunks(chunks, embeddings)

    assert store.count() == 1

def test_search_chunks(tmp_path):
    store = VectorStore(db_path=str(tmp_path / "search_db"))

    chunks = [
        {
            "text": "Arrays store multiple values.",
            "metadata": {
                "document_name": "test.pdf",
                "page_number": 1,
                "chunk_id": 0
            }
        },
        {
            "text": "Loops repeat instructions.",
            "metadata": {
                "document_name": "test.pdf",
                "page_number": 2,
                "chunk_id": 1
            }
        }
    ]

    embeddings = [
        [1.0] + [0.0] * 383,
        [0.0, 1.0] + [0.0] * 382
    ]

    store.add_chunks(chunks, embeddings)

    results = store.search(embeddings[0], top_k=1)

    assert len(results) == 1
    assert results[0]["text"] == "Arrays store multiple values."