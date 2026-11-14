#!/usr/bin/env python3
"""
tools/ch_alerts.py — "ping me when…": Companies House's streaming feeds (officers, charges, owners, filings,
insolvency cases) read since the last run, turned into alerts for the companies on the Accounts and FX filings lists, plus new leads found in the
charges feed (a charge in favour of an FX provider or for trade finance proves FX activity — any company).

    CH_STREAM_KEY=… python3 tools/ch_alerts.py --tracked tracked.json --state stream.json --alerts alerts.json \
        --discoveries discoveries.json [--seconds 240] [--telegram]
    python3 tools/ch_alerts.py --alerts alerts.json --digest        # the 7am summary of the last 24 hours

Alerts:
  new_fd          a new director at a tracked company whom the news names as its finance director / CFO (hot)
  new_director    a new director at a tracked company (role unknown: Companies House no longer shows occupations)
  director_left   a director resigned — a finance director leaving opens the door to the next one
  new_charge      a new charge (security for a loan): refinancing, the moment banking relationships move
  charge_paid     a charge satisfied: a facility paid off or moved
  fx_charge       a charge in favour of an FX provider, or for trade finance / foreign exchange (hot; also a discovery
                  for a company not on the lists)
  new_owner       a new corporate owner (private-equity backed when the owner looks like a deal vehicle: hot)
  director_abroad a new director whose country of residence is outside the UK (an overseas parent or expansion)
  shares_allotted new shares issued (a return of allotment, SH01): money coming in
  articles_changed new articles, share classes created / renamed / their rights varied: usually a funding round or deal
  funding_round   both of those within FUNDING_PAIR_DAYS (hot)
  bank_switch     an all-assets charge paid off and a new one to a different bank within SWITCH_DAYS (hot)
  auditor_changed an auditor resigned or was replaced: often before a sale, a deal or a bigger auditor
  year_end_changed the accounting year-end moved: often lining up with a new owner after a takeover
  insolvency      an insolvency / liquidation / administration filing or case: hold off (a reason not to progress)
  petition        a winding-up petition in the Gazette (--signals): hold off

Read-only on Companies House; free. Public repo: the log holds counts only. Email (Zac, 14 Nov 2026: "I'd rather it
send me an email"; SMTP_USER + SMTP_PASSWORD secrets — a Gmail address and an app password — ALERT_EMAIL_TO optional,
else SMTP_USER) gets one email a run listing the new hot alerts, and the 7am digest; Telegram (TELEGRAM_BOT_TOKEN +
TELEGRAM_CHAT_ID) only when no email is set up. Nothing is sent otherwise, and never to anyone but Zac.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import companies_house, news, triggers  # noqa: E402

STREAM_BASE = "https://stream.companieshouse.gov.uk"
STREAMS = {"officers": "/officers", "charges": "/charges", "psc": "/persons-with-significant-control",
           "filings": "/filings", "insolvency": "/insolvency-cases"}
RECENT_DAYS = 30            # an appointment, charge or change dated within this of the event counts as new
OWNER_RECENT_DAYS = 60
ALERTS_MAX = 2000
NEWS_CHECKS_MAX = 25        # new directors checked against the news a run (Google News RSS: keep it gentle)
FD_NEWS_DAYS = 150          # a news appointment this recent confirms the new director as the finance director
HOT = {"new_fd", "fx_charge", "new_owner_pe", "funding_round", "bank_switch"}
FUNDING_PAIR_DAYS = 60      # new shares and new articles / share classes this close together: a funding round
SWITCH_DAYS = 180           # an all-assets charge paid off and a new one to another bank this close: a bank switch
SWITCH_CHECKS_MAX = 60      # charges registers read a run (one REST call each) to confirm a switch
HOME = {"united kingdom", "uk", "england", "scotland", "wales", "northern ireland", "great britain", "gb", "britain",
        "jersey", "guernsey", "isle of man", ""}

# Charges that prove FX: the holder is an FX provider, or the charge is for trade finance / foreign exchange.
FX_PROVIDERS = re.compile(r"\b(?:EBURY|CORPAY|CONVERA|CAMBRIDGE\s+(?:GLOBAL|MERCANTILE)|MONEYCORP|WESTERN\s+UNION|"
                          r"CURRENCIES\s+DIRECT|AFEX|ARGENTEX|ALPHA\s+(?:FX|GROUP\s+INTERNATIONAL)|GLOBAL\s+REACH|"
                          r"SMART\s+CURRENCY|CENTTRIP|IBANFIRST|KANTOX|CURRENCYCLOUD|BANKING\s+CIRCLE|"
                          r"FOREIGN\s+CURRENCY\s+EXCHANGE)\b", re.I)
FX_PURPOSE = re.compile(r"trade\s+finance|letters?\s+of\s+credit|documentary\s+credit|foreign\s+exchange|"
                        r"forward\s+(?:foreign\s+)?(?:exchange\s+)?contracts?|currency\s+(?:contracts?|hedg)|"
                        r"derivative|hedging|treasury\s+(?:dealing|products|transactions)", re.I)
_NUMBER = re.compile(r"/company/([A-Z0-9]{8})/")


def _day(value: str) -> Optional[date]:
    try:
        return date.fromisoformat((value or "")[:10])
    except ValueError:
        return None


def _within(value: str, today: date, days: int) -> bool:
    d = _day(value)
    return bool(d and today - timedelta(days=days) <= d <= today + timedelta(days=1))


def _person(name: str) -> str:
    """ "SMITH, John Andrew" -> "John Andrew Smith" (Companies House lists surname first)."""
    if "," in name:
        last, first = name.split(",", 1)
        return f"{first.strip().title()} {last.strip().title()}".strip()
    return name.strip().title()


def company_url(number: str) -> str:
    return f"https://find-and-update.company-information.service.gov.uk/company/{number}"


def classify(event: dict, tracked: dict[str, str], today: date) -> Optional[dict]:
    """One stream event as an alert, or None. tracked: {company number: name} of the Accounts + FX filings lists."""
    uri = event.get("resource_uri") or ""
    m = _NUMBER.search(uri + "/")
    if not m:
        return None
    number = m.group(1)
    kind = event.get("resource_kind") or ""
    data = event.get("data") or {}
    at = (event.get("event") or {}).get("published_at") or ""
    base = {"id": f"{kind}:{event.get('resource_id') or uri}", "at": at, "company_number": number,
            "company_name": tracked.get(number, ""), "tracked": number in tracked, "url": company_url(number)}

    if kind.startswith("company-charges"):
        holders = ", ".join(p.get("name", "") for p in data.get("persons_entitled") or [] if p.get("name"))
        words = " ".join([holders, (data.get("classification") or {}).get("description", ""),
                          (data.get("particulars") or {}).get("description", "")])
        provider = FX_PROVIDERS.search(holders)
        purpose = FX_PURPOSE.search(words)
        new = _within(data.get("delivered_on") or data.get("created_on") or "", today, RECENT_DAYS) \
            and data.get("status", "outstanding") == "outstanding"
        if (provider or purpose) and new:
            why = f"charge in favour of {holders}" if provider else f"charge for {purpose.group(0).lower()} ({holders})"
            return {**base, "kind": "fx_charge", "title": "Charge to an FX provider" if provider else "Trade finance / FX charge",
                    "detail": why, "url": company_url(number) + "/charges", "hot": True}
        if number not in tracked:
            return None
        if new:
            return {**base, "kind": "new_charge", "title": "New bank charge (refinancing)",
                    "detail": f"in favour of {holders}" if holders else "", "url": company_url(number) + "/charges",
                    "hot": False}
        if data.get("status") == "fully-satisfied" and _within(data.get("satisfied_on") or "", today, RECENT_DAYS):
            return {**base, "kind": "charge_paid", "title": "Charge paid off", "detail": f"was held by {holders}" if holders else "",
                    "url": company_url(number) + "/charges", "hot": False}
        return None

    if number not in tracked:
        return None

    if kind.startswith("filing-history"):
        return filing_alert(base, data, today)

    if kind.startswith("company-insolvency"):
        cases = data.get("cases") or []
        what = ", ".join(sorted({(c.get("type") or "").replace("-", " ") for c in cases if c.get("type")})) or "insolvency case"
        return {**base, "id": f"insolvency:{number}:{len(cases)}", "kind": "insolvency", "title": "Insolvency case opened",
                "detail": what, "url": company_url(number) + "/insolvency", "hot": False}

    if kind.startswith("company-officers"):
        role = (data.get("officer_role") or "").lower()
        if role not in ("director", "corporate-director", "secretary"):
            return None
        who = _person(data.get("name") or "")
        if data.get("resigned_on") and _within(data["resigned_on"], today, RECENT_DAYS):
            return {**base, "kind": "director_left", "title": "Director resigned" if role != "secretary" else "Company secretary left",
                    "detail": who, "person": who, "url": company_url(number) + "/officers", "hot": False}
        if not data.get("resigned_on") and _within(data.get("appointed_on") or "", today, RECENT_DAYS):
            occupation = data.get("occupation") or ""
            fd = bool(re.search(r"financ|\bCFO\b|treasur", occupation, re.I))
            country = (data.get("country_of_residence") or "").strip()
            abroad = not fd and role != "secretary" and country.lower().replace(".", "").strip() not in HOME
            title = "New finance director" if fd else ("New company secretary" if role == "secretary" else
                                                       f"New director based in {country.title()}" if abroad else "New director")
            return {**base, "kind": "new_fd" if fd else "director_abroad" if abroad else "new_director", "title": title,
                    "detail": f"{who}{f' ({occupation})' if occupation else ''}", "person": who,
                    "url": company_url(number) + "/officers", "hot": fd}
        return None

    if kind.startswith("company-psc"):
        if "corporate" not in (data.get("kind") or "") or data.get("ceased_on"):
            return None
        if not _within(data.get("notified_on") or "", today, OWNER_RECENT_DAYS):
            return None
        owner = data.get("name") or ""
        country = ((data.get("identification") or {}).get("country_registered") or "").strip()
        pe = bool(triggers.investor_owner([{"kind": "corporate", "name": owner}]))
        return {**base, "kind": "new_owner_pe" if pe else "new_owner",
                "title": "New owner — looks private-equity backed" if pe else "New corporate owner",
                "detail": owner + (f" ({country})" if country else ""), "url": company_url(number) + "/persons-with-significant-control",
                "hot": pe}
    return None


# --- Filings: money coming in, a deal being prepared, trouble -------------------------------------------------------

_ARTICLES_TYPES = {"MA", "SH08", "SH10", "SH02", "CC04"}       # articles; share classes renamed / rights varied / split
_ARTICLES_WORDS = re.compile(r"articles|class(?:es)? of shares|share class|variation of (?:class )?rights|"
                             r"redesignat|sub-?divi|preference shares|RES01|RES12", re.I)
_INSOLVENCY = re.compile(r"^(?:LIQ|LRESEX|LRESSP|AM0|AM1|AM2|WU|COM[0-9]|4\.|2\.|600|F10)", re.I)


def _capital(values: dict) -> str:
    """ "GBP 1,234.56" from a return of allotment's statement of capital."""
    parts = [f"{c.get('currency', '')} {c.get('figure', '')}".strip() for c in (values or {}).get("capital") or []
             if c.get("figure")]
    return " + ".join(parts)


