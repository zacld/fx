"""
sourcer/jobs.py — the job-advert finder (Zac, 22 Nov 2026: "make our job finder new"; the brief of 19 Nov 2026: "the
bottleneck is companies not already prospected" — a mid-sized company advertising a role "paying suppliers in EUR and
USD" shows real currency flows, decided in the UK, and is rarely on anyone's list).

Free job-board APIs only — Adzuna (ADZUNA_APP_ID + ADZUNA_APP_KEY) and Reed (REED_API_KEY), each skipped without its
keys — searched for five kinds of role (`QUERIES`):

  currency   accounts / payments roles that name the currency work ("multi-currency payments", "EUR USD payments")
  treasury   treasury, FX and currency-risk roles
  trade      import / export / shipping / customs / overseas-sourcing roles
  fd         finance director / CFO adverts (the incoming FD reviews the banking and FX)
  abroad     payroll and teams abroad (developers in Poland, call centres in South Africa)

Each advert is read (`read_advert`): the sentence naming currency work, the currencies and countries it names (countries
only beside trade words: suppliers, customers, offices, payments), trade terms (letters of credit, Incoterms, customs
declarations …), and a score 0–100 (`ADVERT_POINTS`). Adverts an agency placed ("our client …") are left out: the
employer they name is the agency. Adverts are grouped by employer (`employers`) — several adverts naming currency work
count more — and the employer is matched to Companies House: a company on the lists by its name, else by a name search
(`pick_company`: the registered name exactly, else the one active company whose name is the same core — "Acme Group
Limited" for "Acme"), cached between runs (`LOOKUP_DAYS`), best employers first. Reed's search returns a snippet, so the
full advert is read for the promising ones (`REED_DETAILS_MAX`).

No AI, nothing sent, no people's names kept (adverts name roles, not people). The adverts and employers are saved for the
Accounts page's Job adverts tab (store key `jobs`, `merge`), the matched employers not on the lists become the finder's
discoveries, and the companies on the lists get alerts (tools/ch_alerts.py).
"""

from __future__ import annotations

import re
import time
import urllib.parse
from collections import Counter
from datetime import date, timedelta
from typing import Callable, Iterable, Optional

from sourcer import matching

KINDS = {"currency": "Currency work", "treasury": "Treasury / FX role", "trade": "Import / export role",
         "fd": "Finance director", "abroad": "Teams abroad"}
# (query, kind, pages). Adzuna's free plan allows ~250 calls a day / 2,500 a month: these are ~65 a run, once a day.
QUERIES: list[tuple[str, str, int]] = [
    *[(q, "currency", 2) for q in (
        "multi-currency payments", "foreign currency payments", "overseas supplier payments", "international payments accounts",
        "FX payments", "currency hedging", "forward contracts finance", "letters of credit", "multi currency accounts payable",
        "EUR USD payments", "foreign currency bank reconciliations", "purchase ledger overseas suppliers",
        "sales ledger export customers", "multi-currency accountant", "foreign exchange accounts assistant")],
    *[(q, "treasury", 1) for q in (
        "treasury analyst", "treasury manager", "treasury accountant", "foreign exchange", "FX hedging", "currency risk",
        "cash management treasury")],
    *[(q, "trade", 1) for q in (
        "import export coordinator", "international trade manager", "export sales manager", "import coordinator",
        "export coordinator", "shipping coordinator", "customs compliance", "Incoterms", "overseas sourcing manager",
        "international buyer", "purchasing far east suppliers", "export administrator")],
    *[(q, "fd", 2) for q in ("finance director", "chief financial officer", "CFO", "head of finance", "group finance director")],
    *[(q, "abroad", 1) for q in ("international payroll", "overseas payroll", "offshore team finance", "global payroll accountant")],
]
ADZUNA_CALLS_MAX = 80       # a run (the free plan: 25 a minute, ~2,500 a month)
ADZUNA_PAUSE = 2.6          # seconds between Adzuna calls: under 25 a minute
REED_CALLS_MAX = 100
REED_DETAILS_MAX = 150      # full adverts read a run (Reed's search gives a snippet)
REED_PAUSE = 0.4
DAYS = 14                   # adverts this recent
KEEP_DAYS = 60              # employers kept on the tab this long after their last advert
LOOKUP_DAYS = 30            # a Companies House name search not found is tried again after this
EMPLOYERS_MAX = 3000

