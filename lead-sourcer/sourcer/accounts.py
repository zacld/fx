"""
sourcer/accounts.py — turnover and currency exposure from a company's latest filed accounts.

Companies House has no turnover field. Turnover is in the accounts
document itself: most accounts filed electronically are iXBRL (XHTML with
every figure tagged), where it's a tagged fact. This finds the latest
annual accounts filing, fetches its iXBRL from the Document API and reads
that fact for the latest period, whole company (not a regional breakdown).

It isn't always there — paper/PDF filings carry no tags, and small and
medium companies may file without a profit and loss account — so callers
treat None as "unknown", never as zero.
"""

from __future__ import annotations

import html
import re
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import Optional

from sourcer import banks, companies_house, fx_text, hooks, incumbent, pdf, people, profiles, website

CH_FILING_HISTORY = f"{companies_house.CH_BASE}/company/{{number}}/filing-history"
DOCUMENT_CONTENT = "https://document-api.company-information.service.gov.uk/document/{id}/content"

# Turnover concept names, prefix-free: FRS 102/101 (FRC taxonomy), old UK
# GAAP, and IFRS for the groups that report under it.
TURNOVER_CONCEPTS = {"TurnoverRevenue", "TurnoverGrossOperatingRevenue", "Revenue", "RevenueFromContractsWithCustomers"}

# Foreign exchange gain/loss in profit or loss: a company only has one if it
# holds, owes or is owed foreign currency. Names as seen in real filings.
FX_GAIN_LOSS_CONCEPTS = {
    "GainLossDueToForeignExchangeDifferencesRecognisedInProfitOrLoss",
    "OtherForeignExchangeLossGain",
    "ForeignExchangeGainLoss",
}
# Cost of sales — the purchases side of the business, which is where import payments sit.
COST_OF_SALES_CONCEPTS = {"CostSales", "CostOfSales", "CostOfRevenue"}
_HEDGING_WORDS = ("Derivative", "Hedg", "ForwardContract", "ForwardForeignExchange")

# Large-company iXBRL can embed images; turnover is near the front, so a cap is safe.
MAX_DOCUMENT_BYTES = 40 * 1024 * 1024

_COMMA_DECIMAL_FORMATS = ("commadecimal", "comma-decimal", "numdotcomma", "numspacecomma", "num-space-comma")
_ZERO_FORMATS = ("zerodash", "fixed-zero", "nocontent")


def latest_accounts_filing(company_number: str, api_key: str) -> Optional[dict]:
    """The newest annual accounts ("AA") filing-history item, or None."""
    companies_house._throttle()
    data = companies_house._get(
        CH_FILING_HISTORY.format(number=company_number),
        {"category": "accounts", "items_per_page": 10},
        api_key,
    )
    for item in (data or {}).get("items", []):
        if item.get("type") == "AA":
            return item
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # surface the 302 so its target is fetched without our credentials


_no_redirect_opener = urllib.request.build_opener(_NoRedirect)


def _read_capped(resp) -> bytes:
    return resp.read(MAX_DOCUMENT_BYTES)


def fetch_ixbrl(document_id: str, api_key: str, retries: int = 3) -> Optional[bytes]:
    """The iXBRL (XHTML) version of a filed document, or None if there isn't one (PDF-only filings)."""
    return fetch_document(document_id, api_key, "application/xhtml+xml", retries)


def fetch_pdf(document_id: str, api_key: str, retries: int = 3) -> Optional[bytes]:
    """The PDF version of a filed document (every filing has one), or None."""
    return fetch_document(document_id, api_key, "application/pdf", retries)


def fetch_document(document_id: str, api_key: str, accept: str, retries: int = 3) -> Optional[bytes]:
    """
    A filed document in the `accept` format, or None if there's no such
    version or it can't be fetched. The Document API answers with a
    redirect to a pre-signed S3 URL; that's fetched separately, with no
    Authorization header — S3 rejects a request carrying two auth methods.
    """
    url = DOCUMENT_CONTENT.format(id=document_id)
    headers = dict(companies_house._auth_header(api_key), Accept=accept)
    location = None
    for attempt in range(1, retries + 1):
        companies_house._throttle()
        try:
            with _no_redirect_opener.open(urllib.request.Request(url, headers=headers), timeout=30) as resp:
                return _read_capped(resp)  # served directly, no redirect
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get("Location"):
                location = e.headers["Location"]
                break
            if e.code == 429 and attempt < retries:
                time.sleep(2 ** attempt)
                continue
            return None  # 406: no version in that format; 404 etc.
        except (urllib.error.URLError, OSError):
            return None
    if not location:
        return None
    try:
        with urllib.request.urlopen(urllib.request.Request(location), timeout=60) as resp:
            return _read_capped(resp)
    except (urllib.error.URLError, OSError):
        return None