def filing_alert(base: dict, data: dict, today: date) -> Optional[dict]:
    """A tracked company's filing as an alert: new shares, new articles / share classes, a new auditor, a moved
    year-end, insolvency. Only filings dated within RECENT_DAYS."""
    if not _within(data.get("date") or "", today, RECENT_DAYS):
        return None
    ftype = (data.get("type") or "").upper()
    category = (data.get("category") or "").lower()
    words = " ".join([data.get("description") or "", ftype] +
                     [f"{r.get('type', '')} {r.get('description', '')}" for r in data.get("resolutions") or []])
    number = base["company_number"]
    filed = f"filed {data.get('date', '')[:10]}"
    if category in ("insolvency", "liquidation", "administration") or _INSOLVENCY.match(ftype):
        return {**base, "kind": "insolvency", "title": "Insolvency filing", "detail": f"{ftype} {filed}",
                "url": company_url(number) + "/filing-history", "hot": False}
    if ftype == "SH01":
        cap = _capital(data.get("description_values") or {})
        return {**base, "kind": "shares_allotted", "title": "New shares issued (money coming in)",
                "detail": f"return of allotment {filed}" + (f"; capital now {cap}" if cap else ""),
                "url": company_url(number) + "/filing-history", "hot": False}
    if ftype in _ARTICLES_TYPES or (category in ("resolution", "incorporation", "capital") and _ARTICLES_WORDS.search(words)):
        return {**base, "kind": "articles_changed", "title": "New articles / share classes (often a funding round or deal)",
                "detail": f"{ftype or category} {filed}", "url": company_url(number) + "/filing-history", "hot": False}
    if ftype == "AA01":
        new_end = ((data.get("description_values") or {}).get("new_date") or "")[:10]
        return {**base, "kind": "year_end_changed", "title": "Accounting year-end changed (often after a takeover)",
                "detail": filed + (f"; new year-end {new_end}" if new_end else ""),
                "url": company_url(number) + "/filing-history", "hot": False}
    if category == "auditors" or ftype.startswith("AUD"):
        return {**base, "kind": "auditor_changed", "title": "Auditor resigned or changed",
                "detail": f"{ftype} {filed}", "url": company_url(number) + "/filing-history", "hot": False}
    return None


