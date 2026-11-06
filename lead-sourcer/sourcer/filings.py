"""
sourcer/filings.py — companies whose newly filed accounts show FX, from
Companies House's free bulk accounts files.

Companies House publishes every set of accounts filed online (iXBRL: text
with the figures tagged) as a zip each morning — the previous day's filings
— and monthly archives of the past. Each file holds thousands of filings,
nearly all of tiny companies, so each is screened in two steps:

  1. quick, on the raw text: a tagged turnover of at least the floor, or —
     turnover not tagged — a document big enough to be full accounts that
     mentions foreign exchange;
  2. the survivors are read the way the finder reads accounts
     (accounts.extract_facts: turnover from the profit and loss account,
     the FX gain/loss line, the currency notes, how they handle FX, turnover
     by region) and kept when big enough and their filing shows FX.

A hit is a row for the Accounts page's "Recent FX filings" tab: who filed,
when, and what the filing says about their currency, each fact quoted.
Scanned (paper) filings aren't in these files. Public records only; no API
calls (the bulk files need no key).
"""

from __future__ import annotations

import html
from collections import Counter
import os
import re
import time
import urllib.request
import zipfile
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from typing import Iterable, Optional

from sourcer import accounts, fx_notes, hooks, incumbent

DOWNLOADS = "https://download.companieshouse.gov.uk/"
LIST_PAGES = {"daily": DOWNLOADS + "en_accountsdata.html", "monthly": DOWNLOADS + "en_monthlyaccountsdata.html"}
USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"
MIN_TURNOVER = int(os.environ.get("FILINGS_MIN_TURNOVER", "20000000"))
# Turnover not stated (filleted / untagged): an FX gain or loss this big still marks a company worth a look.
MIN_FX_WITHOUT_TURNOVER = 100_000
# Full accounts run to hundreds of KB; a micro-entity's are tens. Untagged turnover is only looked for above this.
MIN_BYTES_UNTAGGED = 120_000

_ZIP_HREF = re.compile(r'href="([^"]+\.zip)"', re.I)
_MEMBER = re.compile(r"([A-Z0-9]{8})_(\d{8})\.(?:x?html?|xml)$", re.I)
_TURNOVER_TAG = re.compile(
    rb"<ix:nonFraction\b([^>]*\bname=\"[^\":]*:(?:" + b"|".join(c.encode() for c in accounts.TURNOVER_CONCEPTS) +
    rb")\"[^>]*)>(?:\s*<[^>]+>)*\s*([\d,.\s]+)\s*<", re.I)
_SCALE = re.compile(rb"\bscale=\"(-?\d+)\"")
_FX_WORDS = re.compile(rb"exchange\s+(?:loss|gain|difference)|foreign\s+(?:exchange|currenc)|currency\s+risk|"
                       rb"forward\s+(?:foreign\s+)?(?:exchange|currency)|ForeignExchange", re.I)
_NAME_TAG = re.compile(r"name=\"[^\":]*:EntityCurrentLegalOrRegisteredName\"[^>]*>(.*?)</ix:nonNumeric>", re.I | re.S)

stats = {"files": 0, "screened_in": 0, "read": 0, "hits": 0, "seconds": 0.0, "stopped_early": False,
         "why": Counter(), "examples": {}}   # why each filing was dropped (or "kept"), for the run's report


# --- The bulk files ---------------------------------------------------------------------------------------------

def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def list_files(kind: str = "daily") -> list[str]:
    """The zip files on Companies House's daily or monthly accounts page, as full URLs, in page order."""
    page = _get(LIST_PAGES[kind]).decode("utf-8", errors="replace")
    return [u if u.startswith("http") else DOWNLOADS + u.lstrip("/") for u in dict.fromkeys(_ZIP_HREF.findall(page))]


def filed_label(url: str) -> str:
    """ "2026-11-04" from a daily file's name; "October 2026" from a monthly archive's."""
    name = url.rsplit("/", 1)[-1]
    day = re.search(r"(\d{4}-\d{2}-\d{2})", name)
    if day:
        return day.group(1)
    month = re.search(r"([A-Z][a-z]+)(\d{4})", name)
    return f"{month.group(1)} {month.group(2)}" if month else name


def download(url: str, folder: str) -> str:
    """The zip saved to `folder` (kept when already there), streamed to disk: monthly archives run to 4GB."""
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, url.rsplit("/", 1)[-1])
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp, open(path + ".part", "wb") as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)
    os.replace(path + ".part", path)
    return path


# --- Screening --------------------------------------------------------------------------------------------------

def tagged_turnover(document: bytes) -> Optional[float]:
    """The largest turnover figure tagged in the document (its scale applied), or None when none is tagged."""
    best = None
    for attrs, number in _TURNOVER_TAG.findall(document):
        value = _tag_number(attrs, number)
        if value is not None:
            best = value if best is None else max(best, value)
    return best


