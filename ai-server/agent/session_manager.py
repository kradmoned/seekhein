
from uuid import uuid4


class SessionManager:

    def __init__(self):
        self._sessions: dict[str, list[dict[str, str]]] = {}

    def create_session(self) -> str:
        """Create a new conversation and return its ID."""

        conversation_id = str(uuid4())
        self._sessions[conversation_id] = []

        return conversation_id

    def get_history(self, conversation_id: str) -> list[dict[str, str]]:
        """Return conversation history without exposing internal storage."""

        if conversation_id not in self._sessions:
            raise KeyError("Conversation not found.")

        return [
            message.copy()
            for message in self._sessions[conversation_id]
        ]

    def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
    ) -> None:
        """Add a message to an existing conversation."""

        if conversation_id not in self._sessions:
            raise KeyError("Conversation not found.")

        if role not in {"user", "assistant"}:
            raise ValueError("Invalid message role.")

        if not isinstance(content, str) or not content.strip():
            raise ValueError("Message content cannot be empty.")

        self._sessions[conversation_id].append({
            "role": role,
            "content": content,
        })

    def reset_session(self, conversation_id: str) -> None:
        """Clear messages while keeping the conversation ID."""

        if conversation_id not in self._sessions:
            raise KeyError("Conversation not found.")

        self._sessions[conversation_id] = []

    def delete_session(self, conversation_id: str) -> None:
        """Delete a conversation."""

        if conversation_id not in self._sessions:
            raise KeyError("Conversation not found.")

        del self._sessions[conversation_id]