def funding_rounds(alerts: list[dict]) -> list[dict]:
    """New shares and new articles / share classes at the same company within FUNDING_PAIR_DAYS: a funding round."""
    by: dict[str, dict[str, list[dict]]] = {}
    for a in alerts:
        if a["kind"] in ("shares_allotted", "articles_changed"):
            by.setdefault(a["company_number"], {}).setdefault(a["kind"], []).append(a)
    out = []
    for number, kinds in by.items():
        pairs = [(s, r) for s in kinds.get("shares_allotted", []) for r in kinds.get("articles_changed", [])
                 if _day(s.get("at") or "") and _day(r.get("at") or "")
                 and abs((_day(s["at"]) - _day(r["at"])).days) <= FUNDING_PAIR_DAYS]
        if not pairs:
            continue
        s, r = max(pairs, key=lambda p: max(p[0]["at"], p[1]["at"]))
        at = max(s["at"], r["at"])
        out.append({**{k: s.get(k, "") for k in ("company_number", "company_name", "tracked")},
                    "id": f"funding_round:{number}:{at[:7]}", "at": at, "kind": "funding_round",
                    "title": "Funding round likely: new shares + new articles", "detail": f"{s.get('detail', '')}; {r.get('detail', '')}",
                    "url": company_url(number) + "/filing-history", "hot": True})
    return out


def bank_switch(charges: list[dict], today: date, days: int = SWITCH_DAYS) -> Optional[tuple[str, str, str]]:
    """(old bank, new bank, date) when an all-assets / debenture charge held by one bank was satisfied and one to a
    different bank created within `days` of today; None otherwise. charges: companies_house.get_charges rows."""
    from sourcer import banks
    def group(c: dict) -> str:
        g = banks.classify(c.get("name") or "")
        return g[0] if g else ""
    def all_assets(c: dict) -> bool:
        return c.get("floating_all") or bool(re.search(r"debenture|all assets", f"{c.get('classification')} {c.get('particulars')}", re.I))
    since = (today - timedelta(days=days)).isoformat()
    new = [c for c in charges if all_assets(c) and group(c) and (c.get("created_on") or "") >= since
           and c.get("status") in ("outstanding", "part-satisfied")]
    paid = [c for c in charges if all_assets(c) and group(c) and (c.get("satisfied_on") or "") >= since
            and c.get("status") == "fully-satisfied"]
    for n in sorted(new, key=lambda c: c.get("created_on") or "", reverse=True):
        for p in paid:
            if group(p) != group(n):
                return group(p), group(n), max(n.get("created_on") or "", p.get("satisfied_on") or "")
    return None


def confirm_fd(alert: dict, fetcher=None, today: Optional[date] = None) -> dict:
    """A new director the news names as the company's finance director / CFO (recently) becomes a new_fd alert."""
    if alert["kind"] not in ("new_director", "director_abroad") or not alert.get("company_name") or not alert.get("person"):
        return alert
    surname = alert["person"].split()[-1].upper()
    for p in news.appointments(alert["company_name"], fetcher=fetcher, today=today):
        if surname in p["name"].upper() and news.is_recent(p["date"], today, FD_NEWS_DAYS):
            return {**alert, "kind": "new_fd", "title": f"New {p['title'].lower()}", "hot": True,
                    "detail": f"{alert['person']} — {p['title']} ({p['note']})"}
    return alert


# --- Reading the streams -------------------------------------------------------------------------------------------

def read_stream(path: str, key: str, timepoint: Optional[int], seconds: float,
                opener=urllib.request.urlopen) -> tuple[list[dict], Optional[int], str]:
    """
    (events, last timepoint, why it stopped) — events since `timepoint` (from now when None or too old), read until
    caught up (an event published within two minutes of now) or `seconds` pass.
    """
    url = STREAM_BASE + path + (f"?timepoint={timepoint}" if timepoint else "")
    auth = base64.b64encode(f"{key}:".encode()).decode()
    request = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
    events, last, why = [], timepoint, "time up"
    deadline = time.time() + seconds
    try:
        response = opener(request, timeout=60)
    except urllib.error.HTTPError as e:
        if e.code == 416 and timepoint:   # the timepoint has aged out of the stream: start again from now
            return read_stream(path, key, None, seconds, opener)
        return [], timepoint, f"HTTP {e.code}"
    except OSError as e:
        return [], timepoint, f"network: {type(e).__name__}"
    with response:
        for raw in response:
            if time.time() > deadline:
                break
            line = raw.strip()
            if not line:
                continue   # heartbeat
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            events.append(ev)
            meta = ev.get("event") or {}
            last = meta.get("timepoint", last)
            try:
                published = datetime.fromisoformat((meta.get("published_at") or "").replace("Z", "+00:00"))
                if published.tzinfo is None:
                    published = published.replace(tzinfo=timezone.utc)
                if datetime.now(timezone.utc) - published < timedelta(minutes=2):
                    why = "caught up"
                    break
            except ValueError:
                pass
    return events, last, why


def company_name(number: str, api_key: str) -> str:
    try:
        profile = companies_house.get_company_profile(number, api_key) or {}
    except Exception:  # noqa: BLE001 — a name is a nicety
        return ""
    return profile.get("company_name", "")


# --- News and job adverts: the same alerts, and new leads, from public headlines and job boards ------------------

from xml.etree import ElementTree as ET  # noqa: E402
from email.utils import parsedate_to_datetime  # noqa: E402