RECRUITERS = re.compile(r"\b(?:hays|michael\s+page|robert\s+(?:half|walters)|reed|page\s+group|harvey\s+nash|"
                        r"randstad|adecco|manpower|recruit|recruitment|resourcing|talent|search\s+partners|staffing|"
                        r"selection|consult(?:ing|ancy)?\s+group|personnel|appointments|headhunt\w*|executive\s+search|"
                        r"careers?\s+(?:ltd|limited)|jobs?\s+(?:ltd|limited))\b", re.I)
# An agency's advert names the agency as the employer: "our client, a leading importer …" — the client unknown.
AGENCY_TEXT = re.compile(r"\b(?:our client|my client|on behalf of (?:our|a|an) (?:client|company)|we are recruiting (?:for|on)|"
                         r"we(?:'re| are) (?:working|partnering) with (?:a|an)|exciting opportunity has arisen with (?:a|an))\b", re.I)
FD_TITLE = re.compile(r"\b(?:finance director|director of finance|financial director|chief financial officer|CFO|"
                      r"head of finance|finance (?:and|&) operations director)\b", re.I)
NOT_FD = re.compile(r"\b(?:interim|assistant|deputy|part[- ]time|fractional)\b", re.I)
TREASURY_TITLE = re.compile(r"\b(?:treasury|treasurer|foreign exchange|FX|currency)\b", re.I)
TRADE_TITLE = re.compile(r"\b(?:import|export|shipping|customs|international trade|overseas|sourcing|buyer|freight|logistics)\w*\b", re.I)
FX_WORDING = re.compile(r"\b(?:multi[- ]?currenc\w*|foreign (?:currency|exchange)|FX\b|forex|currency (?:payments?|"
                        r"accounts?|risk|exposure|hedg\w*|transactions?|bank accounts?|reconciliations?)|"
                        r"forward (?:contracts?|currency)|letters? of credit|international payments?|"
                        r"overseas (?:payments?|suppliers?)|"
                        r"(?:EUR|USD|euro|dollar|€|\$)\s*(?:and|&|/|,)\s*(?:EUR|USD|GBP|euro|dollar|€|\$)|"
                        r"(?:in|into) (?:euros?|dollars?|EUR|USD)|"
                        r"(?:international|overseas|global|multi[- ]country) payroll|offshore (?:team|centre|center|delivery)|"
                        r"nearshore|(?:teams?|office|centre|center|developers?|engineers?) (?:in|based in) (?:Poland|Romania|"
                        r"Bulgaria|Ukraine|India|the Philippines|Philippines|South Africa|Sri Lanka|Vietnam|Egypt|Mexico|Colombia))", re.I)
CURRENCIES = {
    "EUR": r"\bEUR\b|\beuros?\b|€", "USD": r"\bUSD\b|\bUS\s?dollars?\b|\bdollars?\b|US\$", "CNY": r"\bCNY\b|\bRMB\b|\brenminbi\b|\byuan\b",
    "JPY": r"\bJPY\b|\byen\b", "CHF": r"\bCHF\b|\bSwiss francs?\b", "AUD": r"\bAUD\b|\bAustralian dollars?\b",
    "CAD": r"\bCAD\b|\bCanadian dollars?\b", "SEK": r"\bSEK\b|\bSwedish krona\b", "NOK": r"\bNOK\b|\bNorwegian krone\b",
    "DKK": r"\bDKK\b|\bDanish krone\b", "PLN": r"\bPLN\b|\bzloty\b", "INR": r"\bINR\b|\brupees?\b", "HKD": r"\bHKD\b",
    "SGD": r"\bSGD\b", "AED": r"\bAED\b|\bdirhams?\b", "ZAR": r"\bZAR\b|\bSouth African rand\b", "TRY": r"\bTurkish lira\b",
}
_CURRENCY_RE = {c: re.compile(p, re.I) for c, p in CURRENCIES.items()}
COUNTRIES = ("Europe", "European", "the EU", "Far East", "Asia", "China", "Hong Kong", "Taiwan", "Japan", "Korea", "India",
             "Vietnam", "Bangladesh", "Pakistan", "Sri Lanka", "Thailand", "Malaysia", "Indonesia", "the Philippines", "Turkey",
             "the USA", "the US", "United States", "America", "Canada", "Mexico", "Brazil", "Australia", "New Zealand",
             "Germany", "France", "Italy", "Spain", "Portugal", "the Netherlands", "Holland", "Belgium", "Ireland", "Denmark",
             "Sweden", "Norway", "Finland", "Poland", "Czech Republic", "Romania", "Bulgaria", "Ukraine", "Switzerland",
             "Austria", "Greece", "the Middle East", "UAE", "Dubai", "Saudi Arabia", "Israel", "Egypt", "Morocco",
             "South Africa", "Kenya", "Nigeria", "Africa", "Scandinavia", "the Nordics", "Latin America")
