
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class TutorRequest(BaseModel):
    conversation_id: str = Field(min_length=1, max_length=128)

    message: str = Field(min_length=1)

    recent_messages: list[ConversationMessage] = Field(
        default_factory=list
    )

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
