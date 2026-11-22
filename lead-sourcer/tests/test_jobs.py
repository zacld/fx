import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))

from sourcer import jobs  # noqa: E402
import ch_alerts  # noqa: E402


class TestReadAdvert(unittest.TestCase):
    def test_reads_currencies_countries_terms(self):
        r = jobs.read_advert({"title": "Purchase Ledger Clerk", "text": "<p>You will pay our suppliers in China and Germany "
                              "in USD and EUR.</p> Prepare letters of credit and check Incoterms. Our office is in Leeds."})
        self.assertEqual(r["kind"], "currency")
        self.assertEqual(r["currencies"], ["EUR", "USD"])
        self.assertEqual(r["countries"], ["China", "Germany"])
        self.assertEqual(r["terms"], ["letters of credit", "Incoterms"])
        self.assertGreaterEqual(r["score"], 60)

    def test_countries_only_beside_trade_words(self):
        r = jobs.read_advert({"title": "Accountant", "text": "Our founder grew up in Spain. Great benefits."})
        self.assertEqual(r["countries"], [])
        self.assertEqual(r["score"], 0)

    def test_kinds(self):
        self.assertEqual(jobs.read_advert({"title": "Finance Director", "text": ""})["kind"], "fd")
        self.assertFalse(jobs.read_advert({"title": "Interim Finance Director", "text": ""})["fd"])
        self.assertEqual(jobs.read_advert({"title": "Treasury Analyst", "text": ""})["kind"], "treasury")
        self.assertEqual(jobs.read_advert({"title": "Export Coordinator", "text": "Book freight."})["kind"], "trade")
        self.assertEqual(jobs.read_advert({"title": "Payroll Officer", "text": "Run international payroll for our Polish team."})["kind"], "abroad")
        # gardening isn't hedging
        self.assertEqual(jobs.read_advert({"title": "Gardener", "text": "Hedge trimming and lawn care."})["terms"], [])

    def test_agency_adverts_left_out(self):
        self.assertTrue(jobs.agency_advert({"employer": "Smith Associates", "text": "Our client, a leading importer, seeks…"}))
        self.assertTrue(jobs.agency_advert({"employer": "Pin Point Recruitment Ltd", "text": "Accounts role"}))
        self.assertFalse(jobs.agency_advert({"employer": "Acme Foods Ltd", "text": "We import olive oil from Italy."}))


class TestEmployers(unittest.TestCase):
    ADS = [{"employer": "Acme Foods Ltd", "title": "Purchase Ledger Clerk", "date": "2026-11-18", "link": "a",
            "text": "Pay our growers in Italy in EUR."},
           {"employer": "ACME FOODS LIMITED", "title": "Accounts Assistant", "date": "2026-11-19", "link": "b",
            "text": "Run multi-currency bank reconciliations."},
           {"employer": "Acme Foods Ltd", "title": "Purchase Ledger Clerk", "date": "2026-11-18", "link": "a2",
            "text": "Pay our growers in Italy in EUR."},   # the same role on another board
           {"employer": "Agency X", "title": "Clerk", "date": "2026-11-18", "link": "c", "agency": True, "text": ""}]

    def test_one_per_employer_repeat_adds(self):
        by = jobs.employers(self.ADS)
        self.assertEqual(list(by), ["ACME FOODS"])
        e = by["ACME FOODS"]
        self.assertEqual(len(e["adverts"]), 2)
        self.assertEqual(e["score"], e["adverts"][0]["score"] + jobs.ADVERT_POINTS["repeat"])
        self.assertEqual(e["currencies"], ["EUR"])
        self.assertEqual(e["last_seen"], "2026-11-19")

    def test_pick_company(self):
        items = [{"title": "ACME FOODS (HOLDINGS) LIMITED", "company_number": "1", "company_status": "active"},
                 {"title": "ACME FOODS LIMITED", "company_number": "2", "company_status": "dissolved"},
                 {"title": "ACME FOODS GROUP LIMITED", "company_number": "3", "company_status": "active"}]
        self.assertIsNone(jobs.pick_company("Acme Foods", items))          # two active with the same core: unmatched
        self.assertEqual(jobs.pick_company("Acme Foods", items[1:])["company_number"], "3")
        self.assertEqual(jobs.pick_company("Acme Foods Group Ltd", items)["match"], "exact")

    def test_merge_keeps_first_seen_and_drops_old(self):
        prev = {"employers": [{"key": "OLD CO", "employer": "Old Co", "adverts": [], "last_seen": "2026-08-01", "score": 90},
                              {"key": "ACME FOODS", "employer": "Acme Foods Ltd", "first_seen": "2026-11-01", "score": 30,
                               "adverts": [{"title": "Export Clerk", "date": "2026-11-01"}]}]}
        out = jobs.merge(prev, jobs.employers(self.ADS), date(2026, 11, 22))
        self.assertNotIn("OLD CO", out)
        self.assertEqual(out["ACME FOODS"]["first_seen"], "2026-11-01")
        self.assertIn("Export Clerk", [a["title"] for a in out["ACME FOODS"]["adverts"]])


