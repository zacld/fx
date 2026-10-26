#!/usr/bin/env python3
"""
main.py — FX lead sourcer: UK companies with foreign-currency flows, sized
for a bank FX desk (core band £25m–£250m turnover).

For each company: the evidence that it pays or is paid in foreign currency,
which currencies most likely, roughly how much a year, who it banks with,
its best finance contact (FD, CFO, financial controller, treasurer) and
lead director.

How:
  1. Candidates — companies in the FX niches (config/fx_niches.json) with
     medium, large ("full") or group accounts, plus every company HMRC
     customs records show importing or exporting. Sources: HMRC's monthly
     importer/exporter files and Companies House's free monthly bulk file,
     matched on name and postcode (or the search API, a capped sample).
  2. Size — turnover from the latest filed accounts (iXBRL). Under the
     floor: dropped. Core / Above / Below the band otherwise.
  3. Currency — the company's commodity codes x where the UK trades each
     code (HMRC trade statistics), each country mapped to its usual
     invoicing currency: "EUR 62%, USD 38%".
  4. Wallet — purchases (cost of sales, else 70% of turnover) x an import
     share, plus turnover x an export share, banded by how regularly the
     company shows up in customs records. A range, with its basis.
  5. Bank — the "Bankers" line in the accounts and the charges register:
     main bank, type, new charges in the last year, and (with --own-bank)
     whether it's already your client.
  6. People — the best finance contact, from (strongest first) a filed
     occupation, a finance title in the accounts, the company's own
     website, the company secretary, the director who signed the accounts;
     plus the lead director and owners (PSCs).

No AI calls, no LinkedIn or social sites, no phone lookups, no outreach.
Public HMRC and Companies House data, plus — only when those name no
finance person — up to 4 pages of the company's own website.

Usage:
  export COMPANIES_HOUSE_API_KEY=...         # needed for accounts, directors, owners, charges
  python3 main.py                             # every niche + customs traders -> fx_companies.xlsx
  python3 main.py --own-bank Barclays         # flag Barclays' existing clients
  python3 main.py --band-min 10000000 --band-max 100000000
  python3 main.py --niches european-wine-importers,spirits-importers
  python3 main.py --max-enrich 200            # check 200 companies; the rest ship unchecked
  python3 main.py --list-niches
Without --bulk-file the bulk file (~470MB) is downloaded once a month into
~/.cache/fx-lead-sourcer; HMRC files are cached under ~/.cache/fx-lead-sourcer/hmrc.
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import os
import sys
from collections import Counter
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from typing import Optional, Union

from sourcer import (
    accounts, banks, bulk, companies_house, currency, excel, hmrc, hooks, incumbent, matching, news, people, profiles,
    qualify, register_cache, registries, roles, signals, timing, triggers, website)

CSV_FIELDS = [
    "section",
    "company_name",
    "company_number",
    "trading_as",
    "finance_contact",
    "finance_contact_role",
    "finance_contact_source",
    "finance_contact_confidence",
    "finance_contact_evidence",
    "verify_finance_contact_url",
    "linkedin_search_url",
    "lead_director",
    "lead_director_occupation",
    "triggers",
    "when_to_call",
    "planning_window_now",
    "qualified",
    "qualify_reason",
    "warm_route",
    "fact_1",
    "fact_2",
    "main_currency",
    "currency_direction",
    "currency_evidence",
    "currency_confidence",
    "opener",
    "fx_estimate",
    "incumbent_bank",
    "facility_ends",
    "facility_ends_evidence",
    "lenders",
    "fx_today",
    "fx_today_evidence",
    "turnover_gbp",
    "turnover_period_end",
    "fx_wallet_low_gbp",
    "fx_wallet_high_gbp",
    "fx_wallet_basis",
    "import_currencies",
    "export_currencies",
    "currency_pairs",
    "trade_countries",
    "main_bank",
    "bank_type",
    "banking_relationships",
    "own_bank_client",
    "pe_backed",
    "group_parent",
    "group_companies_in_list",
    "group_fx_wallet_high_gbp",
    "parent_finance_contact",
    "fx_evidence_score",
    "fx_evidence_level",
    "fx_evidence",
    "untapped_score",
    "untapped_level",
    "untapped_reasons",
    "family_run",
    "fx_niche",
    "fx_exposure",
    "call_angle",
    "hmrc_import_months",
    "hmrc_export_months",
    "hmrc_goods",
    "hmrc_match",
    "fx_gain_loss_gbp",
    "fx_gain_loss_prior_gbp",
    "fx_gain_loss_check",
    "turnover_growth",
    "overseas_turnover_share",
    "cost_of_sales_gbp",
    "cash_gbp",
    "bank_borrowings_gbp",
    "net_assets_gbp",
    "auditor",
    "auditor_tier",
    "size_basis",
    "accounts_category",
    "accounts_format",
    "all_directors",
    "company_secretary",
    "accounts_signed_by",
    "website",
    "generic_emails",
    "owners",
    "sic_codes",
    "incorporated_on",
    "postcode",
    "registered_address",
    "companies_house_url",
]

_HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_OUTPUT = "fx_companies.xlsx"
DEFAULT_NICHES_FILE = os.path.join(_HERE, "config", "fx_niches.json")
# The target band: mid-market and lower-corporate clients for a bank's FX desk.
DEFAULT_BAND_MIN = 25_000_000
DEFAULT_BAND_MAX = 250_000_000
DEFAULT_MIN_TURNOVER = DEFAULT_BAND_MIN    # floor: filed turnover under this is dropped
SMALL_COMPANY_MAX_TURNOVER = 15_000_000    # small-company accounts limit (from April 2025)
DEFAULT_HMRC_MONTHS = 12
DEFAULT_MIN_TRADE_MONTHS = 3               # small-accounts companies need this many months of customs records
DEFAULT_MAX_PER_SIC = 25  # search API source only
CH_WORKERS = int(os.environ.get("CH_WORKERS", "4"))  # companies checked at once (API calls still rate-limited)

# Last-accounts categories that put a company in the frame. Medium, large
# ("full") and group filers are kept unless their filed turnover is under
# the minimum. Audit-exempt subsidiaries can be any size, so they're kept
# only when filed turnover confirms it. Everything else — small, micro,
# dormant, abridged — is under the size or files no figures to tell.
# Listed in checking order: large ("full") first — mostly inside the
# £25m–£250m band — then medium (up to £54m), then group parents.
LIKELY_CATEGORIES = ("full", "medium", "group")
CONFIRM_CATEGORIES = ("audit-exemption-subsidiary",)
CANDIDATE_CATEGORIES = LIKELY_CATEGORIES + CONFIRM_CATEGORIES
# Small-company accounts rarely show turnover, so these only come in with
# HMRC customs records proving regular trade — the family-firm pool.
SMALL_TRADER_CATEGORIES = ("small", "total-exemption-full", "audited-abridged", "unaudited-abridged", "partial-exemption")
_CATEGORY_ORDER = {c: i for i, c in enumerate(CANDIDATE_CATEGORIES)}


def _millions(value: int) -> str:
    return f"£{value / 1e6:g}m"


def sections(band_min: int = DEFAULT_BAND_MIN, band_max: int = DEFAULT_BAND_MAX) -> tuple[str, str, str]:
    """(core, above, below) section labels for a turnover band."""
    return (f"Core ({_millions(band_min)}–{_millions(band_max)})", f"Above ({_millions(band_max)}+)",
            f"Below (under {_millions(band_min)})")


SECTION_CORE, SECTION_ABOVE, SECTION_BELOW = sections()


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def new_row(**overrides) -> dict:
    row = {field: "" for field in CSV_FIELDS}
    row.update(overrides)
    return row


def write_csv(rows: list[dict], output_path: str) -> None:
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def write_output(rows: list[dict], output_path: str, band: tuple[int, int] = (DEFAULT_BAND_MIN, DEFAULT_BAND_MAX)) -> None:
    """An Excel workbook (opens in Google Sheets too) for .xlsx paths, else CSV."""
    if output_path.lower().endswith(".xlsx"):
        excel.write_workbook(rows, CSV_FIELDS, output_path, section_order=sections(*band))
    else:
        write_csv(rows, output_path)


def parse_niche_ids(value: Union[str, list, None]) -> Optional[list[str]]:
    """Niche ids from a comma-separated string or a list; None means every niche."""
    if value is None or value == "":
        return None
    items = value.split(",") if isinstance(value, str) else value
    if not isinstance(items, list):
        raise ValueError("niches must be a list of niche ids or a comma-separated string")
    ids = [str(i).strip() for i in items if str(i).strip()]
    return ids or None


def parse_positive_int(value, name: str) -> Optional[int]:
    """A positive int, or None if not given. Raises ValueError otherwise."""
    if value is None or value == "":
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be a positive integer") from None
    if n < 1:
        raise ValueError(f"{name} must be a positive integer")
    return n


def options_from_request(body) -> dict:
    """
    run_pipeline() options from an HTTP JSON body — shared by server.py and
    api/run.py. Body: {"niches": [id, ...] or "id,id", "max_per_sic": int,
    "min_turnover": int, "turnover_check": bool, "max_enrich": int,
    "own_bank": str}, all optional. Raises ValueError (-> HTTP 400) on anything invalid.
    """
    if not isinstance(body, dict):
        raise ValueError("JSON body must be an object")
    options = {
        "niche_ids": parse_niche_ids(body.get("niches")),
        "max_per_sic": parse_positive_int(body.get("max_per_sic"), "max_per_sic"),
        "min_turnover": parse_positive_int(body.get("min_turnover"), "min_turnover") or DEFAULT_MIN_TURNOVER,
        "turnover_check": bool(body.get("turnover_check", True)),
        "max_enrich": parse_positive_int(body.get("max_enrich"), "max_enrich"),
    }
    if body.get("own_bank"):
        options["own_bank"] = str(body["own_bank"]).strip()
    if options["niche_ids"]:
        load_niches(DEFAULT_NICHES_FILE, options["niche_ids"])  # unknown id -> ValueError
    return options


# ---------------------------------------------------------------------------
# Niches and candidates
# ---------------------------------------------------------------------------

def load_niches(path: str, niche_ids: Optional[list[str]] = None) -> list[dict]:
    """FX niches from `path`; only `niche_ids` if given (an unknown id raises ValueError)."""
    with open(path, encoding="utf-8") as f:
        niches = json.load(f).get("niches", [])
    if niche_ids:
        unknown = sorted(set(niche_ids) - {n["id"] for n in niches})
        if unknown:
            raise ValueError(f"unknown niche id(s): {', '.join(unknown)} — see --list-niches")
        wanted = set(niche_ids)
        niches = [n for n in niches if n["id"] in wanted]
    return niches


def best_niche(company_sics: list[str], candidates: list[dict]) -> dict:
    """
    The candidate niche sharing the most SIC codes with the company, so a
    company registered under a code several niches share lands in the niche
    that fits it best. Ties go to the niche listed first.
    """
    sics = set(company_sics)
    return max(candidates, key=lambda n: len(sics & set(n.get("sic_codes", []))))


def candidates_from_api(niches: list[dict], max_per_sic: int, api_key: str) -> list[dict]:
    """
    Up to `max_per_sic` companies per SIC code from the search API, each
    with its last accounts from a profile call — a sample, not the full set.
    """
    found: dict[str, dict] = {}
    searched: set[str] = set()
    for niche in niches:
        for sic in map(str, niche.get("sic_codes", [])):
            if sic in searched:
                continue
            searched.add(sic)
            print(f"  SIC {sic}…", end=" ", flush=True)
            items = companies_house.search_by_sic(sic, api_key, max_per_sic, "active")
            print(f"{len(items)} results")
            for item in items:
                if item.get("company_number"):
                    found.setdefault(item["company_number"], item)

    candidates = []
    for number, item in found.items():
        company_type = item.get("company_type") or ""
        if "guarant" in company_type or "charit" in company_type:
            continue
        last_accounts = companies_house.get_last_accounts(number, api_key)
        if last_accounts["accounts_category"] not in CANDIDATE_CATEGORIES:
            continue
        address = item.get("registered_office_address") or {}
        candidates.append({
            "company_number": number,
            "company_name": item.get("company_name", ""),
            "sic_codes": [str(s) for s in item.get("sic_codes") or []],
            **last_accounts,
            "incorporated_on": item.get("date_of_creation", ""),
            "postcode": address.get("postal_code", ""),
            "registered_address": companies_house.format_address(address),
        })
    return candidates


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------

def describe_size(category: str, turnover: Optional[dict], turnover_checked: bool) -> str:
    if turnover:
        return f"filed turnover £{turnover['turnover'] / 1e6:,.1f}m (accounts to {turnover['period_end']})"
    found = "not in the filing" if turnover_checked else "not checked"
    return f"last accounts filed as {category}; turnover {found}"


def section_for(company: dict, turnover: Optional[dict], band: tuple[int, int] = (DEFAULT_BAND_MIN, DEFAULT_BAND_MAX)) -> str:
    """Core / Above / Below the turnover band; without filed turnover, medium/large/group accounts count as core."""
    core, above, below = sections(*band)
    if turnover:
        value = turnover["turnover"]
        return below if value < band[0] else above if value > band[1] else core
    return core if company["accounts_category"] in CANDIDATE_CATEGORIES else below


def trader_niche(trade: dict) -> dict:
    """A stand-in niche for proven traders outside the niche SIC codes, described by what they trade."""
    goods = hmrc.chapters(trade["import_codes"] + trade["export_codes"])
    flows = " and ".join(f for f, k in (("imports", "import_months"), ("exports", "export_months")) if trade[k])
    return {
        "id": "_hmrc_trader", "name": "Proven trader: " + ", ".join(goods), "sic_codes": [], "currency_pairs": [],
        "exposure_reason": f"HMRC customs records show regular {flows} of {', '.join(goods)}.",
        "call_angle": "",
    }


def _money(value: Optional[float]) -> str:
    return str(round(value)) if value is not None else ""


def group_parent(owners: list[dict]) -> tuple[str, str]:
    """(key, label) for the company's UK parent from its corporate owners, or ("", "")."""
    for o in owners:
        if o["kind"] == "corporate" and not o.get("ceased_on"):
            number = o.get("registration_number", "").replace(" ", "").upper()
            key = number.zfill(8) if number.isdigit() else number or o["name"].upper()
            return key, f"{o['name']} ({number})" if number else o["name"]
    return "", ""