_COUNTRY_RE = re.compile(r"\b(" + "|".join(re.escape(c) for c in sorted(COUNTRIES, key=len, reverse=True)) + r")\b")
_TRADE_CONTEXT = re.compile(r"\b(?:suppl\w+|customers?|clients?|offices?|teams?|subsidiar\w+|entit\w+|export\w*|import\w*|"
                            r"ship\w*|sourc\w+|factor(?:y|ies)|manufactur\w+|payments?|pay(?:ing)?|invoic\w+|operations?|"
                            r"distributors?|partners?|markets?|growers?|vendors?|sites?|branches)\b", re.I)
TERMS = {"letters of credit": r"letters? of credit", "Incoterms": r"incoterms?", "customs declarations": r"customs (?:declarations?|clearance|entr(?:y|ies))",
         "bills of lading": r"bills? of lading", "forward contracts": r"forward (?:contracts?|currency)", "hedging": r"(?:currency|FX|foreign exchange|interest rate)\s+hedg\w*|\bhedg\w*\s+(?:policy|strateg\w*|programmes?|programs?|instruments?|accounting)",
         "intercompany": r"inter-?company", "import duty / VAT": r"import (?:duty|VAT)|duty (?:and|&) VAT", "EORI": r"\bEORI\b",
         "proforma invoices": r"pro-?forma", "freight": r"\bfreight\b", "revaluation": r"revaluation|retranslation"}
_TERM_RE = {k: re.compile(p, re.I) for k, p in TERMS.items()}
ADVERT_POINTS = {"wording": 30, "currency": 8, "currency_max": 24, "country": 4, "country_max": 16, "term": 6, "term_max": 18,
                 "fd": 20, "treasury": 15, "trade": 8, "repeat": 5, "repeat_max": 15}
# Employers whose adverts describe other companies' work, not their own currency flows (the first live run, 22 Nov 2026:
# most "new leads" were recruitment agencies — Morgan McKinley, Robertson Bell, Office Angels — plus a job board, an FX
# payments firm and an actuarial consultancy): by the register's sector codes (all of them in these), else the name, else
# an advert spread no single employer has.
EXCLUDED_SIC = (("78", "a recruitment agency"), ("692", "an accountancy practice — its adverts are client work"),
                ("7022", "a consultancy — its adverts are client work"), ("6312", "a job board or web portal"))
PAYMENTS_NAME = re.compile(r"\b(?:payments?|pay|fx|forex|currency|currencies|exchange|money|remit\w*|transfers?)\b", re.I)
AGENCY_NAME = re.compile(r"\b(?:people|personnel|careers?|jobs|talent|recruit\w*|resourcing|staffing|appointments|search|"
                         r"selection|headhunt\w*|angels)\b", re.I)
