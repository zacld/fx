"""
sourcer/matching.py — link HMRC traders to Companies House companies.

HMRC trader records carry a name and postcode but no company number.
Names alone collide ("J SMITH TRADING LTD" exists many times over), so a
match needs the postcode to agree or the name to be unique:
  high    normalised names identical at the same postcode
  medium  names nearly identical (similarity ≥ 0.92) at the same postcode,
          and clearly better than any other company there; or, failing
          that, an identical name held by exactly one company in the UK
          (HMRC often has the trading address, Companies House the
          registered office — frequently an accountant's)
Anything weaker is left unmatched rather than guessed.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Optional

_SUFFIXES = (
    "PUBLIC LIMITED COMPANY", "LIMITED LIABILITY PARTNERSHIP", "LIMITED", "LTD", "PLC", "LLP",
    "UK", "U K", "(UK)", "CO", "COMPANY",
)
FUZZY_THRESHOLD = 0.92


def normalise_name(name: str) -> str:
    """"The Acme Wine Co. (UK) Limited" -> "ACME WINE" — case, punctuation and legal suffixes removed."""
    n = name.upper().replace("&", " AND ")
    n = re.sub(r"\bT/A\b.*$", "", n)               # "X LTD T/A Y" -> the legal name only
    n = re.sub(r"[^A-Z0-9 ]+", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    n = re.sub(r"^THE ", "", n)
    changed = True
    while changed:                                  # strip stacked suffixes: "CO LIMITED", "UK LTD"
        changed = False
        for suffix in _SUFFIXES:
            if n.endswith(" " + suffix):
                n = n[: -len(suffix) - 1].strip()
                changed = True
    return n


def normalise_postcode(postcode: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", postcode.upper())


# A postcode with more companies than this is a registered-office address
# (an accountant, a formation agent): only an exact name is trusted there.
CROWDED_POSTCODE = 300


def _norm(company: dict) -> str:
    """The company's normalised name, computed once and kept on the record."""
    if "_norm" not in company:
        company["_norm"] = normalise_name(company["company_name"])
    return company["_norm"]


def match_trader(trader_name: str, companies_at_postcode: list[dict]) -> Optional[tuple[dict, str]]:
    """(company, "high" | "medium") for the trader among the companies at its postcode, or None."""
    target = normalise_name(trader_name)
    if not target:
        return None
    for company in companies_at_postcode:
        if _norm(company) == target:
            return company, "high"
    if len(companies_at_postcode) > CROWDED_POSTCODE:
        return None
    scored = []
    for company in companies_at_postcode:
        sm = SequenceMatcher(None, target, _norm(company))
        # Cheap upper bounds first; the full ratio only for plausible names.
        if sm.real_quick_ratio() < FUZZY_THRESHOLD or sm.quick_ratio() < FUZZY_THRESHOLD:
            scored.append((0.0, company))
            continue
        scored.append((sm.ratio(), company))
    if not scored:
        return None
    scored.sort(key=lambda s: s[0], reverse=True)
    best, company = scored[0]
    runner_up = scored[1][0] if len(scored) > 1 else 0.0
    if best >= FUZZY_THRESHOLD and best - runner_up >= 0.05:
        return company, "medium"
    return None


def match_all(traders: dict, by_postcode: dict[str, list[dict]], by_name: Optional[dict[str, list[dict]]] = None) -> dict[str, dict]:
    """
    {company_number: trade evidence} for every trader that matches a company.
    Several trader records (e.g. a name variant) can land on one company;
    their months and codes are merged.
    """
    matched: dict[str, dict] = {}
    for (_, postcode), trader in traders.items():
        hit = match_trader(trader["name"], by_postcode.get(postcode, []))
        if not hit and by_name:
            same_name = by_name.get(normalise_name(trader["name"]), [])
            if len(same_name) == 1:
                hit = (same_name[0], "medium")
        if not hit:
            continue
        company, confidence = hit
        e = matched.setdefault(company["company_number"], {
            "company": company, "confidence": confidence,
            "import_months": set(), "export_months": set(),
            "import_codes": type(trader["import_codes"])(), "export_codes": type(trader["export_codes"])(),
        })
        if confidence == "high":
            e["confidence"] = "high"
        e["import_months"] |= trader["import_months"]
        e["export_months"] |= trader["export_months"]
        e["import_codes"].update(trader["import_codes"])
        e["export_codes"].update(trader["export_codes"])
    return matched