def add_group_rollup(rows: list[dict], parents: dict[str, tuple[str, str]]) -> int:
    """
    Fill the group columns for companies sharing a parent (the parent itself
    included when it's in the list): how many are in the list and their
    combined wallet. Returns the number of groups with 2+ companies.
    """
    members: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        key, _ = parents.get(row["company_number"], ("", ""))
        if key:
            members[key].append(row)
    by_number = {r["company_number"].zfill(8): r for r in rows}
    groups = 0
    for key, rows_in in members.items():
        parent_row = by_number.get(key)
        if parent_row is not None and parent_row not in rows_in:
            rows_in.append(parent_row)
        label = parents[rows_in[0]["company_number"]][1] if rows_in[0]["company_number"] in parents else key
        if len(rows_in) < 2:
            rows_in[0]["group_parent"] = label
            continue
        groups += 1
        total = sum(int(r["fx_wallet_high_gbp"] or 0) for r in rows_in)
        for r in rows_in:
            r["group_parent"] = label
            r["group_companies_in_list"] = len(rows_in)
            r["group_fx_wallet_high_gbp"] = str(total) if total else ""
            if parent_row is not None and r is not parent_row and parent_row["finance_contact"]:
                # Group treasury usually sits with the parent.
                r["parent_finance_contact"] = (f"{parent_row['finance_contact']} ({parent_row['finance_contact_role']}) "
                                               f"at {parent_row['company_name']}")
    return groups


