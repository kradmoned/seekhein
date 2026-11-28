
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class LabContext(BaseModel):
    title: str | None = None
    instructions: str | None = None
    starter_code: str | None = Field(
        default=None,
        validation_alias=AliasChoices("starter_code", "starter"),
    )
    tests: str | None = None
    reference_solution: str | None = Field(
        default=None,
        validation_alias=AliasChoices("reference_solution", "solution"),
    )


class TutorRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=128)
    idempotency_key: str | None = Field(default=None, max_length=128)

    message: str = Field(min_length=1)

    # Legacy field kept optional for backwards compatibility; ignored by api/main.py
    # because conversation history is managed server-side in SQLite.
    recent_messages: list[ConversationMessage] = Field(
        default_factory=list
    )

    lab_context: LabContext | None = None

    current_code: str | None = None
    executed_code: str | None = None

    output_error: dict[str, Any] | None = None
    validation_feedback: dict[str, Any] | None = None

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message cannot be empty.")
        return value

    @field_validator("conversation_id")
    @classmethod
    def validate_conversation_id(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Conversation ID cannot be empty.")
        return value

    @field_validator("idempotency_key")
    @classmethod
    def validate_idempotency_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("Idempotency key cannot be empty.")
        return stripped