def _tag_number(attrs: bytes, number: bytes) -> Optional[float]:
    """A tagged figure as displayed — "45,123", or "1.157.778" / "1.234,5" where the format says the comma is the
    decimal (or dots group the thousands) — times 10^scale; None when unreadable."""
    text = number.decode("ascii", errors="ignore").strip().replace(" ", "")
    comma_decimal = b"commadecimal" in attrs.lower() or text.count(".") > 1 or re.fullmatch(r"[\d.]*,\d{1,2}", text)
    text = text.replace(".", "").replace(",", ".") if comma_decimal else text.replace(",", "")
    try:
        value = float(re.sub(r"[^\d.]", "", text))
        scale = _SCALE.search(attrs)
        return value * 10 ** int(scale.group(1) if scale else 0)
    except ValueError:
        return None


def screen_reason(document: bytes, min_turnover: float = MIN_TURNOVER) -> str:
    """Step 1: "" when worth reading (big enough on its tagged turnover, or — none tagged — full-accounts-sized and
    mentioning FX), else why not (counted in stats["why"] for the run's report)."""
    turnover = tagged_turnover(document)
    if turnover is not None:
        if turnover >= min_turnover:
            return ""
        band = "under £1m" if turnover < 1e6 else "£1m–£10m" if turnover < 10e6 else f"£10m–£{min_turnover / 1e6:g}m"
        fx = " (mentions FX)" if _FX_WORDS.search(document) else ""
        return f"screen: turnover {band}{fx}"
    if len(document) < MIN_BYTES_UNTAGGED:
        return "screen: no turnover shown, short accounts (micro / small / dormant)"
    return "" if _FX_WORDS.search(document) else "screen: no turnover tagged, no mention of foreign exchange"


def worth_reading(document: bytes, min_turnover: float = MIN_TURNOVER) -> bool:
    return not screen_reason(document, min_turnover)


# --- Reading a filing -------------------------------------------------------------------------------------------

def company_name(text: str) -> str:
    m = _NAME_TAG.search(text)
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", m.group(1))).split()) if m else ""


def filing_url(number: str) -> str:
    return f"https://find-and-update.company-information.service.gov.uk/company/{number}/filing-history"


def shows_fx(facts: dict, fx_today: str) -> bool:
    """
    Whether the filing proves foreign-currency flows: an FX gain/loss, forwards, how they hedge (not "doesn't
    hedge" on its own), currencies tied to the business, sensitivity, balances in another currency, or overseas
    sales of 5%+ of turnover. "We don't hedge" with all-UK sales, or a balance in pounds, isn't.
    """
    if facts.get("fx_gain_loss") or facts.get("fx_forwards") or facts.get("fx_sensitivity") or facts.get("fx_currencies"):
        return True
    if fx_today and not fx_today.startswith("Doesn't hedge"):
        return True
    if any(b.get("in") or b.get("ccy") not in ("GBP", "", None) for b in facts.get("fx_balances") or []):
        return True
    whole = facts.get("turnover") or sum(r.get("value", 0) for r in facts.get("regions") or [])
    abroad = sum(r.get("value", 0) for r in facts.get("regions") or [] if not hooks.is_uk(r.get("region", "")))
    return bool(whole and abroad >= 0.05 * whole)


# A filing without turnover (filleted: no profit and loss account, legal for "small" companies — two of: turnover
# up to £15m, balance sheet up to £7.5m, 50 staff — so a £25m company with a light balance sheet can do it): its size
# is estimated from what it must still file, labelled as an estimate, never shown as turnover.
SIZE_RULES = {
    "debtor_multiple": (4.0, 8.0),          # sales ≈ money owed by customers x 4–8 (customers paying in 45–90 days)
    "per_employee": (100_000, 300_000),     # sales per member of staff, for a trading company
    "keep_low": 10_000_000,                 # kept only when the estimate's low end is at least this…
}


def size_band(facts: dict) -> Optional[dict]:
    """
    {"low", "high", "basis"}: a turnover range from the trade debtors and staff numbers in the filing (where both are
    given, the range they agree on), or None when the filing gives neither.
    """
    debtors, staff = facts.get("trade_debtors"), facts.get("employees")
    bands, basis = [], []
    if debtors:
        lo, hi = SIZE_RULES["debtor_multiple"]
        bands.append((debtors * lo, debtors * hi))
        basis.append(f"{hooks.short(debtors)} owed by customers")
    if staff:
        lo, hi = SIZE_RULES["per_employee"]
        bands.append((staff * lo, staff * hi))
        basis.append(f"{staff:,} staff")
    if not bands:
        return None
    low, high = max(b[0] for b in bands), min(b[1] for b in bands)
    agree = low <= high
    if not agree:
        low, high = min(b[0] for b in bands), max(b[1] for b in bands)
    return {"low": low, "high": high,
            "basis": " and ".join(basis) + ("" if agree else " (they point to different sizes)")}


