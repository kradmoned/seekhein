import os
from collections.abc import Callable
from typing import Any

from dotenv import load_dotenv

load_dotenv()

retrieve: Callable[..., dict[str, Any]] | None = None


def is_rag_enabled() -> bool:
    return os.getenv("ENABLE_RAG", "false").strip().lower() in {"1", "true", "yes"}


def _get_retriever() -> Callable[..., dict[str, Any]]:
    global retrieve
    if retrieve is not None:
        return retrieve

    try:
        from rag.retriever import retrieve as rag_retrieve
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "ENABLE_RAG is enabled, but optional RAG dependencies are not installed. "
            "Install them with: uv sync --extra rag"
        ) from exc

    retrieve = rag_retrieve
    return retrieve


def retrieve_context(
    question: str,
    lab_id: str | None = None,
    task_id: str | None = None,
    top_k: int = 3,
    db_path: str | None = None,
) -> dict:

    if not question or not question.strip():
        raise ValueError("Question cannot be empty.")

    if not is_rag_enabled():
        return {
            "context": [],
            "sources": [],
        }

    retrieve_kwargs = {
        "question": question,
        "lab_id": lab_id,
        "task_id": task_id,
        "top_k": top_k,
    }

    if db_path is not None:
        retrieve_kwargs["db_path"] = db_path

    retriever = _get_retriever()
    result = retriever(**retrieve_kwargs)

    return {
        "context": result.get("context", []),
        "sources": result.get("sources", []),
    }
