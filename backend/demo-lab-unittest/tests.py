import unittest

from solution import sum_positive


class TestSumPositive(unittest.TestCase):
    def test_all_positive(self):
        """Sums positive integers."""
        self.assertEqual(sum_positive([4, 7, 2]), 13)

    def test_mixed_signs(self):
        """Ignores negative integers and zero."""
        self.assertEqual(sum_positive([-5, 3, 0, 8, -2]), 11)

    def test_no_positive_numbers(self):
        """Returns zero when no integers are positive."""
        self.assertEqual(sum_positive([-8, 0, -1]), 0)

    def test_empty_list(self):
        """Handles an empty list."""
        self.assertEqual(sum_positive([]), 0)

    def test_repeated_values(self):
        """Counts repeated positive values separately."""
        self.assertEqual(sum_positive([6, 6, -6, 6]), 18)

    def test_preserves_input(self):
        """Leaves the input list unchanged."""
        numbers = [5, -2, 1, 0]
        original = numbers.copy()
        self.assertEqual(sum_positive(numbers), 6)
        self.assertEqual(numbers, original)
