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
import os
import re
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from typing import Optional

from sourcer import turnover_text, banks, companies_house, fx_notes, fx_text, hooks, incumbent, pdf, people, profiles, website

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


def filing_document_url(company_number: str, filing: dict) -> str:
    """The filed accounts as a PDF on the public Companies House site (every filing has one), or ""."""
    path = (filing.get("links") or {}).get("self") or ""
    if not path and filing.get("transaction_id"):
        path = f"/company/{company_number}/filing-history/{filing['transaction_id']}"
    page = companies_house.public_url(path)
    return f"{page}/document?format=pdf&download=0" if page else ""


def accounts_links(company_number: str, facts: Optional[dict]) -> dict:
    """
    {"accounts_url", "fx_gain_loss_url"}: the accounts document the facts
    came from (accounts read before links were kept: the company's accounts
    filings on Companies House), and the FX line's page in it when the
    figure came from a PDF page ("scanned accounts p22").
    """
    f = facts or {}
    url = f.get("accounts_url") or (
        f"{companies_house.FIND_URL}/company/{company_number}/filing-history?category=accounts" if company_number else "")
    fx_url = ""
    if f.get("fx_gain_loss") is not None or f.get("fx_gain_loss_check"):
        page = re.match(r"(?:scanned )?accounts p(\d+):", f.get("fx_gain_loss_evidence") or "")
        fx_url = f"{url}#page={page.group(1)}" if page and f.get("accounts_url") else url
    return {"accounts_url": url, "fx_gain_loss_url": fx_url}


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
# Size clues that even filleted accounts (no profit and loss account) carry: money owed by customers and staff.
TRADE_DEBTORS_CONCEPTS = {"TradeDebtorsTradeReceivables", "TradeReceivables", "TradeReceivablesCurrent"}
EMPLOYEE_CONCEPTS = {"AverageNumberEmployeesDuringPeriod", "AverageNumberOfEmployees"}
_READ_CONCEPTS = (TURNOVER_CONCEPTS | FX_GAIN_LOSS_CONCEPTS | COST_OF_SALES_CONCEPTS | CASH_CONCEPTS
                  | BORROWING_CONCEPTS | NET_ASSETS_CONCEPTS | TRADE_DEBTORS_CONCEPTS | EMPLOYEE_CONCEPTS)
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


# Group accounts tag the group's figures with GroupCompanyDataDimension = Consolidated (the parent's own with another
# member): the whole entity, not a breakdown. Any other dimension (region, segment, currency) is a breakdown.
_ENTITY_DIMENSIONS = {"GroupCompanyDataDimension", "ConsolidatedGroupCompanyDimension"}


# Debtors are tagged "due within one year" / "after one year" in the notes: a maturity, not a breakdown of the entity.
_MATURITY_DIMENSIONS = {"MaturitiesOrExpirationPeriodsDimension"}


def _entity(context: dict, also: frozenset = frozenset()) -> Optional[str]:
    """ "group" / "company" for a whole-entity context ("" when it doesn't say), None for a breakdown. `also`:
    dimensions that don't split the entity for this figure (a debtor's maturity)."""
    if not context["dimensional"]:
        return ""
    members = [(d, m) for d, m in context["members"] if d not in also]
    if not context["members"]:
        return None
    if not members:
        return ""
    if any(d not in _ENTITY_DIMENSIONS for d, _ in members):
        return None
    member = " ".join(m for _, m in context["members"]).lower()
    return "group" if "consolidat" in member or "group" in member else "company"


def _by_period(scanner: "_IxbrlScanner", concepts: set[str], allow_negative: bool,
               basis: Optional[dict] = None, also: frozenset = frozenset()) -> dict[str, float]:
    """
    {period end: value} of the whole-entity GBP facts for any of `concepts`: the group's (consolidated) figure
    before an undimensioned one before the parent company's own. `basis`, if given, gets {period end: "group" /
    "company" / ""}.
    """
    best: dict[str, tuple[int, float, str]] = {}
    for fact in scanner.facts:
        if fact["concept"] not in concepts:
            continue
        context = scanner.contexts.get(fact["context"])
        if not context or not context["end"]:
            continue  # unknown period
        entity = _entity(context, also)
        if entity is None:
            continue  # a breakdown (by region, segment…) rather than the total
        measure = scanner.units.get(fact["unit"], fact["unit"])
        if not measure.upper().endswith("GBP"):
            continue
        value = _fact_value(fact)
        if value is None or (value < 0 and not allow_negative):
            continue
        rank = {"group": 0, "": 1, "company": 2}[entity]
        if context["end"] not in best or rank < best[context["end"]][0]:
            best[context["end"]] = (rank, value, entity)
    if basis is not None:
        basis.update({end: b[2] for end, b in best.items()})
    return {end: b[1] for end, b in best.items()}