def finance_contact(officers: list[dict], facts: dict, site: Optional[dict] = None,
                    news_people: Optional[list[dict]] = None, registry_people: Optional[list[dict]] = None) -> Optional[dict]:
    """people.choose_finance_contact() from everything gathered for one company."""
    site = site or {}
    return people.choose_finance_contact(
        officers, facts.get("finance_people", []), site.get("people", []), facts.get("signatory", ""),
        qualified=facts.get("qualified", []) + site.get("qualified", []), news_people=news_people or [],
        registry_people=registry_people or [])


def registry_people_for(entries: list[dict], today: date) -> list[dict]:
    """A company's registry filings, graded like news items: Confirmed when 2 years old or less."""
    cutoff = date(today.year - 2, today.month, min(today.day, 28)).isoformat()
    return [{**e, "confidence": people.CONFIRMED if e["date"] >= cutoff else people.LIKELY,
             "note": e["date"][:7]} for e in entries]


def company_row(
    niche: dict,
    company: dict,
    turnover: Optional[dict],
    directors: list[dict],
    turnover_checked: bool,
    trade: Optional[dict] = None,
    months_loaded: int = 0,
    facts: Optional[dict] = None,
    owners: Optional[list[dict]] = None,
    bank: Optional[dict] = None,
    checked: bool = True,
    trade_model: Optional[currency.TradeByCountry] = None,
    band: tuple[int, int] = (DEFAULT_BAND_MIN, DEFAULT_BAND_MAX),
    charges: Optional[list[dict]] = None,
    today: Optional[date] = None,
    site: Optional[dict] = None,
    news_people: Optional[list[dict]] = None,
    registry_people: Optional[list[dict]] = None,
    appointments: Optional[dict] = None,
    own_bank_name: str = "",
) -> dict:
    """
    One CSV row. `directors` may include company secretaries (they count as
    finance-contact clues, not directors); `owners` may include ceased ones
    (they count only as ownership-change triggers).
    """
    officers = directors
    directors = companies_house.directors_only(officers)
    site = site or {}
    history = owners or []
    owners = [o for o in history if not o.get("ceased_on")]
    bank = bank or {}
    f = facts or {}
    contact = finance_contact(officers, f, site, news_people, registry_people)
    proof = people.corroborate(contact, officers, f.get("finance_people", []), site.get("people", []),
                               f.get("signatory", ""), news_people or [], registry_people or [], appointments, today)
    lead = roles.pick_lead_director(directors, exclude=contact["officer"] if contact else None)
    secretary = next((o["name"] for o in officers if o["role"] == companies_house.SECRETARY), "")
    is_family, family_reason = signals.family_run(directors, owners)
    fx_score, fx_level, fx_lines = signals.fx_evidence(
        trade, months_loaded, facts, owners, directors, niche_match=niche.get("id") != "_hmrc_trader")
    if checked:
        un_score, un_level, un_lines = signals.untapped(
            owners, is_family, facts, company.get("incorporated_on", ""))
    else:
        un_score, un_level, un_lines = "", "", ["not checked"]
    imports = exports = import_countries = export_countries = None
    if trade and trade_model is not None:
        imports, import_countries = currency.mix(trade_model, "import", trade["import_codes"])
        exports, export_countries = currency.mix(trade_model, "export", trade["export_codes"])
    pairs = currency.pairs(imports, exports) if imports or exports else niche.get("currency_pairs", [])
    countries = "; ".join(f"{label} {currency.describe(c, top=4)}" for label, c in
                          (("from", import_countries), ("to", export_countries)) if c)
    cost_of_sales = f.get("cost_of_sales")
    wallet = currency.wallet(turnover["turnover"] if turnover else None, cost_of_sales,
                             len(trade["import_months"]) if trade else 0, len(trade["export_months"]) if trade else 0,
                             overseas_share=f.get("overseas_share"))
    events = triggers.find(history, charges or [], directors, today) if checked else []
    events += [f"new finance lead {p['name']} ({p['date'][:7]}, news) — new people review providers"
               for p in (news_people or [])[:1] if news.is_recent(p["date"], today)]
    verify_url, linkedin_url = news.verify_links(company["company_name"], contact["name"] if contact else "")
    when, planning_now = timing.when_to_call(trade, (turnover or {}).get("period_end") or f.get("period_end")
                                             or company.get("accounts_made_up_to", ""), today)
    growth = (turnover["turnover"] / f["turnover_prior"] - 1) if turnover and f.get("turnover_prior") else None
    number = company["company_number"]
    # Call hooks and currency exposure: only from records fetched above (blank when nothing qualifies).
    customs = {"imports": currency.describe(imports) if imports else "",
               "exports": currency.describe(exports) if exports else "",
               "import_months": len(trade["import_months"]) if trade else 0,
               "export_months": len(trade["export_months"]) if trade else 0}
    talking = (hooks.columns(company["company_name"], f, officers, charges or [], owners, niche, news_people, today,
                             customs) if checked else {})
    # The incumbent (who holds the security, when the facility is up), how they do FX today, and qualify-out.
    if checked:
        talking.update(incumbent.columns(f, charges or [], today))
        talking.update(qualify.assess(owners, f, {"confidence": talking["currency_confidence"]}, talking["fx_today"],
                                      customs["import_months"] + customs["export_months"], bool(bank.get("own_bank")),
                                      own_bank_name or os.environ.get("OWN_BANK", "").strip(), triggers.investor_owner(owners)))
        talking["fx_estimate"] = hooks.size_estimate(wallet["low"], wallet["high"], wallet["basis"]) if wallet else ""
    return new_row(
        **talking,
        section=section_for(company, turnover, band),
        company_name=company["company_name"],
        company_number=number,
        triggers=" | ".join(events),
        when_to_call=when,
        planning_window_now="yes" if planning_now else "",
        pe_backed=triggers.investor_owner(owners),
        fx_gain_loss_prior_gbp=_money(f.get("fx_gain_loss_prior")),
        fx_gain_loss_check=f.get("fx_gain_loss_check", ""),
        turnover_growth=f"{growth * 100:+.0f}%" if growth is not None else "",
        overseas_turnover_share=f"{f['overseas_share'] * 100:.0f}%" if f.get("overseas_share") is not None else "",
        cash_gbp=_money(f.get("cash")),
        bank_borrowings_gbp=_money(f.get("bank_borrowings")),
        net_assets_gbp=_money(f.get("net_assets")),
        auditor=f.get("auditor", ""),
        auditor_tier=f.get("auditor_tier", ""),
        fx_wallet_low_gbp=str(int(round(wallet["low"], -5))) if wallet else "",
        fx_wallet_high_gbp=str(int(round(wallet["high"], -5))) if wallet else "",
        fx_wallet_basis=wallet["basis"] if wallet else ("no filed turnover" if trade else "no customs records"),
        import_currencies=currency.describe(imports) if imports else "",
        export_currencies=currency.describe(exports) if exports else "",
        trade_countries=countries,
        main_bank=bank.get("main", ""),
        bank_type=bank.get("main_type", ""),
        banking_relationships=bank.get("summary", ""),
        own_bank_client="yes" if bank.get("own_bank") else "",
        fx_evidence_score=fx_score,
        fx_evidence_level=fx_level,
        fx_evidence=" | ".join(fx_lines),
        untapped_score=un_score,
        untapped_level=un_level,
        untapped_reasons=" | ".join(un_lines),
        family_run=family_reason if is_family else "",
        fx_niche=niche.get("name", ""),
        currency_pairs="|".join(pairs),
        fx_exposure=niche.get("exposure_reason", ""),
        call_angle=niche.get("call_angle", ""),
        hmrc_import_months=len(trade["import_months"]) if trade else "",
        hmrc_export_months=len(trade["export_months"]) if trade else "",
        hmrc_goods=", ".join(hmrc.chapters(trade["import_codes"] + trade["export_codes"])) if trade else "",
        hmrc_match=trade["confidence"] if trade else "",
        turnover_gbp=str(round(turnover["turnover"])) if turnover else "",
        turnover_period_end=turnover["period_end"] if turnover else "",
        fx_gain_loss_gbp=_money(f.get("fx_gain_loss")),
        cost_of_sales_gbp=_money(cost_of_sales),
        size_basis=describe_size(company["accounts_category"], turnover, turnover_checked),
        accounts_category=company["accounts_category"],
        accounts_format=f.get("format", ""),
        trading_as="; ".join(profiles.trading_names("; ".join(f"trading as {n}" for n in f.get("trading_names") or []),
                                                    company["company_name"])),
        finance_contact=contact["name"] if contact else "",
        finance_contact_role=contact["role"] if contact else "",
        finance_contact_source=contact["source"] if contact else "",
        finance_contact_confidence=proof["confidence"],
        finance_contact_evidence="; ".join(proof["evidence"]),
        verify_finance_contact_url=verify_url if checked else "",
        linkedin_search_url=linkedin_url if checked else "",
        company_secretary=secretary,
        accounts_signed_by=f.get("signatory", ""),
        website=site.get("website", ""),
        generic_emails="; ".join(site.get("emails", [])),
        lead_director=lead["name"] if lead else "",
        lead_director_occupation=(lead["occupation"] or lead["role"]) if lead else "",
        all_directors="; ".join(f"{d['name']} ({d['occupation'] or d['role']})" for d in directors),
        owners="; ".join(f"{o['name']} ({o['kind']}{', ' + o['country'].title() if o['country'] else ''})" for o in owners),
        sic_codes="|".join(company["sic_codes"]),
        incorporated_on=company.get("incorporated_on", ""),
        postcode=company.get("postcode", ""),
        registered_address=company.get("registered_address", ""),
        companies_house_url=f"https://find-and-update.company-information.service.gov.uk/company/{number}",
    )


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def load_trade_evidence(hmrc_months: int, hmrc_files: Optional[list[str]]) -> tuple[dict, int]:
    """(traders keyed (name, postcode), number of months loaded) — empty if HMRC is off or unreachable."""
    if not hmrc_months and not hmrc_files:
        return {}, 0
    try:
        paths, since = (hmrc_files, "") if hmrc_files is not None else hmrc.download(hmrc_months)
    except Exception as e:  # noqa: BLE001 — customs evidence is a bonus; the run still works without it
        print(f"WARNING: HMRC trader files unavailable ({e}); continuing without customs evidence")
        return {}, 0
    traders = hmrc.build_traders(paths, since)
    months = {m for t in traders.values() for m in t["import_months"] | t["export_months"]}
    print(f"  HMRC: {len(traders):,} distinct traders over {len(months)} months")
    return traders, len(months)


