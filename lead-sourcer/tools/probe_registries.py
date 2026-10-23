#!/usr/bin/env python3
"""
tools/probe_registries.py — one-off check of three gov.uk registries that
name a person at a company: gender pay gap reports ("responsible person"),
payment practices reports ("approved by" director) and modern slavery
statements (signed by a director). Run on GitHub; the dev sandbox can't
reach them.

Prints structure and counts only — page links, column names, how many rows
fill each column, the most common job titles, and how many of an earlier
run's checked companies each registry covers (and how often its person is
the same as ours). Never a person's name: Actions logs here are readable.

    python3 tools/probe_registries.py earlier/fx_companies.csv
"""

from __future__ import annotations

import csv
import io
import os
import re
import sys
import urllib.parse
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import people  # noqa: E402
from tools.probe_sources import fetch, section  # noqa: E402

REGISTRIES = {
    "Gender pay gap": ["https://gender-pay-gap.service.gov.uk/viewing/download"],
    "Payment practices": ["https://check-payment-practices.service.gov.uk/",
                          "https://check-payment-practices.service.gov.uk/search",
                          "https://check-payment-practices.service.gov.uk/export"],
    "Modern slavery statements": ["https://modern-slavery-statement-registry.service.gov.uk/",
                                  "https://modern-slavery-statement-registry.service.gov.uk/search",
                                  "https://modern-slavery-statement-registry.service.gov.uk/download"],
}
DOWNLOAD_WORDS = re.compile(r"download|export|\.csv|csv", re.I)
MAX_FILES = 3
PERSONISH = re.compile(r"responsible|approv|sign|director|person|name", re.I)
NUMBER_COL = re.compile(r"company.?number|companynumber|registration.?number|crn", re.I)


def our_companies(path: str) -> dict[str, dict]:
    """{company_number: row} for the companies an earlier run checked in full."""
    with open(path, newline="", encoding="utf-8") as f:
        return {r["company_number"].upper(): r for r in csv.DictReader(f) if r.get("untapped_reasons") != "not checked"}


def download_links(url: str) -> list[str]:
    status, ctype, body = fetch(url)
    print(f"{url} -> HTTP {status} {ctype[:40]} {len(body):,} bytes")
    links = []
    html = body.decode("utf-8", "replace")
    for href, text in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S | re.I):
        text = re.sub(r"<[^>]+>|\s+", " ", text).strip()
        if DOWNLOAD_WORDS.search(href) or DOWNLOAD_WORDS.search(text):
            full = urllib.parse.urljoin(url, href)
            if full not in links:
                links.append(full)
                print(f"  link: {text[:60]!r} -> {full[:150]}")
    return links


def normalise_number(value: str) -> str:
    value = value.strip().upper()
    return value.zfill(8) if value.isdigit() else value


def describe_csv(url: str, ours: dict[str, dict]) -> bool:
    status, ctype, body = fetch(url, limit=80_000_000)
    print(f"\n  {url[:150]} -> HTTP {status} {ctype[:40]} {len(body):,} bytes")
    if status != 200 or not body or b"<html" in body[:500].lower():
        return False
    text = body.decode("utf-8-sig", "replace")
    try:
        rows = list(csv.DictReader(io.StringIO(text)))
    except csv.Error as e:
        print(f"  not a CSV: {e}")
        return False
    if not rows:
        return False
    cols = list(rows[0].keys())
    print(f"  rows: {len(rows):,}")
    print(f"  columns: {cols}")
    filled = {c: sum(bool((r.get(c) or "").strip()) for r in rows) for c in cols}
    print("  filled:", {c: n for c, n in filled.items()})
    number_col = next((c for c in cols if NUMBER_COL.search(c or "")), None)
    for c in cols:
        if c and PERSONISH.search(c):
            values = [(r.get(c) or "").strip() for r in rows if (r.get(c) or "").strip()]
            titles = Counter(m.group(1).strip().title() for v in values for m in [re.search(r"\(([^)]+)\)\s*$", v)] if m)
            finance = sum(bool(people._FINANCE_TITLE_RE.search(v)) for v in values)
            print(f"  person-like column {c!r}: {len(values):,} filled; with a '(job title)': {sum(titles.values()):,}; "
                  f"with a finance title: {finance:,}")
            if titles:
                print(f"    top job titles: {titles.most_common(15)}")
    if number_col and ours:
        by_number: dict[str, list[dict]] = {}
        for r in rows:
            by_number.setdefault(normalise_number(r.get(number_col) or ""), []).append(r)
        hit = [n for n in ours if n in by_number]
        print(f"  our checked companies covered (by {number_col!r}): {len(hit)} of {len(ours)}")
        for c in cols:
            if c and PERSONISH.search(c):
                same = finance = 0
                for n in hit:
                    value = (by_number[n][-1].get(c) or "").strip()
                    name = re.sub(r"\s*\([^)]*\)\s*$", "", value)
                    same += bool(ours[n].get("finance_contact")) and people.same_person(name, ours[n]["finance_contact"])
                    finance += bool(people._FINANCE_TITLE_RE.search(value))
                print(f"    {c!r} on our companies: same person as our pick {same}, finance title {finance}")
    return True


def main() -> None:
    ours = our_companies(sys.argv[1]) if len(sys.argv) > 1 else {}
    print(f"Checked companies from the earlier run: {len(ours)}")
    for name, pages in REGISTRIES.items():
        section(name)
        links = []
        for page in pages:
            links += [link for link in download_links(page) if link not in links]
        tried = 0
        for link in links:
            if tried >= MAX_FILES:
                break
            if re.search(r"\.csv|download-data|export|csv", link, re.I):
                tried += describe_csv(link, ours)


if __name__ == "__main__":
    main()
