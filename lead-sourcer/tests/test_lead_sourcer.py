"""
Offline tests for the FX lead sourcer. Every Companies House call, bulk
download and document fetch is faked, so these run anywhere:

    python3 -m unittest discover -s tests
"""

import base64
import csv
from collections import Counter
import importlib.util
import io
import json
import os
import random
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import date
from http.server import HTTPServer
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import main  # noqa: E402
import server  # noqa: E402
from sourcer import accounts, banks, bulk, companies_house, confirm, currency, excel, hmrc, hooks, incumbent, matching, people, profiles, register_cache, registries, roles, news, pdf, signals, timing, triggers, website  # noqa: E402

# api/ is a Vercel functions folder, not a package — load run.py by path.
_spec = importlib.util.spec_from_file_location("api_run", os.path.join(ROOT, "api", "run.py"))
api_run = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(api_run)

NICHES = {"niches": [
    {"id": "generic-wholesalers", "name": "Generic Wholesalers", "sic_codes": ["46900"],
     "currency_pairs": ["USD/GBP"], "exposure_reason": "Generic wholesale.", "call_angle": "Generic angle."},
    {"id": "european-wine-importers", "name": "European Wine Importers", "sic_codes": ["46342", "46900"],
     "currency_pairs": ["EUR/GBP"], "exposure_reason": "Buys wine from EU producers in EUR.",
     "call_angle": "Your EUR invoices cost more in sterling."},
    {"id": "craft-beer-importers", "name": "Craft Beer Importers", "sic_codes": ["46341"],
     "currency_pairs": ["EUR/GBP"], "exposure_reason": "Buys beer in EUR.", "call_angle": "Beer angle."},
]}

# --- Bulk file fixture: the real BasicCompanyData header, stray spaces and all. ---

BULK_HEADER = (
    "CompanyName, CompanyNumber,RegAddress.CareOf,RegAddress.POBox,RegAddress.AddressLine1, RegAddress.AddressLine2,"
    "RegAddress.PostTown,RegAddress.County,RegAddress.Country,RegAddress.PostCode,CompanyCategory,CompanyStatus,"
    "CountryOfOrigin,DissolutionDate,IncorporationDate,Accounts.AccountRefDay,Accounts.AccountRefMonth,"
    "Accounts.NextDueDate,Accounts.LastMadeUpDate,Accounts.AccountCategory,Returns.NextDueDate,Returns.LastMadeUpDate,"
    "Mortgages.NumMortCharges,Mortgages.NumMortOutstanding,Mortgages.NumMortPartSatisfied,Mortgages.NumMortSatisfied,"
    "SICCode.SicText_1,SICCode.SicText_2,SICCode.SicText_3,SICCode.SicText_4,LimitedPartnerships.NumGenPartners,"
    "LimitedPartnerships.NumLimPartners,URI,PreviousName_1.CONDATE, PreviousName_1.CompanyName,"
    "ConfStmtNextDueDate, ConfStmtLastMadeUpDate"
).split(",")

SIC_TEXT = {
    "46342": "46342 - Wholesale of wine, beer, spirits and other alcoholic beverages",
    "46341": "46341 - Wholesale of fruit and vegetable juices, mineral water and soft drinks",
    "46900": "46900 - Non-specialised wholesale trade",
    "62010": "62010 - Computer programming activities",
    "10890": "10890 - Manufacture of other food products n.e.c.",
}


def _bulk_row(number, name, sics, category, status="Active", company_type="Private Limited Company", postcode="BS1 1AA",
             incorporated="15/03/2004"):
    row = dict.fromkeys(h.strip() for h in BULK_HEADER)
    row = {k: "" for k in row}
    row.update({
        "CompanyName": name, "CompanyNumber": number, "RegAddress.AddressLine1": "1 Dock Road",
        "RegAddress.PostTown": "BRISTOL", "RegAddress.PostCode": postcode, "CompanyCategory": company_type,
        "CompanyStatus": status, "CountryOfOrigin": "United Kingdom", "IncorporationDate": incorporated,
        "Accounts.LastMadeUpDate": "31/12/2024", "Accounts.AccountCategory": category,
    })
    for i, sic in enumerate(sics, start=1):
        row[f"SICCode.SicText_{i}"] = SIC_TEXT[sic]
    return [row[h.strip()] for h in BULK_HEADER]


BULK_ROWS = [
    _bulk_row("01", "WINE CO LIMITED", ["46342", "46900"], "MEDIUM"),
    _bulk_row("02", "BIG WINE GROUP LIMITED", ["46342"], "GROUP"),
    _bulk_row("03", "TINY WINES LIMITED", ["46342"], "MICRO ENTITY"),
    _bulk_row("04", "BEER IMPORTS LIMITED", ["46341"], "FULL"),
    _bulk_row("05", "PLAIN WHOLESALE LIMITED", ["46900"], "MEDIUM"),
    _bulk_row("06", "SUB WINES LIMITED", ["46342"], "AUDIT EXEMPTION SUBSIDIARY"),
    _bulk_row("07", "DEAD WINES LIMITED", ["46342"], "MEDIUM", status="Dissolved"),
    _bulk_row("08", "WINE TRADE ASSOCIATION", ["46342"], "FULL",
              company_type="PRI/LTD BY GUAR/NSC (Private, limited by guarantee, no share capital)"),
    _bulk_row("09", "SOFTWARE LIMITED", ["62010"], "FULL"),
    _bulk_row("10", "STRIKE OFF WINES LIMITED", ["46342"], "MEDIUM", status="Active - Proposal to Strike off"),
    _bulk_row("11", "SMALL WINES LIMITED", ["46342"], "SMALL"),
    # Outside the niche SIC codes and small-accounts: only in via HMRC customs records.
    _bulk_row("12", "PATEL FINE FOODS LIMITED", ["10890"], "TOTAL EXEMPTION FULL", postcode="LE4 5AB", incorporated="01/06/1989"),
    _bulk_row("13", "ONE OFF TRADING LIMITED", ["10890"], "SMALL", postcode="LE4 9ZZ"),
]


def write_bulk_zip(directory, rows=BULK_ROWS, header=BULK_HEADER):
    path = os.path.join(directory, "BasicCompanyDataAsOneFile-2026-10-01.zip")
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("BasicCompanyDataAsOneFile-2026-10-01.csv", buf.getvalue())
    return path


# --- iXBRL fixture: current + prior year, a regional breakdown, figures in £000. ---

def ixbrl(current="23,412", prior="19,870", scale="3", fmt="ixt2:numdotdecimal", measure="iso4217:GBP",
          concept="core:TurnoverRevenue"):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"
      xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<head><title>Annual accounts</title></head><body>
<div style="display:none"><ix:header><ix:resources>
 <xbrli:context id="FY2024"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">01</xbrli:identifier></xbrli:entity>
  <xbrli:period><xbrli:startDate>2024-01-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:context id="FY2023"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">01</xbrli:identifier></xbrli:entity>
  <xbrli:period><xbrli:startDate>2023-01-01</xbrli:startDate><xbrli:endDate>2023-12-31</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:context id="FY2024-EU"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">01</xbrli:identifier>
  <xbrli:segment><xbrldi:explicitMember dimension="core:GeographicalAreasDimension">core:Europe</xbrldi:explicitMember></xbrli:segment></xbrli:entity>
  <xbrli:period><xbrli:startDate>2024-01-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>
 <xbrli:context id="BS2024"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">01</xbrli:identifier></xbrli:entity>
  <xbrli:period><xbrli:instant>2024-12-31</xbrli:instant></xbrli:period></xbrli:context>
 <xbrli:unit id="CUR"><xbrli:measure>{measure}</xbrli:measure></xbrli:unit>
 <xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
</ix:resources></ix:header></div>
<table>
 <tr><td>Turnover</td>
  <td><ix:nonFraction name="{concept}" contextRef="FY2024" unitRef="CUR" decimals="-3" scale="{scale}" format="{fmt}"><span>{current}</span></ix:nonFraction></td>
  <td><ix:nonFraction name="{concept}" contextRef="FY2023" unitRef="CUR" decimals="-3" scale="{scale}" format="{fmt}">{prior}</ix:nonFraction></td></tr>
 <tr><td>of which Europe</td>
  <td><ix:nonFraction name="{concept}" contextRef="FY2024-EU" unitRef="CUR" scale="{scale}" format="{fmt}">9,001</ix:nonFraction></td></tr>
 <tr><td>Bankers</td><td>Barclays Bank PLC, 1 Churchill Place, London</td></tr>
 <tr><td>Auditors</td><td>Haysmacintyre LLP, 10 Queen Street Place</td></tr>
 <tr><td>FX loss</td>
  <td><ix:nonFraction name="core:GainLossDueToForeignExchangeDifferencesRecognisedInProfitOrLoss" contextRef="FY2024" unitRef="CUR" scale="{scale}" sign="-" format="{fmt}">420</ix:nonFraction></td>
  <td><ix:nonFraction name="core:GainLossDueToForeignExchangeDifferencesRecognisedInProfitOrLoss" contextRef="FY2023" unitRef="CUR" scale="{scale}" sign="-" format="{fmt}">90</ix:nonFraction></td></tr>
 <tr><td>Cash</td><td><ix:nonFraction name="core:CashBankOnHand" contextRef="BS2024" unitRef="CUR" scale="{scale}" format="{fmt}">3,100</ix:nonFraction></td></tr>
 <tr><td>Cost of sales</td>
  <td>(<ix:nonFraction name="core:CostSales" contextRef="FY2024" unitRef="CUR" scale="{scale}" sign="-" format="{fmt}">17,000</ix:nonFraction>)</td></tr>
</table></body></html>""".encode()


def _filing(document_id, paper=False):
    return {"type": "AA", "date": "2025-09-01", "paper_filed": paper,
            "links": {"document_metadata": f"https://frontend-doc-api.company-information.service.gov.uk/document/{document_id}"}}


FILINGS = {
    "01": [{"type": "AA01", "links": {}}, _filing("doc01")],   # change of accounting date first, then the accounts
    "02": [_filing("doc02")],
    "04": [_filing("doc04", paper=True)],
    "05": [_filing("doc05")],
    "06": [_filing("doc06")],
}
DOCUMENTS = {
    "doc01": ixbrl(current="23,412", scale="3"),       # £23.4m — confirmed
    "doc02": ixbrl(current="8,000", scale="3"),        # £8.0m — under the minimum
    "doc05": None,                                     # PDF-only filing
    "doc06": ixbrl(current="12,000,000", prior="11,000,000", scale="0"),
}
# Text of company 05's PDF-only accounts, as pdftotext -layout gives it.
PDF_TEXT_05 = """Profit and loss account for the year ended 31 December 2024
                                   Note      2024        2023
                                             £'000       £'000
Turnover                             3     31,500      28,000
Cost of sales                               (24,000)    (21,000)
\fBankers  HSBC UK Bank plc
The company is exposed to foreign currency risk on purchases from suppliers."""
PDFS = {"doc05": b"%PDF-1.4 doc05"}


def make_pdf(lines):
    """A minimal one-page PDF with `lines` of text (Helvetica), built by hand."""
    stream = "BT /F1 11 Tf 50 760 Td 14 TL " + " ".join(
        "(" + l.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") '" for l in lines) + " ET"
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
               "/Resources << /Font << /F1 5 0 R >> >> >>",
               f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream",
               "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = "%PDF-1.4\n", []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out.encode("latin-1")))
        out += f"{i} 0 obj\n{body}\nendobj\n"
    xref = len(out.encode("latin-1"))
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n" + "".join(f"{o:010d} 00000 n \n" for o in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return out.encode("latin-1")


OFFICERS = {
    "01": [
        {"name": "JONES, Bob", "officer_role": "director", "occupation": "Managing Director", "appointed_on": "2010-01-01"},
        {"name": "SMITH, Jane", "officer_role": "director", "occupation": "Finance Director", "appointed_on": "2020-05-01"},
        {"name": "GONE, Old", "officer_role": "director", "occupation": "Chief Financial Officer",
         "appointed_on": "2005-01-01", "resigned_on": "2019-01-01"},
        {"name": "HOLDCO LIMITED", "officer_role": "corporate-director", "appointed_on": "2000-01-01"},
    ],
    "02": [{"name": "BIG, Boss", "officer_role": "director", "occupation": "Director", "appointed_on": "2001-01-01"}],
    "04": [
        {"name": "NEW, Newer", "officer_role": "director", "occupation": "Company Director", "appointed_on": "2015-01-01"},
        {"name": "FOUNDING, Fran", "officer_role": "director", "occupation": "Company Director", "appointed_on": "2003-01-01"},
        {"name": "SEC, Sally", "officer_role": "secretary", "appointed_on": "2012-01-01"},
    ],
    "05": [],
    "06": [
        {"name": "COUNT, Cara", "officer_role": "director", "occupation": "Chartered Accountant", "appointed_on": "2012-01-01"},
        {"name": "LEAD, Lou", "officer_role": "director", "occupation": "Managing Director", "appointed_on": "2011-01-01"},
    ],
}


OFFICERS["12"] = [
    {"name": "PATEL, Ramesh", "officer_role": "director", "appointed_on": "1989-06-01",
     "date_of_birth": {"year": 1956, "month": 3}, "nationality": "British", "country_of_residence": "England"},
    {"name": "PATEL, Anjali", "officer_role": "director", "appointed_on": "2015-01-01",
     "date_of_birth": {"year": 1988, "month": 7}, "nationality": "British", "country_of_residence": "England"},
]
OWNERS = {
    "12": [{"kind": "individual-person-with-significant-control", "name": "Mr Ramesh Patel", "country_of_residence": "England"}],
    "01": [{"kind": "corporate-entity-person-with-significant-control", "name": "VINI HOLDING SPA",
            "notified_on": "2026-02-10", "identification": {"country_registered": "Italy", "registration_number": "IT998"}},
           {"kind": "individual-person-with-significant-control", "name": "Mr Old Owner",
            "notified_on": "2016-04-06", "ceased_on": "2026-02-10"}],
    "02": [{"kind": "corporate-entity-person-with-significant-control", "name": "WINE CO LIMITED",
            "notified_on": "2016-04-06", "identification": {"country_registered": "England", "registration_number": "01"}}],
}
CHARGES = {
    "12": [{"status": "outstanding", "created_on": "2022-04-02", "persons_entitled": [{"name": "HSBC UK Bank PLC"}]}],
    "01": [{"status": "fully-satisfied", "created_on": "2015-01-01", "satisfied_on": "2026-03-01",
            "persons_entitled": [{"name": "Lloyds Bank PLC"}]}],
}


class FakeCompaniesHouse:
    """Stands in for companies_house._get, routing by URL; records every call."""

    def __init__(self, search=None, profiles=None):
        self.calls = []
        self.search = search or {}
        self.profiles = profiles or {}

    def __call__(self, url, params, api_key, retries=3):
        self.calls.append(url)
        if url == companies_house.CH_SEARCH:
            items = self.search.get(params["sic_codes"], [])
            start = params["start_index"]
            return {"items": items[start:start + params["size"]], "hits": len(items)}
        parts = url.rstrip("/").split("/")
        if parts[-1] == "filing-history":
            return {"items": FILINGS.get(parts[-2], [])}
        if parts[-1] == "officers":
            return {"items": OFFICERS.get(parts[-2], [])}
        if parts[-1] == "persons-with-significant-control":
            return {"items": OWNERS.get(parts[-2], [])}
        if parts[-1] == "charges":
            return {"items": CHARGES.get(parts[-2], [])}
        return self.profiles.get(parts[-1])

    def count(self, suffix):
        return sum(url.endswith(suffix) for url in self.calls)


SITES = {
    "https://www.plainwholesale.co.uk/": (
        "https://www.plainwholesale.co.uk/",
        '<html><body><a href="/about-us/our-team">Our team</a><a href="https://linkedin.com/company/x">LinkedIn</a>'
        '<a href="/contact">Contact</a><footer>Plain Wholesale Limited, registered in England</footer></body></html>'),
    "https://www.plainwholesale.co.uk/about-us/our-team": (
        "https://www.plainwholesale.co.uk/about-us/our-team",
        "<h3>Mark Lee</h3><p>Financial Controller</p><h3>Pat Kim</h3><p>Sales Director</p>"),
    "https://www.plainwholesale.co.uk/contact": (
        "https://www.plainwholesale.co.uk/contact",
        "<p>info@plainwholesale.co.uk | mark.lee@plainwholesale.co.uk | sales@gmail.com</p>"),
}


NEWS_FEEDS = {
    news.feed_url("BEER IMPORTS LIMITED"): """<rss><channel>
