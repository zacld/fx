"""
sourcer/discover.py — finding niche companies from what they trade (Zac, 21 Nov 2026: "we want to focus on finding
niche companies — I have paid services for contacts and exact financials").

Two ways in, both from HMRC's monthly importer / exporter lists matched to Companies House (no paid calls, no AI):

  * Niche search — Zac types a product or trade ("marble", "saffron, vanilla", "drone parts", or customs codes);
    `commodity_codes` finds the customs codes whose official description names it (uktradeinfo's free Commodity
    table), and `search` lists every company whose customs records carry those codes, sized ones first.
  * Lookalikes — the companies Zac marked good (Simplified dash: Open lead / Added to mine; Good lead) give their own
    customs codes; `lookalikes` finds every other sized company trading the same goods (rarer goods count more), so
    his picks find the next batch.

Both write discoveries the finder researches first (NICHE_SEARCH_FILE, LOOKALIKES_FILE in main.py).
"""

from __future__ import annotations

import math
import re
import urllib.error
import urllib.parse
from collections import Counter, defaultdict
from typing import Iterable, Optional

SIZED = ("full", "medium", "group")
SEARCH_MAX_CODES = 80          # customs codes a search may cover (the description search can match many)
SEARCH_MIN_MONTHS = 2          # months a company's records carry the codes before it counts as trading them
SEARCH_MAX_COMPANIES = 400     # rows kept per search, sized first
_CODE = re.compile(r"^\d{2,8}$")
# Everyday words the customs descriptions put another way (a term finding nothing is tried as these too).
CUSTOMS_WORDS = {
    "drone": "unmanned aircraft", "drones": "unmanned aircraft", "laptop": "portable automatic data-processing",
    "laptops": "portable automatic data-processing", "computer": "automatic data-processing", "phone": "telephones",
    "phones": "telephones", "mobile phones": "telephones for cellular", "e-bike": "cycles with an auxiliary electric motor",
    "ebike": "cycles with an auxiliary electric motor", "vape": "electronic cigarettes", "vapes": "intended for inhalation",
    "solar panel": "photovoltaic", "solar panels": "photovoltaic", "battery": "accumulators", "batteries": "accumulators",
    "ev": "electric motor for propulsion", "trainers": "footwear with outer soles of rubber", "sneakers": "footwear with outer soles of rubber",
    "shoes": "footwear", "clothes": "garments", "clothing": "garments", "car parts": "parts and accessories of the motor vehicles",
    "flowers": "cut flowers", "tyres": "pneumatic tyres", "tires": "pneumatic tyres", "chips": "electronic integrated circuits",
    "semiconductors": "electronic integrated circuits", "spirits": "spirits", "whisky": "whiskies", "perfume": "perfumes",
    "makeup": "make-up", "toys": "toys", "furniture": "furniture", "steel": "iron or non-alloy steel", "plastic": "plastics",
}


def terms(text: str) -> list[str]:
    """ "Marble, granite; 6802" -> ["marble", "granite", "6802"] — one term per comma / semicolon / new line."""
    return [t for t in (re.sub(r"\s+", " ", p).strip().lower() for p in re.split(r"[,;\n]+", text or "")) if t][:8]


def commodity_codes(text: str, fetch=None) -> list[dict]:
    """[{code, description}] for a search: a term of digits is a customs code (any length, a prefix); words are looked
    up in uktradeinfo's Commodity table (8-digit descriptions, and the 6- and 4-digit headings'), every word of a term
    in the description. Never fails: a lookup that errors finds nothing."""
    from sourcer import hmrc
    fetch = fetch or (lambda q: list(hmrc._api_rows(q)))
    out: dict[str, str] = {}
    for term in terms(text):
        if _CODE.match(term):
            out.setdefault(term, f"customs code {term}")
            continue
        found = _lookup(term, fetch)
        if not found and term in CUSTOMS_WORDS:
            found = _lookup(CUSTOMS_WORDS[term], fetch)
        for code, text in found:
            out.setdefault(code, text)
    codes = sorted(out.items())[:SEARCH_MAX_CODES]
    return [{"code": c, "description": d} for c, d in codes]


