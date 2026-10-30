"""
sourcer/signals.py — explainable scores for how much a company deals in
foreign currency, whether it's family-run, and how likely it is that nobody
has pitched it FX yet.

Every point awarded comes with the line of evidence that earned it, so a
caller can read why a company ranks where it does. Rule-based weights,
deliberately simple; they get recalibrated once real call outcomes exist.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date
from typing import Optional

from sourcer import hmrc

UK_NAMES = {"", "UNITED KINGDOM", "ENGLAND", "WALES", "SCOTLAND", "NORTHERN IRELAND", "GREAT BRITAIN",
            "UK", "ENGLAND AND WALES", "ENGLAND & WALES", "BRITISH", "ENGLISH", "WELSH", "SCOTTISH"}


def _label(score: int) -> str:
    return "High" if score >= 60 else "Medium" if score >= 30 else "Low"


def _gbp(value: float) -> str:
    v = abs(value)
    return f"£{v / 1e6:,.1f}m" if v >= 1e6 else f"£{v / 1e3:,.0f}k"


_UK_PART = re.compile(r"\b(?:UNITED KINGDOM|GREAT BRITAIN|BRITAIN|ENGLAND|WALES|SCOTLAND|NORTHERN IRELAND|UK|GB|"
                      r"COMPANIES HOUSE|REGISTRAR? OF COMPANIES|JERSEY|GUERNSEY|ISLE OF MAN|CHANNEL ISLANDS)\b")


def is_uk(place: str) -> bool:
    """A UK place, as Companies House and accounts write it: "England", "United Kingdom (England And Wales)",
    "Companies House", "Register Of Companies For England And Wales" (a PSC's register given as its country)."""
    p = " ".join((place or "").upper().replace(".", "").split())
    if p in UK_NAMES:
        return True
    return "NEW SOUTH WALES" not in p and bool(_UK_PART.search(p))


_is_uk = is_uk


_TITLES = {"MR", "MRS", "MS", "MISS", "MX", "DR", "SIR", "DAME", "LORD", "LADY", "PROF"}


def _person_key(full_name: str) -> str:
    """Upper-case name without titles, so "Mr Ramesh Patel" and "Ramesh Patel" are one person."""
    return " ".join(w for w in full_name.upper().replace(",", " ").replace(".", " ").split() if w not in _TITLES)


def surname(full_name: str) -> str:
    parts = _person_key(full_name).split()
    return parts[-1] if parts else ""


def family_run(directors: list[dict], owners: list[dict]) -> tuple[bool, str]:
    """
    (is_family, reason): two or more of the directors / individual owners
    share a surname. Birth years 20+ years apart within that surname mark a
    second generation.
    """
    people: dict[str, dict] = {}
    for d in directors:
        people[_person_key(d["name"])] = {"surname": surname(d["name"]), "year": d.get("birth_year")}
    for o in owners:
        if o["kind"] == "individual":
            people.setdefault(_person_key(o["name"]), {"surname": surname(o["name"]), "year": None})
    by_surname: dict[str, list[Optional[int]]] = defaultdict(list)
    for p in people.values():
        if p["surname"]:
            by_surname[p["surname"]].append(p["year"])
    families = {s: years for s, years in by_surname.items() if len(years) >= 2}
    if not families:
        return False, ""
    name, years = max(families.items(), key=lambda kv: len(kv[1]))
    known = [y for y in years if y]
    generations = len(known) >= 2 and max(known) - min(known) >= 20
    return True, (f"{len(years)} directors/owners named {name.title()}"
                  + (" across two generations" if generations else ""))


def fx_evidence(
    trade: Optional[dict],
    months_loaded: int,
    facts: Optional[dict],
    owners: list[dict],
    directors: list[dict],
    niche_match: bool,
) -> tuple[int, str, list[str]]:
    """(score 0-100, High/Medium/Low, evidence lines) for regular foreign-currency payments."""
    score, evidence = 0, []
    if trade:
        # Appearing at all is proof of cross-border trade; regularity is
        # measured against a full year, so a run that could only load a few
        # months can't make a one-off look like a regular importer.
        span = max(months_loaded, 1)
        imp, exp = len(trade["import_months"]), len(trade["export_months"])
        if imp:
            score += 20 + round(15 * min(imp, 12) / 12)
            evidence.append(f"HMRC customs: imported in {imp} of {span} months ({', '.join(hmrc.chapters(trade['import_codes']))})")
        if exp:
            score += 15 + round(10 * min(exp, 12) / 12)
            evidence.append(f"HMRC customs: exported in {exp} of {span} months ({', '.join(hmrc.chapters(trade['export_codes']))})")
        all_codes = trade["import_codes"] + trade["export_codes"]
        if len({c[:2] for c in all_codes}) >= 3:
            score += 5
    if facts:
        if facts.get("fx_gain_loss") is not None:
            score += 20
            word = "gain" if facts["fx_gain_loss"] >= 0 else "loss"
            prior = facts.get("fx_gain_loss_prior")
            before = (f" (year before: {'gain' if prior >= 0 else 'loss'} of {_gbp(prior)})"
                      if prior is not None else "")
            evidence.append(f"accounts: foreign exchange {word} of {_gbp(facts['fx_gain_loss'])}{before}")
        if facts.get("currency_breakdown"):
            score += 10
            evidence.append("accounts: figures broken down by currency")
        if facts.get("geographic_breakdown"):
            score += 5
            evidence.append("accounts: turnover split by country/region")
        if facts.get("hedging_disclosed"):
            score += 10
            evidence.append("accounts: hedging / derivatives disclosed")
        if facts.get("fx_risk_disclosed"):
            score += 5
            evidence.append("accounts: foreign-exchange risk discussed")
    foreign_parent = next((o for o in owners if o["kind"] == "corporate" and o["country"] and not _is_uk(o["country"])), None)
    if foreign_parent:
        score += 10
        evidence.append(f"owned by {foreign_parent['name']} ({foreign_parent['country'].title()})")
    abroad = [d for d in directors if (d.get("country_of_residence") and not _is_uk(d["country_of_residence"]))
              or (d.get("nationality") and not _is_uk(d["nationality"]))]
    if abroad:
        score += 5
        evidence.append(f"{len(abroad)} director(s) foreign-national or living abroad")
    if niche_match:
        score += 10
    score = min(score, 100)
    return score, _label(score), evidence


def untapped(
    owners: list[dict],
    is_family: bool,
    facts: Optional[dict],
    incorporated_on: str,
    today: Optional[date] = None,
) -> tuple[int, str, list[str]]:
    """
    (score 0-100, High/Medium/Low, reasons) for "FX decisions sit with the
    people we can reach, and nobody sophisticated is running them yet" —
    owner-managed, no group treasury, no hedging. Inferred, never observed.
    Who the company banks with is reported separately (banks.relationships).
    """
    score, reasons = 0, []
    corporate = [o for o in owners if o["kind"] == "corporate"]
    if owners and not corporate:
        score += 30
        reasons.append("owned by individuals, not a group (no group treasury)")
    if any(not _is_uk(o["country"]) for o in corporate if o["country"]):
        score -= 15
        reasons.append("foreign parent company — FX may be run by group treasury")
    if is_family:
        score += 20
        reasons.append("family-run")
    if facts is not None and not facts.get("hedging_disclosed"):
        score += 25
        reasons.append("no hedging disclosed in accounts")
    try:
        years = ((today or date.today()) - date.fromisoformat(incorporated_on)).days // 365
    except (TypeError, ValueError):
        years = 0
    if years >= 15:
        score += 10
        reasons.append(f"established {years} years")
    score = max(0, min(score, 100))
    return score, _label(score), reasons
