"""
The FX case-study library: how real filings show their foreign-exchange
gain/loss, one test per filing (tools/fx_case_study.py, run 26 Oct 2026 on
46 companies from the list). Lines are copied from the public accounts.
Values: + gain / - loss in £.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import accounts, fx_text, pdf  # noqa: E402

CHARGING = "4 Operating profit 2025 2024 £ £ Operating profit for the year is stated after charging/(crediting): "

# (company number, filing, text as it reaches the reader, (this year, last year) or None, check expected)
CASES = [
    # Wanis Ltd, y/e 30 Jun 2025, iXBRL: the tag sits on "Stocks recognised as expenses"; the real line is untagged.
    ("00795535", "Wanis: untagged real line",
     "The operating profit is stated after charging: 2025 2024 £ £ Amortisation in intangible fixed assets 16,046 "
     "23,949 Stocks recognised as expenses 113,049,604 100,459,883 Exchange differences 150,529 41,380 Other "
     "operating lease rentals 3,396,282 3,248,898", (-150_529, -41_380), ""),
    # iXBRL filings with the line untagged
    ("03005254", "losses/(gains), group",
     CHARGING + "Exchange losses/(gains) 52,195 (25,479) Fees payable to the group's auditor", (-52_195, 25_479), ""),
    ("01620340", "losses/(gains)",
     CHARGING.replace("2025 2024", "2026 2025") + "Exchange losses/(gains) 24,583 (25,056) Depreciation of tangible "
     "fixed assets 789,209 909,161", (-24_583, 25_056), ""),
    ("02512025", "losses only",
     "4 Operating profit 2025 2024 £ £ Operating profit for the year is stated after charging: Exchange losses 1,331 "
     "9,975 Fees payable to the group's auditor", (-1_331, -9_975), ""),
    ("02430421", "differences, bracketed in a charging note = credit",
     "Operating profit is stated after charging: £ £ Loss on disposal of fixed assets 342 - Computer software "
     "amortisation 1,883 1,882 Auditors' remuneration 11,550 10,500 Foreign exchange differences (424,193 ) "
     "(266,226 ) Operating leases - land and buildings - 18,750", (424_193, 266_226), ""),
    ("00782674", "differences, charged",
     "stated after charging: 2024 2023 £ Depreciation - owned assets 587,177 598,593 (Profit)/loss on disposal of "
     "fixed assets 1,033 (4,376 ) Foreign exchange differences 2,609 2,609 Auditors' remuneration - audit services "
     "9,600 8,700", (-2_609, -2_609), ""),
    ("NI057478", "profit/loss on exchange in an expenses list",
     "Operating profit is stated after charging: £ £ Consultancy fees 39,743 318 Invoice discounting and bank "
     "charges 230,932 214,618 Profit/loss on exchange (30,792) 26,433 Audit fees 15,000 12,645", (30_792, -26_433), ""),
    # Scanned PDFs (OCR text of the page holding the operating-profit note)
    ("07461227", "OCR p22", "Operating profit is stated after charging/(crediting):\n£ £\n"
     "Exchange differences (11,677) (35,851)", (11_677, 35_851), ""),
    ("01408420", "OCR p24", "The operating profit is stated after charging:\n£ £\n"
     "Exchange differences (62,022) (99,844)", (62_022, 99_844), ""),
    ("04902094", "OCR p22", "The operating profit is stated after charging:\n£ £\n"
     "Exchange differences 53,385 78,936 :", (-53_385, -78_936), ""),
    ("02738190", "OCR p24, OCR debris between columns", "£ £\n"
     "7 . Net foreign exchange losses/(gains) 159,801 ° (63,417) :", (-159_801, 63_417), ""),
    ("04307559", "OCR p27, £'000", "2025 2024\n£'000 £'000\nForeign exchange loss 109 722", (-109_000, -722_000), ""),
    ("00822749", "OCR p20, gains bracketed in a charging note", "after charging/(crediting):\n£ £\n"
     "Exchange gains (4,365) (8,093)", (4_365, 8_093), ""),
    ("04934963", "OCR p26, comma debris", "stated after charging:\n£ £\nExchange differences , 78,704 204,649",
     (-78_704, -204_649), ""),
    ("12467589", "OCR p25", "stated after charging/(crediting):\n£ £\nForeign exchange differences (105,529) 66,700",
     (105_529, -66_700), ""),
    # Not the P&L line
    ("12467589", "translation reserve", "Foreign currency translation reserve 100,190 116,065", None, ""),
    ("09914960", "hedging and cash-pooling lines", "£'000 £'000\nFair value gains on exchange rate futures fair value "
     "hedges 564 -\nExchange rate gains on group cash-pooling balances 689 142", None, ""),
    ("02035315", "policy text only", "On consolidation, exchange differences arising on the translation are "
     "recognised in equity.", None, ""),
    # Checks, not facts
    ("SC302951", "figures in US dollars", "Operating profit for the year is stated after charging/(crediting): "
     "$'000 $'000 Exchange differences 1,262 ( 1,123 )", None, "is in $"),
    ("------", "no heading: direction not stated", "Notes 2025 2024 £ £ Exchange differences 12,000 9,000", None,
     "doesn't say gain or loss"),
]


class TestFxCases(unittest.TestCase):
    def test_cases(self):
        for number, what, text, expected, check in CASES:
            with self.subTest(company=number, case=what):
                got = fx_text.read(text)
                if expected is None and not check:
                    self.assertIsNone(got)
                    continue
                self.assertIsNotNone(got)
                if check:
                    self.assertIn(check, got["check"])
                    self.assertIsNone(got["value"]) if "gain or loss" in check else None
                else:
                    self.assertEqual(got["check"], "")
                    self.assertEqual((got["value"], got["prior"]), expected)

    def test_tag_on_the_wrong_line(self):
        # Wanis: the FX tag's row is "Stocks recognised as expenses"
        self.assertFalse(fx_text.label_is_fx("Amortisation in intangible fixed assets 16,046 23,949 Stocks recognised "
                                             "as expenses "))
        self.assertTrue(fx_text.label_is_fx('">£ £ Exchange losses/(gains) '))
        self.assertTrue(fx_text.label_is_fx("Exchange losses/(gains) 89,740 ( "))   # last year's column
        self.assertTrue(fx_text.label_is_fx("Differences on foreign exchange ( "))

    def test_dollar_heading_on_a_gbp_tag(self):
        # Weston Importers (SC302951): tagged GBP, table headed $'000
        self.assertEqual(fx_text.foreign_heading("2025 2024 $'000 $'000 Exchange differences "), "$")
        self.assertIsNone(fx_text.foreign_heading("2025 2024 £'000 £'000 Exchange differences "))



def _doc(rows: str, unit: str = "iso4217:GBP") -> bytes:
    """A minimal iXBRL document: two periods, turnover £156.4m, the given table rows."""
    return f"""<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance"><body>
