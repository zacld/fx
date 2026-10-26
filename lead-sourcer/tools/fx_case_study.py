#!/usr/bin/env python3
"""
tools/fx_case_study.py — how real filings show their foreign-exchange
gain/loss, for the FX case-study library (tests/fx_cases/).

For each company number: the latest accounts. For a tagged (iXBRL) filing,
every figure whose tag name mentions exchange or currency, with its period,
scale, sign, format, the text shown and the table row it sits in. For a PDF,
the text (pdftotext, else OCR of up to --ocr-pages pages) and every line
mentioning exchange differences / gains / losses, with its page and the
page's "£'000" heading. Also what the finder currently reads (fx_gain_loss).

Accounts are public records; the FX rows carry no personal names. Output is
the log only (public repo: no attachments).

    COMPANIES_HOUSE_API_KEY=... python3 tools/fx_case_study.py 00795535 04955681 ...
"""

from __future__ import annotations

import argparse
import html
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import accounts, pdf  # noqa: E402

FX_CONCEPT = re.compile(r"exchange|currenc", re.I)
FX_LINE = re.compile(r"exchange\s+(?:rate\s+)?(?:difference|gain|loss)|foreign\s+(?:exchange|currency)\s+"
                     r"(?:gain|loss|difference|translation)|currency\s+(?:gain|loss)|"
                     r"(?:gain|loss)\w*\s+on\s+(?:foreign\s+)?(?:exchange|currency)", re.I)
TAG = re.compile(r"<[^>]+>")


def plain(fragment: str) -> str:
    return " ".join(html.unescape(TAG.sub(" ", fragment)).split())


def row_around(doc: str, start: int, end: int) -> str:
    """The table row (<tr>…</tr>) holding the tag, else 300 characters either side, as plain text."""
    tr = doc.rfind("<tr", 0, start)
    close = doc.find("</tr>", end)
    if tr != -1 and close != -1 and close - tr < 20_000 and doc.rfind("</tr>", tr, start) == -1:
        return plain(doc[tr:close])[:400]
    return plain(doc[max(0, start - 300):end + 300])[:400]


def ixbrl_case(document: bytes) -> None:
    doc = document.decode("utf-8", "replace")
    scanner = accounts._IxbrlScanner()
    scanner.feed(doc)
    shown = 0
    for m in re.finditer(r"<ix:nonFraction\b([^>]*)>(.*?)</ix:nonFraction>", doc, re.I | re.S):
        attrs = dict((k.lower(), v) for k, v in re.findall(r'([\w:-]+)="([^"]*)"', m.group(1)))
        concept = attrs.get("name", "").rsplit(":", 1)[-1]
        if not FX_CONCEPT.search(concept):
            continue
        context = scanner.contexts.get(attrs.get("contextref", ""), {})
        members = ",".join(f"{d}={v}" for d, v in context.get("members", [])) or "-"
        print(f"  TAG {concept} | end {context.get('end', '?')} | dims {members} | unit {attrs.get('unitref', '')}"
              f" | scale {attrs.get('scale', '0')} | sign {attrs.get('sign', '') or '+'}"
              f" | format {attrs.get('format', '').rsplit(':', 1)[-1]} | shown {plain(m.group(2))!r}")
        print(f"      row: {row_around(doc, m.start(), m.end())}")
        shown += 1
        if shown >= 25:
            print("  … more tags not shown")
            break
    if not shown:
        print("  no exchange/currency tags")
    for m in list(FX_LINE.finditer(plain(doc)))[:6]:
        text = plain(doc)
        print(f"  TEXT …{text[max(0, m.start() - 120):m.end() + 160]}…")


def pdf_case(data: bytes, ocr_pages: int) -> None:
    t0 = time.time()
    os.environ["OCR_MAX_PAGES"] = str(ocr_pages)
    pdf.OCR_MAX_PAGES = ocr_pages
    text, how = pdf.to_text(data)
    pages = text.split("\f")
    print(f"  {how or 'unreadable'}: {len(pages)} pages read in {time.time() - t0:.0f}s")
    found = 0
    for n, page in enumerate(pages, 1):
        heading = "£'000" if accounts._THOUSANDS_RE.search(page) else "£m" if accounts._MILLIONS_RE.search(page) else "£"
        for line in page.split("\n"):
            if FX_LINE.search(line):
                print(f"  p{n} [{heading}] {' '.join(line.split())[:220]}")
                found += 1
    if not found:
        print("  no exchange gain/loss lines")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("numbers", nargs="+")
    ap.add_argument("--ocr-pages", type=int, default=40)
    args = ap.parse_args()
    key = os.environ.get("COMPANIES_HOUSE_API_KEY", "")
    if not key:
        print("COMPANIES_HOUSE_API_KEY not set")
        return 1
    for number in args.numbers:
        number = number.strip().zfill(8)
        filing = accounts.latest_accounts_filing(number, key)
        if not filing:
            print(f"\n== {number}: no accounts filing")
            continue
        doc_id = ((filing.get("links") or {}).get("document_metadata") or "").rstrip("/").rsplit("/", 1)[-1]
        made_up = (filing.get("description_values") or {}).get("made_up_date") or ""
        print(f"\n== {number} | made up to {made_up} | {filing.get('description', '')}")
        document = None if filing.get("paper_filed") else accounts.fetch_ixbrl(doc_id, key)
        if document:
            facts = accounts.extract_facts(document)
            print(f"  finder reads: fx {facts.get('fx_gain_loss')} prior {facts.get('fx_gain_loss_prior')}"
                  f" turnover {facts.get('turnover')} cost of sales {facts.get('cost_of_sales')}")
            ixbrl_case(document)
        else:
            pdf_case(accounts.fetch_pdf(doc_id, key) or b"", args.ocr_pages)
    return 0


if __name__ == "__main__":
    sys.exit(main())
