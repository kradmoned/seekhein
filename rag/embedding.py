
from sentence_transformers import SentenceTransformer

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

model = SentenceTransformer(MODEL_NAME)


def generate_embeddings(texts: list[str]) -> list[list[float]]:
    """Generate normalized embeddings for document chunks."""
    if not texts:
        return []

    embeddings = model.encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True
    )

    return embeddings.tolist()


def generate_query_embedding(question: str) -> list[float]:
    """Generate an embedding for a student question."""
    if not question.strip():
        raise ValueError("Question cannot be empty")

    return generate_embeddings([question])[0]