<item><title>Beer Imports appoints Nina Patel as finance director - Insider Media</title>
<pubDate>Tue, 03 Mar 2026 09:00:00 GMT</pubDate><source>Insider Media</source></item>
<item><title>Other Brewing names Bob Ray CFO</title><pubDate>Tue, 03 Mar 2026 09:00:00 GMT</pubDate></item>
</channel></rss>""",
}


REGISTRY_FILES = {
    registries.GPG_URL.format(year=2026): (
        "EmployerName,CompanyNumber,ResponsiblePerson,DateSubmitted\n"
        "WINE CO LIMITED,00000001,Mrs Jane Smith (Finance Director),2026/03/30 10:00:00\n"
        "OTHER LIMITED,09999999,Pat Other (HR Director),2026/03/30 10:00:00\n"),
    registries.MSS_URL.format(year=2026): (
        "OrganisationName,CompanyNumber,ApprovingPerson,DateApproved\n"
        "BEER IMPORTS LIMITED,04,Sally Sec (HR Director),2026-06-01\n"),
}


class PipelineTestCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakeCompaniesHouse()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bulk_path = write_bulk_zip(self.tmp.name)
        self.niches_path = os.path.join(self.tmp.name, "niches.json")
        with open(self.niches_path, "w", encoding="utf-8") as f:
            json.dump(NICHES, f)
        for patcher in (
            mock.patch.object(companies_house, "_get", self.fake),
            mock.patch.object(companies_house, "_throttle", lambda: None),
            mock.patch.object(accounts, "fetch_ixbrl", lambda doc_id, key: DOCUMENTS.get(doc_id)),
            mock.patch.object(website, "fetch", SITES.get),   # never the real internet
            mock.patch.object(accounts, "fetch_pdf", lambda doc_id, key: PDFS.get(doc_id)),
            mock.patch.object(pdf, "available", lambda: True),
            mock.patch.object(pdf, "to_text", lambda data: (PDF_TEXT_05, "pdf") if data == PDFS["doc05"] else ("", "")),
            mock.patch.object(website, "PAUSE_SECONDS", 0),
            mock.patch.object(news, "fetch", NEWS_FEEDS.get),
            mock.patch.object(registries, "fetch", REGISTRY_FILES.get),
            mock.patch.dict(os.environ, {"COMPANIES_HOUSE_API_KEY": "test-key"}),
            mock.patch("sys.stdout"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_bulk(self, **kwargs):
        kwargs.setdefault("hmrc_files", [])  # no customs evidence unless a test supplies it
        kwargs.setdefault("stats_files", [])
        kwargs.setdefault("min_turnover", 2_000_000)  # the fixtures are small companies
        kwargs.setdefault("today", date(2026, 10, 19))
        return main.run_pipeline(niches_path=self.niches_path, bulk_file=self.bulk_path, **kwargs)


class TestRegisterCache(PipelineTestCase):
    def test_second_run_reuses_the_lookups(self):
        with mock.patch.object(register_cache, "CACHE_DIR", os.path.join(self.tmp.name, "register")), \
                mock.patch.object(register_cache, "CACHE_DAYS", 7):
            first = self.run_bulk(news_check=False)
            calls = len(self.fake.calls)
            again = self.run_bulk(news_check=False)
            self.assertEqual(again, first)                       # same list, read from the cache
            self.assertTrue(any(u.endswith("/officers") for u in self.fake.calls[:calls]))
            self.assertFalse(any(u.endswith(("/officers", "/filing-history", "/charges"))
                                 for u in self.fake.calls[calls:]))
            # newer accounts in the bulk file: that company is looked up again
            self.assertIsNone(register_cache.load("01", "2099-12-31"))
            self.assertIsNotNone(register_cache.load("01", "2024-12-31"))


class TestBulkFile(PipelineTestCase):
    def test_finds_active_trading_companies_in_frame(self):
        found = bulk.find_candidates(self.bulk_path, {"46342", "46341", "46900"}, set(main.CANDIDATE_CATEGORIES))
        self.assertEqual(sorted(c["company_number"] for c in found), ["01", "02", "04", "05", "06"])
        wine = next(c for c in found if c["company_number"] == "01")
        self.assertEqual(wine, {
            "company_number": "01", "company_name": "WINE CO LIMITED", "sic_codes": ["46342", "46900"],
            "accounts_category": "medium", "accounts_made_up_to": "2024-12-31", "incorporated_on": "2004-03-15",
            "postcode": "BS1 1AA", "registered_address": "1 Dock Road, BRISTOL",
        })

    def test_unexpected_format_fails_loudly(self):
        path = write_bulk_zip(self.tmp.name, rows=[], header=["CompanyName", "CompanyNumber"])
        with self.assertRaises(ValueError) as ctx:
            bulk.find_candidates(path, {"46342"}, {"medium"})
        self.assertIn("missing columns", str(ctx.exception))

    def test_helpers(self):
        self.assertEqual(bulk.normalise_category("AUDIT EXEMPTION SUBSIDIARY"), "audit-exemption-subsidiary")
        self.assertEqual(bulk.sic_code("None Supplied"), "")
        self.assertEqual(bulk.snapshot_dates(date(2026, 1, 3)), ["2026-01-01", "2025-12-01"])

    def test_download_uses_cache_and_falls_back_a_month(self):
        def fake_fetch(url, path):
            if "2026-10-01" in url:
                raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
            with open(path, "wb") as f:
                f.write(b"zip")
        cache = os.path.join(self.tmp.name, "cache")
        with mock.patch.object(bulk, "_fetch_to", side_effect=fake_fetch) as fetch:
            path = bulk.download(cache, today=date(2026, 10, 2))
            self.assertTrue(path.endswith("BasicCompanyDataAsOneFile-2026-09-01.zip"))
            self.assertEqual(fetch.call_count, 2)  # October not out yet (404), so September
            self.assertEqual(bulk.download(cache, today=date(2026, 10, 2)), path)
            self.assertEqual(fetch.call_count, 3)  # tried October again, then used the cached September


class TestIxbrlTurnover(unittest.TestCase):
    def test_latest_whole_company_figure_in_gbp(self):
        # Not last year's 19.87m, not the 9.0m Europe breakdown; scale 3 = thousands.
        self.assertEqual(accounts.extract_turnover(ixbrl()), {"turnover": 23_412_000.0, "period_end": "2024-12-31"})

    def test_old_uk_gaap_concept(self):
        doc = ixbrl(concept="uk-gaap:TurnoverGrossOperatingRevenue", current="15,000,000", scale="0")
        self.assertEqual(accounts.extract_turnover(doc)["turnover"], 15_000_000.0)

    def test_comma_decimal_and_zero_formats(self):
        doc = ixbrl(current="12.500.000,00", prior="1,00", scale="0", fmt="ixt4:num-comma-decimal")
        self.assertEqual(accounts.extract_turnover(doc)["turnover"], 12_500_000.0)
        self.assertEqual(accounts._fact_value({"text": "-", "format": "ixt2:zerodash"}), 0.0)
        self.assertEqual(accounts._fact_value({"text": "1.2", "scale": "6"}), 1_200_000.0)

    def test_non_gbp_or_untagged_is_unknown(self):
        self.assertIsNone(accounts.extract_turnover(ixbrl(measure="iso4217:EUR")))
        self.assertIsNone(accounts.extract_turnover(b"<html><body>PDF-style accounts, nothing tagged</body></html>"))

    def test_fetch_follows_redirect_without_sending_credentials_to_s3(self):
        seen = {}

        def fake_open(request, timeout):
            seen["api"] = request
            raise urllib.error.HTTPError(request.full_url, 302, "Found", {"Location": "https://s3.example/doc?sig=x"}, None)

        def fake_urlopen(request, timeout):
            seen["s3"] = request
            return io.BytesIO(b"<html>ixbrl</html>")

        with mock.patch.object(accounts._no_redirect_opener, "open", fake_open), \
             mock.patch("urllib.request.urlopen", fake_urlopen), \
             mock.patch.object(companies_house, "_throttle", lambda: None):
            self.assertEqual(accounts.fetch_ixbrl("doc1", "key"), b"<html>ixbrl</html>")
        self.assertEqual(seen["api"].full_url,
                         "https://document-api.company-information.service.gov.uk/document/doc1/content")
        self.assertEqual(seen["api"].get_header("Accept"), "application/xhtml+xml")
        self.assertTrue(seen["api"].get_header("Authorization").startswith("Basic "))
        self.assertEqual(seen["s3"].full_url, "https://s3.example/doc?sig=x")
        self.assertIsNone(seen["s3"].get_header("Authorization"))

    def test_fetch_pdf_only_is_none(self):
        def not_acceptable(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 406, "Not Acceptable", {}, None)
        with mock.patch.object(accounts._no_redirect_opener, "open", not_acceptable), \
             mock.patch.object(companies_house, "_throttle", lambda: None):
            self.assertIsNone(accounts.fetch_ixbrl("doc1", "key"))


class TestSourceLinks(PipelineTestCase):
    def test_accounts_document_and_fx_page(self):
        filing = {"links": {"self": "/company/01234567/filing-history/MzQ1Njc4"}}
        url = accounts.filing_document_url("01234567", filing)
        self.assertEqual(url, "https://find-and-update.company-information.service.gov.uk/company/01234567/"
                              "filing-history/MzQ1Njc4/document?format=pdf&download=0")
        links = accounts.accounts_links("01234567", {"accounts_url": url, "fx_gain_loss": 11_677,
                                                     "fx_gain_loss_evidence": 'scanned accounts p22: "Exchange differences (11,677)"'})
        self.assertEqual(links["fx_gain_loss_url"], url + "#page=22")
        # tagged figure: the document itself; no FX figure: no FX link
        self.assertEqual(accounts.accounts_links("01234567", {"accounts_url": url, "fx_gain_loss": -5}, )["fx_gain_loss_url"], url)
        self.assertEqual(accounts.accounts_links("01234567", {"accounts_url": url})["fx_gain_loss_url"], "")
        # read before links were kept: the company's accounts filings
        self.assertEqual(accounts.accounts_links("01234567", {"fx_gain_loss": -5})["accounts_url"],
                         "https://find-and-update.company-information.service.gov.uk/company/01234567/filing-history?category=accounts")

    def test_rows_link_their_sources(self):
        wine = {r["company_number"]: r for r in self.run_bulk(news_check=False)}["01"]
        self.assertTrue(wine["accounts_url"].startswith("https://find-and-update.company-information.service.gov.uk/company/01"))
        self.assertTrue(wine["fx_gain_loss_url"])          # it has an FX figure
        if wine["incumbent_bank"]:
            self.assertIn("/company/01/charges", wine["incumbent_bank_url"])


class TestRecentFxLoss(unittest.TestCase):
    def test_loss_in_accounts_filed_lately(self):
        today = date(2026, 10, 28)
        self.assertEqual(main.recent_fx_loss(-150_512, "2026-09-12", today),
                         "£150,512 FX loss, accounts filed 2026-09-12")
        self.assertEqual(main.recent_fx_loss(-150_512, "2025-12-01", today), "")   # filed too long ago
        self.assertEqual(main.recent_fx_loss(150_512, "2026-09-12", today), "")    # a gain
        self.assertEqual(main.recent_fx_loss(-20_000, "2026-09-12", today), "")    # under the hook threshold
        self.assertEqual(main.recent_fx_loss(None, "2026-09-12", today), "")
        self.assertEqual(main.recent_fx_loss(-150_512, "", today), "")


class TestFinderTimeBudget(PipelineTestCase):
    def test_budget_used_marks_the_list_partial(self):
        os.chdir(self.tmp.name)
        self.addCleanup(os.chdir, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        with mock.patch.object(main, "FINDER_BUDGET_MIN", 1e-9):
            rows = self.run_bulk(news_check=False)
        self.assertEqual(rows, [])
        with open(main.PARTIAL_FILE) as f:
            self.assertGreater(int(f.read()), 0)
        self.run_bulk(news_check=False)            # no budget: a full list, marker gone
        self.assertFalse(os.path.exists(main.PARTIAL_FILE))

    def test_accounts_kept_longer_than_the_register(self):
        with mock.patch.object(register_cache, "CACHE_DIR", os.path.join(self.tmp.name, "register")), \
                mock.patch.object(register_cache, "CACHE_DAYS", 7):
            self.run_bulk(news_check=False)
            reads = sum(1 for c in self.fake.calls if "filing-history" in c)
            with mock.patch.object(register_cache, "CACHE_DAYS", 1e-9):   # register stale, accounts still fresh
                with mock.patch.object(register_cache, "FACTS_DAYS", 90):
                    self.run_bulk(news_check=False)
            self.assertEqual(sum(1 for c in self.fake.calls if "filing-history" in c), reads)
            # past FACTS_DAYS from when they were read (not from the file's date, which each refresh resets): read again
            with mock.patch.object(register_cache, "CACHE_DAYS", 1e-9), mock.patch.object(register_cache, "FACTS_DAYS", 1e-9):
                self.run_bulk(news_check=False)
            self.assertGreater(sum(1 for c in self.fake.calls if "filing-history" in c), reads)


class TestPipeline(PipelineTestCase):
    def test_keeps_in_frame_companies_and_names_directors(self):
        rows = {r["company_number"]: r for r in self.run_bulk()}
        self.assertEqual(sorted(rows), ["01", "02", "04", "05", "06"])
        wine = rows["01"]
        self.assertEqual(wine["section"], main.SECTION_BELOW)  # £23.4m filed, under the £25m core band
        self.assertEqual((wine["main_bank"], wine["bank_type"]), ("Barclays", "high-street"))  # "Bankers" line in the accounts
        self.assertEqual(wine["cost_of_sales_gbp"], "17000000")
        self.assertEqual(wine["fx_wallet_basis"], "no customs records")
        self.assertIn("accounts: foreign exchange loss of £420k (year before: loss of £90k)", wine["fx_evidence"])
        self.assertEqual((wine["fx_gain_loss_gbp"], wine["fx_gain_loss_prior_gbp"]), ("-420000", "-90000"))
        self.assertEqual((wine["turnover_growth"], wine["cash_gbp"]), ("+18%", "3100000"))
        self.assertEqual((wine["auditor"], wine["auditor_tier"]), ("Haysmacintyre", "mid-tier"))
        self.assertEqual(wine["triggers"], "new owner VINI HOLDING SPA (2026-02) | "
                                           "paid off charge to Lloyds Bank PLC (2026-03) — refinanced or left that lender")
        self.assertEqual((wine["when_to_call"], wine["planning_window_now"]), ("year-end 31 Dec: planning Sep–Nov", "yes"))
        self.assertEqual(wine["owners"], "VINI HOLDING SPA (corporate, Italy)")  # the ceased owner isn't listed
        # BIG WINE GROUP is owned by WINE CO (company 01), which is also listed: one group.
        group = {r["company_number"]: r for r in self.run_bulk()}["02"]
        self.assertEqual((group["group_parent"], group["group_companies_in_list"]), ("WINE CO LIMITED (01)", 2))
        self.assertEqual(group["parent_finance_contact"], "Jane Smith (Finance Director) at WINE CO LIMITED")

        self.assertIn("owned by VINI HOLDING SPA (Italy)", wine["fx_evidence"])
        self.assertIn("accounts: turnover split by country/region", wine["fx_evidence"])
        self.assertEqual(wine["fx_niche"], "European Wine Importers")  # 2 shared SIC codes beats generic's 1
        self.assertEqual(wine["currency_pairs"], "EUR/GBP")
        self.assertEqual(wine["fx_exposure"], "Buys wine from EU producers in EUR.")
        self.assertEqual(wine["turnover_gbp"], "23412000")
        self.assertEqual(wine["turnover_period_end"], "2024-12-31")
        self.assertEqual(wine["size_basis"], "filed turnover £23.4m (accounts to 2024-12-31)")
        self.assertEqual((wine["finance_contact"], wine["finance_contact_role"], wine["finance_contact_source"]),
                         ("Jane Smith", "Finance Director", "Companies House occupation"))
        self.assertEqual(wine["website"], "")  # finance person already named: no website lookup
        self.assertEqual((wine["lead_director"], wine["lead_director_occupation"]), ("Bob Jones", "Managing Director"))
        self.assertEqual(wine["all_directors"], "Jane Smith (Finance Director); Bob Jones (Managing Director)")
        self.assertEqual(wine["sic_codes"], "46342|46900")
        self.assertEqual((wine["postcode"], wine["incorporated_on"]), ("BS1 1AA", "2004-03-15"))
        self.assertTrue(wine["companies_house_url"].endswith("/company/01"))

    def test_company_website_names_finance_person_when_nothing_else_does(self):
        plain = {r["company_number"]: r for r in self.run_bulk()}["05"]   # no officers, PDF accounts
        self.assertEqual((plain["finance_contact"], plain["finance_contact_role"], plain["finance_contact_source"]),
                         ("Mark Lee", "Financial Controller", "company website: listed as Financial Controller"))
        self.assertEqual(plain["website"], "https://www.plainwholesale.co.uk/")
        self.assertEqual(plain["generic_emails"], "info@plainwholesale.co.uk")  # not the personal one, not gmail
        offline = {r["company_number"]: r for r in self.run_bulk(websites=False)}["05"]
        self.assertEqual((offline["website"], offline["finance_contact"]), ("", ""))

    def test_turnover_floor_sections_and_unknown_turnover(self):
        rows = {r["company_number"]: r for r in self.run_bulk()}
        self.assertEqual(rows["02"]["section"], main.SECTION_BELOW)  # filed £8.0m: over the £2m floor
        self.assertEqual(rows["04"]["section"], main.SECTION_CORE)   # large ("full") accounts, turnover not filed
        self.assertNotIn("02", {r["company_number"] for r in self.run_bulk(min_turnover=10_000_000)})
        # Default floor is the band's lower end (£25m): only the unconfirmed medium/large ones stay.
        self.assertEqual(sorted(r["company_number"] for r in self.run_bulk(min_turnover=main.DEFAULT_MIN_TURNOVER)),
                         ["04", "05"])
        banded = {r["company_number"]: r["section"] for r in self.run_bulk(band_min=5_000_000, band_max=20_000_000)}
        self.assertEqual((banded["01"], banded["02"]), ("Above (£20m+)", "Core (£5m–£20m)"))
        with self.assertRaises(ValueError):
            self.run_bulk(band_min=20_000_000, band_max=5_000_000)
        self.assertEqual(rows["04"]["size_basis"], "last accounts filed as full; turnover not in the filing")  # paper filing
        self.assertEqual(rows["05"]["size_basis"], "filed turnover £31.5m (accounts to 2024-12-31)")  # read from the PDF
        self.assertEqual((rows["05"]["accounts_format"], rows["05"]["cost_of_sales_gbp"], rows["05"]["turnover_growth"]),
                         ("pdf", "24000000", "+12%"))
        self.assertEqual(rows["05"]["main_bank"], "HSBC")
        self.assertIn("accounts: foreign-exchange risk discussed", rows["05"]["fx_evidence"])
        self.assertEqual(rows["01"]["accounts_format"], "ixbrl")
        self.assertEqual(rows["04"]["turnover_gbp"], "")

    def test_audit_exempt_subsidiary_needs_confirmed_turnover(self):
        sub = {r["company_number"]: r for r in self.run_bulk()}["06"]
        self.assertEqual(sub["turnover_gbp"], "12000000")
        self.assertEqual(sub["finance_contact"], "Cara Count")  # "Chartered Accountant" counts as finance
        self.assertEqual(sub["lead_director"], "Lou Lead")
        rows = self.run_bulk(turnover_check=False)
        self.assertNotIn("06", {r["company_number"] for r in rows})

    def test_lead_director_falls_back_to_longest_serving(self):
        beer = {r["company_number"]: r for r in self.run_bulk()}["04"]
        # The news names Beer Imports' new FD (a headline about another company is ignored) ...
        self.assertEqual((beer["finance_contact"], beer["finance_contact_source"], beer["finance_contact_confidence"]),
                         ("Nina Patel", "news: listed as Finance Director — Insider Media, 2026-03", "Confirmed"))
        self.assertIn("new finance lead Nina Patel (2026-03, news)", beer["triggers"])
        self.assertTrue(beer["verify_finance_contact_url"].endswith("?q=Beer+Imports+finance+director"))
        self.assertEqual(beer["company_secretary"], "Sally Sec")
        # ... without it, the company secretary is the (unconfirmed) guess.
        beer = {r["company_number"]: r for r in self.run_bulk(news_check=False)}["04"]
        self.assertEqual((beer["finance_contact"], beer["finance_contact_source"], beer["finance_contact_confidence"]),
                         ("Sally Sec", "company secretary — often the finance lead", "Guess"))
        self.assertNotIn("Sally Sec", beer["all_directors"])
        self.assertEqual((beer["lead_director"], beer["lead_director_occupation"]), ("Fran Founding", "Company Director"))

    def test_registry_filings_verify_or_contradict_the_pick(self):
        rows = {r["company_number"]: r for r in self.run_bulk()}
        # Register says Finance Director; the gender pay gap report (2026) names her with that title: two sources.
        self.assertEqual((rows["01"]["finance_contact_confidence"], rows["01"]["finance_contact_evidence"]),
                         ("Verified", "Companies House: director since 2020; gender pay gap report: Finance Director (2026-03)"))
        # The secretary guess is named in a modern slavery statement — as HR Director: the wrong person.
        beer = {r["company_number"]: r for r in self.run_bulk(news_check=False)}["04"]
        self.assertEqual(beer["finance_contact_confidence"], "Guess")
        self.assertIn("but modern slavery statement lists them as HR Director", beer["finance_contact_evidence"])
        plain = {r["company_number"]: r for r in self.run_bulk(registry_check=False)}["01"]
        self.assertEqual(plain["finance_contact_confidence"], "Confirmed")

    def test_min_turnover_is_configurable(self):
        rows = {r["company_number"] for r in self.run_bulk(min_turnover=5_000_000)}
        self.assertIn("02", rows)

    def test_max_enrich_checks_the_top_of_the_queue_only(self):
        rows = self.run_bulk(max_enrich=1)
        # Only PLAIN WHOLESALE (first niche) was checked; the rest ship unchecked on category,
        # and the subsidiary drops out because nothing confirmed its size.
        self.assertEqual(sorted(r["company_number"] for r in rows), ["01", "02", "04", "05"])
        self.assertEqual(self.fake.count("/filing-history"), 1)
        self.assertEqual(self.fake.count("/officers"), 1)
        self.assertEqual({r["company_number"]: r["size_basis"] for r in rows}["01"],
                         "last accounts filed as medium; turnover not checked")

    def test_without_api_key_lists_candidates_only(self):
        with mock.patch.dict(os.environ, {"COMPANIES_HOUSE_API_KEY": ""}):
            rows = self.run_bulk()
        self.assertEqual(sorted(r["company_number"] for r in rows), ["01", "02", "04", "05"])
        self.assertEqual(self.fake.calls, [])
        self.assertTrue(all(r["all_directors"] == "" for r in rows))

    def test_unknown_niche_fails_before_any_work(self):
        with self.assertRaises(ValueError):
            self.run_bulk(niche_ids=["no-such-niche"])
        self.assertEqual(self.fake.calls, [])

    def test_api_source(self):
        search = {
            "46342": [
                {"company_number": "01", "company_name": "WINE CO LIMITED", "company_type": "ltd", "sic_codes": ["46342", "46900"],
                 "date_of_creation": "2004-03-15", "registered_office_address": {"address_line_1": "1 Dock Road", "locality": "Bristol", "postal_code": "BS1 1AA"}},
                {"company_number": "03", "company_name": "TINY WINES LIMITED", "company_type": "ltd", "sic_codes": ["46342"]},
                {"company_number": "08", "company_name": "WINE TRADE ASSOCIATION", "company_type": "private-limited-guarant-nsc", "sic_codes": ["46342"]},
            ],
        }
        profiles = {"01": {"accounts": {"last_accounts": {"type": "medium", "made_up_to": "2024-12-31"}}},
                    "03": {"accounts": {"last_accounts": {"type": "micro-entity"}}}}
        fake = FakeCompaniesHouse(search=search, profiles=profiles)
        with mock.patch.object(companies_house, "_get", fake):
            rows = main.run_pipeline(niches_path=self.niches_path, niche_ids=["european-wine-importers"], source="api",
                                     min_turnover=2_000_000)
        self.assertEqual([r["company_number"] for r in rows], ["01"])
        self.assertEqual((rows[0]["registered_address"], rows[0]["postcode"]), ("1 Dock Road, Bristol", "BS1 1AA"))
        self.assertEqual(rows[0]["turnover_gbp"], "23412000")
        self.assertFalse(any(url.endswith("/08") for url in fake.calls))  # guarantee company never profiled

    def test_api_source_needs_key(self):
        with mock.patch.dict(os.environ, {"COMPANIES_HOUSE_API_KEY": ""}), self.assertRaises(ValueError):
            main.run_pipeline(niches_path=self.niches_path, source="api")


# --- HMRC trader files: real layout (tab-separated; period, flag, name, address x5, postcode, codes) ---

def hmrc_line(period, name, address1, postcode, codes):
    return "\t".join([period, "1", name, f'"""{address1}"""', "DOCK ROAD", "BRISTOL", "", "", postcode]
                     + codes + [""] * (50 - len(codes)))


def stats_line(period, code, country, value, flow="imp"):
    """A trade-statistics row in the published fixed-width layout."""
    origin = "     " if flow == "exp" else f"001{country}"
    return f"{period}1202610{code}00150001{country}007DOV{origin}6{value:013d}{0:013d}{0:012d}{flow}0"


def write_stats_zip(directory, period, lines):
    path = os.path.join(directory, f"bdsimp{period[2:]}.zip")
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(f"BDSimp{period[2:]}.txt", "\r\n".join(lines) + "\r\n")
    return path


def write_hmrc_zip(directory, flow, period, lines):
    path = os.path.join(directory, f"{flow}s{period[2:]}.zip")
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr(f"{flow}s{period[2:]}.txt", "\r\n".join(lines) + "\r\n")
    return path


class TestHmrc(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_parse_and_aggregate_months(self):
        paths = [write_hmrc_zip(self.tmp.name, "import", f"2026{m:02d}",
                                [hmrc_line(f"2026{m:02d}", "WINE CO LTD", "UNIT 4", "BS1 1AA", ["22042138", "22042179"])])
                 for m in (6, 7, 8)]
        paths.append(write_hmrc_zip(self.tmp.name, "export", "202608",
                                    [hmrc_line("202608", "Wine Co Limited", "UNIT 4", "BS1 1AA", ["22042138"])]))
        rec = next(hmrc.iter_records(paths[0]))
        self.assertEqual((rec["flow"], rec["period"], rec["name"], rec["postcode"]), ("import", "202606", "WINE CO LTD", "BS1 1AA"))
        self.assertEqual(rec["codes"], ["22042138", "22042179"])
        self.assertEqual(rec["address"], "UNIT 4, DOCK ROAD, BRISTOL")
        traders = hmrc.build_traders(paths)
        self.assertEqual(list(traders), [("WINE", "BS11AA")])   # "WINE CO LTD" and "Wine Co Limited" are one trader
        t = traders[("WINE", "BS11AA")]
        self.assertEqual(sorted(t["import_months"]), ["202606", "202607", "202608"])
        self.assertEqual(t["export_months"], {"202608"})
        self.assertEqual(hmrc.chapters(t["import_codes"]), ["22 beverages, spirits & wine"])

    def test_list_files_reads_monthly_and_archive_links(self):
        page = (b'<a href="/media/xyzl4prn/importers2608.zip">Importer details: August 2026</a>'
                b'<a href="/media/3vrhrwag/exporters2608.zip">Exporter details</a><a href="/media/q/bdsimp2608.zip">x</a>'
                b'<a href="/media/vx5cajmw/importers_jan-jun26archive.zip">a</a>'
                b'<a href="/media/oowkbyeh/importers_jul-dec25archive.zip">a</a>'
                b'<a href="/media/bu4pxiwz/importers_jan-jun2023archive.zip">a</a>'
                b'<a href="/media/4ttmeady/exporters_2025archive.zip">a</a>'
                b'<a href="/media/dtahkxbm/exporters2021_archive.zip">a</a>'
                b'<a href="/media/c5vdgxeu/bdsexp_26archive.zip">not a trader file</a>')
        with mock.patch.object(hmrc, "_get", return_value=page):
            files = hmrc.list_files(["https://www.uktradeinfo.com/trade-data/latest-bulk-data-sets/"])
        self.assertEqual(sorted(files), [("export", "A2021"), ("export", "A2025"), ("export", "M2608"),
                                         ("import", "A2023-H1"), ("import", "A2025-H2"), ("import", "A2026-H1"),
                                         ("import", "M2608")])
        self.assertEqual(files[("import", "M2608")], "https://www.uktradeinfo.com/media/xyzl4prn/importers2608.zip")

    def test_twelve_month_window(self):
        keys = ["M2608", "M2607", "A2026-H1", "A2025-H2", "A2025-H1", "A2026", "A2025", "A2024"]
        since, wanted = hmrc.window(keys, 12)
        self.assertEqual(since, "202509")
        self.assertEqual(wanted, {"M2608", "M2607", "A2026-H1", "A2025-H2", "A2026", "A2025"})

    def test_archive_bundle_with_nested_monthly_zips_and_window(self):
        inner = io.BytesIO()
        with zipfile.ZipFile(inner, "w") as zf:
            zf.writestr("importers2508.txt", hmrc_line("202508", "OLD LTD", "U1", "BS1 1AA", ["22042138"]) + "\r\n")
            zf.writestr("importers2510.txt", hmrc_line("202510", "WINE CO LTD", "U4", "BS1 1AA", ["22042138"]) + "\r\n")
        bundle = os.path.join(self.tmp.name, "imports-A2025-H2.zip")
        with zipfile.ZipFile(bundle, "w") as zf:
            zf.writestr("importers_jul-dec25.zip", inner.getvalue())
        traders = hmrc.build_traders([bundle], since="202509")
        self.assertEqual(list(traders), [("WINE", "BS11AA")])  # August is before the window
        self.assertEqual(traders[("WINE", "BS11AA")]["import_months"], {"202510"})


class TestMatching(unittest.TestCase):
    def test_normalise(self):
        self.assertEqual(matching.normalise_name("The Acme Wine Co. (UK) Limited"), "ACME WINE")
        self.assertEqual(matching.normalise_name("Smith & Sons Ltd T/A Smiths Wines"), "SMITH AND SONS")
        self.assertEqual(matching.normalise_postcode(" bs1 1aa "), "BS11AA")

    def test_match_rules(self):
        here = [{"company_number": "01", "company_name": "ACME WINE IMPORTERS LIMITED"},
                {"company_number": "02", "company_name": "BRISTOL ACCOUNTANTS LLP"}]
        self.assertEqual(matching.match_trader("Acme Wine Importers Ltd", here), (here[0], "high"))
        self.assertEqual(matching.match_trader("ACME WINE IMPORTER LTD", here), (here[0], "medium"))
        self.assertIsNone(matching.match_trader("ACME TRADING LTD", here))
        twins = [{"company_number": "03", "company_name": "ACME WINE IMPORTERS NORTH LIMITED"},
                 {"company_number": "04", "company_name": "ACME WINE IMPORTERS SOUTH LIMITED"}]
        self.assertIsNone(matching.match_trader("ACME WINE IMPORTERS LTD", twins))  # too close to call

    def test_crowded_postcode_needs_exact_name(self):
        crowd = [{"company_number": str(i), "company_name": f"CLIENT {i} LIMITED"} for i in range(400)]
        crowd.append({"company_number": "X", "company_name": "ACME WINE IMPORTERS LIMITED"})
        self.assertEqual(matching.match_trader("ACME WINE IMPORTERS LTD", crowd)[1], "high")
        self.assertIsNone(matching.match_trader("ACME WINE IMPORTER LTD", crowd))  # near-miss at an accountant's address

    def test_name_unique_fallback_when_postcodes_differ(self):
        traders = {("ACME WINE", "LS11AA"): {"name": "ACME WINE LTD", "import_months": {"202608"}, "export_months": set(),
                                             "import_codes": Counter({"22042138": 1}), "export_codes": Counter()}}
        company = {"company_number": "01", "company_name": "ACME WINE LIMITED"}
        self.assertEqual(matching.match_all(traders, {}, {"ACME WINE": [company]})["01"]["confidence"], "medium")
        self.assertEqual(matching.match_all(traders, {}, {"ACME WINE": [company, dict(company, company_number="02")]}), {})


class TestSignals(unittest.TestCase):
    def test_family(self):
        directors = [{"name": "Ramesh Patel", "birth_year": 1956}, {"name": "Anjali Patel", "birth_year": 1988},
                     {"name": "Sam Jones", "birth_year": 1970}]
        self.assertEqual(signals.family_run(directors, []), (True, "2 directors/owners named Patel across two generations"))
        self.assertEqual(signals.family_run(directors[2:], []), (False, ""))

    def test_untapped(self):
        score, level, reasons = signals.untapped(
            [{"kind": "individual", "name": "R Patel", "country": "England", "nationality": ""}],
            True, {"hedging_disclosed": False}, "1989-06-01", today=date(2026, 10, 19))
        self.assertEqual((score, level), (85, "High"))
        self.assertIn("no hedging disclosed in accounts", reasons)
        foreign = [{"kind": "corporate", "name": "X GMBH", "country": "Germany", "nationality": ""}]
        self.assertEqual(signals.untapped(foreign, False, None, "")[0], 0)  # group treasury: likely already served

    def test_one_month_is_proof_not_regularity(self):
        trade = {"import_months": {"202608"}, "export_months": set(), "import_codes": Counter({"22042138": 1}),
                 "export_codes": Counter(), "confidence": "high"}
        self.assertEqual(signals.fx_evidence(trade, 1, None, [], [], niche_match=False)[:2], (21, "Low"))

    def test_fx_evidence(self):
        trade = {"import_months": {f"2026{m:02d}" for m in range(1, 13)}, "export_months": set(),
                 "import_codes": Counter({"22042138": 12}), "export_codes": Counter(), "confidence": "high"}
        score, level, lines = signals.fx_evidence(trade, 12, {"fx_gain_loss": -180_000}, [], [], niche_match=False)
        self.assertEqual((score, level), (55, "Medium"))
        self.assertEqual(lines, ["HMRC customs: imported in 12 of 12 months (22 beverages, spirits & wine)",
                                 "accounts: foreign exchange loss of £180k"])


class TestPipelineWithCustoms(PipelineTestCase):
    def test_customs_evidence_brings_in_family_firm_and_ranks_proven_traders(self):
        d = self.tmp.name
        files = []
        for m in range(3, 9):
            p = f"2026{m:02d}"
            lines = [hmrc_line(p, "WINE CO LTD", "UNIT 4", "BS1 1AA", ["22042138"]),
                     hmrc_line(p, "PATEL FINE FOODS LTD", "UNIT 9", "LE4 5AB", ["09042110", "20019065"])]
            if m == 8:
                lines.append(hmrc_line(p, "ONE OFF TRADING LTD", "UNIT 1", "LE4 9ZZ", ["85171300"]))
            files.append(write_hmrc_zip(d, "import", p, lines))
        stats = write_stats_zip(d, "202608", [
            stats_line("202608", "22042138", "FR", 6_000_000), stats_line("202608", "22042138", "IT", 4_000_000),
            stats_line("202608", "09042110", "IN", 3_000_000), stats_line("202608", "09042110", "ES", 1_000_000),
            stats_line("202608", "20019010", "IT", 2_000_000),   # 20019065 isn't listed: falls back to 200190
            stats_line("202608", "22042138", "US", 9_000_000, flow="exp")])
        rows = {r["company_number"]: r for r in self.run_bulk(hmrc_files=files, stats_files=[stats])}

        self.assertNotIn("13", rows)               # small accounts, customs records in only 1 month
        family = rows["12"]                        # small accounts, but 6 months of customs records
        self.assertEqual(family["section"], main.SECTION_BELOW)
        self.assertEqual(family["fx_niche"], "Proven trader: 09 coffee, tea & spices, 20 prepared fruit & veg")
        self.assertEqual((family["hmrc_import_months"], family["hmrc_match"]), (6, "high"))
        self.assertEqual(family["family_run"], "2 directors/owners named Patel across two generations")
        self.assertEqual(family["untapped_level"], "High")
        self.assertEqual((family["main_bank"], family["bank_type"]), ("HSBC", "high-street"))
        self.assertEqual(family["banking_relationships"], "HSBC (charge 2022-04)")
        self.assertIn("HSBC facility from 2022-04 — on a 3–5 year term, renewal is near", family["triggers"])
        # Year-end from the register's last accounts date (no iXBRL); imports seen Mar–Aug.
        self.assertEqual(family["when_to_call"], "year-end 31 Dec: planning Sep–Nov | imports Mar–Aug (next: Mar)")
        self.assertEqual(family["import_currencies"], "EUR 62%, USD 38%")  # 09 spices: IN 75% / ES 25%; 20: IT
        self.assertEqual(family["currency_pairs"], "GBP/EUR|GBP/USD")
        self.assertEqual(family["trade_countries"], "from IT 50%, IN 38%, ES 12%")
        wine = rows["01"]
        self.assertTrue(wine["fx_evidence"].startswith("HMRC customs: imported in 6 of 6 months"))
        self.assertEqual((wine["import_currencies"], wine["currency_pairs"]), ("EUR 100%", "GBP/EUR"))
        # £17m cost of sales x 15–40% (customs records in 3–8 months)
        self.assertEqual((wine["fx_wallet_low_gbp"], wine["fx_wallet_high_gbp"]), ("2600000", "6800000"))
        self.assertIn("imports 15–40% of cost of sales (6 months in customs)", wine["fx_wallet_basis"])
        # At the default £25m floor, small-accounts firms are out of range and not brought in.
        at_default = self.run_bulk(hmrc_files=files, stats_files=[stats], min_turnover=main.DEFAULT_MIN_TURNOVER)
        self.assertNotIn("12", {r["company_number"] for r in at_default})

    def test_capped_run_checks_proven_traders_first(self):
        files = [write_hmrc_zip(self.tmp.name, "import", "202608",
                                [hmrc_line("202608", "BEER IMPORTS LTD", "UNIT 2", "BS1 1AA", ["22030001"])])]
        rows = {r["company_number"]: r for r in self.run_bulk(hmrc_files=files, max_enrich=1)}
        self.assertNotEqual(rows["04"]["untapped_reasons"], "not checked")  # the customs-proven one got the budget
        self.assertEqual(rows["01"]["untapped_reasons"], "not checked")


class TestCurrency(unittest.TestCase):
    def test_currency_for_country(self):
        self.assertEqual([currency.currency_for(c) for c in ("FR", "BG", "PL", "CH", "US", "CN", "JP", "GB", "QV")],
                         ["EUR", "EUR", "EUR", "CHF", "USD", "USD", "JPY", None, None])

    def test_stats_layout(self):
        line = "20260812026100101210000150001FR007DOV001FR600000149546390000000187000000000000370imp0"  # published row
        self.assertEqual(stats_line("202608", "01012100", "FR", 14_954_639)[:56], line[:56])
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.zip")
            with zipfile.ZipFile(path, "w") as zf:
                zf.writestr("BDSimp2608.txt", line + "\r\n" + stats_line("202607", "01012100", "DE", 5) + "\r\n")
            self.assertEqual(list(currency.iter_stats(path, since="202608")), [("import", "01012100", "FR", 14_954_639)])

    def test_mix_falls_back_to_wider_code_group(self):
        model = currency.TradeByCountry()
        for code, country, value in (("84212100", "DE", 70), ("84212100", "CN", 30), ("84219900", "CH", 100),
                                     ("84212100", "GB", 999)):   # returned goods: ignored
            model.add("import", code, country, value)
        cur, countries = currency.mix(model, "import", Counter({"84212100": 3, "84213900": 1}))
        # 84213900 isn't listed: its 6-digit group 842139 isn't either, so 4-digit 8421 (DE 70, CN 30, CH 100).
        self.assertEqual(currency.describe(cur), "EUR 61%, USD 26%, CHF 13%")  # DE 3x0.7+0.35, CN 3x0.3+0.15, CH 0.5 of 4
        self.assertAlmostEqual(cur["CHF"], 0.125)
        self.assertEqual(currency.pairs(cur, Counter()), ["GBP/EUR", "GBP/USD"])
        self.assertEqual(currency.mix(model, "export", Counter({"84212100": 1})), (Counter(), Counter()))

    def test_wallet(self):
        w = currency.wallet(40_000_000, None, 12, 4)
        # purchases assumed 70% of £40m = £28m x 40–80%, plus £40m x 10–25% exports
        self.assertEqual((round(w["low"]), round(w["high"])), (15_200_000, 32_400_000))
        self.assertIn("70% of turnover as purchases", w["basis"])
        self.assertIsNone(currency.wallet(None, None, 12, 0))
        self.assertIsNone(currency.wallet(40_000_000, None, 0, 0))


class TestBanks(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(banks.classify("Lombard North Central PLC"), ("NatWest", "high-street"))
        self.assertEqual(banks.classify("Close Brothers Limited"), ("Close Brothers", "challenger"))
        self.assertEqual(banks.classify("Acme Invoice Finance Ltd"), ("Acme Invoice Finance Ltd", "specialist lender"))
        self.assertIsNone(banks.classify("John Smith"))

    def test_bankers_from_accounts_text(self):
        self.assertEqual(banks.bankers_from_text("Solicitors X LLP Bankers The Royal Bank of Scotland plc Auditors Y"),
                         ["NatWest"])
        self.assertEqual(banks.bankers_from_text("BANKERS: Bank of Cyprus UK Limited, 27 Charles St"),
                         ["Bank of Cyprus UK Limited"])
        self.assertEqual(banks.bankers_from_text("the bankers have security over the stock"), [])

    def test_relationships(self):
        lenders = [{"name": "Close Brothers Invoice Finance", "created_on": "2026-05-01"},
                   {"name": "Acme Asset Finance Ltd", "created_on": "2026-08-01"},
                   {"name": "Lloyds Bank PLC", "created_on": "2014-02-10"}]
        rel = banks.relationships(lenders, ["HSBC"], own_bank="Lloyds Banking Group")
        self.assertEqual(rel["main"], "HSBC")  # named as bankers beats any charge
        self.assertEqual(rel["summary"], "HSBC (named as bankers); Close Brothers (charge 2026-05); "
                                         "Lloyds (charge 2014-02); Acme Asset Finance Ltd (charge 2026-08)")
        self.assertTrue(rel["own_bank"])
        rel = banks.relationships(lenders, [])
        self.assertEqual((rel["main"], rel["main_type"]), ("Close Brothers", "challenger"))  # newest bank, not the financier
        self.assertFalse(rel["own_bank"])
        self.assertEqual(banks.relationships([], [])["summary"], "")


class TestThrottle(unittest.TestCase):
    def test_calls_stay_spaced_across_threads(self):
        with mock.patch.object(companies_house, "RATE_LIMIT_SECONDS", 0.05), \
             mock.patch.object(companies_house, "_next_call", 0.0):
            started = time.monotonic()
            threads = [threading.Thread(target=companies_house._throttle) for _ in range(5)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertGreaterEqual(time.monotonic() - started, 0.19)  # 5 calls, 4 gaps of 0.05s


class TestTriggers(unittest.TestCase):
    TODAY = date(2026, 10, 19)

    def test_owner_change_and_private_equity(self):
        owners = [{"kind": "corporate", "name": "Acme Bidco Limited", "notified_on": "2026-01-15", "ceased_on": ""},
                  {"kind": "individual", "name": "Jo Founder", "notified_on": "2016-04-06", "ceased_on": "2026-01-15"}]
        self.assertEqual(triggers.find(owners, [], [], self.TODAY),
                         ["new owner Acme Bidco Limited (2026-01) — looks private-equity backed"])
        self.assertEqual(triggers.investor_owner(owners), "Acme Bidco Limited")
        self.assertEqual(triggers.find(owners[1:], [], [], self.TODAY), ["owner Jo Founder stepped back (2026-01)"])
        original = [{"kind": "individual", "name": "Jo Founder", "notified_on": "2016-04-06", "ceased_on": ""}]
        self.assertEqual(triggers.find(original, [], [], date(2016, 10, 1)), [])  # register's first filings aren't news

    def test_charges_and_directors(self):
        charges = [{"name": "Barclays Bank PLC", "created_on": "2022-06-01", "status": "outstanding", "satisfied_on": ""},
                   {"name": "Close Brothers Limited", "created_on": "2026-05-01", "status": "outstanding", "satisfied_on": ""}]
        lines = triggers.find([], charges, [{"name": "New Fd", "appointed_on": "2026-04-01"},
                                            {"name": "Old Hand", "appointed_on": "2001-01-01"}], self.TODAY)
        self.assertEqual(lines, ["new charge to Close Brothers Limited (2026-05) — new borrowing or a new bank",
                                 "new director New Fd (2026-04) — new people review providers"])
        lines = triggers.find([], charges[:1], [], self.TODAY)
        self.assertEqual(lines, ["Barclays facility from 2022-06 — on a 3–5 year term, renewal is near"])


class TestTiming(unittest.TestCase):
    def test_when_to_call(self):
        trade = {"import_months": {"202603", "202604", "202605", "202606", "202609"}, "export_months": set()}
        self.assertEqual(timing.when_to_call(trade, "2024-12-31", date(2026, 10, 19)),
                         ("year-end 31 Dec: planning Sep–Nov | imports Mar–Jun, Sep (next: Mar)", True))
        self.assertEqual(timing.when_to_call(None, "2025-03-31", date(2026, 10, 19)), ("year-end 31 Mar: planning Dec–Feb", False))
        every = {"import_months": {f"2026{m:02d}" for m in range(1, 13)}, "export_months": set()}
        self.assertEqual(timing.when_to_call(every, "", date(2026, 10, 19)), ("imports every month", False))
        self.assertEqual(timing.next_year_end("2024-02-29", date(2026, 1, 10)), date(2026, 2, 28))


class TestAccountsExtras(unittest.TestCase):
    def test_overseas_share_needs_parts_to_add_up(self):
        doc = ixbrl().decode()
        self.assertIsNone(accounts.extract_facts(doc.encode())["overseas_share"])  # Europe alone is 9.0m of 23.4m
        split = doc.replace("</xbrli:unit>\n <xbrli:unit id=\"shares\">", "</xbrli:unit>\n <xbrli:unit id=\"shares\">", 1)
        extra = """ <xbrli:context id="FY2024-UK"><xbrli:entity><xbrli:identifier scheme="x">01</xbrli:identifier>
  <xbrli:segment><xbrldi:explicitMember dimension="core:GeographicalAreasDimension">core:UnitedKingdom</xbrldi:explicitMember></xbrli:segment></xbrli:entity>
  <xbrli:period><xbrli:startDate>2024-01-01</xbrli:startDate><xbrli:endDate>2024-12-31</xbrli:endDate></xbrli:period></xbrli:context>
