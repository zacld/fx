"""
sourcer/hooks.py — call hooks and currency exposure for each company: the
specific, document-backed facts a Finance Director cold call can open on.

Columns (see columns()):
  fact_1, fact_2                              the two strongest facts to open on, in HOOK_RULES priority
  main_currency, currency_direction           e.g. "USD", "Buys (importer)"
  currency_evidence, currency_confidence      the quote or figure behind it, High / Medium / Low
  opener                                      one call sentence built only from the columns above

Hard rules: every figure, date and name in a detail column comes from a
record already fetched for this company (Companies House officers,
charges, PSC register, filing history, the filed accounts, the news
headline) and names that source in brackets. Nothing is estimated; money
is shown exactly, or rounded down ("£312k" for £312,456), never up. When
nothing qualifies a column stays blank. No AI and no extra API calls: the
accounts evidence is read while the document is already open
(text_evidence() / regions, called from sourcer/accounts.py).
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Optional

from sourcer import people, profiles, signals, triggers

# Every threshold in one place, to tune against real call outcomes.
HOOK_RULES = {
    "new_finance_officer_days": 90,      # 1. FD/CFO appointed within this many days
    "fx_gain_loss_min_gbp": 50_000,      # 2. FX gain or loss on the latest accounts, at least this (either sign)
    "new_charge_days": 365,              # 3. charge registered within this many days
    "turnover_growth_min": 0.20,         # 4. turnover growth year on year, at least this
    "accounts_filed_days": 30,           # 6. accounts filed within this many days
    "facility_end_months": 18,           # bank: a facility the accounts say ends within this many months
    "bank_since_years": triggers.RENEWAL_YEARS,   # bank: main bank's debenture in its renewal window (3-5 years)
    # Which fact leads: the bank angle first (Investec is a bank — refinancing opens the door, FX is the
    # cross-sell), then the FX and company facts. Reorder to change what fact_1 / the opener lead with.
    "order": ["facility_end", "charge", "bank_since", "officer", "fx", "growth", "group", "filed"],
    "currency_high_mentions": 3,         # currency named this often (or with purchases/sales wording) = High
    "max_mentions_kept": 60,             # currency mentions kept per document
}

COLUMNS = ["fact_1", "fact_2", "main_currency", "currency_direction",
           "currency_evidence", "currency_confidence", "opener"]

BUYS, SELLS, BOTH, UNKNOWN = "Buys (importer)", "Sells (exporter)", "Both", "Unknown"
BANK_KINDS = ("facility_end", "charge", "bank_since")
HIGH, MEDIUM, LOW = "High", "Medium", "Low"

_MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
_MONTH_NAMES = ("January February March April May June July August September October November December").split()

# --- Countries and currencies --------------------------------------------------

# signals.UK_NAMES, plus places group notes and region tables use. (Unlike currency.currency_for, which
# gives the usual invoicing currency for trade with a country, COUNTRY_CURRENCY is the country's own
# currency: a German parent runs in euros whatever its trade is invoiced in.)
_UK_PLACES = set(signals.UK_NAMES) | {"BRITAIN", "GB", "JERSEY", "GUERNSEY", "ISLE OF MAN", "CHANNEL ISLANDS",
                                      "DOMESTIC", "HOME"}
_EURO_COUNTRIES = ("Ireland|Republic of Ireland|Netherlands|The Netherlands|Holland|Germany|France|Italy|Spain|Belgium|"
                   "Luxembourg|Austria|Finland|Portugal|Greece|Cyprus|Malta|Estonia|Latvia|Lithuania|Slovakia|Slovenia|"
                   "Croatia|Monaco").split("|")
COUNTRY_CURRENCY = {
    **{c.upper(): "EUR" for c in _EURO_COUNTRIES},
    "UNITED STATES": "USD", "UNITED STATES OF AMERICA": "USD", "USA": "USD", "U.S.A.": "USD", "US": "USD",
    "AMERICA": "USD", "DELAWARE": "USD", "CANADA": "CAD", "MEXICO": "MXN", "BRAZIL": "BRL",
    "SWITZERLAND": "CHF", "SWEDEN": "SEK", "NORWAY": "NOK", "DENMARK": "DKK", "POLAND": "PLN",
    "CZECH REPUBLIC": "CZK", "CZECHIA": "CZK", "HUNGARY": "HUF", "ROMANIA": "RON", "TURKEY": "TRY", "TÜRKIYE": "TRY",
    "JAPAN": "JPY", "CHINA": "CNY", "PEOPLE'S REPUBLIC OF CHINA": "CNY", "PRC": "CNY", "HONG KONG": "HKD",
    "SINGAPORE": "SGD", "INDIA": "INR", "AUSTRALIA": "AUD", "NEW ZEALAND": "NZD", "SOUTH AFRICA": "ZAR",
    "UNITED ARAB EMIRATES": "AED", "UAE": "AED", "DUBAI": "AED", "SOUTH KOREA": "KRW", "KOREA": "KRW",
    "TAIWAN": "TWD", "THAILAND": "THB", "VIETNAM": "VND", "MALAYSIA": "MYR", "INDONESIA": "IDR",
    "ISRAEL": "ILS", "SAUDI ARABIA": "SAR", "PAKISTAN": "PKR", "BANGLADESH": "BDT", "SRI LANKA": "LKR",
}
# Regions in a turnover-by-geography note.
_REGION_CURRENCY = [
    (re.compile(r"\b(?:europe|european union|eurozone|euro zone|\beu\b)", re.I), "EUR"),
    (re.compile(r"\b(?:north america|united states|usa|\bus\b|americas)\b", re.I), "USD"),
]
CURRENCY_NAMES = {"USD": "dollar", "EUR": "euro", "CNY": "renminbi", "JPY": "yen", "CHF": "Swiss franc",
                  "SEK": "Swedish krona", "NOK": "Norwegian krone", "DKK": "Danish krone", "PLN": "zloty",
                  "CAD": "Canadian dollar", "AUD": "Australian dollar", "NZD": "New Zealand dollar",
                  "HKD": "Hong Kong dollar", "SGD": "Singapore dollar", "INR": "rupee", "ZAR": "rand",
                  "AED": "dirham", "TRY": "lira", "CZK": "koruna", "HUF": "forint"}

# Currency names and codes in accounts text, longest names first (so "Canadian dollar" isn't read as USD).
_CURRENCY_WORDS = [
    (r"Hong\s+Kong\s+dollars?|HK\$", "HKD"), (r"Canadian\s+dollars?|C\$", "CAD"), (r"Australian\s+dollars?|A\$", "AUD"),
    (r"New\s+Zealand\s+dollars?", "NZD"), (r"Singapore\s+dollars?|S\$", "SGD"),
    (r"U\.?S\.?\s+dollars?|United\s+States\s+dollars?|American\s+dollars?|US\$|\bdollars?\b", "USD"),
    # not "Euro 6 standard" / "Euro VI vehicles" (the emissions standard), but "euros 2 million" counts
    (r"\beuros?\b(?!\s*(?:[1-7]|VI|IV|V)\b\s*(?:standard|emission|engine|compliant|vehicle|lorr|truck|diesel|fleet))|€",
     "EUR"),
    (r"Chinese\s+(?:yuan|renminbi)|\brenminbi\b|\byuan\b", "CNY"),
    (r"Japanese\s+yen|\byen\b", "JPY"), (r"Swiss\s+francs?", "CHF"), (r"Swedish\s+kron(?:a|or)", "SEK"),
    (r"Norwegian\s+kron(?:e|er)", "NOK"), (r"Danish\s+kron(?:e|er)", "DKK"), (r"Polish\s+zlot(?:y|ys)|\bzloty\b", "PLN"),
    (r"Indian\s+rupees?", "INR"), (r"South\s+African\s+rand", "ZAR"), (r"\bdirhams?\b", "AED"),
    (r"Turkish\s+lir(?:a|as)", "TRY"),
]
_CODES = "USD EUR CNY RMB JPY CHF SEK NOK DKK PLN CAD AUD NZD HKD SGD INR ZAR AED TRY CZK HUF MXN BRL KRW TWD THB".split()
_CURRENCY_RE = re.compile("|".join(f"(?P<c{i}>(?i:{p}))" for i, (p, _) in enumerate(_CURRENCY_WORDS))
                          + "|" + r"(?<![:\w])(?P<code>" + "|".join(_CODES) + r")\b")
_BUY_WORDS = re.compile(r"purchas|supplier|import|cost of sales|procure|bought|sourc|raw material|payable|creditor", re.I)
_SELL_WORDS = re.compile(r"\bsales\b|\bsell|\bsold\b|revenue|turnover|customer|export|receivable|debtor|income", re.I)

# "The ultimate parent undertaking is X GmbH, incorporated in Germany"; "subsidiary ... registered in Ireland".
_GROUP_RE = re.compile(
    r"(?P<rel>(?i:(?:ultimate|immediate)\s+(?:parent|holding|controlling)\s+(?:company|undertaking|entity|party)|"
    r"parent\s+(?:company|undertaking)|subsidiar(?:y|ies)(?:\s+undertakings?)?))"
    r"(?P<mid>[^.;]{0,160}?)\b(?i:incorporated|registered|domiciled|established)\s+(?i:in)\s+(?:(?i:the)\s+)?"
    r"(?P<country>[A-Z][A-Za-z'’]+(?:\s+(?:of\s+)?[A-Z][A-Za-z'’]+){0,3})", re.S)


# --- Small helpers -----------------------------------------------------------------

def _d(iso: str) -> Optional[date]:
    try:
        return date.fromisoformat((iso or "")[:10])
    except ValueError:
        return None


def day(iso: str) -> str:
    """"2026-09-02" -> "2 Sep 2026"."""
    d = _d(iso)
    return f"{d.day} {_MONTHS[d.month - 1]} {d.year}" if d else iso


def month(iso: str) -> str:
    """"2026-09-02" -> "September 2026"."""
    d = _d(iso)
    return f"{_MONTH_NAMES[d.month - 1]} {d.year}" if d else iso


def exact(value: float) -> str:
    """£312,456 — the figure exactly as filed (no sign)."""
    return f"£{abs(value):,.0f}"


def short(value: float) -> str:
    """£312k / £58.1m, rounded down so a claim is never bigger than the filing."""
    v = int(abs(value))
    if v >= 1_000_000:
        return f"£{v // 100_000 / 10:.1f}m".replace(".0m", "m")
    if v >= 1_000:
        return f"£{v // 1_000}k"
    return f"£{v}"


_ORG_WORDS = re.compile(r"\b(?:LTD|LIMITED|PLC|LLP|BANK|AB|AG|BV|NV|SA|SAS|GMBH|INC|LLC|CORPORATION|"
                        r"COMPANY|CO|TRUSTEES?|BUILDING SOCIETY|FINANCE|CAPITAL)\b", re.I)
_DEFUNCT = re.compile(r"\b(?:in administration|in liquidation|in receivership|dissolved)\b", re.I)


def is_lender(holder: str) -> bool:
    """A charge holder worth opening a bank conversation on: an organisation, not a person or a failed firm."""
    return bool(_ORG_WORDS.search(holder or "")) and not _DEFUNCT.search(holder or "")


def country_currency(place: str) -> Optional[str]:
    return COUNTRY_CURRENCY.get(" ".join((place or "").upper().split()))


def is_uk(place: str) -> bool:
    return " ".join((place or "").upper().replace(".", "").split()) in _UK_PLACES | {""}


def region_currency(region: str) -> Optional[str]:
    """Currency for a region or country in a turnover note ("Europe" -> EUR, "North America" -> USD)."""
    found = country_currency(region)
    if found:
        return found
    return next((ccy for pattern, ccy in _REGION_CURRENCY if pattern.search(region)), None)


def _sentence(text: str, start: int, end: int, limit: int = 240) -> str:
    """
    The sentence around text[start:end] (bounded by ". " or a blank line),
    whitespace collapsed; if longer than `limit`, trimmed around the match so
    the match itself is always kept.
    """
    raw_pre, raw_post = text[max(0, start - 300):start], text[end:end + 300]
    if "\n\n" in raw_pre:
        raw_pre = raw_pre[raw_pre.rindex("\n\n"):]
    if "\n\n" in raw_post:
        raw_post = raw_post[:raw_post.index("\n\n")]
    # Collapse whitespace with markers around the match, so positions stay right after collapsing.
    flat = " ".join(f"{raw_pre}\x00{text[start:end]}\x01{raw_post}".split())
    pre, rest = flat.split("\x00", 1)
    match, post = rest.split("\x01", 1)
    if ". " in pre:
        pre = pre[pre.rindex(". ") + 2:]
    if ". " in post:
        post = post[:post.index(". ")]
    room = max(0, (limit - len(match)) // 2)
    if len(pre) > room:
        pre = "…" + pre[len(pre) - room:].lstrip()
    if len(post) > room:
        post = post[:room].rstrip() + "…"
    return (pre + match + post).strip(" .;:")


def _direction(sentence: str) -> tuple[bool, bool]:
    s = sentence.lower()
    buys = bool(_BUY_WORDS.search(s))
    sells = bool(_SELL_WORDS.search(s.replace("cost of sales", "")))
    return buys, sells


# --- Evidence read from the accounts document (called by sourcer/accounts.py) ------------------

def text_evidence(text: str) -> dict:
    """
    From an accounts document's plain text:
      currency_mentions  [{"code", "sentence", "buys", "sells"}] — each foreign currency named (not sterling)
      group_abroad       [{"relation": "parent" | "subsidiary", "country", "sentence"}] — group companies
                         incorporated outside the UK
    """
    text = text or ""
    mentions = []
    for m in _CURRENCY_RE.finditer(text):
        code = _code_of(m)
        sentence = _sentence(text, m.start(), m.end())
        if re.search(r"iso4217", sentence, re.I):
            continue
        buys, sells = _direction(sentence)
        mentions.append({"code": code, "sentence": sentence, "buys": buys, "sells": sells})
        if len(mentions) >= HOOK_RULES["max_mentions_kept"]:
            break
    group = []
    for m in _GROUP_RE.finditer(text):
        country = m.group("country").strip()
        words = country.split()
        # "incorporated in England and Wales" / "in the United Kingdom": keep the longest known place
        for n in range(len(words), 0, -1):
            candidate = " ".join(words[:n])
            if country_currency(candidate) or is_uk(candidate):
                country = candidate
                break
        if is_uk(country) or not country_currency(country):
            continue
        rel, mid = m.group("rel").lower(), m.group("mid").lower()
        if rel.startswith("subsidiar"):
            # "a wholly owned subsidiary of Foo GmbH, incorporated in Germany": Germany is the parent's country
            relation = "parent" if re.match(r"\s*(?:undertaking\s+)?of\b", mid) else "subsidiary"
        elif "subsidiar" in mid:
            continue  # "the parent company's subsidiaries are incorporated in France": not this company's
        else:
            relation = "parent"
        sentence = _sentence(text, m.start(), m.end())
        if not any(g["country"] == country and g["relation"] == relation for g in group):
            group.append({"relation": relation, "country": country, "sentence": sentence})
    return {"currency_mentions": mentions, "group_abroad": group}


# --- Hooks ------------------------------------------------------------------------------------

def _source_accounts(facts: dict) -> str:
    how = {"ixbrl": "tagged figure", "pdf": "accounts text", "scanned pdf": "scanned accounts, OCR"}.get(
        facts.get("format", ""), "filed accounts")
    end = facts.get("period_end", "")
    return f"filed accounts{', year to ' + day(end) if end else ''}, {how}"


def find_hooks(facts: Optional[dict], officers: list[dict], charges: list[dict], owners: list[dict],
               news_people: Optional[list[dict]] = None, today: Optional[date] = None) -> list[dict]:
    """
    Every hook that qualifies, strongest first (HOOK_RULES order):
    [{"kind", "label", "detail", "lead"}] — `lead` is the opener's first clause,
    using only facts in `detail`.
    """
    today = today or date.today()
    f = facts or {}
    rules = HOOK_RULES
    hooks: list[dict] = []

    # 1. New finance officer: Companies House appointment (occupation as filed), else a news headline.
    since = (today - timedelta(days=rules["new_finance_officer_days"])).isoformat()
    officer = next((o for o in sorted(officers, key=lambda o: o.get("appointed_on") or "", reverse=True)
                    if (o.get("appointed_on") or "") >= since and people.is_finance_director(o.get("occupation", ""))),
                   None)
    if officer:
        hooks.append({"kind": "officer", "label": "New finance director appointed",
                      "detail": f"{officer['name']} appointed {officer['role'].lower()} {day(officer['appointed_on'])}, "
                                f"occupation {officer['occupation']} (Companies House officers)",
                      "lead": f"Congratulations on joining as {officer['occupation']} in {month(officer['appointed_on'])}"})
    else:
        named = next((p for p in news_people or [] if (p.get("date") or "") >= since
                      and people.is_finance_director(p.get("title", ""))), None)
        if named:
            hooks.append({"kind": "officer", "label": "New finance director appointed",
                          "detail": f"{named['name']} named {named['title']} in the news, {day(named['date'])} "
                                    f"({named.get('note', 'news headline').split(',')[0]} via Google News)",
                          "lead": f"Congratulations on the new {named['title']} role"})

    # 2. FX gain or loss on the latest accounts.
    fx = f.get("fx_gain_loss")
    if fx is not None and abs(fx) >= rules["fx_gain_loss_min_gbp"]:
        kind = "loss" if fx < 0 else "gain"
        prior = f.get("fx_gain_loss_prior")
        before = f"; year before: {exact(prior)} {'loss' if prior < 0 else 'gain'}" if prior else ""
        end = f.get("period_end", "")
        hooks.append({"kind": "fx", "label": f"FX {kind} on accounts", "value": fx, "period": end,
                      "detail": f"{exact(fx)} foreign exchange {kind}{', year to ' + day(end) if end else ''}{before} "
                                f"({_source_accounts(f)})",
                      "lead": f"Saw your accounts show a {short(fx)} FX {kind}"
                              f"{' for the year to ' + month(end) if end else ''}"})

    # 3. New charge registered.
    since = (today - timedelta(days=rules["new_charge_days"])).isoformat()
    fresh = sorted((c for c in charges if (c.get("created_on") or "") >= since and is_lender(c["name"])),
                   key=lambda c: c["created_on"], reverse=True)
    if fresh:
        c = fresh[0]
        hooks.append({"kind": "charge", "label": "New charge registered",
                      "detail": f"Charge registered {day(c['created_on'])} to {c['name']} (Companies House charges register)",
                      "lead": f"Saw a new charge to {c['name']} went on the register in {month(c['created_on'])}"})

    # 4. Turnover growth (both figures from the same filing).
    now, before = f.get("turnover"), f.get("turnover_prior")
    if now and before and before > 0 and now / before - 1 >= rules["turnover_growth_min"]:
        pct = int((now / before - 1) * 100)          # rounded down
        end = f.get("period_end", "")
        hooks.append({"kind": "growth", "label": "Turnover growth",
                      "detail": f"Turnover {exact(now)}{' in the year to ' + day(end) if end else ''}, up {pct}% from "
                                f"{exact(before)} the year before ({_source_accounts(f)})",
                      "lead": f"Saw turnover grew {pct}% to {short(now)}"
                              f"{' in the year to ' + month(end) if end else ''}"})

    # 5. Overseas parent (PSC register) or group company (accounts text).
    parent = next((o for o in owners if o.get("kind") == "corporate" and not o.get("ceased_on")
                   and not is_uk(o.get("country", "")) and country_currency(o.get("country", ""))), None)
    if parent:
        country = " ".join(w.capitalize() if w.isupper() and len(w) > 3 else w for w in parent["country"].split())
        hooks.append({"kind": "group", "label": "Overseas parent company", "country": country,
                      "detail": f"Owned by {parent['name']}, registered in {country} (Companies House PSC register)",
                      "lead": f"Saw you're owned by {parent['name']} in {country}"})
    else:
        abroad = next(iter(f.get("group_abroad") or []), None)
        if abroad:
            relation = "parent" if abroad["relation"] == "parent" else "subsidiary"
            hooks.append({"kind": "group", "label": f"Overseas {relation} company", "country": abroad["country"],
                          "detail": f"\"{abroad['sentence']}\" ({_source_accounts(f).replace(', tagged figure', '')})",
                          "lead": (f"Saw your parent company is in {abroad['country']}" if relation == "parent"
                                   else f"Saw you've got a subsidiary in {abroad['country']}")})

    # Bank: a facility end date the accounts give, and how long the main bank has held its debenture.
    from sourcer import incumbent   # (imports this module)
    ends = incumbent.next_facility_end(f, today, dated_only=True)   # a bare year is too vague to open on
    if ends:
        when = incumbent.facility_end_date(ends["date"])              # a month counts to its last day
        if when and (when - today).days <= rules["facility_end_months"] * 31:
            hooks.append({"kind": "facility_end", "label": "Facility ends soon",
                          "detail": f"Facility runs to {ends['written']}: \"{ends['sentence']}\" "
                                    f"({_source_accounts(f).replace(', tagged figure', '')})",
                          "lead": f"Saw in your accounts the facility runs to {ends['written']}"})
    bank = incumbent.incumbent_bank(charges)
    if bank and not any(h["kind"] == "charge" and bank["name"] in h["detail"] for h in hooks):
        since = _d(bank["created_on"])
        low, high = rules["bank_since_years"]
        if since and low * 365 <= (today - since).days <= (high + 1) * 365:
            years = (today - since).days // 365
            hooks.append({"kind": "bank_since", "label": "Main bank facility in place for years",
                          "detail": f"{bank['name']} has held an all-assets debenture since {day(bank['created_on'])}, "
                                    f"{years} years ago (Companies House charges register)",
                          "lead": f"Saw {bank['bank']} have held your debenture since {month(bank['created_on'])}"})

    # 6. Accounts filed recently.
    filed = f.get("filed_on", "")
    filed_on = _d(filed)
    if filed_on and (today - filed_on).days <= rules["accounts_filed_days"]:
        end = f.get("period_end", "")
        hooks.append({"kind": "filed", "label": "Accounts just filed",
                      "detail": f"Accounts{' for the year to ' + day(end) if end else ''} filed {day(filed)} "
                                f"(Companies House filing history)",
                      "lead": f"Saw your accounts{' for the year to ' + month(end) if end else ''} have just been filed"})
    order = rules["order"]
    return sorted(hooks, key=lambda h: order.index(h["kind"]) if h["kind"] in order else len(order))


# --- Currency exposure ---------------------------------------------------------------------------

def _code_of(m: re.Match) -> str:
    if m.group("code"):
        return "CNY" if m.group("code") == "RMB" else m.group("code")
    return next(_CURRENCY_WORDS[int(k[1:])][1] for k, v in m.groupdict().items()
                                   if v and k.startswith("c"))


def _drop_own_name(mentions: list[dict], company_name: str) -> list[dict]:
    """Mentions that are only the company's own name ("Euro Quality Lambs") don't count."""
    words = profiles.plain_name(company_name).split()
    own = re.compile(r"\s+".join(re.escape(w) for w in words), re.I) if words else None
    out = []
    for m in mentions:
        rest = own.sub(" ", m["sentence"]) if own else m["sentence"]
        if any(_code_of(x) == m["code"] for x in _CURRENCY_RE.finditer(rest)):
            out.append(m)
    return out


def currency_exposure(company_name: str, facts: Optional[dict], owners: list[dict], niche: dict,
                      customs: Optional[dict] = None) -> dict:
    """
    {"currency", "direction", "evidence", "confidence", "rule"} from the
    strongest evidence that gives an answer (all blank when none does):
      1. turnover by geography (accounts)             -> High, Sells
      2. currency names/codes in the accounts text     -> High / Medium, direction from the sentence
      3. overseas parent or group company              -> Medium
      3b. HMRC customs records (the company's own imports/exports, currency
          mix estimated from HMRC trade statistics by country) -> Medium
      4. the niche's default currency                  -> Low
    `customs`: {"imports", "exports"} as the row shows them ("EUR 64%, USD 21%"),
    {"import_months", "export_months"} out of the last 12.
    """
    f = facts or {}
    blank = {"currency": "", "direction": "", "evidence": "", "confidence": "", "rule": ""}
    source = _source_accounts(f).replace(", tagged figure", "")

    # 1. Turnover by geography: the biggest non-UK region that maps to a currency.
    regions = [r for r in f.get("regions") or [] if not is_uk(r["region"]) and r.get("value", 0) > 0]
    regions.sort(key=lambda r: r["value"], reverse=True)
    for r in regions:
        ccy = region_currency(r["region"])
        if ccy:
            total = f.get("turnover")
            of = f" of {exact(total)} total" if total else ""
            how = "tagged figures" if f.get("format") == "ixbrl" else "turnover note"
            return {"currency": ccy, "direction": SELLS, "confidence": HIGH, "rule": "geography",
                    "region": r["region"], "value": r["value"],
                    "evidence": f"Turnover from {r['region']}: {exact(r['value'])}{of} "
                                f"({source.replace('accounts text', how)})"}

    # 2. Currency names/codes in the accounts text: most-mentioned wins.
    mentions = _drop_own_name(f.get("currency_mentions") or [], company_name)
    if mentions:
        counts: dict[str, int] = {}
        for m in mentions:
            counts[m["code"]] = counts.get(m["code"], 0) + 1
        code = max(counts, key=lambda c: (counts[c], -_CODES.index(c) if c in _CODES else 0))
        mine = [m for m in mentions if m["code"] == code]
        buys, sells = any(m["buys"] for m in mine), any(m["sells"] for m in mine)
        direction = BOTH if buys and sells else BUYS if buys else SELLS if sells else UNKNOWN
        best = min((m for m in mine if m["buys"] or m["sells"]), key=lambda m: len(m["sentence"]), default=mine[0])
        strong = counts[code] >= HOOK_RULES["currency_high_mentions"] or direction != UNKNOWN
        times = f"named {counts[code]} time{'s' if counts[code] > 1 else ''}"
        return {"currency": code, "direction": direction, "confidence": HIGH if strong else MEDIUM, "rule": "text",
                "evidence": f"\"{best['sentence']}\" ({source}; {times})"}

    # 3. Overseas parent (PSC register) or group company named in the accounts.
    parent = next((o for o in owners if o.get("kind") == "corporate" and not o.get("ceased_on")
                   and country_currency(o.get("country", "")) and not is_uk(o.get("country", ""))), None)
    if parent:
        return {"currency": country_currency(parent["country"]), "direction": UNKNOWN, "confidence": MEDIUM,
                "rule": "group", "evidence": f"Parent {parent['name']} registered in {parent['country']} "
                                             f"(Companies House PSC register)"}
    abroad = next(iter(f.get("group_abroad") or []), None)
    if abroad:
        return {"currency": country_currency(abroad["country"]), "direction": UNKNOWN, "confidence": MEDIUM,
                "rule": "group", "evidence": f"{abroad['relation'].capitalize()} in {abroad['country']}: "
                                             f"\"{abroad['sentence']}\" ({source})"}

    # 3b. HMRC customs records: the bigger flow's top currency.
    c = customs or {}
    flows = [(c.get("import_months") or 0, c.get("imports") or "", BUYS, "imports"),
             (c.get("export_months") or 0, c.get("exports") or "", SELLS, "exports")]
    flows = [fl for fl in flows if fl[0] and re.match(r"[A-Z]{3}\b", fl[1])]
    if flows:
        months, mix, direction, word = max(flows, key=lambda fl: fl[0])
        both = len(flows) == 2
        listed = "; ".join(f"{w} {m} ({n} of the last 12 months)" for n, m, _, w in flows)
        return {"currency": mix[:3], "direction": BOTH if both else direction, "confidence": MEDIUM, "rule": "customs",
                "months": months, "months_in": c.get("import_months") or 0, "months_out": c.get("export_months") or 0,
                "evidence": f"HMRC customs records: {listed} (currency mix estimated from HMRC trade statistics "
                            f"for the countries those goods come from or go to)"}

    # 4. The niche's default: its first non-sterling currency pair.
    pair = next((p for p in niche.get("currency_pairs") or [] if "GBP" in p), "")
    code = next((c for c in pair.split("/") if c and c != "GBP"), "")
    if code:
        reason = niche.get("exposure_reason", "").lower()
        buys = bool(re.search(r"\b(?:buy|buys|import|imports|source|sources|purchas)", reason))
        sells = bool(re.search(r"\b(?:export|exports|sell \w+ (?:abroad|overseas)|overseas customers)", reason))
        direction = BOTH if buys and sells else BUYS if buys else SELLS if sells else UNKNOWN
        return {"currency": code, "direction": direction, "confidence": LOW, "rule": "niche",
                "evidence": f"Niche default for {niche.get('name', 'this niche')} (not from the company's documents)"}
    return blank


# --- Opener ---------------------------------------------------------------------------------------

_SAME_PLURAL = {"yen", "renminbi", "rand", "zloty", "koruna", "forint"}


def _plural(name: str) -> str:
    return name if name in _SAME_PLURAL or name.endswith("s") else name + "s"


def _how_often(months: int) -> str:
    return "every month" if months >= 12 else f"in {months} of the last 12 months"


def _both_often(exposure: dict) -> tuple[str, str]:
    """("imported every month and exported in 6 of the last 12 months", ...) — each flow's own count."""
    i, o = exposure.get("months_in", 0), exposure.get("months_out", 0)
    if i >= 12 and o >= 12:
        return "imported and exported every month", "goods going in and out every month"
    return (f"imported {_how_often(i)} and exported {_how_often(o)}",
            f"imports {_how_often(i)} and exports {_how_often(o)}")