# Balance sheet: cash (a deposit / treasury opportunity), bank debt and net assets (credit capacity).
CASH_CONCEPTS = {"CashBankOnHand", "CashBankInHand", "CashAndCashEquivalents", "CashCashEquivalents"}
BORROWING_CONCEPTS = {"BankBorrowings", "BankBorrowingsOverdrafts", "LoansFromBanks", "BankLoansAndOverdrafts"}
NET_ASSETS_CONCEPTS = {"NetAssetsLiabilities", "NetAssetsLiabilitiesIncludingPensionAssetLiability"}
_READ_CONCEPTS = (TURNOVER_CONCEPTS | FX_GAIN_LOSS_CONCEPTS | COST_OF_SALES_CONCEPTS | CASH_CONCEPTS
                  | BORROWING_CONCEPTS | NET_ASSETS_CONCEPTS)
_UK_MEMBERS = ("UNITEDKINGDOM", "ENGLAND", "SCOTLAND", "WALES", "NORTHERNIRELAND", "GREATBRITAIN", "DOMESTIC")


class _IxbrlScanner(HTMLParser):
    """Collects contexts, units and turnover facts from an iXBRL document."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.contexts: dict[str, dict] = {}  # id -> {"end": "yyyy-mm-dd", "dimensional": bool, "members": [(dim, member)]}
        self.units: dict[str, str] = {}      # id -> first measure, e.g. "iso4217:GBP"
        self.facts: list[dict] = []
        self.dimensions: set[str] = set()   # dimension names used anywhere (e.g. CurrenciesDimension)
        self.concepts: set[str] = set()     # every tagged concept name (prefix-free)
        self._context: Optional[dict] = None
        self._unit: Optional[str] = None
        self._fact: Optional[dict] = None
        self._fact_depth = 0                 # tags opened inside the current fact
        self._capture: Optional[str] = None  # what _text is collecting: "end" | "measure" | "fact"
        self._text: Optional[list[str]] = None
        self._recent = ""                    # the last few hundred characters of text: a fact's table row

    def handle_starttag(self, tag, attrs):
        if self._fact is not None:
            self._fact_depth += 1
            return
        local = tag.rsplit(":", 1)[-1]
        attrs = dict(attrs)
        if local == "context":
            self._context = {"id": attrs.get("id", ""), "end": "", "dimensional": False, "members": []}
        elif local == "unit":
            self._unit = attrs.get("id", "")
        elif self._context is not None and local in ("explicitmember", "typedmember"):
            self._context["dimensional"] = True
            dimension = attrs.get("dimension", "").rsplit(":", 1)[-1]
            self.dimensions.add(dimension)
            self._context["members"].append([dimension, ""])
            if local == "explicitmember":
                self._capture, self._text = "member", []
        elif self._context is not None and local in ("enddate", "instant"):
            self._capture, self._text = "end", []
        elif self._unit is not None and local == "measure":
            self._capture, self._text = "measure", []
        elif local in ("nonfraction", "nonnumeric"):
            concept = attrs.get("name", "").rsplit(":", 1)[-1]
            self.concepts.add(concept)
            if (local == "nonfraction" and concept in _READ_CONCEPTS) or (
                    local == "nonnumeric" and concept in people.SIGNATORY_CONCEPTS):
                self._start_fact(concept, attrs)

    def _start_fact(self, concept: str, attrs: dict) -> None:
        self._fact = {
            "concept": concept,
            "context": attrs.get("contextref", ""),
            "unit": attrs.get("unitref", ""),
            "scale": attrs.get("scale", "0"),
            "sign": attrs.get("sign", ""),
            "format": attrs.get("format", ""),
            "before": self._recent,          # its row label, to check an FX tag is on an FX line
        }
        self._fact_depth = 0
        self._capture, self._text = "fact", []

    def handle_endtag(self, tag):
        if self._fact is not None:
            if self._fact_depth:
                self._fact_depth -= 1
                return
            self._fact["text"] = "".join(self._text or [])
            self.facts.append(self._fact)
            self._fact, self._capture, self._text = None, None, None
            return
        local = tag.rsplit(":", 1)[-1]
        if local == "explicitmember" and self._capture == "member" and self._context is not None:
            self._context["members"][-1][1] = "".join(self._text or []).strip().rsplit(":", 1)[-1]
            self._capture, self._text = None, None
        elif local in ("enddate", "instant") and self._capture == "end" and self._context is not None:
            self._context["end"] = "".join(self._text or []).strip()[:10]
            self._capture, self._text = None, None
        elif local == "measure" and self._capture == "measure":
            if self._unit is not None:
                self.units.setdefault(self._unit, "".join(self._text or []).strip())
            self._capture, self._text = None, None
        elif local == "context" and self._context is not None:
            self.contexts[self._context["id"]] = self._context
            self._context = None
        elif local == "unit":
            self._unit = None

    def handle_data(self, data):
        if self._text is not None:
            self._text.append(data)
        if data.strip():
            self._recent = (self._recent + " " + " ".join(data.split()))[-400:]


def _fact_value(fact: dict) -> Optional[float]:
    """A tagged figure's value: displayed number x 10^scale, sign applied. None if unreadable."""
    text = (fact.get("text") or "").strip()
    fmt = (fact.get("format") or "").lower()
    if any(z in fmt for z in _ZERO_FORMATS) or text in ("-", "–", "—"):
        number = 0.0
    else:
        for space in (" ", " ", " "):
            text = text.replace(space, "")
        if any(f in fmt for f in _COMMA_DECIMAL_FORMATS):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
        cleaned = re.sub(r"[^0-9.]", "", text)
        if not cleaned or cleaned.count(".") > 1:
            return None
        number = float(cleaned)
    try:
        scale = int(fact.get("scale") or 0)
    except ValueError:
        scale = 0
    value = number * 10 ** scale
    return -value if fact.get("sign") == "-" else value


