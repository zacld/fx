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
import http.client
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

CH_BASE = "https://api.company-information.service.gov.uk"
CH_SEARCH = f"{CH_BASE}/advanced-search/companies"
CH_COMPANY = f"{CH_BASE}/company/{{number}}"
CH_OFFICERS = f"{CH_BASE}/company/{{number}}/officers"

# Companies House allows 600 requests per 5 minutes per key. 0.5s between
# calls stays under it; set CH_RATE_LIMIT_SECONDS higher to leave headroom
# for other jobs sharing the key (the scheduled GitHub run uses 0.8).
RATE_LIMIT_SECONDS = float(os.environ.get("CH_RATE_LIMIT_SECONDS", "0.5"))
PAGE_SIZE = 50

# Officer roles held by a person who could take a call. "officer_role" is
# usually just "director" — the useful job title is the officer's filed
# `occupation` (e.g. "Finance Director"), returned alongside it. Corporate
# directors are left out: the "name" is another company, not a contact.
SECRETARY = "Company Secretary"
PERSON_ROLES = {
    "director": "Director",
    "llp-designated-member": "LLP Designated Member",
    "llp-member": "LLP Member",
}


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
        except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as e:
            # URLError: the request didn't go; OSError / HTTPException: a timeout or dropped connection while
            # reading the answer (urllib doesn't wrap those); ValueError: a body that isn't JSON.
            if attempt == retries:
                print(f"WARNING: Companies House request failed: {type(e).__name__}: {e}", file=sys.stderr)
                return None
            time.sleep(1)
    return None


_throttle_lock = threading.Lock()
_next_call = 0.0


def _throttle() -> None:
    """Space calls RATE_LIMIT_SECONDS apart across all threads (callers may run in parallel)."""
    global _next_call
    with _throttle_lock:
        now = time.monotonic()
        wait = max(0.0, _next_call - now)
        _next_call = max(now, _next_call) + RATE_LIMIT_SECONDS
    if wait:
        time.sleep(wait)


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
    """Fetch the full company profile (accounts, SIC codes, status)."""
    url = CH_COMPANY.format(number=company_number)
    _throttle()
    return _get(url, {}, api_key)


def get_last_accounts(company_number: str, api_key: str) -> dict:
    """
    {"accounts_category", "accounts_made_up_to"} from the company profile's
    last accounts (category e.g. "full", "medium", "group", "micro-entity";
    "" when unknown). Not in Advanced Search results, so it costs one
    profile call per company.
    """
    profile = get_company_profile(company_number, api_key) or {}
    last = (profile.get("accounts") or {}).get("last_accounts") or {}
    return {"accounts_category": last.get("type") or "", "accounts_made_up_to": last.get("made_up_to") or ""}


# A filed occupation that runs the finance function (people.is_finance_director, without importing people here).
_FINANCE_OCCUPATION = re.compile(r"chief financ|\bcfo\b|financ(?:e|ial) director|director of finance|\bf\.?d\b|"
                                 r"head of finance|finance (?:&|and) \w+ director", re.I)


def get_active_officers(company_number: str, api_key: str) -> list[dict]:
    return get_officers_and_former(company_number, api_key)[0]


