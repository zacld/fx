#!/usr/bin/env python3
"""
main.py — Hayvin lead sourcer.

Finds B2B leads (company, contact name, role/title, email) for Hayvin, a
vape/battery recycling collection service pitching UK retailers.

Two tiers:
  Tier 1 — major chains + forecourt groups (config/tier1_targets.yaml).
           Public sustainability-report / press-page scraping for named
           contacts, LinkedIn search URLs generated for manual lookup.
  Tier 2/3 — regional chains, forecourt groups, independents, swept from
           Companies House by SIC code (config/sic_codes.yaml), with
           Companies House officers as the contact-of-record fallback and
           Google Places used only to confirm trading status + domain.

Deliberately does NOT look up phone numbers anywhere — that's out of scope
for this tool and handled separately. `phone` is always left blank in the
output CSV.

Usage:
  export COMPANIES_HOUSE_API_KEY=...   # required for Tier 2/3
  export GOOGLE_PLACES_API_KEY=...     # optional — domain/trading confirmation
  export HUNTER_API_KEY=...            # optional — verified email lookup
  python3 main.py
  python3 main.py --tier1-only
  python3 main.py --tier2-only --max-per-sic 50
  python3 main.py --output leads.csv
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import sys
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

import yaml

from sourcer import companies_house, email_guesser, google_places, hunter, report_scraper

CSV_FIELDS = [
    "tier",
    "company_name",
    "companies_house_number",
    "domain",
    "contact_name",
    "role_title",
    "email",
    "email_source",
    "email_confidence",
    "linkedin_search_url",
    "source_notes",
    "phone",
]

DEFAULT_OUTPUT = "hayvin_leads.csv"
DEFAULT_TIER1_CONFIG = "config/tier1_targets.yaml"
DEFAULT_SIC_CONFIG = "config/sic_codes.yaml"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def new_row(**overrides) -> dict:
    row = {field: "" for field in CSV_FIELDS}
    row.update(overrides)
    return row


def linkedin_search_url(company_name: str, title: str) -> str:
    """
    Build a LinkedIn people-search URL for manual lookup. Output as a link
    for a human to click — never used to scrape LinkedIn itself (PRIORITY 12
    style ToS caution: no automated LinkedIn access anywhere in this tool).
    """
    params = urllib.parse.urlencode({"keywords": title, "company": company_name})
    return f"https://www.linkedin.com/search/results/people/?{params}"


def split_name(full_name: str) -> tuple[str, str]:
    parts = [p for p in re.split(r"\s+", full_name.strip()) if p]
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], parts[-1]


def _apply_hunter_pattern(pattern: str, first: str, last: str) -> str:
    first = first.lower()
    last = last.lower()
    replacements = {
        "{first}": first,
        "{last}": last,
        "{f}": first[:1],
        "{l}": last[:1],
    }
    result = pattern
    for token, value in replacements.items():
        result = result.replace(token, value)
    return result


def resolve_email(first_name: str, last_name: str, domain: str) -> tuple[str, str, str]:
    """
    Resolve an email for a named person at a domain.
    Returns (email, email_source, email_confidence). All "" if no domain or
    no name — caller should leave the row's contact fields blank rather than
    guessing at an email with nothing to anchor it to.
    """
    if not domain or not first_name or not last_name:
        return "", "", ""

    if hunter.get_api_key():
        hit = hunter.find_person_email(first_name, last_name, domain)
        if hit and hit.get("email"):
            confidence = hit.get("confidence")
            return hit["email"], "hunter_verified", str(confidence) if confidence is not None else ""

        pattern_hit = hunter.domain_pattern(domain)
        if pattern_hit and pattern_hit.get("pattern"):
            email = _apply_hunter_pattern(pattern_hit["pattern"], first_name, last_name)
            confidence = pattern_hit.get("confidence")
            return email, "hunter_pattern", str(confidence) if confidence is not None else ""

    guess = email_guesser.best_guess(first_name, last_name, domain)
    if guess:
        return guess, "unverified_guess", ""
    return "", "", ""


def write_csv(rows: list[dict], output_path: str) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


# ---------------------------------------------------------------------------
# Tier 1 — major chains
# ---------------------------------------------------------------------------

def load_tier1_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def run_tier1(config: dict) -> list[dict]:
    companies = config.get("companies", [])
    titles = config.get("titles", [])
    rows: list[dict] = []

    print(f"\n=== Tier 1: {len(companies)} companies x {len(titles)} titles ===")

    for company in companies:
        name = company["name"]
        domain = company.get("domain", "")
        press_url = company.get("press_url")
        report_url = company.get("sustainability_report_url")

        print(f"\n[{name}]")
        found_contacts = report_scraper.find_contacts_for_company(press_url, report_url, titles)
        if found_contacts:
            print(f"  Found {len(found_contacts)} named contact(s) in public sources")
        else:
            print("  No named contacts found in public sources — manual LinkedIn lookup required")

        # Index by title (lowercased) — first match wins per title.
        contacts_by_title: dict[str, dict] = {}
        for hit in found_contacts:
            key = hit["title"].lower()
            if key not in contacts_by_title:
                contacts_by_title[key] = hit

        for title in titles:
            hit = contacts_by_title.get(title.lower())
            li_url = linkedin_search_url(name, title)

            if hit:
                first, last = split_name(hit["name"])
                email, email_source, email_confidence = resolve_email(first, last, domain)
                rows.append(new_row(
                    tier="1",
                    company_name=name,
                    domain=domain,
                    contact_name=hit["name"],
                    role_title=title,
                    email=email,
                    email_source=email_source,
                    email_confidence=email_confidence,
                    linkedin_search_url=li_url,
                    source_notes=f"public_report: found in {hit['source_type']} ({hit['source_url']})",
                ))
            else:
                rows.append(new_row(
                    tier="1",
                    company_name=name,
                    domain=domain,
                    contact_name="",
                    role_title=title,
                    email="",
                    email_source="",
                    email_confidence="",
                    linkedin_search_url=li_url,
                    source_notes="manual_linkedin_lookup_required: no named contact found in public report/press page",
                ))

    return rows


# ---------------------------------------------------------------------------
# Tier 2/3 — Companies House SIC sweep
# ---------------------------------------------------------------------------

def load_sic_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def run_tier23(config: dict, max_per_sic_override: Optional[int]) -> list[dict]:
    ch_key = companies_house.get_api_key()
    if not ch_key:
        print("\n=== Tier 2/3: SKIPPED (no COMPANIES_HOUSE_API_KEY set) ===", file=sys.stderr)
        return []

    sic_entries = config.get("sic_codes", [])
    max_per_sic = max_per_sic_override or config.get("max_per_sic", 200)
    company_status = config.get("company_status", "active")

    print(f"\n=== Tier 2/3: sweeping {len(sic_entries)} SIC code(s), up to {max_per_sic} companies each ===")

    seen: dict[str, dict] = {}  # company_number -> raw CH item
    for entry in sic_entries:
        code = str(entry["code"])
        print(f"  SIC {code} ({entry.get('label', '')})…", end=" ", flush=True)
        results = companies_house.search_by_sic(code, ch_key, max_per_sic, company_status)
        print(f"{len(results)} results")
        for item in results:
            cn = item.get("company_number", "")
            if cn and cn not in seen:
                seen[cn] = item

    print(f"  Unique companies after SIC merge: {len(seen)}")

    rows: list[dict] = []
    for cn, item in seen.items():
        name = item.get("company_name", "")
        address = item.get("registered_office_address") or {}
        locality = address.get("locality", "UK")

        # Google Places: confirm still trading + pull domain. Never reads phone.
        places_hit = google_places.find_company(name, locality or "UK")
        domain = places_hit["domain"] if places_hit else ""
        trading_note = "confirmed trading (Google Places)" if places_hit else "trading status not confirmed"

        directors = companies_house.get_active_directors(cn, ch_key)

        if directors:
            top = directors[0]
            first, last = split_name(top["name"])
            email, email_source, email_confidence = resolve_email(first, last, domain)
            rows.append(new_row(
                tier="2/3",
                company_name=name,
                companies_house_number=cn,
                domain=domain,
                contact_name=top["name"],
                role_title=f"{top['role']} (Companies House officer)",
                email=email,
                email_source=email_source,
                email_confidence=email_confidence,
                linkedin_search_url=linkedin_search_url(name, top["role"]),
                source_notes=f"companies_house_officer; appointed {top.get('appointed_on', 'unknown')}; {trading_note}",
            ))
        else:
            rows.append(new_row(
                tier="2/3",
                company_name=name,
                companies_house_number=cn,
                domain=domain,
                contact_name="",
                role_title="Director/Owner (research needed)",
                email="",
                email_source="",
                email_confidence="",
                linkedin_search_url=linkedin_search_url(name, "Director"),
                source_notes=f"no active director found via Companies House officers API; {trading_note}",
            ))

    return rows


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find B2B leads (company, contact, role, email) for Hayvin.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--tier1-only", action="store_true", help="Only run the Tier 1 major-chain sweep")
    parser.add_argument("--tier2-only", action="store_true", help="Only run the Tier 2/3 Companies House sweep")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, metavar="FILE", help=f"Output CSV path (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--tier1-config", default=DEFAULT_TIER1_CONFIG, metavar="FILE")
    parser.add_argument("--sic-config", default=DEFAULT_SIC_CONFIG, metavar="FILE")
    parser.add_argument("--max-per-sic", type=int, default=None, metavar="N", help="Override max_per_sic from config")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.tier1_only and args.tier2_only:
        print("ERROR: --tier1-only and --tier2-only are mutually exclusive.", file=sys.stderr)
        sys.exit(1)

    print("Hayvin Lead Sourcer")
    print(f"  Companies House key: {'set' if companies_house.get_api_key() else 'MISSING — Tier 2/3 will be skipped'}")
    print(f"  Google Places key:   {'set' if google_places.get_api_key() else 'not set — domain/trading confirmation skipped'}")
    print(f"  Hunter.io key:       {'set' if hunter.get_api_key() else 'not set — emails will be unverified guesses'}")

    rows: list[dict] = []

    if not args.tier2_only:
        if not os.path.exists(args.tier1_config):
            print(f"ERROR: Tier 1 config not found: {args.tier1_config}", file=sys.stderr)
            sys.exit(1)
        tier1_config = load_tier1_config(args.tier1_config)
        rows.extend(run_tier1(tier1_config))

    if not args.tier1_only:
        if not os.path.exists(args.sic_config):
            print(f"ERROR: SIC config not found: {args.sic_config}", file=sys.stderr)
            sys.exit(1)
        sic_config = load_sic_config(args.sic_config)
        rows.extend(run_tier23(sic_config, args.max_per_sic))

    write_csv(rows, args.output)

    print("\n" + "=" * 60)
    print(f"Done — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Output: {args.output}")
    print(f"Total rows: {len(rows)}")
    by_tier: dict[str, int] = {}
    with_contact = 0
    for row in rows:
        by_tier[row["tier"]] = by_tier.get(row["tier"], 0) + 1
        if row["contact_name"]:
            with_contact += 1
    for tier, count in sorted(by_tier.items()):
        print(f"  Tier {tier}: {count} rows")
    print(f"  Rows with a named contact: {with_contact}")
    print(f"  Rows needing manual research: {len(rows) - with_contact}")
    print("=" * 60)


if __name__ == "__main__":
    main()
