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
import os
import re
from collections import defaultdict
from typing import Callable, Optional

from . import pe, profiles

# the question a person types (Zac, 16 Nov 2026: "I open a tab, type who owns it, and if it gives me another company I
# ask who owns that one")
QUERY = 'who owns {name}'
MAX_HOPS = 4

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


# ── The AI reader (Zac, 16 Nov 2026: the rules read "Who", "Renshaw" — a company Bakels bought — and a person for NCR;
# "yes fine" to one capped AI call a company for this check only — the exception to Priority 1 in CLAUDE.md). One Groq
# call per company (free tier, llama-3.3-70b-versatile, key GROQ_API_KEY), given the search results already fetched; it
# must name the result it read and quote it, and the quote and owner are checked against that result — an answer the
# results don't contain is dropped (no owner rather than an invented one). Calls and tokens are counted and logged.
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = os.environ.get("GROQ_MODEL") or "llama-3.3-70b-versatile"
AI_USAGE = {"calls": 0, "tokens": 0, "dropped": 0, "failed": 0}
AI_SPENT: list = []   # set when Groq says the day's free allowance is used
_PROMPT = """You read web search results to find who OWNS a UK company. Answer only from the results below.
Company: {name} (Companies House {number})

Results:
{results}

Who owns {name}? Give the ultimate owner a person would name: the parent company, the private equity firm, or the
person/family who owns it. Not a company it bought, not a customer, not a brand it sells, not a different company with a
similar name. If the results don't say, answer none.
Reply with JSON only: {{"owner": "<name or none>", "type": "company|private_equity|person|none",
"country": "<country where the owner is based, only if the results say, else empty>",
"result": <the number of the result that says it>, "quote": "<the exact words from that result>"}}"""


def _norm_text(t: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).split())


def ai_read(results: list[tuple[str, str, str]], company_name: str, number: str = "",
            post: Optional[Callable[[dict], Optional[dict]]] = None) -> Optional[dict]:
    """{owner, kind, country, quote, url, sites} | {none: True} from one AI call, or None when no call could be made."""
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not results or (not key and post is None) or (AI_SPENT and post is None):
        return None
    shown = results[:8]
    listing = "\n".join(f"[{i + 1}] {t[:160]} — {s[:320]}" for i, (_, t, s) in enumerate(shown))
    # no JSON mode: a reasoning model (gpt-oss) thinks first, and a short JSON-mode limit cut it off ("Failed to
    # validate JSON", 16 Nov 2026) — room to think, and the JSON is read out of the reply
    body = {"model": GROQ_MODEL, "temperature": 0, "max_tokens": 1500,
            "messages": [{"role": "user", "content": _PROMPT.format(name=company_name, number=number, results=listing)}]}
    data = post(body) if post else _groq(body, key)
    if not data:
        AI_USAGE["failed"] += 1
        return None
    AI_USAGE["calls"] += 1
    AI_USAGE["tokens"] += int((data.get("usage") or {}).get("total_tokens") or 0)
    try:
        content = data["choices"][0]["message"]["content"] or ""
        ans = json.loads(re.search(r"\{.*\}", content, re.S).group(0))
    except (KeyError, IndexError, ValueError, TypeError, AttributeError):
        AI_USAGE["failed"] += 1
        return None
    owner = str(ans.get("owner") or "").strip()
    if not owner or owner.lower() == "none" or ans.get("type") == "none":
        return {"none": True}
    try:
        i = int(ans.get("result")) - 1
        url, title, snippet = shown[i]
    except (TypeError, ValueError, IndexError):
        AI_USAGE["dropped"] += 1
        return {"none": True}
    text = _norm_text(f"{title} {snippet}")
    words = [w for w in _norm_text(owner).split() if w not in ("the", "of", "and", "limited", "ltd", "plc", "inc")]
    quote = str(ans.get("quote") or "")
    # the owner must be in the result it named, and the quote mostly its words: else it isn't the results' answer
    q = _norm_text(quote).split()
    if not words or not all(w in text for w in words) or (q and sum(w in text.split() for w in q) < 0.8 * len(q)):
        AI_USAGE["dropped"] += 1
        return {"none": True}
    if _key(owner) and (_key(owner) == _key(company_name)):
        return {"none": True}
    kind = {"private_equity": "pe", "person": "person", "company": "company"}.get(ans.get("type"), kind_of(owner))
    sites = sum(1 for u, t, sn in results if all(w in _norm_text(f"{t} {sn}") for w in words))
    country = str(ans.get("country") or "").strip()
    country = _ADJ.get(country, country)
    if country and _norm_text(country) not in _norm_text(" ".join(f"{t} {sn}" for _, t, sn in results)) \
            and not any(k for k, v in _ADJ.items() if v == country and _norm_text(k) in text):
        country = ""   # a country the results don't say is a guess
    return {"owner": owner[:120], "kind": kind, "country": country, "quote": " ".join(f"{title} — {snippet}".split())[:240],
            "url": "" if url == "knowledge-panel" else url, "sites": max(1, sites), "read_by": "ai"}


