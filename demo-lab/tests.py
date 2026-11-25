from solution import add


def test_positive_numbers():
    """Adds two positive numbers."""
    expect(add(2, 3), 5, inputs={"a": 2, "b": 3})


def test_negative_numbers():
    """Adds two negative numbers."""
    expect(add(-1, -2), -3, inputs={"a": -1, "b": -2})


def test_zero():
    """Handles zero."""
    expect(add(0, 0), 0, inputs={"a": 0, "b": 0})


def test_mixed_signs():
    """Adds a positive and a negative number."""
    expect(add(-4, 7), 3, inputs={"a": -4, "b": 7})