def size_label(band: dict) -> str:
    """ "likely £16m–£26m" """
    return f"likely {hooks.short(band['low'])}–{hooks.short(band['high'])}"


# The size regime the accounts are prepared under, from the statement every set must make.
_SMALL_REGIME = re.compile(r"small\s+companies\s+regime|section\s*1A\b|applicable\s+to\s+small\s+(?:companies|entities)|"
                           r"small\s+companies\s+exemption", re.I)
_MEDIUM_REGIME = re.compile(r"medium[- ]sized\s+compan", re.I)


def accounts_regime(text: str) -> str:
    """ "small" / "medium" / "" (full accounts of a large company, or not stated)."""
    if _SMALL_REGIME.search(text):
        return "small"
    return "medium" if _MEDIUM_REGIME.search(text) else ""


# --- Notes kept from the filing: bank borrowing, every line about currency ---------------------------------------

_BANK_DEBT = re.compile(r"bank\s+loans?|bank\s+overdrafts?|revolving\s+credit\s+facilit\w+|\bRCF\b|term\s+loans?|"
                        r"invoice\s+(?:discounting|finance)\s+facilit\w+|asset\s+(?:based\s+)?(?:lending|finance)\s+facilit\w+|"
                        r"bank\s+borrowings?|loan\s+facilit\w+", re.I)
_FX_WORDS_TEXT = re.compile(r"\bforeign\b|\bdollars?\b|\beuros?\b|\b(?:USD|EUR|CNY|RMB|JPY|CHF|AUD|CAD|SEK|NOK|DKK|PLN)\b|"
                            r"[$€¥]\s?\d|exchange\s+rates?|\bcurrenc\w+|\bhedg\w+|forward\s+contracts?|\boverseas\b|"
                            r"\bexport\w*|\bimport\w*|\bsterling\b", re.I)
# Accounting-policy boilerplate every company with a foreign invoice prints: kept last.
_FX_POLICY = re.compile(r"translated|retranslated|functional\s+currency|presentation\s+currency|closing\s+rate|"
                        r"rate\s+(?:of\s+exchange\s+)?ruling|spot\s+rate|monetary\s+(?:assets|items)", re.I)
FX_MENTIONS_MAX = 4


def bank_debt(facts: dict, plain: str) -> str:
    """ "Bank loans and overdrafts £3.2m (tagged)" / "mentions a revolving credit facility, a term loan" / ""."""
    if facts.get("bank_borrowings"):
        return f"Bank loans and overdrafts {hooks.short(facts['bank_borrowings'])} (tagged in the accounts)"
    found = list(dict.fromkeys(m.group(0).lower() for m in _BANK_DEBT.finditer(plain)))[:3]
    return ("Mentions " + ", ".join(found)) if found else ""


def fx_mentions(plain: str, limit: int = FX_MENTIONS_MAX) -> tuple[list[str], int]:
    """
    (the sentences mentioning currency, foreign trade or hedging — the business's own first, accounting-policy
    boilerplate last — each trimmed; how many sentences mention it in all).
    """
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z(])", " ".join(plain.split()))
    hits = [x for x in sentences if _FX_WORDS_TEXT.search(x) and 20 <= len(x) <= 1200]
    hits = list(dict.fromkeys(hits))
    ranked = sorted(hits, key=lambda x: bool(_FX_POLICY.search(x)))
    return [hooks._sentence(x, 0, 0, limit=220) for x in ranked[:limit]], len(hits)


# --- Moved up from small accounts (Companies House filing history: one call per company kept) -----------------

_SMALL_TYPES = ("small", "micro-entity", "total-exemption", "unaudited-abridged", "abridged", "dormant")
_BIG_TYPES = ("medium", "full", "group")


def _accounts_type(description: str) -> str:
    """ "small" / "medium" / "full" (full or group) / "" from a filing-history description."""
    d = (description or "").lower()
    if not d.startswith("accounts-with-accounts-type-"):
        return ""
    kind = d.replace("accounts-with-accounts-type-", "")
    if kind.startswith(_SMALL_TYPES):
        return "small"
    if kind.startswith("medium"):
        return "medium"
    return "full" if kind.startswith(("full", "group")) else ""


def moved_up(items: list[dict]) -> str:
    """
    "Moved up from small accounts (31 Dec 2024: small → 31 Dec 2025: medium-sized)" when the latest annual accounts
    are medium or full and one of the two before was small, else "". `items`: filing-history items, newest first.
    """
    accounts = [(i.get("description_values", {}).get("made_up_date", "") or i.get("date", ""),
                 _accounts_type(i.get("description", ""))) for i in items if i.get("type") == "AA"]
    accounts = [(d, t) for d, t in accounts if t]
    if len(accounts) < 2 or accounts[0][1] not in ("medium", "full"):
        return ""
    before = next(((d, t) for d, t in accounts[1:3] if t == "small"), None)
    if not before:
        return ""
    words = {"medium": "medium-sized", "full": "full", "small": "small"}
    return (f"Moved up from small accounts ({hooks.day(before[0]) or before[0]}: small → "
            f"{hooks.day(accounts[0][0]) or accounts[0][0]}: {words[accounts[0][1]]})")