def _by_period(scanner: "_IxbrlScanner", concepts: set[str], allow_negative: bool) -> dict[str, float]:
    """{period end: value} of the whole-company GBP facts for any of `concepts`."""
    values: dict[str, float] = {}
    for fact in scanner.facts:
        if fact["concept"] not in concepts:
            continue
        context = scanner.contexts.get(fact["context"])
        if not context or context["dimensional"] or not context["end"]:
            continue  # unknown period, or a breakdown (by region, segment…) rather than the total
        measure = scanner.units.get(fact["unit"], fact["unit"])
        if not measure.upper().endswith("GBP"):
            continue
        value = _fact_value(fact)
        if value is None or (value < 0 and not allow_negative):
            continue
        values.setdefault(context["end"], value)
    return values


def _latest(scanner: "_IxbrlScanner", concepts: set[str], allow_negative: bool) -> Optional[tuple[float, str]]:
    """(value, period end) of the latest whole-company GBP fact for any of `concepts`."""
    values = _by_period(scanner, concepts, allow_negative)
    if not values:
        return None
    end = max(values)
    return values[end], end


def _prior(scanner: "_IxbrlScanner", concepts: set[str], allow_negative: bool, before: str) -> Optional[float]:
    """The value for the latest period ending at least ~10 months before `before` (last year's figure)."""
    values = _by_period(scanner, concepts, allow_negative)
    earlier = [end for end in values if end and before and end <= _months_before(before, 10)]
    return values[max(earlier)] if earlier else None


def _months_before(iso: str, months: int) -> str:
    year, month = int(iso[:4]), int(iso[5:7]) - months
    while month < 1:
        year, month = year - 1, month + 12
    return f"{year:04d}-{month:02d}{iso[7:10]}"


def _is_uk_member(member: str) -> bool:
    m = member.upper()
    return m.startswith(_UK_MEMBERS) or m == "UK" or (m.startswith("UK") and not m.startswith("UKRAINE"))


def _turnover_by_member(scanner: "_IxbrlScanner", period_end: str) -> list[tuple[str, float]]:
    """(member, value) for turnover tagged against one country/region member for `period_end`."""
    found = []
    for fact in scanner.facts:
        context = scanner.contexts.get(fact["context"])
        if fact["concept"] not in TURNOVER_CONCEPTS or not context or context["end"] != period_end:
            continue
        members = context.get("members") or []
        if len(members) != 1 or not any(k in members[0][0] for k in ("Geographic", "CountriesRegions")) or not members[0][1]:
            continue
        value = _fact_value(fact)
        if value is not None and value >= 0:
            found.append((members[0][1], value))
    return found


def _overseas_share(scanner: "_IxbrlScanner", turnover: Optional[float], period_end: str) -> Optional[float]:
    """
    Share of turnover from outside the UK, from turnover broken down by
    country/region for the latest period — only when the parts add up to
    the total (within 20%), so overlapping regions can't mislead.
    """
    if not turnover or not period_end:
        return None
    uk = abroad = 0.0
    for member, value in _turnover_by_member(scanner, period_end):
        if _is_uk_member(member):
            uk += value
        else:
            abroad += value
    total = uk + abroad
    if not total or not 0.8 * turnover <= total <= 1.2 * turnover:
        return None
    return abroad / total


def _region_label(member: str) -> str:
    """"NorthAmericaMember" -> "North America", "RestWorld" -> "Rest of world"."""
    name = re.sub(r"Member$", "", member.split(":")[-1])
    words = re.findall(r"[A-Z][a-z]+|[A-Z]+(?![a-z])|\d+", name) or [name]
    label = " ".join(words)
    return {"Rest World": "Rest of world", "Rest Of World": "Rest of world", "Rest Europe": "Rest of Europe",
            "United States America": "United States", "U K": "UK"}.get(label, label)