def _currency_clause(exposure: dict) -> str:
    """The FX half of the opener — only for document evidence (High/Medium) with a known direction."""
    if exposure.get("confidence") not in (HIGH, MEDIUM) or exposure.get("direction") in ("", UNKNOWN):
        return ""
    if exposure.get("rule") == "geography":
        return f"and with {short(exposure['value'])} of sales from {exposure['region']}, a rising pound trims what they're worth"
    if exposure.get("rule") == "customs":   # the records show trade, not its currency: don't name one
        often = _how_often(exposure.get("months", 0))
        return {BUYS: f"and with imports coming in {often}, a falling pound makes every invoice dearer",
                SELLS: f"and with exports going out {often}, a rising pound trims what they bring back",
                BOTH: f"and with {_both_often(exposure)[1]}, the pound's moves hit you either way",
                }[exposure["direction"]]
    name = CURRENCY_NAMES.get(exposure["currency"], exposure["currency"])
    return {BUYS: f"and with {name} purchases in the mix, a falling pound makes every invoice dearer",
            SELLS: f"and with sales in {_plural(name)}, a rising pound trims what they bring back",
            BOTH: f"and with {_plural(name)} going both in and out, the pound's moves hit you either way",
            }[exposure["direction"]]


def opener(hooks: list[dict], exposure: dict) -> str:
    """
    One plain-English sentence from the strongest hook and the currency
    evidence, using only facts in the detail columns; "" when there's nothing
    solid. Importers worry about the pound falling, exporters about it rising.
    """
    clause = _currency_clause(exposure)
    fx = next((h for h in hooks if h["kind"] == "fx"), None)
    if hooks and hooks[0]["kind"] in BANK_KINDS and fx:
        # Bank angle first, FX as the cross-sell — both from the fact columns.
        kind = "loss" if fx["value"] < 0 else "gain"
        shows = "they show" if "accounts" in hooks[0]["lead"] else "your accounts show"
        return (f"{hooks[0]['lead']}, and {shows} a {short(fx['value'])} FX {kind}"
                f"{' for the year to ' + month(fx['period']) if fx.get('period') else ''}"
                f" — worth looking at the FX alongside the banking.")
    if hooks:
        lead = hooks[0]["lead"]
        return f"{lead}, {clause}." if clause else f"{lead}, so thought it worth a quick word on how you handle currency."
    if clause and exposure.get("rule") == "geography":
        return (f"Saw {short(exposure['value'])} of your turnover came from {exposure['region']}, "
                f"so a rising pound trims what those sales are worth.")
    if clause and exposure.get("rule") == "customs":
        often = _how_often(exposure.get("months", 0))
        return {BUYS: f"Saw from the customs records that you've imported {often}, so a falling pound pushes up what you pay.",
                SELLS: f"Saw from the customs records that you've exported {often}, so a rising pound trims what those sales bring back.",
                BOTH: f"Saw from the customs records that you've {_both_often(exposure)[0]}, so the pound's moves hit you either way.",
                }[exposure["direction"]]
    if clause:
        name = _plural(CURRENCY_NAMES.get(exposure["currency"], exposure["currency"]))
        return {BUYS: f"Saw in your accounts that you buy in {name}, so a falling pound pushes up what you pay.",
                SELLS: f"Saw in your accounts that you sell in {name}, so a rising pound trims what those sales bring back.",
                BOTH: f"Saw in your accounts you've got {name} going both in and out, so the pound's moves hit you either way.",
                }[exposure["direction"]]
    return ""


