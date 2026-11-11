"""
sourcer/absurd.py — leads that make no sense for a bank's FX desk, whatever their filings show.

The FX filings scan keeps any £20m+ company whose accounts prove FX, so it also catches banks, insurers, funds, FX
brokers (FX is their product, not their payments), public bodies, charities and companies since dissolved. Each rule
gives a plain reason; a company with one is qualified Out on the Accounts page (shown under "Show qualified out", never
deleted). Rule-based, from the register's own record (status, type, SIC codes) and the registered name.
"""

from __future__ import annotations

import re
from typing import Optional

# Sector codes that are never an FX-payments prospect — only when ALL of a company's codes are in them (a trading group
# that also lists 64209 "holding company" stays).
NOT_A_PROSPECT_SIC = (
    ("64110", "the central bank"), ("64191", "a bank"), ("64192", "a building society"),
    ("6430", "an investment trust, fund or unit trust"),
    ("651", "an insurer"), ("652", "a reinsurer"), ("653", "a pension fund"),
    ("6611", "a financial market"), ("6612", "a securities / FX broker — FX is its product"),
    ("6621", "a loss adjuster"), ("6622", "an insurance broker"), ("6630", "a fund manager"),
    ("84", "a public body"), ("99000", "an extraterritorial organisation"), ("941", "a trade or employers' body"),
    ("942", "a trade union"), ("9491", "a religious organisation"), ("9492", "a political organisation"),
)

# FX providers and payment firms — the desk's competitors, never its clients.
FX_PROVIDERS = re.compile(
    r"\b(?:EBURY|MONEYCORP|CURRENCIES DIRECT|WESTERN UNION|WISE PAYMENTS|TRANSFERWISE|CORPAY|CAMBRIDGE GLOBAL PAYMENTS|"
    r"CONVERA|TRAVELEX|OFX|WORLDFIRST|ARGENTEX|EQUALS (?:GROUP|CONNECT)|FAIRFX|CAXTON|GLOBAL REACH|ALPHA FX|ALPHA GROUP|"
    r"LUMON|GPS CAPITAL|SMART CURRENCY|CURRENCYCLOUD|CURRENCY ?FAIR|TORFX|XE\.COM|PAYONEER|AIRWALLEX|STATRYS|"
    r"MONEYGRAM|RIA FINANCIAL|AZIMO|REMITLY|WORLDREMIT|BANKING CIRCLE|CLEAR CURRENCY|FOREIGN CURRENCY DIRECT|"
    r"BRITISH CURRENCY EXCHANGE|ASTON CURRENCIES|CENTTRIP|MILLTECH|KANTOX|NIUM)\b")

NAME_RULES = (
    (re.compile(r"\bBUILDING SOCIETY\b"), "a building society"),
    (re.compile(r"\bBANK (?:PLC|LIMITED|LTD|AG|N\.?V\.?|S\.?A\.?|AS|ASA|PJSC)\b|^(?:THE )?BANK OF\b|\bBANKING CORPORATION\b"), "a bank"),
    (re.compile(r"\b(?:RE)?INSURANCE (?:COMPANY|PLC|LIMITED|LTD|SE|AG)\b|\bASSURANCE\b|\bUNDERWRITING\b|\bLLOYD'?S SYNDICATE\b"), "an insurer"),
    (re.compile(r"\bPENSION(?:S)? (?:SCHEME|FUND|TRUSTEES?)\b"), "a pension scheme"),
    (re.compile(r"\b(?:TRUSTEES?|NOMINEES?) (?:LIMITED|LTD)\b"), "a trustee or nominee company"),
    (re.compile(r"\bINVESTMENT TRUST\b|\bSICAV\b|\bOEIC\b|\bUNIT TRUST\b|\bFUND (?:LIMITED|LTD|PLC|LP)\b"), "a fund"),
    (re.compile(r"\((?:IN )?(?:LIQUIDATION|ADMINISTRATION)\)"), "in liquidation or administration"),
)
# Co-operatives (registered societies) trade commercially — an organic milk co-op exports — so they stay.
NOT_FOR_PROFIT_TYPES = re.compile(r"guarant|charit|community interest", re.I)


def reason(name: str, record: Optional[dict]) -> str:
    """Why this lead is absurd for an FX desk, or "" — from the register's record ({status, type, sic_codes}) and name.
    `record` None: the company wasn't in the register's bulk file at all (dissolved some time ago)."""
    up = (name or (record or {}).get("name") or "").upper()
    if record is None:
        return "Not on the register's live list — dissolved or removed"
    status = (record.get("status") or "").lower()
    if status and status != "active":
        return f"Not trading: {record['status'].lower()} on the register"
    if FX_PROVIDERS.search(up):
        return "An FX provider itself — a competitor, not a client"
    sics = [s for s in record.get("sic_codes") or [] if s]
    if sics:
        hits = [next((why for prefix, why in NOT_A_PROSPECT_SIC if s.startswith(prefix)), "") for s in sics]
        if all(hits):
            return f"{hits[0][0].upper()}{hits[0][1:]} (sector {sics[0]}) — not a prospect for FX payments"
    if NOT_FOR_PROFIT_TYPES.search(record.get("type") or ""):
        return "Not-for-profit (limited by guarantee, charity or community interest company) — not a commercial FX prospect"
    for pattern, why in NAME_RULES:
        if pattern.search(up):
            return f"{why[0].upper()}{why[1:]}, by its name — not a prospect for FX payments"
    return ""
