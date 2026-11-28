
from agent.execution_sanitizer import sanitize_validation_feedback


def test_tutor_feedback_sanitization():
    tutor_feedback = {
        "status": "ok",
        "score": 50,
        "ran": 4,
        "passed": 2,
        "failed": 2,
        "total": 4,
        "duration_ms": 14,
        "passed_tests": ["test_one", "test_two"],
        "failures": [
            {
                "index": 2,
                "name": "hidden_test",
                "display_name": "Check maximum value",
                "status": "failed",
                "passed": False,
                "inputs": [1, 2, 3],
                "expected": 3,
                "actual": 2,
                "error_type": "AssertionError",
                "error_message": "Expected 3 but received 2",
                "traceback": [
                    {
                        "line": 8,
                        "function": "find_max",
                        "code": "return nums[0]",
                    }
                ],
                "stdout": "Debug output",
            }
        ],
    }

    result = sanitize_validation_feedback(tutor_feedback)

    assert result["status"] == "ok"
    assert result["score"] == 50
    assert result["passed"] == 2
    assert len(result["failures"]) == 1

    failure = result["failures"][0]

    assert failure["display_name"] == "Check maximum value"
    assert failure["error_type"] == "AssertionError"
    assert "traceback" in failure

    # Hidden test details must not reach the AI.
    assert "inputs" not in failure
    assert "expected" not in failure
    assert "actual" not in failure
    assert "name" not in failure
    assert "index" not in failure

    # Passing test names must not reach the AI.
    assert "passed_tests" not in result

    print("Tutor feedback sanitization test passed!")


if __name__ == "__main__":
    test_tutor_feedback_sanitization()