def get_officers_and_former(company_number: str, api_key: str) -> tuple[list[dict], list[dict]]:
    """
    Active officers who are people — directors, LLP members and company
    secretaries — as [{"name", "role", "occupation", "appointed_on",
    "nationality", "country_of_residence", "birth_year"}], newest-appointed
    first. CH officer names come back "SURNAME, Forename" — normalised to
    "Forename Surname". In a mid-market private company the company
    secretary is often the finance director.

    Also, from the same call: former directors whose filed occupation was a
    finance role, [{"name", "occupation", "resigned_on"}], latest first — the
    company has an FD role even when today's FD isn't on the board.
    """
    url = CH_OFFICERS.format(number=company_number)
    _throttle()
    data = _get(url, {"items_per_page": 100}, api_key)
    if not data:
        return [], []

    officers, former = [], []
    for item in data.get("items", []):
        if item.get("resigned_on"):
            if (item.get("officer_role") or "").lower() in PERSON_ROLES and _FINANCE_OCCUPATION.search(item.get("occupation") or ""):
                former.append({"name": _normalise_ch_name(item.get("name", "")),
                               "occupation": (item.get("occupation") or "").strip(), "resigned_on": item["resigned_on"]})
            continue
        role = (item.get("officer_role") or "").lower()
        if role not in PERSON_ROLES and role != "secretary":
            continue
        officers.append({
            "name": _normalise_ch_name(item.get("name", "")),
            "role": PERSON_ROLES.get(role, SECRETARY),
            "occupation": (item.get("occupation") or "").strip(),
            "appointed_on": item.get("appointed_on", ""),
            "nationality": (item.get("nationality") or "").strip(),
            "country_of_residence": (item.get("country_of_residence") or "").strip(),
            "birth_year": (item.get("date_of_birth") or {}).get("year"),
            "appointments_url": CH_BASE + path if (path := ((item.get("links") or {}).get("officer") or {})
                                                   .get("appointments")) else "",
        })

    officers.sort(key=lambda d: d["appointed_on"], reverse=True)
    former.sort(key=lambda d: d["resigned_on"], reverse=True)
    return officers, former


_GENERIC_NAME_WORDS = {"LIMITED", "LTD", "PLC", "LLP", "UK", "GB", "GROUP", "HOLDINGS", "HOLDING", "INTERNATIONAL",
                       "SERVICES", "TRADING", "FOOD", "FOODS", "THE", "AND", "OF", "CO", "COMPANY", "EUROPE", "GLOBAL"}


def name_words(company_name: str) -> set[str]:
    """Distinctive words of a company name ("RANDALL PARKER FOOD GROUP LIMITED" -> {"RANDALL", "PARKER"})."""
    return {w for w in re.sub(r"[^A-Z0-9 ]+", " ", company_name.upper()).split()
            if w not in _GENERIC_NAME_WORDS and len(w) > 1}


def officer_appointments(appointments_url: str, api_key: str, related_to: set[str]) -> Optional[dict]:
    """
    {"active", "related"} for one officer: how many companies they're an
    active officer of, and how many of those share a distinctive name word
    with `related_to` (this company and its parent). A group finance
    director sits on the group's boards; a professional company secretary
    serves many unrelated companies.
    """
    if not appointments_url:
        return None
    _throttle()
    data = _get(appointments_url, {"items_per_page": 50}, api_key)
    if not data:
        return None
    active = [i for i in data.get("items", []) if not i.get("resigned_on")]
    count = data.get("active_count", len(active))
    related = sum(bool(name_words((i.get("appointed_to") or {}).get("company_name", "")) & related_to) for i in active)
    return {"active": count, "related": related}


def directors_only(officers: list[dict]) -> list[dict]:
    """Officers minus company secretaries."""
    return [o for o in officers if o["role"] != SECRETARY]


def get_active_directors(company_number: str, api_key: str) -> list[dict]:
    """Active directors / LLP members (no secretaries), newest-appointed first."""
    return directors_only(get_active_officers(company_number, api_key))


def get_owners(company_number: str, api_key: str, with_ceased: bool = False) -> list[dict]:
    """
    Persons with significant control as [{"kind": "individual" | "corporate" | "other",
    "name", "country", "nationality", "notified_on", "ceased_on", "registration_number"}].
    For a corporate owner `country` is where it's registered; for a person,
    their country of residence. Current owners only, unless `with_ceased`.
    """
    _throttle()
    data = _get(f"{CH_BASE}/company/{company_number}/persons-with-significant-control", {"items_per_page": 50}, api_key)
    owners = []
    for item in (data or {}).get("items", []):
        ceased_on = item.get("ceased_on") or ("unknown" if item.get("ceased") else "")
        if ceased_on and not with_ceased:
            continue
        kind = item.get("kind", "")
        ident = item.get("identification") or {}
        owners.append({
            "kind": "individual" if kind.startswith("individual") else "corporate" if kind.startswith("corporate") else "other",
            "name": _person_name(item),
            "country": (ident.get("country_registered") or ident.get("place_registered")
                        or item.get("country_of_residence") or "").strip(),
            "nationality": (item.get("nationality") or "").strip(),
            "notified_on": item.get("notified_on") or "",
            "ceased_on": ceased_on,
            "registration_number": (ident.get("registration_number") or "").strip(),
        })
    return owners


