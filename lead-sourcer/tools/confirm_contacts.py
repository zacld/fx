#!/usr/bin/env python3
"""
tools/confirm_contacts.py — the confirmation step, run after the finder
has written its list: checks each company's finance contact against public
LinkedIn profile results from a web search (sourcer/confirm.py) and writes
an Excel workbook. 
Searches go through Search1API (Google results, 1 credit each; set
SEARCH1API_KEY). Runs anywhere — in the finder workflow, or by hand:

    set SEARCH1API_KEY=...        (Windows; export on Mac/Linux)
    python tools/confirm_contacts.py companies.csv --top 25 --show

companies.csv: the finder's fx_companies.csv, or the Google Sheet saved as
CSV (File > Download > CSV) — columns "Company", "Company no.", "Finance
contact", "Role", "Confidence" are understood. --show prints each result
(names included) — leave it off where logs are public.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import CSV_FIELDS, sections  # noqa: E402
from sourcer import confirm, excel, profiles  # noqa: E402

# The Google Sheet's friendly headers -> the finder's column names.
SHEET_HEADERS = {"Company": "company_name", "Company no.": "company_number", "Finance contact": "finance_contact",
                 "Role": "finance_contact_role", "Confidence": "finance_contact_confidence", "Band": "section",
                 "Why we think so": "finance_contact_source"}


def read_rows(path: str) -> tuple[list[dict], list[str]]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = [{SHEET_HEADERS.get(k, k): (v or "").strip() for k, v in r.items() if k} for r in reader]
        names = [SHEET_HEADERS.get(c, c) for c in (reader.fieldnames or []) if c]
    for r in rows:   # a sheet export has no "checked" marker, and drops leading zeros from numbers
        r.setdefault("untapped_reasons", "")
        if r.get("company_number", "").isdigit():
            r["company_number"] = r["company_number"].zfill(8)
    fields = [c for c in CSV_FIELDS if c in names] + [c for c in names if c not in CSV_FIELDS]
    return [r for r in rows if r.get("company_name")], fields


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv")
    parser.add_argument("--output", default="fx_companies.xlsx")
    parser.add_argument("--csv-out", help="Also write the confirmed rows to this CSV file")
    parser.add_argument("--top", type=int, help="Only the first N companies checked in full")
    parser.add_argument("--show", action="store_true", help="Print each company's result (names included)")
    parser.add_argument("--match", help="Only companies whose name contains this text, e.g. --match fairburn")
    parser.add_argument("--debug", action="store_true", help="Print what each search returned (engine, titles, sites)")
    parser.add_argument("--check-providers", action="store_true",
                        help="First, one test search per configured search API, to show which keys work")
    args = parser.parse_args()
    if args.check_providers:
        for name, status in profiles.check_providers().items():
            print(f"  search API {name}: {status}")
    rows, fields = read_rows(args.csv)
    if args.match:
        rows = [r for r in rows if args.match.lower() in r["company_name"].lower()]
    if args.debug:
        # the searches go through fetch_any (Search1API, Tavily, Exa, Serper in turn): show what each returned
        real_fetch = profiles.fetch_any

        def fetch_and_show(query: str, key: str = ""):
            answer = real_fetch(query, key)
            results = profiles.parse(answer) if answer else None
            print(f"\n  [search] {query}\n    -> "
                  f"{'FAILED (no answer)' if answer is None else 'not a results answer' if results is None else f'{len(results)} results'}")
            for link, title, _ in (results or [])[:6]:
                print(f"    - {urllib.parse.urlparse(link).netloc:28} {title[:90]}")
            return answer
        profiles.fetch_any = fetch_and_show
    if args.top:
        keep = {id(r) for r in [r for r in rows if r.get("untapped_reasons") != confirm.NOT_CHECKED][:args.top]}
        rows = [r for r in rows if id(r) in keep]
    started = time.time()
    rows, stats = confirm.confirm_rows(rows)
    out_fields = confirm.fields_with_confirmation(fields)
    excel.write_workbook(rows, out_fields, args.output, section_order=sections())
    if args.csv_out:
        with open(args.csv_out, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=out_fields, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
    if args.show:
        for r in rows:
            if r.get("search_check"):
                print(f"{r['company_name'][:40]:40}  {r.get('finance_contact', '')[:28]:28}  "
                      f"{r.get('finance_contact_role', '')[:24]:24}  {r.get('finance_contact_confidence', ''):9}  {r['search_check']}")
    print(f"\nConfirmation: {time.time() - started:,.0f}s")
    for key, value in sorted(stats.items()):
        print(f"  {key}: {value:,}")
    print(f"  searches answered this month, by provider: {profiles.usage()}")
    for name, why in profiles.left_out().items():
        print(f"  search API {name} left out this run: {why}")
    print(f"Output: {args.output}")


if __name__ == "__main__":
    main()