from sourcer import matching  # noqa: E402

NEWS_DAYS = 10
NEWS_QUERIES = {   # Google News RSS, UK edition — each headline matched to the lists, or to Companies House by name
    "news_fd": ['appoints "finance director"', 'appoints CFO', '"chief financial officer" appointed', '"new finance director"',
                '"joins as finance director"', '"promoted to finance director"'],
    "news_abroad": ['acquires GmbH', 'acquires "B.V."', 'acquires Inc UK company', '"opens office in" UK firm',
                    '"export contract" UK', '"expands into" Europe UK firm', '"distribution agreement" UK manufacturer',
                    '"new factory" abroad UK company', '"King\'s Award for International Trade"',
                    '"UK Export Finance" backs', '"UK Export Finance" supports', 'UKEF guarantee exporter'],
    # New money (Zac, 12 Nov 2026: "companies which have just been funded which will have FX, or just got bought by a PE")
    "news_funding": ['raises "Series A" UK', 'raises "Series B" UK', 'raises "Series C" UK', '"growth investment" UK company',
                     '"secures £" investment international expansion', '"funding round" UK US expansion'],
    "news_pe": ['"management buyout" UK', '"private equity" backs UK company', '"acquired by" private equity UK',
                '"secondary buyout" UK', '"backed by" private equity acquires', '"investment from" private equity UK firm'],
}
_SUBJECT = re.compile(r"^(?:UK\s+|British\s+)?(.+?)\s+(?:has\s+)?(?:appoints|appointed|names|hires|welcomes|acquires|"
                      r"buys|opens|expands|wins|secures|signs|lands|launches|raises|closes|bags|completes)\b", re.I)
_NOT_A_COMPANY = re.compile(r"^(?:the|a|an|how|why|what|who|uk|britain|government|council|nhs|police|university)\b|"
                            r"\b(?:ceo|chief|boss|founder|director|minister|chancellor)\b", re.I)
RECRUITERS = re.compile(r"\b(?:hays|michael\s+page|robert\s+(?:half|walters)|reed|page\s+group|harvey\s+nash|"
                        r"randstad|adecco|manpower|recruit|recruitment|resourcing|talent|search\s+partners|staffing|"
                        r"selection|consult(?:ing|ancy)?\s+group)\b", re.I)
JOB_QUERIES = ["treasury analyst", "treasury manager", "foreign exchange", "FX hedging", "import export coordinator",
               "international trade manager", "export sales manager", "currency risk"]
STATS: dict[str, int] = {}   # counts for the log (public repo: no names)
LOOKUPS_MAX = 40            # Companies House name searches a run, for subjects not on the lists
# 14 Nov 2026 (discovery review: news and job adverts were the noisiest source — low volume, name-matching): headlines
# and adverts are triggers on companies already on the lists. Only a private-equity deal or a funding round about a
# company not on them is looked up and becomes a lead (the New money tab); a new FD, expansion abroad or a job advert
# at an unknown company isn't.
DISCOVER_FROM_NEWS = ("news_pe", "news_funding")


def tracked_index(tracked: dict[str, str]) -> list[tuple[re.Pattern, str]]:
    """[(pattern for the name as a headline writes it, company number)] for names distinctive enough to match."""
    out = []
    for number, name in tracked.items():
        core = matching.normalise_name(name or "")
        if len(core) < 6 or len(core.split()) == 1 and len(core) < 8:
            continue   # "ACME" alone matches too much
        out.append((re.compile(r"(?<![A-Z0-9])" + re.escape(core) + r"(?![A-Z0-9])"), number))
    return out


def match_tracked(text: str, index: list[tuple[re.Pattern, str]]) -> str:
    up = matching.normalise_name(text) or text.upper()
    return next((number for pattern, number in index if pattern.search(up)), "")


_UKEF_OBJECT = re.compile(r"\b(?:UK Export Finance|UKEF)\s+(?:backs|supports|helps|guarantees|boosts|deal for)\s+"
                          r"(?:UK\s+|British\s+|\w+-based\s+|exporter\s+|manufacturer\s+)*(.+?)(?:\s+(?:to|with|in|as|for|on|after)\b|$)", re.I)


_DESCRIPTOR = re.compile(r"^(?:[A-Z][\w&-]*\s+){0,2}?(?:family-owned\s+|family\s+|independent\s+)?(?:firm|manufacturer|"
                         r"exporter|company|business|maker|supplier|distributor|importer|wholesaler|retailer|brand|"
                         r"start-?up|specialist|group|producer|grower)\b\s*", re.I)


def _clean_subject(name: str) -> str:
    name = _DESCRIPTOR.sub("", name.strip(" '\"‘’“”")).strip(" '\"‘’“”")
    return "" if not name or _NOT_A_COMPANY.search(name) or len(name) > 60 or not name[0].isupper() else name


_BOUGHT_SUBJECT = re.compile(r"^(?:UK\s+|British\s+)?(.+?)\s+(?:is\s+|has\s+been\s+)?(?:acquired|bought|backed|sold)\s+(?:by|to)\b", re.I)
_BACKS_OBJECT = re.compile(r"\b(?:backs|invests in|invests £[\d.]+\s?m in|acquires|completes (?:an? )?(?:investment in|buyout of|MBO of|"
                           r"management buyout of))\s+(?:UK\s+|British\s+|\w+-based\s+)?(.+?)(?:\s+(?:in|with|as|for|to|on)\b|$|,)", re.I)
_BUYOUT_OF = re.compile(r"\b(?:management buy-?out|MBO|buy-?out)\s+(?:of|at)\s+(.+?)(?:\s+(?:in|with|as|for|to|on|backed)\b|$|,)", re.I)


def headline_subject(headline: str) -> str:
    """The company a headline is about: who appoints / acquires / wins / raises, who was bought or backed, or whom
    UK Export Finance or a PE house backs."""
    text = headline.split(" - ")[0].strip()
    ukef = _UKEF_OBJECT.search(text)
    if ukef:
        return _clean_subject(ukef.group(1))
    m = _BOUGHT_SUBJECT.match(text)
    if m:
        inner = re.sub(r"^(?:the\s+)?(?:management\s+buy-?out|MBO|buy-?out)\s+(?:of|at)\s+", "", m.group(1), flags=re.I)
        return _clean_subject(inner)
    if _PE_HEADLINE.search(text):
        for rx in (_BUYOUT_OF, _BACKS_OBJECT):
            m = rx.search(text)
            if m:
                return _clean_subject(m.group(1))
    m = _SUBJECT.match(text)
    return _clean_subject(m.group(1)) if m else ""


