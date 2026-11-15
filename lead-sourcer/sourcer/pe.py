"""
sourcer/pe.py — is a company private-equity backed, and by whom (Zac, 15 Nov 2026: "improve the FD, PE-backed and
private equity companies"). PE-backed companies are strong FX leads: the lenders behind a buyout usually require a
hedging policy, the finance team is professional, and a new owner reviews the banking.

Three kinds of evidence, each from a record already read (no extra calls):
  * an owner anywhere up the chain of corporate owners named like a PE house, a fund (LP) or a buyout vehicle
    (Topco / Bidco / Midco) — sponsor_kind(name), owners.pe_owner(…);
  * a charge held by a private-credit lender or an independent loan agency / security trustee (the debt behind
    buyouts: Ares, Pemberton, GLAS, Lucid …) — lender_kind(name);
  * the accounts naming a fund or PE house as the ultimate controlling party ("ultimately controlled by funds managed
    by Inflexion Private Equity Partners LLP") — text_evidence(text).
"""

from __future__ import annotations

import re
from typing import Optional

# UK mid-market and international private-equity houses and growth investors, as owner names write them
HOUSES = re.compile(
    r"\b(?:LDC|INFLEXION|BRIDGEPOINT|LIVINGBRIDGE|PHOENIX EQUITY|PALATINE|BGF|BUSINESS GROWTH FUND|FORESIGHT GROUP|"
    r"FORESIGHT (?:REGIONAL|CAPITAL|INVESTMENT)|YFM|MOBEUS|RUTLAND PARTNERS|MERCIA (?:ASSET|FUND|EIS|GROWTH|VENTURES)|"
    r"MAVEN (?:CAPITAL|INCOME|VCT)|LYCEUM CAPITAL|ENDLESS LLP|SILVERFLEET|AUGUST EQUITY|HORIZON CAPITAL|KESTER CAPITAL|"
    r"CAIRNGORM CAPITAL|MML CAPITAL|SYNOVA|ECI PARTNERS|GRAPHITE CAPITAL|GRESHAM HOUSE|PRIMARY CAPITAL|APPOSITE CAPITAL|"
    r"TENZING|ELYSIAN CAPITAL|INSPIRIT|GROWTH CAPITAL PARTNERS|NORTHEDGE|RCAPITAL|CONNECTION CAPITAL|PENTA CAPITAL|"
    r"SOVEREIGN CAPITAL|BOWMARK|EQUISTONE|VITRUVIAN|PANORAMIC GROWTH|BERINGEA|PRAETURA|LITERACY CAPITAL|FPE CAPITAL|CBPE|"
    r"BLUE WATER ENERGY|HG ?CAPITAL|ADVENT INTERNATIONAL|CINVEN|PERMIRA|CVC CAPITAL|KKR|BLACKSTONE|CARLYLE|TA ASSOCIATES|"
    r"PERWYN|ELAGHMORE|NVM PRIVATE EQUITY|WESTBRIDGE|APIARY CAPITAL|NEXT WAVE PARTNERS|AGILITAS|FREMMAN|AMBIENTA|"
    r"AURELIUS|SUMMIT PARTNERS|WARBURG PINCUS|EQT|PAI PARTNERS|BC PARTNERS|APAX|IK PARTNERS|IK INVESTMENT|NORDIC CAPITAL|"
    r"TRITON (?:PARTNERS|FUND)|CHARTERHOUSE CAPITAL|ICG|INTERMEDIATE CAPITAL GROUP|H\.?I\.?G\.? CAPITAL|BAIN CAPITAL|"
    r"ONE EQUITY PARTNERS|GENERAL ATLANTIC|THREE HILLS|AEA INVESTORS|BID EQUITY|SILVER ?LAKE|HAMBRO PERKS|BLACKFINCH|"
    r"BREGAL|CAPZA|ARDIAN|SUN CAPITAL|LONE STAR FUNDS|OAKTREE CAPITAL|APOLLO (?:GLOBAL|MANAGEMENT|INVESTMENT)|"
    r"PLATINUM EQUITY|CERBERUS|RIVERSIDE COMPANY|MONTAGU PRIVATE EQUITY|PALAMON|LIMERSTON|EV PRIVATE EQUITY|RJD PARTNERS|"
    r"CROWN PRIVATE EQUITY|DUKE STREET|LIVINGSTONE PARTNERS)\b")