# Banks and financial groups advertise treasury / FX roles for their own markets business; their name matches a UK entity
# (a holding or service company) whose sector codes may not say bank.
BIG_FINANCE = re.compile(r"\b(?:citi(?:group|bank)?|wells fargo|j\.? ?p\.? ?morgan|jpmorgan|goldman sachs|morgan stanley|barclays|"
                         r"hsbc|lloyds|natwest|royal bank|santander|deutsche bank|bnp paribas|societe generale|soci[ée]t[ée] g[ée]n[ée]rale|"
                         r"ubs|credit suisse|bank of america|merrill|nomura|mizuho|mufg|smbc|sumitomo mitsui|standard chartered|"
                         r"investec|rothschild|lazard|jefferies|blackrock|state street|bny|mellon|northern trust|macquarie|"
                         r"natixis|ing bank|rabobank|abn amro|commerzbank|unicredit|intesa|nordea|danske|handelsbanken|"
                         r"close brothers|metro bank|virgin money|tsb|coutts|schroders|aviva|legal (?:and|&) general|"
                         r"prudential|m ?& ?g|phoenix group|lseg|london stock exchange|ice futures|cme group)\b", re.I)
AGENCY_SPREAD = {"kinds": 4, "adverts": 8}   # this many kinds of role, or adverts, in DAYS days: an agency, not an employer
LOOKUP_MIN = 30             # an employer not on the lists is looked up when its best advert scores this
LEAD_MIN = 40               # … and becomes a new lead when it scores this, or names currency work, or advertises an FD


def _plain(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(text or ""))).strip()


def _sentences(text: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?])\s+|\s*[•·\n]\s*", text) if s.strip()]


def agency_advert(advert: dict) -> bool:
    return bool(RECRUITERS.search(advert.get("employer", ""))) or bool(AGENCY_TEXT.search(_plain(advert.get("text", ""))))


def fx_wording(advert: dict) -> str:
    """The sentence of an advert (title, then its text) that names currency work — "paying suppliers in EUR and USD",
    "multi-currency bank accounts", "FX hedging" — or "". Sentences about a recruiter's own pitch are skipped."""
    text = _plain(f"{advert.get('title', '')}. {advert.get('text', '')}")
    for sentence in _sentences(text):
        if FX_WORDING.search(sentence) and not AGENCY_TEXT.search(sentence):
            return re.sub(r"\s+", " ", sentence).strip()[:240]
    return ""


def read_advert(advert: dict) -> dict:
    """{kind, quote, quotes, currencies, countries, terms, score, why} for one advert."""
    title = advert.get("title", "")
    text = _plain(f"{title}. {advert.get('text', '')}")
    quotes = []
    for s in _sentences(text):
        if FX_WORDING.search(s) and not AGENCY_TEXT.search(s) and s.strip() not in quotes:
            quotes.append(re.sub(r"\s+", " ", s).strip()[:240])
        if len(quotes) == 3:
            break
    currencies = [c for c, rx in _CURRENCY_RE.items() if rx.search(text)]
    countries: list[str] = []
    for s in _sentences(text):
        if _TRADE_CONTEXT.search(s):
            for c in _COUNTRY_RE.findall(s):
                name = {"European": "Europe", "the EU": "Europe", "Holland": "the Netherlands", "the US": "the USA",
                        "United States": "the USA", "America": "the USA", "Dubai": "UAE"}.get(c, c)
                if name not in countries:
                    countries.append(name)
    terms = [k for k, rx in _TERM_RE.items() if rx.search(text)]
    fd = bool(FD_TITLE.search(title)) and not NOT_FD.search(title)
    kind = ("fd" if fd else "treasury" if TREASURY_TITLE.search(title) else "abroad" if re.search(r"payroll|offshore|nearshore", text, re.I) and quotes
            else "currency" if quotes else "trade" if TRADE_TITLE.search(title) else advert.get("query_kind") or "other")
    p = ADVERT_POINTS
    why = []
    score = 0
    if quotes:
        score += p["wording"]
        why.append("names currency work")
    if currencies:
        score += min(p["currency_max"], p["currency"] * len(currencies))
        why.append(", ".join(currencies))
    if countries:
        score += min(p["country_max"], p["country"] * len(countries))
        why.append(", ".join(countries[:4]))
    if terms:
        score += min(p["term_max"], p["term"] * len(terms))
        why.append(", ".join(terms[:3]))
    score += p["fd"] if kind == "fd" else p["treasury"] if kind == "treasury" else p["trade"] if kind == "trade" else 0
    return {"kind": kind, "quote": quotes[0] if quotes else "", "quotes": quotes, "currencies": currencies,
            "countries": countries, "terms": terms, "score": min(100, score), "why": why, "fd": fd}