def _latest(scanner: "_IxbrlScanner", concepts: set[str], allow_negative: bool,
            basis: Optional[dict] = None, also: frozenset = frozenset()) -> Optional[tuple[float, str]]:
    """(value, period end) of the latest whole-entity GBP fact for any of `concepts` (the group's when consolidated)."""
    values = _by_period(scanner, concepts, allow_negative, basis, also)
    if not values:
        return None
    end = max(values)
    return values[end], end


def _headcount(scanner: "_IxbrlScanner") -> Optional[int]:
    """
    The latest average number of employees tagged for the whole entity (a count: no currency), or None. The figure
    as shown, never scaled: filers tag headcounts with scale -2 or 3 by mistake (Exol's 104 read as 1, Manton Wood's
    1,072 as 1,072,000 — a third of the companies in the reader audit).
    """
    best: dict[str, tuple[int, float]] = {}
    for fact in scanner.facts:
        if fact["concept"] not in EMPLOYEE_CONCEPTS:
            continue
        context = scanner.contexts.get(fact["context"])
        entity = _entity(context) if context and context["end"] else None
        value = _fact_value({**fact, "scale": "0"})
        if entity is None or value is None or value < 0:
            continue
        rank = {"group": 0, "": 1, "company": 2}[entity]
        if context["end"] not in best or rank < best[context["end"]][0]:
            best[context["end"]] = (rank, value)
    return round(best[max(best)][1]) if best else None


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


_TOTAL_MEMBER = re.compile(r"Total|Unallocated|AllSegments|Elimination|Consolidat|Reconcil", re.I)


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
        if _TOTAL_MEMBER.search(members[0][1]):
            continue   # "TotalGeographicSegmentsIncludingAnyUnallocatedAmount": the whole, not a region
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


# Bump when what extract_facts / extract_facts_from_text read changes, so cached facts are read again.
FACTS_VERSION = "2026-11-06d"   # + headcounts as shown (never scaled); continuing/discontinued/total rows


# Scanned filings under this turnover (when known) don't get their currency notes OCR'd: they're out of the band.
OCR_NOTES_MIN_TURNOVER = float(os.environ.get("OCR_NOTES_MIN_TURNOVER", "25000000"))

# A scanned filing whose profit and loss page wasn't searched because the run's OCR time ran out.
TURNOVER_NOT_READ_YET = "turnover not read yet: this run's OCR time for scanned accounts was used up"


def facts_reusable(entry: dict) -> bool:
    """
    Whether cached facts were read with rules still current. Older facts are
    read again (main.py caps how many a run; until then the older facts
    are used, without the newer fields): "2026-11-05" added the currency
    notes (forward contracts, currencies, balances, sensitivity) and turnover
    by region from accounts text, which every filing can have.
    """
    facts = entry.get("facts") or {}
    if facts.get("turnover_check") == TURNOVER_NOT_READ_YET:
        return False
    return entry.get("facts_version") == FACTS_VERSION

# An FX gain/loss bigger than this share of turnover is almost certainly a
# different figure tagged or read as FX (Wanis: purchases in foreign currency,
# £113m on £156m turnover). It goes to fx_gain_loss_check, never into a fact.
FX_MAX_SHARE_OF_TURNOVER = 0.20
# An FX gain/loss under £1,000 at a £10m+ company is almost always a £'000 figure read (or tagged) as pounds: 113
# tagged and 163 read from text in the first year's FX filings scan (Lister Wilder "597", Greanco "(21)").
FX_MIN_PLAUSIBLE = 1_000
FX_MIN_PLAUSIBLE_TURNOVER = 10_000_000


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