def size_estimate(low: Optional[float], high: Optional[float], basis: str) -> str:
    """The FX wallet as a clearly labelled estimate — never a fact column, never in the opener."""
    if not low or not high:
        return ""
    return f"Estimate, not a filed figure: roughly {short(low)}–{short(high)} a year through foreign currency ({basis})"


def columns(company_name: str, facts: Optional[dict], officers: list[dict], charges: list[dict], owners: list[dict],
            niche: dict, news_people: Optional[list[dict]] = None, today: Optional[date] = None,
            customs: Optional[dict] = None) -> dict:
    """The nine output columns for one company (blank where nothing qualifies)."""
    found = find_hooks(facts, officers, charges, owners, news_people, today)
    exposure = currency_exposure(company_name, facts, owners, niche, customs)
    first, second = (found + [{}, {}])[:2]
    fx = next((h for h in found if h["kind"] == "fx"), None)
    if first.get("kind") in BANK_KINDS and fx:
        second = fx                     # bank angle + the FX figure: the pitch in two facts
    return {
        "fact_1": first.get("detail", ""), "fact_2": second.get("detail", ""),
        "main_currency": exposure["currency"], "currency_direction": exposure["direction"],
        "currency_evidence": exposure["evidence"], "currency_confidence": exposure["confidence"],
        "opener": opener([h for h in (first, second) if h], exposure),
    }