# --- fetching -------------------------------------------------------------------------------------------------------

def _reed_date(d: str) -> str:
    return f"{d[6:10]}-{d[3:5]}-{d[0:2]}" if re.match(r"\d\d/\d\d/\d{4}", d or "") else (d or "")[:10]


def fetch_adverts(fetch_json: Callable, adzuna: tuple[str, str] = ("", ""), reed: str = "", sleep: Callable = time.sleep,
                  queries: Optional[list] = None, stats: Optional[dict] = None) -> list[dict]:
    """[{employer, title, date, link, text, source, query, query_kind, id}] from both boards, last DAYS days; agency
    adverts left out. `stats` gets per-query counts ({query: {kind, adverts, kept}})."""
    queries = queries if queries is not None else QUERIES
    stats = stats if stats is not None else {}
    app_id, app_key = adzuna
    out: list[dict] = []
    calls = {"adzuna": 0, "reed": 0}
    for q, kind, pages in queries:
        got: list[dict] = []
        for page in range(1, pages + 1) if app_id and app_key else ():
            if calls["adzuna"] >= ADZUNA_CALLS_MAX:
                break
            if calls["adzuna"]:
                sleep(ADZUNA_PAUSE)
            calls["adzuna"] += 1
            url = (f"https://api.adzuna.com/v1/api/jobs/gb/search/{page}?" + urllib.parse.urlencode(
                {"app_id": app_id, "app_key": app_key, "what": q, "max_days_old": DAYS, "results_per_page": 50, "sort_by": "date"}))
            for j in (fetch_json(url, None) or {}).get("results") or []:
                got.append({"employer": (j.get("company") or {}).get("display_name", ""), "title": j.get("title", ""),
                            "date": (j.get("created") or "")[:10], "link": j.get("redirect_url", ""),
                            "text": j.get("description", ""), "source": "Adzuna", "id": f"adzuna:{j.get('id', '')}"})
        for page in range(pages) if reed else ():
            if calls["reed"] >= REED_CALLS_MAX:
                break
            if calls["reed"]:
                sleep(REED_PAUSE)
            calls["reed"] += 1
            params = {"keywords": q, "resultsToTake": 100, "resultsToSkip": 100 * page}
            if kind in ("trade", "treasury"):        # broad roles: mostly agencies otherwise
                params["postedByDirectEmployer"] = "true"
            url = "https://www.reed.co.uk/api/1.0/search?" + urllib.parse.urlencode(params)
            for j in (fetch_json(url, reed) or {}).get("results") or []:
                got.append({"employer": j.get("employerName", ""), "title": j.get("jobTitle", ""), "date": _reed_date(j.get("date") or ""),
                            "link": j.get("jobUrl", ""), "text": j.get("jobDescription", ""), "source": "Reed",
                            "id": f"reed:{j.get('jobId', '')}"})
        kept = [dict(a, query=q, query_kind=kind) for a in got if a["employer"] and not agency_advert(a)]
        stats[q] = {"kind": kind, "adverts": len(got), "kept": len(kept)}
        out += kept
    stats["_calls"] = calls
    return out