def _regions(scanner: "_IxbrlScanner", turnover: Optional[float], period_end: str) -> list[dict]:
    """[{"region", "value"}]: turnover tagged by country/region for the latest period, biggest first."""
    if not period_end:   # no whole-company figure tagged: the latest period any regional turnover is tagged for
        period_end = max((c["end"] for c in scanner.contexts.values() if c.get("members")), default="")
    found: dict[str, float] = {}
    for member, value in _turnover_by_member(scanner, period_end):
        if value <= 0 or (turnover and value > turnover * 1.01):
            continue
        label = _region_label(member)
        found[label] = max(found.get(label, 0.0), value)
    return sorted(({"region": k, "value": v} for k, v in found.items()), key=lambda r: -r["value"])


# An FX gain/loss bigger than this share of turnover is almost certainly a
# different figure tagged or read as FX (Wanis: purchases in foreign currency,
# £113m on £156m turnover). It goes to fx_gain_loss_check, never into a fact.
FX_MAX_SHARE_OF_TURNOVER = 0.20


def _gbp_short(value: float) -> str:
    a = abs(value)
    text = f"£{a / 1e6:.1f}m" if a >= 1e6 else f"£{a / 1e3:.0f}k" if a >= 1e3 else f"£{a:.0f}"
    return ("-" if value < 0 else "") + text


def _screen_fx_tags(scanner: "_IxbrlScanner") -> str:
    """
    Drop FX gain/loss tags that aren't on an FX line (Wanis: "Stocks
    recognised as expenses" tagged as FX) or sit under a $ / € table heading
    (Weston Importers: tagged GBP, headed $'000). Returns why, for the check
    column when the accounts text has no FX line either; "" when all are fine.
    """
    kept, why = [], ""
    for fact in scanner.facts:
        if fact["concept"] in FX_GAIN_LOSS_CONCEPTS:
            before = fact.get("before", "")
            value = _fact_value(fact)
            shown = _gbp_short(value) if value is not None else fact.get("text", "")
            row = fx_text.row_label(before)[-80:]
            if not fx_text.label_is_fx(before):
                why = why or f'the figure tagged as FX ({shown}) is on the line "{row}"; check the accounts'
                continue
            currency = fx_text.foreign_heading(before)
            if currency:
                why = why or f"the FX figure ({shown}) is in a table headed {currency}, not pounds; check the accounts"
                continue
        kept.append(fact)
    scanner.facts = kept
    return why


def _fx_from_text(facts: dict, text: str, how: str, ocr: bool = False) -> bool:
    """Fill the FX fields from an FX line in accounts text; True when a line was found (a figure or a check)."""
    found = fx_text.read(text, ocr=ocr)
    if not found:
        return False
    if found["check"]:
        facts["fx_gain_loss_check"] = found["check"]
        return True
    facts.update(fx_gain_loss=found["value"], fx_gain_loss_prior=found["prior"],
                 fx_gain_loss_evidence=f'{how}: "{found["line"]}"')
    return True


def check_fx(facts: dict) -> dict:
    """
    Sanity checks on the FX gain/loss just read. A figure that fails moves to
    fx_gain_loss_check (a sentence saying why) and fx_gain_loss / _prior are
    cleared, so no hook, signal or opener states it as a fact.
    """
    facts.setdefault("fx_gain_loss_check", "")
    facts.setdefault("fx_gain_loss_evidence", "")
    fx, prior, turnover = facts.get("fx_gain_loss"), facts.get("fx_gain_loss_prior"), facts.get("turnover")
    reason = ""
    if fx is not None and turnover and abs(fx) > FX_MAX_SHARE_OF_TURNOVER * turnover:
        reason = (f"FX figure {_gbp_short(fx)} is {abs(fx) / turnover:.0%} of turnover: too big for an exchange "
                  f"gain/loss, likely another figure tagged as FX; check the accounts")
    elif prior is not None and turnover and abs(prior) > FX_MAX_SHARE_OF_TURNOVER * turnover:
        reason = (f"last year's FX figure {_gbp_short(prior)} is {abs(prior) / turnover:.0%} of turnover: "
                  f"likely another figure tagged as FX; check the accounts")
    if reason:
        facts.update(fx_gain_loss=None, fx_gain_loss_prior=None, fx_gain_loss_evidence="", fx_gain_loss_check=reason)
    return facts