<div style="display:none"><ix:header><ix:resources>
 <xbrli:context id="C"><xbrli:period><xbrli:endDate>2025-06-30</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:context id="P"><xbrli:period><xbrli:endDate>2024-06-30</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:unit id="u1"><xbrli:measure>{unit}</xbrli:measure></xbrli:unit>
</ix:resources></ix:header></div>
<table><tr><td>Turnover</td><td><ix:nonFraction name="core:TurnoverRevenue" contextRef="C" unitRef="u1" scale="0">156,365,849</ix:nonFraction></td></tr>
{rows}</table></body></html>""".encode()


FX = "core:GainLossDueToForeignExchangeDifferencesRecognisedInProfitOrLoss"


class TestFxTagsInAccounts(unittest.TestCase):
    def test_wanis_tag_on_stocks_line_and_real_line_untagged(self):
        doc = _doc(f"""<tr><td>The operating profit is stated after charging:</td><td>2025</td><td>2024</td></tr>
<tr><td>£</td><td>£</td></tr>
<tr><td>Stocks recognised as expenses</td>
 <td><ix:nonFraction name="{FX}" contextRef="C" unitRef="u1" scale="0" sign="-">113,049,604</ix:nonFraction></td>
 <td><ix:nonFraction name="{FX}" contextRef="P" unitRef="u1" scale="0" sign="-">100,459,883</ix:nonFraction></td></tr>
