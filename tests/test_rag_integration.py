
from unittest.mock import patch

import pytest

from agent.rag_integration import retrieve_context


def test_retrieve_context():

    mock_result = {
        "context": ["Retrieved programming concept."],
        "sources": [{"document_name": "example.pdf"}],
    }

    with patch(
        "agent.rag_integration.retrieve",
        return_value=mock_result,
    ) as mock_retrieve:

        result = retrieve_context(
            question="Explain this concept",
            lab_id="dynamic_lab",
            task_id="dynamic_task",
        )

    assert result == mock_result

    mock_retrieve.assert_called_once_with(
        question="Explain this concept",
        lab_id="dynamic_lab",
        task_id="dynamic_task",
        top_k=3,
    )


def test_empty_question():

    with pytest.raises(ValueError):
        retrieve_context(" ")