# a vehicle set up for a buyout (not "Holdco" or "Newco" alone: families and groups use those too)
VEHICLE = re.compile(r"\b(?:BID ?CO|TOP ?CO|MID ?CO|ACQUISITION ?CO|ACQUICO|DEBT ?CO|INVEST ?CO|MIDCO\d?|BIDCO\d?|TOPCO\d?)\b")
GENERIC = re.compile(r"\b(?:PRIVATE EQUITY|EQUITY PARTNERS|GROWTH EQUITY|BUY-?OUT|CAPITAL PARTNERS LLP)\b")
FUND = re.compile(r"\b(?:L\.?P\.?|LIMITED PARTNERSHIP|SCSP|S\.C\.S\.P\.?)$|\bFUND(?:\s+[IVX\d]+)?\b")


def sponsor_kind(name: str) -> str:
    """'a private-equity house' / 'a buyout vehicle' / 'a fund' for an owner's name, else ''."""
    up = " ".join((name or "").upper().replace(",", " ").split())
    if not up:
        return ""
    if HOUSES.search(up) or GENERIC.search(up):
        return "a private-equity house"
    if VEHICLE.search(up):
        return "a buyout vehicle"
    if FUND.search(up):
        return "a fund"
    return ""


# The debt behind buyouts: private-credit funds lend unitranche loans, and independent agency firms hold the security
# for the lenders (a bank "as security agent" is a syndicated / club facility — typical of PE too, but banks also act
# for plain corporate loans, so it isn't counted on its own).
PRIVATE_CREDIT = re.compile(
    r"\b(?:ARES (?:MANAGEMENT|CAPITAL|EUROPEAN)|PEMBERTON|HAYFIN|ARCMONT|PERMIRA (?:CREDIT|DEBT)|TIKEHAU|KARTESIA|MUZINICH|"
    r"BEECHBROOK|HPS INVESTMENT|BARINGS|SIXTH STREET|APERA|ARBOUR LANE|CAPZA|BLUE OWL|GOLUB|CRESCENT CAPITAL|"
    r"CHURCHILL ASSET|BRIDGEPOINT CREDIT|ICG|INTERMEDIATE CAPITAL|ALCENTRA|PROVENTUS|BOOST ?& ?CO|BAIN CAPITAL CREDIT|"
    r"OAKTREE CAPITAL|APOLLO (?:GLOBAL|MANAGEMENT)|BLACKSTONE|KKR CREDIT|CVC CREDIT|PARTNERS GROUP|PGIM|"
    r"DEUTSCHE PRIVATE DEBT|SANTANDER PRIVATE CREDIT)\b")
AGENCY = re.compile(
    r"\b(?:GLOBAL LOAN AGENCY|GLAS (?:TRUST|AGENCY|SAS|AMERICAS)|LUCID (?:AGENCY|TRUSTEE|ISSUER)|WILMINGTON TRUST|"
    r"KROLL (?:AGENCY|TRUSTEE|ISSUER)|ANKURA (?:TRUSTEE|AGENCY)|ALTER DOMUS|INTERTRUST|CORTLAND|CSC CAPITAL MARKETS|"
    r"U\.?S\.? BANK TRUSTEES|CITICORP TRUSTEE|DEUTSCHE BANK TRUST|BNY MELLON CORPORATE TRUSTEE|LAW DEBENTURE)\b")


