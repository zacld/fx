"""
sourcer/banks.py — who a company banks with, from the names on its charges
register and the "Bankers" line in its accounts.

Names are messy ("HSBC UK Bank PLC", "Barclays Security Trustee Limited",
"Lombard North Central PLC"), so each is mapped to a banking group and a
type: high-street, challenger, international, or specialist lender (asset
or invoice finance — the company may have no bank holding security at all).
For a bank's FX desk, a competitor holding the relationship is a switch
target; the bank itself holding it is a cross-sell.
"""

from __future__ import annotations

import re
from typing import Optional

# (keyword in the upper-cased name, banking group, type). First match wins.
_GROUPS: list[tuple[str, str, str]] = [
    # High-street (and their asset-finance arms)
    ("HSBC", "HSBC", "high-street"),
    ("BARCLAYS", "Barclays", "high-street"),
    ("LLOYDS", "Lloyds", "high-street"),
    ("BANK OF SCOTLAND", "Lloyds", "high-street"),
    ("HALIFAX", "Lloyds", "high-street"),
    ("NATIONAL WESTMINSTER", "NatWest", "high-street"),
    ("NATWEST", "NatWest", "high-street"),
    ("ROYAL BANK OF SCOTLAND", "NatWest", "high-street"),
    ("LOMBARD NORTH CENTRAL", "NatWest", "high-street"),
    ("ULSTER BANK", "NatWest", "high-street"),
    ("COUTTS", "NatWest", "high-street"),
    ("SANTANDER", "Santander", "high-street"),
    # Challengers and mid-market banks
    ("CLYDESDALE", "Virgin Money", "challenger"),
    ("YORKSHIRE BANK", "Virgin Money", "challenger"),
    ("VIRGIN MONEY", "Virgin Money", "challenger"),
    ("METRO BANK", "Metro Bank", "challenger"),
    ("TSB", "TSB", "challenger"),
    ("HANDELSBANKEN", "Handelsbanken", "challenger"),
    ("ALLICA", "Allica", "challenger"),
    ("OAKNORTH", "OakNorth", "challenger"),
    ("INVESTEC", "Investec", "challenger"),
    ("CLOSE BROTHERS", "Close Brothers", "challenger"),
    ("SHAWBROOK", "Shawbrook", "challenger"),
    ("ALDERMORE", "Aldermore", "challenger"),
    ("ARBUTHNOT", "Arbuthnot", "challenger"),
    ("STARLING", "Starling", "challenger"),
    ("CYNERGY", "Cynergy", "challenger"),
    ("HAMPSHIRE TRUST", "Hampshire Trust", "challenger"),
    ("UNITY TRUST", "Unity Trust", "challenger"),
    ("TRIODOS", "Triodos", "challenger"),
    # International banks
    ("CITIBANK", "Citi", "international"),
    ("CITIGROUP", "Citi", "international"),
    ("JPMORGAN", "JPMorgan", "international"),
    ("J.P. MORGAN", "JPMorgan", "international"),
    ("DEUTSCHE BANK", "Deutsche Bank", "international"),
    ("BNP PARIBAS", "BNP Paribas", "international"),
    ("SOCIETE GENERALE", "Société Générale", "international"),
    ("CREDIT AGRICOLE", "Crédit Agricole", "international"),
    ("ING BANK", "ING", "international"),
    ("ABN AMRO", "ABN AMRO", "international"),
    ("RABOBANK", "Rabobank", "international"),
    ("COMMERZBANK", "Commerzbank", "international"),
    ("UNICREDIT", "UniCredit", "international"),
    ("INTESA", "Intesa Sanpaolo", "international"),
    ("DANSKE", "Danske Bank", "international"),
    ("NORDEA", "Nordea", "international"),
    ("BANK OF IRELAND", "Bank of Ireland", "international"),
    ("ALLIED IRISH", "AIB", "international"),
    ("AIB GROUP", "AIB", "international"),
    ("BANK OF CHINA", "Bank of China", "international"),
    ("INDUSTRIAL AND COMMERCIAL BANK OF CHINA", "ICBC", "international"),
    ("STATE BANK OF INDIA", "State Bank of India", "international"),
    ("SUMITOMO", "SMBC", "international"),
    ("MUFG", "MUFG", "international"),
    ("MIZUHO", "Mizuho", "international"),
    ("WELLS FARGO", "Wells Fargo", "international"),
    ("BANK OF AMERICA", "Bank of America", "international"),
]
_SPECIALIST_WORDS = ("FINANCE", "LEASING", "ASSET", "INVOICE", "FACTORS", "FACTORING", "COMMERCIAL CREDIT",
                     "CAPITAL", "FUNDING", "LENDING", "CREDIT")