def _fx_from_text(facts: dict, text: str, how: str, ocr: bool = False, thousands: bool = False) -> bool:
    """
    Fill the FX fields from an FX line in accounts text; True when a line was found (a figure or a check).
    `thousands`: the document's tagged figures are in £'000, so a line with no £ / £'000 heading near it is too
    (Greanco's "Foreign exchange differences (21) 7" in a £385m company is £21k, not £21).
    """
    found = fx_text.read(text, ocr=ocr)
    if not found:
        return False
    if found["check"]:
        facts["fx_gain_loss_check"] = found["check"]
        return True
    # only a figure under 1,000: there a £ reading is implausible for these companies (check_fx), while a bigger one
    # could be either (45,000 is £45k in a £ table, £45m in a £'000 one) and is left as written
    times = 1_000 if (thousands and not found.get("headed", True) and found["value"] is not None
                      and abs(found["value"]) < FX_MIN_PLAUSIBLE) else 1
    facts.update(fx_gain_loss=found["value"] * times if found["value"] is not None else None,
                 fx_gain_loss_prior=found["prior"] * times if found["prior"] is not None else None,
                 fx_gain_loss_evidence=f'{how}: "{found["line"]}"'
                 + (" (in £'000, as the accounts' tagged figures are)" if times > 1 else ""))
    return True


def _in_thousands(scanner) -> bool:
    """Most of the document's tagged money figures carry scale 3: the accounts are presented in £'000."""
    scales = [str(f.get("scale") or "0") for f in scanner.facts
              if f.get("unit") and not re.search(r"pure|shares?|employee|number|percent", f["unit"], re.I)
              and f.get("concept") not in EMPLOYEE_CONCEPTS]
    return len(scales) >= 5 and scales.count("3") / len(scales) >= 0.6


# Above this a turnover read from the text (or tagged by a company with under 1,000 staff) is a misread — a £'000
# figure taken as £m, cells run together (Eland Electrical read as £317,766bn) — never a size to use.
MAX_PLAUSIBLE_TURNOVER = 5_000_000_000
# Turnover per member of staff above this: the headcount is a holding company's own (Brooklyn Travel: £247m, 6 staff)
MAX_TURNOVER_PER_HEAD = 20_000_000
REGIONS_MAX_SHARE = 1.05   # regions adding to more than turnover +5% mix two tables (Industrial Chemicals: UK £177.4m of £177.3m, then the rest)

# Full, group and medium-sized accounts are for companies well past this; a turnover under it read from one is a
# misread (a £'000 table taken as £, a wrong cell) or a holding company's own few charges — never a size to use.
MIN_PLAUSIBLE_TURNOVER = 1_000_000
_FULL_ACCOUNTS = ("full", "group", "medium")


