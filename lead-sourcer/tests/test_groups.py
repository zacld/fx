import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import owners  # noqa: E402


class TestGroupActivity(unittest.TestCase):
    # Topco -> Midco -> Bidco -> two trading companies (a freight forwarder filing full accounts, a small haulier) and
    # a dormant one; the parents map as owners.tee_parents builds it: {child: [(owner number, name, UK?, country)]}
    PARENTS = {"MID": [("TOP", "TOPCO", True, "")], "BID": [("MID", "MIDCO", True, "")],
               "FWD": [("BID", "BIDCO", True, "")], "HAUL": [("BID", "BIDCO", True, "")], "DORM": [("BID", "BIDCO", True, "")],
               "TOP": [("", "SOME FUND LP", False, "Jersey")]}
    REGISTRY = {"TOP": {"status": "Active", "sic_codes": ["64209"], "name": "TOPCO"},
                "MID": {"status": "Active", "sic_codes": ["64209"], "name": "MIDCO"},
                "BID": {"status": "Active", "sic_codes": ["70100"], "name": "BIDCO"},
                "FWD": {"status": "Active", "sic_codes": ["52290"], "name": "ACME FREIGHT LIMITED", "category": "full"},
                "HAUL": {"status": "Active", "sic_codes": ["49410"], "name": "ACME ROAD LIMITED", "category": "small"},
                "DORM": {"status": "Active", "sic_codes": ["52290"], "name": "OLD CO", "category": "DORMANT"}}

    def test_reads_down_to_the_trading_companies(self):
        children = owners.children_index(self.PARENTS)
        self.assertEqual(sorted(children["BID"]), ["DORM", "FWD", "HAUL"])
        subs = owners.descendants("TOP", children)
        self.assertEqual(subs[:2], ["MID", "BID"])
        a = owners.group_activity(["64209"], subs, self.REGISTRY, {"full", "medium", "group"}, lambda codes: "Freight forwarders")
        self.assertEqual(a["sic"], ["52290", "49410"])        # the full-accounts forwarder outweighs the small haulier
        self.assertEqual(a["subs"], 2)                        # the dormant one doesn't count
        self.assertEqual(a["names"][0], "ACME FREIGHT LIMITED")
        self.assertEqual(a["niche"], "Freight forwarders")

    def test_a_trading_company_keeps_its_own_sector(self):
        self.assertIsNone(owners.group_activity(["46390"], ["FWD"], self.REGISTRY, {"full"}))

    def test_non_trading_codes(self):
        for code in ("70100", "64209", "66190", "82990", "99999"):
            self.assertTrue(owners.non_trading(code), code)
        self.assertFalse(owners.non_trading("52290"))

    def test_loops_stop(self):
        loop = {"A": [("B", "B", True, "")], "B": [("A", "A", True, "")]}
        self.assertEqual(owners.descendants("A", owners.children_index(loop)), ["B"])


if __name__ == "__main__":
    unittest.main()
