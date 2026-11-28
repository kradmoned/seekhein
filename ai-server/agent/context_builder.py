
from agent.rag_integration import retrieve_context
from agent.execution_sanitizer import sanitize_execution_feedback



def determine_scenario(
    output_error: dict | None,
    validation_feedback: dict | None,
) -> str:

    if output_error is not None and validation_feedback is not None:
        return "combined_feedback"

    if output_error is not None:
        return "runtime_error"

    if validation_feedback is not None:
        status = validation_feedback.get("status")

        execution_error_statuses = {
            "syntax_error",
            "runtime_error",
            "timeout",
            "oom",
            "internal_error",
        }

        if status in execution_error_statuses:
            return "runtime_error"

        return "submission_feedback"

    return "coding"


def build_context(
    message: str,
    current_code: str | None = None,
    executed_code: str | None = None,
    output_error: dict | None = None,
    validation_feedback: dict | None = None,
    db_path: str | None = None,
) -> dict:

    if not isinstance(message, str) or not message.strip():
        raise ValueError("Message cannot be empty.")

    scenario = determine_scenario(
        output_error=output_error,
        validation_feedback=validation_feedback,
    )

    retrieve_kwargs = {
        "question": message,
        "lab_id": None,
        "task_id": None,
    }

    if db_path is not None:
        retrieve_kwargs["db_path"] = db_path

    rag_result = retrieve_context(**retrieve_kwargs)

    safe_execution_feedback = sanitize_execution_feedback(
        output_error=output_error,
        validation_feedback=validation_feedback,
    )

    return {
        "message": message,
        "scenario": scenario,
        "current_code": current_code,
        "executed_code": executed_code,
        "execution_feedback": safe_execution_feedback,
        "retrieved_context": rag_result["context"],
        "sources": rag_result["sources"],
    }
