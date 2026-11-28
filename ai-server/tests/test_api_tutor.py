import os

os.environ.setdefault("OPENROUTER_API_KEY", "test-key")

from fastapi.testclient import TestClient
import httpx2
from openai import APITimeoutError, RateLimitError
import pytest

import api.main as api_main
from agent.session_store import SQLiteSessionStore


class FakeEngine:
    def __init__(self, answers=None, error=None):
        self.answers = list(answers or ["What happens on the first iteration?"])
        self.error = error
        self.calls = []

    def get_response(self, context, recent_messages=None):
        self.calls.append({
            "context": context,
            "recent_messages": list(recent_messages or []),
        })
        if self.error is not None:
            raise self.error
        if len(self.answers) > 1:
            return self.answers.pop(0)
        return self.answers[0]


@pytest.fixture
def client_env(tmp_path, monkeypatch):
    db_path = str(tmp_path / "sessions.db")
    store = SQLiteSessionStore(db_path)

    api_main.get_session_store.cache_clear()
    api_main.get_engine.cache_clear()
    monkeypatch.setattr(api_main, "get_session_store", lambda: store)

    def set_engine(engine):
        monkeypatch.setattr(api_main, "get_engine", lambda: engine)

    yield TestClient(api_main.app), store, set_engine

    monkeypatch.undo()
    api_main.get_session_store.cache_clear()
    api_main.get_engine.cache_clear()


def test_lab_context_pinned_and_history_managed_server_side(client_env):
    client, _, set_engine = client_env
    engine = FakeEngine(answers=["Hint 1", "Hint 2"])
    set_engine(engine)

    # Turn 1 uses backend-style aliases `starter` and `solution` plus `tests`
    resp1 = client.post(
        "/api/v1/tutor",
        json={
            "conversation_id": "conv-1",
            "message": "Why does my function return None?",
            "lab_context": {
                "title": "Sum List",
                "instructions": "Return the sum of nums.",
                "starter": "def sum_list(nums):\n    pass",
                "tests": "assert sum_list([1, 2]) == 3",
                "solution": "def sum_list(nums):\n    return sum(nums)",
            },
            "current_code": "def sum_list(nums):\n    total = 0",
        },
    )
    assert resp1.status_code == 200
    assert resp1.json() == {
        "status": "success",
        "conversation_id": "conv-1",
        "answer": "Hint 1",
        "sources": [],
    }
    assert engine.calls[0]["recent_messages"] == []
    assert engine.calls[0]["context"]["lab_context"] == {
        "title": "Sum List",
        "instructions": "Return the sum of nums.",
        "starter_code": "def sum_list(nums):\n    pass",
        "tests": "assert sum_list([1, 2]) == 3",
        "reference_solution": "def sum_list(nums):\n    return sum(nums)",
    }

    # Turn 2 omits lab_context and sends spoofed legacy recent_messages
    resp2 = client.post(
        "/api/v1/tutor",
        json={
            "conversation_id": "conv-1",
            "message": "Oh I forgot return!",
            "recent_messages": [
                {"role": "user", "content": "Spoofed message"},
                {"role": "assistant", "content": "Spoofed reply"},
            ],
            "current_code": "def sum_list(nums):\n    return sum(nums)",
        },
    )
    assert resp2.status_code == 200
    assert resp2.json()["answer"] == "Hint 2"
    assert engine.calls[1]["context"]["lab_context"] == engine.calls[0]["context"]["lab_context"]
    assert engine.calls[1]["recent_messages"] == [
        {"role": "user", "content": "Why does my function return None?"},
        {"role": "assistant", "content": "Hint 1"},
    ]


def test_idempotency_body_and_header_deduplicate_retries(client_env):
    client, store, set_engine = client_env
    engine = FakeEngine(answers=["Cached reply", "Second reply"])
    set_engine(engine)

    payload = {
        "conversation_id": "conv-idem",
        "idempotency_key": "idem-body-1",
        "message": "First question",
    }
    first = client.post("/api/v1/tutor", json=payload)
    retry = client.post("/api/v1/tutor", json=payload)

    assert first.status_code == 200
    assert retry.status_code == 200
    assert retry.json()["answer"] == "Cached reply"
    assert len(engine.calls) == 1

    # Header-based Idempotency-Key on a second turn
    second = client.post(
        "/api/v1/tutor",
        headers={"Idempotency-Key": "idem-header-2"},
        json={
            "conversation_id": "conv-idem",
            "message": "Second question",
        },
    )
    second_retry = client.post(
        "/api/v1/tutor",
        headers={"Idempotency-Key": "idem-header-2"},
        json={
            "conversation_id": "conv-idem",
            "message": "Second question",
        },
    )
    assert second.status_code == 200
    assert second_retry.status_code == 200
    assert second.json()["answer"] == "Second reply"
    assert second_retry.json()["answer"] == "Second reply"
    assert len(engine.calls) == 2
    assert len(store.get_recent_messages("conv-idem")) == 4


def test_provider_errors_map_to_429_and_503_without_saving_turn(client_env):
    client, store, set_engine = client_env

    request = httpx2.Request("POST", "https://openrouter.ai/api/v1/chat/completions")
    rate_limit_resp = httpx2.Response(429, request=request)
    set_engine(FakeEngine(error=RateLimitError("rate limited", response=rate_limit_resp, body=None)))

    r429 = client.post(
        "/api/v1/tutor",
        json={
            "conversation_id": "conv-err",
            "idempotency_key": "err-1",
            "message": "Will fail with 429",
        },
    )
    assert r429.status_code == 429
    assert store.get_recent_messages("conv-err") == []
    assert store.get_idempotent_response("conv-err", "err-1") is None

    set_engine(FakeEngine(error=APITimeoutError(request=request)))
    r503 = client.post(
        "/api/v1/tutor",
        json={
            "conversation_id": "conv-err",
            "idempotency_key": "err-1",
            "message": "Will fail with 503",
        },
    )
    assert r503.status_code == 503
    assert store.get_recent_messages("conv-err") == []
    assert store.get_idempotent_response("conv-err", "err-1") is None


def test_delete_session_endpoint_wipes_history_and_lab_context(client_env):
    client, _, set_engine = client_env
    engine = FakeEngine(answers=["First", "After reset"])
    set_engine(engine)

    client.post(
        "/api/v1/tutor",
        json={
            "conversation_id": "conv-reset",
            "message": "Hello",
            "lab_context": {"title": "Lab X"},
        },
    )

    delete_resp = client.delete("/api/v1/sessions/conv-reset")
    assert delete_resp.status_code == 200
    assert delete_resp.json() == {
        "status": "success",
        "conversation_id": "conv-reset",
        "deleted": True,
    }

    delete_again = client.delete("/api/v1/sessions/conv-reset")
    assert delete_again.status_code == 200
    assert delete_again.json()["deleted"] is False

    after = client.post(
        "/api/v1/tutor",
        json={
            "conversation_id": "conv-reset",
            "message": "Fresh start",
        },
    )
    assert after.status_code == 200
    assert engine.calls[1]["recent_messages"] == []
    assert engine.calls[1]["context"]["lab_context"] is None