def load_trade_model(months: int, stats_files: Optional[list[str]]) -> Optional[currency.TradeByCountry]:
    """National trade by goods x country, for the currency mix — None if unavailable."""
    try:
        paths, since = (stats_files, "") if stats_files is not None else hmrc.download(months, kind="stats")
    except Exception as e:  # noqa: BLE001 — currency mix is a bonus; the run still works without it
        print(f"WARNING: HMRC trade statistics unavailable ({e}); continuing without currency mix")
        return None
    model = currency.TradeByCountry.from_files(paths, since)
    print(f"  HMRC trade statistics: {len(model):,} commodity codes with country values")
    return model


def run_pipeline(
    niche_ids: Optional[list[str]] = None,
    niches_path: str = DEFAULT_NICHES_FILE,
    source: str = "bulk",
    bulk_file: Optional[str] = None,
    max_per_sic: Optional[int] = None,
    min_turnover: int = DEFAULT_MIN_TURNOVER,
    turnover_check: bool = True,
    max_enrich: Optional[int] = None,
    hmrc_months: int = DEFAULT_HMRC_MONTHS,
    hmrc_files: Optional[list[str]] = None,
    min_trade_months: int = DEFAULT_MIN_TRADE_MONTHS,
    band_min: int = DEFAULT_BAND_MIN,
    band_max: int = DEFAULT_BAND_MAX,
    own_bank: str = "",
    stats_files: Optional[list[str]] = None,
    today: Optional[date] = None,
    websites: bool = True,
    news_check: bool = True,
    registry_check: bool = True,
) -> list[dict]:
    """
    Find the companies and return one row per company (does not write a
    CSV — callers decide where output goes). Shared by the CLI, server.py
    and api/run.py so they never drift. Raises ValueError for bad options
    and FileNotFoundError for a missing niches file, before any download
    or API call. Without COMPANIES_HOUSE_API_KEY the bulk source still
    lists candidates, just without the checks or directors.

    Candidates: niche companies (SIC + medium/large/group accounts) plus, on
    the bulk source, every company HMRC customs records show importing or
    exporting regularly — including small-accounts family firms whose
    turnover isn't public (only when min_turnover is under the small-company
    limit). Companies with customs evidence are checked first.
    """
    if source not in ("bulk", "api"):
        raise ValueError("source must be 'bulk' or 'api'")
    max_per_sic = parse_positive_int(max_per_sic, "max_per_sic") or DEFAULT_MAX_PER_SIC
    max_enrich = parse_positive_int(max_enrich, "max_enrich")
    if not os.path.exists(niches_path):
        raise FileNotFoundError(f"FX niches file not found: {niches_path}")
    niches = load_niches(niches_path, niche_ids)
    api_key = companies_house.get_api_key()
    if source == "api" and not api_key:
        raise ValueError("the search API source needs COMPANIES_HOUSE_API_KEY")

    if band_min >= band_max:
        raise ValueError("band_min must be under band_max")
    band = (band_min, band_max)
    today = today or date.today()
    own_bank = own_bank or os.environ.get("OWN_BANK", "").strip()
    print(f"FX Lead Sourcer — FX-exposed companies, core band {_millions(band_min)}–{_millions(band_max)}, "
          f"floor {_millions(min_turnover)}")
    print(f"  Niches: {len(niches)} | source: {source} | "
          f"Companies House key: {'set' if api_key else 'MISSING — listing candidates only, no checks or directors'}")

    trade_by_company: dict[str, dict] = {}
    months_loaded = 0
    trade_model = None
    if source == "api":
        candidates = candidates_from_api(niches, max_per_sic, api_key)
    else:
        traders, months_loaded = load_trade_evidence(hmrc_months, hmrc_files)
        path = bulk_file or bulk.download()
        print(f"  Bulk file: {path}")
        sics = {str(s) for n in niches for s in n.get("sic_codes", [])}
        candidates, by_postcode, by_name = bulk.scan(
            path, sics, set(CANDIDATE_CATEGORIES),
            postcodes={pc for _, pc in traders} or None, names={n for n, _ in traders} or None)
        if traders:
            trade_by_company = matching.match_all(traders, by_postcode, by_name)
            print(f"  HMRC traders matched to companies: {len(trade_by_company):,} "
                  f"({sum(e['confidence'] == 'high' for e in trade_by_company.values()):,} high confidence)")
            trade_model = load_trade_model(hmrc_months or DEFAULT_HMRC_MONTHS, stats_files)
            small_ok = min_turnover < SMALL_COMPANY_MAX_TURNOVER
            known = {c["company_number"] for c in candidates}
            for number, evidence in trade_by_company.items():
                company = evidence["company"]
                months = len(evidence["import_months"] | evidence["export_months"])
                if number in known:
                    continue
                if company["accounts_category"] in CANDIDATE_CATEGORIES or (small_ok and
                        company["accounts_category"] in SMALL_TRADER_CATEGORIES and months >= min_trade_months):
                    candidates.append(company)
                    known.add(number)

    niche_position = {n["id"]: i for i, n in enumerate(niches)}
    queue = []
    for company in candidates:
        trade = trade_by_company.get(company["company_number"])
        matching_niches = [n for n in niches if set(map(str, n.get("sic_codes", []))) & set(company["sic_codes"])]
        if matching_niches:
            niche = best_niche(company["sic_codes"], matching_niches)
        elif trade:
            niche = trader_niche(trade)
        else:
            continue
        queue.append((niche, company, trade))
    # Proven traders first (most months of customs records), then niche order and sweet-spot
    # accounts category, so a capped run spends its API budget where the evidence is.
    queue.sort(key=lambda q: (
        -(len(q[2]["import_months"] | q[2]["export_months"]) if q[2] else 0),
        niche_position.get(q[0]["id"], len(niches)),
        _CATEGORY_ORDER.get(q[1]["accounts_category"], 99),
        q[1]["company_name"],
    ))

    budget = 0 if not api_key else len(queue) if max_enrich is None else max_enrich
    print(f"  Candidates: {len(queue):,} ({sum(1 for q in queue if q[2]):,} with customs evidence) | "
          f"checking {min(budget, len(queue)):,}")

    # gov.uk registries naming a person with a job title (gender pay gap, modern slavery): two bulk files a year.
    in_registries = registries.load(today) if registry_check and budget else {}
    if in_registries:
        print(f"  Registry filings naming a person (gender pay gap, modern slavery): {len(in_registries):,} companies")

    stats: Counter = Counter()
    pending: list[dict] = []   # company_row arguments, finished once websites are in
    parents: dict[str, tuple[str, str]] = {}
    def gather(item: tuple) -> tuple:
        """Accounts + register lookups for one company: (skip reason or "", details)."""
        position, (niche, company, trade) = item
        checked = position < budget
        number = company["company_number"]
        made_up = company.get("accounts_made_up_to", "")
        # read on an earlier run within REGISTER_CACHE_DAYS (and no newer accounts since): no Companies House calls
        cached = register_cache.load(number, made_up) if checked and turnover_check else None
        facts = cached["facts"] if cached else (
            accounts.facts_from_latest_accounts(number, api_key) if checked and turnover_check else None)
        if facts:
            accounts.check_fx(facts)   # cached facts too, read before a check existed
        turnover = ({"turnover": facts["turnover"], "period_end": facts["period_end"]}
                    if facts and facts["turnover"] is not None else None)
        if turnover is not None and turnover["turnover"] < min_turnover:
            if not cached:
                register_cache.store(number, made_up, {"facts": facts})
            return "under_min", None
        if turnover is None and company["accounts_category"] not in LIKELY_CATEGORIES and not trade:
            if not cached and checked and turnover_check:
                register_cache.store(number, made_up, {"facts": facts})
            return "unconfirmed", None  # audit-exempt subsidiary with no filed turnover or customs record
        if cached and "officers" in cached:
            register = {k: cached[k] for k in ("officers", "owners", "charges")}
        else:
            register = {
                "officers": companies_house.get_active_officers(number, api_key) if checked else [],
                "owners": companies_house.get_owners(number, api_key, with_ceased=True) if checked else [],
                "charges": companies_house.get_charges(number, api_key) if checked else [],
            }
            if checked and turnover_check:
                register_cache.store(number, made_up, {"facts": facts, **register})
        return "", {"niche": niche, "company": company, "trade": trade, "checked": checked, "facts": facts,
                    "turnover": turnover, **register}

    # Several companies at once: Companies House calls stay spaced by the shared throttle, while
    # document downloads and PDF/OCR work for one company overlap with calls for the others.
    items = list(enumerate(queue))
    with ThreadPoolExecutor(max_workers=CH_WORKERS) as pool:
        results = itertools.chain(pool.map(gather, items[:budget]), map(gather, items[budget:]))
        gathered = []
        for done, result in enumerate(results, 1):
            if done < budget and done % 50 == 0:
                print(f"  …checked {done:,} of {min(budget, len(queue)):,}", flush=True)
            gathered.append(result)
    for skip, g in gathered:
        if skip:
            stats[skip] += 1
            continue
        niche, company, trade, checked, facts, turnover = (g["niche"], g["company"], g["trade"], g["checked"],
                                                          g["facts"], g["turnover"])
        officers, owners, charges, number = g["officers"], g["owners"], g["charges"], company["company_number"]
        bank = (banks.relationships(companies_house.outstanding(charges), (facts or {}).get("bankers", []), own_bank)
                if checked else None)
        need_site = False
        if checked and websites:
            # The company's own site only when the register and accounts name no finance person.
            known = people.choose_finance_contact(officers, (facts or {}).get("finance_people", []), [],
                                                  (facts or {}).get("signatory", ""))
            need_site = not known or not known["source"].startswith(("Companies House", "filed accounts"))
        pending.append({"args": (niche, company, turnover, officers, checked and turnover_check),
                        "kwargs": dict(trade=trade, months_loaded=months_loaded, facts=facts, owners=owners, bank=bank,
                                       checked=checked, trade_model=trade_model, band=band, charges=charges,
                                       today=today, own_bank_name=own_bank),
                        "need_site": need_site})
        parent = group_parent([o for o in owners if not o.get("ceased_on")])
        if parent[0]:
            parents[number] = parent

    # Company websites, several at once (each is a different site), after the rate-limited CH loop.
    wanted = [(p["args"][1]["company_number"], p["args"][1]["company_name"],
               (p["kwargs"]["facts"] or {}).get("web_addresses", [])) for p in pending if p["need_site"]]
    if wanted:
        print(f"  Reading {len(wanted):,} company websites (no finance person named in the register or accounts)…",
              flush=True)
    sites = website.look_up_many(wanted) if wanted else {}
    stats["site_tried"], stats["site_found"] = len(wanted), sum(bool(s["website"]) for s in sites.values())
    # Finance appointments in the news, for companies whose finance contact still isn't confirmed.
    unconfirmed = []
    filed = {p["args"][1]["company_number"]: registry_people_for(
                 in_registries.get(registries.company_number(p["args"][1]["company_number"]), []), today)
             for p in pending if p["kwargs"]["checked"]}
    for p in pending:
        number = p["args"][1]["company_number"]
        known = finance_contact(p["args"][3], p["kwargs"]["facts"] or {}, sites.get(number), registry_people=filed.get(number))
        if news_check and p["kwargs"]["checked"] and (not known or known["confidence"] != people.CONFIRMED):
            unconfirmed.append((number, p["args"][1]["company_name"]))
    if unconfirmed:
        print(f"  Checking the news for {len(unconfirmed):,} finance appointments…", flush=True)
    in_news = news.appointments_many(unconfirmed, today=today)
    stats["news_tried"], stats["news_found"] = len(unconfirmed), sum(bool(v) for v in in_news.values())
    # Is a secretary or signatory pick a group-wide officer or a professional secretary? One call each.
    appointments: dict[str, dict] = {}
    for p in pending:
        number, company = p["args"][1]["company_number"], p["args"][1]
        known = finance_contact(p["args"][3], p["kwargs"]["facts"] or {}, sites.get(number), in_news.get(number),
                                filed.get(number))
        officer = next((o for o in p["args"][3] if known and people.same_person(o["name"], known["name"])), None)
        if api_key and officer and known["confidence"] in (people.LIKELY, people.GUESS):
            related = companies_house.name_words(company["company_name"]) | companies_house.name_words(
                parents.get(number, ("", ""))[1])
            found = companies_house.officer_appointments(officer.get("appointments_url", ""), api_key, related)
            if found:
                appointments[number] = found
    rows: list[dict] = []
    for p in pending:
        number = p["args"][1]["company_number"]
        row = company_row(*p["args"], **p["kwargs"], site=sites.get(number), news_people=in_news.get(number),
                          registry_people=filed.get(number), appointments=appointments.get(number))
        rows.append(row)
        turnover, trade, checked = p["args"][2], p["kwargs"]["trade"], p["kwargs"]["checked"]
        stats["confirmed" if turnover else "by_category" if checked else "unchecked"] += 1
        stats["in_registry"] += bool(filed.get(number))
        if row["finance_contact"]:
            stats["fc " + row["finance_contact_source"].split(":")[0].split(" — ")[0].split(" (")[0]] += 1
            stats["confidence " + row["finance_contact_confidence"]] += 1
        stats["family"] += bool(row["family_run"])
        stats["customs"] += bool(trade)
        stats["wallet"] += bool(row["fx_wallet_high_gbp"])
        stats["currency"] += bool(row["import_currencies"] or row["export_currencies"])
        stats["bank"] += bool(row["main_bank"])
        stats["triggered"] += bool(row["triggers"])
        stats["pe_backed"] += bool(row["pe_backed"])
        stats["planning_now"] += bool(row["planning_window_now"])
        stats["own_bank"] += bool(row["own_bank_client"])
        stats[row["section"]] += 1

    stats["groups"] = add_group_rollup(rows, parents)
    section_order = {label: i for i, label in enumerate(sections(*band))}
    # Triggers lift a company a little (10 each, up to 20); when-to-call never does.
    rows.sort(key=lambda r: (
        section_order[r["section"]],
        -(int(r["fx_evidence_score"]) + (int(r["untapped_score"]) if r["untapped_score"] != "" else 0)
          + 10 * min(len(r["triggers"].split(" | ")) if r["triggers"] else 0, 2)),
        -float(r["fx_wallet_high_gbp"] or 0),
        r["company_name"].lower(),
    ))
    print_summary(rows, stats, min_turnover, band, own_bank)
    return rows