class TestJobSignals(unittest.TestCase):
    def test_lookups_cached_and_statuses(self):
        ads = [{"employer": "Brightbloom Flowers Ltd", "title": "Accounts Assistant", "date": "2026-11-18", "link": "j1",
                "text": "Pay growers in the Netherlands in EUR and USD."},
               {"employer": "Plain Co Ltd", "title": "Office Manager", "date": "2026-11-18", "link": "j2", "text": "Run the office."},
               {"employer": "Nowhere Ltd", "title": "Treasury Analyst", "date": "2026-11-18", "link": "j3",
                "text": "Manage FX hedging policy and forward contracts."}]
        looked = []

        def lookup(name):
            looked.append(name)
            return {"company_number": "07654321", "company_name": "BRIGHTBLOOM FLOWERS LTD"} if "Brightbloom" in name else None

        cache, out = {}, {}
        alerts, found = ch_alerts.job_signals({}, "", ads, lookup=lookup, cache=cache, employers_out=out, today=date(2026, 11, 22))
        self.assertEqual(sorted(looked), ["Brightbloom Flowers Ltd", "Nowhere Ltd"])
        self.assertEqual({k: v["status"] for k, v in out.items()},
                         {"BRIGHTBLOOM FLOWERS": "new_lead", "PLAIN": "not_looked_up", "NOWHERE": "not_found"})
        self.assertEqual(found[0]["currencies_in_adverts"], "EUR, USD")
        # the next run uses the cache: no search for either
        looked.clear()
        ch_alerts.job_signals({}, "", ads, lookup=lookup, cache=cache, today=date(2026, 11, 23))
        self.assertEqual(looked, [])
        # a "not found" is tried again after LOOKUP_DAYS
        ch_alerts.job_signals({}, "", ads, lookup=lookup, cache=cache, today=date(2026, 12, 30))
        self.assertEqual(looked, ["Nowhere Ltd"])

    def test_agencies_consultancies_and_payment_firms_left_out(self):
        # the first live run (22 Nov 2026): recruiters, a job board, an FX payments firm and a consultancy came through
        ad = lambda emp, title="Accounts Assistant": {"employer": emp, "title": title, "date": "2026-11-20", "link": emp,
                                                      "text": "Process multi-currency payments in EUR and USD."}
        ads = [ad("Morgan McKinley"), ad("IFX Payments"), ad("Lane Clark & Peacock LLP"), ad("Acme Foods Ltd"),
               ad("Smith Personnel Ltd")]
        companies = {"Morgan McKinley": ("01111111", ["78109"]), "IFX Payments": ("02222222", ["64999"]),
                     "Lane Clark & Peacock LLP": ("03333333", ["70229"]), "Acme Foods Ltd": ("04444444", ["46390"])}
        lookup = lambda name: {"company_number": companies[name][0], "company_name": name.upper()} if name in companies else None
        sic = {v[0]: v[1] for v in companies.values()}
        out = {}
        _, found = ch_alerts.job_signals({}, "", ads, lookup=lookup, employers_out=out, today=date(2026, 11, 22),
                                         profile=lambda n: {"sic_codes": sic[n], "company_status": "active"})
        self.assertEqual([r["company_number"] for r in found], ["04444444"])
        why = {k: v.get("excluded", "") for k, v in out.items()}
        self.assertIn("recruitment agency", why["MORGAN MCKINLEY"])
        self.assertIn("payments / FX firm", why["IFX PAYMENTS"])
        self.assertIn("consult", why["LANE CLARK AND PEACOCK"])
        self.assertIn("by its name", why["SMITH PERSONNEL"])               # no search spent on it
        # an employer advertising many kinds of finance role at once is an agency whatever its name
        # the second live run: brand names matched namesakes (an advert by "Citi" -> CITIGROUP LIMITED, a builder)
        self.assertIn("namesake", jobs.excluded({"employer": "Citi Ltd"}, "SOME BUILDER LIMITED", ["41202"], accounts="micro-entity"))
        self.assertIn("namesake", jobs.excluded({"employer": "Staffline"}, "STAFFLINE LIMITED", ["99999"]))
        self.assertIn("payments / FX firm", jobs.excluded({"employer": "IFX Payments"}, "IFX PAYMENTS LIMITED", ["74990", "62020"]))
        self.assertIn("staffing", jobs.excluded({"employer": "Sail"}, "SAILGLOBAL TECHNOLOGY LIMITED", ["62020", "78300"]))
        # the third live run's stragglers: a fund manager, a housebuilder, a housing society
        self.assertIn("financial services", jobs.excluded({"employer": "ICG"}, "ICG PLC", ["64999"]))
        self.assertIn("property", jobs.excluded({"employer": "Vistry"}, "VISTRY HOMES LIMITED", ["68100"]))
        self.assertIn("public body", jobs.excluded({"employer": "Albyn Housing Society"}, "ALBYN HOUSING SOCIETY LIMITED", None))
        self.assertEqual(jobs.excluded({"employer": "Acme Holdings"}, "ACME HOLDINGS LIMITED", ["64209"]), "")   # a holdco stays
        self.assertIn("bank or financial group", jobs.excluded({"employer": "Citi"}, "CITIGROUP LIMITED", ["64209"]))
        self.assertEqual(jobs.excluded({"employer": "Chasewater Foods"}, "CHASEWATER FOODS LIMITED", ["10890"]), "")
        spread = {"employer": "Quiet Co", "kinds": ["fd", "currency", "trade", "treasury"], "adverts": [{}] * 4}
        self.assertIn("probably an agency", jobs.excluded(spread))

    def test_small_accounts_are_checked_by_hand_and_payroll_wording_alone_is_no_lead(self):
        ads = [{"employer": "Raytec Ltd", "title": "Accounts Assistant", "date": "2026-11-20", "link": "a",
                "text": "Process multi-currency payments in USD."},
               {"employer": "Tiny Widgets Ltd", "title": "Purchase Ledger", "date": "2026-11-20", "link": "b",
                "text": "Pay suppliers in EUR and USD from Germany."},
               {"employer": "Payroll Hub Ltd", "title": "Payroll Officer", "date": "2026-11-20", "link": "c",
                "text": "Run international payroll."}]
        numbers = {"Raytec Ltd": "1", "Tiny Widgets Ltd": "2", "Payroll Hub Ltd": "3"}
        accounts = {"1": "full", "2": "small", "3": "full"}
        out = {}
        _, found = ch_alerts.job_signals({}, "", ads, employers_out=out, today=date(2026, 11, 22),
                                         lookup=lambda n: {"company_number": numbers[n], "company_name": n.upper()},
                                         profile=lambda n: {"sic_codes": ["27900"], "company_status": "active",
                                                            "accounts": {"last_accounts": {"type": accounts[n]}}})
        self.assertEqual([r["company_number"] for r in found], ["1"])
        self.assertEqual(out["TINY WIDGETS"]["status"], "matched")
        self.assertIn("small accounts", out["TINY WIDGETS"]["note"])
        self.assertEqual(out["PAYROLL HUB"]["status"], "matched")

    def test_fetch_paces_and_counts(self):
        calls, slept = [], []
        payload = {"results": [{"employerName": "Acme Ltd", "jobTitle": "Export Clerk", "date": "18/11/2026", "jobId": 5,
                                "jobUrl": "u", "jobDescription": "short"}]}
        stats = {}
        ads = jobs.fetch_adverts(lambda url, user: calls.append(url) or payload, reed="k", sleep=slept.append,
                                 queries=[("export coordinator", "trade", 1), ("EUR USD payments", "currency", 2)], stats=stats)
        self.assertEqual(len(calls), 3)
        self.assertIn("postedByDirectEmployer=true", calls[0])
        self.assertNotIn("postedByDirectEmployer", calls[1])
        self.assertEqual(len(slept), 2)
        self.assertEqual(stats["export coordinator"]["kept"], 1)
        n = jobs.read_full_reed(ads, lambda url, user: {"jobDescription": "Pay suppliers in EUR."}, "k", sleep=lambda s: None)
        self.assertEqual(n, 1)                      # one per employer and title
        self.assertTrue(jobs.fx_wording(ads[0]))


if __name__ == "__main__":
    unittest.main()