def accounts_history(number: str, api_key: str) -> Optional[list[dict]]:
    """The company's accounts filings (newest first) from Companies House, or None when the call fails."""
    from sourcer import companies_house

    companies_house._throttle()
    data = companies_house._get(accounts.CH_FILING_HISTORY.format(number=number),
                                {"category": "accounts", "items_per_page": 10}, api_key)
    return None if data is None else data.get("items", [])


# --- Mini research: who runs it, who it banks with, who owns it (three Companies House calls per company) -----------

def research(number: str, name: str, api_key: str, today: Optional[date] = None) -> dict:
    """
    Directors, the incumbent bank (all-assets debenture holder) and other lenders, the owner (UK or overseas parent,
    private-equity backing) and the finder's triggers (new owner, new or paid-off charge, facility renewal due, new
    director) from the register — the same rules as the main list — plus a Google search for the FD. The finance
    contact hunt (websites, news, search) stays in the main finder.
    """
    from sourcer import companies_house, news, triggers

    today = today or date.today()
    directors = companies_house.get_active_directors(number, api_key)
    charges = companies_house.get_charges(number, api_key)
    owners = companies_house.get_owners(number, api_key)
    bank = incumbent.incumbent_bank(charges)
    lenders = [c for c in incumbent._outstanding(charges) if not bank or c is not bank][:3]
    return {
        "directors": "; ".join(f"{d['name']}" + (f" (appointed {hooks.day(d['appointed_on'])})" if d.get("appointed_on") else "")
                               for d in directors[:5]),
        "director_count": len(directors),
        "incumbent_bank": (f"{bank['bank']}: all-assets debenture since {hooks.day(bank['created_on'])}" if bank else ""),
        "incumbent_bank_url": bank.get("url", "") if bank else "",
        "lenders": "; ".join(f"{c['name']}: {incumbent.charge_kind(c)}" + (f", {hooks.day(c['created_on'])}" if c.get("created_on") else "")
                             for c in lenders),
        "owner": owner_line(owners),
        "triggers": " | ".join(triggers.find(owners, charges, directors, today)),
        "fd_search_url": news.verify_links(name)[0],
        "research_checked": today.isoformat(),
    }


def owner_line(owners: list[dict]) -> str:
    """ "Owned by ACME HOLDINGS LIMITED (UK, 01234567)" / "… (Germany) — overseas parent" / "… — private-equity
    backed" / "Owned by 2 individuals" / ""."""
    from sourcer import triggers

    current = [o for o in owners if not o.get("ceased_on")]
    corporate = [o for o in current if o["kind"] != "individual"]
    if corporate:
        o = corporate[0]
        uk = hooks.is_uk(o.get("country", ""))
        where = ("UK" + (f", {o['registration_number']}" if o.get("registration_number") else "")) if uk else o.get("country", "")
        pe = triggers.investor_owner(current) == o["name"]
        return (f"Owned by {o['name']}" + (f" ({where})" if where else "")
                + (" — overseas parent" if not uk else "") + (" — private-equity backed" if pe else ""))
    people = [o for o in current if o["kind"] == "individual"]
    return f"Owned by {len(people)} individual{'s' if len(people) != 1 else ''}" if people else ""