def _lookup(term: str, fetch) -> list[tuple[str, str]]:
    """[(8-digit code, description)] whose description (or its heading's) holds every word of the term."""
    words = [w for w in re.findall(r"[a-z0-9]+", term) if len(w) > 1][:4]
    if not words:
        return []
    # the 8-digit descriptions first (not counting what they exclude — "(excl. unmanned …)"); only when none names it,
    # the 6-digit then the 4-digit heading's (every code under it)
    for field in ("Cn8LongDescription", "Hs6Description", "Hs4Description"):
        filt = " and ".join(f"contains(tolower({field}),'{w}')" for w in words)
        query = f"Commodity?$select=Cn8Code,Cn8LongDescription&$top=200&$filter=" + urllib.parse.quote(filt, safe="(),'")
        try:
            rows = fetch(query)
        except (urllib.error.URLError, OSError, ValueError):
            return []
        out = []
        for r in rows:
            code = str(r.get("Cn8Code") or "").strip()
            text = re.sub(r"\s+", " ", str(r.get("Cn8LongDescription") or "")).strip()
            if len(code) != 8 or not code.isdigit():
                continue
            if field == "Cn8LongDescription":
                kept = re.sub(r"\((?:excl|other than|not)\b[^)]*\)", "", text, flags=re.I).lower()
                if not all(w in kept for w in words):
                    continue
            out.append((code, text[:140]))
        if out:
            return out
    return []


def _months_with(trade: dict, prefixes: tuple[str, ...]) -> tuple[int, int, Counter]:
    """(code-months of the prefixes, all code-months, {code: months}) in a matched trader's records, both flows."""
    hits: Counter = Counter()
    total = 0
    for flow in ("import_codes", "export_codes"):
        for code, m in (trade.get(flow) or {}).items():
            total += m
            if str(code).startswith(prefixes):
                hits[str(code)] += m
    return sum(hits.values()), total, hits


def search(trade: dict, codes: Iterable[str], tracked: Optional[dict] = None, filings: Optional[dict] = None) -> list[dict]:
    """Every matched company (trade: {number: match_all evidence}) whose records carry the codes in
    SEARCH_MIN_MONTHS+ months, sized ones first, then by months trading them and their share of its trade."""
    prefixes = tuple(sorted({str(c) for c in codes if c}))
    if not prefixes:
        return []
    tracked, filings = tracked or {}, filings or {}
    rows = []
    for number, e in trade.items():
        weight, total, hits = _months_with(e, prefixes)
        if not weight:
            continue
        flows = [f for f, k in (("import", "import_codes"), ("export", "export_codes"))
                 if any(str(c).startswith(prefixes) for c in (e.get(k) or {}))]
        months = len(e["import_months"] | e["export_months"])
        # the records keep months per code, not codes per month: one code seen in SEARCH_MIN_MONTHS+ months is the
        # proof of that many distinct months (two codes in the same month must not add up to two)
        if max(hits.values()) < SEARCH_MIN_MONTHS:
            continue
        c = e["company"]
        f = filings.get(number) or {}
        rows.append({"company_number": number, "company_name": c.get("company_name", ""),
                     "accounts_category": c.get("accounts_category", ""), "sic_codes": c.get("sic_codes", []),
                     "postcode": c.get("postcode", ""), "incorporated_on": c.get("incorporated_on", ""),
                     "flow": " and ".join(flows), "months": months, "code_months": weight,
                     "share": round(100 * weight / total) if total else 0,
                     "codes": [k for k, _ in hits.most_common(3)], "tracked": number in tracked,
                     "filed_fx_score": f.get("filed_fx_score") or "", "turnover_gbp": f.get("turnover_gbp") or ""})
    rows.sort(key=lambda r: (r["accounts_category"] not in SIZED, -r["share"], -r["code_months"], r["company_name"]))
    return rows[:SEARCH_MAX_COMPANIES]


# Lookalikes: goods compared at the 6-digit heading (8-digit codes split one product many ways), each weighted by how
# rare it is among sized traders (a good everyone imports says little); a candidate must cover LOOKALIKE_MIN_SCORE of
# the good lead's weighted goods with LOOKALIKE_MIN_SHARED+ goods in common. The same sector adds a little.
LOOKALIKE_MIN_SCORE = 0.4
LOOKALIKE_MIN_SHARED = 2
LOOKALIKE_PER_LEAD = 15
LOOKALIKE_MAX = 400
LOOKALIKE_COMMON_DF = 3000     # a heading this many sized traders carry is left out of the search (still in the sum)
SECTOR_BONUS = 0.1


