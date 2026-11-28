from unittest.mock import patch

import pytest

from agent.context_builder import build_context, determine_scenario


def test_build_context():
    mock_rag_result = {
        "context": ["Relevant programming concept"],
        "sources": [{"document_name": "lab.pdf"}],
    }

    with patch(
        "agent.context_builder.retrieve_context",
        return_value=mock_rag_result,
    ) as mock_retrieve:

        result = build_context(
            message="How does a loop work?",
            current_code="for i in range(5): print(i)",
            executed_code="for i in range(5): print(i)",
        )

    mock_retrieve.assert_called_once_with(
        question="How does a loop work?",
        lab_id=None,
        task_id=None,
    )

    assert result["message"] == "How does a loop work?"
    assert result["scenario"] == "coding"
    assert result["current_code"] is not None
    assert result["executed_code"] is not None
    assert result["retrieved_context"] == mock_rag_result["context"]
    assert result["sources"] == mock_rag_result["sources"]


def test_empty_message():
    with pytest.raises(ValueError):
        build_context("")


def test_optional_fields():
    with patch(
        "agent.context_builder.retrieve_context",
        return_value={"context": [], "sources": []},
    ):
        result = build_context(message="Explain functions")

    assert result["current_code"] is None
    assert result["executed_code"] is None
    assert result["execution_feedback"] == {
        "output_error": None,
        "validation_feedback": None,
    }
    assert result["retrieved_context"] == []
    assert result["sources"] == []


def test_scenario_detection():
    assert determine_scenario(None, None) == "coding"

    assert determine_scenario(
        {"error_type": "NameError"},
        None,
    ) == "runtime_error"

    assert determine_scenario(
        None,
        {"status": "ok"},
    ) == "submission_feedback"

    assert determine_scenario(
        None,
        {"status": "syntax_error"},
    ) == "runtime_error"

    assert determine_scenario(
        {"error_type": "NameError"},
        {"status": "ok"},
    ) == "combined_feedback"