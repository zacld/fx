"""
sourcer/niches.py — which niche a company belongs to, and how good each niche is, measured.

Two kinds of niche in config/fx_niches.json:
  * SIC niches (`sic_codes`): the sector a company chose for itself on the register — broad and self-declared;
  * goods niches (`hmrc_codes`): what HMRC's monthly importer / exporter lists show it actually trading — 4-digit
    customs headings or 6-digit subheadings, matched as prefixes of the 8-digit codes. Proof of the trade, so a goods
    niche wins over a SIC niche when a company's customs records fit one.

Each niche is measured (tools/niche_hits.py, weekly): of its companies big enough to file full / medium / group
accounts, how many show strong FX proof in their own filings (the FX filings scan, filed FX score 50+) — the hit rate —
and of those, how many name no forward contracts and no FX provider (probably paying their bank's rate: still open).
    score = hit rate (%) x (0.5 + 0.5 x open share)
The finder checks niches in score order and skips niches measured as poor (`verdict` "drop"). Unmeasured niches (too
few companies yet, or no measurement file) sit in the middle, so a new niche gets its chance.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from typing import Optional

STRONG = 50                 # filed FX score that counts as strong proof (the finder's priority bar)
SIZED = ("full", "medium", "group")   # accounts big enough to be in the band
MIN_MEASURED = 15           # sized companies a niche needs before its rate means anything
DROP_RATE = 1.0             # under 1 strong find per 100 sized companies (with MIN_DROP_SIZED+ measured): drop
MIN_DROP_SIZED = 40
GOODS_MIN_MONTHS = 3        # code-months of a goods niche's codes before a company counts as trading in it
GOODS_MIN_SHARE = 0.10      # ... and at least this share of all its declared code-months
TIERS = ((8.0, 3), (4.0, 2), (1.5, 1))   # score -> tier for the finder's order; unmeasured = 1, below 1.5 = 0

_SERVED = re.compile(r"^Uses (?:forward|currency option|an FX provider)", re.I)


def goods_weight(trade: dict, niche: dict) -> int:
    """Code-months of the niche's customs codes in a trader's records (imports, or both ways for flow "both")."""
    prefixes = tuple(niche.get("hmrc_codes") or ())
    if not prefixes or not trade:
        return 0
    flows = ("import_codes", "export_codes") if niche.get("flow") == "both" else \
        ("export_codes",) if niche.get("flow") == "export" else ("import_codes",)
    return sum(m for f in flows for code, m in (trade.get(f) or {}).items() if str(code).startswith(prefixes))


def goods_niches(trade: Optional[dict], niches: list[dict]) -> list[tuple[int, dict]]:
    """[(weight, niche)] for every goods niche a trader really trades in, heaviest first."""
    if not trade:
        return []
    total = sum((trade.get("import_codes") or Counter()).values()) + sum((trade.get("export_codes") or Counter()).values())
    out = []
    for n in niches:
        w = goods_weight(trade, n)
        if w >= GOODS_MIN_MONTHS and total and w / total >= GOODS_MIN_SHARE:
            out.append((w, n))
    return sorted(out, key=lambda x: -x[0])


def goods_niche(trade: Optional[dict], niches: list[dict]) -> Optional[dict]:
    hits = goods_niches(trade, niches)
    return hits[0][1] if hits else None


BROAD_NICHE_CODES = 10      # a sector niche with this many codes is the measured broad one, not a specific niche
CATCH_ALL_SHARE = 4         # a code this many specific niches share ("non-specialised wholesale of food", "other
                            # household goods") names no niche: a toothbrush wholesaler isn't a musical instrument one


def catch_all_codes(niches: list[dict]) -> set[str]:
    counts: Counter = Counter(str(c) for n in niches if 0 < len(n.get("sic_codes") or []) < BROAD_NICHE_CODES
                              for c in n["sic_codes"])
    return {c for c, k in counts.items() if k >= CATCH_ALL_SHARE}


def niche_codes(niche: dict, catch_all: set[str]) -> set[str]:
    """The SIC codes that really name this niche (catch-all codes left out)."""
    return set(map(str, niche.get("sic_codes") or [])) - catch_all


def sector_niche(sics: list[str], niches: list[dict], catch_all: Optional[set[str]] = None) -> Optional[dict]:
    """The SIC niche sharing the most specific codes with the company; the broad measured one only when nothing narrower
    fits; None when only catch-all codes match."""
    catch_all = catch_all_codes(niches) if catch_all is None else catch_all
    codes = set(sics or [])
    fits = [n for n in niches if codes & niche_codes(n, catch_all)]
    if not fits:
        return None
    return max(fits, key=lambda n: (len(n["sic_codes"]) < BROAD_NICHE_CODES, len(codes & niche_codes(n, catch_all))))


def company_niche(trade: Optional[dict], sics: list[str], niches: list[dict], catch_all: Optional[set[str]] = None) -> Optional[dict]:
    """What its customs records show it trading, else the sector it chose for itself."""
    return goods_niche(trade, [n for n in niches if n.get("hmrc_codes")]) or sector_niche(sics, niches, catch_all)


def is_open(row: dict) -> bool:
    """No forward contracts and no FX provider named in its filings: probably paying the bank's rate."""
    return not (row.get("fx_forwards") or _SERVED.search(row.get("fx_today") or ""))