def check_turnover(facts: dict) -> dict:
    """
    A turnover of £0 or less, or under MIN_PLAUSIBLE_TURNOVER from full / group / medium accounts, moves to
    turnover_check ("check the accounts"), never a figure (Nisbets read as £354k, Caribbean Trading Group as £0).
    """
    turnover, kind = facts.get("turnover"), facts.get("accounts_type", "")
    if turnover is None:
        return facts
    staff = facts.get("employees") or 0
    if turnover > MAX_PLAUSIBLE_TURNOVER and ("tagged" not in (facts.get("turnover_source") or "") or 0 < staff < 1_000):
        facts.update(turnover=None, turnover_prior=None, turnover_check=(
            f"turnover read as {hooks.short(turnover)}: too big to be right (cells run together, or a £'000 figure "
            f"read as £m?); check the accounts"))
        return facts
    prior = facts.get("turnover_prior")
    if prior and not 1 / 20 <= turnover / prior <= 20:
        facts["turnover_prior"] = None   # over 20x apart: a note number or another cell read as last year's — no growth
    if turnover <= 0 or (turnover < MIN_PLAUSIBLE_TURNOVER and kind in _FULL_ACCOUNTS):
        where = f"{kind} accounts" if kind else "the accounts"
        facts.update(turnover=None, turnover_prior=None, turnover_check=(
            f"turnover nil in {where} (a holding company?)" if turnover <= 0 else
            f"turnover read as {hooks.short(turnover)} from {where}: too small to be right (a £'000 table or a "
            f"holding company's own figure?); check the accounts"))
    return facts


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
    if fx is not None and fx != 0 and abs(fx) < FX_MIN_PLAUSIBLE and turnover and turnover >= FX_MIN_PLAUSIBLE_TURNOVER:
        reason = (f"FX figure read as {_gbp_short(fx)} at a company with {_gbp_short(turnover)} turnover: probably in "
                  f"£'000 (or tagged without its scale); check the accounts")
    elif fx is not None and turnover and abs(fx) > FX_MAX_SHARE_OF_TURNOVER * turnover:
        reason = (f"FX figure {_gbp_short(fx)} is {abs(fx) / turnover:.0%} of turnover: too big for an exchange "
                  f"gain/loss, likely another figure tagged as FX; check the accounts")
    elif prior is not None and turnover and abs(prior) > FX_MAX_SHARE_OF_TURNOVER * turnover:
        reason = (f"last year's FX figure {_gbp_short(prior)} is {abs(prior) / turnover:.0%} of turnover: "
                  f"likely another figure tagged as FX; check the accounts")
    regions = sum(r.get("value") or 0 for r in facts.get("regions") or [])
    if turnover and regions > REGIONS_MAX_SHARE * turnover:   # regions adding to more than turnover: mixed
        facts.update(regions=[], overseas_share=None)
    if turnover and facts.get("fx_sensitivity"):   # a currency move's effect bigger than half of turnover: a misread
        facts["fx_sensitivity"] = [s for s in facts["fx_sensitivity"] if (s.get("amount") or 0) <= 0.5 * turnover]
    if reason:
        facts.update(fx_gain_loss=None, fx_gain_loss_prior=None, fx_gain_loss_evidence="", fx_gain_loss_check=reason)
    elif fx and prior and max(abs(fx), abs(prior)) / max(min(abs(fx), abs(prior)), 1) > 1_000:
        facts["fx_gain_loss_prior"] = None   # "Foreign exchange losses 699,158 5": a stray cell, not last year's
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
    turnover_basis: dict = {}
    turnover = _latest(scanner, TURNOVER_CONCEPTS, allow_negative=False, basis=turnover_basis)
    fx_tag_problem = _screen_fx_tags(scanner)
    fx = _latest(scanner, FX_GAIN_LOSS_CONCEPTS, allow_negative=True)
    cost = _latest(scanner, COST_OF_SALES_CONCEPTS, allow_negative=True)  # some filings tag it as a negative
    plain = html.unescape(re.sub(r"<[^>]*>", " ", text))
    end = turnover[1] if turnover else (fx[1] if fx else "")
    cash = _latest(scanner, CASH_CONCEPTS, allow_negative=False)
    debt = _latest(scanner, BORROWING_CONCEPTS, allow_negative=True)
    net = _latest(scanner, NET_ASSETS_CONCEPTS, allow_negative=True)
    trade_debtors = _latest(scanner, TRADE_DEBTORS_CONCEPTS, allow_negative=False, also=frozenset(_MATURITY_DIMENSIONS))
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
        "trade_debtors": trade_debtors[0] if trade_debtors else None,
        "employees": _headcount(scanner),
        "auditor": auditor[0] if auditor else "",
        "auditor_tier": auditor[1] if auditor else "",
        "finance_people": people.finance_people(plain),
        "signatory": tagged_signatory or people.signatory_from_text(plain),
        "fx_risk_disclosed": bool(FX_RISK_RE.search(plain)),
        "web_addresses": website.addresses_in_text(plain),
        "qualified": people.qualified_people(plain),
        "regions": _regions(scanner, turnover[0] if turnover else None, end),
        "regions_page": 0,
        "trading_names": profiles.trading_names(plain),
        **hooks.text_evidence(plain),
        **incumbent.text_evidence(plain),
        "fx_gain_loss_evidence": "tagged in the accounts" if fx else "",
        "fx_gain_loss_check": "",
    }
    # An FX tag under £1,000 with no scale, in accounts whose tagged figures are in £'000: the filer left the scale
    # off this one tag (Lister Wilder's "597" in a £'000 statement is £597k) — scaled like the rest, and said so.
    if fx and facts["fx_gain_loss"] and abs(facts["fx_gain_loss"]) < FX_MIN_PLAUSIBLE and _in_thousands(scanner) and any(
            f["concept"] in FX_GAIN_LOSS_CONCEPTS and str(f.get("scale") or "0") == "0"
            and (scanner.contexts.get(f["context"]) or {}).get("end") == fx[1] for f in scanner.facts):
        prior = facts["fx_gain_loss_prior"]
        facts.update(fx_gain_loss=facts["fx_gain_loss"] * 1_000,
                     fx_gain_loss_prior=prior * 1_000 if prior is not None and abs(prior) < FX_MIN_PLAUSIBLE else prior,
                     fx_gain_loss_evidence="tagged in the accounts (in £'000 like the rest of the accounts; the tag "
                                           "carried no scale)")
    rows_text = ixbrl_table_text(text)
    # the currency notes, from the document laid out as paragraphs and table rows (no page numbers in iXBRL)
    facts.update(fx_notes.read([rows_text], numbers=[0]))
    if turnover:
        facts.update(turnover_basis=turnover_basis.get(turnover[1], ""), turnover_unit="", turnover_page=0,
                     turnover_check="", turnover_source="tagged in the accounts (iXBRL)"
                     + (" — consolidated" if turnover_basis.get(turnover[1]) == "group" else ""))
    else:
        # Turnover not tagged (or tagged under another name): its row in the profit and loss table, else the
        # strategic report's sentence; why not when the statement starts at gross profit.
        pl = turnover_text.read_document(rows_text) or turnover_text.from_prose([plain])
        found = bool(pl and pl["turnover"] is not None)
        if found:
            facts.update(turnover=pl["turnover"], turnover_prior=pl["turnover_prior"],
                         period_end=facts["period_end"] or "")
            if facts["cost_of_sales"] is None and pl["cost_of_sales"] is not None:
                facts["cost_of_sales"] = pl["cost_of_sales"]
        facts.update(turnover_fields(pl, found, "ixbrl", plain))
    if not facts["regions"]:   # turnover by region not tagged: the note's table, as laid out
        facts["regions"] = regions_from_pages([rows_text], facts["turnover"], numbers=[0])[0]
        if facts["overseas_share"] is None:
            facts["overseas_share"] = overseas_share_from(facts["regions"], facts["turnover"])
    if not fx and not _fx_from_text(facts, plain, "accounts text", thousands=_in_thousands(scanner)) and fx_tag_problem:
        facts["fx_gain_loss_check"] = fx_tag_problem
    facts = check_fx(check_turnover(facts))
    if facts.get("employees") and facts.get("turnover") and facts["turnover"] / facts["employees"] > MAX_TURNOVER_PER_HEAD:
        facts["employees"] = None   # the holding company's own few staff beside the group's turnover, not the business's
    return facts