def tidy(rows: list[dict]) -> int:
    """
    Today's sanity rules on rows already on the list (no reading again): an FX gain/loss under £1,000 at a £10m+
    company, a turnover over £5bn without the staff for it, and forward sizes the reader no longer takes
    (accounts.check_fx / check_turnover, fx_notes.forward_evidence_doubtful) move to a check; the filed FX proof is
    scored again (customs points kept). Returns how many rows changed.
    """
    changed = 0
    for r in rows:
        before = (r.get("fx_gain_loss_gbp"), r.get("turnover_gbp"), r.get("fx_forwards"), r.get("employees"))
        before_sens = (r.get("fx_sensitivity"), r.get("turnover_regions"))
        turnover = float(r["turnover_gbp"]) if r.get("turnover_gbp") else None
        staff = int(r["employees"]) if str(r.get("employees") or "").isdigit() else 0
        if turnover and turnover > accounts.MAX_PLAUSIBLE_TURNOVER and staff < 1_000:
            r.update(turnover_gbp="", turnover_check=f"turnover read as {hooks.short(turnover)}: too big to be right "
                                                     f"(cells run together, or a £'000 figure read as £m?); check the accounts")
            turnover = None
        # headcounts tagged with a wrong scale (accounts._headcount): 1,072 read as 1,072,000 is put back; 104 read as
        # 1 can't be, so it's cleared; a size estimate built on either is worked out again from what's left
        if str(r.get("employees") or "").isdigit():
            n = int(r["employees"])
            fixed = n // 1000 if n >= 20_000 and n % 1000 == 0 else None if n <= 2 else n
            if fixed and r.get("turnover_gbp") and float(r["turnover_gbp"]) / fixed > accounts.MAX_TURNOVER_PER_HEAD:
                fixed = None   # a holding company's own staff beside the group's turnover
            if fixed != n:
                r["employees"] = str(fixed) if fixed else ""
                if r.get("size_estimate") and "staff" in (r.get("size_estimate_basis") or ""):
                    debtors = re.search(r"£([\d.]+)(k|m|bn) owed by customers", r["size_estimate_basis"])
                    band = size_band({"trade_debtors": float(debtors.group(1)) * {"k": 1e3, "m": 1e6, "bn": 1e9}[debtors.group(2)]
                                      if debtors else None, "employees": fixed})
                    if band:
                        r.update(size_estimate=size_label(band), size_low_gbp=str(round(band["low"])),
                                 size_estimate_basis=f"from {band['basis']} — not filed turnover (the accounts are "
                                                     f"filleted: no profit and loss account)")
                    else:
                        r.update(size_estimate="", size_low_gbp="", size_estimate_basis="size not estimated: the staff "
                                                                                         "figure was tagged wrongly")
        fx = float(r["fx_gain_loss_gbp"]) if r.get("fx_gain_loss_gbp") else None
        if fx and abs(fx) < accounts.FX_MIN_PLAUSIBLE and turnover and turnover >= accounts.FX_MIN_PLAUSIBLE_TURNOVER:
            r.update(fx_gain_loss_gbp="", fx_gain_loss_prior_gbp="",
                     fx_gain_loss_check=f"FX figure read as {hooks.short(fx)} at a company with {hooks.short(turnover)} "
                                        f"turnover: probably in £'000; check the accounts ({r.get('fx_gain_loss_evidence', '')})")
        sens = re.search(r"[£$€]\s?([\d,.]+)\s*(k|m|bn)?\b", (r.get("fx_sensitivity") or "").split(" — ")[0])
        if sens and turnover:
            size = float(sens.group(1).replace(",", "")) * {"k": 1e3, "m": 1e6, "bn": 1e9}.get(sens.group(2) or "", 1)
            if size > 0.5 * turnover:
                r["fx_sensitivity"] = ""   # a currency move's effect over half of turnover: a misread (a growth line)
        parts = re.findall(r"£\s?([\d,.]+)\s*(k|m|bn)?\b", r.get("turnover_regions") or "")
        if turnover and parts and sum(float(a.replace(",", "")) * {"k": 1e3, "m": 1e6, "bn": 1e9}.get(u, 1)
                                      for a, u in parts) > accounts.REGIONS_MAX_SHARE * turnover:
            r["turnover_regions"] = ""   # regions adding to more than turnover: years or columns mixed
        prior = float(r["fx_gain_loss_prior_gbp"]) if r.get("fx_gain_loss_prior_gbp") else None
        if fx and prior and max(abs(fx), abs(prior)) / max(min(abs(fx), abs(prior)), 1) > 1_000:
            r["fx_gain_loss_prior_gbp"] = ""
        recheck = fx_notes.forward_recheck(r.get("fx_forwards") or "", r.get("fx_forwards_evidence") or "")
        if recheck:
            new, why = recheck
            r.update(fx_forwards=new, fx_forwards_check="" if new else f"{why}: {r.get('fx_forwards_evidence', '')}")
        if (r.get("fx_gain_loss_gbp"), r.get("turnover_gbp"), r.get("fx_forwards"), r.get("employees"),
                r.get("fx_sensitivity"), r.get("turnover_regions")) != before + before_sens:
            changed += 1
            score, lines = fx_notes.filed_proof(r)
            if r.get("hmrc_trade"):
                score += CUSTOMS_POINTS
                line = r["hmrc_trade"].removeprefix("HMRC customs records: ").split(" (matched")[0]
                lines.append(f"HMRC customs: {line} (+{CUSTOMS_POINTS})")
            r.update(filed_fx_score=score, filed_fx="; ".join(lines))
    return changed


_OWNED_ABROAD = re.compile(r"^Owned by (.+) \(([^()]+)\) — overseas parent")


def owner_abroad(row: dict) -> tuple[str, str]:
    """(parent, country) when the mini research's owner line names a parent registered abroad; ('', '') otherwise."""
    m = _OWNED_ABROAD.match(row.get("owner") or "")
    if not m or " ".join(m.group(2).upper().split()) in hooks.ABROAD_RULES["not_abroad"]:
        return "", ""
    return m.group(1), m.group(2)


