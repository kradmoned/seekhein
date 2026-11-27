
from rag.embedding import (
    generate_embeddings,
    generate_query_embedding
)


def test_document_embeddings():
    texts = [
        "A pointer stores a memory address.",
        "A variable stores a value."
    ]

    embeddings = generate_embeddings(texts)

    assert len(embeddings) == 2
    assert len(embeddings[0]) == 384


def test_query_embedding():
    embedding = generate_query_embedding("What is a pointer?")

    assert len(embedding) == 384