<tr><td>Exchange differences</td><td>150,529</td><td>41,380</td></tr>""")
        f = accounts.extract_facts(doc)
        self.assertEqual((f["fx_gain_loss"], f["fx_gain_loss_prior"], f["fx_gain_loss_check"]), (-150_529, -41_380, ""))
        self.assertEqual(f["fx_gain_loss_evidence"], 'accounts text: "Exchange differences 150,529 41,380"')

    def test_wrong_line_tag_without_a_text_line_is_a_check(self):
        doc = _doc(f"""<tr><td>Stocks recognised as expenses</td>
 <td><ix:nonFraction name="{FX}" contextRef="C" unitRef="u1" scale="0" sign="-">113,049,604</ix:nonFraction></td></tr>""")
        f = accounts.extract_facts(doc)
        self.assertIsNone(f["fx_gain_loss"])
        self.assertIn('is on the line "Stocks recognised as expenses"', f["fx_gain_loss_check"])

    def test_dollar_table_tagged_as_pounds(self):
        doc = _doc(f"""<tr><td>Operating profit is stated after charging/(crediting):</td><td>$'000</td><td>$'000</td></tr>
<tr><td>Exchange differences</td>
 <td><ix:nonFraction name="{FX}" contextRef="C" unitRef="u1" scale="3" sign="-">1,262</ix:nonFraction></td>
 <td>(<ix:nonFraction name="{FX}" contextRef="P" unitRef="u1" scale="3">1,123</ix:nonFraction>)</td></tr>""")
        f = accounts.extract_facts(doc)
        self.assertIsNone(f["fx_gain_loss"])
        self.assertIn("$", f["fx_gain_loss_check"])

    def test_tagged_fx_line_is_kept(self):
        doc = _doc(f"""<tr><td>£</td><td>£</td></tr><tr><td>Exchange losses/(gains)</td>
 <td><ix:nonFraction name="{FX}" contextRef="C" unitRef="u1" scale="0" sign="-">89,740</ix:nonFraction></td>
 <td>(<ix:nonFraction name="{FX}" contextRef="P" unitRef="u1" scale="0">41,183</ix:nonFraction>)</td></tr>""")
        f = accounts.extract_facts(doc)
        self.assertEqual((f["fx_gain_loss"], f["fx_gain_loss_prior"], f["fx_gain_loss_evidence"]),
                         (-89_740, 41_183, "tagged in the accounts"))


class TestFxInPdfText(unittest.TestCase):
    def test_line_on_a_later_page(self):
        text = ("Company information\nBankers  HSBC UK Bank plc\n\f"
                "Turnover   3   45,123,000   41,000,000\n\f"
                "6 Operating profit\nThe operating profit is stated after charging:\n        2025      2024\n"
                "         £         £\nExchange differences (62,022) (99,844)\n")
        f = accounts.extract_facts_from_text(text, "2025-12-31", "scanned pdf")
        self.assertEqual((f["fx_gain_loss"], f["fx_gain_loss_prior"]), (62_022, 99_844))
        self.assertEqual(f["fx_gain_loss_evidence"], 'scanned accounts p3: "Exchange differences (62,022) (99,844)"')

    def test_pages_tried_for_the_fx_note(self):
        # 30 pages, 6 already read: 18-27 first (60-90%), then 7, 8 (12 pages at most)
        self.assertEqual(pdf.fx_pages_order(30, 6), list(range(18, 28)) + [7, 8])
        self.assertEqual(pdf.fx_pages_order(5, 6), [])


if __name__ == "__main__":
    unittest.main()