_FD_HEADLINE = re.compile(r"\b(?:appoint|names?|named|hires?|welcomes?|joins?|promot)\w*\b.*\b(?:financ\w* director|"
                          r"CFO|chief financial officer|finance chief|head of finance|director of finance)\b|\b(?:new|incoming) "
                          r"(?:finance director|CFO|chief financial officer)\b", re.I)
_ABROAD_HEADLINE = re.compile(r"\b(?:acquir\w*|buys?|bought|opens?|expands?|expansion|export\w*|overseas|international|"
                              r"distribution (?:deal|agreement)|contract)\b.*\b(?:GmbH|B\.?V\.?|S\.?A\.?S?|S\.?p\.?A|Inc|"
                              r"LLC|Pty|abroad|overseas|export|Europe\w*|US|USA|America\w*|Asia\w*|China|India|Japan|"
                              r"Australia\w*|Canada|Dutch|German\w*|French|France|Spain|Spanish|Italy|Italian|Ireland|Irish|"
                              r"Middle East|Africa\w*|Nordic|Poland|Polish|Dubai|UAE|Saudi|Singapore|Hong Kong|Mexico|"
                              r"Brazil|Vietnam|Turkey|Netherlands|Belgium|Sweden|Norway|Denmark|Switzerland)\b|"
                              r"\bexport\w* (?:contract|deal|order|award|growth|sales)\b|"
                              r"\bKing'?s Award for (?:International Trade|Enterprise)", re.I)


_PE_HEADLINE = re.compile(r"\bmanagement buy-?out\b|\bMBO\b|\bsecondary buy-?out\b|\bprivate equity\b|\bPE[- ]backed\b|"
                          r"\b(?:backed|acquired|bought)\s+by\s+[A-Z][\w&]*(?:\s+[A-Z][\w&]*){0,3}\s+(?:Capital|Partners|Equity|LDC|BGF)\b|"
                          r"\b(?:LDC|BGF|Inflexion|Bridgepoint|Livingbridge|Palatine|Mobeus|Foresight|YFM|NorthEdge|Kester|"
                          r"Growth Capital Partners|Elysian|Tenzing|Synova|ECI)\b\s+(?:backs|invests|acquires|completes)", re.I)
_FUNDING_HEADLINE = re.compile(r"\b(?:raises?|raised|secures?|secured|lands?|closes?|bags?|completes?)\b[^.]*?(?:£|\$|€)\s?\d[\d.,]*\s?"
                               r"(?:m|mn|million|bn|billion)\b|\bSeries [A-E]\b|\bgrowth (?:investment|funding|capital)\b", re.I)


def headline_kind(headline: str) -> str:
    """news_fd (a finance director / CFO appointed), news_pe (bought by / backed by private equity, a buyout),
    news_funding (a funding round), news_abroad (buying, opening or selling abroad), or ""."""
    if _FD_HEADLINE.search(headline):
        return "news_fd"
    if _PE_HEADLINE.search(headline):
        return "news_pe"
    if _FUNDING_HEADLINE.search(headline):
        return "news_funding"
    if re.search(r"\b(?:UK Export Finance|UKEF)\b", headline, re.I):
        return "news_abroad"
    return "news_abroad" if _ABROAD_HEADLINE.search(headline) else ""


def find_company(name: str, api_key: str) -> Optional[dict]:
    """An active company whose registered name is the headline's name (Companies House name search), or None."""
    data = companies_house._get(f"{companies_house.CH_BASE}/search/companies", {"q": name, "items_per_page": 5}, api_key) or {}
    want = matching.normalise_name(name)
    for item in data.get("items") or []:
        if item.get("company_status") == "active" and matching.normalise_name(item.get("title", "")) == want:
            return {"company_number": item.get("company_number", ""), "company_name": item.get("title", "")}
    return None


def news_items(query: str, fetcher=None, today: Optional[date] = None) -> list[dict]:
    today = today or date.today()
    url = news.FEED.format(query=urllib.parse.urlencode({"q": f"{query} when:{NEWS_DAYS}d", "hl": "en-GB", "gl": "GB", "ceid": "GB:en"}))
    xml = (fetcher or news.fetch)(url)
    if not xml:
        return []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    out = []
    for item in root.iter("item"):
        try:
            when = parsedate_to_datetime(item.findtext("pubDate") or "").date()
        except (TypeError, ValueError):
            continue
        if (today - when).days > NEWS_DAYS:
            continue
        out.append({"headline": re.sub(r"\s+", " ", item.findtext("title") or "").strip(), "link": item.findtext("link") or "",
                    "date": when.isoformat(), "source": re.sub(r"<[^>]+>", "", item.findtext("source") or "").strip()})
    return out


def news_signals(tracked: dict[str, str], api_key: str, fetcher=None, today: Optional[date] = None,
                 lookup=None) -> tuple[list[dict], list[dict]]:
    """(alerts, discovery rows) from the day's headlines: a company on the lists named in a finance-director,
    expansion-abroad, private-equity or funding headline is an alert (hot); a company not on the lists, found on
    Companies House by its exact name, is a new lead only for a private-equity deal or a funding round
    (DISCOVER_FROM_NEWS)."""
    index = tracked_index(tracked)
    lookup = lookup or (lambda name: find_company(name, api_key) if api_key else None)
    alerts, found, lookups, seen = [], [], 0, set()
    for queries in NEWS_QUERIES.values():
        for q in queries:
            for item in news_items(q, fetcher, today):
                h = item["headline"]
                if h in seen:
                    continue
                seen.add(h)
                kind = headline_kind(h.split(" - ")[0])
                if not kind:
                    continue
                number = match_tracked(h.split(" - ")[0], index)
                company = {"company_number": number, "company_name": tracked.get(number, "")} if number else None
                if not company and kind in DISCOVER_FROM_NEWS and lookups < LOOKUPS_MAX:
                    subject = headline_subject(h)
                    if subject:
                        lookups += 1
                        company = lookup(subject)
                if not company or not company.get("company_number"):
                    continue
                title = {"news_fd": "In the news: new finance director", "news_pe": "In the news: private-equity deal",
                         "news_funding": "In the news: just raised funding"}.get(kind, "In the news: expanding abroad")
                alerts.append({"id": f"{kind}:{company['company_number']}:{item['date']}", "at": item["date"] + "T07:00:00",
                               "kind": kind, "company_number": company["company_number"], "company_name": company["company_name"],
                               "tracked": bool(number), "hot": True, "title": title,
                               "detail": f"{h} ({item['date']})", "url": item["link"] or company_url(company["company_number"])})
                if not number:
                    found.append({"company_number": company["company_number"], "company_name": company["company_name"],
                                  "discovered": item["date"], "discovered_by": f"news: {h}",
                                  "filed_fx_score": 55 if kind in ("news_abroad", "news_pe") else 50})
    STATS.update({"headlines": len(seen), "name lookups": lookups})
    return alerts, found