"""
        split = split.replace("</ix:resources>", extra + "</ix:resources>").replace(
            "</table>", '<tr><td><ix:nonFraction name="core:TurnoverRevenue" contextRef="FY2024-UK" unitRef="CUR" '
                        'scale="3">14,411</ix:nonFraction></td></tr></table>')
        self.assertAlmostEqual(accounts.extract_facts(split.encode())["overseas_share"], 9_001 / 23_412, places=3)

    def test_auditor(self):
        self.assertEqual(accounts.auditor_from_text("Statutory Auditor KPMG LLP 1 Sovereign Square"), ("KPMG", "Big Four"))
        self.assertEqual(accounts.auditor_from_text("AUDITORS: Smith Cooper LLP, St Helens House"),
                         ("Smith Cooper LLP", "independent"))
        self.assertIsNone(accounts.auditor_from_text("REPORT OF THE INDEPENDENT AUDITORS TO THE MEMBERS OF ACME LIMITED"))

    def test_wallet_uses_filed_overseas_share(self):
        w = currency.wallet(40_000_000, 30_000_000, 0, 12, overseas_share=0.25)
        self.assertEqual((w["low"], w["high"]), (10_000_000, 10_000_000))  # replaces the 20–50% export band
        self.assertEqual(w["basis"], "sales abroad 25% of turnover (filed split by region)")


class TestPeople(unittest.TestCase):
    def test_corroborate(self):
        officers = [{"name": "Jane Smith", "role": "Company Secretary", "occupation": "", "appointed_on": "2019-01-01"}]
        guess = {"name": "Jane Smith", "role": "Company Secretary", "confidence": people.GUESS}
        today = date(2026, 10, 19)
        site = [{"name": "Jane Smith", "title": "Finance Director"}]
        self.assertEqual(people.corroborate(guess, officers, website_people=site, today=today),
                         {"confidence": "Verified", "sources": 2,
                          "evidence": ["Companies House: company secretary since 2019", "company website: Finance Director"]})
        # Secretary of 40 unrelated companies: a professional secretary, not the FD.
        pro = people.corroborate(guess, officers, appointments={"active": 40, "related": 1}, today=today)
        self.assertEqual(pro["confidence"], "Guess")
        self.assertIn("looks like a professional company secretary", pro["evidence"][-1])
        group = people.corroborate(guess, officers, appointments={"active": 6, "related": 5}, today=today)
        self.assertEqual(group["evidence"][-1], "officer of 5 group companies")
        # One source alone, however good, is not Verified; an old filing alone isn't current either.
        confirmed = {"name": "Jane Smith", "role": "Finance Director", "confidence": people.CONFIRMED}
        self.assertEqual(people.corroborate(confirmed, [], website_people=site, today=today)["confidence"], "Confirmed")
        old = [{"name": "Jane Smith", "title": "Finance Director", "date": "2023-01-05", "source": "gender pay gap report"}]
        self.assertEqual(people.corroborate(confirmed, [], accounts_people=site, registry_people=old,
                                            today=today)["confidence"], "Confirmed")

    def test_registry_parsing(self):
        self.assertEqual(registries.split_person("Mrs Jane Smith (Chief Financial Officer)"),
                         ("Mrs Jane Smith", "Chief Financial Officer"))
        self.assertEqual(registries.split_person("Jane Smith"), ("Jane Smith", ""))
        self.assertEqual((registries.company_number("725104"), registries.company_number("sc017664")),
                         ("00725104", "SC017664"))
        found = registries.load(date(2026, 10, 19), REGISTRY_FILES.get)
        self.assertEqual(found["00000001"], [{"name": "Mrs Jane Smith", "title": "Finance Director",
                                               "date": "2026-03-30", "source": "gender pay gap report"}])
        self.assertEqual(found["00000004"][0]["date"], "2026-06-01")

    def test_organisations_are_not_people(self):
        # Seen in a real run: an address, a news outlet, headline words and the company itself next to a title.
        for text, not_names in (("Albex House\nGroup Finance Director\nMarlow", ""),
                                ("Jollibee Group CFO conducts media briefings", ""),
                                ("Golden Acre Foods appoints new Finance Director", "Golden Acre Foods Food Manufacture"),
                                ("Ex-Tyson Foods CFO joins Acme", "Tyson Foods just-food.com"),
                                ("JBS Global CFO says prices rise", "JBS GLOBAL (UK) LIMITED TradingView")):
            with self.subTest(text=text):
                self.assertEqual(people.finance_people(text, not_names), [])
        self.assertEqual(people.finance_people("Fairburn names Jane Fairburn as CFO", "Fairburn"),
                         [{"name": "Jane Fairburn", "title": "CFO"}])

    def test_finance_people_in_text(self):
        self.assertEqual(people.finance_people("Directors J A Smith (Chairman) Jane Doe (Finance Director) Bob Jones (MD)"),
                         [{"name": "Jane Doe", "title": "Finance Director"}])
        self.assertEqual(people.finance_people("Bob Jones Managing Director Jane Smith Group CFO Ann Lee"),
                         [{"name": "Jane Smith", "title": "Group CFO"}])
        self.assertEqual(people.finance_people("Chief Financial Officer: Mr Peter O'Neil"),
                         [{"name": "Peter O'Neil", "title": "Chief Financial Officer"}])
        self.assertEqual(people.finance_people("MEET THE TEAM JOHN BROWN FINANCIAL CONTROLLER"),
                         [{"name": "John Brown", "title": "Financial Controller"}])
        self.assertEqual(people.finance_people("Head of Finance\nKaren Patel\nKaren joined us in 2019"),
                         [{"name": "Karen Patel", "title": "Head of Finance"}])
        self.assertEqual(people.finance_people("approved by the board and the Finance Director reviewed it"), [])

    def test_signatory_and_ranking(self):
        self.assertEqual(people.signatory_from_text("and signed on its behalf by: J Smith Director"), "J Smith")
        officers = [{"name": "Bob Jones", "role": "Director", "occupation": "", "appointed_on": "2001-01-01"},
                    {"name": "Jane Smith", "role": "Director", "occupation": "", "appointed_on": "2015-01-01"},
                    {"name": "Jane Smith", "role": "Company Secretary", "occupation": "", "appointed_on": "2015-01-01"}]
        accounts_people = [{"name": "J Smith", "title": "Finance Director"}]
        pick = people.choose_finance_contact(officers, accounts_people, [])
        self.assertEqual((pick["name"], pick["source"], pick["confidence"]),
                         ("Jane Smith", "filed accounts: listed as Finance Director (also a director)", "Confirmed"))
        pick = people.choose_finance_contact(officers, [], [])
        self.assertEqual((pick["source"], pick["confidence"]), ("company secretary and director — often the finance lead", "Guess"))
        pick = people.choose_finance_contact(officers, [], [], signatory="J Smith")   # secretary also signed: Likely
        self.assertEqual((pick["source"], pick["confidence"]),
                         ("company secretary and director, signed the accounts — often the finance lead", "Likely"))
        pick = people.choose_finance_contact(officers[:2], [], [], qualified=[{"name": "Bob Jones", "letters": "FCA"}])
        self.assertEqual((pick["name"], pick["role"], pick["confidence"]), ("Bob Jones", "Director (FCA)", "Likely"))
        pick = people.choose_finance_contact(officers[:2], [], [], signatory="J Smith")
        self.assertEqual((pick["name"], pick["source"]), ("Jane Smith", "signed the accounts — often the finance director"))
        self.assertIsNone(people.choose_finance_contact(officers[:1], [], [], signatory="Bob Jones"))  # sole director

    def test_qualified_accountants_and_news_style_names(self):
        self.assertEqual(people.qualified_people("Directors\nJ A Smith FCA\nJane Doe BSc (Hons), ACMA\nBob Jones"),
                         [{"name": "J A Smith", "letters": "FCA"}, {"name": "Jane Doe", "letters": "ACMA"}])
        self.assertEqual(people.finance_people("Acme Wines appoints Jane Smith as finance director"),
                         [{"name": "Jane Smith", "title": "Finance Director"}])
        self.assertEqual(people.finance_people("Peter Brown has been appointed Group CFO at Acme"),
                         [{"name": "Peter Brown", "title": "Group CFO"}])

    def test_news_appointments_must_name_the_company_and_be_recent(self):
        feed = """<rss><channel>
