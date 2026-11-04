"""
Real profit and loss lines from the turnover sample (tools/turnover_sample.py, run on the Accounts list's
companies without turnover, Nov 2026): what sourcer/turnover_text.py must read from each, and what not.
Accounts are public records; these lines carry no personal names.
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import accounts, pdf, turnover_text  # noqa: E402


def page(*lines: str) -> str:
    return "\n".join(lines)


class TestRealProfitAndLossPages(unittest.TestCase):
    def test_scanned_statements(self):
        cases = [
            # (company, page text as OCR gives it, turnover, prior, cost of sales, unit)
            ("EDMI EUROPE LIMITED p13", page(
                "STATEMENT OF COMPREHENSIVE INCOME", "FOR THE YEAR ENDED 31 DECEMBER 2025",
                ". Notes 2025 2024", "£'000 £'000",
                "Turnover 2 80,354 70,650", "Cost of sales 3 (71,933) (61,813) :", "Gross profit 8,421 8,837"),
             80_354_000, 70_650_000, 71_933_000, "£'000"),
            ("SMALLRIDGE BROS LIMITED p13", page(
                "PROFIT AND LOSS ACCOUNT", "Notes 2025 2024", "£ £",
                "Turnover 3 47,887,534, 37,371,869", "Cost of sales . (40,088,356) (30,460,769)",
                "Gross Profit 7,799,178 - 6,911,100"),
             47_887_534, 37_371_869, 40_088_356, "£"),
            ("DELIFRANCE (UK) LIMITED p13", page(
                "PROFIT AND LOSS ACCOUNT", "Note 30 June 2025 30 June 2024", "£000 £000",
                "Turnover 2 209,445 188,034", "Cost of sales (174,929) (158,974)", "Gross profit 34,516 29,060"),
             209_445_000, 188_034_000, 174_929_000, "£'000"),
            ("LOCH LOMOND DISTILLERS LIMITED p21", page(
                "PROFIT AND LOSS ACCOUNT", "Year ended Year ended", "December 2025 December 2024", "Note £000 £000",
                "Turnover 2 95,289 104,164", "Cost of sales (60,620) (65,854)", "Gross profit. . _ 34,669 38,310"),
             95_289_000, 104_164_000, 60_620_000, "£'000"),
            ("RENISHAW UK SALES LIMITED p12", page(
                "INCOME STATEMENT", "Note 2025 2024", "£ £",
                "Turnover 4 129,922,001 126,778,008", "Cost of sales (115,067,807) (111,979,167)",
                "Gross profit 14,854,194 14,798,841"),
             129_922_001, 126_778_008, 115_067_807, "£"),
            ("JOHN DEWAR AND SONS LIMITED p20", page(
                "PROFIT AND LOSS ACCOUNT", ", 2025 2024", "Note £000 £000",
                "Revenue 4 227,133 227,090", "Cost of sales (183,603) (182,575)", "Gross profit : 43,530 44,515"),
             227_133_000, 227_090_000, 183_603_000, "£'000"),
            ("METALWASH LIMITED p11 (a small company: found, so it leaves Core)", page(
                "PROFIT AND LOSS ACCOUNT", "2025 2024", "Notes £ £",
                "TURNOVER 3 4,765,941 6,440,370", "Cost of sales (2,388,894) (3,353,539)",
                "GROSS PROFIT 2,377,047 3,086,831"),
             4_765_941, 6_440_370, 2_388_894, "£"),
        ]
        for company, text, turnover, prior, cost, unit in cases:
            with self.subTest(company):
                r = turnover_text.read([text], ocr=True)
                self.assertEqual((r["turnover"], r["turnover_prior"], r["cost_of_sales"], r["unit"], r["check"]),
                                 (turnover, prior, cost, unit, ""))
                self.assertTrue(r["statement"])

    def test_turnover_worked_out_when_the_line_is_misread_or_missing(self):
        # ALL MARKET EUROPE p14: OCR read £53,109,419 as "$3,109,419" — cost of sales + gross profit says otherwise.
        r = turnover_text.read([page("STATEMENT OF PROFIT AND LOSS AND TOTAL COMPREHENSIVE INCOME", "2025 2024", "£ £",
                                     "Turnover (net) $3,109,419 ~~—~=~C«2,514,046.",
                                     "Cost of sales (33,223,456) (28,058,221)",
                                     "Gross profit 19,885,963 —~—«*14,455,825.")], ocr=True)
        self.assertEqual((r["turnover"], r["turnover_prior"]), (53_109_419, 42_514_046))
        self.assertIn("cost of sales + gross profit (the turnover line is unreadable)", turnover_text.describe(r))
        # ICEFRESH FOODS p12: the turnover line didn't come through OCR at all.
        r = turnover_text.read([page("PROFIT AND LOSS ACCOUNT", ". 2025 2024", "£ £",
                                     "Cost of sales (46,482,516) (39,592,807)", "Gross profit 7,110,221 5,404,870")])
        self.assertEqual(r["turnover"], 53_592_737)
        self.assertIn("not read", r["line"])

    def test_not_in_pounds_and_not_disclosed(self):
        # FEI UK p16: the accounts are in euros — reported, never converted.
        r = turnover_text.read([page("STATEMENT OF COMPREHENSIVE INCOME", ". 2025 2024", "Note €'000 €'000",
                                     "Turnover 4 63,541 55,278", "Cost of sales (49,940) (42,197)")])
        self.assertIsNone(r["turnover"])
        self.assertIn("in €", r["check"])
        # A medium-sized company's abridged profit and loss starts at gross profit.
        r = turnover_text.read([page("PROFIT AND LOSS ACCOUNT", "2025 2024", "£ £",
                                     "Gross profit 5,123,456 4,000,000", "Administrative expenses (1,000,000) (900,000)")])
        self.assertIsNone(r["turnover"])
        self.assertIn("starts at gross profit", r["check"])

    def test_group_columns_and_year_order(self):
        r = turnover_text.read([page("GROUP AND COMPANY PROFIT AND LOSS ACCOUNT",
                                     "Group Group Company Company", "2025 2024 2025 2024", "£'000 £'000 £'000 £'000",
                                     "Turnover 3 50,000 40,000 10,000 9,000")])
        self.assertEqual((r["basis"], r["turnover"], r["turnover_prior"]), ("group", 50_000_000, 40_000_000))
        r = turnover_text.read([page("CONSOLIDATED INCOME STATEMENT", "2024 2025", "£m £m", "Revenue 182.4 199.0")])
        self.assertEqual((r["basis"], r["turnover"], r["turnover_prior"]), ("group", 199_000_000, 182_400_000))
        # a statement's figure beats an earlier note's
        note = page("Turnover analysed by class of business", "2025 2024", "£ £", "Turnover 1,000,000 900,000")
        stmt = page("PROFIT AND LOSS ACCOUNT", "2025 2024", "£ £", "Turnover 3 9,000,000 8,000,000")
        self.assertEqual(turnover_text.read([note, stmt])["turnover"], 9_000_000)

    def test_strategic_report_sentences(self):
        # RENISHAW UK SALES p4 and LOCH LOMOND p4 state turnover in prose: a fallback, labelled as such.
        r = turnover_text.from_prose(["Revenue for the year ended 30 June 2025 was £129,922,001 (2024: £126,778,008). "
                                      "Revenue was £3,143,993 higher"])
        self.assertEqual((r["turnover"], r["turnover_prior"]), (129_922_001, 126_778_008))
        r = turnover_text.from_prose(["x", "Turnover for the year to 31 December 2025 was £95.3m, compared with £104.2m"])
        self.assertEqual((r["turnover"], r["turnover_prior"], r["page"]), (95_300_000, 104_200_000, 2))
        self.assertIn("strategic report", turnover_text.describe(r))
        for not_total in ("Turnover from Europe was £12m.", "Sales growth percentage 19.1 1.2",
                          "FIRST GRADE: Turnover has increased by 23.9% on 2024 as higher prices drove our revenue to over £88 million."):
            self.assertIsNone(turnover_text.from_prose([not_total]), not_total)


class TestTaggedFilings(unittest.TestCase):
    def ixbrl(self, body: str, contexts: str) -> bytes:
        return (f'<html><body><ix:header><ix:resources>{contexts}'
                '<xbrli:unit id="GBP"><xbrli:measure>iso4217:GBP</xbrli:measure></xbrli:unit>'
                f'</ix:resources></ix:header>{body}</body></html>').encode()

    def test_consolidated_figures_count_as_the_group_total(self):
        # S & A GROUP HOLDINGS: every P&L figure tagged GroupCompanyDataDimension = Consolidated.
        ctx = ('<xbrli:context id="cur"><xbrli:entity><xbrli:segment><xbrldi:explicitMember '
               'dimension="bus:GroupCompanyDataDimension">bus:Consolidated</xbrldi:explicitMember></xbrli:segment>'
               '</xbrli:entity><xbrli:period><xbrli:startDate>2025-01-01</xbrli:startDate><xbrli:endDate>2025-12-31'
               '</xbrli:endDate></xbrli:period></xbrli:context>'
               '<xbrli:context id="co"><xbrli:entity><xbrli:segment><xbrldi:explicitMember '
               'dimension="bus:GroupCompanyDataDimension">bus:Company</xbrldi:explicitMember></xbrli:segment>'
               '</xbrli:entity><xbrli:period><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>'
               '<xbrli:context id="eu"><xbrli:entity><xbrli:segment><xbrldi:explicitMember '
               'dimension="core:GeographicalAreasDimension">core:Europe</xbrldi:explicitMember></xbrli:segment>'
               '</xbrli:entity><xbrli:period><xbrli:endDate>2025-12-31</xbrli:endDate></xbrli:period></xbrli:context>')
        body = ('<ix:nonFraction name="core:TurnoverRevenue" contextRef="eu" unitRef="GBP" decimals="0">9,000,000</ix:nonFraction>'
                '<ix:nonFraction name="core:TurnoverRevenue" contextRef="co" unitRef="GBP" decimals="0">1,000,000</ix:nonFraction>'
                '<ix:nonFraction name="core:TurnoverRevenue" contextRef="cur" unitRef="GBP" decimals="0">131,000,000</ix:nonFraction>'
                '<ix:nonFraction name="core:CostSales" contextRef="cur" unitRef="GBP" decimals="0">108,015,420</ix:nonFraction>')
        f = accounts.extract_facts(self.ixbrl(body, ctx))
        self.assertEqual((f["turnover"], f["cost_of_sales"], f["turnover_basis"]), (131_000_000, 108_015_420, "group"))
        self.assertIn("consolidated", f["turnover_source"])

    def test_untagged_turnover_read_from_its_table_row(self):
        # KLIPSPRINGER / WERA TOOLS: cost of sales tagged, the turnover row not — read the row itself.
        ctx = ('<xbrli:context id="cur"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:endDate>2025-12-31'
               '</xbrli:endDate></xbrli:period></xbrli:context>')
        body = ('<p>PROFIT AND LOSS ACCOUNT</p><table><tr><td></td><td>Note</td><td>2025</td><td>2024</td></tr>'
                '<tr><td></td><td></td><td>£</td><td>£</td></tr>'
                '<tr><td>Turnover</td><td>3</td><td>16,070,512</td><td>16,170,880</td></tr>'
                '<tr><td>Cost of sales</td><td></td><td>(<ix:nonFraction name="core:CostSales" contextRef="cur" '
                'unitRef="GBP" decimals="0">10,283,203</ix:nonFraction>)</td><td>(11,309,737)</td></tr></table>')
        f = accounts.extract_facts(self.ixbrl(body, ctx))
        self.assertEqual((f["turnover"], f["turnover_prior"], f["cost_of_sales"]), (16_070_512, 16_170_880, 10_283_203))
        self.assertTrue(f["turnover_source"].startswith("accounts: company profit and loss account, £"))
        self.assertEqual(f["turnover_page"], 0)

    def test_untagged_rows_in_block_layouts_and_kpis_skipped(self):
        ctx = ('<xbrli:context id="C"><xbrli:entity></xbrli:entity><xbrli:period><xbrli:endDate>2025-12-31'
               '</xbrli:endDate></xbrli:period></xbrli:context>')
        kpi = ('<div>Strategic report</div><table><tr><td>Turnover: £42.2 million (2025: £36.5million)</td></tr></table>'
               '<table><tr><td>Turnover</td><td>11,984</td><td>16,540</td><td>(28)%</td></tr></table>')
        cases = [
            # NATOORA: one <div> per cell, only distribution costs tagged; a KPI table and line come first (WOODS).
            ("NATOORA", kpi + '<div>Profit and loss account</div><div>For the year ended 31 December 2025</div>'
             '<div>Note</div><div>2025</div><div>2024</div><div>£</div><div>£</div><div>Turnover</div><div>3</div>'
             '<div>43,423,259</div><div>42,553,761</div><div>Cost of sales</div><div>(30,676,427)</div>'
             '<div>(30,126,972)</div><div/><div/><div>Gross profit</div><div>12,746,832</div><div>12,426,789</div>',
             43_423_259, 42_553_761, "company"),
            # INTERFISH: consolidated, <td><span> cells, £'000 in a separate table.
            ("INTERFISH", '<p>CONSOLIDATED PROFIT AND LOSS ACCOUNT</p><table><tr><td></td><td>Note</td><td>2025</td>'
             "<td></td><td>2024</td></tr><tr><td></td><td></td><td>£'000</td><td/><td>£'000</td></tr></table><table>"
             '<tr><td><span>TURNOVER</span></td> <td><span>3</span></td> <td><span>139,535</span></td> <td/> '
             '<td><span>109,392</span></td> <td/> <td/> </tr></table>', 139_535_000, 109_392_000, "group"),
            # ASKO FOODS: <td><div><p><span> cells with the £ in each.
            ("ASKO FOODS", '<p>Statement of comprehensive income</p><table><tr><td><div><p><span>2025</span></p></div>'
             '</td><td><div><p><span>2024</span></p></div></td></tr><tr><td><div><p><span>Turnover</span></p></div></td>'
             '<td><div><p><span> £37,284,099 </span></p></div></td><td><div><p><span> £28,985,269 </span></p></div>'
             '</td></tr></table>', 37_284_099, 28_985_269, "company"),
        ]
        for company, body, turnover, prior, basis in cases:
            with self.subTest(company):
                f = accounts.extract_facts(self.ixbrl(body, ctx))
                self.assertEqual((f["turnover"], f["turnover_prior"], f["turnover_basis"], f["turnover_check"]),
                                 (turnover, prior, basis, ""))
                self.assertIn("profit and loss account", f["turnover_source"])


class TestRereadingAndOcrOrder(unittest.TestCase):
    def test_pages_tried_for_the_profit_and_loss(self):
        # p21 of 43 (Loch Lomond), p13 of 29 (EDMI): tried within the first few, nearest 44% first
        self.assertEqual(pdf.pl_pages_order(43, 6)[:5], [19, 18, 20, 17, 21])
        self.assertIn(13, pdf.pl_pages_order(29, 6)[:3])
        self.assertEqual(pdf.pl_pages_order(5, 6), [])

    def test_currency_notes_pages_and_reuse(self):
        # the notes near the end first (62-97% through), then the strategic report (12-40%), at most 8 pages
        self.assertEqual(pdf.notes_pages_order(20, 6), [12, 13, 14, 15, 16, 17, 18, 19])
        self.assertEqual(pdf.notes_pages_order(10, 6)[:4], [7, 8, 9, 10])
        ran = []
        seen = {13: "At the year end the company had forward foreign exchange contracts to buy US$2m."}
        with mock.patch.object(pdf, "ocr_available", lambda: True), mock.patch.object(pdf, "_page_count", lambda p: 20), \
                mock.patch.object(pdf, "_run", lambda args: ran.append(args[0]) or ""), \
                mock.patch.dict(pdf.stats, {"notes_seconds": 0.0, "notes_pages": 0}):
            text, number = pdf.ocr_find(b"%PDF", lambda t: "forward" in t, purpose="notes", seen=seen)
            self.assertEqual(pdf.stats["notes_pages"], 1)          # page 12 OCR'd; 13 reused, not read again
        self.assertEqual((number, text), (13, seen[13]))
        self.assertEqual(ran, ["pdftoppm"])

    def test_a_lost_thousands_heading_is_put_right_by_the_strategic_report(self):
        # Nisbets (scanned, Nov 2026): OCR lost the profit and loss page's £'000 heading; the strategic report says £355m
        report = ("Strategic report\nSales in 2025 totalled £355m, a total increase of £9.5m (2.8%) compared with 2024 "
                  "and gross profit increased by £4.5m to £122.8m\n")
        pl = ("Profit and loss account for the year ended 31 December 2025\n"
              "                                  Note        2025        2024\n"
              "Turnover                            5     354,989     345,495\n"
              "Cost of sales                            (232,195)   (227,186)\n"
              "Gross profit                              122,794     118,309\n")
        reading = turnover_text.read([report, pl])
        self.assertEqual((reading["turnover"], reading["turnover_prior"], reading["unit"]),
                         (354_989_000, 345_495_000, "£'000"))
        # …or by its KPI table in £m (what corrected the real filing)
        kpi = "Key performance indicators\n                 £m       £m\n                 2025     2024\nTurnover        355.0    345.5\n"
        self.assertEqual(turnover_text.read([kpi, pl])["turnover"], 354_989_000)
        self.assertIn("the accounts state turnover as £355.0m elsewhere", reading["line"])
        # without anything stating the turnover elsewhere, it isn't guessed (check_turnover then flags it)
        self.assertEqual(turnover_text.read([pl])["turnover"], 354_989)
        # a page whose columns say "£ £" is in pounds, whatever else is said
        in_pounds = pl.replace("Note        2025        2024", "Note        2025        2024\n"
                                                                "                                                £           £")
        self.assertEqual(turnover_text.read([report, in_pounds])["turnover"], 354_989)

    def test_implausible_turnover_is_a_check_not_a_figure(self):
        # Nisbets' group accounts read as £354k; Caribbean Trading Group's as £0 (FX notes sample, Nov 2026)
        nisbets = accounts.check_turnover({"turnover": 354_000.0, "turnover_prior": 340_000.0, "accounts_type": "group"})
        self.assertIsNone(nisbets["turnover"])
        self.assertIn("£354k from group accounts: too small to be right", nisbets["turnover_check"])
        self.assertIsNone(accounts.check_turnover({"turnover": 0.0, "accounts_type": ""})["turnover"])
        # small accounts can be small; full accounts of £1m+ are kept
        self.assertEqual(accounts.check_turnover({"turnover": 354_000.0, "accounts_type": "small"})["turnover"], 354_000)
        self.assertEqual(accounts.check_turnover({"turnover": 5_800_000.0, "accounts_type": "full"})["turnover"], 5_800_000)

    def test_which_cached_accounts_are_read_again(self):
        current = accounts.FACTS_VERSION
        self.assertTrue(accounts.facts_reusable({"facts_version": current, "facts": {"turnover": None}}))
        # the run's OCR time ran out before the profit and loss page was searched: try again
        self.assertFalse(accounts.facts_reusable({"facts_version": current,
                                                  "facts": {"turnover_check": accounts.TURNOVER_NOT_READ_YET}}))
        # read before the currency notes were: every company's accounts again (capped a run by main.py)
        self.assertFalse(accounts.facts_reusable({"facts_version": "2026-11-04", "facts": {"turnover": 5e7}}))
        self.assertFalse(accounts.facts_reusable({"facts_version": "2026-10-26b", "facts": {"turnover": None}}))


if __name__ == "__main__":
    unittest.main()
