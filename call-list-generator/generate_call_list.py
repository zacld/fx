#!/usr/bin/env python3
"""
generate_call_list.py — Companies House niche call-list generator.

Reads niches.json, queries the CH Advanced Search API for active companies
matching each niche's SIC codes, optionally filters by accounts type to proxy
for £10m+ turnover, deduplicates across niches, and writes call_list.csv.

Requirements:
  - Python 3.8+ (stdlib only — no pip installs required)
  - A Companies House API key. A built-in default is included so the script
    runs immediately after cloning; override with CH_API_KEY or --api-key.

Usage:
  python3 generate_call_list.py                        # uses built-in key
  export CH_API_KEY=your_api_key_here                  # or your own key
  python3 generate_call_list.py --api-key your_api_key_here
  python3 generate_call_list.py --niches european-charcuterie-importers,italian-olive-oil-importers
  python3 generate_call_list.py --no-accounts-filter   # skip size filtering (faster)
  python3 generate_call_list.py --require-name-match    # sharpest list — name must fit the niche
  python3 generate_call_list.py --verify-websites       # find website + scan for FX evidence (slow)
  python3 generate_call_list.py --output results.csv   # custom output filename
  python3 generate_call_list.py --max-per-niche 50     # limit companies per niche

Offline test (no API key or network needed):
  python3 test_generator.py
"""

import argparse
import base64
import csv
import json
import os
import re
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

# Built-in fallback key so the script runs with zero setup after cloning.
# NOTE: this repo is public, so this key is public — treat it as disposable
# and override with CH_API_KEY / --api-key when you have your own.
DEFAULT_API_KEY = "bf190544-f3dd-4dd3-b60b-d897c8ffebf8"

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
    "name_match",
    "matched_keyword",
    "website",
    "fx_signal_count",
    "fx_signals",
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
            elif 400 <= e.code < 500:
                # Permanent client error (404 etc.) — retrying can't fix it
                raise
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


def match_name(company_name: str, keywords: list[str]) -> Optional[str]:
    """
    Return the first niche keyword found in the company name (case-insensitive),
    or None. A SIC code is broad — "wholesale of meat" catches every meat
    wholesaler — so this narrows a niche to the companies whose names actually
    fit it (e.g. "wine", "vintners", "cellar" for wine importers).

    Keywords must start at a word boundary, but may continue into the word:
    "wine" matches "WINE CELLARS" and "WINERY" but NOT "TWINE"; "gin" matches
    "GIN DISTILLERY" but NOT "ENGINEERING". Plain substring matching produced
    exactly those false positives.
    """
    lowered = company_name.lower()
    for kw in keywords:
        if re.search(r"\b" + re.escape(kw.lower()), lowered):
            return kw
    return None


# ---------------------------------------------------------------------------
# Website discovery + FX evidence (opt-in via --verify-websites)
# ---------------------------------------------------------------------------
# A name that fits the niche is a guess; text on the company's own website
# saying "we import from Europe" is evidence. Mirrors the main pipeline's
# website validation: homepage + up to 3 more pages (4 max), early stop
# once 3+ distinct FX signals are found.

FETCH_TIMEOUT = 10
MAX_PAGE_BYTES = 300_000
MAX_PAGES_PER_SITE = 4
EARLY_STOP_SIGNALS = 3
EXTRA_PAGES = ["/about", "/about-us", "/products", "/services"]

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) FXCallList/1.0",
    "Accept": "text/html,application/xhtml+xml",
}

# (label, regex) — labels are what lands in the fx_signals CSV column.
# Anchored patterns, not substrings: "import" must not fire on "important".
FX_SIGNAL_PATTERNS: list[tuple[str, str]] = [
    ("import", r"\bimport(s|er|ers|ing|ed)?\b"),
    ("export", r"\bexport(s|er|ers|ing|ed)?\b"),
    ("overseas supplier", r"\boverseas suppliers?\b"),
    ("foreign supplier", r"\bforeign suppliers?\b"),
    ("international supplier", r"\binternational suppliers?\b"),
    ("pay in foreign currency", r"\bpay(ing|ments?)? in (euros?|dollars?|eur\b|usd\b)"),
    ("foreign currency invoice", r"\b(eur|usd|euro|dollar) invoic"),
    ("currency", r"\bcurrenc(y|ies)\b"),
    ("exchange rate", r"\bexchange rates?\b"),
    ("hedging", r"\bhedg(e|es|ing|ed)\b"),
    ("sourced from", r"\bsourced? (direct(ly)? )?from\b"),
    ("direct from", r"\bdirect(ly)? from\b"),
    ("distributor", r"\bdistribut(or|ors|ion|e|es|ing)\b"),
    ("global sourcing", r"\b(worldwide|global) sourcing\b"),
]

