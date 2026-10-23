"""
sourcer/bulk.py — candidate companies from Companies House's free monthly
bulk company file ("Basic Company Data": every live company on the
register, one CSV inside a ~470MB zip).

The search API can list a SIC code's companies but says nothing about
their size until you fetch each profile — thousands of calls for one busy
code, so in practice only a sample. The bulk file carries every company's
SIC codes and the category of its last accounts, so the niche + size
filter covers every company and costs no API calls.

Published a few days into each month at download.companieshouse.gov.uk.
"""

from __future__ import annotations

import csv
import io
import os
import urllib.error
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from typing import Iterator, Optional

BULK_URL = "https://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-{snapshot}.zip"
DEFAULT_CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "fx-lead-sourcer")
USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"

# Header names in the file (some carry stray leading spaces — stripped on read).
REQUIRED_COLUMNS = (
    "CompanyName", "CompanyNumber", "CompanyStatus", "CompanyCategory",
    "IncorporationDate", "Accounts.AccountCategory", "Accounts.LastMadeUpDate",
    "RegAddress.AddressLine1", "RegAddress.AddressLine2", "RegAddress.PostTown",
    "RegAddress.County", "RegAddress.PostCode",
    "SICCode.SicText_1", "SICCode.SicText_2", "SICCode.SicText_3", "SICCode.SicText_4",
)
SIC_COLUMNS = ("SICCode.SicText_1", "SICCode.SicText_2", "SICCode.SicText_3", "SICCode.SicText_4")


def snapshot_dates(today: date) -> list[str]:
    """This month's and last month's snapshot dates (the file lands a few days into the month)."""
    this_month = today.replace(day=1)
    last_month = (this_month - timedelta(days=1)).replace(day=1)
    return [this_month.isoformat(), last_month.isoformat()]


def download(cache_dir: str = DEFAULT_CACHE_DIR, today: Optional[date] = None) -> str:
    """
    Path to the newest bulk zip, downloading it into `cache_dir` unless it's
    already there. A fresh download replaces older snapshots in the cache.
    """
    os.makedirs(cache_dir, exist_ok=True)
    for snapshot in snapshot_dates(today or date.today()):
        path = os.path.join(cache_dir, f"BasicCompanyDataAsOneFile-{snapshot}.zip")
        if os.path.exists(path):
            return path
        try:
            _fetch_to(BULK_URL.format(snapshot=snapshot), path)
        except urllib.error.HTTPError as e:
            if e.code == 404:  # this month's file isn't published yet
                continue
            raise
        for name in os.listdir(cache_dir):
            if name.startswith("BasicCompanyDataAsOneFile-") and name != os.path.basename(path):
                os.remove(os.path.join(cache_dir, name))
        return path
    raise RuntimeError("no Companies House bulk file published for this month or last")


def _fetch_to(url: str, path: str) -> None:
    print(f"Downloading {url} …", flush=True)
    part = path + ".part"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as resp, open(part, "wb") as out:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    os.replace(part, path)


def iter_rows(zip_path: str) -> Iterator[list[str]]:
    """The header (names stripped), then each row, of the CSV inside the bulk zip."""
    with zipfile.ZipFile(zip_path) as zf:
        member = next((n for n in zf.namelist() if n.lower().endswith(".csv")), None)
        if member is None:
            raise ValueError(f"no CSV inside {zip_path}")
        with zf.open(member) as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline=""))
            header = [h.strip() for h in next(reader)]
            missing = [c for c in REQUIRED_COLUMNS if c not in header]
            if missing:
                raise ValueError(f"unexpected bulk file format — missing columns: {', '.join(missing)}")
            yield header
            yield from reader


def normalise_category(value: str) -> str:
    """Bulk-file accounts category ("AUDIT EXEMPTION SUBSIDIARY") -> API style ("audit-exemption-subsidiary")."""
    return "-".join(value.strip().lower().split())