def extract_facts(document: bytes) -> dict:
    """
    What an iXBRL accounts document says about size and currency exposure:
      turnover, period_end      latest whole-company turnover in GBP (None if not tagged)
      fx_gain_loss              latest foreign-exchange gain (+) / loss (-) in GBP, or None
      currency_breakdown        figures broken down by currency
      geographic_breakdown      figures broken down by country / region
      hedging_disclosed         derivatives / hedging / forward contracts tagged
      cost_of_sales             latest whole-company cost of sales in GBP, or None
      bankers                   banks named under "Bankers" on the company-information page
      fx_gain_loss_prior        last year's FX gain/loss, or None
      turnover_prior            last year's turnover, or None
      overseas_share            share of turnover from outside the UK (0-1), or None
      cash, bank_borrowings, net_assets   latest balance-sheet figures in GBP, or None
      auditor, auditor_tier     the audit firm named in the accounts and its tier
      finance_people            [{"name", "title"}] named with a finance title
      signatory                 the director who signed the accounts, or ""
    """
    scanner = _IxbrlScanner()
    text = document.decode("utf-8", errors="replace")
    try:
        scanner.feed(text)
        scanner.close()
    except Exception:  # noqa: BLE001 — a malformed tail shouldn't lose facts already read
        pass
    turnover = _latest(scanner, TURNOVER_CONCEPTS, allow_negative=False)
    fx_tag_problem = _screen_fx_tags(scanner)
    fx = _latest(scanner, FX_GAIN_LOSS_CONCEPTS, allow_negative=True)
    cost = _latest(scanner, COST_OF_SALES_CONCEPTS, allow_negative=True)  # some filings tag it as a negative
    plain = html.unescape(re.sub(r"<[^>]*>", " ", text))
    end = turnover[1] if turnover else (fx[1] if fx else "")
    cash = _latest(scanner, CASH_CONCEPTS, allow_negative=False)
    debt = _latest(scanner, BORROWING_CONCEPTS, allow_negative=True)
    net = _latest(scanner, NET_ASSETS_CONCEPTS, allow_negative=True)
    auditor = auditor_from_text(plain)
    tagged_signatory = next((" ".join(f["text"].split()) for f in scanner.facts
                             if f["concept"] in people.SIGNATORY_CONCEPTS and f.get("text", "").strip()), "")
    facts = {
        "turnover": turnover[0] if turnover else None,
        "period_end": end,
        "fx_gain_loss": fx[0] if fx else None,
        "currency_breakdown": any("Currenc" in d for d in scanner.dimensions),
        "geographic_breakdown": any(k in d for d in scanner.dimensions for k in ("Geographic", "CountriesRegions")),
        "hedging_disclosed": any(w in c for c in scanner.concepts for w in _HEDGING_WORDS),
        "cost_of_sales": abs(cost[0]) if cost else None,
        "bankers": banks.bankers_from_text(plain),
        "fx_gain_loss_prior": _prior(scanner, FX_GAIN_LOSS_CONCEPTS, True, fx[1]) if fx else None,
        "turnover_prior": _prior(scanner, TURNOVER_CONCEPTS, False, turnover[1]) if turnover else None,
        "overseas_share": _overseas_share(scanner, turnover[0] if turnover else None, end),
        "cash": cash[0] if cash else None,
        "bank_borrowings": abs(debt[0]) if debt else None,
        "net_assets": net[0] if net else None,
        "auditor": auditor[0] if auditor else "",
        "auditor_tier": auditor[1] if auditor else "",
        "finance_people": people.finance_people(plain),
        "signatory": tagged_signatory or people.signatory_from_text(plain),
        "fx_risk_disclosed": bool(FX_RISK_RE.search(plain)),
        "web_addresses": website.addresses_in_text(plain),
        "qualified": people.qualified_people(plain),
        "regions": _regions(scanner, turnover[0] if turnover else None, end),
        "trading_names": profiles.trading_names(plain),
        **hooks.text_evidence(plain),
        **incumbent.text_evidence(plain),
        "fx_gain_loss_evidence": "tagged in the accounts" if fx else "",
        "fx_gain_loss_check": "",
    }
    if not fx and not _fx_from_text(facts, plain, "accounts text") and fx_tag_problem:
        facts["fx_gain_loss_check"] = fx_tag_problem
    return check_fx(facts)


