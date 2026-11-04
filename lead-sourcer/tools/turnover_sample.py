#!/usr/bin/env python3
"""
tools/turnover_sample.py — why the finder has no turnover for a company:
what its latest accounts filing actually shows.

For each company: the filing's type (full / group / medium / small …) and
whether it is tagged (iXBRL), a text PDF or a scanned PDF; every tagged
turnover / revenue / cost-of-sales / gross-profit figure with its period,
dimensions (group v company), unit and scale; for PDFs, every turnover /
revenue / cost of sales / gross profit line with its page, the page's
£ / £'000 / £m heading and its column headings (Group / Company, years) —
OCR'ing scanned pages until the profit and loss account turns up; and what
the finder reads today (accounts.extract_facts*).

Accounts are public records and these lines carry no personal names, so the
output is the log only (public repo: no attachments).

    COMPANIES_HOUSE_API_KEY=... python3 tools/turnover_sample.py --accounts sample.json --max 30
    COMPANIES_HOUSE_API_KEY=... python3 tools/turnover_sample.py 00795535 SC302951
"""

from __future__ import annotations

import argparse
import glob
import html
import json
import os
import re
import sys
import tempfile
import time
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import accounts, pdf  # noqa: E402

CONCEPT = re.compile(r"turnover|revenue|costsales|costofsales|grossprofit|costofrevenue", re.I)
LINE = re.compile(r"^\s*(?:group\s+|total\s+)?(?:turnover|revenue|sales|cost\s+of\s+sales|gross\s+profit)\b", re.I | re.M)
SCALE = re.compile(r"£\s*['’`]?\s*000|£\s*k\b|£\s*thousands?|£\s*['’`]?\s*m\b|£\s*millions?|\$|€|US\$", re.I)
COLUMNS = re.compile(r"^.*\b(?:19|20)\d\d\b.*\b(?:19|20)\d\d\b.*$|^.*\bGroup\b.*\bCompany\b.*$", re.M)
PL_PAGE = re.compile(r"(?:consolidated\s+)?(?:statement\s+of\s+(?:comprehensive\s+)?income|profit\s+and\s+loss\s+account|"
                     r"income\s+statement)", re.I)
NONFRACTION = re.compile(r"<ix:nonfraction\b([^>]*)>(.*?)</ix:nonfraction>", re.I | re.S)
ATTR = re.compile(r'([\w:-]+)\s*=\s*"([^"]*)"')


def short(s: str, n: int = 150) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def tagged(document: bytes) -> list[str]:
    """Every turnover-like tagged figure: concept, period end, dimensions, unit, scale, sign, shown text."""
    text = document.decode("utf-8", "replace")
    scanner = accounts._IxbrlScanner()
    try:
        scanner.feed(text)
        scanner.close()
    except Exception:  # noqa: BLE001
        pass
    out = []
    for m in NONFRACTION.finditer(text):
        attrs = {k.lower(): v for k, v in ATTR.findall(m.group(1))}
        concept = attrs.get("name", "").rsplit(":", 1)[-1]
        if not CONCEPT.search(concept):
            continue
        ctx = scanner.contexts.get(attrs.get("contextref", ""), {})
        members = ",".join(f"{d}={v}" for d, v in ctx.get("members", [])) or "-"
        unit = scanner.units.get(attrs.get("unitref", ""), attrs.get("unitref", ""))
        shown = html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
        out.append(f"{concept} end={ctx.get('end', '?')} dims={members} unit={unit} scale={attrs.get('scale', '0')}"
                   f"{' sign=-' if attrs.get('sign') == '-' else ''} shown={shown!r}")
    return out


def page_lines(page: str, number: int) -> list[str]:
    out = []
    scale = sorted({short(s, 12) for s in SCALE.findall(page)})
    columns = [short(c, 110) for c in COLUMNS.findall(page)][:2]
    for m in LINE.finditer(page):
        line = page[m.start(): page.find("\n", m.start()) if page.find("\n", m.start()) > 0 else len(page)]
        out.append(f"p{number} [{'/'.join(scale) or 'no £ heading'}] {short(line)}")
    if out and columns:
        out.insert(0, f"p{number} columns: " + " ‖ ".join(columns))
    return out


def ocr_until_pl(data: bytes, first: int, budget_s: float) -> tuple[list[str], int]:
    """OCR pages from `first` on until the profit and loss page (and the next) or the time budget; (lines, pages read)."""
    out, read = [], 0
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "a.pdf")
        with open(path, "wb") as f:
            f.write(data)
        pages = pdf._page_count(path)
        started, found_at = time.monotonic(), 0
        for number in range(first, pages + 1):
            if time.monotonic() - started > budget_s or (found_at and number > found_at + 1):
                break
            stem = os.path.join(tmp, f"p{number}")
            pdf._run(["pdftoppm", "-r", "200", "-gray", "-f", str(number), "-l", str(number), "-png", path, stem])
            images = sorted(glob.glob(stem + "*.png"))
            text = pdf._run(["tesseract", images[0], "stdout", "--psm", "6"]) if images else ""
            read += 1
            lines = page_lines(text, number)
            if lines:
                out += lines
            if PL_PAGE.search(text) and LINE.search(text) and not found_at:
                found_at = number
                out.append(f"p{number} looks like the profit and loss account")
    return out, read


