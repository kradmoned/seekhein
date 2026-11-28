import sqlite3

import pytest

from agent.session_store import SQLiteSessionStore


def test_session_and_pinned_lab_context_persist_across_restarts(tmp_path):
    db_path = str(tmp_path / "sessions.db")
    lab_context = {
        "title": "Loop Basics",
        "instructions": "Print every item in the list.",
        "starter_code": "def print_all(items):\n    pass",
        "tests": "assert print_all([1, 2]) == [1, 2]",
        "reference_solution": "def print_all(items):\n    return list(items)",
    }

    store1 = SQLiteSessionStore(db_path)
    pinned = store1.ensure_session("conv-1", lab_context=lab_context)
    assert pinned == lab_context

    store1.save_turn(
        conversation_id="conv-1",
        user_message="Why does it return None?",
        assistant_answer="What does `pass` do in Python?",
        sources=[],
        idempotency_key="turn-1",
    )

    # Re-open a brand new store instance to simulate process restart.
    store2 = SQLiteSessionStore(db_path)
    assert store2.ensure_session("conv-1") == lab_context
    assert store2.get_recent_messages("conv-1") == [
        {"role": "user", "content": "Why does it return None?"},
        {"role": "assistant", "content": "What does `pass` do in Python?"},
    ]


def test_sliding_window_keeps_all_messages_but_returns_recent_turns(tmp_path):
    db_path = str(tmp_path / "sessions.db")
    store = SQLiteSessionStore(db_path)
    store.ensure_session("conv-window")

    for i in range(1, 5):
        store.save_turn(
            conversation_id="conv-window",
            user_message=f"Question {i}",
            assistant_answer=f"Hint {i}",
            sources=[],
        )

    with sqlite3.connect(db_path) as conn:
        total_rows = conn.execute(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = ?",
            ("conv-window",),
        ).fetchone()[0]
    assert total_rows == 8

    recent = store.get_recent_messages("conv-window", max_turns=2)
    assert recent == [
        {"role": "user", "content": "Question 3"},
        {"role": "assistant", "content": "Hint 3"},
        {"role": "user", "content": "Question 4"},
        {"role": "assistant", "content": "Hint 4"},
    ]


def test_idempotency_deduplication(tmp_path):
    db_path = str(tmp_path / "sessions.db")
    store = SQLiteSessionStore(db_path)
    store.ensure_session("conv-idem")

    store.save_turn(
        conversation_id="conv-idem",
        user_message="Help me",
        assistant_answer="First answer",
        sources=[{"doc": "lab.pdf"}],
        idempotency_key="key-1",
    )
    # Saving again with the same key must not duplicate messages or overwrite response.
    store.save_turn(
        conversation_id="conv-idem",
        user_message="Help me",
        assistant_answer="Second answer",
        sources=[],
        idempotency_key="key-1",
    )

    cached = store.get_idempotent_response("conv-idem", "key-1")
    assert cached == {
        "answer": "First answer",
        "sources": [{"doc": "lab.pdf"}],
    }
    assert store.get_recent_messages("conv-idem") == [
        {"role": "user", "content": "Help me"},
        {"role": "assistant", "content": "First answer"},
    ]


def test_delete_session_cascades_and_is_idempotent(tmp_path):
    db_path = str(tmp_path / "sessions.db")
    store = SQLiteSessionStore(db_path)
    store.ensure_session("conv-del", lab_context={"title": "Lab 1"})
    store.save_turn(
        conversation_id="conv-del",
        user_message="Hi",
        assistant_answer="Hello",
        sources=[],
        idempotency_key="k1",
    )

    assert store.delete_session("conv-del") is True
    assert store.delete_session("conv-del") is False
    assert store.get_recent_messages("conv-del") == []
    assert store.get_idempotent_response("conv-del", "k1") is None
    assert store.ensure_session("conv-del") is None


def test_invalid_max_turns():
    store = SQLiteSessionStore(":memory:")
    with pytest.raises(ValueError):
        store.get_recent_messages("conv-1", max_turns=0)