# Audit firms by tier — the tier hints at how sophisticated the finance function
# is, and the firm is a possible introducer.
_AUDITOR_TIERS: list[tuple[str, str, str]] = [
    ("DELOITTE", "Deloitte", "Big Four"), ("PRICEWATERHOUSECOOPERS", "PwC", "Big Four"), ("PWC", "PwC", "Big Four"),
    ("KPMG", "KPMG", "Big Four"), ("ERNST & YOUNG", "EY", "Big Four"), ("ERNST AND YOUNG", "EY", "Big Four"),
    ("BDO", "BDO", "mid-tier"), ("GRANT THORNTON", "Grant Thornton", "mid-tier"), ("RSM", "RSM", "mid-tier"),
    ("MAZARS", "Forvis Mazars", "mid-tier"), ("CROWE", "Crowe", "mid-tier"), ("PKF", "PKF", "mid-tier"),
    ("MOORE", "Moore", "mid-tier"), ("SAFFERY", "Saffery", "mid-tier"), ("AZETS", "Azets", "mid-tier"),
    ("MHA", "MHA", "mid-tier"), ("HAYSMACINTYRE", "Haysmacintyre", "mid-tier"), ("BUZZACOTT", "Buzzacott", "mid-tier"),
    ("KRESTON", "Kreston Reeves", "mid-tier"), ("MENZIES", "Menzies", "mid-tier"), ("BISHOP FLEMING", "Bishop Fleming", "mid-tier"),
    ("HAZLEWOODS", "Hazlewoods", "mid-tier"), ("PRICE BAILEY", "Price Bailey", "mid-tier"), ("EVELYN", "Evelyn Partners", "mid-tier"),
    ("SMITH & WILLIAMSON", "Evelyn Partners", "mid-tier"), ("COOPER PARRY", "Cooper Parry", "mid-tier"),
    ("UHY", "UHY Hacker Young", "mid-tier"), ("FRANCIS CLARK", "Francis Clark", "mid-tier"),
    ("ALBERT GOODMAN", "Albert Goodman", "mid-tier"), ("BLICK ROTHENBERG", "Blick Rothenberg", "mid-tier"),
    ("JEFFREYS HENRY", "Jeffreys Henry", "mid-tier"), ("LUBBOCK FINE", "Lubbock Fine", "mid-tier"),
    ("SHAW GIBBS", "Shaw Gibbs", "mid-tier"), ("GRAVITA", "Gravita", "mid-tier"),
]
# "Auditors  Smith & Co LLP  Chartered Accountants ..." — heading case, capitalised name after it.
_AUDITORS_RE = re.compile(r"\b(?:(?:Statutory|Independent|STATUTORY|INDEPENDENT)\s+)?(?:Auditors?|AUDITORS?)\b[\s:–-]{1,12}(?=[A-Z])")
_FIRM_RE = re.compile(r"^((?:[A-Z][\w&.'’-]*,?\s+){0,5}?(?:LLP|Limited|Ltd|LIMITED|Audit\s+LLP|& Co))\b")

_NOT_FIRM_WORDS = {"TO", "THE", "OF", "MEMBERS", "REPORT", "RESPONSIBILITIES", "OPINION", "COMPANY"}


def auditor_from_text(text: str) -> Optional[tuple[str, str]]:
    """(audit firm, tier) named after an "Auditors" heading in accounts text, or None."""
    for m in _AUDITORS_RE.finditer(text):
        window = " ".join(text[m.end():m.end() + 80].split())
        upper = window.upper()
        hits = [(upper.find(k), name, tier) for k, name, tier in _AUDITOR_TIERS if re.search(rf"\b{re.escape(k)}\b", upper)]
        if hits:
            _, name, tier = min(hits)
            return name, tier
        firm = _FIRM_RE.match(window)
        if firm and not set(firm.group(1).upper().replace(",", " ").split()) & _NOT_FIRM_WORDS:
            return firm.group(1).strip(), "independent"
    return None


def extract_turnover(document: bytes) -> Optional[dict]:
    """{"turnover": GBP, "period_end": "yyyy-mm-dd"} from an iXBRL document, or None if not tagged in GBP."""
    facts = extract_facts(document)
    if facts["turnover"] is None:
        return None
    return {"turnover": facts["turnover"], "period_end": facts["period_end"]}


def facts_from_latest_accounts(company_number: str, api_key: str) -> Optional[dict]:
    """
    extract_facts() for the company's latest annual accounts — from the
    tagged iXBRL version where there is one, else from the PDF's text
    (extract_facts_from_text) when the PDF tools are installed. None when
    nothing could be read. facts["format"] says which: "ixbrl", "pdf",
    "scanned pdf".
    """
    filing = latest_accounts_filing(company_number, api_key)
    if not filing:
        return None
    metadata_url = (filing.get("links") or {}).get("document_metadata") or ""
    document_id = metadata_url.rstrip("/").rsplit("/", 1)[-1]
    if not document_id:
        return None
    filed_on = filing.get("date") or ""   # for the "accounts just filed" hook
    made_up = (filing.get("description_values") or {}).get("made_up_date") or ""
    document = None if filing.get("paper_filed") else fetch_ixbrl(document_id, api_key)
    if document:
        facts = dict(extract_facts(document), format="ixbrl", filed_on=filed_on)
        facts["period_end"] = facts["period_end"] or made_up   # no tagged turnover or FX: the filing's made-up date
        return facts
    if not pdf.available():
        return None
    data = fetch_pdf(document_id, api_key) or b""
    text, how = pdf.to_text(data)
    if not text:
        return None
    facts = dict(extract_facts_from_text(text, made_up, how), filed_on=filed_on)
    if how == "scanned pdf" and facts["fx_gain_loss"] is None and not facts["fx_gain_loss_check"]:
        # the FX line is in the notes, past the pages OCR'd for the company information
        page, number = pdf.ocr_find(data, lambda t: fx_text.read(t) is not None)
        if page and _fx_from_text(facts, page, f"scanned accounts p{number}", ocr=True):
            check_fx(facts)
    return facts