def sample(number: str, api_key: str, ocr_budget: float, stats: Counter, label: str = "") -> None:
    print(f"\n=== {number} {label}".rstrip())
    filing = accounts.latest_accounts_filing(number, api_key)
    if not filing:
        print("  no accounts filing")
        stats["no filing"] += 1
        return
    kind = (filing.get("description") or "").replace("accounts-with-accounts-type-", "")
    made_up = (filing.get("description_values") or {}).get("made_up_date") or ""
    print(f"  filing: {kind} | made up to {made_up} | filed {filing.get('date', '')} | pages {filing.get('pages', '?')}"
          f"{' | paper' if filing.get('paper_filed') else ''}")
    doc_id = ((filing.get("links") or {}).get("document_metadata") or "").rstrip("/").rsplit("/", 1)[-1]
    if not doc_id:
        print("  no document")
        stats["no document"] += 1
        return
    document = None if filing.get("paper_filed") else accounts.fetch_ixbrl(doc_id, api_key)
    if document:
        facts = accounts.extract_facts(document)
        rows = tagged(document)
        stats[f"ixbrl/{kind}"] += 1
        stats["ixbrl, finder has turnover" if facts["turnover"] else "ixbrl, finder has none"] += 1
        print(f"  ixbrl | finder reads turnover={facts['turnover']} cost_of_sales={facts['cost_of_sales']} "
              f"period_end={facts['period_end']}")
        for r in rows[:16]:
            print(f"    tag {r}")
        if not rows:
            print("    no turnover/revenue/cost/gross-profit tags at all")
            stats["ixbrl, no turnover tag"] += 1
        plain = html.unescape(re.sub(r"<[^>]*>", "\n", document.decode("utf-8", "replace")))
        text_lines = page_lines(re.sub(r"\n\s*\n+", "\n", plain), 0)
        for line in text_lines[:8]:
            print(f"    text {line}")
        return
    data = accounts.fetch_pdf(doc_id, api_key) or b""
    text, how = pdf.to_text(data)
    stats[f"{how or 'unreadable'}/{kind}"] += 1
    if not text:
        print(f"  pdf ({len(data):,} bytes): no text")
        return
    facts = accounts.extract_facts_from_text(text, made_up, how)
    stats[f"{how}, finder has turnover" if facts["turnover"] else f"{how}, finder has none"] += 1
    pages = text.split("\f")
    print(f"  {how} | {len(pages)} pages read | finder reads turnover={facts['turnover']} "
          f"cost_of_sales={facts['cost_of_sales']} period_end={facts['period_end']}")
    lines = [line for n, p in enumerate(pages, 1) for line in page_lines(p, n)]
    if how == "scanned pdf":
        more, read = ocr_until_pl(data, len(pages) + 1, ocr_budget)
        print(f"    OCR'd {read} more pages")
        lines += more
    for line in lines[:24]:
        print(f"    {line}")
    if not lines:
        print("    no turnover / revenue / cost of sales / gross profit lines")
        stats[f"{how}, no turnover line"] += 1


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("numbers", nargs="*")
    parser.add_argument("--accounts", help="accounts.json-style rows; those without turnover_gbp are sampled")
    parser.add_argument("--max", type=int, default=30)
    parser.add_argument("--ocr-budget", type=float, default=90, help="seconds of extra OCR per scanned filing")
    args = parser.parse_args()
    api_key = os.environ.get("COMPANIES_HOUSE_API_KEY", "")
    if not api_key:
        sys.exit("COMPANIES_HOUSE_API_KEY is not set")
    picks: list[tuple[str, str]] = [(n.upper(), "") for n in args.numbers]
    if args.accounts:
        with open(args.accounts, encoding="utf-8") as f:
            rows = json.load(f)
        missing = [r for r in rows if not r.get("turnover_gbp")]
        print(f"Accounts list: {len(rows):,} companies, {len(missing):,} without turnover")
        for key in ("accounts_category", "accounts_format", "section"):
            print(f"  without turnover, by {key}: {dict(Counter(r.get(key, '') or '(blank)' for r in missing).most_common())}")
        print(f"  with turnover, by accounts_format: "
              f"{dict(Counter(r.get('accounts_format', '') or '(blank)' for r in rows if r.get('turnover_gbp')).most_common())}")
        # an even spread through the list, not just the top
        step = max(1, len(missing) // max(1, args.max))
        picks += [(r["company_number"], f"{r.get('company_name', '')} [{r.get('accounts_category', '')}, "
                   f"{r.get('accounts_format', '') or 'format ?'}]") for r in missing[::step]]
    stats: Counter = Counter()
    for number, label in picks[: args.max + len(args.numbers)]:
        try:
            sample(number, api_key, args.ocr_budget, stats, label)
        except Exception as e:  # noqa: BLE001 — one bad filing shouldn't stop the sample
            print(f"  failed: {type(e).__name__}: {e}")
            stats["failed"] += 1
    print("\nSummary:")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
