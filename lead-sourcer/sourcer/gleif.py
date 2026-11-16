"""
sourcer/gleif.py — who owns a company, from the Global LEI register (GLEIF) — free open data, no key, no searching
(Zac, 16 Nov 2026: "automated, ideally without API usage"). A company that trades FX forwards or other derivatives must
hold a Legal Entity Identifier, and each LEI record states its direct and ultimate accounting parent (Level 2
"relationship records"), or why it has none ("reporting exceptions": owned by natural persons, non-consolidating …).

Three daily "golden copy" files, read once a run as streams (zipped CSV):
  * lei2  — every LEI: legal name, country, and the registration number (Companies House: RA000585) → our match key;
  * rr    — relationships: child LEI IS_DIRECTLY / IS_ULTIMATELY_CONSOLIDATED_BY parent LEI;
  * repex — reporting exceptions: child LEI, which parent (direct / ultimate), the reason there's none.
Column names are matched by their ending (the files use dotted names, e.g. "Entity.LegalAddress.Country").
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import time
import urllib.request
import zipfile
from typing import Iterator, Optional

HEADERS = {"User-Agent": "fx-lead-sourcer (open-data reader)"}

INDEX = "https://goldencopy.gleif.org/api/v2/golden-copies/publishes/latest"
DIRECT = "https://goldencopy.gleif.org/api/v2/golden-copies/publishes/{kind}/latest.csv"
COMPANIES_HOUSE = {"RA000585"}   # GLEIF's code for Companies House (England & Wales, Scotland, Northern Ireland)
UK_CODES = {"GB", "JE", "GG", "IM"}
COUNTRY = {"GB": "United Kingdom", "JE": "Jersey", "GG": "Guernsey", "IM": "Isle of Man", "US": "United States",
           "DE": "Germany", "FR": "France", "NL": "Netherlands", "IE": "Ireland", "LU": "Luxembourg", "BE": "Belgium",
           "CH": "Switzerland", "SE": "Sweden", "DK": "Denmark", "NO": "Norway", "FI": "Finland", "IT": "Italy", "ES": "Spain",
           "PT": "Portugal", "AT": "Austria", "JP": "Japan", "CN": "China", "HK": "Hong Kong", "SG": "Singapore", "IN": "India",
           "CA": "Canada", "AU": "Australia", "AE": "United Arab Emirates", "KY": "Cayman Islands", "BM": "Bermuda",
           "VG": "British Virgin Islands", "IL": "Israel", "KR": "South Korea", "TW": "Taiwan", "ZA": "South Africa",
           "PL": "Poland", "CZ": "Czechia", "TR": "Turkey", "BR": "Brazil", "MX": "Mexico", "SA": "Saudi Arabia", "QA": "Qatar"}
REASONS = {"NATURAL_PERSONS": "owned by individuals (no parent company)", "NON_CONSOLIDATING": "its parent doesn't consolidate it",
           "NO_KNOWN_PERSON": "no known owner", "NON_PUBLIC": "parent not made public", "BINDING_LEGAL_COMMITMENTS": "parent withheld (legal reasons)",
           "LEGAL_OBSTACLES": "parent withheld (legal obstacles)", "DISCLOSURE_DETRIMENTAL": "parent withheld",
           "DETRIMENT_NOT_EXCLUDED": "parent withheld", "CONSENT_NOT_OBTAINED": "parent withheld (no consent)",
           "NO_LEI": "its parent has no LEI"}


def country_name(code: str) -> str:
    return COUNTRY.get((code or "").upper(), code or "")


def normalise_number(raw: str) -> str:
    """Companies House number as the register writes it: 8 characters, zero-padded digits after any prefix."""
    s = re.sub(r"\s+", "", (raw or "").upper())
    m = re.match(r"^([A-Z]{2})?(\d{1,8})$", s)
    if not m:
        return s
    prefix, digits = m.group(1) or "", m.group(2)
    return prefix + digits.zfill(8 - len(prefix))


def _urls() -> dict:
    """{lei2, rr, repex}: the latest full CSV files (direct links first, else found in the publishes index)."""
    out = {k: DIRECT.format(kind=k) for k in ("lei2", "rr", "repex")}
    try:
        found: list[str] = []

        def walk(x):
            if isinstance(x, dict):
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
            elif isinstance(x, str) and x.startswith("http") and "csv" in x.lower() and "delta" not in x.lower():
                found.append(x)
        with urllib.request.urlopen(urllib.request.Request(INDEX, headers=HEADERS), timeout=60) as res:
            walk(json.load(res))
        for k in out:
            hit = next((u for u in found if re.search(rf"[/-]{k}[/-]|{k}-golden-copy", u, re.I)), None)
            if hit:
                out[k] = hit
    except Exception as e:   # the direct links still work
        print(f"GLEIF index not read ({e}); using the direct links")
    return out


def download(cache_dir: str) -> dict:
    """{lei2, rr, repex}: local paths of today's files (kept in cache_dir; re-downloaded when a day old)."""
    os.makedirs(cache_dir, exist_ok=True)
    paths = {}
    for kind, url in _urls().items():
        path = os.path.join(cache_dir, f"gleif-{kind}.csv.zip")
        fresh = os.path.exists(path) and (os.path.getmtime(path) > time.time() - 20 * 3600)
        if not fresh:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=600) as res, open(path + ".part", "wb") as f:
                while chunk := res.read(1 << 20):
                    f.write(chunk)
            os.replace(path + ".part", path)
        paths[kind] = path
    return paths