def read_full_reed(adverts: list[dict], fetch_json: Callable, reed: str, sleep: Callable = time.sleep,
                   limit: int = REED_DETAILS_MAX) -> int:
    """Reads the whole advert (Reed's search gives a snippet) for promising Reed adverts with no currency wording in the
    snippet — currency, treasury, trade and teams-abroad searches, one per employer and title. Updates the adverts in
    place (`text` replaced by the full advert, `full` set, `agency` when the full text shows an agency's advert) and
    returns how many were read."""
    if not reed or limit <= 0:
        return 0
    seen, done = set(), 0
    for a in adverts:
        if done >= limit:
            break
        if a.get("source") != "Reed" or a.get("query_kind") == "fd" or fx_wording(a) or not a.get("id", "").startswith("reed:"):
            continue
        key = (matching.normalise_name(a["employer"]), a["title"].lower())
        if key in seen:
            continue
        seen.add(key)
        if done:
            sleep(REED_PAUSE)
        done += 1
        full = fetch_json(f"https://www.reed.co.uk/api/1.0/jobs/{a['id'].split(':', 1)[1]}", reed) or {}
        if full.get("jobDescription"):
            a["text"] = full["jobDescription"]
            a["full"] = True
            if AGENCY_TEXT.search(_plain(a["text"])):
                a["agency"] = True
    return done


# --- employers ------------------------------------------------------------------------------------------------------

def employers(adverts: Iterable[dict]) -> dict[str, dict]:
    """{employer key: {employer, adverts [read, best first], score, kinds, currencies, countries, terms, quote, fd}} —
    one per employer; several adverts naming currency work add ADVERT_POINTS["repeat"] each."""
    out: dict[str, dict] = {}
    for a in adverts:
        if a.get("agency"):
            continue
        key = matching.normalise_name(a["employer"])
        if not key:
            continue
        r = read_advert(a)
        e = out.setdefault(key, {"key": key, "employer": a["employer"], "adverts": [], "links": set()})
        link = a.get("link") or a.get("id") or f"{a['title']}|{a.get('date')}"
        if link in e["links"] or any(x["title"].lower() == a["title"].lower() for x in e["adverts"]):
            continue
        e["links"].add(link)
        e["adverts"].append({"title": a["title"][:120], "date": a.get("date", ""), "link": a.get("link", ""),
                             "source": a.get("source", ""), "query": a.get("query", ""), **r})
    for e in out.values():
        e.pop("links")
        e["adverts"].sort(key=lambda x: x["date"], reverse=True)       # newest first, then (stable) best first
        e["adverts"].sort(key=lambda x: -x["score"])
        best = e["adverts"][0]
        worded = sum(1 for x in e["adverts"] if x["quote"])
        e["score"] = min(100, best["score"] + min(ADVERT_POINTS["repeat_max"], ADVERT_POINTS["repeat"] * max(0, worded - 1)))
        e["kinds"] = sorted({x["kind"] for x in e["adverts"]} - {"other"})
        e["currencies"] = sorted({c for x in e["adverts"] for c in x["currencies"]})
        e["countries"] = sorted({c for x in e["adverts"] for c in x["countries"]})
        e["terms"] = sorted({t for x in e["adverts"] for t in x["terms"]})
        e["quote"] = next((x["quote"] for x in e["adverts"] if x["quote"]), "")
        e["fd"] = any(x["fd"] for x in e["adverts"])
        e["last_seen"] = max((x["date"] for x in e["adverts"] if x["date"]), default="")
    return out


_CORE_DROP = {"GROUP", "HOLDINGS", "HOLDING", "INTERNATIONAL", "EUROPE", "GLOBAL", "SERVICES", "SOLUTIONS", "TRADING"}


def _core(name: str) -> str:
    words = matching.normalise_name(name).split()
    while len(words) > 1 and words[-1] in _CORE_DROP:
        words.pop()
    return " ".join(words)


def pick_company(name: str, items: list[dict]) -> Optional[dict]:
    """The active company among a Companies House name search's items whose registered name is the employer's (case,
    punctuation and Ltd / Limited aside); else the only active one whose name is the same core ("ACME GROUP LIMITED"
    for "Acme", "ACME LIMITED" for "Acme Group") — two such and it's left unmatched."""
    want = matching.normalise_name(name)
    active = [i for i in items or [] if i.get("company_status") == "active" and i.get("company_number")]
    for i in active:
        if matching.normalise_name(i.get("title", "")) == want:
            return {"company_number": i["company_number"], "company_name": i.get("title", ""), "match": "exact"}
    core = _core(name)
    if len(core) < 4:
        return None
    same = [i for i in active if _core(i.get("title", "")) == core]
    if len(same) == 1:
        return {"company_number": same[0]["company_number"], "company_name": same[0].get("title", ""), "match": "core"}
    return None