# --- Accounts as plain text (PDF / OCR) --------------------------------------

_MONTH_NUMBERS = {m: i for i, m in enumerate(
    ("january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
     "november", "december"), 1)}
_PERIOD_RE = re.compile(r"(?:year|period)\s+ended\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})", re.I)
# 45,123 / (1,234) / 45123 / 45.6 (in £m tables). Note numbers ("3") don't match.
_AMOUNT_RE = re.compile(r"\(?-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\)?|\(?-?\d{4,}(?:\.\d+)?\)?|\(?-?\d{1,3}\.\d{1,2}\)?")
_THOUSANDS_RE = re.compile(r"£\s*['’`]?\s*000|£\s*k\b|£\s*thousands?", re.I)
_MILLIONS_RE = re.compile(r"£\s*['’`]?\s*m\b|£\s*millions?", re.I)
_OTHER_CURRENCY_RE = re.compile(r"(?:€|US\$|\$\s*['’`]?000|EUR\s*['’`]?000|USD\s*['’`]?000)")
FX_RISK_RE = re.compile(r"foreign (?:exchange|currency) risk|currency risk|exchange rate risk|"
                        r"exposure to (?:foreign )?(?:exchange|currency)", re.I)
_TEXT_HEDGING_RE = re.compile(r"forward (?:foreign )?(?:exchange|currency) contracts?|hedg(?:e|es|ing)\b|"
                              r"derivative financial instruments", re.I)


def _amount(token: str) -> Optional[float]:
    negative = token.startswith("(") or token.startswith("-")
    digits = re.sub(r"[^\d.]", "", token)
    try:
        value = float(digits)
    except ValueError:
        return None
    return -value if negative else value


def _line_amounts(pages: list[str], label: str) -> Optional[tuple[float, Optional[float]]]:
    """
    (this year, last year) in £ from the first table row starting with
    `label` ("Turnover   3   45,123   41,000"): note numbers skipped, the
    page's "£'000" / "£m" heading applied, rows on non-sterling pages and
    prose sentences ignored.
    """
    row_re = re.compile(rf"^\s*{label}\b(.*)$", re.I | re.M)
    for page in pages:
        if _OTHER_CURRENCY_RE.search(page) and "£" not in page:
            continue
        scale = 1_000 if _THOUSANDS_RE.search(page) else 1_000_000 if _MILLIONS_RE.search(page) else 1
        for m in row_re.finditer(page):
            rest = m.group(1)
            if len(re.findall(r"[A-Za-z]{3,}", rest)) > 3:
                continue  # a sentence ("Turnover increased by ..."), not a table row
            tokens = [t for t in _AMOUNT_RE.findall(rest) if not re.fullmatch(r"(?:19[9]\d|20[0-4]\d)", t)]  # not years
            amounts = [a for a in (_amount(t) for t in tokens) if a is not None]
            if not amounts:
                continue
            current = amounts[0] * scale
            prior = amounts[1] * scale if len(amounts) > 1 else None
            return current, prior
    return None


def _period_end(text: str) -> str:
    m = _PERIOD_RE.search(text)
    if not m or m.group(2).lower() not in _MONTH_NUMBERS:
        return ""
    return f"{int(m.group(3)):04d}-{_MONTH_NUMBERS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"


_GEOGRAPHY_HEADING = re.compile(r"geographic(?:al)?\s+(?:market|area|analysis|segment|location|split)|"
                                r"by\s+(?:geographical\s+)?destination|by\s+geograph", re.I)
_REGION_ROW = re.compile(
    r"^\s*(United\s+Kingdom|UK|Europe(?:an\s+Union)?|Rest\s+of\s+(?:the\s+)?(?:world|Europe)|North\s+America|"
    r"United\s+States(?:\s+of\s+America)?|USA|Americas|Asia(?:\s+Pacific)?|Far\s+East|Middle\s+East|Africa|"
    r"Australasia|Overseas|Ireland|Republic\s+of\s+Ireland|Germany|France|Netherlands|Spain|Italy|China|Japan|"
    r"Canada|Australia)\b(.*)$", re.I | re.M)