def mark_abroad(rows: list[dict]) -> int:
    """
    run_from_abroad on each researched row (hooks.run_from_abroad: owned from abroad, no sign of FX run locally) and
    rank_score — the filed FX proof less ABROAD_RULES["points"] for those — the order the finder takes them in.
    Rerun every scan (no calls), so a rule change reaches every row. Returns how many are run from abroad.
    """
    for r in rows:
        r["run_from_abroad"] = hooks.run_from_abroad(*owner_abroad(r), r)
        r["rank_score"] = rank_score(r)
    return sum(bool(r["run_from_abroad"]) for r in rows)


def rank_score(row: dict) -> int:
    """Filed FX proof, less ABROAD_RULES["points"] when the FX decision is probably made abroad."""
    abroad = row.get("run_from_abroad")
    if abroad is None:
        abroad = hooks.run_from_abroad(*owner_abroad(row), row)
    return int(row.get("filed_fx_score") or 0) - (hooks.ABROAD_RULES["points"] if abroad else 0)


def hit(document: bytes, number: str, made_up: str, filed: str, min_turnover: float = MIN_TURNOVER) -> Optional[dict]:
    """A row only when the filing itself proves FX (customs records are checked later, by finalise)."""
    row, _ = assess(document, number, made_up, filed, min_turnover)
    return row if row and row["fx_in_filing"] else None


def assess(document: bytes, number: str, made_up: str, filed: str,
           min_turnover: float = MIN_TURNOVER) -> tuple[Optional[dict], str]:
    """
    Step 2: the filing read like the finder reads accounts. (row, why): a row when the company is big enough —
    filed turnover at the floor, or no turnover filed and a size estimate reaching it — with fx_in_filing saying
    whether the filing itself proves FX (else customs records decide, in finalise); None and why not otherwise.
    """
    facts = accounts.extract_facts(document)
    facts["format"] = "ixbrl"
    turnover, fx = facts.get("turnover"), facts.get("fx_gain_loss")
    if turnover is not None and turnover < min_turnover:
        return None, "read: turnover in the accounts under the floor (a subsidiary's own, or the tag was a segment)"
    text = document.decode("utf-8", errors="replace")
    plain_text = html.unescape(re.sub(r"<[^>]+>", " ", re.sub(r"<ix:header\b.*?</ix:header>", " ", text, flags=re.S)))
    regime = accounts_regime(plain_text)
    if regime == "small" and turnover is None:
        return None, "read: no turnover filed, accounts prepared as a small company"
    band = size_band(facts) if turnover is None else None
    big_by_band = bool(band and band["high"] >= min_turnover and band["low"] >= SIZE_RULES["keep_low"])
    if turnover is None and not big_by_band and abs(fx or 0) < MIN_FX_WITHOUT_TURNOVER:
        text = document.decode("utf-8", errors="replace")
        debtor_tags = sorted({m.split(":")[-1] for m in re.findall(r'name="([^"]+)"', text)
                              if re.search(r"debtor|receivable", m, re.I)})[:5]
        example = (f"\t{company_name(text) or number} ({number}): staff {facts.get('employees') or '—'}, trade debtors "
                   f"{hooks.short(facts['trade_debtors']) if facts.get('trade_debtors') else '—'}"
                   + (f" → {size_label(band)}" if band else "") + f"; debtor tags: {', '.join(debtor_tags) or 'none'}")
        if not band:
            return None, "read: no turnover filed, no staff or debtors figures to size it" + example
        return None, "read: no turnover filed, too small on staff / debtors" + example
    name = company_name(text) or number
    url = filing_url(number)
    cols = fx_notes.columns(facts, name, url)
    today = incumbent.columns(facts, [])
    exposure = hooks.currency_exposure(name, facts, [], {})
    row = {
        "company_number": number, "company_name": name, "filed": filed, "period_end": facts.get("period_end") or made_up,
        "turnover_gbp": str(round(turnover)) if turnover is not None else "",
        "turnover_basis": facts.get("turnover_basis", ""), "turnover_check": facts.get("turnover_check", ""),
        "size_estimate": size_label(band) if band else "",
        "size_estimate_basis": (f"from {band['basis']} — not filed turnover (the accounts are filleted: no profit "
                                f"and loss account)") if band else "",
        "size_low_gbp": str(round(band["low"])) if band else "",
        "fx_gain_loss_gbp": str(round(fx)) if fx is not None else "",
        "fx_gain_loss_prior_gbp": str(round(facts["fx_gain_loss_prior"])) if facts.get("fx_gain_loss_prior") is not None else "",
        "fx_gain_loss_evidence": facts.get("fx_gain_loss_evidence", "") if fx is not None else "",
        "fx_today": today["fx_today"], "fx_today_evidence": today["fx_today_evidence"],
        "currency": exposure["currency"] if exposure["rule"] not in ("niche", "") else "",
        "currency_source": hooks.CURRENCY_SOURCES.get(exposure["rule"], "") if exposure["rule"] != "niche" else "",
        "currency_evidence": exposure["evidence"] if exposure["rule"] not in ("niche", "") else "",
        "auditor": facts.get("auditor", ""), "bankers": ", ".join(facts.get("bankers") or []),
        "employees": str(facts["employees"]) if facts.get("employees") else "",
        "accounts_regime": regime,
        "bank_debt": bank_debt(facts, plain_text),
        "accounts_url": url,
        **{k: v for k, v in cols.items() if not k.endswith("_url")},
    }
    mentions, mention_count = fx_mentions(plain_text)
    row.update(fx_mentions=mentions, fx_mention_count=mention_count)
    row["fx_in_filing"] = shows_fx(facts, today["fx_today"])
    score, lines = fx_notes.filed_proof(row)
    row.update(filed_fx_score=score, filed_fx="; ".join(lines))
    if row["fx_in_filing"]:
        return row, "kept: FX in the filing" + (" (size estimated)" if band else "")
    return row, "read: big" + (" on staff / debtors" if band else "") + ", no FX in the filing — customs records checked"


