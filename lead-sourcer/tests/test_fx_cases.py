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

from sourcer import accounts, fx_notes, fx_text, pdf  # noqa: E402

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
    ("01207120", "pdftotext -layout columns, £'000", "Operating profit is stated after charging:\n"
     "                                         2025          2024\n                                        £'000         £'000\n"
     "Net foreign exchange losses                 56            58", (-56_000, -58_000), ""),
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

    def test_review_findings(self):
        # figures without thousands commas, and OCR's full stop for a comma
        self.assertEqual(fx_text.read(CHARGING + "Exchange losses 52195 25479")["value"], -52_195)
        self.assertEqual(fx_text.read(CHARGING + "Exchange losses 52195 25479")["prior"], -25_479)
        self.assertEqual(fx_text.read(CHARGING + "Exchange losses 52.195 25.479")["value"], -52_195)
        # ... but a £m table keeps its decimals
        self.assertEqual(fx_text.read("after charging: £m £m Exchange losses 1.2 0.8")["value"], -1_200_000)
        # a minus in a losses/(gains) column is a gain, like brackets
        self.assertEqual(fx_text.read(CHARGING + "Foreign exchange losses/(gains) -12,345 6,000")["value"], 12_345)
        # "2,019" is a figure, not a year
        self.assertEqual(fx_text.read("after charging: £'000 £'000 Exchange losses 2,019 5,000")["value"], -2_019_000)
        # "£'000s" / "£ million" headings scale
        self.assertEqual(fx_text.read("after charging: £'000s £'000s Exchange losses 1,234 567")["value"], -1_234_000)
        self.assertEqual(fx_text.read("after charging: £ million Exchange losses 1.5 2.0")["value"], -1_500_000)
        # "US$" in prose isn't a dollar table
        self.assertIsNone(fx_text.foreign_heading("The group has US$ and euro borrowings. Foreign exchange loss "))
        got = fx_text.read("The group has US$ borrowings. Operating profit is stated after charging: £ £ "
                           "Exchange losses 12,000 9,000")
        self.assertEqual((got["value"], got["check"]), (-12_000, ""))

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
<tr>
      <td class="label">
        Exchange differences
      </td>
      <td class="figure">
        150,529
      </td>
      <td class="figure">
        41,380
      </td>
    </tr>""")
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

    def test_ocr_dollar_sign_is_usually_a_pound(self):
        # 12467589 p25: OCR turned the "£" heading into "$"
        page = "stated after charging/(crediting):\n$ $\nForeign exchange differences (105,529) 66,700"
        self.assertIn("$", fx_text.read(page)["check"])
        self.assertEqual(fx_text.read(page, ocr=True)["value"], 105_529)
        dollars = "All figures in US dollars\nafter charging:\n$'000 $'000\nExchange differences 1,262 (1,123)"
        self.assertIn("$", fx_text.read(dollars, ocr=True)["check"])

    def test_pages_tried_for_the_fx_note(self):
        # 30 pages, 6 already read: 18-27 first (60-90%), then 7, 8 (12 pages at most)
        self.assertEqual(pdf.fx_pages_order(30, 6), list(range(18, 28)) + [7, 8])
        self.assertEqual(pdf.fx_pages_order(5, 6), [])


if __name__ == "__main__":
    unittest.main()


class TestFirstYearScanFindings(unittest.TestCase):
    """From the cross-check of the first year's FX filings scan (Nov 2026)."""

    def test_an_fx_figure_under_1000_at_a_10m_company_is_a_check(self):
        facts = accounts.check_fx({"fx_gain_loss": -597.0, "fx_gain_loss_prior": -10.0, "turnover": 89_700_000})
        self.assertIsNone(facts["fx_gain_loss"])
        self.assertIn("probably in £'000", facts["fx_gain_loss_check"])
        kept = accounts.check_fx({"fx_gain_loss": -597.0, "turnover": 4_000_000})   # a small firm's £597 can be real
        self.assertEqual(kept["fx_gain_loss"], -597.0)

    def test_a_text_fx_line_without_a_heading_takes_the_documents_thousands(self):
        text = "Operating profit is stated after charging/(crediting):\nForeign exchange differences (21) 7\n"
        facts: dict = {}
        self.assertTrue(accounts._fx_from_text(facts, text, "accounts text", thousands=True))
        self.assertEqual((facts["fx_gain_loss"], facts["fx_gain_loss_prior"]), (21_000.0, -7_000.0))
        self.assertIn("in £'000", facts["fx_gain_loss_evidence"])
        headed: dict = {}
        accounts._fx_from_text(headed, "£ £\n" + text, "accounts text", thousands=True)   # its own £ heading wins
        self.assertEqual(headed["fx_gain_loss"], 21.0)
        big: dict = {}   # 45,000 could be £45k or £45m: left as written
        accounts._fx_from_text(big, text.replace("(21) 7", "(45,000) 7"), "accounts text", thousands=True)
        self.assertEqual(big["fx_gain_loss"], 45_000.0)

    def test_turnover_over_5bn_without_the_staff_is_a_check(self):
        facts = accounts.check_turnover({"turnover": 40.4e9, "turnover_source": "the profit and loss account"})
        self.assertIsNone(facts["turnover"])
        self.assertIn("too big to be right", facts["turnover_check"])
        big = accounts.check_turnover({"turnover": 6e9, "turnover_source": "tagged in the accounts (iXBRL)",
                                       "employees": 20_000})
        self.assertEqual(big["turnover"], 6e9)

    def test_forward_rows_and_sentences_that_are_not_sizes(self):
        page = "Financial instruments £'000\nForeign exchange forward contract 49 464 59,476 48,690\n"
        self.assertEqual(fx_notes._forward_rows(page, 1), [])
        page = "£\nForward foreign currency contracts losses/(gains) - 7,127 6.\n"
        self.assertEqual(fx_notes._forward_rows(page, 1), [])
        sentence = ("Fair value gains and losses on foreign exchange contracts The group made a loss of £327,499 "
                    "(2024 - gain of £2,494) in the year on a foreign exchange contract.")
        self.assertEqual(fx_notes._forward_items(sentence, 1), [])
        self.assertEqual(fx_notes.forward_recheck("Forward contracts valued at £327k (prior year £2k)",
                                                  f'"{sentence}" (filed accounts)')[0], "")
        good = fx_notes._forward_rows("£'000\nForward foreign exchange contracts 1,250 980\n", 1)
        self.assertEqual(good[0]["amount"], 1_250_000)