def _table(path: str, wanted: dict) -> Iterator[dict]:
    """Each row of a zipped (or plain) CSV as {field: value} for the wanted fields only, each found once in the header
    by its name's ending ({"lei": ("LEI",), …}; the first ending that matches a column wins)."""
    def stream(f):
        reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8", newline=""))
        header = [h.strip() for h in next(reader, [])]
        index = {}
        for field, endings in wanted.items():
            for e in endings:
                hit = next((i for i, h in enumerate(header) if h.lower() == e.lower() or h.lower().endswith("." + e.lower())), None)
                if hit is not None:
                    index[field] = hit
                    break
        print(f"  {os.path.basename(path)}: {len(header)} columns; found {', '.join(f'{k}={header[i]}' for k, i in index.items())}"
              f"{'; MISSING ' + ', '.join(k for k in wanted if k not in index) + ' — columns: ' + ', '.join(header) if len(index) < len(wanted) else ''}")
        for row in reader:
            yield {k: (row[i] if i < len(row) else "") for k, i in index.items()}
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            name = next((n for n in z.namelist() if n.lower().endswith(".csv")), z.namelist()[0])
            with z.open(name) as f:
                yield from stream(f)
    else:
        with open(path, "rb") as f:
            yield from stream(f)


def owners(paths: dict, tracked: set[str]) -> dict:
    """{company number: {lei, direct, direct_country, ultimate, ultimate_country, exception}} for the tracked companies
    that hold an LEI; parents by name and full country name; `exception` says why a parent isn't given."""
    # pass 1 — relationships (small): child LEI → {direct, ultimate} parent LEI
    rel: dict[str, dict] = {}
    for row in _table(paths["rr"], {"child": ("StartNode.NodeID",), "parent": ("EndNode.NodeID",),
                                    "kind": ("RelationshipType",), "status": ("RelationshipStatus",)}):
        if row.get("status", "").upper() not in ("ACTIVE", "") or not row.get("child") or not row.get("parent"):
            continue
        kind = row.get("kind", "").upper()
        if "ULTIMATELY" in kind:
            rel.setdefault(row["child"], {})["ultimate"] = row["parent"]
        elif "DIRECTLY" in kind:
            rel.setdefault(row["child"], {})["direct"] = row["parent"]
    # pass 2 — every LEI: our companies by number; names and countries of every parent
    parents = {p for r in rel.values() for p in r.values()}
    lei_of: dict[str, str] = {}
    entity: dict[str, tuple[str, str]] = {}
    for row in _table(paths["lei2"], {"lei": ("LEI",), "name": ("Entity.LegalName", "LegalName"),
                                      "country": ("Entity.LegalAddress.Country", "LegalAddress.Country"),
                                      "authority": ("RegistrationAuthority.RegistrationAuthorityID", "RegistrationAuthorityID"),
                                      "number": ("RegistrationAuthority.RegistrationAuthorityEntityID", "RegistrationAuthorityEntityID")}):
        lei = row.get("lei", "")
        if row.get("authority", "").upper() in COMPANIES_HOUSE:
            number = normalise_number(row.get("number", ""))
            if number in tracked:
                lei_of[number] = lei
                entity[lei] = (row.get("name", ""), row.get("country", ""))
        if lei in parents:
            entity[lei] = (row.get("name", ""), row.get("country", ""))
    # pass 3 — reporting exceptions for our LEIs (why no ultimate parent is given)
    ours = set(lei_of.values())
    why: dict[str, str] = {}
    for row in _table(paths["repex"], {"lei": ("LEI",), "category": ("ExceptionCategory", "Category", "Exception.Category"),
                                       "reason": ("ExceptionReason", "ExceptionReason1", "Reason", "Exception.Reason", "ExceptionReasons")}):
        if row.get("lei") in ours and "ULTIMATE" in row.get("category", "").upper():
            reason = row.get("reason", "").upper()
            why[row["lei"]] = REASONS.get(reason, reason.replace("_", " ").lower())
    out = {}
    for number, lei in lei_of.items():
        r = rel.get(lei, {})
        d, u = entity.get(r.get("direct", ""), ("", "")), entity.get(r.get("ultimate", ""), ("", ""))
        out[number] = {"lei": lei, "direct": d[0], "direct_country": country_name(d[1]), "ultimate": u[0],
                       "ultimate_country": country_name(u[1]), "uk": (u[1] or d[1] or "GB").upper() in UK_CODES if (u[0] or d[0]) else None,
                       "exception": why.get(lei, "")}
    return out


def save(out: dict, path: str) -> None:
    with open(path, "w") as f:
        json.dump({"companies": out}, f)


def load(path: Optional[str]) -> dict:
    try:
        return json.load(open(path)).get("companies", {}) if path else {}
    except (OSError, ValueError):
        return {}