def excluded(employer: dict, name: str = "", sic: Optional[list] = None, status: str = "", kind: str = "") -> str:
    """Why an employer's adverts don't make it a lead, or "": a recruitment agency, job board, accountancy practice,
    consultancy, payments / FX firm (sector codes, then name), anything sourcer/absurd.py rules out (a bank, insurer,
    fund, public body, not-for-profit, not trading), or an agency's spread of adverts (AGENCY_SPREAD)."""
    from sourcer import absurd
    name = name or employer.get("employer", "")
    codes = [str(c) for c in sic or [] if c]
    if codes:
        hits = [next((why for prefix, why in EXCLUDED_SIC if c.startswith(prefix)), "") for c in codes]
        if all(hits):
            return f"{hits[0][0].upper()}{hits[0][1:]} (sector {codes[0]})"
        if all(c[:2] in ("64", "66") for c in codes) and PAYMENTS_NAME.search(name):
            return f"A payments / FX firm (sector {codes[0]}) — a competitor"
    if RECRUITERS.search(name) or AGENCY_NAME.search(name) or RECRUITERS.search(employer.get("employer", "")):
        return "A recruitment agency or job board, by its name"
    if BIG_FINANCE.search(name) or BIG_FINANCE.search(employer.get("employer", "")):
        return "A bank or financial group — its treasury / FX roles are its own markets business"
    if sic is not None or status:
        why = absurd.reason(name, {"status": status or "active", "type": kind, "sic_codes": codes, "name": name})
        if why:
            return why
    if len(employer.get("kinds") or []) >= AGENCY_SPREAD["kinds"] or len(employer.get("adverts") or []) >= AGENCY_SPREAD["adverts"]:
        return f"{len(employer.get('adverts') or [])} different finance roles in {DAYS} days — probably an agency"
    return ""


def lookup_due(cache: dict, key: str, today: date) -> bool:
    c = cache.get(key)
    if not c:
        return True
    if c.get("company_number"):
        return False
    try:
        return (today - date.fromisoformat(c.get("at", "")[:10])).days >= LOOKUP_DAYS
    except ValueError:
        return True


def merge(previous: dict, found: dict[str, dict], today: date) -> dict[str, dict]:
    """The Job adverts tab's employers: this run's merged into the last (adverts joined by title, first_seen kept), those
    with no advert in KEEP_DAYS dropped, best first, at most EMPLOYERS_MAX."""
    out = {e["key"]: e for e in (previous or {}).get("employers") or [] if e.get("key")}
    for key, e in found.items():
        old = out.get(key)
        if old:
            titles = {a["title"].lower() for a in e["adverts"]}
            e["adverts"] = (e["adverts"] + [a for a in old.get("adverts") or [] if a["title"].lower() not in titles])[:12]
            e["first_seen"] = old.get("first_seen") or today.isoformat()
            for k in ("company_number", "company_name", "match", "status"):
                if not e.get(k) and old.get(k):
                    e[k] = old[k]
        else:
            e["first_seen"] = today.isoformat()
        out[key] = e
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()
    kept = [e for e in out.values() if (e.get("last_seen") or e.get("first_seen") or "") >= cutoff]
    kept.sort(key=lambda e: (-(e.get("score") or 0), e.get("employer", "")))
    return {e["key"]: e for e in kept[:EMPLOYERS_MAX]}


def query_stats(stats: dict, by_key: dict[str, dict]) -> list[dict]:
    """Which searches pay: per query, adverts found / kept and how many named currency work or became leads."""
    worded: Counter = Counter()
    leads: Counter = Counter()
    for e in by_key.values():
        for a in e["adverts"]:
            if a.get("quote"):
                worded[a.get("query", "")] += 1
            if e.get("status") == "new_lead":
                leads[a.get("query", "")] += 1
    return [{"query": q, "kind": s["kind"], "adverts": s["adverts"], "kept": s["kept"], "worded": worded[q], "leads": leads[q]}
            for q, s in stats.items() if not q.startswith("_")]
