
from typing import Any


MAX_TEXT_LENGTH = 2000
MAX_TRACEBACK_FRAMES = 10


ALLOWED_NUMERIC_FIELDS = {
    "score",
    "ran",
    "passed",
    "failed",
    "total",
    "duration_ms",
}


ALLOWED_ERROR_FIELDS = {
    "status",
    "error_type",
    "error_message",
}


ALLOWED_FAILURE_FIELDS = {
    "display_name",
    "status",
    "error_type",
    "error_message",
}


ALLOWED_SYNTAX_ERROR_FIELDS = {
    "source",
    "error_type",
    "error_message",
    "line",
    "code_line",
}


def sanitize_string(value: Any, limit: int = MAX_TEXT_LENGTH) -> str | None:
    if not isinstance(value, str):
        return None

    return value[:limit]


def sanitize_output_error(
    output_error: dict[str, Any] | None,
) -> dict[str, Any] | None:

    if output_error is None:
        return None

    if not isinstance(output_error, dict):
        raise TypeError("Output error must be a dictionary.")

    safe_error = {}

    for field in ALLOWED_ERROR_FIELDS:
        value = sanitize_string(output_error.get(field))

        if value is not None:
            safe_error[field] = value

    return safe_error


def sanitize_traceback(traceback: Any) -> list[dict[str, Any]]:
    if not isinstance(traceback, list):
        return []

    safe_frames = []

    for frame in traceback[:MAX_TRACEBACK_FRAMES]:
        if not isinstance(frame, dict):
            continue

        safe_frame = {}

        for field in ("line", "function", "code"):
            value = sanitize_string(frame.get(field), 500)

            if value is not None:
                safe_frame[field] = value

        if safe_frame:
            safe_frames.append(safe_frame)

    return safe_frames



def sanitize_failure(failure: dict[str, Any]) -> dict[str, Any]:
    safe_failure = {}

    for field in ALLOWED_FAILURE_FIELDS:
        value = sanitize_string(failure.get(field))

        if value is None:
            continue

        # Assertion messages may reveal hidden test values.
        if field == "error_message":
            error_type = failure.get("error_type")

            if error_type == "AssertionError":
                continue

        safe_failure[field] = value

    traceback = sanitize_traceback(failure.get("traceback"))

    if traceback:
        safe_failure["traceback"] = traceback

    return safe_failure



def sanitize_syntax_error(
    syntax_error: Any,
) -> dict[str, Any] | None:

    if not isinstance(syntax_error, dict):
        return None

    safe_syntax_error = {}

    for field in ALLOWED_SYNTAX_ERROR_FIELDS:
        value = syntax_error.get(field)

        if field == "line":
            if isinstance(value, int) and not isinstance(value, bool):
                safe_syntax_error[field] = value
        else:
            safe_value = sanitize_string(value)

            if safe_value is not None:
                safe_syntax_error[field] = safe_value

    return safe_syntax_error


def sanitize_validation_feedback(
    feedback: dict[str, Any] | None,
) -> dict[str, Any] | None:

    if feedback is None:
        return None

    if not isinstance(feedback, dict):
        raise TypeError("Validation feedback must be a dictionary.")

    safe_feedback = {}

    # Overall execution status.
    status = sanitize_string(feedback.get("status"), 100)

    if status is not None:
        safe_feedback["status"] = status

    # Aggregate execution results.
    for field in ALLOWED_NUMERIC_FIELDS:
        value = feedback.get(field)

        if isinstance(value, (int, float)) and not isinstance(value, bool):
            safe_feedback[field] = value

    # Individual failed tests.
    failures = feedback.get("failures")

    if isinstance(failures, list):
        safe_feedback["failures"] = [
            sanitize_failure(failure)
            for failure in failures[:20]
            if isinstance(failure, dict)
        ]

    # Syntax error information, when present.
    syntax_error = sanitize_syntax_error(
        feedback.get("syntax_error")
    )

    if syntax_error is not None:
        safe_feedback["syntax_error"] = syntax_error

    # Output produced before test execution.
    top_level_stdout = sanitize_string(
        feedback.get("top_level_stdout")
    )

    if top_level_stdout is not None:
        safe_feedback["top_level_stdout"] = top_level_stdout

    # Keep only the first line of internal diagnostics.
    internal_error = sanitize_string(
        feedback.get("internal_error"),
        1000,
    )

    if internal_error is not None:
        safe_feedback["internal_error"] = internal_error.splitlines()[0]

    return safe_feedback


def sanitize_execution_feedback(
    output_error: dict[str, Any] | None = None,
    validation_feedback: dict[str, Any] | None = None,
) -> dict[str, Any]:

    return {
        "output_error": sanitize_output_error(output_error),
        "validation_feedback": sanitize_validation_feedback(
            validation_feedback
        ),
    }