<item><title>Acme Wine appoints Jane Smith as CFO</title><pubDate>Mon, 02 Mar 2026 09:00:00 GMT</pubDate></item>
<item><title>Acme Wine hires Old Guy as finance director</title><pubDate>Mon, 02 Mar 2020 09:00:00 GMT</pubDate></item>
<item><title>Rival Ltd names Bob Ray CFO</title><pubDate>Mon, 02 Mar 2026 09:00:00 GMT</pubDate></item>
<item><title>Acme Wine: Ann Lee joins as financial controller</title><pubDate>Mon, 02 Mar 2023 09:00:00 GMT</pubDate></item>
</channel></rss>"""
        found = news.appointments("ACME WINE LIMITED", lambda url: feed, today=date(2026, 10, 20))
        self.assertEqual([(p["name"], p["confidence"]) for p in found], [("Jane Smith", "Confirmed"), ("Ann Lee", "Likely")])
        self.assertEqual(news.appointments("ACME WINE LIMITED", lambda url: None), [])

    def test_accounts_name_signatory_and_finance_people(self):
        doc = ixbrl().replace(b"</table>", b"<p>Directors: Jane Doe (Finance Director)</p><p>Signed on its behalf by "
                                           b"Jane Doe</p></table>")
        facts = accounts.extract_facts(doc)
        self.assertEqual((facts["finance_people"], facts["signatory"]),
                         ([{"name": "Jane Doe", "title": "Finance Director"}], "Jane Doe"))


class TestFxSanity(unittest.TestCase):
    def test_wanis_shaped_figure_is_a_check_not_a_fact(self):
        # Wanis Ltd (00795535), y/e 2025-06-30: "FX loss" £113.0m on £156.4m turnover, £100.5m the year before.
        doc = ixbrl(current="156,366", prior="139,600").replace(b">420<", b">113,050<").replace(b">90<", b">100,460<")
        f = accounts.extract_facts(doc)
        self.assertIsNone(f["fx_gain_loss"])
        self.assertIsNone(f["fx_gain_loss_prior"])
        self.assertIn("72% of turnover", f["fx_gain_loss_check"])
        self.assertIn("-£113.0m", f["fx_gain_loss_check"])
        self.assertNotIn("fx", [h["kind"] for h in hooks.find_hooks(f, [], [], [], today=date(2026, 10, 26))])

    def test_ordinary_figure_passes(self):
        f = accounts.extract_facts(ixbrl())   # £420k loss on £23.4m: 1.8%
        self.assertEqual((f["fx_gain_loss"], f["fx_gain_loss_check"]), (-420_000, ""))

    def test_cached_facts_are_checked_too(self):
        f = accounts.check_fx({"turnover": 10_000_000, "fx_gain_loss": 2_500_000, "fx_gain_loss_prior": None})
        self.assertIsNone(f["fx_gain_loss"])
        self.assertIn("25% of turnover", f["fx_gain_loss_check"])


class TestPdfAccounts(unittest.TestCase):
    def test_facts_from_layout_text(self):
        f = accounts.extract_facts_from_text(PDF_TEXT_05 + """
