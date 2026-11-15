"""Private-equity backing and new finance directors (sourcer/pe.py, owners.pe_owner, deals.finance_appointments,
tools/ch_alerts.py's PE debt and FD adverts) — no network."""

import importlib.util
import os
import sys
import unittest
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sourcer import deals, owners, pe  # noqa: E402

_spec = importlib.util.spec_from_file_location("ch_alerts", os.path.join(ROOT, "tools", "ch_alerts.py"))
ch_alerts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ch_alerts)


class TestSponsors(unittest.TestCase):
    def test_owner_names(self):
        self.assertEqual(pe.sponsor_kind("ACME BIDCO LIMITED"), "a buyout vehicle")
        self.assertEqual(pe.sponsor_kind("ACME TOPCO 2 LIMITED"), "a buyout vehicle")
        self.assertEqual(pe.sponsor_kind("LDC (MANAGERS) LIMITED"), "a private-equity house")
        self.assertEqual(pe.sponsor_kind("INFLEXION BUYOUT FUND V LP"), "a private-equity house")
        self.assertEqual(pe.sponsor_kind("SMITH GROWTH FUND LP"), "a fund")
        # ordinary companies and words a house name is made of
        for name in ("ACME HOLDCO LIMITED", "SMITH FAMILY HOLDINGS LIMITED", "TRITON SHOWERS LIMITED", "OAKTREE FARMS LTD",
                     "APOLLO FIRE DETECTORS LIMITED", "MERCIA SAUSAGES LIMITED", ""):
            self.assertEqual(pe.sponsor_kind(name), "", name)

    def test_lenders(self):
        self.assertIn("private-credit", pe.lender_kind("PEMBERTON ASSET MANAGEMENT S.A."))
        self.assertIn("loan agency", pe.lender_kind("GLAS TRUST CORPORATION LIMITED"))
        self.assertIn("loan agency", pe.lender_kind("LUCID AGENCY SERVICES LIMITED"))
        self.assertEqual(pe.lender_kind("HSBC UK BANK PLC"), "")
        self.assertEqual(pe.lender_kind("HSBC UK BANK PLC AS SECURITY AGENT"), "")   # a bank alone: not counted
        charges = [{"name": "HSBC UK BANK PLC", "created_on": "2026-01-01", "status": "outstanding"},
                   {"name": "ARES MANAGEMENT LIMITED", "created_on": "2025-06-01", "status": "outstanding"},
                   {"name": "KROLL AGENCY SERVICES LIMITED", "created_on": "2020-01-01", "status": "fully-satisfied"}]
        self.assertEqual(pe.from_charges(charges)["name"], "ARES MANAGEMENT LIMITED")
        self.assertIsNone(pe.from_charges(charges[2:]))   # paid off: not backed now

    def test_accounts_controlling_party(self):
        self.assertEqual(pe.text_evidence("Notes. The ultimate controlling party is Inflexion Private Equity Partners LLP. "
                                          "Other.")["pe_sponsor"], "Inflexion Private Equity Partners LLP")
        found = pe.text_evidence("The company is ultimately controlled by funds managed by LDC (Managers) Limited, a "
                                 "subsidiary of Lloyds Banking Group.")
        self.assertEqual(found["pe_sponsor"], "LDC (Managers) Limited")
        self.assertIn("funds managed by", found["pe_sponsor_evidence"])
        self.assertEqual(pe.text_evidence("The ultimate controlling party is Mr J Smith, by virtue of his shareholding.")
                         ["pe_sponsor"], "")
        self.assertEqual(pe.text_evidence("The ultimate parent is Acme Holdings Limited, registered in England.")["pe_sponsor"], "")

    def test_backed_says_why(self):
        name, why = pe.backed("ACME BIDCO LIMITED")
        self.assertEqual(name, "ACME BIDCO LIMITED")
        self.assertIn("buyout vehicle", why)
        name, why = pe.backed("", [{"name": "PEMBERTON ASSET MANAGEMENT", "created_on": "2025-03-01", "status": "outstanding"}])
        self.assertIn("PEMBERTON", name)
        self.assertIn("buyout", why)
        self.assertEqual(pe.backed(""), ("", ""))

    def test_chain(self):
        # 01 ← 02 (UK holding company) ← 03 (UK) ← "ACME TOPCO S.A R.L." (Luxembourg)
        parents = {"01": [("02", "ACME HOLDINGS LIMITED", True, "England")],
                   "02": [("03", "ACME GROUP LIMITED", True, "England")],
                   "03": [("", "ACME TOPCO S.A R.L.", False, "Luxembourg")]}
        self.assertEqual(owners.pe_owner("01", parents), {"name": "ACME TOPCO S.A R.L.", "hops": 3})
        self.assertEqual(owners.pe_owner("02", {"02": [("", "SMITH FAMILY TRUST", False, "Jersey")]}), {})
        loop = {"01": [("02", "A LIMITED", True, "England")], "02": [("01", "B LIMITED", True, "England")]}
        self.assertEqual(owners.pe_owner("01", loop), {})


