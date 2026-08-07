#!/usr/bin/env python3
"""
generate_call_list.py — Companies House niche call-list generator.

Reads niches.json, queries the CH Advanced Search API for active companies
matching each niche's SIC codes, optionally filters by accounts type to proxy
for £10m+ turnover, deduplicates across niches, and writes call_list.csv.

Requirements:
  - CH_API_KEY environment variable (Companies House API key)
  - Python 3.8+ (stdlib only — no pip installs required)

Usage:
  export CH_API_KEY=your_api_key_here
  python3 generate_call_list.py
  python3 generate_call_list.py --api-key your_api_key_here
  python3 generate_call_list.py --niches european-charcuterie-importers,italian-olive-oil-importers
  python3 generate_call_list.py --no-accounts-filter   # skip size filtering (faster)
  python3 generate_call_list.py --output results.csv   # custom output filename
  python3 generate_call_list.py --max-per-niche 50     # limit companies per niche
"""

import argparse
import base64
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Optional

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CH_BASE = "https://api.company-information.service.gov.uk"
CH_SEARCH = f"{CH_BASE}/advanced-search/companies"
CH_COMPANY = f"{CH_BASE}/company/{{number}}"

RATE_LIMIT_SECONDS = 0.5          # delay between every API call
PAGE_SIZE = 50                    # max CH allows per request
DEFAULT_OUTPUT = "call_list.csv"
DEFAULT_MAX_PER_NICHE = 200       # safety cap per niche

# Accounts types that proxy for £10m+ turnover
QUALIFYING_ACCOUNTS_TYPES = {
    "full",
    "medium",
    "group",
    "small-full",
}

