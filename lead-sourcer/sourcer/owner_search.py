"""
sourcer/owner_search.py — who really owns a company, from a web search (Zac, 16 Nov 2026, after checking 30 leads by
hand: Companies House gave the right holding company — Axalta Coating Systems, Investindustrial Advisors, NLC Group —
but not the owner a person would name: TowerBrook, Investindustrial / Andrea Bonomi, Paul Rosen, Trustbridge. "We NEED
a search.")

One search a company through the search APIs the finder already uses within their allowances (`profiles.fetch_any`:
Search1API → Tavily → Exa → Serper), results cached. The answer is read by rules, no AI: result titles and snippets
that name the company and say "owned by X", "a subsidiary of X", "acquired by X", "part of the X group", "X portfolio
company", "backed by X", "X acquires <company>" — and Google's knowledge panel ("Parent organization: X", "Owner: X")
when the provider returns one. Each candidate owner counts once per site; the panel counts twice; the most named wins.
Kept with its quote and link; a person, a private-equity house or a company; the country only when a snippet says it
("a US-based …", "headquartered in Germany").
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from typing import Callable, Optional

from . import pe, profiles

QUERY = '"{name}" owned by OR "subsidiary of" OR "acquired by" OR "parent company" OR "portfolio company"'

_WORD = r"(?:[A-Z][\w&'’.\-]*|&|of|and|de|du|la|von|van|der)"
_NAME = rf"((?:[A-Z][\w&'’.\-]*)(?:\s+{_WORD}){{0,6}})"
_CUES = [
    (3, re.compile(rf"\b(?i:parent organi[sz]ation|parent company|owners?|owned by|ultimate parent)\s*:\s*{_NAME}")),
    (2, re.compile(rf"\b(?:wholly[- ]owned |a |an |the )?subsidiary of (?:the )?{_NAME}")),
    (2, re.compile(rf"\b(?:is |was |now |are )?(?:wholly |majority |privately |jointly )?owned by (?:the )?{_NAME}")),
    (2, re.compile(rf"\b(?:was |been |is being |were )?(?:acquired|bought|purchased|taken over) by (?:the )?{_NAME}")),
    (2, re.compile(rf"\bpart of (?:the )?{_NAME}(?:\s+(?:group|Group|family))")),
    (2, re.compile(rf"\bportfolio company of (?:the )?{_NAME}")),
    (1, re.compile(rf"\b(?:backed|controlled) by (?:the )?{_NAME}")),
    (2, re.compile(rf"{_NAME}\s+(?:portfolio company|-backed|backed)\b")),
]
_ACQUIRES = re.compile(rf"{_NAME}\s+(?:has\s+)?(?:acquires|acquired|buys|bought|completes (?:the )?acquisition of|to acquire|agrees to buy)\s+")
# words that end a name or aren't owners
_STOP_TAIL = re.compile(r"\s+(?:in|for|on|at|from|with|since|after|which|who|that|the|a|an|its|and|of|&|de|du|la|von|van|der)$")
_NOT_OWNER = re.compile(r"^(?:The|A|An|Its|It|This|That|Management|Private Equity|Investors?|Founders?|Shareholders?|Employees?|Staff|"
                        r"Directors?|Family|Families|Group|Company|Companies|Limited|Ltd|UK|United Kingdom|England|London|Google|"
                        r"LinkedIn|Wikipedia|Companies House|Bloomberg|Reuters|Crunchbase|PitchBook|Dun|Owner|Owners|Parent|"
                        r"Subsidiary|Subsidiaries|January|February|March|April|May|June|July|August|September|October|"
                        r"November|December|Mr|Mrs|Ms|Dr|Sir)$")
_CORP = re.compile(r"\b(?:Limited|Ltd|PLC|plc|Inc|Corp|Corporation|LLC|LLP|LP|L\.P\.|AG|GmbH|SA|S\.A\.|SpA|S\.p\.A\.|NV|N\.V\.|BV|B\.V\.|"
                   r"AB|AS|A/S|Oy|SE|KK|Co|Company|Group|Holdings?|Partners|Capital|Equity|Investments?|Fund|Ventures|"
                   r"Industries|International|Enterprises|Trust|Foundation|Bank|Topco|Bidco|Midco)\b")
_COUNTRY = re.compile(r"\b(?:(?:an?|the)\s+)?(American|US|U\.S\.|German|French|Dutch|Swiss|Swedish|Danish|Norwegian|Finnish|Italian|"
                      r"Spanish|Portuguese|Belgian|Austrian|Irish|Japanese|Chinese|Indian|Canadian|Australian|Singaporean|"
                      r"Korean|Israeli|Polish|Turkish|Brazilian|Mexican|Luxembourg|British|UK|Scottish)[- ](?:based|headquartered|owned|listed|company|group|firm|investor|private equity)"
                      r"|\b(?:based|headquartered|incorporated) in (?:the )?(United States|USA|Germany|France|the Netherlands|Netherlands|"
                      r"Switzerland|Sweden|Denmark|Norway|Finland|Italy|Spain|Portugal|Belgium|Austria|Ireland|Japan|China|"
                      r"Hong Kong|India|Canada|Australia|Singapore|South Korea|Israel|Poland|Turkey|Brazil|Mexico|Luxembourg|"
                      r"the United Kingdom|United Kingdom|UK|England|London|Scotland|Jersey|Guernsey)")
_ADJ = {"American": "United States", "US": "United States", "U.S.": "United States", "German": "Germany", "French": "France",
        "Dutch": "Netherlands", "Swiss": "Switzerland", "Swedish": "Sweden", "Danish": "Denmark", "Norwegian": "Norway",
        "Finnish": "Finland", "Italian": "Italy", "Spanish": "Spain", "Portuguese": "Portugal", "Belgian": "Belgium",
        "Austrian": "Austria", "Irish": "Ireland", "Japanese": "Japan", "Chinese": "China", "Indian": "India",
        "Canadian": "Canada", "Australian": "Australia", "Singaporean": "Singapore", "Korean": "South Korea",
        "Israeli": "Israel", "Polish": "Poland", "Turkish": "Turkey", "Brazilian": "Brazil", "Mexican": "Mexico",
        "Luxembourg": "Luxembourg", "British": "United Kingdom", "UK": "United Kingdom", "Scottish": "United Kingdom",
        "USA": "United States", "the Netherlands": "Netherlands", "the United Kingdom": "United Kingdom",
        "England": "United Kingdom", "London": "United Kingdom", "Scotland": "United Kingdom"}


def _key(name: str) -> str:
    s = re.sub(r"[^a-z0-9 ]", " ", name.lower())
    s = re.sub(r"\b(?:the|limited|ltd|plc|inc|llp|llc|lp|group|holdings?|uk|international|co|company|corporation|corp|sa|ag|gmbh)\b", " ", s)
    return " ".join(s.split())


def _tidy(raw: str) -> str:
    name = raw.strip(" ,.;:'’\"()")
    name = re.split(r"\s+(?:in|for|on|at|from|with|since|after|which|who|that|is|was|has|and its|as)\s+", name)[0]
    while _STOP_TAIL.search(name):
        name = _STOP_TAIL.sub("", name)
    name = re.sub(r"['’]s$", "", name).strip(" ,.;:-")
    return name


def kind_of(name: str) -> str:
    """'pe' | 'company' | 'person'."""
    if pe.HOUSES.search(name.upper()) or re.search(r"\b(?:Capital|Partners|Private Equity|Equity|Ventures|Fund|Investindustrial)\b", name):
        return "pe"
    if _CORP.search(name) or len(name.split()) == 1 or len(name.split()) > 4:
        return "company"
    return "person"


def candidates(results: list[tuple[str, str, str]], company_name: str) -> list[dict]:
    """[{owner, kind, country, score, sites, quote, url}] best first — owners named for this company in the results."""
    own = _key(company_name)
    plain = profiles.plain_name(company_name)
    found: dict[str, dict] = {}
    seen_site: dict[str, set] = defaultdict(set)
    for url, title, snippet in results:
        panel = url == "knowledge-panel"
        for text in (title, snippet):
            if not text or not (panel or profiles.mentions_company(text, company_name, url) or _key(plain) in _key(text)):
                continue
            hits = [(w, m) for w, rx in _CUES for m in rx.finditer(text)] + [(2, m) for m in _ACQUIRES.finditer(text)
                                                                           if _key(plain) in _key(text[m.end():m.end() + 80])]
            for weight, m in hits:
                name = _tidy(m.group(1))
                k = _key(name)
                if (not k or len(name) < 3 or _NOT_OWNER.match(name) or k == own or (own and (k in own or own in k))
                        or len(k) < 3):
                    continue
                site = "panel" if panel else profiles._site(url)
                c = found.setdefault(k, {"owner": name, "kind": kind_of(name), "country": "", "score": 0, "sites": 0,
                                         "quote": "", "url": ""})
                if site not in seen_site[k]:
                    seen_site[k].add(site)
                    c["sites"] += 1
                    c["score"] += weight * (2 if panel else 1)
                    if not c["quote"] or panel:
                        c["quote"], c["url"] = " ".join(text.split())[:240], ("" if panel else url)
                if not c["country"]:
                    near = text[max(0, m.start() - 60):m.end() + 120]
                    cm = _COUNTRY.search(near)
                    if cm:
                        c["country"] = _ADJ.get(cm.group(1) or cm.group(2), cm.group(1) or cm.group(2) or "")
    # one owner under several spellings ("TowerBrook", "TowerBrook Capital Partners"): merged on the first word,
    # under the fullest name, sites and points added
    merged: dict[str, dict] = {}
    for k, c in sorted(found.items(), key=lambda kv: -kv[1]["score"]):
        head = k.split()[0]
        m = merged.get(head) if len(head) >= 4 else None
        if not m:
            merged[head if len(head) >= 4 else k] = dict(c)
            continue
        m["score"] += c["score"]
        m["sites"] += c["sites"]
        m["country"] = m["country"] or c["country"]
        if len(c["owner"]) > len(m["owner"]):
            m["owner"], m["kind"] = c["owner"], c["kind"]
    return sorted(merged.values(), key=lambda c: (-c["score"], -c["sites"]))


def answer(results: list[tuple[str, str, str]], company_name: str) -> Optional[dict]:
    """The owner the results support best, or None. One site with a weak cue isn't enough."""
    best = next(iter(candidates(results, company_name)), None)
    if not best or best["score"] < 2:
        return None
    return best


def search(number: str, company_name: str, fetch: Callable[[str], Optional[str]] = profiles.fetch_any) -> dict:
    """{owner, kind, country, sites, quote, url} or {none: True}; {error: True} when no search could be made."""
    name = profiles.plain_name(company_name)
    query = QUERY.format(name=name)
    raw = profiles._cached(query)
    if raw is None:
        raw = fetch(query)
        if raw is None:
            return {"error": True}
        profiles._store(query, raw)
    results = profiles.parse(raw) or []
    results = _panel(raw) + results
    best = answer(results, company_name)
    return best if best else {"none": True}


def _panel(raw: str) -> list[tuple[str, str, str]]:
    """Google's knowledge panel facts kept by the provider answer (fetch_any keeps Serper's as `panel`)."""
    try:
        data = json.loads(raw or "")
    except ValueError:
        return []
    p = data.get("panel") if isinstance(data, dict) else None
    if not p:
        return []
    facts = "; ".join(f"{k}: {v}" for k, v in (p.get("attributes") or {}).items()
                      if re.search(r"parent|owner|subsidiar", k, re.I))
    return [("knowledge-panel", p.get("title", ""), facts)] if facts else []
