
from rag import ingest


def test_ingest_lab_json(monkeypatch):
    lab_content = {
        "title": "Lab 03 - Arrays",
        "description": "Introduction to arrays",
        "instructions": "Create and access arrays.",
        "tasks": [
            {
                "title": "Task 1",
                "description": "Create an array."
            }
        ],
    }

    monkeypatch.setattr(
        ingest,
        "chunk_pages",
        lambda pages: [{
            "text": pages[0]["text"],
            "metadata": pages[0]["metadata"].copy(),
        }],
    )

    monkeypatch.setattr(
        ingest,
        "generate_embeddings",
        lambda texts: [[0.1] * 384],
    )

    class FakeStore:
        def __init__(self, db_path="./chroma_db"):
            pass

        def add_chunks(self, chunks, embeddings):
            assert "Lab 03 - Arrays" in chunks[0]["text"]
            assert chunks[0]["metadata"]["document_name"] == "lab_content.json"
            assert len(embeddings) == 1

    monkeypatch.setattr(ingest, "VectorStore", FakeStore)

    count = ingest.ingest_lab_json(lab_content)

    assert count == 1