Balance sheet               2024     2023
                            £'000    £'000
Cash at bank and in hand    3,100    2,050
Net assets                 (1,400)   1,000
Turnover   2024   2023
Turnover increased by 12,000 thanks to growth in Europe and Asia markets
Auditors  Haysmacintyre LLP
Directors  Jane Smith  Finance Director
Signed on behalf of the board by J Smith Director""")
        self.assertEqual((f["turnover"], f["turnover_prior"], f["cost_of_sales"]), (31_500_000, 28_000_000, 24_000_000))
        self.assertEqual((f["cash"], f["net_assets"], f["period_end"]), (3_100_000, -1_400_000, "2024-12-31"))
        self.assertEqual((f["bankers"], f["auditor"], f["signatory"]), (["HSBC"], "Haysmacintyre", "J Smith"))
        self.assertEqual(f["finance_people"], [{"name": "Jane Smith", "title": "Finance Director"}])
        self.assertTrue(f["fx_risk_disclosed"])
        self.assertFalse(f["hedging_disclosed"])
        self.assertIsNone(accounts.extract_facts_from_text("Turnover 3 45 41\nNothing else")["turnover"])

    def test_millions_and_other_currencies(self):
        self.assertEqual(accounts.extract_facts_from_text("£m\nRevenue  4  182.4  170.1")["turnover"], 182_400_000)
        self.assertIsNone(accounts.extract_facts_from_text("€'000\nRevenue  4  82,400  70,100")["turnover"])

    @unittest.skipUnless(pdf.available(), "pdftotext not installed")
    def test_pdftotext_reads_a_real_pdf(self):
        text, how = pdf.to_text(make_pdf(["Profit and loss account for the year ended 31 March 2025", "",
                                          "                    2025       2024", "                   GBP'000    GBP'000",
                                          "Turnover      3     45,123     41,000"] + ["Notes to the accounts"] * 30))
        self.assertEqual(how, "pdf")
        self.assertIn("45,123", text)
        self.assertEqual(accounts.extract_facts_from_text(text.replace("GBP", "£"))["turnover"], 45_123_000)
        self.assertEqual(pdf.to_text(b"not a pdf"), ("", ""))


class TestWebsite(unittest.TestCase):
    def test_domains_and_confirmation(self):
        self.assertEqual(website.candidate_domains("ACME WINE IMPORTERS LIMITED")[:3],
                         ["https://www.acmewineimporters.co.uk/", "https://www.acmewineimporters.com/",
                          "https://www.acme-wine-importers.co.uk/"])
        self.assertEqual(website.confirms_company("Registered in England No. 1234567", "01234567", "X LTD"), "high")
        self.assertEqual(website.confirms_company("Tel 0123 4567 or 01234567890", "01234567", "X LTD"), "")
        self.assertEqual(website.confirms_company("(c) Acme Wine Importers Limited", "09", "ACME WINE IMPORTERS LIMITED"),
                         "medium")

    def test_address_printed_in_accounts_is_tried_first(self):
        self.assertEqual(website.addresses_in_text("Registered office ... www.Acme-Group.co.uk | www.gov.uk/x | "
                                                    "visit www.acme-group.co.uk"), ["https://www.acme-group.co.uk/"])
        sites = {"https://www.acme-group.co.uk/": ("https://www.acme-group.co.uk/", "Acme Wine Limited, company 1234567")}
        found = website.look_up_many([("01234567", "ACME WINE LIMITED", ["https://www.acme-group.co.uk/"])], sites.get)
        self.assertEqual(found["01234567"]["website"], "https://www.acme-group.co.uk/")  # not guessable from the name

    def test_lookalike_domain_is_rejected_and_robots_respected(self):
        sites = {"https://www.acmewine.co.uk/": ("https://www.acmewine.co.uk/",
                                                 '<a href="/team">Team</a> Some other Acme, Tel 01234 567890'),
                 "https://www.acmewine.co.uk/team": ("https://www.acmewine.co.uk/team", "Jo Bloggs, Finance Director")}
        self.assertEqual(website.look_up("01234567", "ACME WINE LIMITED", sites.get, pause=0)["website"], "")
        sites["https://www.acmewine.co.uk/"] = ("https://www.acmewine.co.uk/", '<a href="/team">Team</a> Company no 1234567')
        sites["https://www.acmewine.co.uk/robots.txt"] = ("https://www.acmewine.co.uk/robots.txt", "User-agent: *\nDisallow: /team")
        found = website.look_up("01234567", "ACME WINE LIMITED", sites.get, pause=0)
        self.assertEqual((found["website"], found["confidence"], found["people"]), ("https://www.acmewine.co.uk/", "high", []))


class TestWebsiteSitemap(unittest.TestCase):
    def test_team_page_found_through_the_sitemap(self):
        home = "https://www.acmewine.co.uk/"
        index = ('<sitemapindex><sitemap><loc>https://www.acmewine.co.uk/post-sitemap.xml</loc></sitemap>'
                 '<sitemap><loc>https://www.acmewine.co.uk/page-sitemap.xml</loc></sitemap></sitemapindex>')
        pages = ('<urlset><url><loc>https://www.acmewine.co.uk/shop</loc></url>'
                 '<url><loc>https://acmewine.co.uk/about-us/our-leadership-team/</loc></url></urlset>')
        sites = {home: (home, "Acme Wine Limited, company 1234567. <a href='/shop'>Shop</a>"),
                 home + "robots.txt": (home + "robots.txt", "User-agent: *\nSitemap: https://www.acmewine.co.uk/sitemap_index.xml"),
                 home + "sitemap_index.xml": ("", index), home + "page-sitemap.xml": ("", pages),
                 "https://acmewine.co.uk/about-us/our-leadership-team/": ("", "Jo Bloggs, Finance Director")}
        asked = []
        fetcher = lambda url: asked.append(url) or sites.get(url)
        found = website.look_up("01234567", "ACME WINE LIMITED", fetcher, pause=0)
        self.assertEqual(found["people"], [{"name": "Jo Bloggs", "title": "Finance Director"}])
        self.assertNotIn(home + "post-sitemap.xml", asked)        # only the pages sitemap of the index
        # a team page linked from the homepage: no sitemap read
        sites[home] = (home, "Acme Wine Limited, company 1234567. <a href='/our-team'>Our team</a>")
        asked.clear()
        website.look_up("01234567", "ACME WINE LIMITED", fetcher, pause=0)
        self.assertFalse(any("sitemap" in u for u in asked))


class TestWebsiteNeverStopsTheRun(unittest.TestCase):
    def test_relative_sitemap_address_and_bad_sites(self):
        # The 29 and 30 Oct finder runs died on "Sitemap: /sitemap.xml" in a robots.txt ("unknown url type").
        self.assertIsNone(website.fetch("/sitemap.xml"))
        home = "https://www.acmewine.co.uk/"
        sites = {home: (home, "Acme Wine Limited, company 1234567"),
                 home + "robots.txt": (home + "robots.txt", "User-agent: *\nSitemap: /sitemap.xml"),
                 home + "sitemap.xml": ("", "<urlset><url><loc>/about/our-team</loc></url></urlset>"),
                 home + "about/our-team": ("", "Jo Bloggs, Finance Director")}
        asked = []
        found = website.look_up("01234567", "ACME WINE LIMITED", lambda u: asked.append(u) or sites.get(u), pause=0)
        self.assertIn(home + "sitemap.xml", asked)
        self.assertEqual(found["people"], [{"name": "Jo Bloggs", "title": "Finance Director"}])

        def broken(url):
            raise ValueError(f"unknown url type: {url!r}")
        out = website.look_up_many([("01234567", "ACME WINE LIMITED")], broken)
        self.assertEqual(out["01234567"]["website"], "")             # that company skipped, the run carries on

    def test_malformed_links_relative_child_sitemaps_and_robots(self):
        home = "https://www.acmewine.co.uk/"
        # a link urllib can't parse is skipped, not fatal for the company
        self.assertEqual(website.team_links("<a href='http://[oops'>Team</a><a href='/team'>Team</a>", home),
                         [home + "team"])
        sites = {home: (home, "Acme Wine Limited, company 1234567"),
                 home + "robots.txt": (home + "robots.txt", "User-agent: *\nSitemap: /maps/index.xml"),
                 home + "maps/index.xml": (home + "maps/index.xml",
                                           "<sitemapindex><sitemap><loc>pages.xml</loc></sitemap></sitemapindex>"),
                 home + "maps/pages.xml": ("", "<urlset><url><loc>/about/our-team?a=1&amp;b=2</loc></url></urlset>"),
                 home + "about/our-team?a=1&b=2": ("", "Jo Bloggs, Finance Director")}
        found = website.look_up("01234567", "ACME WINE LIMITED", sites.get, pause=0)
        self.assertEqual(found["people"], [{"name": "Jo Bloggs", "title": "Finance Director"}])
        # /sitemap.xml (not named by robots.txt) is not read when robots.txt disallows it
        sites[home + "robots.txt"] = (home + "robots.txt", "User-agent: *\nDisallow: /sitemap.xml")
        asked = []
        website.look_up("01234567", "ACME WINE LIMITED", lambda u: asked.append(u) or sites.get(u), pause=0)
        self.assertNotIn(home + "sitemap.xml", asked)


class TestFormerFinanceDirector(unittest.TestCase):
    def test_kept_from_the_same_officers_call(self):
        items = {"items": [
            {"name": "ROE, Sam", "officer_role": "director", "occupation": "Managing Director", "appointed_on": "2001-01-01"},
            {"name": "LEE, Amy", "officer_role": "director", "occupation": "Finance Director", "appointed_on": "2015-01-01",
             "resigned_on": "2026-03-31"},
            {"name": "OLD, Bob", "officer_role": "director", "occupation": "Sales Director", "resigned_on": "2025-01-01"},
            {"name": "SEC, Pat", "officer_role": "secretary", "occupation": "Chief Financial Officer", "resigned_on": "2024-01-01"},
        ]}
        with mock.patch.object(companies_house, "_get", return_value=items), mock.patch.object(companies_house, "_throttle"):
            active, former = companies_house.get_officers_and_former("01234567", "k")
        self.assertEqual([o["name"] for o in active], ["Sam Roe"])
        self.assertEqual(former, [{"name": "Amy Lee", "occupation": "Finance Director", "resigned_on": "2026-03-31"}])
        # the no-FD flag stands down when the company had an FD on the board
        row = {"finance_contact_role": "Finance Manager", "turnover_gbp": "30000000"}
        self.assertTrue(confirm.no_fd_reason(row))
        self.assertEqual(confirm.no_fd_reason({**row, "former_finance_director": "Amy Lee (Finance Director), left the board 2026-03-31"}), "")


class TestRoles(unittest.TestCase):
    PEOPLE = [
        {"name": "A", "occupation": "Company Director", "appointed_on": "2001-01-01"},
        {"name": "B", "occupation": "Managing Director", "appointed_on": "2010-01-01"},
        {"name": "C", "occupation": "Chief Financial Officer", "appointed_on": "2022-01-01"},
    ]

    def test_classify(self):
        self.assertEqual(roles.classify_role("Finance Director"), (1, "Finance Director"))
        self.assertEqual(roles.classify_role("Chartered Accountant"), (1, "Accountant"))
        self.assertEqual(roles.classify_role("Company Director"), (3, "Director"))
        self.assertIsNone(roles.classify_role(""))

    def test_finance_and_lead(self):
        finance = roles.pick_finance_director(self.PEOPLE)
        self.assertEqual(finance["name"], "C")
        self.assertEqual(roles.pick_lead_director(self.PEOPLE, exclude=finance)["name"], "B")
        self.assertIsNone(roles.pick_finance_director(self.PEOPLE[:2]))
        self.assertEqual(roles.pick_lead_director([self.PEOPLE[0]])["name"], "A")
        self.assertIsNone(roles.pick_lead_director([]))


class TestRequestOptions(unittest.TestCase):
    def test_valid(self):
        opts = main.options_from_request({"niches": "european-wine-importers, spirits-importers", "max_per_sic": "5",
                                          "min_turnover": 20_000_000, "turnover_check": False, "max_enrich": 50})
        self.assertEqual(opts, {"niche_ids": ["european-wine-importers", "spirits-importers"], "max_per_sic": 5,
                                "min_turnover": 20_000_000, "turnover_check": False, "max_enrich": 50})
        self.assertEqual(main.options_from_request({})["min_turnover"], 25_000_000)
        self.assertEqual(main.options_from_request({"own_bank": " Barclays "})["own_bank"], "Barclays")

    def test_invalid(self):
        for body in ([], {"niches": ["no-such-niche"]}, {"max_per_sic": 0}, {"max_enrich": "lots"},
                     {"min_turnover": -1}, {"niches": 7}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                main.options_from_request(body)


def search_answer(*results):
    """A Search1API JSON answer: (url, title, snippet) results, in its REST shape."""
    return json.dumps({"results": [{"title": t, "link": u, "snippet": s} for u, t, s in results]})


FAIRBURN = "L.J. FAIRBURN AND SON LIMITED"
ALAN = ("https://uk.linkedin.com/in/metcalfealan", "Alan Metcalfe - Finance Director at LJ Fairburn & Son Limited",
        "I am involved in a wide range of corporate finance transactions.")
DANIEL = ("https://uk.linkedin.com/in/daniel-fairburn-1", "Daniel Fairburn - Managing Director, Farmer at LJ ...",
          "Managing Director. LJ Fairburn & Son Ltd. Jan 2000 - Present")
COMPANY_PAGE = ("https://uk.linkedin.com/company/l-j-fairburn", "L J Fairburn & Son Limited | LinkedIn",
                "Vicki Taylor. Head of Finance, L J Fairburn & So Ltd ; Alan Metcalfe. Finance Director at LJ Fairburn & Son…")


class TestMostSeniorFinanceContact(unittest.TestCase):
    def test_titles_and_order(self):
        for title in ("VP, Finance", "V.P. Finance", "Director – Finance", "Group FD", "Finance & Operations Director"):
            self.assertTrue(people.is_finance_director(title), title)
        for title in ("Financial Controller", "Chief Accountant", "Finance Manager", "Director", "Accountant"):
            self.assertFalse(people.is_finance_director(title), title)
        self.assertTrue(people.is_finance_title("Chief Accountant"))
        page = "Our team: Jane Smith, Finance Manager. John Brown, Finance Director. Amy Lee, Financial Controller."
        self.assertEqual([p["name"] for p in people.finance_people(page)], ["John Brown", "Amy Lee", "Jane Smith"])

    def test_most_senior_across_sources_not_the_first_source(self):
        officers = [{"name": "Pat Jones", "role": "Director", "occupation": "Finance Manager", "appointed_on": "2015-01-01"},
                    {"name": "Sam Roe", "role": "Director", "occupation": "Managing Director", "appointed_on": "2001-01-01"}]
        website = [{"name": "John Brown", "title": "Finance Director"}]
        accounts = [{"name": "Amy Lee", "title": "Financial Controller"}]
        # the board "Finance Manager" no longer stops the search: the website's FD wins
        pick = people.choose_finance_contact(officers, accounts, website)
        self.assertEqual((pick["name"], pick["role"], pick["source"]), ("John Brown", "Finance Director", "company website: listed as Finance Director"))
        # a controller elsewhere ties with a board director filed with a finance occupation: the board director stays
        pick = people.choose_finance_contact(officers, accounts, [])
        self.assertEqual((pick["name"], pick["source"]), ("Pat Jones", "Companies House occupation"))
        # a board FD is taken straight away
        fd = [{**officers[0], "occupation": "Finance Director"}, officers[1]]
        self.assertEqual(people.choose_finance_contact(fd, accounts, website)["name"], "Pat Jones")
        # with no finance director on the board, the most senior title any source gives
        plain = [{**officers[0], "occupation": "Director"}, officers[1]]
        self.assertEqual(people.choose_finance_contact(plain, accounts, [{"name": "Jo Bell", "title": "Finance Manager"}])["name"],
                         "Amy Lee")


class TestConfirmation(unittest.TestCase):
    ROW = {"company_number": "01182857", "company_name": FAIRBURN, "untapped_reasons": "x",
           "finance_contact": "Daniel James Fairburn", "finance_contact_role": "Director",
           "finance_contact_confidence": "Guess", "finance_contact_evidence": "Companies House: director since 2001"}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patcher = mock.patch.object(profiles, "CACHE_DIR", tmp.name)  # never the real cache
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_reading_search_results(self):
        results = profiles.parse(search_answer(ALAN, DANIEL, COMPANY_PAGE,
                                               ("https://pe.linkedin.com/company/l-j-fairburn", COMPANY_PAGE[1], COMPANY_PAGE[2]),
                                               ("https://uk.linkedin.com/in/jeff", "Jeff Fairburn - Chief Executive - Berkeley DeVeer", "")))
        self.assertEqual(len(results), 4)  # the second country copy of the company page is dropped
        found = {p["name"]: p for p in profiles.people_in_results(results, FAIRBURN)}
        self.assertEqual(sorted(found), ["Alan Metcalfe", "Daniel Fairburn", "Vicki Taylor"])  # not the namesake
        self.assertEqual((found["Alan Metcalfe"]["title"], found["Alan Metcalfe"]["url"]), ("Finance Director", ALAN[0]))
        self.assertEqual(found["Daniel Fairburn"]["title"], "Managing Director, Farmer")
        self.assertEqual(found["Vicki Taylor"]["title"], "Head of Finance")
        # The MCP's shape (url/text) reads the same; something else is not a results answer.
        mcp = json.dumps({"results": [{"title": ALAN[1], "url": ALAN[0], "text": ALAN[2]}]})
        self.assertEqual(profiles.parse(mcp), [ALAN])
        self.assertIsNone(profiles.parse('{"error": "insufficient credits"}'))
        self.assertEqual(profiles.queries_for(FAIRBURN)[0], "L.J. Fairburn And Son finance director")

    def test_other_sites_and_roles(self):
        board = ("https://www.cjlang.co.uk/about-us/directors", "Board of Directors & Executives - CJ Lang",
                 "Finance Director Chris Boyle Finance Director Frank McCarron, Company Owned Stores Director")
        org = ("https://rocketreach.co/cj-lang", "CJ Lang & Son Limited Management Team",
               "The CJ Lang & Son Limited management team includes. Chris Boyle (Financial Director), and Paula Middleton.")
        found = profiles.people_in_results(profiles.parse(search_answer(board, org)), "C.J. LANG & SON LIMITED")
        self.assertEqual([(p["name"], p["sites"]) for p in found], [("Chris Boyle", ["cjlang.co.uk", "rocketreach.co"])])
        about = ("https://forrestfoods.com/about-us", "About Us - Forrest Fresh Foods",
                 "Chris Craven. Managing Director ; Shona Craven. Accounts Director")
        mine = ("https://uk.linkedin.com/in/chris-craven", "Chris Craven - Forrest Fresh Foods Ltd | LinkedIn", "")
        found = {p["name"]: p for p in profiles.people_in_results(profiles.parse(search_answer(mine, about)),
                                                                  "FORREST FRESH FOODS LIMITED")}
        self.assertEqual(found["Chris Craven"]["title"], "Managing Director")  # headline was only the employer

    def test_namesakes_and_headline_words_are_not_people(self):
        # The company's name must appear as a phrase: "Forrest" alone is another firm.
        self.assertEqual(profiles.company_phrases("MORRIS & SON (LEEDS) LIMITED"), ["morris and son"])
        self.assertEqual(profiles.company_phrases(FAIRBURN), ["lj fairburn"])
        self.assertEqual(profiles.company_phrases("DUNNS FOOD & DRINKS LIMITED"), ["dunns food and drinks", "dunns food"])
        self.assertTrue(profiles.mentions_company("Finance Director at L J Fairburn & Son", FAIRBURN))
        self.assertTrue(profiles.mentions_company("Our team", "BRINDISA LIMITED", "https://www.brindisa.com/team"))
        other = ("https://www.linkedin.com/in/sg", "Scott Goodrich - Chief Financial Officer - Forrest Lumber | LinkedIn", "")
        abroad = ("https://kr.linkedin.com/in/jr", "Jungki Ro - CFO at Korea Foods | LinkedIn", "")
        junk = ("https://news.example.com/x", "Brand Factory IPO Divisional CFO",
                "Brand Factory Vice President, Chief Financial Officer")
        dunns = ("https://news.example.com/y", "Scottish wholesale moves",
                 "Dunns Food & Drinks Gordon Wallace, Finance Manager. " + "Elsewhere in the trade... " * 6 +
                 "Brand Factory named Jane Doe as Finance Director.")
        ron = ("https://www.linkedin.com/in/ron-wall", "Ron Wall, MBA - Chief Financial Officer - Lomond Fine Foods", "")
        stop = ("https://uk.linkedin.com/company/brindisa", "Brindisa | LinkedIn",
                "Finance Director Ratnesh Bagdai. Linton Rees, Head Chef")
        results = profiles.parse(search_answer(other, abroad, junk, dunns, ron, stop))
        self.assertEqual(profiles.people_in_results(results, "FORREST FRESH FOODS LIMITED"), [])
        self.assertEqual(profiles.people_in_results(results, "KOREA FOODS COMPANY LIMITED"), [])
        self.assertEqual([p["name"] for p in profiles.people_in_results(results, "BRAND FACTORY LIMITED")],
                         ["Jane Doe"])  # not the Dunns person named earlier in the same round-up
        self.assertEqual([p["name"] for p in profiles.people_in_results(results, "DUNNS FOOD & DRINKS LIMITED")],
                         ["Gordon Wallace"])
        self.assertEqual([p["name"] for p in profiles.people_in_results(results, "LOMOND FINE FOODS LIMITED")],
                         ["Ron Wall"])
        self.assertEqual([p["name"] for p in profiles.people_in_results(results, "BRINDISA LIMITED")],
                         ["Ratnesh Bagdai"])

    def test_trading_name_sites_letters_and_past_jobs(self):
        own = ("https://www.fairburnseggs.co.uk/news", "News - Fairburn´s Eggs",
               "Fairburn’s Eggs finance director scoops top award. Alan Metcalfe, our finance director, has been recognised")
        self.assertEqual([(p["name"], p["title"]) for p in profiles.people_in_results([own], FAIRBURN)],
                         [("Alan Metcalfe", "Finance Director")])   # the company's site under its trading name
        cff = "CLASSIC FINE FOODS UK LIMITED"
        site = ("https://classicfinefoods.co.uk/about-us", "Classic Fine Foods",
                "#### Kolitha Wickramasekera Finance & Administration Director Kolitha brings over 20 years")
        leaver = ("https://uk.linkedin.com/in/hg", "Himanshu Gandhi -FCCA - Director of Finance and ...",
                  "Headline: Director of Finance and Administration at Classic Fine Foods UK Ltd Available "
                  "Immediately Location: London")
        moved = ("https://uk.linkedin.com/in/mi", "Malinka I. - Malinka Ivanova FCCA",
                 "## Experience - Financial Controller at Finalto (Feb 2025 to present) - Finance Manager at "
                 "Classic Fine Foods UK (2019 to 2021)")
        moved2 = ("https://uk.linkedin.com/in/mi2", "Jo Smith - Accountant",
                  "## Experience - Financial Controller at Finalto (Feb 2025 to present) - Finance Manager at "
                  "Classic Fine Foods UK (2019 to 2021)")
        found = {p["name"]: p for p in profiles.people_in_results(profiles.parse(search_answer(site, leaver, moved, moved2)), cff)}
        self.assertEqual(sorted(found), ["Himanshu Gandhi", "Jo Smith", "Kolitha Wickramasekera"])  # not "Malinka I"
        self.assertEqual(found["Kolitha Wickramasekera"]["title"], "Finance & Administration Director")
        self.assertFalse(found["Himanshu Gandhi"]["current"])   # open to work
        self.assertFalse(found["Jo Smith"]["current"])          # works elsewhere now
        directory = ("https://leadiq.com/c/hyperama", "Hyperama Company Overview",
                     "Mobile Phone Email Finance Director at Hyperama F. P. Finance Director")
        self.assertEqual(profiles.people_in_results([directory], "HYPERAMA PLC"), [])
        self.assertEqual(profiles.clean_person("Photo' Chris Boyle", "C.J. LANG & SON LIMITED"), "Chris Boyle")
        self.assertEqual(profiles.clean_person("Jim Rowan Jim Rowan", "DUNNS FOOD & DRINKS LIMITED"), "Jim Rowan")
        self.assertEqual(people.finance_people("Mr. Joaquim Bauló Miralles - Chief Financial Officer"),
                         [{"name": "Joaquim Bauló Miralles", "title": "Chief Financial Officer"}])

    def test_finance_director_over_controller(self):
        fc = ("https://uk.linkedin.com/in/ds", "Devinder Shinh - Financial Controller at Natco Foods", "")
        fd = ("https://www.natcofoods.com/team", "Our team - Natco Foods", "Amit Parekh, Finance Director")
        asked = []

        def fetcher(query, key):
            asked.append(query)
            return search_answer(fc, fc) if len(asked) == 1 else search_answer(fd)
        found, _ = profiles.finance_team_many([("00782674", "NATCO FOODS LIMITED")], fetcher=fetcher, pause=0, key="k")
        self.assertEqual(len(asked), 2)   # a controller alone: the second wording looks for the FD
        row = {**self.ROW, "company_name": "NATCO FOODS LIMITED"}
        row, _ = confirm.confirm_row(row, found["00782674"])
        self.assertEqual((row["finance_contact"], row["finance_contact_role"]), ("Amit Parekh", "Finance Director"))
        row, _ = confirm.confirm_row({**self.ROW, "company_name": "NATCO FOODS LIMITED"},
                                     profiles.people_in_results(profiles.parse(search_answer(fc)), "NATCO FOODS LIMITED"))
        self.assertIn("no finance director named", row["search_check"])
        self.assertTrue(people.is_finance_director("Finance & Administration Director"))
        self.assertFalse(people.is_finance_director("Financial Controller"))

    def test_trading_names(self):
        tradelink = "THE TRADELINK INTERNATIONAL GROUP LIMITED"
        about = ("The TradeLink International Group Ltd, trading as The BakeRite Company, is an experienced importer "
                 "and distributor.")
        self.assertEqual(profiles.trading_names(about, tradelink), ["The BakeRite Company"])
        self.assertEqual(profiles.trading_names("Acme Foods Ltd t/a Sunny Snacks Ltd.", "ACME FOODS LIMITED"),
                         ["Sunny Snacks"])
        self.assertEqual(profiles.trading_names("Acme Foods Limited, trading as Acme Foods.", "ACME FOODS LIMITED"), [])
        self.assertEqual(profiles.trading_names("trading as normal throughout the year", "ACME FOODS LIMITED"), [])
        # the auditor's trading name is not the company's; a name stops at a line break
        self.assertEqual(profiles.trading_names("Sterling Audit Services Limited trading as Sterling Chartered "
                                                "Accountants and Statutory Auditors", "SHANA FOODS LIMITED"), [])
        self.assertEqual(profiles.trading_names("trading as Noble\n\t\tStrategic Report", "VILLAGE LIMITED"), ["Noble"])

    def test_common_first_word_is_not_the_companys_website(self):
        def own(name, site):
            return profiles._own_site(f"https://{site}", profiles.company_phrases(name))
        self.assertFalse(own("VILLAGE QUALITY PRODUCTS LIMITED", "villagemd.com"))   # a US healthcare firm
        self.assertFalse(own("HT DRINKS LTD", "drinks.com"))
        self.assertTrue(own("L.J. FAIRBURN AND SON LIMITED", "fairburnseggs.co.uk"))
        self.assertTrue(own("FAYREFIELD FOODS LIMITED", "fayrefield.com"))

    def test_search_under_the_trading_name(self):
        tradelink = "THE TRADELINK INTERNATIONAL GROUP LIMITED"
        about = ("https://bakerite.co.uk/about-us/", "About Us - The BakeRite Company",
                 "The TradeLink International Group Ltd, trading as The BakeRite Company, is an experienced importer.")
        fd = ("https://uk.linkedin.com/in/pat-lane", "Pat Lane - Finance Director at The BakeRite Company", "")
        left = ("https://uk.linkedin.com/in/sam-moss", "Sam Moss - Finance & Operations Director at Plant Plan",
                "Experience: Plant Plan ... Group Chief Financial Officer. The BakeRite Company. Apr 2025 - Jul 2026")
        asked = []

        def fetcher(query, key):
            asked.append(query)
            return search_answer(about) if len(asked) == 1 else search_answer(fd, left)
        found, _ = profiles.finance_team_many([("06629663", tradelink)], fetcher=fetcher, pause=0, key="k")
        self.assertEqual(asked[1], "The BakeRite Company finance director")
        self.assertEqual(len(asked), 2)   # the FD turned up under the trading name: no third search
        team = {p["name"]: p for p in found["06629663"]}
        self.assertTrue(team["Pat Lane"]["current"])
        self.assertFalse(team["Sam Moss"]["current"])   # the headline puts them at another company now
        row, outcome = confirm.confirm_row({**self.ROW, "company_name": tradelink, "finance_contact": "",
                                            "finance_contact_confidence": ""}, found["06629663"])
        self.assertEqual((row["finance_contact"], outcome), ("Pat Lane", "found where we had nobody"))
        self.assertIn("under trading name The BakeRite Company", row["search_check"])
        # a trading name from the accounts is searched even when the first results don't mention it
        asked.clear()
        found, _ = profiles.finance_team_many([("1", "ACME FOODS LIMITED", ["Sunny Snacks"])],
                                              fetcher=lambda q, k: asked.append(q) or search_answer(), pause=0, key="k")
        self.assertEqual(asked, ["Acme Foods finance director", "Sunny Snacks finance director",
                                 '"Acme Foods" CFO OR FD OR "director of finance" OR "head of finance"'])

    def test_provider_checks_say_why_without_results(self):
        answers = {"api.search1api.com": (200, '{"error": "Invalid API key"}'), "api.tavily.com": (401, ""),
                   "api.exa.ai": (200, json.dumps({"results": [{"title": "t", "url": "u", "text": "s"}]}))}
        env = {"SEARCH1API_KEY": "a", "TAVILY_API_KEY": "b", "EXA_API_KEY": "c"}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(profiles, "_post", lambda url, h, b: answers[url.split("/")[2]]):
            status = profiles.check_providers()
        self.assertEqual(status, {"search1api": "HTTP 200 without results (keys: error; Invalid API key)",
                                  "tavily": "HTTP 401", "exa": "ok (1 results)"})
        self.assertEqual(profiles.describe_failure(0, ""), "timeout or network error")
        self.assertEqual(profiles.describe_failure(403, '{"message": "Invalid API key"}'), "HTTP 403 (Invalid API key)")
        self.assertIn("likely blocked", profiles.describe_failure(403, "<!DOCTYPE html><html><title>Attention</title>"))

    def test_most_named_person_replaces_a_guess(self):
        found = [{"name": "Old Cfo", "title": "Chief Financial Officer", "url": "", "current": True,
                  "sites": ["news.example.com"], "source": "news.example.com"},
                 {"name": "Alan Metcalfe", "title": "Finance Director", "url": ALAN[0], "current": True,
                  "sites": ["linkedin.com", "ljfairburn.co.uk"], "source": profiles.LINKEDIN}]
        row, outcome = confirm.confirm_row(dict(self.ROW), found)
        self.assertEqual((row["finance_contact"], row["finance_contact_confidence"], outcome),
                         ("Alan Metcalfe", "Verified", "replaced the guess"))

    def test_providers_rotate_retry_and_keep_allowances(self):
        calls = []
        blips = iter([(0, ""), (503, "")])      # Tavily: a timeout and a server error, then fine

        def post(url, headers, body):
            calls.append(url.split("/")[2])
            if "search1api" in url:
                return 200, '{"error": "insufficient credits"}'   # out of credit: next provider, no retries
            if "tavily" in url:
                return next(blips, (200, json.dumps({"results": [{"title": ALAN[1], "url": ALAN[0], "content": ALAN[2]}]})))
            return 200, json.dumps({"organic": [{"title": ALAN[1], "link": ALAN[0], "snippet": ALAN[2]}]})
        env = {"SEARCH1API_KEY": "a", "TAVILY_API_KEY": "b", "TAVILY_MONTHLY": "1", "SERPER_API_KEY": "c"}
        with mock.patch.dict(os.environ, env), mock.patch.object(profiles, "_post", post), \
                mock.patch.object(profiles, "_failed", set()), mock.patch.object(profiles, "_strikes", {}), \
                mock.patch.object(profiles, "RETRY_PAUSE", 0):
            self.assertEqual(profiles.parse(profiles.fetch_any("q1")), [ALAN])   # Search1API out -> Tavily, after 2 retries
            self.assertEqual(profiles.parse(profiles.fetch_any("q2")), [ALAN])   # Tavily's 1/month used -> Serper
        self.assertEqual(calls, ["api.search1api.com", "api.tavily.com", "api.tavily.com", "api.tavily.com",
                                 "google.serper.dev"])
        self.assertEqual(profiles.usage(), {"tavily": 1, "serper": 1})  # only answered searches count

    def test_flaky_provider_still_fills_the_daily_budget(self):
        rnd = random.Random(3)

        def post(url, headers, body):
            x = rnd.random()
            if x < 0.1:
                return 0, ""                      # timeout
            if x < 0.15:
                return 503, ""                    # server error
            return 200, json.dumps({"results": [{"title": ALAN[1], "url": ALAN[0], "content": ""}]})
        rows = [{**self.ROW, "company_number": str(i), "company_name": f"ACME {i} TRADING LIMITED"} for i in range(60)]
        with mock.patch.dict(os.environ, {"TAVILY_API_KEY": "b"}), mock.patch.object(profiles, "_post", post), \
                mock.patch.object(profiles, "_failed", set()), mock.patch.object(profiles, "_strikes", {}), \
                mock.patch.object(profiles, "RETRY_PAUSE", 0):
            _, stats = confirm.confirm_rows(rows, pause=0, max_searches=90)
        self.assertEqual(stats["search budget of 90 searches reached"], 1)
        self.assertEqual(profiles.usage(), {"tavily": 90})

    def test_confirm_row_outcomes(self):
        team = profiles.people_in_results(profiles.parse(search_answer(ALAN, DANIEL, COMPANY_PAGE)), FAIRBURN)
        # The search shows our "Director" guess is the MD, and names the FD: he replaces it.
        row, outcome = confirm.confirm_row(dict(self.ROW), team)
        self.assertEqual((row["finance_contact"], row["finance_contact_confidence"], outcome),
                         ("Alan Metcalfe", "Confirmed", "replaced a wrong pick"))
        self.assertIn("earlier pick: Daniel James Fairburn (Director)", row["finance_contact_evidence"])
        self.assertIn("finance+director", row["verify_finance_contact_url"])
        self.assertEqual(row["finance_contact_linkedin"], ALAN[0])
        row, outcome = confirm.confirm_row({**self.ROW, "finance_contact": "Alan Metcalfe"}, team)
        self.assertEqual((row["finance_contact_confidence"], outcome), ("Verified", "agrees"))
        row, outcome = confirm.confirm_row({**self.ROW, "finance_contact": "Vicki Taylor",
                                            "finance_contact_confidence": "Confirmed"}, team)
        self.assertEqual(outcome, "agrees")  # a Head of Finance pick agreeing is kept, not swapped
        row, outcome = confirm.confirm_row({**self.ROW, "finance_contact": "Pat Jones"}, team)
        self.assertEqual((row["finance_contact"], outcome), ("Alan Metcalfe", "replaced the guess"))  # FD beats Head of Finance
        row, outcome = confirm.confirm_row(dict(self.ROW), [])
        self.assertEqual((row["search_check"], outcome), ("no finance person found", "nobody found"))
        # A Confirmed controller / manager we picked gives way when the search names a current FD; kept in the evidence.
        for role in ("Financial Controller", "Finance Manager"):
            row, outcome = confirm.confirm_row({**self.ROW, "finance_contact": "Pat Jones", "finance_contact_role": role,
                                                "finance_contact_confidence": "Confirmed"}, team)
            self.assertEqual((row["finance_contact"], outcome), ("Alan Metcalfe", "replaced a controller / manager with the FD"))
            self.assertIn(f"earlier pick: Pat Jones ({role})", row["finance_contact_evidence"])
        row, outcome = confirm.confirm_row({**self.ROW, "finance_contact": "Pat Jones", "finance_contact_role": "CFO",
                                            "finance_contact_confidence": "Confirmed"}, team)
        self.assertEqual((row["finance_contact"], outcome), ("Pat Jones", "kept our pick, search names another"))  # an FD stays

    def test_group_fd_found_under_the_parent(self):
        controller = ("https://uk.linkedin.com/in/kim", "Kim Hart - Financial Controller at Brindle Foods", "")
        group_fd = ("https://uk.linkedin.com/in/lee", "Lee Park - Group Finance Director at Halden Holdings", "")
        asked = []

        def fetcher(query, key):
            asked.append(query)
            return search_answer(group_fd) if "Halden" in query else search_answer(controller)
        row = {**self.ROW, "company_name": "BRINDLE FOODS LIMITED", "finance_contact": "", "finance_contact_role": "",
               "finance_contact_confidence": "", "group_parent": "HALDEN HOLDINGS LIMITED (01234567)"}
        out, stats = confirm.confirm_rows([row], fetcher=fetcher, pause=0, key="k")
        self.assertEqual(len(asked), 3)                              # two wordings, then one under the parent
        self.assertIn("Halden Holdings finance director", asked[-1])
        self.assertEqual((out[0]["finance_contact"], out[0]["finance_contact_role"]), ("Lee Park", "Group Finance Director"))
        self.assertIn("at the parent company HALDEN HOLDINGS LIMITED", out[0]["search_check"])
        self.assertEqual(confirm.parent_name("HALDEN HOLDINGS LIMITED (01234567)"), "HALDEN HOLDINGS LIMITED")
        # an FD at the company itself: no parent search
        asked.clear()
        fd_here = ("https://uk.linkedin.com/in/ann", "Ann Cole - Finance Director at Tarrant Foods", "")
        profiles_fetch = lambda query, key: asked.append(query) or search_answer(fd_here)
        out, _ = confirm.confirm_rows([{**row, "company_number": "99", "company_name": "TARRANT FOODS LIMITED"}],
                                      fetcher=profiles_fetch, pause=0, key="k")
        self.assertEqual((len(asked), out[0]["finance_contact"]), (1, "Ann Cole"))

    def test_probably_no_fd(self):
        row = {"finance_contact": "Jo Bell", "finance_contact_role": "Finance Manager", "turnover_gbp": "32000000",
               "family_run": "same surname on the board"}
        self.assertEqual(confirm.no_fd_reason(row),
                         "no finance director in the register, accounts, website or search; £32m turnover, no parent company; "
                         "family-run; the MD likely decides on FX — Jo Bell (Finance Manager) likely makes the payments")
        self.assertEqual(confirm.no_fd_reason({**row, "finance_contact_role": "Finance Director"}), "")   # an FD
        self.assertEqual(confirm.no_fd_reason({**row, "turnover_gbp": "80000000"}), "")                  # too big
        self.assertEqual(confirm.no_fd_reason({**row, "group_parent": "HALDEN HOLDINGS LIMITED"}), "")    # group FD
        self.assertEqual(confirm.no_fd_reason({**row, "turnover_gbp": ""}), "")                           # size unknown
        self.assertTrue(confirm.no_fd_reason({"turnover_gbp": "30000000"}).endswith("the MD likely decides on FX"))

    def test_neediest_first_and_confirmed_fds_skipped(self):
        rows = [{**self.ROW, "company_number": "1", "company_name": "TARRANT FOODS LIMITED",   # its own search (not cached)
                 "finance_contact": "Pat Jones", "finance_contact_role": "Finance Manager",
                 "finance_contact_confidence": "Confirmed"},
                {**self.ROW, "company_number": "2"},                                          # a Guess
                {**self.ROW, "company_number": "3", "finance_contact": "Kim Fox", "finance_contact_role": "Finance Director",
                 "finance_contact_confidence": "Confirmed"}]
        asked = []
        fetcher = lambda query, key: asked.append(query) or search_answer(ALAN)
        out, stats = confirm.confirm_rows(rows, fetcher=fetcher, pause=0, key="k", max_searches=1)
        self.assertEqual(len(asked), 1)
        self.assertEqual([r["finance_contact"] for r in out], ["Pat Jones", "Alan Metcalfe", "Kim Fox"])   # the guess went first
        self.assertEqual((stats["to check"], stats["not searched: FD already confirmed"]), (2, 1))

    def test_confirm_rows_budget_cache_and_skips(self):
        rows = [dict(self.ROW), {**self.ROW, "company_number": "2", "untapped_reasons": "not checked"},
                {**self.ROW, "company_number": "3", "finance_contact_confidence": "Verified"},
                {**self.ROW, "company_number": "4", "qualified": "Out"}]
        asked = []
        fetcher = lambda query, key: asked.append(query) or search_answer(ALAN, DANIEL)
        out, stats = confirm.confirm_rows(rows, fetcher=fetcher, pause=0, key="k")
        self.assertEqual([r["finance_contact"] for r in out],
                         ["Alan Metcalfe", "Daniel James Fairburn", "Daniel James Fairburn", "Daniel James Fairburn"])
        self.assertEqual(stats["to check"], 1)   # not checked, already Verified and qualified Out are skipped
        self.assertEqual(len(asked), 1)  # one company; the first wording found the FD
        self.assertEqual((stats["replaced a wrong pick"], stats["Guess -> Confirmed"]), (1, 1))
        confirm.confirm_rows([dict(self.ROW)], fetcher=fetcher, pause=0, key="k")
        self.assertEqual(len(asked), 1)  # cached: no second credit spent
        _, stats = confirm.confirm_rows([{**self.ROW, "company_name": "OTHER CO LIMITED"}], fetcher=fetcher, pause=0,
                                        key="k", max_searches=0)
        self.assertEqual(stats["search budget of 0 searches reached"], 1)
        self.assertEqual(profiles.finance_team_many([("1", FAIRBURN)], key="")[1], "no search API key")
        self.assertEqual(confirm.fields_with_confirmation(["a", "finance_contact_evidence", "b"]),
                         ["a", "finance_contact_evidence", "search_check", "finance_contact_linkedin", "no_fd_likely", "b"])


class TestCsvAndConfig(unittest.TestCase):
    def test_csv_columns(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "out.csv")
            main.write_csv([main.new_row(company_name="WINE CO LIMITED", finance_contact="Jane Smith")], path)
            with open(path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                self.assertEqual(reader.fieldnames, main.CSV_FIELDS)
                self.assertEqual(next(reader)["finance_contact"], "Jane Smith")
        for gone in ("email", "phone", "tier"):  # no personal emails or phone numbers
            self.assertNotIn(gone, main.CSV_FIELDS)

    def test_excel_workbook(self):
        rows = [main.new_row(section=main.SECTION_CORE, company_name="ACME & WINES LIMITED", company_number="01234567",
                             finance_contact="Jane Smith", turnover_gbp="45000000", untapped_reasons="family-run",
                             verify_finance_contact_url="https://www.google.com/search?q=%22a%22&x=1", triggers="new\x0bowner"),
                main.new_row(section=main.SECTION_ABOVE, company_name="BIG CO LIMITED", company_number="SC123456",
                             untapped_reasons="not checked")]
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "out.xlsx")
            main.write_output(rows, path)
            with zipfile.ZipFile(path) as z:
                parts = {name: z.read(name).decode() for name in z.namelist()}
        for name, xml in parts.items():
            if name.endswith((".xml", ".rels")):
                ET.fromstring(xml)  # well-formed (control characters stripped, & escaped)
        sheets = re.findall(r'<sheet name="([^"]+)"', parts["xl/workbook.xml"])
        self.assertEqual(sheets, ["Checked", main.SECTION_CORE, main.SECTION_ABOVE, "About"])
        checked = parts["xl/worksheets/sheet1.xml"]
        self.assertIn("ACME &amp; WINES LIMITED", checked)
        self.assertNotIn("BIG CO", checked)  # unchecked rows only on their section tab
        self.assertIn("<v>45000000</v>", checked)  # money is a number, not text
        self.assertIn("Google check", checked)
        self.assertIn('Target="https://www.google.com/search?q=%22a%22&amp;x=1"', parts["xl/worksheets/_rels/sheet1.xml.rels"])
        self.assertEqual(excel.header("fx_wallet_high_gbp"), "FX wallet high (£)")

    def test_niches_copy_matches_call_list_generator(self):
        source = os.path.join(ROOT, "..", "call-list-generator", "niches.json")
        if not os.path.exists(source):
            self.skipTest("call-list-generator/niches.json not alongside (standalone deploy)")
        with open(source, "rb") as a, open(main.DEFAULT_NICHES_FILE, "rb") as b:
            self.assertEqual(a.read(), b.read(), "config/fx_niches.json has drifted — copy it across again")


def _serve(test, handler_class):
    """Serve handler_class on a free localhost port for the test's lifetime; returns the base URL."""
    httpd = HTTPServer(("127.0.0.1", 0), handler_class)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    test.addCleanup(httpd.server_close)
    test.addCleanup(httpd.shutdown)  # cleanups run last-in first-out: stop serving, then close
    return f"http://127.0.0.1:{httpd.server_address[1]}"


