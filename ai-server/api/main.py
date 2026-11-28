
from functools import lru_cache
import logging

from fastapi import FastAPI, Header, HTTPException
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    RateLimitError,
)

from agent.context_builder import build_context
from agent.session_store import SQLiteSessionStore
from agent.socratic_engine import SocraticEngine
from api.schemas import TutorRequest
from config.settings import MAX_HISTORY_TURNS, SESSION_DB_PATH


logger = logging.getLogger(__name__)


app = FastAPI(
    title="Seekhein Socratic Lab Assistant",
    description="AI-powered Socratic Programming Lab Assistant",
    version="1.0.0",
)


@lru_cache
def get_engine() -> SocraticEngine:
    return SocraticEngine()


@lru_cache
def get_session_store() -> SQLiteSessionStore:
    return SQLiteSessionStore(SESSION_DB_PATH)


def _resolve_idempotency_key(
    body_key: str | None,
    header_key: str | None,
) -> str | None:
    if body_key is not None:
        return body_key
    if header_key is None:
        return None
    stripped = header_key.strip()
    if not stripped:
        return None
    if len(stripped) > 128:
        raise ValueError("Idempotency-Key header must be at most 128 characters.")
    return stripped


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "message": "Seekhein API is running",
    }


@app.post("/api/v1/tutor")
def tutor(
    request: TutorRequest,
    idempotency_key_header: str | None = Header(
        default=None,
        alias="Idempotency-Key",
    ),
):
    try:
        idempotency_key = _resolve_idempotency_key(
            request.idempotency_key,
            idempotency_key_header,
        )

        incoming_lab_context = None
        if request.lab_context is not None:
            dumped = request.lab_context.model_dump(exclude_none=True)
            cleaned = {
                key: value
                for key, value in dumped.items()
                if not isinstance(value, str) or value.strip()
            }
            incoming_lab_context = cleaned or None

        store = get_session_store()
        pinned_lab_context = store.ensure_session(
            request.conversation_id,
            lab_context=incoming_lab_context,
        )

        if idempotency_key is not None:
            cached = store.get_idempotent_response(
                request.conversation_id,
                idempotency_key,
            )
            if cached is not None:
                return {
                    "status": "success",
                    "conversation_id": request.conversation_id,
                    "answer": cached["answer"],
                    "sources": cached["sources"],
                }

        recent_messages = store.get_recent_messages(
            request.conversation_id,
            max_turns=MAX_HISTORY_TURNS,
        )

        context = build_context(
            message=request.message,
            current_code=request.current_code,
            executed_code=request.executed_code,
            output_error=request.output_error,
            validation_feedback=request.validation_feedback,
            lab_context=pinned_lab_context,
        )

        engine = get_engine()
        answer = engine.get_response(
            context=context,
            recent_messages=recent_messages,
        )

        store.save_turn(
            conversation_id=request.conversation_id,
            user_message=request.message,
            assistant_answer=answer,
            sources=context["sources"],
            idempotency_key=idempotency_key,
        )

        return {
            "status": "success",
            "conversation_id": request.conversation_id,
            "answer": answer,
            "sources": context["sources"],
        }

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        )

    except RateLimitError as error:
        logger.warning(
            "OpenRouter rate limit for conversation_id=%s: %s",
            request.conversation_id,
            error,
        )
        raise HTTPException(
            status_code=429,
            detail="The AI provider is temporarily rate-limited. Please retry shortly.",
        )

    except (APITimeoutError, APIConnectionError) as error:
        logger.warning(
            "OpenRouter unavailable for conversation_id=%s: %s",
            request.conversation_id,
            error,
        )
        raise HTTPException(
            status_code=503,
            detail="The AI provider is temporarily unavailable. Please retry shortly.",
        )

    except APIStatusError as error:
        if error.status_code == 429:
            logger.warning(
                "OpenRouter HTTP 429 for conversation_id=%s: %s",
                request.conversation_id,
                error,
            )
            raise HTTPException(
                status_code=429,
                detail="The AI provider is temporarily rate-limited. Please retry shortly.",
            )
        if error.status_code >= 500:
            logger.warning(
                "OpenRouter HTTP %s for conversation_id=%s: %s",
                error.status_code,
                request.conversation_id,
                error,
            )
            raise HTTPException(
                status_code=503,
                detail="The AI provider is temporarily unavailable. Please retry shortly.",
            )
        logger.exception(
            "Unexpected OpenRouter error for conversation_id=%s",
            request.conversation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="An internal error occurred while processing your request.",
        )

    except Exception:
        logger.exception(
            "Unexpected tutor error for conversation_id=%s",
            request.conversation_id,
        )
        raise HTTPException(
            status_code=500,
            detail="An internal error occurred while processing your request.",
        )


@app.delete("/api/v1/sessions/{conversation_id}")
def delete_session(conversation_id: str):
    if not conversation_id.strip():
        raise HTTPException(
            status_code=400,
            detail="Conversation ID cannot be empty.",
        )

    deleted = get_session_store().delete_session(conversation_id)
    return {
        "status": "success",
        "conversation_id": conversation_id,
        "deleted": deleted,
    }