def classify(name: str) -> Optional[tuple[str, str]]:
    """(banking group, type) for a lender/banker name, or None if it isn't recognisably a lender."""
    upper = name.upper()
    for keyword, group, kind in _GROUPS:
        if keyword in upper:
            return group, kind
    if "BANK" in upper:
        return name.strip(), "other bank"
    if any(w in upper for w in _SPECIALIST_WORDS):
        return name.strip(), "specialist lender"
    return None


# "Bankers" on an accounts company-information page, e.g.
#   "Bankers  Barclays Bank plc  1 Churchill Place ..." / "BANKERS: HSBC UK Bank plc"
# Heading case only ("Bankers"/"BANKERS"), followed by a capitalised name.
_BANKERS_RE = re.compile(r"\b(?:Bankers?|BANKERS?)\b[\s:–-]{1,12}(?=[A-Z])")
_GENERIC_BANK_RE = re.compile(
    r"^((?:[A-Z][\w&.'’-]*\s+){0,5}Bank(?:ing)?(?:\s+of(?:\s+[A-Z][\w&.'’-]*){1,3})?"
    r"(?:\s+(?:UK|plc|PLC|Plc|Limited|Ltd|AG|N\.A\.|SA|S\.A\.))*)")


def bankers_from_text(text: str) -> list[str]:
    """Banks named after a "Bankers" heading in accounts text, as banking-group names."""
    names: list[str] = []
    for m in _BANKERS_RE.finditer(text):
        window = " ".join(text[m.end():m.end() + 80].split())
        upper = window.upper()
        hits = [(upper.find(k), group) for k, group, _ in _GROUPS if k in upper]
        if hits:
            name = min(hits)[1]
        else:
            generic = _GENERIC_BANK_RE.match(window)
            name = generic.group(1) if generic and generic.group(1) != "Bank" else ""
        if name and name not in names:
            names.append(name)
    return names


def relationships(lenders: list[dict], bankers: list[str], own_bank: str = "") -> dict:
    """
    Summarise who the company banks with:
      summary       "Barclays (charge 2021-03, named as bankers); Close Brothers (charge 2024-06)"
      main          the primary relationship: named as bankers, else the newest bank charge
      main_type     its type (high-street, challenger, international, other bank, specialist lender)
      own_bank      True if `own_bank` is among them (a cross-sell, not a prospect)
New and paid-off charges are reported by triggers.find.
    """
    groups: dict[str, dict] = {}
    for b in bankers:
        c = classify(b)
        if c:
            g = groups.setdefault(c[0], {"type": c[1], "notes": [], "rank": 0})
            g["notes"].append("named as bankers")
    for l in sorted(lenders, key=lambda l: l.get("created_on") or "", reverse=True):
        c = classify(l["name"])
        if not c:
            continue
        # Banks outrank asset/invoice financiers as the main relationship.
        g = groups.setdefault(c[0], {"type": c[1], "notes": [], "rank": 2 if c[1] == "specialist lender" else 1})
        g["notes"].append(f"charge {(l.get('created_on') or '')[:7]}".strip())
    ordered = sorted(groups.items(), key=lambda kv: kv[1]["rank"])  # stable: bankers line, then newest bank charge
    summary = "; ".join(f"{name} ({', '.join(dict.fromkeys(g['notes']))})" for name, g in ordered)
    return {
        "summary": summary,
        "main": ordered[0][0] if ordered else "",
        "main_type": ordered[0][1]["type"] if ordered else "",
        "own_bank": bool(own_bank) and ((classify(own_bank) or (own_bank,))[0] in groups
                                        or any(own_bank.upper() in name.upper() for name in groups)),
        "groups": list(groups),
    }
