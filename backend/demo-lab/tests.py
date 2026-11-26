import unittest

from solution import add


class TestAdd(unittest.TestCase):
    def test_positive_numbers(self):
        """Adds two positive numbers."""
        self.assertEqual(add(2, 3), 5)

    def test_negative_numbers(self):
        """Adds two negative numbers."""
        self.assertEqual(add(-1, -2), -3)

    def test_zero(self):
        """Handles zero."""
        self.assertEqual(add(0, 0), 0)

    def test_mixed_signs(self):
        """Adds a positive and a negative number."""
        self.assertEqual(add(-4, 7), 3)
