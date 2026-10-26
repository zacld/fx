"""
sourcer/profiles.py — who a Google search says runs a company's finance,
for the confirmation step (sourcer/confirm.py).

Searches go through whichever search APIs have keys, each kept inside its
own monthly allowance (counted in the cache folder) and used in order:
Search1API (Google results, SEARCH1API_KEY, 200/month free), Tavily
(TAVILY_API_KEY, 1,000/month free), Exa (EXA_API_KEY), Serper (Google
results, SERPER_API_KEY, paid per search). When one is used up or fails,
the next takes over. Only the search engine's own result titles and
snippets are read — linkedin.com is never fetched, nothing is logged in,
no emails or phone numbers are kept. Finance people are taken from:

  - LinkedIn profile results: "Alan Metcalfe - Finance Director at LJ Fairburn & Son Limited";
  - any other result naming someone with a finance title next to the
    company: board pages ("Finance Director Chris Boyle"), news, org charts
    ("Bhavesh Dobariya (Finance Director)").

Ideas borrowed from browser-search (MIT, fangsylar-pixel): several query
wordings per question, results de-duplicated by link and near-identical
title, and a result only counts when it covers every required anchor group
(the company and a finance title) — "strict" rather than "partial".
Results are cached on disk, so a company re-checked within CACHE_DAYS costs
nothing.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Iterable, Optional

from sourcer import people

API_URL = "https://api.search1api.com/search"
TIMEOUT_SECONDS = 30
PAUSE_SECONDS = 1.0
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "fx-lead-sourcer", "search")
# A finance director rarely changes within two months; at 60 days the whole list's re-checks (~650
# searches a month) fit inside Tavily's free 1,000 a month, so one-off credits (Serper) last.
CACHE_DAYS = float(os.environ.get("SEARCH_CACHE_DAYS", "60"))
MAX_SEARCHES = int(os.environ.get("SEARCH_MAX_PER_RUN", "200"))
MAX_FAILED = 5              # consecutive searches no provider could answer before giving up for the run
RETRIES = 2                 # extra tries on a temporary failure (timeout, 429, 5xx), with a growing pause
RETRY_PAUSE = 3.0
STRIKES = 3                 # temporary failures in a row before a provider is left out for the run
LINKEDIN = "LinkedIn profile"
# Our name on every API request. Some APIs sit behind Cloudflare, which refuses Python's default client name with a bare 403.
USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"
_FORMER = re.compile(r"\b(former|formerly|ex-|previously|retired|available immediately|open to work)\b", re.I)
# Non-finance roles, so a pick shown as "Chris Craven. Managing Director" can be ruled out.
_ROLE = (r"Managing Director|Chief Executive(?: Officer)?|CEO|Chief Operating Officer|COO|Chair(?:man|woman)?|"
         r"Founder|Owner|(?:Sales|Operations|Commercial|Purchasing|Accounts|HR|People|Marketing|Trading|Technical) "
         r"Director|Director")
_NAMED_ROLE = re.compile(rf"([A-ZÀ-ÖØ-Þ](?:[^\W\d_A-Z]|['’-])+(?: [A-ZÀ-ÖØ-Þ](?:[^\W\d_A-Z]|['’-])+){{1,3}})\s*[.,:–-]\s*({_ROLE})\b")
# Words dropped from the end of a company's name to get the phrase people write ("C.J. Lang & Son Limited" -> "cj lang").
_TAIL = {"limited", "ltd", "plc", "llp", "uk", "gb", "group", "holdings", "holding", "company", "co", "trading",
         "international", "and", "son", "sons", "bros", "brothers", "the"}
_FAMILY = {"and", "son", "sons", "bros", "brothers"}
# ...and, if two or more words are left, these too ("Natco Foods" is often written "Natco").
_LOOSE_TAIL = {"foods", "food", "products", "brands", "fine", "drinks", "europe", "global"}
# Everyday words that start many unrelated websites ("villagemd.com", "drinks.com"): a website whose name only
# starts with one of these is not taken as the company's own.
_COMMON_FIRST = {"village", "orchard", "drinks", "drink", "international", "origin", "global", "united", "premier",
                 "quality", "fresh", "foods", "food", "royal", "national", "general", "first", "golden", "green",
                 "natural", "prime", "select", "world", "city", "country", "classic", "direct", "total", "north",
                 "south", "east", "west", "central", "british", "english", "scottish", "irish", "european", "trade",
                 "trading", "import", "imports", "export", "supply", "supplies", "products", "brands", "service",
                 "services", "solutions", "systems", "industries", "partners", "wine", "wines", "coffee", "dairy",
                 "meat", "seafood", "farm", "farms", "valley", "house", "home", "garden", "kitchen", "market"}
# LinkedIn country sites other than the UK's (uk.) and the default (www.): someone at a namesake abroad.
_FOREIGN_LINKEDIN = re.compile(r"^(?!uk\.|www\.)[a-z]{2}\.linkedin\.com$")
# Words that turn up next to a title in a headline but aren't part of a person's name.
_NOT_PERSON = {"DIVISIONAL", "DIVISION", "REGION", "REGIONAL", "NORTHEAST", "NORTHWEST", "SOUTHEAST", "SOUTHWEST",
               "BUSINESS", "PARTNER", "VICE", "PRESIDENT", "ASSISTANT", "ASSOCIATE", "ANALYST", "ACCOUNTANT",
               "REMOTE", "HYBRID", "CREDIT", "HOSPITALITY", "COLLEGIATE", "IPO", "PRIVATE", "EQUITY", "CAPITAL",
               "BANK", "FARM", "FARMS", "FRESH", "FINE", "DRINKS", "MEAT", "DAIRY", "BAKERY", "INTERIM", "ACTING",
               "MOBILE", "PHONE", "EMAIL", "CONTACT", "VIEW", "PROFILE", "LINKEDIN", "AVAILABLE", "IMMEDIATELY",
               "PHOTO", "IMAGE", "MARKETING", "ROLE", "ACTIVE", "RESIGNED", "APPOINTED", "EXPRESS", "EGGS", "STORES"}
# "(Feb 2025 to present)", "Jan 2000 - Present": a LinkedIn result's current job.
_PRESENT = re.compile(r"(?:to|-|–)\s*present\b", re.I)

# (query, key) -> JSON text of the API's answer, or None on failure
Fetcher = Callable[[str, str], Optional[str]]


# name, key variable, monthly-allowance variable and default, endpoint, request builder, results key
PROVIDERS = [
    ("search1api", "SEARCH1API_KEY", "SEARCH1API_MONTHLY", 200, API_URL,
     lambda q, k: ({"Authorization": f"Bearer {k}"},
                   {"query": q, "search_service": "google", "max_results": 10, "crawl_results": 0})),
    ("tavily", "TAVILY_API_KEY", "TAVILY_MONTHLY", 1000, "https://api.tavily.com/search",
     lambda q, k: ({"Authorization": f"Bearer {k}"}, {"query": q, "max_results": 10, "search_depth": "basic",
                                                     "country": "united kingdom"})),
    ("exa", "EXA_API_KEY", "EXA_MONTHLY", 500, "https://api.exa.ai/search",
     lambda q, k: ({"x-api-key": k}, {"query": q, "numResults": 10, "userLocation": "GB",
                                              "contents": {"highlights": True}})),
    ("serper", "SERPER_API_KEY", "SERPER_MONTHLY", 0, "https://google.serper.dev/search",
     lambda q, k: ({"X-API-KEY": k}, {"q": q, "gl": "uk", "num": 10})),
]


def api_key() -> str:
    """The first configured search key ("" when none) — whether searching can happen at all."""
    return next((os.environ.get(var, "").strip() for _, var, *_ in PROVIDERS if os.environ.get(var, "").strip()), "")


def _post(url: str, headers: dict, body: dict) -> tuple[int, str]:
    """(HTTP status, body) — status 0 for a network error or timeout."""
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "User-Agent": USER_AGENT, **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return resp.status, resp.read(2_000_000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read(2000).decode("utf-8", "replace")   # an error answer: says why (bad key, plan...)
        except Exception:  # noqa: BLE001
            return e.code, ""
    except Exception:  # noqa: BLE001
        return 0, ""


def fetch(query: str, key: str) -> Optional[str]:
    """Search1API's JSON answer for a Google search, or None."""
    headers, body = PROVIDERS[0][5](query, key)
    code, text = _post(API_URL, headers, body)
    return text if code == 200 else None


