
from typing import Annotated

from fastapi import APIRouter, HTTPException, Body

from api.schemas import LabInitializeRequest, MessageRequest
from rag.ingest import ingest_lab_json
from agent.context_builder import build_context
from agent.socratic_engine import SocraticEngine


TutorRequest = Annotated[
    LabInitializeRequest | MessageRequest,
    Body(discriminator="request_type"),
]

router = APIRouter()

# One reusable engine client.
# It does not store conversation history.
engine = SocraticEngine()


@router.post("/tutor")
def tutor(request: TutorRequest):

    # First request: initialize the lab.
    if isinstance(request, LabInitializeRequest):
        try:
            chunk_count = ingest_lab_json(request.lab_content)

            return {
                "status": "success",
                "message": "Lab initialized successfully.",
                "chunks_indexed": chunk_count,
            }

        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        except Exception:
            raise HTTPException(
                status_code=500,
                detail="Lab initialization failed.",
            )

    # Subsequent requests: answer student questions.
    if isinstance(request, MessageRequest):
        try:
            if request.scenario == "runtime_error":
                feedback = request.output

            elif request.scenario == "submission_feedback":
                feedback = request.validation_feedback

            else:
                feedback = None

            context = build_context(
                question=request.message,
                scenario=request.scenario,
                student_code=request.code,
                execution_feedback=feedback,
            )

            answer = engine.get_response(
                context=context,
                recent_messages=[
                    message.model_dump()
                    for message in request.recent_messages
                ],
            )

            return {
                "status": "success",
                "answer": answer,
                "sources": context["sources"],
            }

        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        except Exception:
            raise HTTPException(
                status_code=500,
                detail="Tutor request failed.",
            )
