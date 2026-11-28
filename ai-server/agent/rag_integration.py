
from rag.retriever import retrieve


def retrieve_context(
    question: str,
    lab_id: str | None = None,
    task_id: str | None = None,
    top_k: int = 3,
    db_path: str | None = None,
) -> dict:

    if not question or not question.strip():
        raise ValueError("Question cannot be empty.")

    retrieve_kwargs = {
        "question": question,
        "lab_id": lab_id,
        "task_id": task_id,
        "top_k": top_k,
    }

    if db_path is not None:
        retrieve_kwargs["db_path"] = db_path

    result = retrieve(**retrieve_kwargs)

    return {
        "context": result.get("context", []),
        "sources": result.get("sources", []),
    }
