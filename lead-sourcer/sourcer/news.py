"""
sourcer/news.py — finance appointments in the news ("Acme Wines appoints
Jane Smith as Finance Director"), from Google News search feeds (RSS).

Used only for companies whose finance contact isn't already confirmed by
their filings or website. A headline counts only if it names the company;
items older than NEWS_YEARS are ignored. A finance appointment in the last
12 months is also a trigger: new finance directors review their banks and
FX providers.
"""

from __future__ import annotations

import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from email.utils import parsedate_to_datetime
from typing import Callable, Iterable, Optional

from sourcer import matching, people

FEED = "https://news.google.com/rss/search?{query}"
USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"
TIMEOUT_SECONDS = 10
NEWS_YEARS = 4          # older appointments are likely out of date
CONFIRMED_YEARS = 2     # newer than this counts as confirmed
WORKERS = 4             # one news service: keep it gentle
_TITLES_QUERY = '("finance director" OR CFO OR "chief financial officer" OR "financial controller" OR "head of finance")'

Fetcher = Callable[[str], Optional[str]]


def fetch(url: str) -> Optional[str]:
    """The feed's XML text, or None on any failure."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return resp.read(2_000_000).decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 — no news is fine
        return None


def short_name(company_name: str) -> str:
    """"ACME WINE IMPORTERS LIMITED" -> "Acme Wine Importers" (as it'd be written in a headline)."""
    core = matching.normalise_name(company_name)
    return core.title() if core else company_name.title()


def feed_url(company_name: str) -> str:
    query = f'"{short_name(company_name)}" {_TITLES_QUERY}'
    return FEED.format(query=urllib.parse.urlencode({"q": query, "hl": "en-GB", "gl": "GB", "ceid": "GB:en"}))


def _plain(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html or "")).strip()


def appointments(company_name: str, fetcher: Optional[Fetcher] = None, today: Optional[date] = None) -> list[dict]:
    """
    [{"name", "title", "confidence", "note", "date"}] — people named with a
    finance title in recent headlines that mention the company, newest first.
    """
    today = today or date.today()
    xml = (fetcher or fetch)(feed_url(company_name))
    if not xml:
        return []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    wanted = short_name(company_name).upper()
    found: dict[str, dict] = {}
    for item in root.iter("item"):
        headline = _plain(item.findtext("title") or "")
        # The headline must name the company: Google News descriptions list related stories' headlines too, so
        # "Other Co appoints Jane Smith as CFO" next to an Acme story would otherwise become Acme's FD.
        if wanted not in headline.upper():
            continue  # about someone else
        try:
            when = parsedate_to_datetime(item.findtext("pubDate") or "").date()
        except (TypeError, ValueError):
            continue
        age_years = (today - when).days / 365
        if age_years > NEWS_YEARS:
            continue
        source = _plain(item.findtext("source") or "") or "news"
        not_names = f"{company_name} {source}"
        for p in people.finance_people(headline, not_names):
            key = p["name"].upper()
            if key in found and found[key]["date"] >= when.isoformat():
                continue
            found[key] = {**p, "date": when.isoformat(),
                          "confidence": people.CONFIRMED if age_years <= CONFIRMED_YEARS else people.LIKELY,
                          "note": f"{source}, {when.isoformat()[:7]}"}
    return sorted(found.values(), key=lambda p: p["date"], reverse=True)


def appointments_many(company_names: Iterable[tuple[str, str]], fetcher: Optional[Fetcher] = None,
                      today: Optional[date] = None) -> dict[str, list[dict]]:
    """{company_number: appointments(...)} for (company_number, company_name) pairs, a few at a time."""
    companies = list(company_names)
    if not companies:
        return {}
    with ThreadPoolExecutor(max_workers=min(WORKERS, len(companies))) as pool:
        results = pool.map(lambda c: appointments(c[1], fetcher, today), companies)
        return {c[0]: r for c, r in zip(companies, results)}


def verify_links(company_name: str, contact_name: str = "") -> tuple[str, str]:
    """
    (Google search URL, LinkedIn people-search URL) for checking the finance
    contact by hand — links only; nothing here fetches LinkedIn.
    """
    company = short_name(company_name)
    # Plain "<company> finance director": shows who holds the job now, whoever we picked (contact_name is not used).
    google = f"{company} finance director"
    linkedin = f"{company} finance director"
    return ("https://www.google.com/search?" + urllib.parse.urlencode({"q": google}),
            "https://www.linkedin.com/search/results/people/?" + urllib.parse.urlencode({"keywords": linkedin}))


def is_recent(item_date: str, today: Optional[date] = None, days: int = 365) -> bool:
    try:
        return ((today or date.today()) - datetime.strptime(item_date[:10], "%Y-%m-%d").date()).days <= days
    except ValueError:
        return False