def job_adverts(fetch_json=None) -> list[dict]:
    """[{employer, title, date, link}] from Adzuna (ADZUNA_APP_ID + ADZUNA_APP_KEY) and Reed (REED_API_KEY), last 14
    days; recruiters left out. Empty without keys."""
    fetch_json = fetch_json or _fetch_json
    out = []
    app_id, app_key = os.environ.get("ADZUNA_APP_ID", "").strip(), os.environ.get("ADZUNA_APP_KEY", "").strip()
    reed = os.environ.get("REED_API_KEY", "").strip()
    for q in JOB_QUERIES:
        if app_id and app_key:
            url = ("https://api.adzuna.com/v1/api/jobs/gb/search/1?" + urllib.parse.urlencode(
                {"app_id": app_id, "app_key": app_key, "what": q, "max_days_old": 14, "results_per_page": 50}))
            for j in (fetch_json(url, None) or {}).get("results") or []:
                out.append({"employer": (j.get("company") or {}).get("display_name", ""), "title": j.get("title", ""),
                            "date": (j.get("created") or "")[:10], "link": j.get("redirect_url", "")})
        if reed:
            url = "https://www.reed.co.uk/api/1.0/search?" + urllib.parse.urlencode({"keywords": q, "resultsToTake": 100})
            for j in (fetch_json(url, reed) or {}).get("results") or []:
                d = j.get("date") or ""
                iso = f"{d[6:10]}-{d[3:5]}-{d[0:2]}" if re.match(r"\d\d/\d\d/\d{4}", d) else d[:10]
                out.append({"employer": j.get("employerName", ""), "title": j.get("jobTitle", ""), "date": iso,
                            "link": j.get("jobUrl", "")})
    return [j for j in out if j["employer"] and not RECRUITERS.search(j["employer"])]


def _fetch_json(url: str, basic_user: Optional[str]):
    headers = {"User-Agent": news.USER_AGENT}
    if basic_user:
        headers["Authorization"] = "Basic " + base64.b64encode(f"{basic_user}:".encode()).decode()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
            return json.loads(r.read(5_000_000).decode("utf-8", "replace"))
    except (OSError, ValueError):
        return None


def job_signals(tracked: dict[str, str], api_key: str, adverts: list[dict], lookup=None,
                discover: bool = False) -> tuple[list[dict], list[dict]]:
    """(alerts, discovery rows): an employer on the lists hiring for treasury / FX / import-export is an alert. With
    `discover` (off since 14 Nov 2026), one not on the lists, found on Companies House by its exact name, is a new lead."""
    index = tracked_index(tracked)
    lookup = lookup or (lambda name: find_company(name, api_key) if api_key else None)
    alerts, found, lookups, seen = [], [], 0, {}
    for j in adverts:
        number = match_tracked(j["employer"], index)
        if not number:
            if not discover:
                continue
            key = matching.normalise_name(j["employer"])
            if key not in seen and lookups < LOOKUPS_MAX:
                lookups += 1
                seen[key] = lookup(j["employer"])
            company = seen.get(key)
        else:
            company = {"company_number": number, "company_name": tracked[number]}
        if not company or not company.get("company_number"):
            continue
        alerts.append({"id": f"hiring:{company['company_number']}:{matching.normalise_name(j['title'])[:40]}",
                       "at": (j["date"] or date.today().isoformat()) + "T07:00:00", "kind": "hiring",
                       "company_number": company["company_number"], "company_name": company["company_name"],
                       "tracked": bool(number), "hot": False, "title": f"Hiring: {j['title'][:60]}",
                       "detail": f"advertised {j['date']}", "url": j["link"] or company_url(company["company_number"])})
        if not number:
            found.append({"company_number": company["company_number"], "company_name": company["company_name"],
                          "discovered": j["date"], "discovered_by": f"job advert: {j['title']}", "filed_fx_score": 50})
    return alerts, found


# --- Telegram ------------------------------------------------------------------------------------------------------

def telegram(text: str) -> bool:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip(), os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat:
        return False
    body = urllib.parse.urlencode({"chat_id": chat, "text": text[:4000], "disable_web_page_preview": "true"}).encode()
    try:
        with urllib.request.urlopen(f"https://api.telegram.org/bot{token}/sendMessage", body, timeout=20) as r:
            return r.status == 200
    except OSError:
        return False


def email(subject: str, text: str) -> bool:
    """One plain-text email to Zac (ALERT_EMAIL_TO, else SMTP_USER) through SMTP over SSL (SMTP_HOST, default Gmail);
    False when not set up or it fails. The body never reaches the log (public repo)."""
    import smtplib
    import ssl
    from email.message import EmailMessage
    user, password = os.environ.get("SMTP_USER", "").strip(), os.environ.get("SMTP_PASSWORD", "").strip()
    if not user or not password:
        return False
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, user, os.environ.get("ALERT_EMAIL_TO", "").strip() or user
    msg.set_content(text)
    try:
        with smtplib.SMTP_SSL(os.environ.get("SMTP_HOST", "smtp.gmail.com"), int(os.environ.get("SMTP_PORT", "465") or 465),
                              context=ssl.create_default_context(), timeout=30) as smtp:
            smtp.login(user, password)
            smtp.send_message(msg)
        return True
    except (OSError, smtplib.SMTPException):
        return False


def email_set_up() -> bool:
    return bool(os.environ.get("SMTP_USER", "").strip() and os.environ.get("SMTP_PASSWORD", "").strip())