def print_summary(rows: list[dict], stats: Counter, min_turnover: int,
                  band: tuple[int, int] = (DEFAULT_BAND_MIN, DEFAULT_BAND_MAX), own_bank: str = "") -> None:
    print("\n" + "=" * 60)
    print(f"Done — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Companies: {len(rows):,} — " + ", ".join(f"{stats[label]:,} {label}" for label in sections(*band)))
    print(f"  With HMRC customs evidence: {stats['customs']:,} | currency mix: {stats['currency']:,} | "
          f"FX wallet estimate: {stats['wallet']:,}")
    print(f"  Bank identified: {stats['bank']:,}"
          + (f" | already banks with {own_bank}: {stats['own_bank']:,}" if own_bank else ""))
    print(f"  With a trigger (new owner, refinancing, new director): {stats['triggered']:,} | "
          f"investor-backed: {stats['pe_backed']:,} | in year-end planning window now: {stats['planning_now']:,} | "
          f"groups with 2+ companies listed: {stats['groups']:,}")
    print(f"  FX evidence High: {sum(r['fx_evidence_level'] == 'High' for r in rows):,} | "
          f"Medium: {sum(r['fx_evidence_level'] == 'Medium' for r in rows):,}")
    print(f"  Untapped High: {sum(r['untapped_level'] == 'High' for r in rows):,} | family-run: {stats['family']:,}")
    print(f"  Turnover confirmed from filed accounts: {stats['confirmed']:,}; "
          f"checked, turnover not filed: {stats['by_category']:,}")
    if stats["unchecked"]:
        print(f"  Not checked (beyond --max-enrich or no API key): {stats['unchecked']:,}")
    by_source = {k[3:]: v for k, v in stats.items() if k.startswith("fc ")}
    print(f"  Finance contact named: {sum(by_source.values()):,} — "
          + (", ".join(f"{k}: {v:,}" for k, v in sorted(by_source.items(), key=lambda kv: -kv[1])) or "none"))
    print(f"  Finance contact confidence — Verified: {stats['confidence Verified']:,}, "
          f"Confirmed: {stats['confidence Confirmed']:,}, "
          f"Likely: {stats['confidence Likely']:,}, Guess: {stats['confidence Guess']:,}")
    print(f"  Company websites tried: {stats['site_tried']:,}, confirmed: {stats['site_found']:,} | "
          f"news checked: {stats['news_tried']:,}, with a finance appointment: {stats['news_found']:,} | "
          f"in a gender pay gap / modern slavery filing: {stats['in_registry']:,}")
    print(f"  Dropped — filed turnover under £{min_turnover / 1e6:,.0f}m: {stats['under_min']:,}; "
          f"subsidiaries with nothing to confirm them: {stats['unconfirmed']:,}")
    print("=" * 60)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def niche_summaries(path: str = DEFAULT_NICHES_FILE) -> list[dict]:
    """id / name / currency pairs for each FX niche."""
    return [
        {"id": n["id"], "name": n["name"], "currency_pairs": n.get("currency_pairs", [])}
        for n in load_niches(path)
    ]