_HIDDEN_RE = re.compile(r"<ix:header\b.*?</ix:header>|<(script|style)\b.*?</\1>", re.I | re.S)


def ixbrl_table_text(document_text: str) -> str:
    """
    A tagged filing as layout-like text: one line per table row (cells
    separated by wide spaces), one per paragraph — so "Turnover  3  45,123
    41,000" reads as it does in a PDF.
    """
    t = _HIDDEN_RE.sub(" ", document_text)
    t = re.sub(r"</t[dh]\s*>", "    ", t, flags=re.I)
    t = re.sub(r"</tr\s*>|<br\s*/?>|</p\s*>|</div\s*>|</h\d\s*>|</li\s*>", "\n", t, flags=re.I)
    t = html.unescape(re.sub(r"<[^>]+>", "", t))
    lines = [line.strip() for line in re.sub(r"[ \t\u00a0]+", " ", t).split("\n") if line.strip()]
    # Tables laid out one cell per block ("<div>Turnover</div><div>3</div><div>43,423,259</div>…", or a <p> per
    # cell): a figure-only line joins the short label line before it, rebuilding "Turnover 3 43,423,259 42,553,761".
    out: list[str] = []
    for line in lines:
        figures_only = re.fullmatch(r"[£$€]?\s?[\d,.()\-–—%£$€' ]+", line) is not None
        if figures_only and out and len(out[-1].split()) <= 14 and not out[-1].endswith((".", ":")):
            out[-1] += "    " + line
        else:
            out.append(line)
    return "\n".join(out)


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
    kind = (filing.get("description") or "").replace("accounts-with-accounts-type-", "")
    url = filing_document_url(company_number, filing)
    made_up = (filing.get("description_values") or {}).get("made_up_date") or ""
    document = None if filing.get("paper_filed") else fetch_ixbrl(document_id, api_key)
    if document:
        facts = dict(extract_facts(document), format="ixbrl", filed_on=filed_on, accounts_url=url, accounts_type=kind)
        facts["period_end"] = facts["period_end"] or made_up   # no tagged turnover or FX: the filing's made-up date
        return check_turnover(facts)
    if not pdf.available():
        return None
    data = fetch_pdf(document_id, api_key) or b""
    text, how = pdf.to_text(data)
    if not text:
        return None
    facts = dict(extract_facts_from_text(text, made_up, how), filed_on=filed_on, accounts_url=url, accounts_type=kind)
    check_turnover(facts)
    ocr_pages: dict[int, str] = {}   # pages OCR'd below while looking for turnover and the FX line, kept for the notes
    if how == "scanned pdf" and (facts["turnover"] is None or "profit and loss account" not in facts.get("turnover_source", "")):
        # the profit and loss account is past the pages OCR'd for the company information (a strategic report's
        # sentence is kept only when the statement can't be found)
        page, number = pdf.ocr_find(data, lambda t: bool((r := turnover_text.read_page(t, ocr=True)) and (
            r["turnover"] is not None or r["check"])), purpose="pl", seen=ocr_pages)
        pl = turnover_text.read_page(page, number, ocr=True) if page else None
        # a page without its £'000 heading (lost to OCR): scaled by the turnover the first pages state, if any
        earlier = [facts["turnover"]] if facts.get("turnover") is not None else []
        pl = turnover_text.rescale(pl, earlier + [r["turnover"] for r in [turnover_text.from_prose(
            [ocr_pages[n] for n in sorted(ocr_pages)])] if r])
        if pl and pl["turnover"] is not None:
            facts.update(turnover=pl["turnover"], turnover_prior=pl["turnover_prior"],
                         **turnover_fields(pl, True, how))
            if pl["cost_of_sales"] is not None:
                facts["cost_of_sales"] = pl["cost_of_sales"]
            check_fx(facts)   # the FX figure's share of turnover can be checked now
        elif pl and pl["check"] and facts["turnover"] is None:
            facts.update(turnover_check=pl["check"], turnover_page=number)
        elif facts["turnover"] is None and not pdf.pl_budget_left():
            facts["turnover_check"] = TURNOVER_NOT_READ_YET   # read again next run, not cached as "not found"
    if how == "scanned pdf" and facts["fx_gain_loss"] is None and not facts["fx_gain_loss_check"]:
        # the FX line is in the notes, past the pages OCR'd for the company information
        page, number = pdf.ocr_find(data, lambda t: fx_text.read(t) is not None, seen=ocr_pages)
        if page and _fx_from_text(facts, page, f"scanned accounts p{number}", ocr=True):
            check_fx(facts)
    if how == "scanned pdf" and (facts["turnover"] is None or facts["turnover"] >= OCR_NOTES_MIN_TURNOVER):
        # the currency notes: their own pages (forward contracts, sensitivity, currency risk), until one names a
        # forward contract's size or a sensitivity, under their own OCR budget (pdf.notes_pages_order)
        def notes_found(page_text: str) -> bool:
            found = fx_notes.read([page_text])
            return bool(found["fx_forwards"] or found["fx_sensitivity"])
        pdf.ocr_find(data, notes_found, purpose="notes", seen=ocr_pages)
    if ocr_pages:
        # the currency notes and the turnover-by-region table, from the pages OCR'd for them, turnover and the FX line
        numbers = sorted(ocr_pages)
        fx_notes.merge(facts, fx_notes.read([ocr_pages[n] for n in numbers], numbers=numbers))
        # how they handle FX, FX providers and currencies named, on those pages too
        later = " ".join(" ".join(ocr_pages[n].split()) for n in numbers)
        more = {**incumbent.text_evidence(later), **hooks.text_evidence(later)}
        for key in ("fx_policy", "fx_providers", "facility_dates", "group_abroad"):
            if not facts.get(key) and more.get(key):
                facts[key] = more[key]
        facts["currency_mentions"] = (facts.get("currency_mentions") or []) + more["currency_mentions"]
        if not facts.get("regions"):
            facts["regions"], facts["regions_page"] = regions_from_pages(
                [ocr_pages[n] for n in numbers], facts["turnover"], numbers=numbers)
            facts["overseas_share"] = overseas_share_from(facts["regions"], facts["turnover"])
    return check_turnover(facts)


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