def send_hot(alerts: list[dict], heading: str, limit: int = 20, send_email=email, send_telegram=None) -> str:
    """The new hot alerts: one email listing them all when email is set up, else one Telegram message each.
    Returns what was sent, for the log ("email (3 alerts)", "Telegram 2", "nothing")."""
    if not alerts:
        return "nothing"
    if email_set_up():
        when = datetime.now(timezone.utc).strftime("%d %b %H:%M UTC")
        body = "\n\n".join(alert_line(a) for a in alerts[:limit])
        body += "\n\nAll alerts: the Alerts tab on the Accounts page"
        subject = f"FX alerts: {len(alerts)} hot — {alerts[0].get('title', '')}: {alerts[0].get('company_name') or alerts[0]['company_number']}"
        return f"email ({len(alerts)} alerts)" if send_email(subject[:150], f"{heading} — {when}\n\n{body}") else "email failed"
    send_telegram = send_telegram or telegram
    sent = sum(1 for a in alerts[:limit] if send_telegram(alert_line(a)))
    return f"Telegram {sent}" if sent else "nothing (no email or Telegram set up)"


def alert_line(a: dict) -> str:
    who = a.get("company_name") or a["company_number"]
    return f"{a['title']}: {who}" + (f" — {a['detail']}" if a.get("detail") else "") + f"\n{a['url']}"


def digest(alerts: list[dict], now: datetime) -> str:
    since = (now - timedelta(hours=24)).isoformat()
    recent = [a for a in alerts if (a.get("at") or "") >= since[:19]]
    if not recent:
        return ""
    hot = [a for a in recent if a.get("hot")]
    rest = [a for a in recent if not a.get("hot")]
    lines = [f"FX alerts — last 24 hours: {len(hot)} hot, {len(rest)} other"]
    lines += ["", "HOT"] + [alert_line(a) for a in hot[:15]] if hot else []
    counts: dict[str, int] = {}
    for a in rest:
        counts[a["title"]] = counts.get(a["title"], 0) + 1
    if counts:
        lines += ["", "Also: " + ", ".join(f"{n} × {t.lower()}" for t, n in sorted(counts.items(), key=lambda x: -x[1]))]
    lines += ["", "All alerts: the Alerts tab on the Accounts page"]
    return "\n".join(lines)


# --- Main ----------------------------------------------------------------------------------------------------------