# a retired model answers 404 model_not_found: the next of these is tried and kept for the run (as packages/pipeline's
# sources/ai.ts does for the event call)
GROQ_FALLBACKS = ["openai/gpt-oss-120b", "meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.1-8b-instant"]
_model: list = []


def _groq(body: dict, key: str) -> Optional[dict]:
    global GROQ_MODEL
    for model in ([_model[0]] if _model else [GROQ_MODEL] + [m for m in GROQ_FALLBACKS if m != GROQ_MODEL]):
        extra = {"reasoning_effort": "low", "reasoning_format": "hidden"} if model.startswith("openai/gpt-oss") else {}
        out = _groq_once({**body, "model": model, **extra}, key)
        if out == "model_gone":
            continue
        if out is not None and not _model:
            _model.append(model)
            if model != GROQ_MODEL:
                print(f"  Groq: {GROQ_MODEL} not available, using {model}")
                GROQ_MODEL = model
        return out if isinstance(out, dict) else None
    return None


def _groq_once(body: dict, key: str):
    import time
    import urllib.error
    import urllib.request
    for attempt in range(3):
        req = urllib.request.Request(GROQ_URL, data=json.dumps(body).encode(), headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {key}", "User-Agent": profiles.USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            text = e.read(400).decode("utf-8", "replace") if e.fp else ""
            if e.code == 404 and re.search(r"model_not_found|does not exist|decommissioned", text, re.I):
                return "model_gone"
            if e.code == 400 and re.search(r"decommissioned|not supported", text, re.I):
                return "model_gone"
            if e.code == 429:
                wait = float(e.headers.get("retry-after") or 10)
                # the day's allowance used (a long wait, or the error says per day): no more AI this run — the run stops
                # and keeps its search credit for tomorrow, rather than stall on waits or fall back to the rules
                if wait > 60 or re.search(r"per day|\bTPD\b|\bRPD\b|daily", text, re.I) or attempt == 2:
                    AI_SPENT.append(text[:160])
                    print(f"  Groq: today's free allowance used — {re.sub(r'[^ -~]', '', text)[:140]}")
                    return None
                time.sleep(wait)                    # requests a minute: a short wait
                continue
            print(f"  Groq refused ({e.code}): {re.sub(r'[^ -~]', '', text)[:160]}")
            return None
        except Exception:  # noqa: BLE001
            if attempt < 2:
                time.sleep(5)
    return None


# ── Gemini with Grounding with Google Search (Zac, 16 Nov 2026: "the most reliable way is through Google"; key
# GEMINI_API_KEY from AI Studio). One call a company: Gemini runs the Google searches itself — "who owns X", then who
# owns that owner — and answers from them; an answer counts only when a source backs the owner's name. Its allowance
# used → the older route (search APIs + Groq).
# Gemini 3 (25 Nov 2026): 2.5 Flash is closed to new keys ("no longer available to new users"), and on 3.x the old
# generateContent call mostly answered from memory without searching (1 search in ~10 tests, even when told to). So a
# 3.x model is asked through the Interactions API (POST /v1beta/interactions), where Google Search ran every time. It
# doesn't hand back the pages it read, so the answer names its source page and the words on it, and that page is opened
# to check the owner's name is really there (website.fetch, robots.txt respected, never a social site). What it cites is
# mostly Google's own redirect link (vertexaisearch.cloud.google.com — robots.txt says no, never opened; first live run,
# 25 Nov 2026), so the owner is then confirmed by one search through the finder's search APIs for the company and that
# owner, its results' titles and snippets held to the same rules (`_search_check`); an owner nothing backs is asked the
# older way (search APIs + Groq). Searches are billed one by one on 3.x (5,000 free a month, then about $14 per 1,000), so the
# prompt keeps it to GEMINI_MAX_SEARCHES and the nightly run asks only about Zac's good leads (tools/owner_search.py
# --only-first, 25 Nov 2026: "only run on good leads").
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
GEMINI_MODELS = [m for m in [os.environ.get("GEMINI_MODEL", "")] if m] + ["gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash",
                                                                      "gemini-2.5-flash-lite", "gemini-flash-lite-latest", "gemini-2.0-flash"]
GEMINI_MAX_SEARCHES = int(os.environ.get("GEMINI_MAX_SEARCHES", "3"))
GEMINI_PAGE_CHECKS = 3          # cited pages opened to find the owner's name, a company
GEMINI_USAGE = {"calls": 0, "tokens": 0, "searches": 0, "verified": 0, "confirmed_by_search": 0, "dropped": 0, "failed": 0}
GEMINI_SPENT: list = []
GEMINI_DROPS: dict = {}         # why cited pages didn't back an owner: counts for the run's log
GEMINI_LAST: dict = {}          # the last answer's chain and page checks (tools/gemini_key_check.py prints them)
GEMINI_FAILS_MAX = 3            # calls in a row that fail (timeouts, errors) before the rest of the run skips Gemini
_GEMINI_FAILS = [0]
_gemini_model: list = []
_GEMINI_PROMPT = """Search Google to find who owns the UK company {name} (Companies House number {number}). Use at most
{searches} searches. If it is owned by another company, find who owns that company, and so on up the chain, until you
reach a person or family, a private equity firm or fund, or a stock-market-listed company. Do not confuse it with a
company it bought, a customer, a brand it sells, or a different company with a similar name. Use only what the search
results say; if they don't say who owns it, say none.
Reply with JSON only, no other text:
{{"chain": [{{"owner": "<name>", "type": "company|private_equity|person", "country": "<country where based, if known>",
"source_url": "<the address of the web page that says so>", "quote": "<the words on that page that say so>"}}],
"answer": "<one sentence saying who owns {name}>"}}
The chain lists the owners from the nearest parent up to the ultimate owner; an empty chain means none found."""
_STOP_WORDS = ("the", "of", "and", "limited", "ltd", "plc", "inc", "group", "uk", "holdings", "holding", "company", "co",
               "ab", "gmbh", "sa", "llc", "bv", "nv", "spa", "srl", "as", "oy")


_OWNERSHIP_WORDS = re.compile(r"\b(?:own(?:s|ed|er|ers|ership)?|subsidiar\w*|parent|part of|acquir\w*|bought|portfolio|"
                              r"backed|member of|division of|ultimate|controlling|holding company|sold to)\b")


def _uses_interactions(model: str) -> bool:
    return not re.match(r"gemini-[12]\.", model)


def _words(name: str) -> list[str]:
    return [w for w in _norm_text(name).split() if w not in _STOP_WORDS and len(w) > 1]


def _page_check(url: str, owner: str, company_name: str, page: Optional[Callable[[str], Optional[tuple[str, str]]]] = None) -> str:
    """"ok" when the cited page names the owner (every telling word of it — its whole name when the company shares
    them), the company (a telling word) and says something about ownership; else why not. Opened with the finder's own
    fetcher: robots.txt respected, never LinkedIn or another social site (Priority 12)."""
    import urllib.parse
    from . import website
    if not re.match(r"https?://", url or ""):
        return "no page cited"
    if any(s in url.lower() for s in website._SOCIAL):
        return "social site (never opened)"
    if re.match(r"https?://[^/]*vertexaisearch\.cloud\.google\.com/", url):
        return "Google's redirect link (its robots.txt says no)"    # what Gemini 3 cites: the search below instead
    fetch = page or website.fetch
    parts = urllib.parse.urlsplit(url)
    robots = website._robots(f"{parts.scheme}://{parts.netloc}/", fetch)
    if not robots.can_fetch(website.USER_AGENT, url):
        return "robots.txt says no"
    got = fetch(url)
    if not got:
        return "page didn't open"
    return _text_check(website.page_text(got[1]), owner, company_name, "page")


def _text_check(raw: str, owner: str, company_name: str, where: str = "page") -> str:
    """"ok" when the text names the owner (every telling word — its whole name when the company shares them), the
    company (a telling word) and says something about ownership; else why not."""
    text = " " + _norm_text(raw) + " "
    owner_words, company_words = _words(owner), _words(company_name)
    if not owner_words or not all(f" {w} " in text for w in owner_words):
        return f"owner not on the {where}"
    if company_words and not any(f" {w} " in text for w in company_words):
        return f"company not on the {where}"
    # an owner sharing the company's name (Cloetta UK → Cloetta AB): any page about the company has that word, so the
    # owner's whole name must be there ("cloetta ab")
    if set(owner_words) <= set(company_words) and f" {_norm_text(owner)} " not in text:
        return f"owner's whole name not on the {where}"
    return "ok" if _OWNERSHIP_WORDS.search(text) else f"nothing about ownership on the {where}"


def _search_check(owner: str, company_name: str, fetch: Optional[Callable[[str], Optional[str]]] = None) -> tuple[str, str, int, str]:
    """When no cited page backs Gemini's owner: one search through the finder's search APIs for the company and that
    owner, its results' titles and snippets held to the same rules (never a page fetched). (reason, link, results that
    back it, the first one's snippet) — reason "ok" when one does."""
    query = f'"{profiles.plain_name(company_name)}" {owner}'
    raw = profiles._cached(query) if fetch is None else None      # a stand-in fetcher (tests) never touches the cache
    if raw is None:
        if fetch is None and not profiles.api_key():
            return "no search API to confirm it", "", 0, ""
        raw = (fetch or profiles.fetch_any)(query)
        if raw is None:
            return "no search API to confirm it", "", 0, ""
        if fetch is None:
            profiles._store(query, raw)
    backing = [(link, snippet or title) for link, title, snippet in profiles.parse(raw) or []
               if _text_check(f"{title} {snippet}", owner, company_name, "result") == "ok"]
    return ("ok", backing[0][0], len(backing), backing[0][1]) if backing else ("no search result backs it either", "", 0, "")


def _page_backs(url: str, owner: str, company_name: str, page: Optional[Callable[[str], Optional[tuple[str, str]]]] = None) -> bool:
    return _page_check(url, owner, company_name, page) == "ok"


_UNCHECKED = {"none": True, "unchecked": True}   # Gemini named an owner nothing backs: asked the older way instead


def gemini_read(company_name: str, number: str = "", post: Optional[Callable[[str], Optional[dict]]] = None,
                page: Optional[Callable[[str], Optional[tuple[str, str]]]] = None,
                confirm: Optional[Callable[[str], Optional[str]]] = None) -> Optional[dict]:
    """{owner, kind, country, quote, url, chain, read_by: "gemini"} | {none: True} (with `unchecked` when it named an
    owner no source backs), or None when no call could be made. `post(prompt)`, `page(url)` and `confirm(query)` stand in
    for the API, the page fetcher and the search APIs in tests."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if (not key and post is None) or (GEMINI_SPENT and post is None):
        return None
    GEMINI_LAST.clear()
    prompt = _GEMINI_PROMPT.format(name=company_name, number=number or "unknown", searches=GEMINI_MAX_SEARCHES)
    data = post(prompt) if post else _gemini(prompt, key)
    if not data:
        GEMINI_USAGE["failed"] += 1
        _GEMINI_FAILS[0] += 1
        if _GEMINI_FAILS[0] >= GEMINI_FAILS_MAX and not GEMINI_SPENT:
            GEMINI_SPENT.append("failing")
            print(f"  Gemini: {GEMINI_FAILS_MAX} calls in a row failed — the search APIs take the rest of this run")
        return None
    _GEMINI_FAILS[0] = 0
    GEMINI_USAGE["calls"] += 1
    steps = data.get("steps")
    if steps is not None:                                   # the Interactions API (Gemini 3)
        use = data.get("usage") or {}
        GEMINI_USAGE["tokens"] += int(use.get("total_tokens") or sum(v for k, v in use.items() if isinstance(v, (int, float))
                                                                   and k.startswith("total_") and k.endswith("_tokens")))
        GEMINI_USAGE["searches"] += sum(len((st.get("arguments") or {}).get("queries") or [])
                                        for st in steps if st.get("type") == "google_search_call")
        text = " ".join(c.get("text", "") for st in steps if st.get("type") == "model_output"
                        for c in st.get("content") or [] if isinstance(c, dict))
        searched = any(st.get("type") == "google_search_call" for st in steps)
        chunks, supported = [], ""
    else:                                                   # generateContent (Gemini 2.x): Google's grounding
        GEMINI_USAGE["tokens"] += int((data.get("usageMetadata") or {}).get("totalTokenCount") or 0)
        try:
            cand = data["candidates"][0]
            text = "".join(p.get("text", "") for p in cand["content"]["parts"])
        except (KeyError, IndexError, TypeError):
            GEMINI_USAGE["failed"] += 1
            return None
        meta = cand.get("groundingMetadata") or {}
        chunks = meta.get("groundingChunks") or []
        supported = " ".join(((s.get("segment") or {}).get("text") or "") for s in meta.get("groundingSupports") or [])
        searched = bool(chunks)
    try:
        ans = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
    except (ValueError, TypeError, AttributeError):
        GEMINI_USAGE["failed"] += 1
        return None
    steps_ = [c for c in ans.get("chain") or [] if isinstance(c, dict) and str(c.get("owner") or "").strip()
              and str(c.get("owner")).lower() != "none"]
    if not steps_:
        return {"none": True}
    top = steps_[-1]
    owner = str(top["owner"]).strip()
    if _key(owner) == _key(company_name) or not searched:
        GEMINI_USAGE["dropped"] += 1                        # no search ran: the model's memory, not a source
        return dict(_UNCHECKED)
    if steps is not None:
        # the owner must be on a page it cites: the top owner's own page first, then the chain's others
        urls = [u for u in dict.fromkeys(str(c.get("source_url") or "").strip() for c in [top] + steps_[::-1]) if u]
        GEMINI_LAST.update(chain=[(str(c.get("owner")), c.get("type")) for c in steps_], checks=[])
        backing = ""
        for u in urls[:GEMINI_PAGE_CHECKS] or [""]:
            why = _page_check(u, owner, company_name, page)
            GEMINI_LAST["checks"].append((u, why, str(next((c.get("quote") for c in steps_
                                                             if str(c.get("source_url") or "").strip() == u), "") or "")))
            if why == "ok":
                backing = u
                break
        sites, snippet = 1, ""
        if not backing:
            # no page it cites opened and named the owner: one search for the company and that owner instead
            why, link, sites, snippet = _search_check(owner, company_name, confirm)
            GEMINI_LAST["checks"].append(("search", why, ""))
            if why == "ok":
                backing = link
                GEMINI_USAGE["confirmed_by_search"] += 1
        if not backing:
            GEMINI_USAGE["dropped"] += 1
            for _, why, _ in GEMINI_LAST["checks"]:
                GEMINI_DROPS[why] = GEMINI_DROPS.get(why, 0) + 1
            return dict(_UNCHECKED)
        GEMINI_USAGE["verified"] += 1
        # the words that back it: the search result's own, else what Gemini quoted from the page we opened
        quote = snippet or str(next((c.get("quote") for c in steps_ if str(c.get("source_url") or "").strip() == backing
                                     and c.get("quote")), "") or ans.get("answer") or "")
        url, source = backing, re.sub(r"^https?://(www\.)?", "", backing).split("/")[0]
    else:
        words = [w for w in _norm_text(owner).split() if w not in ("the", "of", "and", "limited", "ltd", "plc", "inc", "group")]
        # backed by Google: the owner named in the grounded text (else it may be the model's memory)
        if not (words and supported and all(w in _norm_text(supported + " " + text) for w in words)):
            GEMINI_USAGE["dropped"] += 1
            return dict(_UNCHECKED)
        web = [c.get("web") or {} for c in chunks]
        quote = str(ans.get("answer") or supported)
        url = next((w.get("uri") for w in web if w.get("uri")), "")
        source, sites = ", ".join(w.get("title", "") for w in web[:3] if w.get("title")), len(chunks)
    kind = {"private_equity": "pe", "person": "person", "company": "company"}.get(top.get("type"), kind_of(owner))
    return {"owner": owner[:120], "kind": kind, "country": _ADJ.get(str(top.get("country") or "").strip(), str(top.get("country") or "").strip()),
            "quote": " ".join(quote.split())[:240], "url": url, "source": source, "sites": sites, "read_by": "gemini",
            "chain": [{"owner": str(c["owner"]).strip()[:120], "kind": {"private_equity": "pe", "person": "person", "company": "company"}.get(c.get("type"), "company"),
                       "country": str(c.get("country") or "").strip()} for c in steps_]}


def _gemini(prompt: str, key: str) -> Optional[dict]:
    import time
    import urllib.error
    import urllib.request
    for model in (_gemini_model[:1] or GEMINI_MODELS):
        if _uses_interactions(model):
            url = GEMINI_INTERACTIONS_URL
            body = {"model": model, "input": prompt, "tools": [{"type": "google_search"}]}
        else:
            url = GEMINI_URL.format(model=model)
            body = {"contents": [{"parts": [{"text": prompt}]}], "tools": [{"google_search": {}}], "generationConfig": {"temperature": 0}}
        for attempt in range(3):
            req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
                "Content-Type": "application/json", "x-goog-api-key": key, "User-Agent": profiles.USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=150) as res:
                    out = json.load(res)
                if not _gemini_model:
                    _gemini_model.append(model)
                    print(f"  Gemini: using {model}" + (" (Interactions API)" if _uses_interactions(model) else ""))
                return out
            except urllib.error.HTTPError as e:
                text = e.read(400).decode("utf-8", "replace") if e.fp else ""
                if e.code == 404 or (e.code == 400 and re.search(r"not found|not supported|unknown name|no longer available", text, re.I)):
                    break                                   # this model isn't available: the next one
                if e.code == 429:
                    full = e.read(3000).decode("utf-8", "replace") if e.fp else ""
                    text = text + full
                    # no free allowance for this model at all ("limit: 0"): try the next model
                    if re.search(r"limit:\s*0\b|free_tier", text, re.I) and model != (_gemini_model[:1] or GEMINI_MODELS)[-1]:
                        print(f"  Gemini: {model} has no free allowance on this key — trying the next model")
                        break
                    if re.search(r"per day|PerDay|daily|quota", text, re.I) or attempt == 2:
                        GEMINI_SPENT.append(text[:160])
                        print(f"  Gemini: today's allowance used ({model}) — {re.sub(r'[^ -~]', '', ' '.join(text.split()))[:400]}")
                        return None
                    time.sleep(20)                         # requests a minute
                    continue
                print(f"  Gemini refused ({e.code}): {re.sub(r'[^ -~]', '', text)[:160]}")
                if e.code in (401, 402, 403):          # no credit / key refused: not again this run
                    GEMINI_SPENT.append(text[:160])
                return None
            except Exception:  # noqa: BLE001 — a timeout or a dropped connection: once more, then not for this company
                if attempt == 0:                       # (never the next model: this one exists, the call failed)
                    time.sleep(5)
                    continue
                return None
    return None


def search(number: str, company_name: str, fetch: Callable[[str], Optional[str]] = profiles.fetch_any) -> dict:
    """Who owns it — Gemini searching Google when it can (one call, the whole chain), else the search APIs: asked again
    of each owner that is a company until a person, a private-equity firm, a loop or MAX_HOPS: {owner, kind, country,
    quote, url, chain: [{owner, kind, country}]} (owner = the top), {none: True}, or {error: True} when no search could be
    made."""
    g = gemini_read(company_name, number)
    if g is not None and not g.get("unchecked"):
        return g
    r = _chain(number, company_name, fetch)
    # Gemini answered but nothing backed its owner, and the search APIs can't be asked: nothing found this time
    return {"none": True} if g is not None and r.get("error") else r


def _chain(number: str, company_name: str, fetch: Callable[[str], Optional[str]]) -> dict:
    """The older route: the search APIs read by Groq (or the rules), asked again of each owner that is a company."""
    chain, seen, name, num = [], {_key(company_name)}, company_name, number
    for _ in range(MAX_HOPS):
        r = _one(num, name, fetch)
        if r.get("error"):
            if chain:
                break
            return r
        if r.get("none") or _key(r["owner"]) in seen:
            break
        chain.append(r)
        seen.add(_key(r["owner"]))
        if r.get("kind") in ("person", "pe"):
            break
        name, num = r["owner"], ""
    if not chain:
        return {"none": True}
    top = dict(chain[-1])
    top["country"] = top.get("country") or ""
    top["chain"] = [{"owner": c["owner"], "kind": c.get("kind", ""), "country": c.get("country", "")} for c in chain]
    return top


def _one(number: str, company_name: str, fetch: Callable[[str], Optional[str]]) -> dict:
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
    read = ai_read(results, company_name, number)
    if read is not None:          # the AI read it (an owner checked against the results, or none)
        return read
    best = answer(results, company_name)          # no AI key or the call failed: the rules
    return {**best, "read_by": "rules"} if best else {"none": True}


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
    out = [("knowledge-panel", p.get("title", ""), facts)] if facts else []
    if p.get("answer"):
        out.insert(0, (p.get("answer_link") or "knowledge-panel", "Google answer", p["answer"]))
    return out