def measure(sized: int, strong: int, open_: int) -> dict:
    """The niche's numbers, score and verdict (keep / drop / few)."""
    rate = round(100 * strong / sized, 2) if sized else 0.0
    open_share = round(open_ / strong, 2) if strong else 0.0
    score = round(rate * (0.5 + 0.5 * open_share), 2)
    verdict = "few" if sized < MIN_MEASURED and strong < 3 else "drop" if sized >= MIN_DROP_SIZED and rate < DROP_RATE else "keep"
    return {"sized": sized, "strong": strong, "open": open_, "hit_rate": rate, "open_share": open_share,
            "score": score, "verdict": verdict}


def load_stats(path: str) -> dict:
    """{niche id: measured numbers} from tools/niche_hits.py's file; {} when there's none."""
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return (json.load(f) or {}).get("niches") or {}
    except (OSError, ValueError):
        return {}


def tier(niche_id: str, stats: dict) -> int:
    """The finder's order: 3 best … 0 poor; unmeasured (or too few to tell) = 1."""
    s = stats.get(niche_id)
    if not s or s.get("verdict") == "few":
        return 1
    return next((t for floor, t in TIERS if s.get("score", 0) >= floor), 0)


def dropped(niche_id: str, stats: dict) -> bool:
    return (stats.get(niche_id) or {}).get("verdict") == "drop"


# --- Hard to broker (Zac, 13 Nov 2026) ----------------------------------------------------------------------------------
# Sectors payment firms (non-bank FX brokers) often decline or restrict — AML high-risk goods, commodities, sanctions-
# heavy trades — where a bank's FX desk can win. Niches carrying `broker_shy` (the reason) in config/fx_niches.json.
# Never these, whatever the niche: weapons and firearms, gambling, crypto, cannabis, adult.
SHY_NEVER_SIC = {"25400", "30400", "92000", "64991"}   # weapons & ammunition, military vehicles, gambling, security dealing
SHY_NEVER_NAME = re.compile(r"\b(?:firearms?|guns?|gunsmiths?|ammunition|munitions|weapons?|armou?ry|casinos?|betting|"
                            r"bookmakers?|bingo|lotter(?:y|ies)|gambling|crypto\w*|bitcoin|blockchain|cannabis|cbd|hemp|"
                            r"adult|escorts?)\b", re.I)


def broker_shy(trade: Optional[dict], sics: list[str], name: str, niches: list[dict]) -> Optional[dict]:
    """{"niche", "why"} when the company trades in (customs records) or is registered in (SIC) a hard-to-broker niche;
    None for anything on the never list."""
    if set(sics or []) & SHY_NEVER_SIC or SHY_NEVER_NAME.search(name or ""):
        return None
    shy = [n for n in niches if n.get("broker_shy")]
    in_sector = lambda n: bool(set(map(str, n.get("sic_codes") or [])) & set(sics or []))   # noqa: E731
    # `needs_sic`: its goods alone are too common (laptops, lorries, oils) — the company's own sector must say so too
    goods = goods_niche(trade, [n for n in shy if n.get("hmrc_codes") and (not n.get("needs_sic") or in_sector(n))])
    sector = None if goods else next((n for n in shy if in_sector(n)), None)
    hit = goods or sector
    return {"niche": hit["name"], "why": hit["broker_shy"]} if hit else None