def _load(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save(path: str, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def merge_alerts(old: list[dict], new: Iterable[dict]) -> list[dict]:
    by_id = {a["id"]: a for a in old}
    for a in new:
        if a["id"] not in by_id or (a.get("hot") and not by_id[a["id"]].get("hot")):
            by_id[a["id"]] = {**by_id.get(a["id"], {}), **a}
    return sorted(by_id.values(), key=lambda a: a.get("at") or "", reverse=True)[:ALERTS_MAX]


# --- The Gazette: winding-up petitions (before Companies House shows any insolvency) --------------------------------

GAZETTE_FEED = ("https://www.thegazette.co.uk/all-notices/notice/data.feed?noticetype=2450&results-page-size=100"
                "&start-publish-date={since}")   # notice code 2450: petitions to wind up (companies); Open Government Licence
GAZETTE_DAYS = 14
_ATOM = "{http://www.w3.org/2005/Atom}"
_CO_NUMBER = re.compile(r"\b((?:SC|NI|OC|SO|NC)?\d{6,8})\b")


def gazette_petitions(tracked: dict[str, str], fetcher=None, today: Optional[date] = None) -> tuple[list[dict], int]:
    """(petition alerts for the lists' companies, notices read): matched by the company number in the notice, else by
    its name as the notice writes it."""
    today = today or date.today()
    xml = (fetcher or news.fetch)(GAZETTE_FEED.format(since=(today - timedelta(days=GAZETTE_DAYS)).isoformat()))
    if not xml:
        return [], 0
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return [], 0
    index = tracked_index(tracked)
    out, read = [], 0
    for entry in root.iter(_ATOM + "entry"):
        read += 1
        title = re.sub(r"\s+", " ", entry.findtext(_ATOM + "title") or "").strip()
        text = " ".join(t for t in entry.itertext() if t)
        number = next((n.zfill(8) for n in _CO_NUMBER.findall(text) if n.zfill(8) in tracked), "") or match_tracked(title, index)
        if not number:
            continue
        when = (entry.findtext(_ATOM + "published") or entry.findtext(_ATOM + "updated") or today.isoformat())[:10]
        link = next((l.get("href") for l in entry.iter(_ATOM + "link") if l.get("href")), "")
        out.append({"id": f"petition:{number}:{when}", "at": when + "T07:00:00", "kind": "petition", "company_number": number,
                    "company_name": tracked.get(number, ""), "tracked": True, "title": "Winding-up petition (Gazette)",
                    "detail": title[:160], "url": link or company_url(number), "hot": False})
    return out, read


def run_signals(args, store: dict, alerts: list[dict], now: datetime) -> None:
    tracked = _load(args.tracked, {}) or {}
    api_key = os.environ.get("COMPANIES_HOUSE_API_KEY", "").strip()
    news_alerts, news_found = news_signals(tracked, api_key, today=now.date())
    adverts = job_adverts()
    job_alerts, job_found = job_signals(tracked, api_key, adverts)
    discoveries = _load(args.discoveries, {}) or {}
    rows = {r["company_number"]: r for r in discoveries.get("rows") or []}
    for r in news_found + job_found:
        rows.setdefault(r["company_number"], r)
    old_ids = {a["id"] for a in alerts}
    petitions, notices = gazette_petitions(tracked, today=now.date())
    found = news_alerts + job_alerts + petitions
    fresh = [a for a in found if a["id"] not in old_ids]
    alerts = merge_alerts(alerts, found)
    sent = send_hot([a for a in fresh if a.get("hot") and a["tracked"]], "New hot alerts from the news",
                    limit=10) if args.telegram else "nothing (test run)"
    _save(args.alerts, {"made_at": now.isoformat(), "count": len(alerts), "items": alerts})
    _save(args.discoveries, {"made_at": now.isoformat(), "rows": sorted(rows.values(), key=lambda r: r.get("discovered", ""), reverse=True)[:500]})
    keys = "with job-board keys" if os.environ.get("ADZUNA_APP_ID") or os.environ.get("REED_API_KEY") else "no job-board keys"
    print(f"Signals: headlines read {STATS.get('headlines', 0)}, Companies House name lookups {STATS.get('name lookups', 0)}; "
          f"news alerts {len(news_alerts)} (new leads {len(news_found)}), job adverts read {len(adverts)} ({keys}), "
          f"hiring alerts {len(job_alerts)} (new leads {len(job_found)}); Gazette winding-up notices read {notices}, on the "
          f"lists {len(petitions)}; new alerts {len(fresh)}; sent: {sent}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tracked", default="tracked.json")
    parser.add_argument("--state", default="stream.json")
    parser.add_argument("--alerts", default="alerts.json")
    parser.add_argument("--discoveries", default="discoveries.json")
    parser.add_argument("--seconds", type=float, default=240, help="per stream")
    parser.add_argument("--telegram", action="store_true",
                        help="send the new hot alerts (one email a run; Telegram when no email is set up)")
    parser.add_argument("--digest", action="store_true", help="send the last 24 hours' summary (email, else Telegram) and stop")
    parser.add_argument("--signals", action="store_true",
                        help="news headlines (new FD, expansion abroad) and job adverts instead of the streams")
    args = parser.parse_args()

    store = _load(args.alerts, {}) or {}
    alerts = store.get("items") or []
    now = datetime.now(timezone.utc)
    if args.digest:
        text = digest(alerts, now)
        if not text:
            how = "nothing new"
        elif email_set_up():
            how = "emailed" if email(text.split("\n")[0], text) else "email failed"
        else:
            how = "sent to Telegram" if telegram(text) else "not sent (no email or Telegram set up)"
        print(f"digest: {len([a for a in alerts if (a.get('at') or '') >= (now - timedelta(hours=24)).isoformat()[:19]])} "
              f"alerts in the last 24 hours; {how}")
        return

    if args.signals:
        run_signals(args, store, alerts, now)
        return
    # A streaming key (CH_STREAM_KEY) if there is one, else the REST key: the streams' docs ask only for "an API key"
    stream_key = os.environ.get("CH_STREAM_KEY", "").strip()
    key = stream_key or os.environ.get("COMPANIES_HOUSE_API_KEY", "").strip()
    if not key:
        print("No Companies House key (CH_STREAM_KEY or COMPANIES_HOUSE_API_KEY). Nothing read.")
        with open("alerts_partial.txt", "w") as f:
            f.write("no stream key")
        return
    print(f"Streams read with the {'streaming key (CH_STREAM_KEY)' if stream_key else 'REST key (COMPANIES_HOUSE_API_KEY)'}")
    tracked = _load(args.tracked, {}) or {}
    state = _load(args.state, {}) or {}
    today = now.date()
    found: list[dict] = []
    stats: dict[str, int] = {}
    for name, path in STREAMS.items():
        events, last, why = read_stream(path, key, state.get(name), args.seconds)
        state[name] = last
        stats[f"{name} events"] = len(events)
        print(f"  {name}: {len(events):,} events ({why})")
        if why == "HTTP 401":
            print("    401: this key isn't allowed on the streams — the developer hub's application needs a key made "
                  "for the Streaming API (CH_STREAM_KEY)")
            with open("alerts_partial.txt", "w") as f:
                f.write("stream key rejected")
        for ev in events:
            a = classify(ev, tracked, today)
            if a:
                found.append(a)
    news_checked = 0
    for i, a in enumerate(found):
        if a["kind"] in ("new_director", "director_abroad") and news_checked < NEWS_CHECKS_MAX:
            found[i] = confirm_fd(a, today=today)
            news_checked += 1
    api_key = os.environ.get("COMPANIES_HOUSE_API_KEY", "").strip()
    discoveries = _load(args.discoveries, {}) or {}
    rows = {r["company_number"]: r for r in discoveries.get("rows") or []}
    for a in found:
        if a["kind"] == "fx_charge" and not a["tracked"]:
            a["company_name"] = a["company_name"] or (company_name(a["company_number"], api_key) if api_key else "")
            rows.setdefault(a["company_number"], {"company_number": a["company_number"], "company_name": a["company_name"],
                                                   "discovered": a["at"][:10], "discovered_by": a["detail"],
                                                   "fx_today": f"Uses an FX provider: {a['detail']}", "filed_fx_score": 60})
    # A charge moving: read that company's charges register once to see whether it changed bank
    switch_checked = 0
    for a in list(found):
        if a["kind"] in ("new_charge", "charge_paid") and a["tracked"] and api_key and switch_checked < SWITCH_CHECKS_MAX:
            switch_checked += 1
            try:
                moved = bank_switch(companies_house.get_charges(a["company_number"], api_key), today)
            except Exception:  # noqa: BLE001 — one register that won't read never stops the run
                moved = None
            if moved:
                found.append({**{k: a[k] for k in ("company_number", "company_name", "tracked")}, "id": f"bank_switch:{a['company_number']}:{moved[2][:10]}",
                              "at": a["at"], "kind": "bank_switch", "title": f"Changed bank: {moved[0]} → {moved[1]}",
                              "detail": f"all-assets charge to {moved[0]} paid off, new one to {moved[1]}",
                              "url": company_url(a["company_number"]) + "/charges", "hot": True})
    found += [f for f in funding_rounds(merge_alerts(alerts, found)) if f["id"] not in {a["id"] for a in alerts}]
    old_ids = {a["id"] for a in alerts}
    alerts = merge_alerts(alerts, found)
    fresh = [a for a in found if a["id"] not in old_ids]
    sent = send_hot([a for a in fresh if a.get("hot") and (a["tracked"] or a["kind"] == "fx_charge")],
                    "New hot alerts from Companies House") if args.telegram else "nothing (test run)"
    _save(args.state, state)
    _save(args.alerts, {"made_at": now.isoformat(), "count": len(alerts), "items": alerts})
    _save(args.discoveries, {"made_at": now.isoformat(), "rows": sorted(rows.values(), key=lambda r: r.get("discovered", ""), reverse=True)[:500]})
    kinds: dict[str, int] = {}
    for a in fresh:
        kinds[a["kind"]] = kinds.get(a["kind"], 0) + 1
    print(f"New alerts: {len(fresh)} ({', '.join(f'{k} {n}' for k, n in sorted(kinds.items())) or 'none'}); "
          f"news checks {news_checked}; charges registers read {switch_checked}; sent: {sent}; discoveries on file {len(rows)}; tracked companies {len(tracked):,}")


if __name__ == "__main__":
    main()