_CELL_RE = re.compile(r"\(?-?\d[\d,]*(?:\.\d+)?\)?")   # any number in a table cell, "856" included


def _regions_from_text(pages: list[str], turnover: Optional[float] = None) -> list[dict]:
    """
    [{"region", "value"}] from a turnover-by-geography table in accounts text
    (the rows under a "geographical market" heading), this year's column,
    the page's "£'000" heading applied. [] when there's no such table.
    """
    for page in pages:
        heading = _GEOGRAPHY_HEADING.search(page)
        if not heading or (_OTHER_CURRENCY_RE.search(page) and "£" not in page):
            continue
        scale = 1_000 if _THOUSANDS_RE.search(page) else 1_000_000 if _MILLIONS_RE.search(page) else 1
        block = "\n".join(page[heading.end():].split("\n")[:40])
        found: dict[str, float] = {}
        for m in _REGION_ROW.finditer(block):
            rest = m.group(2)
            if re.search(r"[A-Za-z]{3,}", rest):
                continue  # words after the place ("United Kingdom corporation tax"): not a turnover row
            tokens = [t for t in _CELL_RE.findall(rest) if not re.fullmatch(r"(?:19[9]\d|20[0-4]\d)", t)]
            amounts = [a for a in (_amount(t) for t in tokens) if a is not None and a > 0]
            label = " ".join(m.group(1).split())
            if amounts and label not in found:
                found[label] = amounts[0] * scale
        # Only with turnover known, and never a region bigger than the company (a misread scale or column).
        if found and turnover and max(found.values()) <= turnover * 1.01:
            return sorted(({"region": k, "value": v} for k, v in found.items()), key=lambda r: -r["value"])
    return []


def extract_facts_from_text(text: str, made_up_date: str = "", how: str = "pdf") -> dict:
    """
    The extract_facts() fields that can be read from accounts text: turnover
    and last year's (first "Turnover"/"Revenue" table row), cost of sales,
    cash, net assets, bankers, auditor, finance people, signatory, hedging
    and FX-risk wording. Tagged-only fields (regional splits) are None/False;
    the FX gain/loss comes from its line in the notes (sourcer/fx_text.py).
    A turnover under £100k is treated as a misread.
    """
    pages = text.split("\f")
    turnover = _line_amounts(pages, r"(?:Turnover|Revenue)")
    if turnover and abs(turnover[0]) < 100_000:
        turnover = None
    cost = _line_amounts(pages, r"Cost\s+of\s+sales")
    cash = _line_amounts(pages, r"Cash\s+at\s+bank(?:\s+and\s+in\s+hand)?")
    net = _line_amounts(pages, r"Net\s+assets")
    plain = " ".join(text.split())
    auditor = auditor_from_text(plain)
    facts = {
        "turnover": abs(turnover[0]) if turnover else None,
        "period_end": made_up_date or _period_end(plain),
        "fx_gain_loss": None,
        "currency_breakdown": False,
        "geographic_breakdown": False,
        "hedging_disclosed": bool(_TEXT_HEDGING_RE.search(plain)),
        "fx_risk_disclosed": bool(FX_RISK_RE.search(plain)),
        "cost_of_sales": abs(cost[0]) if cost else None,
        "bankers": banks.bankers_from_text(plain),
        "fx_gain_loss_prior": None,
        "turnover_prior": abs(turnover[1]) if turnover and turnover[1] else None,
        "overseas_share": None,
        "cash": abs(cash[0]) if cash else None,
        "bank_borrowings": None,
        "net_assets": net[0] if net else None,
        "auditor": auditor[0] if auditor else "",
        "auditor_tier": auditor[1] if auditor else "",
        "finance_people": people.finance_people(text),
        "signatory": people.signatory_from_text(text),
        "web_addresses": website.addresses_in_text(plain),
        "qualified": people.qualified_people(text),
        "regions": _regions_from_text(pages, abs(turnover[0]) if turnover else None),
        "trading_names": profiles.trading_names(plain),
        **hooks.text_evidence(plain),
        **incumbent.text_evidence(plain),
        "format": how,
        "fx_gain_loss_check": "",
        "fx_gain_loss_evidence": "",
    }
    for number, page in enumerate(pages, 1):
        if _fx_from_text(facts, page, f"{'scanned ' if how == 'scanned pdf' else ''}accounts p{number}",
                         ocr=how == "scanned pdf"):
            break
    return check_fx(facts)


def turnover_from_latest_accounts(company_number: str, api_key: str) -> Optional[dict]:
    """{"turnover", "period_end"} from the latest annual accounts, or None."""
    facts = facts_from_latest_accounts(company_number, api_key)
    if not facts or facts["turnover"] is None:
        return None
    return {"turnover": facts["turnover"], "period_end": facts["period_end"]}
