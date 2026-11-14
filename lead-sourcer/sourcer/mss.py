"""
sourcer/mss.py — the modern slavery statement registry as a discovery source (14 Nov 2026, the discovery review).

Every organisation with £36m+ turnover must publish a modern slavery statement; the registry's yearly download
(registries.MSS_URL, ~12,000 statements) gives each one's company number, turnover band, sectors and, when it names
supply-chain risks, the countries they sit in (Risk1-3Location). A private company in the desk's band whose supply
chain runs abroad — or whose sector is goods trade — is a candidate the finder checks like the FX filings scan's finds.
It is size-qualified by law and covers companies whose accounts the online files miss (paper / PDF filers).
"""

from __future__ import annotations

import csv
import io
from datetime import date
from typing import Callable, Optional

from sourcer import registries

# The registry's turnover bands that overlap the desk's £20m–£300m (over £500m is outside; under £36m are voluntary)
BANDS = {"£36 million to £60 million": "£36m–£60m", "£60 million to £100 million": "£60m–£100m",
         "£100 million to £500 million": "£100m–£500m"}
# Sectors whose business is moving goods across borders
GOODS_SECTORS = ("Fashion, textiles, apparel and luxury goods", "Food and beverages, agriculture and fishing",
                 "Automotive, machinery and heavy electrical equipment", "Durable consumer goods",
                 "Mining, metals, chemicals and resources", "Healthcare and pharmaceuticals", "Retail",
                 "Waste management and recycling", "Transportation, logistics, and storage", "Defence and aerospace")
NOT_PROSPECT = ("Financial, insurance and real estate activities", "Charitable / not-for-profit activities", "Public sector",
                "Education and research")
HOME = {"united kingdom", "uk", "england", "scotland", "wales", "northern ireland", "great britain"}
SCORE_ABROAD = 60     # supply-chain countries abroad named: checked with the FX filings scan's strong finds
SCORE_GOODS = 50      # a goods-trade sector only: at the finder's priority floor


def _parts(value: str) -> list[str]:
    return [p.strip() for p in (value or "").replace("\r", "\n").split("\n") if p.strip()]


def candidates(text: str) -> dict[str, dict]:
    """{company number: {name, band, sectors, countries, parent, score, reason}} for the private companies in the
    band, from one year's download; organisations in finance / property, charities, public bodies and education
    only — or with nothing pointing abroad and no goods sector — are left out."""
    out: dict[str, dict] = {}
    for r in csv.DictReader(io.StringIO(text or "")):
        number = registries.company_number(r.get("CompanyNumber", ""))
        band = BANDS.get((r.get("Turnover") or "").strip())
        if not number or not band or (r.get("SectorType") or "").strip() != "Private":
            continue
        sectors = _parts(r.get("OrganisationSectors", ""))
        countries = sorted({c for k in ("Risk1Location", "Risk2Location", "Risk3Location") for c in _parts(r.get(k, ""))
                            if c.lower() not in HOME})
        goods = [s for s in sectors if s.startswith(GOODS_SECTORS)]
        if not countries and (not goods or all(s.startswith(NOT_PROSPECT) for s in sectors)):
            continue
        score = SCORE_ABROAD if countries else SCORE_GOODS
        reason = (f"Supply chain abroad ({', '.join(countries[:5])})" if countries else f"Goods sector: {goods[0]}")
        out[number] = {"name": (r.get("OrganisationName") or "").strip(), "band": band, "sectors": sectors,
                       "countries": countries, "parent": (r.get("ParentName") or "").strip(), "score": score,
                       "reason": f"{reason}; turnover {band} (modern slavery statement)"}
    return out


def load(today: Optional[date] = None, fetcher: Optional[Callable[[str], Optional[str]]] = None) -> dict[str, dict]:
    """This year's and last year's statements (the newer one wins); {} when the registry can't be reached."""
    fetcher = fetcher or registries.fetch
    year = (today or date.today()).year
    out: dict[str, dict] = {}
    for y in (year - 1, year):
        out.update(candidates(fetcher(registries.MSS_URL.format(year=y)) or ""))
    return out