def _request(url, body=None):
    """(status, parsed JSON or raw bytes) — straight to localhost, ignoring any proxy env."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=10) as resp:
            status, raw, ctype = resp.status, resp.read(), resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        status, raw, ctype = e.code, e.read(), e.headers.get("Content-Type", "")
    return status, json.loads(raw) if "json" in ctype else raw


class TestHttpFrontEnds(unittest.TestCase):
    def setUp(self):
        for patcher in (mock.patch.dict(os.environ, {"TRIGGER_TOKEN": "", "CH_BULK_FILE": ""}),
                        mock.patch.object(server.Handler, "log_message", lambda *a: None),
                        mock.patch.object(api_run.handler, "log_message", lambda *a: None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_server_niches_validation_and_run(self):
        base = _serve(self, server.Handler)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = os.path.join(tmp.name, "leads.csv")
        row = main.new_row(company_name="WINE CO LIMITED")
        with mock.patch.object(server, "OUTPUT_DIR", tmp.name), mock.patch.object(server, "OUTPUT_PATH", out), \
             mock.patch.object(main, "run_pipeline", return_value=[row]) as run:
            status, body = _request(base + "/niches")
            self.assertEqual(status, 200)
            self.assertEqual(len(body["niches"]), 73)

            status, body = _request(base + "/run", {"niches": ["no-such-niche"]})
            self.assertEqual(status, 400)
            self.assertIn("no-such-niche", body["error"])

            status, _ = _request(base + "/run", {"niches": ["european-wine-importers"]})
            self.assertEqual(status, 202)
            for _ in range(50):
                if _request(base + "/status")[1]["status"] != "running":
                    break
                time.sleep(0.05)
            self.assertEqual(_request(base + "/status")[1]["status"], "done")
            run.assert_called_once_with(niche_ids=["european-wine-importers"], max_per_sic=None, min_turnover=25_000_000,
                                        turnover_check=True, max_enrich=None, source="api")
            status, csv_bytes = _request(base + "/leads.csv")
            self.assertEqual(status, 200)
            self.assertTrue(csv_bytes.decode().startswith(",".join(main.CSV_FIELDS)))

    def test_api_requires_niches_and_uses_search_source(self):
        base = _serve(self, api_run.handler)
        with mock.patch.object(main, "run_pipeline", return_value=[]) as run:
            status, body = _request(base + "/api/run")
            self.assertEqual(status, 200)
            self.assertEqual(len(body["niches"]), 73)

            status, body = _request(base + "/api/run", {"min_turnover": 20_000_000})
            self.assertEqual(status, 400)
            self.assertIn("name the niches", body["error"])
            run.assert_not_called()

            status, _ = _request(base + "/api/run", {"niches": ["spirits-importers"]})
            self.assertEqual(status, 200)
            run.assert_called_once_with(niche_ids=["spirits-importers"], max_per_sic=api_run.SERVERLESS_DEFAULT_MAX_PER_SIC,
                                        min_turnover=25_000_000, turnover_check=True, max_enrich=None, source="api")


if __name__ == "__main__":
    unittest.main()


class TestAccountsJson(unittest.TestCase):
    def test_only_checked_companies_in_order(self):
        from tools.to_accounts_json import accounts
        rows = [{"company_name": "A LTD", "section": "Core (£25m–£250m)", "untapped_reasons": "family-run", "website": ""},
                {"company_name": "B LTD", "section": "Core (£25m–£250m)", "untapped_reasons": "not checked"},
                {"company_name": "C LTD", "section": "Above (£250m+)", "untapped_reasons": "x"}]
        data = accounts(rows, made_at="2026-10-21T06:00:00+00:00")
        self.assertEqual([(r["company_name"], r["rank"]) for r in data["rows"]], [("A LTD", 1), ("C LTD", 2)])
        self.assertNotIn("website", data["rows"][0])          # empty fields left out
        self.assertEqual(data["sections"], ["Core (£25m–£250m)", "Above (£250m+)"])
        self.assertEqual(data["count"], 2)


class TestHooks(unittest.TestCase):
    TODAY = date(2026, 10, 21)
    NICHE = {"id": "chinese-electronics", "name": "Asian Electronics Importers", "currency_pairs": ["USD/GBP"],
             "exposure_reason": "UK distributors buy components from Chinese factories in USD."}
    FACTS = {"format": "ixbrl", "period_end": "2026-03-31", "filed_on": "2026-10-03",
             "turnover": 58_123_456, "turnover_prior": 46_900_000, "fx_gain_loss": -312_456, "fx_gain_loss_prior": 5_100}

    def test_hooks_in_priority_order_with_sources(self):
        officers = [{"name": "Sarah Jones", "role": "Director", "occupation": "Chief Financial Officer",
                     "appointed_on": "2026-09-02"},
                    {"name": "Old Hand", "role": "Director", "occupation": "Finance Director", "appointed_on": "2019-01-01"}]
        charges = [{"name": "HSBC UK Bank PLC", "created_on": "2026-01-14", "status": "outstanding"}]
        owners = [{"kind": "corporate", "name": "Fresh Holdings BV", "country": "Netherlands", "ceased_on": ""}]
        found = hooks.find_hooks(self.FACTS, officers, charges, owners, today=self.TODAY)
        self.assertEqual([h["kind"] for h in found], ["charge", "officer", "fx", "growth", "group", "filed"])  # bank first
        self.assertIn("HSBC UK Bank PLC (Companies House charges register)", found[0]["detail"])
        self.assertEqual(found[1]["detail"], "Sarah Jones appointed director 2 Sep 2026, occupation Chief Financial Officer "
                                             "(Companies House officers)")
        self.assertEqual(found[2]["detail"], "£312,456 foreign exchange loss, year to 31 Mar 2026; year before: £5,100 gain "
                                             "(filed accounts, year to 31 Mar 2026, tagged figure)")
        self.assertIn("up 23% from £46,900,000", found[3]["detail"])          # 23.9% is rounded down, never up
        self.assertIn("registered in Netherlands (Companies House PSC register)", found[4]["detail"])
        self.assertEqual(found[5]["detail"], "Accounts for the year to 31 Mar 2026 filed 3 Oct 2026 (Companies House filing history)")
        cols = hooks.columns("ACME ELECTRONICS LIMITED", self.FACTS, officers, charges, owners, self.NICHE, today=self.TODAY)
        # bank fact first, then the FX figure (the pitch in two facts), and an opener that leads with the bank
        self.assertEqual((cols["fact_1"], cols["fact_2"]), (found[0]["detail"], found[2]["detail"]))
        self.assertEqual(cols["opener"], "Saw a new charge to HSBC UK Bank PLC went on the register in January 2026, and "
                                         "your accounts show a £312k FX loss for the year to March 2026 — worth looking "
                                         "at the FX alongside the banking.")

    def test_incumbent_bank_facility_and_fx_today(self):
        text = ("The company has a revolving credit facility of £10m with HSBC UK Bank plc which expires on 31 March 2027. "
                "The facility was renewed in March 2024. The company uses forward foreign exchange contracts to hedge "
                "its US dollar purchases.")
        facts = {"format": "ixbrl", "period_end": "2025-12-31", **incumbent.text_evidence(text)}
        debenture = {"name": "HSBC UK Bank PLC", "created_on": "2022-10-14", "status": "outstanding",
                     "classification": "A registered charge", "particulars": "", "floating_all": True, "floating": True}
        forklifts = {"name": "Close Brothers Limited", "created_on": "2024-06-01", "status": "outstanding",
                     "classification": "A registered charge", "particulars": "Plant and machinery",
                     "floating_all": False, "floating": False}
        cols = incumbent.columns(facts, [debenture, forklifts], self.TODAY)
        self.assertEqual(cols["incumbent_bank"], "HSBC: all-assets debenture since 14 Oct 2022 (Companies House charges register)")
        self.assertIn("Close Brothers Limited: asset finance, registered 1 Jun 2024", cols["lenders"])
        self.assertEqual(cols["facility_ends"], "31 Mar 2027")
        self.assertIn("which expires on 31 March 2027", cols["facility_ends_evidence"])
        self.assertEqual(cols["fx_today"], "Uses forward contracts")
        found = hooks.find_hooks(facts, [], [debenture, forklifts], [], today=self.TODAY)
        self.assertEqual([h["kind"] for h in found], ["facility_end", "bank_since"])
        self.assertEqual(found[0]["lead"], "Saw in your accounts the facility runs to 31 March 2027")
        self.assertIn("HSBC UK Bank PLC has held an all-assets debenture since 14 Oct 2022, 4 years ago", found[1]["detail"])
        # how they do FX today: the FD's own words, negations respected; a broker holding a charge wins
        self.assertEqual(incumbent.text_evidence("The company does not use forward contracts to hedge.")["fx_policy"]["policy"],
                         "Doesn't hedge")
        invoice_arm = {**debenture, "name": "HSBC Invoice Finance (UK) Ltd", "created_on": "2024-01-01"}
        self.assertIn("since 14 Oct 2022", incumbent.columns(facts, [invoice_arm, debenture], self.TODAY)["incumbent_bank"])
        supplier = {**debenture, "name": "Lifecycle Oils LTD (In Administration)", "created_on": "2025-12-12"}
        person = {**debenture, "name": "Raymond Paul Cornelius", "created_on": "2026-02-02"}
        self.assertEqual([h["kind"] for h in hooks.find_hooks({}, [], [supplier, person], [], today=self.TODAY)], [])
        ebury = {**forklifts, "name": "Ebury Partners UK Limited", "particulars": ""}
        self.assertEqual(incumbent.columns(facts, [ebury], self.TODAY)["fx_today"], "Uses an FX provider: Ebury")
        self.assertIn("Estimate, not a filed figure: roughly £43.7m–£94.4m",
                      hooks.size_estimate(43_700_000, 94_400_000, "imports 40–80% of cost of sales"))

    def test_thresholds_and_blanks(self):
        small = {**self.FACTS, "fx_gain_loss": -49_999, "turnover_prior": 50_000_000, "filed_on": "2026-08-01"}
        old = [{"name": "A B", "role": "Director", "occupation": "Finance Director", "appointed_on": "2026-07-01"}]
        stale = [{"name": "Bank", "created_on": "2025-10-01", "status": "outstanding"}]
        self.assertEqual(hooks.find_hooks(small, old, stale, [], today=self.TODAY), [])   # each just outside its rule
        with mock.patch.dict(hooks.HOOK_RULES, {"fx_gain_loss_min_gbp": 40_000}):
            self.assertEqual([h["kind"] for h in hooks.find_hooks(small, [], [], [], today=self.TODAY)], ["fx"])
        blank = hooks.columns("X LTD", None, [], [], [], {"id": "_hmrc_trader", "currency_pairs": []}, today=self.TODAY)
        self.assertEqual(set(blank.values()), {""})                                       # nothing qualifies: all blank
        self.assertEqual(set(blank), set(hooks.COLUMNS))

    def test_currency_rules_strongest_first(self):
        text = ("Purchases from suppliers in China are denominated in US dollars. The company also pays some US dollar "
                "freight. Sales are made in sterling. Euro Quality Lambs Limited trades. ")
        facts = {**self.FACTS, **hooks.text_evidence(text)}
        exp = hooks.currency_exposure("EURO QUALITY LAMBS LIMITED", facts, [], self.NICHE)
        self.assertEqual((exp["currency"], exp["direction"], exp["confidence"], exp["rule"]),
                         ("USD", hooks.BUYS, hooks.HIGH, "text"))
        self.assertIn('"Purchases from suppliers in China are denominated in US dollars"', exp["evidence"])
        regions = {**facts, "regions": [{"region": "United Kingdom", "value": 40e6}, {"region": "Europe", "value": 12_345_678}]}
        exp = hooks.currency_exposure("X LTD", regions, [], self.NICHE)
        self.assertEqual((exp["currency"], exp["direction"], exp["confidence"]), ("EUR", hooks.SELLS, hooks.HIGH))
        self.assertIn("Turnover from Europe: £12,345,678 of £58,123,456 total", exp["evidence"])
        owners = [{"kind": "corporate", "name": "Nippon Parts KK", "country": "Japan", "ceased_on": ""}]
        exp = hooks.currency_exposure("X LTD", {"format": "pdf"}, owners, self.NICHE)
        self.assertEqual((exp["currency"], exp["confidence"], exp["direction"]), ("JPY", hooks.MEDIUM, hooks.UNKNOWN))
        customs = {"imports": "EUR 64%, USD 21%", "exports": "EUR 58%", "import_months": 12, "export_months": 1}
        exp = hooks.currency_exposure("X LTD", {}, [], self.NICHE, customs)
        self.assertEqual((exp["currency"], exp["direction"], exp["confidence"], exp["rule"]),
                         ("EUR", hooks.BOTH, hooks.MEDIUM, "customs"))   # customs beat the niche default
        self.assertIn("imports EUR 64%, USD 21% (12 of the last 12 months)", exp["evidence"])
        self.assertEqual(hooks.opener([], exp), "Saw from the customs records that you've imported every month and "
                                                "exported in 1 of the last 12 months, so the pound's moves hit you either "
                                                "way.")   # each flow's own count; no (estimated) currency named
        exp = hooks.currency_exposure("X LTD", {}, [], self.NICHE)
        self.assertEqual((exp["currency"], exp["direction"], exp["confidence"]), ("USD", hooks.BUYS, hooks.LOW))
        group = hooks.text_evidence("The ultimate parent undertaking is Fresh BV, a company incorporated in the "
                                    "Netherlands. Its subsidiaries are registered in England and Wales.")
        self.assertEqual([(g["relation"], g["country"]) for g in group["group_abroad"]], [("parent", "Netherlands")])
        self.assertEqual(hooks.text_evidence("<xbrli:measure>iso4217:USD</xbrli:measure>")["currency_mentions"], [])
        self.assertEqual(hooks.text_evidence("All vehicles are EURO 6 standard.")["currency_mentions"], [])
        self.assertEqual([m["code"] for m in hooks.text_evidence("Paid in Euro 500,000 and €2m.")["currency_mentions"]],
                         ["EUR", "EUR"])

    def test_opener_uses_only_detail_facts(self):
        found = hooks.find_hooks({**self.FACTS, "turnover_prior": None, "filed_on": ""}, [], [], [], today=self.TODAY)
        exposure = {"currency": "USD", "direction": hooks.BUYS, "confidence": hooks.HIGH, "rule": "text"}
        self.assertEqual(hooks.opener(found, exposure),
                         "Saw your accounts show a £312k FX loss for the year to March 2026, and with dollar purchases "
                         "in the mix, a falling pound makes every invoice dearer.")
        low = {**exposure, "confidence": hooks.LOW}                     # a niche guess never reaches the opener
        self.assertNotIn("dollar", hooks.opener(found, low))
        sells = {**exposure, "direction": hooks.SELLS}
        self.assertIn("a rising pound", hooks.opener([], sells))       # exporters worry about the pound rising
        self.assertEqual(hooks.opener([], low), "")
        self.assertEqual(hooks.short(58_199_999), "£58.1m")             # rounded down, never up

    def test_accounts_evidence_from_pdf_text(self):
        text = ("Strategic report\nPurchases are mainly invoiced in euros.\n                £'000     £'000\n"
                "Turnover         57,423    51,100\n"
                "Turnover by geographical market\n                 2026      2025\n"
                "United Kingdom   45,123    41,000\nEurope           12,300    10,100\nAsia                856     1,234\n"
                "United Kingdom corporation tax   1,234   1,100\n")
        facts = accounts.extract_facts_from_text(text, "2026-03-31")
        self.assertEqual(facts["regions"][1], {"region": "Europe", "value": 12_300_000})
        self.assertEqual([m["code"] for m in facts["currency_mentions"]], ["EUR"])
        exp = hooks.currency_exposure("X LTD", facts, [], self.NICHE)
        self.assertEqual((exp["rule"], exp["currency"]), ("geography", "EUR"))   # rule 1 beats rule 2
        self.assertEqual(facts["regions"][2], {"region": "Asia", "value": 856_000})   # 3-digit cell, this year's column
        self.assertEqual(len(facts["regions"]), 3)                                 # the tax line isn't a region
        self.assertEqual(accounts._regions_from_text(text.split("\f"), turnover=None), [])   # no total: no regions
        self.assertEqual(accounts._regions_from_text(text.split("\f"), turnover=1_000_000), [])  # region > company

    def test_review_fixes(self):
        ev = hooks.text_evidence
        self.assertEqual([m["code"] for m in ev("Purchases are paid in Chinese yuan. Also renminbi.")["currency_mentions"]],
                         ["CNY", "CNY"])
        self.assertEqual([m["code"] for m in ev("The company paid euros 2 million to suppliers.")["currency_mentions"]],
                         ["EUR"])
        self.assertEqual(ev("All vehicles are Euro VI standard.")["currency_mentions"], [])
        owned = ev("The company is a wholly owned subsidiary of Foo GmbH, a company incorporated in Germany.")
        self.assertEqual([(g["relation"], g["country"]) for g in owned["group_abroad"]], [("parent", "Germany")])
        theirs = ev("The parent company's subsidiaries are incorporated in France.")
        self.assertEqual(theirs["group_abroad"], [])
        long = "Word " * 120 + "Purchases are denominated in        US dollars" + " and more" * 80 + ". Next."
        self.assertIn("US dollars", ev(long)["currency_mentions"][0]["sentence"])   # the match survives trimming
        usa = [{"kind": "corporate", "name": "Acme Inc", "country": "USA", "ceased_on": ""}]
        self.assertIn("registered in USA", hooks.find_hooks({}, [], [], usa, today=self.TODAY)[0]["detail"])


class TestQualify(unittest.TestCase):
    def test_out_check_yes_and_warm_routes(self):
        from sourcer import qualify
        german = [{"kind": "corporate", "name": "Acme GmbH", "country": "Germany", "ceased_on": ""}]
        q = qualify.assess(german, {}, {"confidence": "High"}, "", 12, False, "", "")
        self.assertEqual((q["qualified"], q["qualify_reason"]),
                         ("Out", "owned by Acme GmbH (Germany): FX likely run by group treasury abroad"))
        q = qualify.assess([], {}, {"confidence": "Low"}, "", 0, False, "", "")
        self.assertEqual(q["qualified"], "Out")                                   # niche default only
        self.assertEqual(qualify.assess([], {}, {"confidence": "Low"}, "", 6, False, "", "")["qualified"], "Yes")  # customs
        big4 = {"auditor": "KPMG", "auditor_tier": "Big Four"}
        q = qualify.assess([], big4, {"confidence": "High"}, "Uses forward contracts", 12, False, "", "")
        self.assertEqual(q["qualified"], "Check")
        self.assertEqual(qualify.assess([], {"net_assets": -250_000}, {"confidence": "High"}, "", 12, False, "", "")
                         ["qualify_reason"], "net liabilities of £250,000 in the latest accounts")
        with mock.patch.dict(os.environ, {"WARM_AUDITORS": "Shaw Gibbs, Menzies"}):
            q = qualify.assess([], {"auditor": "Shaw Gibbs"}, {"confidence": "High"}, "", 12, True, "Investec", "Lmuk Bidco Limited")
        self.assertEqual(q["warm_route"], "existing Investec relationship (charge or bankers line); private-equity backed "
                                          "(Lmuk Bidco Limited): route in through the sponsor; auditor Shaw Gibbs is an introducer")
        with mock.patch.dict(qualify.QUALIFY_RULES, {"out_foreign_parent": False}):
            self.assertEqual(qualify.assess(german, {}, {"confidence": "High"}, "", 12, False, "", "")["qualified"], "Yes")


class TestReviewFixesIncumbent(unittest.TestCase):
    TODAY = date(2026, 10, 22)

    def test_going_concern_until_is_not_a_facility_end(self):
        text = ("The directors have prepared cash flow forecasts for the period until 31 December 2027 which show that "
                "the company can operate within its existing banking facilities.")
        self.assertEqual(incumbent.text_evidence(text)["facility_dates"], [])
        real = "The revolving credit facility expires on 31 March 2027."
        self.assertEqual([d["date"] for d in incumbent.text_evidence(real)["facility_dates"]], ["2027-03-31"])

    def test_hedgers_with_speculative_boilerplate_still_use_forwards(self):
        text = ("The company uses forward foreign exchange contracts to manage currency risk; these are not used for "
                "speculative purposes. The company does not use derivative financial instruments for speculative purposes.")
        self.assertEqual(incumbent.text_evidence(text)["fx_policy"]["policy"], "Uses forward contracts")
        only_boilerplate = "The company does not use derivative financial instruments for speculative purposes."
        self.assertEqual(incumbent.text_evidence(only_boilerplate)["fx_policy"], {})
        self.assertEqual(incumbent.text_evidence("Forward contracts are not used.")["fx_policy"], {})

    def test_everyday_words_are_not_fx_providers(self):
        self.assertEqual(incumbent.text_evidence("We aim to extend our global reach across Europe.")["fx_providers"], [])
        self.assertEqual(incumbent.text_evidence("Payments are made through Ebury.")["fx_providers"][0]["name"], "Ebury")

    def test_past_and_vague_dates_dont_open_a_call(self):
        def facts(when):
            return {"facility_dates": [{"date": when, "written": when, "sentence": "The RCF expires"}]}
        self.assertIsNone(incumbent.next_facility_end(facts("2026-10-01"), self.TODAY))          # already passed
        self.assertIsNone(incumbent.next_facility_end(facts("2026-09"), self.TODAY))
        self.assertIsNotNone(incumbent.next_facility_end(facts("2026-10"), self.TODAY))         # runs to 31 Oct
        self.assertIsNone(incumbent.next_facility_end(facts("2026"), self.TODAY))                # this year: may have passed
        self.assertEqual(hooks.find_hooks(facts("2028"), [], [], [], today=self.TODAY), [])      # a bare year never opens
        self.assertEqual(incumbent.text_evidence("The loan facility is repayable on 15/31/2027.")["facility_dates"], [])
        self.assertEqual([d["date"] for d in incumbent.text_evidence(
            "The loan facility is repayable on 31/03/2027.")["facility_dates"]], ["2027-03-31"])

    def test_accounting_policy_wording_is_not_using_forwards(self):
        policy = ("Other financial liabilities Derivatives, including interest rate swaps and forward foreign exchange "
                  "contracts, are not basic financial instruments.")
        self.assertEqual(incumbent.text_evidence(policy)["fx_policy"], {})
        used = policy + " The group manages its euro purchases with forward foreign exchange contracts."
        self.assertIn("euro purchases", incumbent.text_evidence(used)["fx_policy"]["sentence"])

    def test_bare_forward_contracts_need_currency_context(self):
        shipping = ("The group has entered forward contracts that fix the costs of shipping sea containers from China "
                    "at least three months in advance.")
        self.assertEqual(incumbent.text_evidence(shipping)["fx_policy"], {})
        materials = "Forward contracts for raw materials, diesel and natural gas have been used to limit cost increases."
        self.assertEqual(incumbent.text_evidence(materials)["fx_policy"], {})
        fx = ("Foreign currency risk. The group buys stock in US dollars. The exposure is monitored by the board and "
              "managed using forward contracts.")
        self.assertEqual(incumbent.text_evidence(fx)["fx_policy"]["policy"], "Uses forward contracts")
        self.assertEqual(incumbent.text_evidence(
            "Using forward contracts to mitigate exchange variances.")["fx_policy"]["policy"], "Uses forward contracts")

    def test_interest_rate_wording_and_negated_natural_hedge(self):
        interest = ("The company does not use derivative financial instruments to manage interest rate costs and as such, "
                    "no hedge accounting is applied.")
        self.assertEqual(incumbent.text_evidence(interest)["fx_policy"], {})
        fx = "The company does not use derivative financial instruments to manage foreign currency transactions."
        self.assertEqual(incumbent.text_evidence(fx)["fx_policy"]["policy"], "Doesn't hedge")
        negated = "Sterling flows are not naturally hedged at company level but are managed at group level."
        self.assertEqual(incumbent.text_evidence(negated)["fx_policy"], {})

    def test_intercompany_loan_is_not_a_bank_facility(self):
        text = ("In respect of Intercompany loan notes becoming due for repayment on 31 July 2025; the repayment date has "
                "been renegotiated after the year end and extended to 31 July 2030.")
        self.assertEqual(incumbent.text_evidence(text)["facility_dates"], [])

    def test_charge_holder_initialisms(self):
        self.assertEqual(companies_house.holder_name("Hsbc UK Bank PLC"), "HSBC UK Bank PLC")
        self.assertEqual(companies_house.holder_name("Rbs  Invoice Finance Limited"), "RBS Invoice Finance Limited")
        self.assertEqual(companies_house.holder_name("Lloyds Bank PLC"), "Lloyds Bank PLC")

    def test_old_debenture_is_outside_the_renewal_window(self):
        old = {"name": "HSBC UK Bank PLC", "created_on": "2004-03-01", "status": "outstanding", "classification": "",
               "particulars": "", "floating_all": True, "floating": True}
        self.assertEqual(hooks.find_hooks({}, [], [old], [], today=self.TODAY), [])
        recent = {**old, "created_on": "2022-06-01"}
        self.assertEqual([h["kind"] for h in hooks.find_hooks({}, [], [recent], [], today=self.TODAY)], ["bank_since"])

    def test_a_finance_director_leaving_the_board_is_a_trigger(self):
        company = {"company_name": "ACME LIMITED", "company_number": "01234567", "accounts_category": "full",
                   "sic_codes": ["46900"]}
        left = [{"name": "Amy Lee", "occupation": "Finance Director", "resigned_on": "2026-03-31"}]
        row = main.company_row({"id": "x", "name": "N", "currency_pairs": []}, company, None, [], True,
                               facts={}, owners=[], charges=[], today=date(2026, 10, 28), former_fd=left)
        self.assertIn("finance director Amy Lee left the board 2026-03", row["triggers"])
        self.assertEqual(row["former_finance_director"], "Amy Lee (Finance Director), left the board 2026-03-31")
        long_ago = [{**left[0], "resigned_on": "2024-01-31"}]
        row = main.company_row({"id": "x", "name": "N", "currency_pairs": []}, company, None, [], True,
                               facts={}, owners=[], charges=[], today=date(2026, 10, 28), former_fd=long_ago)
        self.assertNotIn("left the board", row["triggers"])
        self.assertTrue(row["former_finance_director"])

    def test_warm_route_names_the_runs_own_bank(self):
        company = {"company_name": "ACME LIMITED", "company_number": "01234567", "accounts_category": "full",
                   "sic_codes": ["46900"]}
        with mock.patch.dict(os.environ, {"OWN_BANK": "Investec"}):
            row = main.company_row({"id": "x", "name": "N", "currency_pairs": []}, company, None, [], True,
                                   facts={}, owners=[], charges=[], today=self.TODAY,
                                   bank={"own_bank": True}, own_bank_name="Barclays")
        self.assertIn("existing Barclays relationship", row["warm_route"])