def lender_kind(name: str) -> str:
    """'a private-credit lender' / 'a loan agency (security trustee for a lending syndicate)' for a charge holder."""
    up = " ".join((name or "").upper().split())
    if PRIVATE_CREDIT.search(up):
        return "a private-credit lender"
    if AGENCY.search(up):
        return "a loan agency (security trustee for a lending syndicate)"
    return ""


def from_charges(charges: list[dict]) -> Optional[dict]:
    """{name, kind, created_on, url} for the newest outstanding charge held by private credit or a loan agency."""
    for c in sorted(charges or [], key=lambda c: c.get("created_on") or "", reverse=True):
        if c.get("status") not in (None, "", "outstanding", "part-satisfied"):
            continue
        kind = lender_kind(c.get("name", ""))
        if kind:
            return {"name": c["name"], "kind": kind, "created_on": c.get("created_on", ""), "url": c.get("url", "")}
    return None


# "The ultimate controlling party is Inflexion Private Equity Partners LLP" / "ultimately controlled by funds managed by
# LDC (Managers) Limited" / "the company's ultimate parent ... is owned by funds advised by Bridgepoint"
_CONTROL = re.compile(r"[^.]{0,200}\b(?:ultimate(?:ly)?\s+control(?:ling\s+part(?:y|ies)|led)|ultimate\s+parent|"
                      r"funds?\s+(?:managed|advised)\s+by)\b[^.]{0,300}\.", re.I)
_FUNDS_BY = re.compile(r"\bfunds?\s+(?:managed|advised)\s+(?:and\s+advised\s+|or\s+advised\s+)?by\s+((?:[A-Z(][\w&'’.()-]*\s*){1,8})")
_NAME_AFTER = re.compile(r"\b(?:is|are|by|being)\s+((?:[A-Z][\w&'’.()-]*\s*){1,8})")


def text_evidence(text: str) -> dict:
    """{pe_sponsor, pe_sponsor_evidence}: a PE house or fund the accounts name as controlling the company."""
    for m in _CONTROL.finditer(text or ""):
        sentence = " ".join(m.group(0).split()).strip()
        if re.search(r"\bpolic(?:y|ies)\b|\bmeans\b|\bdefin", sentence, re.I):
            continue
        named = _FUNDS_BY.search(sentence) or None
        names = [named.group(1)] if named else [n.group(1) for n in _NAME_AFTER.finditer(sentence)]
        for raw in names:
            name = raw.strip(" ,.;")
            if named or sponsor_kind(name):
                return {"pe_sponsor": name[:120], "pe_sponsor_evidence": sentence[:400]}
        if re.search(r"\bprivate equity\b", sentence, re.I):
            return {"pe_sponsor": "a private-equity fund", "pe_sponsor_evidence": sentence[:400]}
    return {"pe_sponsor": "", "pe_sponsor_evidence": ""}


def backed(owner_name: str = "", charges: Optional[list[dict]] = None, sponsor: str = "", sponsor_evidence: str = "",
           chain: Optional[dict] = None) -> tuple[str, str]:
    """(pe_backed — the sponsor or vehicle's name, evidence — what says so), from whichever records show it."""
    if owner_name:
        return owner_name, f"its owner {owner_name} is {sponsor_kind(owner_name) or 'an investor'} (PSC register)"
    if chain and chain.get("name"):
        return chain["name"], (f"{chain['name']} ({sponsor_kind(chain['name']) or 'an investor'}) owns it, "
                               f"{chain.get('hops', 0)} level{'s' if chain.get('hops', 0) != 1 else ''} up (PSC register)")
    if sponsor:
        return sponsor, f"accounts: {sponsor_evidence}"
    lender = from_charges(charges or [])
    if lender:
        return (f"debt from {lender['name']}",
                f"charge to {lender['name']} ({lender['kind']}){', created ' + lender['created_on'] if lender['created_on'] else ''} "
                "— the kind of debt behind a buyout")
    return "", ""