CSV_FIELDS = [
    "company_name",
    "company_number",
    "sic_codes",
    "niche_id",
    "niche_name",
    "currency_pairs",
    "call_angle",
    "registered_address",
    "accounts_type",
    "companies_house_url",
]


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _auth_header(api_key: str) -> dict:
    """Basic auth: api_key as username, empty password."""
    token = base64.b64encode(f"{api_key}:".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def _get(url: str, params: dict, api_key: str, retries: int = 3) -> dict:
    """HTTP GET with retry logic. Returns parsed JSON or raises."""
    qs = urllib.parse.urlencode(params, doseq=True)
    full_url = f"{url}?{qs}" if qs else url
    headers = _auth_header(api_key)

    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(full_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** attempt
                print(f"    [rate-limited] waiting {wait}s…", file=sys.stderr)
                time.sleep(wait)
            elif e.code in (401, 403):
                print(f"ERROR: Auth failed ({e.code}). Check CH_API_KEY.", file=sys.stderr)
                sys.exit(1)
            elif attempt == retries:
                raise
            else:
                time.sleep(1)
        except urllib.error.URLError as e:
            if attempt == retries:
                raise
            time.sleep(1)

    raise RuntimeError(f"Failed after {retries} attempts: {full_url}")


def _throttle():
    time.sleep(RATE_LIMIT_SECONDS)


# ---------------------------------------------------------------------------
# Companies House queries
# ---------------------------------------------------------------------------

def search_by_sic(sic_code: str, api_key: str, max_results: int) -> list[dict]:
    """
    Paginate through CH Advanced Search for a single SIC code.
    Returns list of raw company dicts from the API.
    """
    companies = []
    start_index = 0

    while len(companies) < max_results:
        batch_size = min(PAGE_SIZE, max_results - len(companies))
        params = {
            "sic_codes": sic_code,
            "company_status": "active",
            "size": batch_size,
            "start_index": start_index,
        }
        _throttle()
        data = _get(CH_SEARCH, params, api_key)
        items = data.get("items") or []
        if not items:
            break
        companies.extend(items)
        start_index += len(items)
        total_available = data.get("hits", 0)
        if start_index >= total_available:
            break

    return companies


def get_accounts_type(company_number: str, api_key: str) -> Optional[str]:
    """
    Fetch the full company profile to get accounts.last_accounts.type.
    Returns the type string or None if not available.
    Not in Advanced Search results — requires a separate call.
    """
    url = CH_COMPANY.format(number=company_number)
    _throttle()
    try:
        data = _get(url, {}, api_key)
        return (
            data.get("accounts", {})
            .get("last_accounts", {})
            .get("type")
        )
    except Exception:
        return None


def format_address(address: dict) -> str:
    """Collapse a CH address object into a single readable string."""
    parts = [
        address.get("premises"),
        address.get("address_line_1"),
        address.get("address_line_2"),
        address.get("locality"),
        address.get("region"),
        address.get("postal_code"),
        address.get("country"),
    ]
    return ", ".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# Core pipeline
# ---------------------------------------------------------------------------

def load_niches(path: str, selected_ids: Optional[list[str]] = None) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    niches = data.get("niches", [])
    if selected_ids:
        niches = [n for n in niches if n["id"] in selected_ids]
        missing = set(selected_ids) - {n["id"] for n in niches}
        if missing:
            print(f"WARNING: niche IDs not found: {', '.join(sorted(missing))}", file=sys.stderr)
    return niches


def collect_companies(
    niches: list[dict],
    api_key: str,
    filter_accounts: bool,
    max_per_niche: int,
) -> list[dict]:
    """
    For each niche, search all its SIC codes, deduplicate within niche,
    optionally filter by accounts type, then return merged list.
    Deduplication across niches: first niche wins.
    """
    seen_globally: dict[str, dict] = {}   # company_number → row
    all_rows: list[dict] = []

    for niche in niches:
        niche_id = niche["id"]
        niche_name = niche["name"]
        currency_pairs = "|".join(niche.get("currency_pairs", []))
        call_angle = niche.get("call_angle", "")
        sic_codes = niche.get("sic_codes", [])

        print(f"\n[{niche_id}]")
        print(f"  SIC codes: {', '.join(sic_codes)}")

        # Collect raw companies from CH for all SIC codes in this niche
        niche_companies: dict[str, dict] = {}  # company_number → raw item

        for sic in sic_codes:
            print(f"  Searching SIC {sic}…", end=" ", flush=True)
            results = search_by_sic(sic, api_key, max_per_niche)
            print(f"{len(results)} results")
            for item in results:
                cn = item.get("company_number", "")
                if cn and cn not in niche_companies:
                    niche_companies[cn] = item

        print(f"  Unique companies after SIC merge: {len(niche_companies)}")

        # Apply accounts-type filter (requires individual profile calls)
        qualified = []
        skipped_accounts = 0
        skipped_global_dup = 0

        for cn, item in niche_companies.items():
            # Skip if already found in an earlier niche
            if cn in seen_globally:
                skipped_global_dup += 1
                continue

            accounts_type = None
            if filter_accounts:
                accounts_type = get_accounts_type(cn, api_key)
                if accounts_type not in QUALIFYING_ACCOUNTS_TYPES:
                    skipped_accounts += 1
                    continue

            address_obj = item.get("registered_office_address", {})
            address_str = format_address(address_obj)
            sic_list = item.get("sic_codes") or []

            row = {
                "company_name": item.get("company_name", ""),
                "company_number": cn,
                "sic_codes": "|".join(sic_list),
                "niche_id": niche_id,
                "niche_name": niche_name,
                "currency_pairs": currency_pairs,
                "call_angle": call_angle,
                "registered_address": address_str,
                "accounts_type": accounts_type or "",
                "companies_house_url": f"https://find-and-update.company-information.service.gov.uk/company/{cn}",
            }
            qualified.append(row)
            seen_globally[cn] = row

        if filter_accounts:
            print(f"  Passed accounts filter: {len(qualified)} | Filtered out: {skipped_accounts} | Global dups skipped: {skipped_global_dup}")
        else:
            print(f"  Added: {len(qualified)} | Global dups skipped: {skipped_global_dup}")

        all_rows.extend(qualified)

    return all_rows


def write_csv(rows: list[dict], output_path: str) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def print_summary(rows: list[dict], niches: list[dict], output_path: str) -> None:
    print("\n" + "=" * 60)
    print(f"Pipeline complete — {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Output: {output_path}")
    print(f"Total companies: {len(rows)}")
    print()

    by_niche: dict[str, int] = {}
    for row in rows:
        by_niche[row["niche_name"]] = by_niche.get(row["niche_name"], 0) + 1

    # Show all niches including those with zero results
    niche_names = {n["name"] for n in niches}
    for name in sorted(niche_names):
        count = by_niche.get(name, 0)
        print(f"  {count:>4}  {name}")

    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a call list of FX-exposed UK companies from Companies House.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--niches",
        metavar="ID[,ID...]",
        help="Comma-separated niche IDs to run (default: all niches)",
    )
    parser.add_argument(
        "--no-accounts-filter",
        action="store_true",
        help="Skip accounts-type filtering (faster, returns more results)",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        metavar="FILE",
        help=f"Output CSV path (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--max-per-niche",
        type=int,
        default=DEFAULT_MAX_PER_NICHE,
        metavar="N",
        help=f"Max companies to fetch per niche per SIC code (default: {DEFAULT_MAX_PER_NICHE})",
    )
    parser.add_argument(
        "--niches-file",
        default="niches.json",
        metavar="FILE",
        help="Path to niches.json (default: niches.json in current directory)",
    )
    parser.add_argument(
        "--api-key",
        metavar="KEY",
        help="Companies House API key (overrides CH_API_KEY env var)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    api_key = (args.api_key or os.environ.get("CH_API_KEY", "")).strip()
    if not api_key:
        print("ERROR: No Companies House API key supplied.", file=sys.stderr)
        print("  export CH_API_KEY=your_api_key_here", file=sys.stderr)
        print("  or pass: --api-key your_api_key_here", file=sys.stderr)
        sys.exit(1)

    niches_file = args.niches_file
    if not os.path.exists(niches_file):
        print(f"ERROR: niches file not found: {niches_file}", file=sys.stderr)
        sys.exit(1)

    selected_ids = None
    if args.niches:
        selected_ids = [s.strip() for s in args.niches.split(",") if s.strip()]

    filter_accounts = not args.no_accounts_filter

    print(f"FX Call List Generator")
    print(f"  Niches file:      {niches_file}")
    print(f"  Output:           {args.output}")
    print(f"  Accounts filter:  {'ON (£10m+ proxy)' if filter_accounts else 'OFF'}")
    print(f"  Max per niche:    {args.max_per_niche}")
    if selected_ids:
        print(f"  Niche filter:     {', '.join(selected_ids)}")
    else:
        print(f"  Niche filter:     all")

    niches = load_niches(niches_file, selected_ids)
    if not niches:
        print("ERROR: No niches to process.", file=sys.stderr)
        sys.exit(1)

    print(f"\nProcessing {len(niches)} niche(s)…")

    rows = collect_companies(
        niches=niches,
        api_key=api_key,
        filter_accounts=filter_accounts,
        max_per_niche=args.max_per_niche,
    )

    write_csv(rows, args.output)
    print_summary(rows, niches, args.output)


if __name__ == "__main__":
    main()
