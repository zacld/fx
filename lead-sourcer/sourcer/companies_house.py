"""
sourcer/companies_house.py — Companies House API helpers.

Same stdlib-only HTTP pattern as call-list-generator/generate_call_list.py:
basic auth with the API key as username, retry-with-backoff on 429s.

Degrades gracefully: every public function returns [] / None (never raises)
when COMPANIES_HOUSE_API_KEY is unset, so callers can skip this enrichment
step instead of crashing.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

CH_BASE = "https://api.company-information.service.gov.uk"
CH_SEARCH = f"{CH_BASE}/advanced-search/companies"
CH_COMPANY = f"{CH_BASE}/company/{{number}}"
CH_OFFICERS = f"{CH_BASE}/company/{{number}}/officers"

RATE_LIMIT_SECONDS = 0.5
PAGE_SIZE = 50

# Job titles/roles a decision-maker-shaped officer record is likely to carry.
# Companies House "officer_role" is usually just "director" / "secretary" —
# there's no title field, so we surface the role as-is and let the CSV's
# role_title column read e.g. "Director (Companies House officer)".
DIRECTOR_ROLES = {"director", "corporate-director"}


def get_api_key() -> Optional[str]:
    key = os.environ.get("COMPANIES_HOUSE_API_KEY", "").strip()
    return key or None


def _auth_header(api_key: str) -> dict:
    token = base64.b64encode(f"{api_key}:".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def _get(url: str, params: dict, api_key: str, retries: int = 3) -> Optional[dict]:
    qs = urllib.parse.urlencode(params, doseq=True)
    full_url = f"{url}?{qs}" if qs else url
    headers = _auth_header(api_key)

    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(full_url, headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:
                wait = 2 ** attempt
                print(f"    [CH rate-limited] waiting {wait}s…", file=sys.stderr)
                time.sleep(wait)
            elif e.code in (401, 403):
                print("WARNING: Companies House auth failed — check COMPANIES_HOUSE_API_KEY.", file=sys.stderr)
                return None
            elif attempt == retries:
                print(f"WARNING: Companies House request failed: {e}", file=sys.stderr)
                return None
            else:
                time.sleep(1)
        except urllib.error.URLError as e:
            if attempt == retries:
                print(f"WARNING: Companies House request failed: {e}", file=sys.stderr)
                return None
            time.sleep(1)
    return None


def _throttle() -> None:
    time.sleep(RATE_LIMIT_SECONDS)


def search_by_sic(sic_code: str, api_key: str, max_results: int, company_status: str = "active") -> list[dict]:
    """Paginate CH Advanced Search for a single SIC code. Returns [] on any failure."""
    companies: list[dict] = []
    start_index = 0

    while len(companies) < max_results:
        batch_size = min(PAGE_SIZE, max_results - len(companies))
        params = {
            "sic_codes": sic_code,
            "company_status": company_status,
            "size": batch_size,
            "start_index": start_index,
        }
        _throttle()
        data = _get(CH_SEARCH, params, api_key)
        if not data:
            break
        items = data.get("items") or []
        if not items:
            break
        companies.extend(items)
        start_index += len(items)
        total_available = data.get("hits", 0)
        if start_index >= total_available:
            break

    return companies


def get_company_profile(company_number: str, api_key: str) -> Optional[dict]:
    """Fetch the full company profile (used for website URL, if CH has one on file)."""
    url = CH_COMPANY.format(number=company_number)
    _throttle()
    return _get(url, {}, api_key)


def get_active_directors(company_number: str, api_key: str) -> list[dict]:
    """
    Return active director-role officers as
    [{"name": ..., "role": ..., "appointed_on": ...}, ...], newest-appointed first.
    CH officer names come back "SURNAME, Forename" — normalised to "Forename Surname".
    """
    url = CH_OFFICERS.format(number=company_number)
    _throttle()
    data = _get(url, {"items_per_page": 50}, api_key)
    if not data:
        return []

    directors = []
    for item in data.get("items", []):
        if item.get("resigned_on"):
            continue
        role = (item.get("officer_role") or "").lower()
        if role not in DIRECTOR_ROLES:
            continue
        directors.append({
            "name": _normalise_ch_name(item.get("name", "")),
            "role": item.get("officer_role", "director").replace("-", " ").title(),
            "appointed_on": item.get("appointed_on", ""),
        })

    directors.sort(key=lambda d: d["appointed_on"], reverse=True)
    return directors


def _normalise_ch_name(raw: str) -> str:
    """"SMITH, John Michael" -> "John Michael Smith". Falls back to raw on odd input."""
    if "," not in raw:
        return raw.strip()
    surname, given = raw.split(",", 1)
    surname = surname.strip().title()
    given = given.strip()
    if not given:
        return surname
    return f"{given} {surname}"


def format_address(address: dict) -> str:
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
