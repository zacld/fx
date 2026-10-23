"""
sourcer/currency.py — which currencies a company most likely pays and is
paid in, and roughly how much it converts a year.

Currency mix. HMRC's trader files say what a company imports (8-digit
commodity codes) but not from where. HMRC's national trade statistics say,
for every commodity code, how much the UK imported from (and exported to)
each country, in £. Putting the two together: a company importing wine
code 22042109 every month most likely buys where the UK buys that code —
mostly France, Italy and Spain, so mostly EUR. Each country is mapped to
the currency its trade with the UK is usually invoiced in. It's an
inference from the national pattern for the goods, not the company's own
invoices, and says so.

Trade statistics files are fixed-width, one row per period x code x
country x port (verified against the published files):
  [0:6] period YYYYMM, [13:21] commodity code, [29:31] country consigned
  from (imports) / to (exports), [43:56] value £, [81:84] "imp"/"exp".

Wallet. Annual foreign-currency flow is estimated as a range from filed
figures: purchases (cost of sales, else 70% of turnover) x an import share,
plus turnover x an export share, each share banded by how regularly the
company appears in customs records. Rule of thumb, labelled as such.
"""

from __future__ import annotations

import zipfile
from collections import Counter, defaultdict
from typing import Iterable, Optional

from sourcer import hmrc

# Euro area (Bulgaria from Jan 2026) and countries using the euro.
_EUR = set("AT BE BG HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES MC SM VA AD ME XK".split())
# Non-euro EU and near neighbours whose trade with the UK is mostly invoiced in EUR.
_EUR_INVOICED = set("PL CZ HU RO TR".split())
# Countries whose trade is commonly invoiced in their own currency.
_NATIVE = {"US": "USD", "CH": "CHF", "LI": "CHF", "SE": "SEK", "NO": "NOK", "DK": "DKK", "JP": "JPY",
           "AU": "AUD", "NZ": "NZD", "CA": "CAD", "ZA": "ZAR"}
# UK itself (returned goods, Northern Ireland), unknown or stores-and-provisions codes.
_SKIP = {"GB", "XI", "XU", "QU", "QV", "QW", "QX", "QY", "QZ", "QP", "QQ", "QR", "QS", ""}

# Share of the money going abroad, banded by how many of the last 12 months
# the company appears in customs records: (min months, low share, high share).
IMPORT_SHARE = ((9, 0.40, 0.80), (3, 0.15, 0.40), (1, 0.05, 0.15))
EXPORT_SHARE = ((9, 0.20, 0.50), (3, 0.10, 0.25), (1, 0.02, 0.10))
ASSUMED_PURCHASES_SHARE = 0.70  # of turnover, when cost of sales isn't filed


def currency_for(country: str) -> Optional[str]:
    """Likely invoicing currency for trade with a country (ISO alpha-2); None for the UK / unknown."""
    country = country.strip().upper()
    if country in _SKIP:
        return None
    if country in _EUR or country in _EUR_INVOICED:
        return "EUR"
    return _NATIVE.get(country, "USD")


def iter_stats(path: str, since: str = "") -> Iterable[tuple[str, str, str, int]]:
    """(flow, code, country, value £) per row of a trade-statistics file; rows before `since` (YYYYMM) skipped."""
    with zipfile.ZipFile(path) as zf:
        for _, text in hmrc._txt_members(zf):
            for line in text:
                if len(line) < 84 or not line[:6].isdigit():
                    continue
                if since and line[:6] < since:
                    continue
                kind = line[81:84].lower()
                if kind not in ("imp", "exp"):
                    continue
                value = line[43:56]
                if not value.isdigit():
                    continue
                yield "import" if kind == "imp" else "export", line[13:21], line[29:31], int(value)