class TestFirstYearScanFindingsAudit(unittest.TestCase):
    """From the reader audit of 250 filings (Nov 2026)."""

    def test_a_first_years_turnover_row_keeps_its_note_number_out(self):
        from sourcer import turnover_text
        self.assertEqual(turnover_text._figures(" 3 384,712,050", False), [(384712050.0, False)])
        self.assertEqual(turnover_text._figures(" 3 45,123 41,000", False), [(45123.0, False), (41000.0, False)])
        self.assertEqual(len(turnover_text._figures(" 12 15", False)), 2)   # two small figures: not a note pattern

    def test_last_years_turnover_20x_apart_is_dropped(self):
        facts = accounts.check_turnover({"turnover": 384_700_000, "turnover_prior": 3.0})
        self.assertEqual((facts["turnover"], facts["turnover_prior"]), (384_700_000, None))
        kept = accounts.check_turnover({"turnover": 50_000_000, "turnover_prior": 40_000_000})
        self.assertEqual(kept["turnover_prior"], 40_000_000)

    def test_a_continuing_discontinued_total_row_takes_the_totals(self):
        from sourcer import turnover_text
        figures = turnover_text._figures(" 3 37,679,617 1,619,583 39,299,200 32,434,093 3,742,042 36,176,135", False)
        self.assertEqual(turnover_text._pick(figures, [2025, 2024]), (39_299_200.0, 36_176_135.0))

    def test_last_years_fx_1000x_apart_is_dropped(self):
        facts = accounts.check_fx({"fx_gain_loss": -699_158.0, "fx_gain_loss_prior": -5.0, "turnover": 60_000_000})
        self.assertEqual((facts["fx_gain_loss"], facts["fx_gain_loss_prior"]), (-699_158.0, None))

    def test_a_growth_sentence_is_not_a_sensitivity(self):
        from sourcer import fx_notes
        s = ("The result was a growth in ACV of 12% with a 12% move in sterling against the USD, adding £35.1m "
             "to profit.")
        self.assertEqual(fx_notes._sensitivity_items(s, 1), [])
        facts = accounts.check_fx({"turnover": 32_900_000, "fx_sensitivity": [{"amount": 35_100_000}, {"amount": 450_000}]})
        self.assertEqual(facts["fx_sensitivity"], [{"amount": 450_000}])

    def test_a_gain_beside_the_fair_value_goes_the_fair_value_stays(self):
        from sourcer import fx_notes
        s = ("The fair value of forward foreign exchange contracts is measured using quoted forward exchange rates. "
             "The fair value is an asset of £125,120 (2024 - liability of £372,996) and the change in value included "
             "in profit or loss is a gain of £498,116 (2024 - loss of £372,996).")
        items = fx_notes._forward_items(s, 1)
        self.assertEqual([(i["amount"], i["prior"]) for i in items], [(125_120.0, 372_996.0)])
        stored = "Forward contracts valued at £125k (prior year £372k); forward contracts valued at £498k (prior year £372k)"
        new, _ = fx_notes.forward_recheck(stored, f'"{s}" (filed accounts)')
        self.assertEqual(new, "Forward contracts valued at £125k (prior year £372k)")
        self.assertIsNone(fx_notes.forward_recheck(new, f'"{s}" (filed accounts)'))   # stands now

    def test_a_four_column_forward_row_is_not_a_size(self):
        from sourcer import fx_notes
        self.assertEqual(fx_notes._forward_rows("£'000\nForeign exchange forward contract 35 - 64,856 53,872\n", 1), [])
        self.assertTrue(fx_notes.forward_evidence_doubtful('"Foreign exchange forward contract 35 - 64,856 53,872"'))
        kept = fx_notes._forward_rows("£'000\nForward foreign exchange contracts 21 1,250 980\n", 1)   # note, two years
        self.assertEqual(kept[0]["amount"], 1_250_000)

    def test_regions_adding_to_more_than_turnover_are_dropped(self):
        facts = accounts.check_fx({"turnover": 36_946_000, "overseas_share": 0.4,
                                   "regions": [{"region": "UK", "value": 30_000_000}, {"region": "EU", "value": 12_800_000}]})
        self.assertEqual((facts["regions"], facts["overseas_share"]), ([], None))
