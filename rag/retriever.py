from rag.embedding import generate_query_embedding
from rag.vector_store import VectorStore

def retrieve(
    question: str,
    lab_id: str | None = None,
    task_id: str | None = None,
    top_k: int = 3,
    db_path: str = "./chroma_db"
) -> dict:
    """Retrieve relevant context for a student's question."""

    if not question.strip():
        raise ValueError("Question cannot be empty")

    store = VectorStore(db_path=db_path)
    query_embedding = generate_query_embedding(question)

    filters = {}

    if lab_id:
        filters["lab_id"] = lab_id

    if task_id:
        filters["task_id"] = task_id

    where = (
        {"$and": [{key: value} for key, value in filters.items()]}
        if len(filters) > 1
        else filters if filters else None
    )

    results = store.search(
        query_embedding,
        top_k=top_k,
        where=where
    )

    return {
        "context": [item["text"] for item in results],
        "sources": [item["metadata"] for item in results]
    }