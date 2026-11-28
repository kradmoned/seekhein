
from functools import lru_cache

from fastapi import FastAPI, HTTPException

from api.schemas import TutorRequest
from agent.context_builder import build_context
from agent.socratic_engine import SocraticEngine


app = FastAPI(
    title="Seekhein Socratic Lab Assistant",
    description="AI-powered Socratic Programming Lab Assistant",
    version="1.0.0",
)


@lru_cache
def get_engine() -> SocraticEngine:
    return SocraticEngine()


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "message": "Seekhein API is running",
    }


@app.post("/api/v1/tutor")
def tutor(request: TutorRequest):

    try:
        context = build_context(
            message=request.message,
            current_code=request.current_code,
            executed_code=request.executed_code,
            output_error=request.output_error,
            validation_feedback=request.validation_feedback,
        )

        engine = get_engine()

        answer = engine.get_response(
            context=context,
            recent_messages=[
                message.model_dump()
                for message in request.recent_messages
            ],
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

    except Exception:
        raise HTTPException(
            status_code=500,
            detail="An internal error occurred while processing your request.",
        )