class TradeByCountry:
    """National trade value by commodity code and country, with shares looked up at 8/6/4/2 digits."""

    LEVELS = (8, 6, 4, 2)

    def __init__(self):
        # (flow, level, code prefix) -> Counter(country -> £)
        self._values: dict[tuple[str, int, str], Counter] = defaultdict(Counter)
        self._shares: dict[tuple[str, str], list[tuple[str, float]]] = {}
        self._rolled_up = False

    def add(self, flow: str, code: str, country: str, value: int) -> None:
        if len(code) != 8 or not code.isdigit() or currency_for(country) is None or value <= 0:
            return
        self._values[(flow, 8, code)][country] += value
        self._rolled_up = False

    def _roll_up(self) -> None:
        """Sum the 8-digit figures into their 6/4/2-digit groups (once, after loading)."""
        for key in [k for k in self._values if k[1] != 8]:
            del self._values[key]
        for (flow, _, code), counts in list(self._values.items()):
            for level in self.LEVELS[1:]:
                self._values[(flow, level, code[:level])].update(counts)
        self._shares.clear()
        self._rolled_up = True

    @classmethod
    def from_files(cls, paths: Iterable[str], since: str = "") -> "TradeByCountry":
        model = cls()
        for path in paths:
            for flow, code, country, value in iter_stats(path, since):
                model.add(flow, code, country, value)
        return model

    def __len__(self) -> int:
        return sum(1 for (_, level, _) in self._values if level == 8)

    def shares(self, flow: str, code: str) -> list[tuple[str, float]]:
        """[(country, share)] for a code, falling back to its 6/4/2-digit group; [] if unknown."""
        if not self._rolled_up:
            self._roll_up()
        key = (flow, code)
        if key not in self._shares:
            result: list[tuple[str, float]] = []
            for level in self.LEVELS:
                counts = self._values.get((flow, level, code[:level]))
                if counts:
                    total = sum(counts.values())
                    result = [(c, v / total) for c, v in counts.items()]
                    break
            self._shares[key] = result
        return self._shares[key]


def mix(model: TradeByCountry, flow: str, codes: Counter) -> tuple[Counter, Counter]:
    """
    (currency -> share, country -> share) for a company's codes. Each code
    counts by how many months it appeared, split by where the UK trades it.
    """
    countries: Counter = Counter()
    for code, months in codes.items():
        for country, share in model.shares(flow, code):
            countries[country] += months * share
    total = sum(countries.values())
    if not total:
        return Counter(), Counter()
    countries = Counter({c: v / total for c, v in countries.items()})
    currencies: Counter = Counter()
    for country, share in countries.items():
        currencies[currency_for(country)] += share
    return currencies, countries


def describe(shares: Counter, top: int = 3, floor: float = 0.05) -> str:
    """"EUR 58%, USD 37%, CHF 5%" — the largest `top` entries of at least `floor`."""
    ranked = sorted(shares.items(), key=lambda kv: (-kv[1], kv[0]))
    return ", ".join(f"{k} {round(v * 100)}%" for k, v in ranked[:top] if v >= floor)


def pairs(import_mix: Counter, export_mix: Counter, floor: float = 0.15) -> list[str]:
    """GBP pairs worth pitching: every currency with at least `floor` of either flow, biggest first."""
    combined: Counter = Counter()
    for m in (import_mix, export_mix):
        for cur, share in m.items():
            if share >= floor:
                combined[cur] = max(combined[cur], share)
    return [f"GBP/{c}" for c, _ in sorted(combined.items(), key=lambda kv: (-kv[1], kv[0]))]


def _band(months: int, bands: tuple) -> Optional[tuple[float, float]]:
    for minimum, low, high in bands:
        if months >= minimum:
            return low, high
    return None


def wallet(turnover: Optional[float], cost_of_sales: Optional[float], import_months: int,
           export_months: int, overseas_share: Optional[float] = None) -> Optional[dict]:
    """
    {"low", "high", "basis"} — estimated annual foreign-currency flow in £ —
    or None when there's no filed turnover, or nothing (customs records or
    an overseas turnover split) to base it on. A filed split of turnover by
    country replaces the export band.
    """
    if not turnover or not (import_months or export_months or overseas_share):
        return None
    low = high = 0.0
    basis = []
    imp = _band(import_months, IMPORT_SHARE)
    if imp:
        purchases = cost_of_sales if cost_of_sales else turnover * ASSUMED_PURCHASES_SHARE
        low, high = low + purchases * imp[0], high + purchases * imp[1]
        source = "cost of sales" if cost_of_sales else f"{round(ASSUMED_PURCHASES_SHARE * 100)}% of turnover as purchases"
        basis.append(f"imports {round(imp[0] * 100)}–{round(imp[1] * 100)}% of {source} ({import_months} months in customs)")
    if overseas_share:
        low, high = low + turnover * overseas_share, high + turnover * overseas_share
        basis.append(f"sales abroad {round(overseas_share * 100)}% of turnover (filed split by region)")
    else:
        exp = _band(export_months, EXPORT_SHARE)
        if exp:
            low, high = low + turnover * exp[0], high + turnover * exp[1]
            basis.append(f"exports {round(exp[0] * 100)}–{round(exp[1] * 100)}% of turnover ({export_months} months in customs)")
    if not basis:
        return None
    return {"low": low, "high": high, "basis": "; ".join(basis)}
