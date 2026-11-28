
import re

from rag.embedding import generate_query_embedding
from rag.vector_store import VectorStore


ACTIVITY_PATTERN = re.compile(
    r"\bactivity(?:\s+number)?[\s-]*(\d+)\b",
    re.IGNORECASE,
)


def retrieve(
    question: str,
    lab_id: str | None = None,
    task_id: str | None = None,
    top_k: int = 3,
    db_path: str = "./chroma_db",
) -> dict:
    """Retrieve relevant context for a student's question."""

    if not isinstance(question, str) or not question.strip():
        raise ValueError("Question cannot be empty")

    if top_k <= 0:
        raise ValueError("top_k must be positive")

    store = VectorStore(db_path=db_path)
    query_embedding = generate_query_embedding(question)

    filters = {}

    if lab_id:
        filters["lab_id"] = lab_id

    if task_id:
        filters["task_id"] = task_id

    activity_match = ACTIVITY_PATTERN.search(question)

    if activity_match:
        filters["activity_number"] = int(activity_match.group(1))

    where = (
        {"$and": [{key: value} for key, value in filters.items()]}
        if len(filters) > 1
        else filters if filters else None
    )

    results = store.search(
        query_embedding,
        top_k=top_k,
        where=where,
    )

    return {
        "context": [item["text"] for item in results],
        "sources": [item["metadata"] for item in results],
    }