def _goods(trade: dict) -> Counter:
    out: Counter = Counter()
    for flow in ("import_codes", "export_codes"):
        for code, m in (trade.get(flow) or {}).items():
            out[str(code)[:6]] += m
    return out


def lookalikes(good: dict, trade: dict, tracked: Optional[dict] = None, skip: Iterable[str] = ()) -> tuple[list[dict], dict]:
    """[{company_number, company_name, like, like_name, score, shared, ...}] — sized companies trading what Zac's good
    leads trade (good: {number: name}); and {"leads": n with customs records, "without": n without} for the log."""
    tracked = tracked or {}
    skip = set(skip) | set(good)
    sized = {n: e for n, e in trade.items() if e["company"].get("accounts_category") in SIZED}
    goods = {n: _goods(e) for n, e in sized.items()}
    df: Counter = Counter()
    for g in goods.values():
        df.update(g.keys())
    total = max(len(goods), 1)
    weight = {h: math.log(1 + total / d) for h, d in df.items()}
    index: dict[str, list[str]] = defaultdict(list)
    for n, g in goods.items():
        for h in g:
            if df[h] <= LOOKALIKE_COMMON_DF:
                index[h].append(n)
    found: dict[str, dict] = {}
    with_trade = 0
    for lead, lead_name in good.items():
        e = trade.get(lead)
        if not e:
            continue
        with_trade += 1
        mine = {h for h, m in _goods(e).items()}
        denom = sum(weight.get(h, math.log(1 + total)) for h in mine) or 1
        lead_sectors = {str(s)[:4] for s in e["company"].get("sic_codes", [])}
        overlap: dict[str, set[str]] = defaultdict(set)
        for h in mine:
            for n in index.get(h, ()):
                overlap[n].add(h)
        picks = []
        for n, shared in overlap.items():
            if n in skip or len(shared) < LOOKALIKE_MIN_SHARED:
                continue
            score = sum(weight[h] for h in shared) / denom
            if lead_sectors & {str(s)[:4] for s in sized[n]["company"].get("sic_codes", [])}:
                score += SECTOR_BONUS
            if score >= LOOKALIKE_MIN_SCORE:
                picks.append((round(min(score, 1.0), 2), n, shared))
        for score, n, shared in sorted(picks, key=lambda p: (-p[0], p[1]))[:LOOKALIKE_PER_LEAD]:
            if n in found and found[n]["score"] >= score:
                continue
            c = sized[n]["company"]
            found[n] = {"company_number": n, "company_name": c.get("company_name", ""),
                        "accounts_category": c.get("accounts_category", ""), "sic_codes": c.get("sic_codes", []),
                        "postcode": c.get("postcode", ""), "like": lead, "like_name": lead_name or e["company"].get("company_name", ""),
                        "score": score, "shared": sorted(shared, key=lambda h: -weight[h])[:5], "shared_n": len(shared),
                        "of": len(mine), "tracked": n in tracked}
    rows = sorted(found.values(), key=lambda r: (-r["score"], r["company_name"]))[:LOOKALIKE_MAX]
    return rows, {"leads": with_trade, "without": len(good) - with_trade}


def good_leads(checks: dict, verdicts: dict, lists: dict | None = None) -> set[str]:
    """Company numbers Zac marked as new prospects: Good lead, Research harder (a good lead with no contact info yet),
    Added to mine, or put on his call / email / mail list — and not since marked Not a fit, Owned abroad or Open lead.
    Open lead means something is already ongoing with them on our side, not a new prospect, and Skip means no finance director found (Zac, 23 Nov 2026):
    neither is one to find more like. Mirrors markClass in apps/web/src/accounts/format.js."""
    checks, verdicts, lists = checks or {}, verdicts or {}, lists or {}
    good = {n for n, l in lists.items() if (l or {}).get("list")}
    for n in set(checks) | set(verdicts):
        if n in good:
            continue
        review = (checks.get(n) or {}).get("review")
        if review in ("research", "mine") or (review not in ("abroad", "open", "skip") and (verdicts.get(n) or {}).get("verdict") == "good"):
            good.add(n)
    return good
