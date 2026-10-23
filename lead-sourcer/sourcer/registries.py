"""
sourcer/registries.py — gov.uk registries where a company names a real
person, with their job title, on a dated filing the law requires:

  - gender pay gap reports (employers with 250+ staff, yearly): the
    "responsible person", e.g. "Jane Smith (Finance Director)";
  - modern slavery statements (turnover £36m+, yearly): the person who
    approved the statement.

Both are free bulk CSV downloads keyed by company number. A finance title
here is a dated, first-hand statement of who does the job; any title here
for the person we picked is independent proof they work there (or, if it
isn't a finance title, a sign we picked the wrong person).

Files are cached for CACHE_DAYS under ~/.cache/fx-lead-sourcer/registries.
"""

from __future__ import annotations

import csv
import io
import os
import re
import time
import urllib.request
from datetime import date, datetime
from typing import Callable, Optional

GENDER_PAY_GAP = "gender pay gap report"
MODERN_SLAVERY = "modern slavery statement"
GPG_URL = "https://gender-pay-gap.service.gov.uk/viewing/download-data/{year}"
MSS_URL = "https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads/StatementSummaries{year}.csv"
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "fx-lead-sourcer", "registries")
CACHE_DAYS = 30
MAX_AGE_YEARS = 3         # older filings are likely out of date
USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"

Fetcher = Callable[[str], Optional[str]]


def fetch(url: str) -> Optional[str]:
    """The file's text, from the cache when fresh; None on any failure."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, re.sub(r"[^A-Za-z0-9.]+", "_", url.split("//", 1)[-1]))
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_DAYS * 86400:
        with open(path, encoding="utf-8") as f:
            return f.read()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            text = resp.read().decode("utf-8-sig", "replace")
    except Exception:  # noqa: BLE001 — a missing year or an outage just means fewer names
        return None
    if "<html" in text[:500].lower():
        return None
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def company_number(value: str) -> str:
    value = (value or "").strip().upper()
    return value.zfill(8) if value.isdigit() else value


def split_person(value: str) -> tuple[str, str]:
    """"Jane Smith (Finance Director)" -> ("Jane Smith", "Finance Director")."""
    value = " ".join((value or "").split())
    m = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", value)
    return (m.group(1).strip(), m.group(2).strip()) if m else (value, "")


def _date(value: str) -> str:
    value = (value or "").strip()
    for fmt, size in (("%Y-%m-%d", 10), ("%Y/%m/%d", 10), ("%d/%m/%Y", 10)):
        try:
            return datetime.strptime(value[:size], fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def parse(text: str, source: str, number_col: str, person_col: str, date_col: str) -> dict[str, list[dict]]:
    """{company_number: [{"name", "title", "date", "source"}]} from one registry file."""
    found: dict[str, list[dict]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        number = company_number(row.get(number_col, ""))
        name, title = split_person(row.get(person_col, ""))
        if number and name:
            found.setdefault(number, []).append({"name": name, "title": title, "date": _date(row.get(date_col, "")),
                                                 "source": source})
    return found


def load(today: Optional[date] = None, fetcher: Optional[Fetcher] = None) -> dict[str, list[dict]]:
    """
    {company_number: [person, ...]} from the last few years of both
    registries, newest first, one entry per person and registry.
    """
    today = today or date.today()
    fetcher = fetcher or fetch
    files = [(GPG_URL.format(year=y), GENDER_PAY_GAP, "CompanyNumber", "ResponsiblePerson", "DateSubmitted")
             for y in range(today.year, today.year - MAX_AGE_YEARS, -1)]
    files += [(MSS_URL.format(year=y), MODERN_SLAVERY, "CompanyNumber", "ApprovingPerson", "DateApproved")
              for y in range(today.year + 1, today.year - MAX_AGE_YEARS, -1)]
    merged: dict[str, list[dict]] = {}
    for url, source, number_col, person_col, date_col in files:
        text = fetcher(url)
        if not text:
            continue
        for number, entries in parse(text, source, number_col, person_col, date_col).items():
            merged.setdefault(number, []).extend(entries)
    oldest = date(today.year - MAX_AGE_YEARS, today.month, min(today.day, 28)).isoformat()
    for number, entries in merged.items():
        entries.sort(key=lambda e: e["date"], reverse=True)
        seen, kept = set(), []
        for e in entries:
            key = (e["name"].upper(), e["source"])
            if key not in seen and (not e["date"] or e["date"] >= oldest):
                seen.add(key)
                kept.append(e)
        merged[number] = kept
    return merged