# --- HMRC customs records: proof of trade abroad for a filing that says nothing about FX --------------------------

CUSTOMS_POINTS = 20


def customs_index(traders: dict) -> dict[str, dict]:
    """HMRC traders (hmrc.build_traders) by normalised name, a name's postcodes merged."""
    from sourcer.matching import normalise_name

    out: dict[str, dict] = {}
    for (name, _), t in traders.items():
        e = out.setdefault(name, {"import_months": set(), "export_months": set(),
                                  "import_codes": Counter(), "export_codes": Counter()})
        for k in ("import_months", "export_months"):
            e[k] |= t[k]
        for k in ("import_codes", "export_codes"):
            e[k].update(t[k])
    return out


def customs_line(trade: dict) -> str:
    """ "imports in 12 of the last 12 months, exports in 3 (goods: wine, machinery)" """
    from sourcer import hmrc

    parts = [f"{w} in {len(trade[f'{k}_months'])} of the last 12 months"
             for k, w in (("import", "imports"), ("export", "exports")) if trade[f"{k}_months"]]
    goods = hmrc.chapters(trade["import_codes"] + trade["export_codes"])
    return ", ".join(parts) + (f" (goods: {', '.join(goods)})" if goods else "")


def finalise(rows: list[dict], customs: Optional[dict[str, dict]]) -> tuple[list[dict], Counter]:
    """
    The rows to list: each checked against HMRC's importer / exporter lists (by registered name); kept when the
    filing or the customs records prove trade in another currency. (rows, why) — why counts each decision.
    """
    from sourcer.matching import normalise_name

    kept, why = [], Counter()
    for row in rows:
        row = dict(row)   # the caller's rows stay as read: running this twice never counts customs twice
        trade = (customs or {}).get(normalise_name(row["company_name"]))
        if trade and (trade["import_months"] or trade["export_months"]):
            line = customs_line(trade)
            row["hmrc_trade"] = f"HMRC customs records: {line} (matched on the registered name)"
            row["filed_fx_score"] = row.get("filed_fx_score", 0) + CUSTOMS_POINTS
            row["filed_fx"] = "; ".join(x for x in (row.get("filed_fx"), f"HMRC customs: {line} (+{CUSTOMS_POINTS})") if x)
        if row.get("fx_in_filing"):
            why["kept: FX in the filing" + (" and customs" if row.get("hmrc_trade") else "")] += 1
        elif row.get("hmrc_trade"):
            why["kept: customs records only (no FX in the filing)"] += 1
        else:
            why["dropped: big, but no FX in the filing or customs records"] += 1
            continue
        kept.append(row)
    return kept, why


def _read_one(args: tuple) -> tuple[Optional[dict], str]:
    """Step 2 for one screened-in filing — run in worker processes."""
    document, number, made_up, filed, min_turnover = args
    try:
        return assess(document, number, made_up, filed, min_turnover)
    except Exception:  # noqa: BLE001 — one malformed filing mustn't stop the scan
        return None, "read: couldn't be read (malformed filing)"