class TestFdInAccounts(unittest.TestCase):
    def test_title_beside_the_appointment(self):
        cols = deals.fd_columns("Directors: A Brown; J Smith - Finance Director (appointed 3 March 2026); C Green.")
        self.assertEqual(cols["new_fd_in_accounts"], "Finance director appointed 3 March 2026")

    def test_title_elsewhere_in_the_accounts(self):
        text = ("Directors: A Brown; Jane Smith (appointed 3 March 2026); C Green. ... Approved by the board and signed on "
                "its behalf by Jane Smith, Chief Financial Officer, on 12 May 2026.")
        cols = deals.fd_columns(text)
        self.assertEqual(cols["new_fd_in_accounts"], "Finance director appointed 3 March 2026")
        self.assertIn("Chief Financial Officer", cols["new_fd_in_accounts_evidence"])
        # appointed, but nowhere called a finance director
        self.assertEqual(deals.fd_columns("Directors: J Bloggs (appointed 1 June 2026) … signed by A Brown, Director")
                         ["new_fd_in_accounts"], "")


class TestAlerts(unittest.TestCase):
    TODAY = date(2026, 11, 15)

    def test_pe_debt_charge_any_company(self):
        event = {"resource_kind": "company-charges", "resource_uri": "/company/09999999/charges/abc", "resource_id": "abc",
                 "event": {"published_at": "2026-11-14T10:00:00"},
                 "data": {"persons_entitled": [{"name": "GLAS Trust Corporation Limited"}], "created_on": "2026-11-10",
                          "delivered_on": "2026-11-12", "status": "outstanding"}}
        a = ch_alerts.classify(event, {}, self.TODAY)
        self.assertEqual((a["kind"], a["hot"], a["tracked"]), ("pe_debt", True, False))
        plain = dict(event, data={**event["data"], "persons_entitled": [{"name": "Barclays Bank UK PLC"}]})
        self.assertIsNone(ch_alerts.classify(plain, {}, self.TODAY))   # an ordinary bank charge, not on the lists

    def test_fd_adverts(self):
        tracked = {"01234567": "ACME WIDGETS LIMITED"}
        adverts = [{"employer": "Acme Widgets Ltd", "title": "Finance Director", "date": "2026-11-10", "link": "u1"},
                   {"employer": "Acme Widgets", "title": "Finance Director - Manufacturing", "date": "2026-11-11", "link": "u2"},
                   {"employer": "Acme Widgets Ltd", "title": "Assistant Finance Director", "date": "2026-11-11", "link": "u3"},
                   {"employer": "Unknown Exports Ltd", "title": "Chief Financial Officer", "date": "2026-11-12", "link": "u4"},
                   {"employer": "Other Co Ltd", "title": "Treasury Analyst", "date": "2026-11-12", "link": "u5"}]
        lookup = lambda name: {"company_number": "07654321", "company_name": "UNKNOWN EXPORTS LIMITED"} if "Unknown" in name else None
        alerts, found = ch_alerts.job_signals(tracked, "", adverts, lookup=lookup)
        kinds = sorted((a["company_number"], a["kind"], a["hot"]) for a in alerts)
        self.assertEqual(kinds, [("01234567", "hiring", False), ("01234567", "hiring_fd", True), ("07654321", "hiring_fd", True)])
        self.assertEqual([r["company_number"] for r in found], ["07654321"])   # a new lead from the FD advert only

    def test_news_fd_discovers(self):
        self.assertIn("news_fd", ch_alerts.DISCOVER_FROM_NEWS)


if __name__ == "__main__":
    unittest.main()
