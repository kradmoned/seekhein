from rag import ingest


def test_ingest_pdf(monkeypatch):
    monkeypatch.setattr(
        ingest, "extract_text",
        lambda path: [{
            "text": "Arrays store multiple values.",
            "metadata": {
                "document_name": "test.pdf",
                "page_number": 1
            }
        }]
    )

    monkeypatch.setattr(
        ingest, "chunk_pages",
        lambda pages: [{
            "text": pages[0]["text"],
            "metadata": pages[0]["metadata"].copy()
        }]
    )

    monkeypatch.setattr(
        ingest, "generate_embeddings",
        lambda texts: [[0.1] * 384]
    )

    class FakeStore:
        def __init__(self, db_path="./chroma_db"):
            pass

        def add_chunks(self, chunks, embeddings):
            assert chunks[0]["metadata"]["lab_id"] == "lab_1"
            assert len(embeddings) == 1

    monkeypatch.setattr(ingest, "VectorStore", FakeStore)

    count = ingest.ingest_pdf("test.pdf", lab_id="lab_1")

    assert count == 1