_GEOGRAPHY_HEADING = re.compile(r"geographic(?:al)?\s+(?:markets?|areas?|analysis|segments?|locations?|split|regions?|"
                                r"information)|by\s+(?:geographical\s+)?destination|by\s+geograph|"
                                r"(?:turnover|revenue|sales)\s+(?:is\s+)?(?:analysed\s+)?by\s+(?:country|region|market)\b|"
                                r"(?:turnover|revenue|sales)\s+by\s+(?:location\s+of\s+)?customers?", re.I)
_PLACE = (r"United\s+Kingdom|UK|Great\s+Britain|Europe(?:an\s+Union)?|EU|Non-EU|Eurozone|Rest\s+of\s+(?:the\s+)?"
          r"(?:world|Europe)|ROW|North\s+America|South\s+America|Latin\s+America|Central\s+America|"
          r"United\s+States(?:\s+of\s+America)?|USA|US|Americas|Asia(?:\s+Pacific)?|Asia\s+and\s+Pacific|APAC|"
          r"Far\s+East|Middle\s+East|Africa|Australasia|Oceania|Scandinavia|Nordics?|Overseas|Exports?|"
          r"Ireland|Republic\s+of\s+Ireland|Germany|France|Netherlands|Belgium|Spain|Italy|Switzerland|Sweden|"
          r"Norway|Denmark|Poland|China|Hong\s+Kong|Japan|India|Singapore|Canada|Australia|New\s+Zealand|"
          r"South\s+Africa|UAE|United\s+Arab\s+Emirates")