# Tokens dropped from company names when guessing domains
LEGAL_SUFFIXES = {
    "limited", "ltd", "plc", "llp", "llc", "holdings", "group",
    "co", "company", "uk", "gb", "the", "and",
}


def _strip_html(html: str) -> str:
    """Crude but dependency-free: drop script/style, then all tags."""
    html = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    html = re.sub(r"(?s)<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", html).lower()


def fetch_page(url: str) -> Optional[str]:
    """Fetch a page politely; return HTML text or None on any failure."""
    try:
        req = urllib.request.Request(url, headers=BROWSER_HEADERS)
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            ctype = resp.headers.get("Content-Type", "")
            if ctype and "html" not in ctype:
                return None
            raw = resp.read(MAX_PAGE_BYTES)
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return None


def _candidate_urls(company_name: str) -> list[str]:
    """Guess plausible domains from the company name (no search engine needed)."""
    tokens = re.findall(r"[a-z0-9]+", company_name.lower())
    core = [t for t in tokens if t not in LEGAL_SUFFIXES] or tokens

    bases = []
    joined = "".join(core)
    if joined:
        bases.append(joined)
    if len(core) > 1:
        bases.append("-".join(core))
        abbr = "".join(w[0] for w in core)
        if len(abbr) >= 3:          # 2-letter acronym domains are never the SME
            bases.append(abbr)

    urls = []
    for base in bases:
        if not 2 <= len(base) <= 40:
            continue
        for tld in (".co.uk", ".com"):
            for prefix in ("https://www.", "https://"):
                urls.append(f"{prefix}{base}{tld}")
    return urls


def guess_website(company_name: str) -> tuple[Optional[str], Optional[str]]:
    """Try candidate domains; return (url, homepage_html) for the first hit."""
    for url in _candidate_urls(company_name):
        _throttle()
        html = fetch_page(url)
        if html:
            return url, html
    return None, None


def scan_fx_signals(html: str) -> list[str]:
    """Return the distinct FX signal labels present in a page."""
    text = _strip_html(html)
    return [label for label, pattern in FX_SIGNAL_PATTERNS if re.search(pattern, text)]