def _usage_path(today: Optional[time.struct_time] = None) -> str:
    return os.path.join(CACHE_DIR, f"usage-{time.strftime('%Y-%m', today or time.gmtime())}.json")


def usage() -> dict:
    try:
        with open(_usage_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _count(name: str) -> None:
    counts = usage()
    counts[name] = counts.get(name, 0) + 1
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(_usage_path(), "w", encoding="utf-8") as f:
        json.dump(counts, f)


def fetch_any(query: str, _key: str = "") -> Optional[str]:
    """
    The first provider with a key and allowance left this month answers;
    a failing provider is skipped for the rest of the run. The answer is
    returned in Search1API's shape ({"results": [{title, link, snippet}]}).
    A monthly allowance of 0 means no cap (paid per search).
    """
    for name, var, cap_var, default_cap, url, build in PROVIDERS:
        key = os.environ.get(var, "").strip()
        cap = int(os.environ.get(cap_var, default_cap))
        if not key or name in _failed or (cap and usage().get(name, 0) >= cap):
            continue
        headers, body = build(query, key)
        for attempt in range(RETRIES + 1):
            code, text = _post(url, headers, body)
            results = _normalise(text) if code == 200 else None
            if results is not None:
                _count(name)
                _strikes[name] = 0
                return json.dumps({"results": results, "provider": name})
            if code in (401, 402, 403) or code == 200:
                _failed.add(name)       # bad key or out of credits (an error answer): done for this run
                _why[name] = describe_failure(code, text)
                break
            if attempt < RETRIES:       # timeout, rate limit or server error: wait and try again
                time.sleep(RETRY_PAUSE * (attempt + 1))
        else:
            _strikes[name] = _strikes.get(name, 0) + 1
            if _strikes[name] >= STRIKES:
                _failed.add(name)
                _why[name] = f"{STRIKES} temporary failures in a row (last: {describe_failure(code, text)})"
    return None


_failed: set = set()
_strikes: dict = {}
_why: dict = {}   # provider -> why it was left out this run (status codes and API error text: no results, no keys)


def describe_failure(code: int, text: str) -> str:
    """"HTTP 401", "timeout or network error", or an error answer's message — safe to log."""
    if code == 0:
        return "timeout or network error"
    if code != 200:
        if "<html" in (text or "")[:500].lower():
            return f"HTTP {code} (a web page, not the API: likely blocked before reaching it)"
        try:
            data = json.loads(text or "")
        except ValueError:
            plain = " ".join((text or "").split())[:80]   # e.g. Cloudflare's "error code: 1010"
            return f"HTTP {code}" + (f" ({plain})" if plain else "")
        message = next((str(data[k]) for k in ("error", "message", "detail", "msg") if isinstance(data, dict) and data.get(k)), "")
        return f"HTTP {code}" + (f" ({message[:100]})" if message else "")
    try:
        data = json.loads(text or "")
    except ValueError:
        return "HTTP 200 but not JSON"
    if not isinstance(data, dict):
        return "HTTP 200, unexpected answer"
    message = next((str(data[k]) for k in ("error", "message", "detail", "msg") if data.get(k)), "")
    return f"HTTP 200 without results (keys: {', '.join(sorted(data)[:6])}{'; ' + message[:100] if message else ''})"


def left_out() -> dict:
    """{provider: reason} for providers dropped during this run."""
    return dict(_why)


def check_providers(query: str = "Companies House") -> dict:
    """
    {provider: "ok (N results)" or why not} — one search each with every
    configured key, so a run's log shows which allowances work. Results
    aren't kept; each successful check counts against that month's allowance.
    """
    status = {}
    for name, var, cap_var, default_cap, url, build in PROVIDERS:
        key = os.environ.get(var, "").strip()
        if not key:
            continue
        cap = int(os.environ.get(cap_var, default_cap))
        if cap and usage().get(name, 0) >= cap:
            status[name] = f"monthly allowance of {cap} used"
            continue
        code, text = _post(url, *build(query, key))
        results = _normalise(text) if code == 200 else None
        if results is not None:
            _count(name)
            status[name] = f"ok ({len(results)} results)"
        else:
            status[name] = describe_failure(code, text)
    return status


def _normalise(answer: Optional[str]) -> Optional[list[dict]]:
    """Any provider's JSON -> [{title, link, snippet}], or None if it isn't a results answer."""
    try:
        data = json.loads(answer or "")
    except ValueError:
        return None
    items = data.get("results", data.get("organic")) if isinstance(data, dict) else None
    if not isinstance(items, list):
        return None
    out = []
    for r in items:
        snippet = (r.get("snippet") or r.get("content") or (r.get("metadata") or {}).get("snippet")
                   or " ".join(r.get("highlights") or []) or r.get("text") or "")
        out.append({"title": r.get("title") or "", "link": r.get("link") or r.get("url") or "", "snippet": snippet})
    return out


def parse(answer: str) -> Optional[list[tuple[str, str, str]]]:
    """[(url, title, snippet)] from a search API's JSON; None if it isn't a results answer."""
    items = _normalise(answer)
    if items is None:
        return None
    return dedupe((r["link"], _clean(r["title"]), _clean(r["snippet"])) for r in items)


def _clean(text: str) -> str:
    text = re.sub(r"&nbsp;|&middot;", lambda m: " " if m.group(0) == "&nbsp;" else " · ", text or "")
    return " ".join(text.split())


def _similar(a: str, b: str) -> float:
    wa, wb = set(a.lower().split()), set(b.lower().split())
    return len(wa & wb) / max(len(wa), len(wb)) if wa and wb else 0.0


def dedupe(results: Iterable[tuple[str, str, str]]) -> list[tuple[str, str, str]]:
    """Drop repeated links and near-identical titles (the same page in several country versions)."""
    seen, titles, out = set(), [], []
    for url, title, snippet in results:
        key = url.split("?")[0].rstrip("/").lower().split("://")[-1]
        key = re.sub(r"^[a-z]{2}\.linkedin\.com", "linkedin.com", re.sub(r"^www\.", "", key))
        if key in seen or any(_similar(title, t) > 0.7 for t in titles):
            continue
        seen.add(key)
        titles.append(title)
        out.append((url, title, snippet))
    return out


def _norm(text: str) -> str:
    """Lower case, "&" as "and", punctuation as spaces, runs of initials joined ("L.J." / "L J" -> "lj")."""
    text = re.sub(r"[^a-z0-9 ]+", " ", re.sub(r"['’´`]", "", (text or "").lower().replace("&", " and ")))
    text = " ".join(text.split())
    return re.sub(r"\b[a-z](?: [a-z]\b)+", lambda m: m.group(0).replace(" ", ""), text)


def company_phrases(company_name: str) -> list[str]:
    """
    How the company's name is written in a search result, normalised:
    "L.J. FAIRBURN AND SON LIMITED" -> ["lj fairburn"]; "NATCO FOODS LIMITED"
    -> ["natco foods"]; "FORREST FRESH FOODS LIMITED" -> ["forrest fresh foods", "forrest fresh"].
    """
    words = _norm(re.sub(r"\([^)]*\)", " ", company_name)).split()
    while len(words) > 1 and words[0] == "the":
        words.pop(0)
    while len(words) > 1 and words[-1] in _TAIL - _FAMILY:
        words.pop()
    # "& Son" goes only if two words are left: "Morris & Son" stays "morris and son"
    family = next((i for i, w in enumerate(reversed(words)) if w not in _FAMILY), len(words))
    if family and len(words) - family >= 2:
        del words[-family:]
    phrases = [" ".join(words)] if words else []
    loose = list(words)
    while len(loose) > 2 and loose[-1] in _LOOSE_TAIL | (_TAIL - _FAMILY) | {"and"}:
        loose.pop()
        if loose[-1] not in _TAIL:
            phrases.append(" ".join(loose))
    return phrases


def mentions_company(text: str, company_name: str, url: str = "") -> bool:
    """
    The result names this company: its name as a phrase ("Forrest Fresh
    Foods", not just "Forrest"), or it is on the company's own website.
    """
    phrases = company_phrases(company_name)
    padded = f" {_norm(text)} "
    if any(f" {p} " in padded for p in phrases):
        return True
    joined = [p.replace(" ", "") for p in phrases]
    if any(j and len(j) >= 6 and f" {j} " in padded for j in joined):   # "FreshAsia" for "Fresh Asia"
        return True
    return _own_site(url, phrases)


def _own_site(url: str, phrases: list[str]) -> bool:
    """The website's name holds the company's ("brindisa.com"; "fairburnseggs.co.uk" for LJ Fairburn)."""
    host = re.sub(r"[^a-z0-9]", "", _site(url).split(".")[0]) if url else ""
    if not host or _site(url) == "linkedin.com":
        return False
    first = next((w for w in phrases[0].split() if len(w) > 3), "") if phrases else ""
    return any(len(p.replace(" ", "")) >= 5 and p.replace(" ", "") in host for p in phrases) or \
        (len(first) >= 6 and first not in _COMMON_FIRST and host.startswith(first))


def plain_name(company_name: str) -> str:
    """"L.J. FAIRBURN AND SON LIMITED" -> "L.J. Fairburn And Son" (as a person would type it)."""
    name = re.sub(r"[\s,.]*\b(LIMITED|LTD|PLC|LLP)\.?$", "", company_name.strip(), flags=re.I)
    return name.title() if name.isupper() else name


# "The TradeLink International Group Ltd, trading as The BakeRite Company": staff list the trading name online.
_TRADING_AS = re.compile(r"\b(?i:trading\s+as|t/a|trades\s+as|trading\s+under\s+the\s+names?(?:\s+of)?)[ \t]+[\"“‘']?"
                         r"((?:The[ \t]+)?[A-Z][\w&'’.-]*(?:[ \t]+(?:[A-Z][\w&'’.-]*|&|and|of)){0,4})")
# Accountants' and lawyers' firms also "trade as" in the accounts ("Sterling, trading as Sterling Chartered Accountants").
_ADVISER_NAME = re.compile(r"\b(?:accountants?|auditors?|chartered|solicitors?|advis[eo]rs?|LLP|tax|statutory)\b", re.I)


def trading_names(text: str, company_name: str = "") -> list[str]:
    """Names the text says the company trades as ("trading as X", "t/a X"), other than its registered name."""
    own = company_phrases(company_name) if company_name else []
    names: list[str] = []
    for m in _TRADING_AS.finditer(text or ""):
        name = re.sub(r"(?:\s+(?:and|of|&))+$", "", m.group(1).strip(" .,'’\""))
        name = re.sub(r"[\s,.]*\b(?:Limited|Ltd|PLC|LLP)\.?$", "", name, flags=re.I)
        phrases = company_phrases(name)
        if not phrases or len(phrases[0].replace(" ", "")) < 4 or any(p in own for p in phrases) \
                or _ADVISER_NAME.search(name):
            continue
        if not any(_norm(n) == _norm(name) for n in names):
            names.append(name)
    return names[:2]


def queries_for(company_name: str) -> list[str]:
    """The wordings tried in turn until one finds a finance person (cheapest first)."""
    name = plain_name(company_name)
    return [f"{name} finance director", f'"{name}" CFO OR FD OR "director of finance" OR "head of finance"']


def split_title(title: str) -> tuple[str, str]:
    """"Alan Metcalfe - Finance Director at LJ Fairburn | LinkedIn" -> ("Alan Metcalfe", "Finance Director at LJ Fairburn")."""
    title = re.sub(r"\s*[|\-–—]\s*LinkedIn\s*$", "", title.strip(), flags=re.I)
    parts = re.split(r"\s+[-–—|]\s+", title, maxsplit=1)
    return (parts[0].strip(), parts[1].strip()) if len(parts) == 2 else (title, "")


def _plausible_name(name: str) -> bool:
    words = name.replace(",", " ").split()
    return 2 <= len(words) <= 4 and all(w[:1].isupper() for w in words) and \
        not any(w.strip(".").upper() in people._NOT_NAME for w in words)


def _site(url: str) -> str:
    host = urllib.parse.urlparse(url).netloc.lower()
    return "linkedin.com" if host.endswith("linkedin.com") else re.sub(r"^www\.", "", host)


def _title_near_company(text: str, company_name: str) -> str:
    """A finance title followed closely by the company's name ("Group Finance Director. Meadowvale Foods")."""
    for m in people._FINANCE_TITLE_RE.finditer(text):
        if mentions_company(text[m.end():m.end() + 60], company_name):
            return " ".join(m.group(0).split())
    return ""


def clean_person(name: str, company_name: str) -> str:
    """
    The person's name from the words next to a title, or "" if it isn't one:
    letters after the name dropped ("Ron Wall, MBA"), cut at a full stop
    ("Ratnesh Bagdai. Linton"), the company's or headline words in front
    dropped ("Drinks Gordon Wallace"), and anything still containing a
    non-name word rejected ("IPO Divisional", "Vice President").
    """
    name = people._DEGREES.sub("", " ".join(name.split()).strip(" .·,;|")).strip(" .·,;")
    words: list[str] = []
    for w in name.replace(",", " ").split():
        if people._QUALIFICATION_RE.fullmatch(w.strip("-–(),")) or w.startswith(("-", "–")):
            continue  # "Himanshu Gandhi -FCCA"
        if w.endswith(".") and len(w.strip(".")) > 1:
            words.append(w.strip("."))
            break
        words.append(w)
    words = [w.strip("'’\"") for w in words if w.strip("'’\"")]
    company = {w.upper() for w in _norm(company_name).split()}
    while words and ({_norm(words[0]).upper(), _norm(words[0]).upper().removesuffix("S")} & company
                     or words[0].strip(".").upper() in _NOT_PERSON | people._NOT_NAME):
        words.pop(0)  # "Fairburn's Eggs", "Photo' Chris Boyle"
    half = len(words) // 2
    if half and len(words) % 2 == 0 and words[:half] == words[half:]:
        words = words[:half]  # "Jim Rowan Jim Rowan"
    if any(w.strip(".").upper() in _NOT_PERSON for w in words) or (words and len(words[-1].strip(".")) == 1):
        return ""  # a non-name word, or a surname cut to an initial ("Malinka I.")
    name = " ".join(words)
    return name if _plausible_name(name) else ""


def _near(text: str, name: str, company_name: str, reach: int = 120) -> bool:
    """The company is named within `reach` characters of the person (a round-up names several firms)."""
    at = text.find(name)
    return at >= 0 and mentions_company(text[max(0, at - reach):at + len(name) + reach], company_name)


def people_in_results(results: Iterable[tuple[str, str, str]], company_name: str) -> list[dict]:
    """
    [{"name", "title", "url", "current", "sites", "source"}] — people the
    results name at this company, merged by person. A result counts only if
    it is "strict": it names the company as a phrase (outside the person's
    name; "Forrest Fresh Foods", not just "Forrest") and, for anyone but a
    LinkedIn profile, a finance title. LinkedIn profiles on another
    country's LinkedIn site are left out (a namesake abroad). `sites` lists
    the distinct websites that named them (independent sources).
    """
    if not company_phrases(company_name):
        return []
    found: dict[str, dict] = {}

    def add(name: str, title: str, url: str, current: bool, source: str) -> None:
        name = clean_person(name, company_name)
        if not name:
            return
        key = next((k for k in found if people.same_person(k, name)), name)
        entry = found.setdefault(key, {"name": name, "title": title, "url": "", "current": current,
                                       "sites": [], "source": source})
        if _site(url) not in entry["sites"]:
            entry["sites"].append(_site(url))
        if source == LINKEDIN and not entry["url"]:
            entry.update(url=url.split("?")[0], current=current, source=source,
                         title=title or entry["title"])
        elif not entry["title"] or (people.is_finance_title(title) and not people.is_finance_title(entry["title"])):
            entry["title"] = title

    for url, title, snippet in results:
        if _site(url) == "linkedin.com" and "/in/" in url:
            if _FOREIGN_LINKEDIN.match(urllib.parse.urlparse(url).netloc.lower()):
                continue
            name, headline = split_title(title)
            if not mentions_company(f"{headline} {snippet}", company_name):
                continue  # someone at another company, or only sharing a word with it
            job = re.split(r"\s+(?:at|@)\s+|\s*@\s*|\s+[-–—|]\s+", headline, maxsplit=1)[0].strip() if headline else ""
            if mentions_company(job, company_name) and not re.search(_ROLE, job) and not people.is_finance_title(job):
                job = ""  # the headline is just the employer's name
            if not people.is_finance_title(job):
                job = _title_near_company(snippet, company_name) or job
            full = re.search(r"Headline:\s*(.*?)(?:\s+(?:Current role|Location|Seniority):|$)", snippet)
            current = not _FORMER.search(f"{headline} {full.group(1) if full else ''}")
            if current and not mentions_company(headline, company_name):
                # the company is only in the snippet: current only if it's the job held "to present"
                jobs = [snippet[max(0, m.start() - 100):m.end()] for m in _PRESENT.finditer(snippet)]
                elsewhere = re.search(r"\s(?:at|@)\s+\S", headline)   # "Finance Director at Plant Plan": works there now
                current = any(mentions_company(j, company_name) for j in jobs) if jobs else not elsewhere
            add(name, job if job.strip("- ") else "", url, current, LINKEDIN)
            continue
        text = f"{title}\n{snippet}"
        if not mentions_company(text, company_name, url):
            continue
        own_site = mentions_company("", company_name, url)
        for p in people.finance_people(text, f"{company_name} {_site(url)}"):
            if own_site or _near(text, p["name"], company_name):
                add(p["name"], p["title"], url, True, _site(url))
        for m in _NAMED_ROLE.finditer(text):  # other roles: only used to rule a pick in or out
            if own_site or _near(text, m.group(1), company_name):
                add(m.group(1), m.group(2), url, True, _site(url))
    return list(found.values())


def _cached(query: str) -> Optional[str]:
    path = os.path.join(CACHE_DIR, hashlib.sha1(query.encode()).hexdigest() + ".json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_DAYS * 86400:
        with open(path, encoding="utf-8") as f:
            return f.read()
    return None


def _store(query: str, answer: str) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(os.path.join(CACHE_DIR, hashlib.sha1(query.encode()).hexdigest() + ".json"), "w", encoding="utf-8") as f:
        f.write(answer)


def finance_team_many(companies: list[tuple], fetcher: Optional[Fetcher] = None,
                      pause: Optional[float] = None, key: Optional[str] = None,
                      max_searches: Optional[int] = None) -> tuple[dict[str, list[dict]], str]:
    """
    ({company_number: people_in_results(...)}, status) for (number, name)
    pairs, in order. The second wording is tried only when the first finds no
    current finance director (a controller or manager alone isn't enough). status: "ok", "no search API key", "budget of N
    searches reached", or "stopped after N failed searches".
    """
    key = api_key() if key is None else key
    if not key and fetcher is None:
        return {}, "no search API key"
    fetcher = fetcher or fetch_any
    pause = PAUSE_SECONDS if pause is None else pause
    budget = MAX_SEARCHES if max_searches is None else max_searches
    found: dict[str, list[dict]] = {}
    spent = failed = 0
    class Stop(Exception):
        pass

    def search(query: str) -> Optional[list[tuple[str, str, str]]]:
        nonlocal spent, failed
        answer = _cached(query)
        if answer is None:
            if spent >= budget:
                raise Stop(f"budget of {budget} searches reached")
            if spent:
                time.sleep(pause)
            spent += 1
            answer = fetcher(query, key)
            if answer is not None and parse(answer) is not None:
                _store(query, answer)
        results = parse(answer) if answer else None
        if results is None:
            failed += 1
            if failed >= MAX_FAILED:
                raise Stop(f"stopped after {failed} failed searches (allowances used up?)")
        else:
            failed = 0
        return results

    def has_fd(team: list[dict]) -> bool:   # a controller alone isn't enough: keep looking for the FD
        return any(p["current"] and people.is_finance_director(p["title"]) for p in team)

    try:
        for number, name, *rest in companies:
            hits: list[tuple[str, str, str]] = []
            team: list[dict] = []
            queries = queries_for(name)
            first = search(queries[0])
            if first is None:
                continue
            hits = dedupe(first)
            team = people_in_results(hits, name)
            if not has_fd(team):
                # staff often list a trading name online ("trading as The BakeRite Company"): one search under it
                given = [n for n in (rest[0] if rest else []) if n]
                seen = given + [n for url, title, snippet in hits if mentions_company(f"{title} {snippet}", name, url)
                                for n in trading_names(f"{title} {snippet}", name)]
                trading = next(iter(trading_names("; ".join(f"trading as {n}" for n in seen), name)), "")
                if trading:
                    results = search(queries_for(trading)[0])
                    if results:
                        team = merge(team, [{**p, "trading_as": trading} for p in people_in_results(results, trading)])
            if not has_fd(team):
                results = search(queries[1])
                if results:
                    hits = dedupe(hits + results)
                    team = merge(people_in_results(hits, name), [p for p in team if p.get("trading_as")])
            found[number] = team
    except Stop as stop:
        return found, str(stop)
    return found, f"ok ({spent} searches)"


def merge(team: list[dict], more: list[dict]) -> list[dict]:
    """Two people_in_results lists as one: the same person found twice keeps the first entry, with both lists' sites."""
    out = [dict(p, sites=list(p["sites"])) for p in team]
    for p in more:
        same = next((q for q in out if people.same_person(q["name"], p["name"])), None)
        if same is None:
            out.append(dict(p, sites=list(p["sites"])))
            continue
        same["sites"] += [s for s in p["sites"] if s not in same["sites"]]
        if not same["url"] and p["url"]:
            same.update(url=p["url"], current=p["current"], title=p["title"] or same["title"], source=p["source"])
    return out
