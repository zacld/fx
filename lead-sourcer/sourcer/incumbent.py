"""
sourcer/incumbent.py — who a company banks with today, what the bank holds,
when the facility is up, and how the company handles FX now, from records
already fetched (the charges register and the filed accounts; no extra calls).

Columns (see columns()):
  lenders                 every outstanding charge: holder, what it covers, when registered
  incumbent_bank          the bank holding an all-assets debenture (the main banking relationship)
  facility_ends           when a facility runs to, as the accounts state it ("March 2027")
  facility_ends_evidence  the sentence saying so, with its source
  fx_today                "Uses forward contracts" / "Uses currency options" / "Doesn't hedge" /
                          "Natural hedge" / "Uses an FX provider: Ebury"
  fx_today_evidence       the FD's own words, or the charge, with its source

Every value comes from a document; blank when none says so.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

from sourcer import banks, hooks

# FX brokers and payment firms: named in the accounts, or holding a charge (some take security for FX lines).
FX_PROVIDERS = ["Ebury", "Corpay", "Cambridge Global Payments", "Moneycorp", "Western Union Business Solutions",
                "AFEX", "Argentex", "Equals Money", "Currencies Direct", "Wise Business", "OFX", "Alpha FX",
                "Smart Currency Exchange", "Bibby Foreign Exchange", "Kantox", "Convera", "GPS Capital Markets",
                "Clear Currency", "Centtrip", "Payoneer", "Airwallex", "iBanFirst", "Currenxie"]
# Case-sensitive in the accounts' prose: these are proper names ("clear currency" in a sentence isn't Clear Currency).
# Names that are also everyday words ("global reach") are left out. Charge holders are filed in capitals
# ("EBURY PARTNERS UK LIMITED"), so the charges register is matched ignoring case.
_PROVIDER_RE = re.compile(r"\b(" + "|".join(re.escape(p) for p in FX_PROVIDERS) + r")\b")
_PROVIDER_HOLDER_RE = re.compile(_PROVIDER_RE.pattern, re.I)

_FORWARDS_RE = re.compile(r"forward\s+(?:foreign\s+)?(?:exchange|currency|fx)\s+contracts?|forward\s+contracts?|"
                          r"(?:currency|fx|foreign\s+exchange)\s+forwards?|forward\s+(?:purchases?|cover)", re.I)
_OPTIONS_RE = re.compile(r"(?:currency|fx|foreign\s+exchange)\s+options?", re.I)
_NO_HEDGE_RE = re.compile(
    r"(?:do|does|did)\s+not\s+(?:currently\s+|actively\s+|formally\s+)?(?:hedge|use\s+(?:any\s+)?(?:derivative|hedg|forward)|"
    r"enter\s+into\s+(?:any\s+)?(?:derivative|hedg|forward))|\bno\s+(?:formal\s+)?hedging|\bnot\s+hedged|\bunhedged|"
    r"no\s+(?:derivative|forward)\s+(?:financial\s+)?(?:instruments|contracts)\s+(?:are|were)\s+(?:used|held)", re.I)
_NATURAL_RE = re.compile(r"natural(?:ly)?\s+hedg|match(?:es|ing)?\s+(?:its\s+)?(?:foreign\s+)?currency\s+"
                         r"(?:receipts|income|sales)\s+(?:and|with|against)\s+(?:payments|costs|purchases)", re.I)
_NEGATED_BEFORE = re.compile(r"\b(?:not|no|never|nor|without)\b[^.;,]{0,40}$", re.I)   # "does not use forward ..."
_NEGATED_AFTER = re.compile(r"^\s+(?:are|were|is|was|have\s+been)\s+not\s+(?:used|held|entered)(?!\s+for\s+(?:speculat|trading))",
                            re.I)                                                          # "... contracts are not used"
_SPECULATIVE = re.compile(r"speculat|trading\s+purposes", re.I)   # "does not use derivatives for speculative purposes"
# An accounting-policy definition ("Derivatives, including forward foreign exchange contracts, are not basic
# financial instruments") says how forwards would be measured, not that the company uses them.
_POLICY_DEFINITION = re.compile(r"basic\s+financial\s+instruments|initially\s+(?:recogni[sz]ed|measured)|"
                                r"subsequently\s+(?:re)?measured|qualify\s+as\s+derivatives", re.I)
# A bare "forward contracts" / "forward purchases" counts only near currency words, and not for shipping or materials.
_EXPLICIT_FX_FORWARD = re.compile(r"exchange|currenc|\bfx\b", re.I)
_FX_CONTEXT = re.compile(r"currenc|exchange\s+(?:rates?|fluctuations?|variances?|value|risk|movements?)|foreign|\bFX\b|euros?\b|dollars?\b|\b(?:USD|EUR)\b|[$€]", re.I)
_NON_FX_FORWARD = re.compile(r"shipping|freight|containers?\b|raw\s+materials?|commodit|energy|electricity|\bgas\b|"
                             r"\bfuel|\bmetals?\b|steel|grain|wheat|cocoa|coffee", re.I)
_INTEREST_ONLY = re.compile(r"interest\s+rates?", re.I)
_NOT_BANK_DEBT = re.compile(r"inter-?company|group\s+undertakings?|related\s+part|shareholders?|parent\s+company",
                            re.I)   # an intercompany or shareholder loan is not a bank facility
_GOING_CONCERN = re.compile(r"going\s+concern|forecasts?|projections?|cash\s*flows?|twelve\s+months|12\s+months|"
                            r"period\s+of\s+at\s+least", re.I)

_FACILITY_RE = re.compile(r"\b(?:facilit(?:y|ies)|RCF|revolving\s+credit|overdraft|term\s+loan|loan\s+notes?|"
                          r"invoice\s+(?:discounting|finance)|borrowing\s+base|asset[- ]based\s+lending)\b", re.I)
_END_RE = re.compile(r"\b(?:expir(?:es|y|ing|e)|matur(?:es|ity|ing)|repayable\s+(?:in|on|by)|due\s+for\s+renewal|"
                     r"due\s+to\s+(?:expire|mature)|runs?\s+(?:until|to)|terminat(?:es|ion\s+date)|"
                     r"(?:available|committed|extended)\s+(?:until|to)|renewal\s+date)\b", re.I)
_MONTHS = {m.lower(): i for i, m in enumerate(
    "January February March April May June July August September October November December".split(), 1)}
_MONTHS.update({m[:3].lower(): i for m, i in list(_MONTHS.items())})
_DATE_RE = re.compile(r"\b(?:(\d{1,2})(?:st|nd|rd|th)?\s+)?(January|February|March|April|May|June|July|August|"
                      r"September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?,?\s+"
                      r"(20\d\d)\b|\b(\d{1,2})/(\d{1,2})/(20\d\d)\b|\b(20\d\d)\b", re.I)


# --- Charges -------------------------------------------------------------------------------

def charge_kind(c: dict) -> str:
    """What a registered charge covers, from its registered description."""
    text = f"{c.get('classification', '')} {c.get('particulars', '')}".lower()
    if c.get("floating_all") or "debenture" in text or "all assets" in text or "all the property" in text:
        return "all-assets debenture"
    if re.search(r"freehold|leasehold|\bproperty\b|\bland\b|title number|premises", text):
        return "property charge"
    if re.search(r"rent deposit|\bdeposit\b|cash collateral|credit balance", text):
        return "deposit / cash charge"
    if re.search(r"book debts|receivables|invoice", text):
        return "receivables (invoice finance)"
    if re.search(r"chattel|equipment|vehicle|machinery|\bplant\b|aircraft|vessel|\bgoods\b", text):
        return "asset finance"
    if c.get("floating"):
        return "floating charge"
    return "type not stated"


def _outstanding(charges: list[dict]) -> list[dict]:
    return sorted((c for c in charges if c.get("status") in ("outstanding", "part-satisfied")),
                  key=lambda c: c.get("created_on") or "", reverse=True)


def incumbent_bank(charges: list[dict]) -> Optional[dict]:
    """
    The newest outstanding all-assets debenture held by a bank — its banking arm
    ("HSBC UK Bank PLC") before its finance arms ("HSBC Invoice Finance"), which
    also take debentures — or None.
    """
    debentures = [(c, banks.classify(c["name"])) for c in _outstanding(charges) if charge_kind(c) == "all-assets debenture"]
    debentures = [(c, found) for c, found in debentures if found and found[1] != "specialist lender"]
    finance_arm = lambda c: any(w in c["name"].upper() for w in banks._SPECIALIST_WORDS)   # noqa: E731
    for c, found in sorted(debentures, key=lambda cf: finance_arm(cf[0])):   # stable: newest first within each
        return {**c, "bank": found[0]}
    return None


# --- Accounts text (called by sourcer/accounts.py while the document is open) ------------------

def _date_after(sentence: str, start: int) -> tuple[str, str]:
    """(iso-ish date "2027-03-31" / "2027-03" / "2027", how it's written) for the first date after `start`."""
    m = _DATE_RE.search(sentence, start)
    if not m:
        return "", ""
    if m.group(3):
        month_no = _MONTHS.get(m.group(2).lower().rstrip(".")[:3], 0)
        iso = f"{m.group(3)}-{month_no:02d}" + (f"-{int(m.group(1)):02d}" if m.group(1) else "")
    elif m.group(6):
        try:
            iso = date(int(m.group(6)), int(m.group(5)), int(m.group(4))).isoformat()   # UK order: dd/mm/yyyy
        except ValueError:
            return "", ""
    else:
        iso = m.group(7)
    return iso, m.group(0)


def text_evidence(text: str) -> dict:
    """
    From an accounts document's plain text:
      facility_dates  [{"date", "written", "sentence"}] — when a facility is said to end
      fx_policy       {"policy", "sentence"} — how the company handles FX, in its own words ({} if not said)
      fx_providers    [{"name", "sentence"}] — FX brokers named
    """
    text = text or ""
    dates, seen = [], set()
    for m in _END_RE.finditer(text):
        sentence = hooks._sentence(text, m.start(), m.end(), limit=320)
        at = sentence.lower().find(m.group(0).lower())
        if at < 0 or not _FACILITY_RE.search(sentence[max(0, at - 120):at]) or _GOING_CONCERN.search(sentence) \
                or _NOT_BANK_DEBT.search(sentence):
            continue  # the facility must be what ends ("the RCF expires on ..."), not a forecast period
        iso, written = _date_after(sentence, at)
        if iso and iso not in seen:
            seen.add(iso)
            dates.append({"date": iso, "written": written, "sentence": sentence})

    policy: dict = {}
    for name, pattern in (("Uses forward contracts", _FORWARDS_RE), ("Uses currency options", _OPTIONS_RE)):
        for m in pattern.finditer(text):
            before = text[max(0, m.start() - 80):m.start()]
            after = text[m.end():m.end() + 80]
            if _NEGATED_BEFORE.search(before) or _NEGATED_AFTER.search(after):
                continue
            sentence = hooks._sentence(text, m.start(), m.end())
            if _POLICY_DEFINITION.search(sentence):
                continue
            if not _EXPLICIT_FX_FORWARD.search(m.group(0)) and not _FX_CONTEXT.search(sentence) and (
                    _NON_FX_FORWARD.search(sentence) or not _FX_CONTEXT.search(text[max(0, m.start() - 250):m.end() + 120])):
                continue  # a bare "forward contracts": currency words in its sentence, or nearby and not about materials
            policy = {"policy": name, "sentence": sentence}
            break
        if policy:
            break
    if not policy:
        for name, pattern in (("Doesn't hedge", _NO_HEDGE_RE), ("Natural hedge", _NATURAL_RE)):
            for m in pattern.finditer(text):
                sentence = hooks._sentence(text, m.start(), m.end())
                if name == "Doesn't hedge" and _SPECULATIVE.search(sentence):
                    continue  # "does not use derivatives for speculative purposes" says nothing about hedging
                if name == "Doesn't hedge" and _INTEREST_ONLY.search(sentence) and not _FX_CONTEXT.search(sentence):
                    continue  # "... to manage interest rate costs" is about borrowing, not currency
                if name == "Natural hedge" and _NEGATED_BEFORE.search(text[max(0, m.start() - 40):m.start()]):
                    continue  # "not naturally hedged"
                policy = {"policy": name, "sentence": sentence}
                break
            if policy:
                break

    providers = []
    for m in _PROVIDER_RE.finditer(text):
        if not any(p["name"].lower() == m.group(1).lower() for p in providers):
            providers.append({"name": m.group(1), "sentence": hooks._sentence(text, m.start(), m.end())})
    return {"facility_dates": dates[:6], "fx_policy": policy, "fx_providers": providers[:3]}


# --- Columns -----------------------------------------------------------------------------------

def facility_end_date(iso: str) -> Optional[date]:
    """The latest day a written end date can mean: "2027-03-31" -> that day; "2027-03" -> 31 March; "2027" -> None (too vague)."""
    try:
        if len(iso) == 10:
            return date.fromisoformat(iso)
        if len(iso) == 7:
            y, m = int(iso[:4]), int(iso[5:7])
            return date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
    except ValueError:
        return None
    return None


def next_facility_end(facts: Optional[dict], today: Optional[date] = None, dated_only: bool = False) -> Optional[dict]:
    """
    The soonest facility end the accounts give that hasn't passed: a day or a
    month that is still to come, or (unless `dated_only`) a year after this one.
    """
    today = today or date.today()
    upcoming = []
    for d in (facts or {}).get("facility_dates") or []:
        last_day = facility_end_date(d["date"])
        if last_day is not None and last_day >= today:
            upcoming.append(d)
        elif last_day is None and not dated_only and len(d["date"]) == 4 and int(d["date"]) > today.year:
            upcoming.append(d)
    return min(upcoming, key=lambda d: d["date"]) if upcoming else None


def columns(facts: Optional[dict], charges: list[dict], today: Optional[date] = None) -> dict:
    f = facts or {}
    source = hooks._source_accounts(f).replace(", tagged figure", "")
    lenders = [f"{c['name']}: {charge_kind(c)}, registered {hooks.day(c['created_on'])}" for c in _outstanding(charges)[:4]]
    bank = incumbent_bank(charges)
    end = next_facility_end(f, today)
    provider_charge = next((c for c in _outstanding(charges) if _PROVIDER_HOLDER_RE.search(c["name"])), None)
    named = next(iter(f.get("fx_providers") or []), None)
    policy = f.get("fx_policy") or {}
    if provider_charge:
        found = _PROVIDER_HOLDER_RE.search(provider_charge["name"]).group(1).lower()
        fx_today = f"Uses an FX provider: {next(p for p in FX_PROVIDERS if p.lower() == found)}"   # "Ebury", not "EBURY"
        fx_evidence = (f"{provider_charge['name']} holds a charge registered {hooks.day(provider_charge['created_on'])} "
                       f"(Companies House charges register)")
    elif named:
        fx_today, fx_evidence = f"Uses an FX provider: {named['name']}", f"\"{named['sentence']}\" ({source})"
    elif policy:
        fx_today, fx_evidence = policy["policy"], f"\"{policy['sentence']}\" ({source})"
    else:
        fx_today = fx_evidence = ""
    return {
        "lenders": " | ".join(lenders) + (" (Companies House charges register)" if lenders else ""),
        "incumbent_bank": (f"{bank['bank']}: all-assets debenture since {hooks.day(bank['created_on'])} "
                           f"(Companies House charges register)") if bank else "",
        "facility_ends": "" if not end else hooks.day(end["date"]) if len(end["date"]) == 10 else
                         hooks.month(end["date"] + "-01") if len(end["date"]) == 7 else end["date"],
        "facility_ends_evidence": f"\"{end['sentence']}\" ({source})" if end else "",
        "fx_today": fx_today,
        "fx_today_evidence": fx_evidence,
        # links to the records behind them: the charge on the public register (accounts links: main.py)
        "incumbent_bank_url": (bank.get("url") or "") if bank else "",
        "fx_today_url": (provider_charge.get("url") or "") if provider_charge else "",
    }


COLUMNS = ["lenders", "incumbent_bank", "facility_ends", "facility_ends_evidence", "fx_today", "fx_today_evidence"]