def scan(path: str, filed: str = "", min_turnover: float = MIN_TURNOVER, workers: int = 0,
         only: Optional[Iterable[str]] = None, limit: int = 0, batch: int = 64, max_hits: int = 0) -> list[dict]:
    """
    Every accounts document in a bulk zip screened (here, cheaply) and the survivors read (in `workers` processes,
    `batch` at a time, so a 4GB archive never sits in memory); the hits, strongest filed-FX proof first.
    `only`: company numbers to look at (tests / samples); `limit`: stop after this many documents (0: all);
    `max_hits`: stop once this many companies are found (a test run; stats["stopped_early"] says so).
    """
    started = time.time()
    stats["stopped_early"] = False
    filed = filed or filed_label(path)
    wanted = {n.upper() for n in only} if only else None
    hits: list[dict] = []
    pending: list[tuple] = []
    workers = workers or max(1, os.cpu_count() or 2)

    def flush(pool) -> None:
        for found, why in (pool.map(_read_one, pending) if pool else map(_read_one, pending)):
            why, _, example = why.partition("\t")
            stats["why"][why] += 1
            if example and len(stats["examples"].setdefault(why, [])) < 40:
                stats["examples"][why].append(example)
            if found:
                hits.append(found)
        stats["read"] += len(pending)
        pending.clear()

    pool = ProcessPoolExecutor(max_workers=workers) if workers > 1 else None
    try:
        with zipfile.ZipFile(path) as zf:
            for info in zf.infolist():
                m = _MEMBER.search(info.filename)
                if not m or (wanted and m.group(1).upper() not in wanted):
                    continue
                if (limit and stats["files"] >= limit) or (max_hits and len(hits) >= max_hits):
                    stats["stopped_early"] = True
                    break
                stats["files"] += 1
                document = zf.read(info)
                try:
                    why = screen_reason(document, min_turnover)
                except Exception:  # noqa: BLE001 — one odd filing mustn't stop a month of them
                    why = "screen: couldn't be read"
                if why:
                    stats["why"][why] += 1
                    continue
                d = m.group(2)
                pending.append((document, m.group(1).upper(), f"{d[:4]}-{d[4:6]}-{d[6:]}", filed, min_turnover))
                if len(pending) >= (min(batch, workers) if max_hits else batch):
                    flush(pool)
            flush(pool)
    finally:
        if pool:
            pool.shutdown()
    stats["screened_in"] = stats["read"]
    stats["hits"] += len(hits)
    stats["seconds"] += time.time() - started
    hits.sort(key=lambda r: (-r["filed_fx_score"], -float(r["turnover_gbp"] or 0)))
    return hits[:max_hits] if max_hits else hits


def merge(previous: list[dict], new: list[dict], keep_days: int = 400, today: Optional[date] = None) -> list[dict]:
    """
    The tab's rows: the newest filing per company (a later period end replaces an earlier one), filings made more
    than `keep_days` ago dropped (by when filed: accounts come up to 9 months after the year end), newest first.
    """
    today = today or date.today()
    cutoff = date.fromordinal(today.toordinal() - keep_days).isoformat()
    best: dict[str, dict] = {}
    for row in list(previous or []) + list(new or []):
        number = row.get("company_number", "")
        if not number or _sort_date(row.get("filed", "")) < cutoff[:7]:
            continue
        old = best.get(number)
        if not old or (row.get("period_end") or "") >= (old.get("period_end") or ""):
            best[number] = row
    return sorted(_one_per_group(list(best.values())),
                  key=lambda r: (_sort_date(r.get("filed", "")), r.get("filed_fx_score", 0)), reverse=True)


def _one_per_group(rows: list[dict]) -> list[dict]:
    """
    A group's figures filed by several of its companies (the holding company, a subsidiary, an employee-ownership
    trustee) as one row: same year end and the same turnover, or the same FX gain/loss to the pound (LRS Broadhurst
    and The Long Rake Spar: £36.2m v £35.9m turnover, both a £22,990 FX loss). The group's own filing (group
    figures) is kept, the others named in also_filed.
    """
    parent = list(range(len(rows)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    seen: dict[tuple, int] = {}
    for i, r in enumerate(rows):
        end = r.get("period_end", "")
        keys = [("turnover", r.get("turnover_gbp"), end)] if r.get("turnover_gbp") else []
        if r.get("fx_gain_loss_gbp") and abs(float(r["fx_gain_loss_gbp"])) >= 1_000:
            keys.append(("fx", r["fx_gain_loss_gbp"], end))
        for key in keys:
            if key in seen:
                parent[root(i)] = root(seen[key])
            else:
                seen[key] = i
    groups: dict[int, list[dict]] = {}
    for i, r in enumerate(rows):
        groups.setdefault(root(i), []).append(r)
    out = []
    for same in groups.values():
        same.sort(key=lambda r: (r.get("turnover_basis") != "group", -r.get("filed_fx_score", 0),
                                 -float(r.get("turnover_gbp") or 0), r.get("company_name", "")))
        keep = dict(same[0])
        others = [f"{r.get('company_name', '')} ({r['company_number']})" for r in same[1:]]
        if others:
            keep["also_filed"] = "; ".join(others)
        out.append(keep)
    return out


_MONTHS = {m: i for i, m in enumerate(("January February March April May June July August September October "
                                       "November December").split(), 1)}


def _sort_date(filed: str) -> str:
    """ "2026-11-04" as is; "October 2026" as "2026-10-00", so a month's archive sorts before its days."""
    m = re.fullmatch(r"([A-Z][a-z]+) (\d{4})", filed or "")
    return f"{m.group(2)}-{_MONTHS.get(m.group(1), 0):02d}-00" if m else (filed or "")
