
import pytest

from agent.session_manager import SessionManager


def test_create_session():
    manager = SessionManager()

    first = manager.create_session()
    second = manager.create_session()

    assert first != second
    assert manager.get_history(first) == []
    assert manager.get_history(second) == []


def test_add_and_retrieve_messages():
    manager = SessionManager()
    conversation_id = manager.create_session()

    manager.add_message(conversation_id, "user", "Explain loops")
    manager.add_message(conversation_id, "assistant", "What does a loop repeat?")

    history = manager.get_history(conversation_id)

    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[1]["role"] == "assistant"


def test_sessions_are_independent():
    manager = SessionManager()

    first = manager.create_session()
    second = manager.create_session()

    manager.add_message(first, "user", "First conversation")

    assert len(manager.get_history(first)) == 1
    assert manager.get_history(second) == []


def test_invalid_conversation():
    manager = SessionManager()

    with pytest.raises(KeyError):
        manager.get_history("unknown-conversation")


def test_invalid_role():
    manager = SessionManager()
    conversation_id = manager.create_session()

    with pytest.raises(ValueError):
        manager.add_message(conversation_id, "system", "Invalid role")


def test_empty_message():
    manager = SessionManager()
    conversation_id = manager.create_session()

    with pytest.raises(ValueError):
        manager.add_message(conversation_id, "user", "  ")


def test_reset_session():
    manager = SessionManager()
    conversation_id = manager.create_session()

    manager.add_message(conversation_id, "user", "Hello")
    manager.reset_session(conversation_id)

    assert manager.get_history(conversation_id) == []


def test_delete_session():
    manager = SessionManager()
    conversation_id = manager.create_session()

    manager.delete_session(conversation_id)

    with pytest.raises(KeyError):
        manager.get_history(conversation_id)


def test_history_is_a_copy():
    manager = SessionManager()
    conversation_id = manager.create_session()

    manager.add_message(conversation_id, "user", "Hello")

    history = manager.get_history(conversation_id)
    history.clear()

    assert len(manager.get_history(conversation_id)) == 1
