import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import moves  # noqa: E402


def ecb_xml(days):
    """A file shaped like the ECB's eurofxref-hist-90d.xml."""
    cubes = "".join(f'<Cube time="{d}">' + "".join(f'<Cube currency="{c}" rate="{r}"/>' for c, r in rates.items())
                    + "</Cube>" for d, rates in days.items())
    return ('<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" '
            'xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>Reference rates</gesmes:subject>'
            f"<Cube>{cubes}</Cube></gesmes:Envelope>")


DAYS = {
    "2026-07-23": {"USD": 1.10, "GBP": 0.85},   # £1 = €1.1765, $1.2941
    "2026-09-21": {"USD": 1.10, "GBP": 0.86},
    "2026-10-14": {"USD": 1.10, "GBP": 0.87},
    "2026-10-20": {"USD": 1.10, "GBP": 0.87},
    "2026-10-21": {"USD": 1.12, "GBP": 0.88},   # £1 = €1.1364, $1.2727
}


class TestMoves(unittest.TestCase):
    def test_gbp_crosses_changes_and_impact(self):
        doc = moves.moves(moves.gbp_rates(moves.parse(ecb_xml(DAYS))), ["EUR", "USD"])
        self.assertEqual(doc["as_of"], "2026-10-21")
        eur = next(c for c in doc["currencies"] if c["code"] == "EUR")
        self.assertAlmostEqual(eur["rate"], 1 / 0.88, places=4)
        self.assertEqual(eur["changes"]["1d"], round((0.87 / 0.88 - 1) * 100, 2))     # the pound fell against the euro
        self.assertEqual(eur["since"]["1m"], "2026-09-21")
        self.assertEqual(eur["since"]["3m"], "2026-07-23")
        # €1m now costs £880,000 against £860,000 a month ago: £20,000 more
        self.assertEqual(eur["impact_per_million"]["1m"], 20_000)
        self.assertEqual(eur["material"], ["1m", "3m"])                                  # -2.3% and -3.4%
        usd = next(c for c in doc["currencies"] if c["code"] == "USD")
        self.assertEqual(usd["material"], [])                                            # within thresholds
        self.assertEqual(doc["currencies"][0]["code"], "EUR")                            # biggest mover first
        self.assertEqual(len(eur["history"]), 5)

    def test_rules_are_tunable_and_empty_input_fails(self):
        by_day = moves.gbp_rates(moves.parse(ecb_xml(DAYS)))
        old = dict(moves.MOVE_RULES)
        try:
            moves.MOVE_RULES.update({"1m": 5.0, "3m": 5.0})
            self.assertEqual(moves.moves(by_day, ["EUR"])["currencies"][0]["material"], [])
        finally:
            moves.MOVE_RULES.clear()
            moves.MOVE_RULES.update(old)
        with self.assertRaises(ValueError):
            moves.moves({})


if __name__ == "__main__":
    unittest.main()