def print_niches(path: str) -> None:
    for niche in niche_summaries(path):
        pairs = "|".join(niche["currency_pairs"])
        print(f"{niche['id']:<45} {pairs:<24} {niche['name']}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="FX lead sourcer: UK companies with foreign-currency flows, their likely currencies, FX wallet and bank.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--niches", metavar="ID[,ID...]", help="Only these niche ids (default: every niche — see --list-niches)")
    parser.add_argument("--list-niches", action="store_true", help="Print the FX niche ids and exit")
    parser.add_argument("--source", choices=("bulk", "api"), default="bulk",
                        help="bulk: Companies House bulk file, every company (default). api: search API sample, no download")
    parser.add_argument("--bulk-file", metavar="ZIP", help="Use this BasicCompanyDataAsOneFile zip instead of downloading it")
    parser.add_argument("--max-per-sic", type=int, metavar="N", help=f"api source: companies per SIC code (default: {DEFAULT_MAX_PER_SIC})")
    parser.add_argument("--min-turnover", type=int, metavar="GBP",
                        help="Drop companies whose filed turnover is under this (default: the band's lower end)")
    parser.add_argument("--band-min", type=int, default=DEFAULT_BAND_MIN, metavar="GBP",
                        help=f"Core turnover band, lower end (default: {DEFAULT_BAND_MIN:,})")
    parser.add_argument("--band-max", type=int, default=DEFAULT_BAND_MAX, metavar="GBP",
                        help=f"Core turnover band, upper end (default: {DEFAULT_BAND_MAX:,})")
    parser.add_argument("--own-bank", default="", metavar="NAME",
                        help="Your bank's name (e.g. Barclays): its existing clients are flagged as cross-sell, not new (or env OWN_BANK)")
    parser.add_argument("--no-websites", action="store_true",
                        help="Don't read company websites (otherwise read only when no finance person is named elsewhere)")
    parser.add_argument("--no-news", action="store_true",
                        help="Don't check the news for finance appointments")
    parser.add_argument("--no-registries", action="store_true",
                        help="Don't load the gender pay gap and modern slavery registries")
    parser.add_argument("--no-turnover-check", action="store_true", help="Don't read filed accounts; go on accounts category alone (fewer API calls)")
    parser.add_argument("--hmrc-months", type=int, default=DEFAULT_HMRC_MONTHS, metavar="N",
                        help=f"Months of HMRC importer/exporter records to load, 0 to skip (default: {DEFAULT_HMRC_MONTHS})")
    parser.add_argument("--min-trade-months", type=int, default=DEFAULT_MIN_TRADE_MONTHS, metavar="N",
                        help=f"Small-accounts companies need customs records in this many months (default: {DEFAULT_MIN_TRADE_MONTHS})")
    parser.add_argument("--max-enrich", type=int, metavar="N", help="Check turnover and directors for at most N companies; the rest ship unchecked")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, metavar="FILE", help=f"Output path: .xlsx for an Excel workbook, .csv for CSV (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--niches-file", default=DEFAULT_NICHES_FILE, metavar="FILE")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    try:
        if args.list_niches:
            print_niches(args.niches_file)
            return
        rows = run_pipeline(
            niche_ids=parse_niche_ids(args.niches),
            niches_path=args.niches_file,
            source=args.source,
            bulk_file=args.bulk_file,
            max_per_sic=args.max_per_sic,
            min_turnover=parse_positive_int(args.min_turnover, "min_turnover") or args.band_min,
            band_min=parse_positive_int(args.band_min, "band_min"),
            band_max=parse_positive_int(args.band_max, "band_max"),
            own_bank=args.own_bank,
            websites=not args.no_websites,
            news_check=not args.no_news,
            registry_check=not args.no_registries,
            turnover_check=not args.no_turnover_check,
            max_enrich=args.max_enrich,
            hmrc_months=max(args.hmrc_months, 0),
            min_trade_months=max(args.min_trade_months, 1),
        )
    except (ValueError, FileNotFoundError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    write_output(rows, args.output, (args.band_min, args.band_max))
    print(f"Output: {args.output}")


if __name__ == "__main__":
    main()