# The register spells some holders "Hsbc UK Bank PLC": put the initialisms back.
_INITIALISMS = {"Hsbc": "HSBC", "Rbs": "RBS", "Bnp": "BNP", "Abn": "ABN", "Amro": "AMRO", "Uk": "UK", "Plc": "PLC",
                "Llp": "LLP", "Nv": "NV", "Ag": "AG", "Sa": "SA", "Ubs": "UBS", "Ing": "ING", "Rbsi": "RBSI"}
_INITIALISM_RE = re.compile(r"\b(" + "|".join(_INITIALISMS) + r")\b")


def holder_name(name: str) -> str:
    return _INITIALISM_RE.sub(lambda m: _INITIALISMS[m.group(1)], " ".join(name.split()))


# The public Companies House site, for links a person can open (no API key needed).
FIND_URL = "https://find-and-update.company-information.service.gov.uk"


def public_url(path: str) -> str:
    """A Companies House API path ("/company/01/charges/abc") as a page on the public site, or ""."""
    return f"{FIND_URL}{path}" if path and path.startswith("/company/") else ""


def get_charges(company_number: str, api_key: str) -> list[dict]:
    """
    Every charge on the register, one entry per holder per charge, as
    [{"name", "created_on", "status", "satisfied_on", "classification",
    "particulars", "floating_all", "floating", "url"}] (url: the charge's
    page on the public register). status is "outstanding",
    "part-satisfied", "fully-satisfied" (or similar); the last four say what
    the charge covers (e.g. a debenture over all assets, a property).
    """
    _throttle()
    data = _get(f"{CH_BASE}/company/{company_number}/charges", {"items_per_page": 100}, api_key)
    charges = []
    for item in (data or {}).get("items", []):
        for entitled in item.get("persons_entitled") or []:
            name = holder_name(entitled.get("name") or "")
            if name:
                charges.append({"name": name, "created_on": item.get("created_on") or "",
                                "status": item.get("status") or "outstanding",
                                "satisfied_on": item.get("satisfied_on") or "",
                                # what the charge covers, as registered (same answer, no extra call)
                                "classification": ((item.get("classification") or {}).get("description") or "").strip(),
                                "particulars": " ".join(((item.get("particulars") or {}).get("description") or "").split())[:300],
                                "floating_all": bool((item.get("particulars") or {}).get("floating_charge_covers_all")),
                                "floating": bool((item.get("particulars") or {}).get("contains_floating_charge")),
                                "url": public_url((item.get("links") or {}).get("self") or "")})
    return charges


def outstanding(charges: list[dict]) -> list[dict]:
    """The charges still in force (outstanding or part-satisfied)."""
    return [c for c in charges if c["status"] in ("outstanding", "part-satisfied")]


def get_lenders(company_number: str, api_key: str) -> list[dict]:
    """
    Holders of the company's outstanding charges — usually its bank, or an
    asset/invoice financier — as [{"name", "created_on", ...}], one per holder per charge.
    """
    return outstanding(get_charges(company_number, api_key))


def _person_name(item: dict) -> str:
    """"Forename Surname" from a PSC's name parts (no "Mr"), else its name as given."""
    parts = item.get("name_elements") or {}
    if parts.get("surname"):
        return " ".join(p for p in (parts.get("forename"), parts.get("surname", "").title()) if p)
    return _normalise_ch_name(item.get("name", ""))


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
    """Registered office as one line, postcode excluded (it gets its own column)."""
    parts = [
        address.get("premises"),
        address.get("address_line_1"),
        address.get("address_line_2"),
        address.get("locality"),
        address.get("region"),
    ]
    return ", ".join(p for p in parts if p)