_REGION_ROW = re.compile(rf"^\s*((?:The\s+)?(?:{_PLACE})(?:\s*(?:&|and|/|,)\s*(?:the\s+)?(?:{_PLACE}))?)\b(.*)$",
                         re.I | re.M)


_CELL_RE = re.compile(r"\(?-?\d[\d,]*(?:\.\d+)?\)?")   # any number in a table cell, "856" included


def _scale_around(page: str, start: int, end: int) -> int:
    """The £'000 / £m heading for a table: in the table itself, else the nearest one above it (2,500 characters)."""
    inside = page[start:end]
    if _THOUSANDS_RE.search(inside) or _MILLIONS_RE.search(inside):
        return 1_000 if _THOUSANDS_RE.search(inside) else 1_000_000
    before = page[max(0, start - 2500):start]
    marks = [(m.end(), 1_000) for m in _THOUSANDS_RE.finditer(before)] + \
            [(m.end(), 1_000_000) for m in _MILLIONS_RE.finditer(before)]
    return max(marks)[1] if marks else 1


def regions_from_pages(pages: list[str], turnover: Optional[float] = None,
                       numbers: Optional[list[int]] = None) -> tuple[list[dict], int]:
    """
    ([{"region", "value"}], page number) from a turnover-by-geography table
    in accounts text (the rows under a "geographical market" heading), this
    year's column, the table's "£'000" / "£m" heading applied; ([], 0) when
    there's no such table. Only with turnover known, and never a region
    bigger than the company (a misread scale or column).
    """
    numbers = numbers if numbers is not None else list(range(1, len(pages) + 1))
    for page, number in zip(pages, numbers):
        if _OTHER_CURRENCY_RE.search(page) and "£" not in page:
            continue
        for heading in _GEOGRAPHY_HEADING.finditer(page):
            lines = page[heading.end():].split("\n")[:40]
            block = "\n".join(lines)
            scale = _scale_around(page, heading.start(), heading.end() + len(block))
            found: dict[str, float] = {}
            for m in _REGION_ROW.finditer(block):
                rest = re.sub(r"\([^)]*\)", " ", m.group(2))   # "Europe (excluding UK)  12,300"
                if re.search(r"[A-Za-z]{3,}", rest):
                    continue  # words after the place ("United Kingdom corporation tax"): not a turnover row
                tokens = [t for t in _CELL_RE.findall(rest) if not re.fullmatch(r"(?:19[9]\d|20[0-4]\d)", t)]
                amounts = [a for a in (_amount(t) for t in tokens) if a is not None and a > 0]
                label = " ".join(m.group(1).split())
                if amounts and label not in found:
                    found[label] = amounts[0] * scale
            if found and turnover and max(found.values()) <= turnover * 1.01:
                return sorted(({"region": k, "value": v} for k, v in found.items()), key=lambda r: -r["value"]), number
    return [], 0


