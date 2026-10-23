#!/usr/bin/env python3
"""
tools/finance_contact_test.py — run the finance-contact search on companies
from an earlier fx_companies.csv, to measure coverage before a full run.

    COMPANIES_HOUSE_API_KEY=... python3 tools/finance_contact_test.py fx_companies.csv \
        [--where main_bank] [--output finance_contacts_test.csv] [--no-websites]

Selects rows where the --where column is filled in (default: main_bank, i.e.
the companies whose bank was identified), then for each: Companies House
officers (incl. secretary), the latest iXBRL accounts (finance titles,
signatory), and the company's own website when those name nobody.

Writes names to the output CSV (an artifact, not the log). The log shows
counts only, because Actions logs on this repo are readable.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import CH_WORKERS, finance_contact  # noqa: E402
from sourcer import accounts, companies_house, news, people, website  # noqa: E402

FIELDS = ["company_number", "company_name", "section", "main_bank", "finance_contact", "finance_contact_role",
          "finance_contact_source", "finance_contact_confidence", "verify_finance_contact_url", "qualified_accountants", "company_secretary", "accounts_signed_by", "accounts_read",
          "finance_people_in_accounts", "website", "website_confidence", "generic_emails"]


def source_kind(source: str) -> str:
    return source.split(":")[0].split(" — ")[0].split(" (")[0] if source else "none"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv")
    parser.add_argument("--where", default="main_bank", help="Only rows where this column is filled in (default: main_bank)")
    parser.add_argument("--output", default="finance_contacts_test.csv")
    parser.add_argument("--no-websites", action="store_true")
    args = parser.parse_args()

    key = companies_house.get_api_key()
    if not key:
        sys.exit("COMPANIES_HOUSE_API_KEY is not set")
    with open(args.csv, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if (r.get(args.where) or "").strip()]
    print(f"Companies selected (where {args.where} is filled in): {len(rows):,}", flush=True)

    stats: Counter = Counter()
    started = time.time()
    def gather(row: dict) -> tuple:
        number = row["company_number"]
        officers = companies_house.get_active_officers(number, key)
        facts = accounts.facts_from_latest_accounts(number, key) or {}
        known = people.choose_finance_contact(officers, facts.get("finance_people", []), [], facts.get("signatory", ""))
        need_site = not args.no_websites and (not known or not known["source"].startswith(("Companies House",
                                                                                            "filed accounts")))
        return row, officers, facts, need_site

    found = []   # (row, officers, facts, needs a website)
    with ThreadPoolExecutor(max_workers=CH_WORKERS) as pool:   # CH calls stay rate-limited; OCR overlaps
        for i, result in enumerate(pool.map(gather, rows), 1):
            found.append(result)
            if i % 25 == 0:
                print(f"  …{i:,} of {len(rows):,} ({time.time() - started:,.0f}s)", flush=True)
    register_seconds = time.time() - started
    wanted = [(r["company_number"], r["company_name"], f.get("web_addresses", [])) for r, _, f, need in found if need]
    print(f"  Reading {len(wanted):,} company websites…", flush=True)
    sites = website.look_up_many(wanted) if wanted else {}
    website_seconds = time.time() - started - register_seconds
    unconfirmed = [(r["company_number"], r["company_name"]) for r, officers, facts, _ in found
                   if (lambda c: not c or c["confidence"] != people.CONFIRMED)(
                       finance_contact(officers, facts, sites.get(r["company_number"])))]
    print(f"  Checking the news for {len(unconfirmed):,} companies…", flush=True)
    in_news = news.appointments_many(unconfirmed)
    news_seconds = time.time() - started - register_seconds - website_seconds

    out = []
    for row, officers, facts, need_site in found:
        number = row["company_number"]
        found_people, signatory = facts.get("finance_people", []), facts.get("signatory", "")
        site = sites.get(number, {})
        if need_site:
            stats["site_tried"] += 1
            stats["site_found"] += bool(site["website"])
            stats["site_people"] += bool(site["people"])
            stats["site_emails"] += bool(site["emails"])
        contact = finance_contact(officers, facts, site, in_news.get(number))
        stats["news_tried"] += any(n == number for n, _ in unconfirmed)
        stats["news_found"] += bool(in_news.get(number))
        stats["qualified"] += bool(facts.get("qualified") or site.get("qualified"))
        stats["turnover"] += facts.get("turnover") is not None
        stats["confidence " + (contact["confidence"] if contact else "none")] += 1
        stats["accounts_read"] += bool(facts)
        stats["format " + (facts.get("format") or "none")] += 1
        stats["accounts_people"] += bool(found_people)
        stats["signatory"] += bool(signatory)
        stats["secretary"] += any(o["role"] == companies_house.SECRETARY for o in officers)
        stats["source " + source_kind(contact["source"] if contact else "")] += 1
        out.append({
            "company_number": number, "company_name": row["company_name"], "section": row.get("section", ""),
            "main_bank": row.get("main_bank", ""),
            "finance_contact": contact["name"] if contact else "", "finance_contact_role": contact["role"] if contact else "",
            "finance_contact_source": contact["source"] if contact else "",
            "finance_contact_confidence": contact["confidence"] if contact else "",
            "verify_finance_contact_url": news.verify_links(row["company_name"], contact["name"] if contact else "")[0],
            "qualified_accountants": "; ".join(f"{q['name']} ({q['letters']})"
                                               for q in facts.get("qualified", []) + site.get("qualified", [])),
            "company_secretary": next((o["name"] for o in officers if o["role"] == companies_house.SECRETARY), ""),
            "accounts_signed_by": signatory, "accounts_read": facts.get("format", ""),
            "finance_people_in_accounts": "; ".join(f"{p['name']} ({p['title']})" for p in found_people),
            "website": site.get("website", ""), "website_confidence": site.get("confidence", ""),
            "generic_emails": "; ".join(site.get("emails", [])),
        })

    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(out)

    n = len(rows) or 1
    named = n - stats["source none"]
    strong = stats["source Companies House occupation"] + stats["source filed accounts"] + stats["source company website"]
    print("\n" + "=" * 60)
    print(f"Finance contact named: {named:,} of {len(rows):,} ({100 * named / n:.0f}%)")
    print(f"  with an explicit finance title (occupation, accounts or website): {strong:,} ({100 * strong / n:.0f}%)")
    for k, v in sorted(((k[7:], v) for k, v in stats.items() if k.startswith("source ")), key=lambda kv: -kv[1]):
        print(f"  {k}: {v:,}")
    print(f"Accounts readable: {stats['accounts_read']:,} (ixbrl {stats['format ixbrl']:,}, pdf {stats['format pdf']:,}, "
          f"scanned pdf {stats['format scanned pdf']:,}) | naming a finance person: {stats['accounts_people']:,} | "
          f"signatory found: {stats['signatory']:,}")
    print(f"Company secretary on the register: {stats['secretary']:,}")
    print(f"Websites tried: {stats['site_tried']:,} | confirmed: {stats['site_found']:,} | "
          f"naming a finance person: {stats['site_people']:,} | with generic emails: {stats['site_emails']:,}")
    print(f"Confidence — Confirmed: {stats['confidence Confirmed']:,}, Likely: {stats['confidence Likely']:,}, "
          f"Guess: {stats['confidence Guess']:,}, none: {stats['confidence none']:,}")
    print(f"Qualified accountants named (accounts or website): {stats['qualified']:,} companies")
    print(f"Turnover read from the accounts: {stats['turnover']:,}")
    print(f"News checked: {stats['news_tried']:,} | with a finance appointment naming the company: {stats['news_found']:,}")
    print(f"Time: {time.time() - started:,.0f}s — register + accounts {register_seconds:,.0f}s, "
          f"websites {website_seconds:,.0f}s, news {news_seconds:,.0f}s")
    print("=" * 60)
    print(f"Output: {args.output}")


if __name__ == "__main__":
    main()
