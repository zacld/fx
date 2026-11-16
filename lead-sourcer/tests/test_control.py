"""Where finance decisions sit (sourcer/control.py) — no network."""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import control  # noqa: E402


class TestControlClues(unittest.TestCase):
    def kinds(self, text):
        return [(c["side"], c["kind"]) for c in control.text_clues(text)]

    def test_run_from_abroad(self):
        text = ("Financial risk management. The company's treasury activities are managed centrally by the ultimate parent "
                "undertaking. The company participates in a group cash pooling arrangement. Amounts owed to the parent company "
                "are unsecured and repayable on demand. The directors have received a letter of support from the ultimate parent.")
        kinds = self.kinds(text)
        for k in ("group_treasury", "cash_pool", "owed_to_parent", "parent_support"):
            self.assertIn(("abroad", k), kinds)

    def test_decided_here(self):
        text = "During the year the company renewed its revolving credit facility with HSBC UK Bank plc for a further three years."
        self.assertEqual(self.kinds(text), [("uk", "own_rcf")])
        self.assertEqual(self.kinds("The group's revolving credit facility is held by the parent company in Germany."), [])

    def test_policy_text_and_fields(self):
        self.assertEqual(self.kinds("Accounting policies: cash pooling is defined as the netting of balances under IFRS 9."), [])
        ev = control.text_evidence("Foreign exchange risk is managed centrally by the group treasury in Paris.")
        self.assertTrue(ev["control_clues"].startswith("abroad|fx_by_group|"))
        self.assertEqual(control.text_evidence("Nothing here.")["control_clues"], "")

    def test_board(self):
        self.assertEqual(control.board_line([{"country_of_residence": "England"}, {"country_of_residence": "Netherlands"},
                                             {"country_of_residence": "United Kingdom"}, {}]), "2 of 3 directors live in the UK")
        self.assertEqual(control.board_line([]), "")


if __name__ == "__main__":
    unittest.main()