def verify_company_website(company_name: str) -> tuple[str, list[str]]:
    """
    Find the company's website and collect FX evidence from it.
    Returns ("", []) if no site could be found. Domains are GUESSED from the
    company name — eyeball the URL before trusting it.
    """
    url, homepage = guess_website(company_name)
    if not url or homepage is None:
        return "", []

    signals = set(scan_fx_signals(homepage))
    pages_fetched = 1
    for path in EXTRA_PAGES:
        if len(signals) >= EARLY_STOP_SIGNALS or pages_fetched >= MAX_PAGES_PER_SITE:
            break
        _throttle()
        html = fetch_page(url.rstrip("/") + path)
        if html:
            pages_fetched += 1
            signals.update(scan_fx_signals(html))
    return url, sorted(signals)


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
    require_name_match: bool = False,
    verify_websites: bool = False,
) -> list[dict]:
    """
    For each niche, search all its SIC codes, deduplicate within niche,
    rank by name match against the niche keywords, optionally filter by
    accounts type, then return merged list.
    Deduplication across niches: first niche wins.
    Within each niche, name-matched companies are processed and listed first.
    """
    seen_globally: dict[str, dict] = {}   # company_number → row
    all_rows: list[dict] = []

    for niche in niches:
        niche_id = niche["id"]
        niche_name = niche["name"]
        currency_pairs = "|".join(niche.get("currency_pairs", []))
        call_angle = niche.get("call_angle", "")
        sic_codes = niche.get("sic_codes", [])
        keywords = niche.get("name_keywords", [])

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

        # Score by name match. matched companies first (best fit for the niche),
        # so that with --require-name-match we keep only these, and even without
        # it, the accounts-filter API calls are spent on the best candidates first.
        scored = []
        for cn, item in niche_companies.items():
            matched_kw = match_name(item.get("company_name", ""), keywords)
            scored.append((0 if matched_kw else 1, cn, item, matched_kw))
        scored.sort(key=lambda t: t[0])   # matched (0) before unmatched (1)

        name_matched = sum(1 for s in scored if s[0] == 0)
        print(f"  Name-matched: {name_matched} / {len(scored)}"
              + ("  (keeping matches only)" if require_name_match else ""))

        # Build rows, applying name and accounts filters
        qualified = []
        skipped_name = 0
        skipped_accounts = 0
        skipped_global_dup = 0
        sites_found = 0

        for _, cn, item, matched_kw in scored:
            # Skip if already found in an earlier niche
            if cn in seen_globally:
                skipped_global_dup += 1
                continue

            if require_name_match and not matched_kw:
                skipped_name += 1
                continue

            accounts_type = None
            if filter_accounts:
                accounts_type = get_accounts_type(cn, api_key)
                if accounts_type not in QUALIFYING_ACCOUNTS_TYPES:
                    skipped_accounts += 1
                    continue

            website = ""
            fx_signals: list[str] = []
            if verify_websites:
                website, fx_signals = verify_company_website(item.get("company_name", ""))
                if website:
                    sites_found += 1

            address_obj = item.get("registered_office_address", {})
            address_str = format_address(address_obj)
            sic_list = item.get("sic_codes") or []

            row = {
                "company_name": item.get("company_name", ""),
                "company_number": cn,
                "sic_codes": "|".join(sic_list),
                "niche_id": niche_id,
                "niche_name": niche_name,
                "name_match": "yes" if matched_kw else "no",
                "matched_keyword": matched_kw or "",
                "website": website,
                "fx_signal_count": str(len(fx_signals)) if verify_websites else "",
                "fx_signals": "|".join(fx_signals),
                "currency_pairs": currency_pairs,
                "call_angle": call_angle,
                "registered_address": address_str,
                "accounts_type": accounts_type or "",
                "companies_house_url": f"https://find-and-update.company-information.service.gov.uk/company/{cn}",
            }
            qualified.append(row)
            seen_globally[cn] = row

        # With evidence in hand, strongest first within the niche
        if verify_websites:
            qualified.sort(key=lambda r: (0 if r["name_match"] == "yes" else 1,
                                          -int(r["fx_signal_count"] or 0)))

        summary = f"  Added: {len(qualified)}"
        if require_name_match:
            summary += f" | Name-filtered: {skipped_name}"
        if filter_accounts:
            summary += f" | Accounts-filtered: {skipped_accounts}"
        if verify_websites:
            summary += f" | Websites found: {sites_found}"
        summary += f" | Global dups: {skipped_global_dup}"
        print(summary)

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
    parser.add_argument(
        "--require-name-match",
        action="store_true",
        help="Keep only companies whose name matches the niche keywords "
             "(sharpest list; drops generic SIC-only matches)",
    )
    parser.add_argument(
        "--verify-websites",
        action="store_true",
        help="Guess each company's website and scan it for FX evidence "
             "(import/export/overseas suppliers). Much slower — combine with "
             "--require-name-match. Domains are guessed; eyeball before trusting.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    api_key = (args.api_key or os.environ.get("CH_API_KEY", "") or DEFAULT_API_KEY).strip()
    using_default_key = api_key == DEFAULT_API_KEY
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
    print(f"  API key:          {'built-in default' if using_default_key else 'user-supplied'}")
    print(f"  Niches file:      {niches_file}")
    print(f"  Output:           {args.output}")
    print(f"  Accounts filter:  {'ON (£10m+ proxy)' if filter_accounts else 'OFF'}")
    print(f"  Name match:       {'REQUIRED (matches only)' if args.require_name_match else 'ranked (matches first)'}")
    print(f"  Website check:    {'ON (FX evidence scan)' if args.verify_websites else 'OFF'}")
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
        require_name_match=args.require_name_match,
        verify_websites=args.verify_websites,
    )

    write_csv(rows, args.output)
    print_summary(rows, niches, args.output)


if __name__ == "__main__":
    main()
