from rag import retriever


def test_retrieve(monkeypatch):
    class FakeStore:
        def search(self, query_embedding, top_k=3, where=None):
            return [{
                "text": "Arrays store multiple values.",
                "metadata": {
                    "document_name": "test.pdf",
                    "page_number": 1
                },
                "distance": 0.1
            }]

    monkeypatch.setattr(
        retriever,
        "VectorStore",
        lambda db_path="./chroma_db": FakeStore()
    )

    monkeypatch.setattr(
        retriever,
        "generate_query_embedding",
        lambda question: [0.1] * 384
    )

    result = retriever.retrieve("What is an array?")

    assert len(result["context"]) == 1
    assert "Arrays" in result["context"][0]
    assert result["sources"][0]["page_number"] == 1


def test_empty_question():
    import pytest

    with pytest.raises(ValueError):
        retriever.retrieve("   ")