def sic_code(sic_text: str) -> str:
    """"46342 - Wholesale of wine, beer, spirits…" -> "46342" ("" for "None Supplied")."""
    code = sic_text.split(" - ", 1)[0].strip()
    return code if code.isdigit() else ""


def _iso_date(value: str) -> str:
    """The file's dd/mm/yyyy -> yyyy-mm-dd (unchanged if it isn't in that format)."""
    value = value.strip()
    try:
        return datetime.strptime(value, "%d/%m/%Y").date().isoformat()
    except ValueError:
        return value


def find_candidates(zip_path: str, sic_codes: set[str], categories: set[str]) -> list[dict]:
    """
    Active, trading companies registered under any of `sic_codes` whose last
    accounts category (normalised, e.g. "medium") is in `categories`.
    Guarantee companies and charities are left out — they're not trading
    businesses with supplier invoices.
    """
    return scan(zip_path, sic_codes, categories)[0]


def scan(
    zip_path: str,
    sic_codes: set[str],
    categories: set[str],
    postcodes: Optional[set[str]] = None,
    names: Optional[set[str]] = None,
) -> tuple[list[dict], dict[str, list[dict]], dict[str, list[dict]]]:
    """
    One pass over the bulk file:
      candidates   — as find_candidates()
      by_postcode  — every active trading company (any size) at one of `postcodes`
      by_name      — every active trading company whose normalised name is in `names`
    Postcodes and names are normalised as in sourcer.matching. The two
    indexes are for matching HMRC traders, which can be any size or sector.
    """
    from sourcer.matching import normalise_name, normalise_postcode

    rows = iter_rows(zip_path)
    header = next(rows)
    col = {name: i for i, name in enumerate(header)}
    sic_cols = [col[c] for c in SIC_COLUMNS]
    width = len(header)

    candidates: list[dict] = []
    by_postcode: dict[str, list[dict]] = {}
    by_name: dict[str, list[dict]] = {}
    scanned = 0
    for values in rows:
        scanned += 1
        if scanned % 1_000_000 == 0:
            print(f"  bulk file: {scanned:,} companies scanned, {len(candidates):,} candidates", flush=True)
        if len(values) < width or values[col["CompanyStatus"]].strip() != "Active":
            continue
        company_type = values[col["CompanyCategory"]].lower()
        if "guar" in company_type or "charit" in company_type:
            continue
        sics = [code for code in (sic_code(values[i]) for i in sic_cols) if code]
        category = normalise_category(values[col["Accounts.AccountCategory"]])
        in_frame = bool(sic_codes.intersection(sics)) and category in categories
        postcode = normalise_postcode(values[col["RegAddress.PostCode"]]) if postcodes else ""
        at_postcode = bool(postcodes) and postcode in postcodes
        name_key = normalise_name(values[col["CompanyName"]]) if names else ""
        named = bool(names) and name_key in names
        if not (in_frame or at_postcode or named):
            continue
        address = [values[col[c]].strip() for c in
                   ("RegAddress.AddressLine1", "RegAddress.AddressLine2", "RegAddress.PostTown", "RegAddress.County")]
        company = {
            "company_number": values[col["CompanyNumber"]].strip(),
            "company_name": values[col["CompanyName"]].strip(),
            "sic_codes": sics,
            "accounts_category": category,
            "accounts_made_up_to": _iso_date(values[col["Accounts.LastMadeUpDate"]]),
            "incorporated_on": _iso_date(values[col["IncorporationDate"]]),
            "postcode": values[col["RegAddress.PostCode"]].strip(),
            "registered_address": ", ".join(a for a in address if a),
        }
        if in_frame:
            candidates.append(company)
        if at_postcode:
            by_postcode.setdefault(postcode, []).append(company)
        if named:
            by_name.setdefault(name_key, []).append(company)

    print(f"  bulk file: {scanned:,} companies scanned, {len(candidates):,} candidates"
          + (f", {sum(map(len, by_postcode.values())):,} at trader postcodes, {len(by_name):,} trader names" if postcodes or names else ""))
    return candidates, by_postcode, by_name