def _regions_from_text(pages: list[str], turnover: Optional[float] = None) -> list[dict]:
    return regions_from_pages(pages, turnover)[0]


def overseas_share_from(regions: list[dict], turnover: Optional[float]) -> Optional[float]:
    """Share of turnover from outside the UK, from a regions table whose rows add up to turnover (within 5%)."""
    if not regions or not turnover:
        return None
    total = sum(r["value"] for r in regions)
    if abs(total - turnover) > 0.05 * turnover:
        return None
    foreign = sum(r["value"] for r in regions if not hooks.is_uk(r["region"]) and
                  not re.fullmatch(r"(?:the\s+)?(?:UK|United\s+Kingdom|Great\s+Britain)", r["region"], re.I))
    return round(foreign / turnover, 3)


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
    pl = turnover_text.read(pages, ocr=how == "scanned pdf") or turnover_text.from_prose(pages)
    if pl and pl["turnover"] is not None:
        turnover = (pl["turnover"], pl["turnover_prior"])
        cost = (pl["cost_of_sales"], pl["cost_of_sales_prior"]) if pl["cost_of_sales"] is not None else None
    else:
        turnover = _line_amounts(pages, r"(?:Turnover|Revenue)")   # a row outside a recognisable statement
        if turnover and abs(turnover[0]) < turnover_text.MIN_TURNOVER:
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
        "trading_names": profiles.trading_names(plain),
        **hooks.text_evidence(plain),
        **incumbent.text_evidence(plain),
        **fx_notes.read(pages),
        "format": how,
        "fx_gain_loss_check": "",
        "fx_gain_loss_evidence": "",
        **turnover_fields(pl, turnover is not None, how, text),
    }
    facts["regions"], facts["regions_page"] = regions_from_pages(pages, facts["turnover"])
    facts["overseas_share"] = overseas_share_from(facts["regions"], facts["turnover"])
    for number, page in enumerate(pages, 1):
        if _fx_from_text(facts, page, f"{'scanned ' if how == 'scanned pdf' else ''}accounts p{number}",
                         ocr=how == "scanned pdf"):
            break
    return check_fx(facts)


def turnover_fields(pl: Optional[dict], found: bool, how: str, text: str = "") -> dict:
    """
    What the turnover figure is and where it came from, for the row and the Accounts page:
      turnover_basis   "group" | "company" | "" (tagged figures: the filing's own total)
      turnover_unit    the table's "£" / "£'000" / "£m"
      turnover_page    the PDF page it's on (0: not known)
      turnover_source  "accounts p12: group profit and loss account, £'000 — \"Turnover 3 45,123 41,000\""
      turnover_check   why there's no figure when the accounts show why (not disclosed, not in pounds), else ""
    """
    if pl and found and pl["turnover"] is not None:
        source = turnover_text.describe(pl)
        if how == "ixbrl":
            source = source.replace("accounts p1: ", "accounts: ").replace("accounts p0: ", "accounts: ")
        return {"turnover_basis": pl["basis"], "turnover_unit": pl["unit"],
                "turnover_page": pl["page"] if how != "ixbrl" else 0,
                "turnover_source": source, "turnover_check": ""}
    out = {"turnover_basis": "", "turnover_unit": "", "turnover_page": 0, "turnover_check": "",
           "turnover_source": "accounts text: first turnover row" if found else ""}
    if not found:
        if pl and pl["check"]:
            out.update(turnover_check=pl["check"], turnover_page=pl["page"])
        elif how in ("pdf", "ixbrl") and turnover_text.PL_HEADING.search(text) and re.search(r"turnover|revenue", text, re.I):
            out["turnover_check"] = "turnover shown in the profit and loss account but not readable; check the accounts"
        elif how in ("pdf", "ixbrl"):
            out["turnover_check"] = "turnover not disclosed: no profit and loss account in the filed accounts"
        elif how == "scanned pdf":
            out["turnover_check"] = "turnover not found in the scanned pages read"
    return out


def turnover_from_latest_accounts(company_number: str, api_key: str) -> Optional[dict]:
    """{"turnover", "period_end"} from the latest annual accounts, or None."""
    facts = facts_from_latest_accounts(company_number, api_key)
    if not facts or facts["turnover"] is None:
        return None
    return {"turnover": facts["turnover"], "period_end": facts["period_end"]}
