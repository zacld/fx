"""
sourcer/hmrc.py — who actually imports and exports, from HMRC customs records.

HMRC publishes, every month, the name, address and goods (8-digit commodity
codes) of every UK business that made a customs import or export declaration
— about 100,000 importers and 50,000 exporters a month. Appearing there is
an official record of cross-border trade, so foreign-currency payments are
all but certain; appearing month after month shows a regular payment flow.
No values are published, only who and what.

Files are tab-separated, one row per trader per month:
  period (YYYYMM), flag, name, address 1-5, postcode, then up to 50 codes.
Their download links change every month, so they're read off the
uktradeinfo pages rather than built.
"""

from __future__ import annotations

import io
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from typing import Iterable, Iterator, Optional

LATEST_PAGE = "https://www.uktradeinfo.com/trade-data/latest-bulk-data-sets/"
ARCHIVE_PAGE = "https://www.uktradeinfo.com/trade-data/latest-bulk-data-sets/bulk-data-sets-archive/"
DEFAULT_CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "fx-lead-sourcer", "hmrc")
USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"

# Trader detail files ("importers"/"exporters") and the national trade statistics
# by goods x country ("bdsimp"/"bdsexp") share naming patterns.
_FLOWS = {"importers": "import", "exporters": "export", "bdsimp": "import", "bdsexp": "export"}
_MONTHLY_RE = re.compile(r"(importers|exporters|bdsimp|bdsexp)(\d{4})\.zip$", re.I)
# Archive bundles: importers by half-year, exporters by year, named inconsistently:
# importers_jan-jun26archive.zip, importers_jul-dec2023archive.zip, exporters_2025archive.zip, exporters2021_archive.zip
_ARCHIVE_RE = re.compile(r"(importers|exporters|bdsimp|bdsexp)_?(?:(jan-jun|jul-dec)_?)?(\d{2}|\d{4})_?archive\.zip$", re.I)


def _get(url: str, limit: Optional[int] = None) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as resp:
        return resp.read(limit) if limit else resp.read()


def list_files(pages: Iterable[str] = (LATEST_PAGE, ARCHIVE_PAGE), kind: str = "traders") -> dict[tuple[str, str], str]:
    """
    {(flow, key): url} for every file of `kind` linked from the pages:
    "traders" = importer/exporter detail files, "stats" = trade statistics
    by goods x country (bdsimp/bdsexp). key is "M2608" for a monthly file (Aug 2026), "A2025" for a
    yearly archive bundle, "A2025-H1" / "A2025-H2" for a half-year one.
    """
    found: dict[tuple[str, str], str] = {}
    for page in pages:
        try:
            html = _get(page).decode("utf-8", "replace")
        except (urllib.error.URLError, OSError) as e:
            print(f"WARNING: couldn't read {page}: {e}")
            continue
        for href in re.findall(r'href="([^"]+)"', html):
            path = href.split("?")[0]
            monthly, archive = _MONTHLY_RE.search(path), _ARCHIVE_RE.search(path)
            match = monthly or archive
            if not match or (match.group(1).lower().startswith("bds")) != (kind == "stats"):
                continue
            if monthly:
                flow, key = monthly.group(1), "M" + monthly.group(2)
            elif archive:
                year = archive.group(3) if len(archive.group(3)) == 4 else "20" + archive.group(3)
                half = {"jan-jun": "-H1", "jul-dec": "-H2"}.get((archive.group(2) or "").lower(), "")
                flow, key = archive.group(1), "A" + year + half
            else:
                continue
            flow = _FLOWS[flow.lower()]
            found.setdefault((flow, key), urllib.parse.urljoin(page, href))
    return found


def window(keys: Iterable[str], months: int) -> tuple[str, set[str]]:
    """
    (earliest period to keep, "YYYYMM"; the keys worth downloading) for the
    latest `months` months: monthly files in the window plus the archive
    bundles for the years (or half-years) it reaches back into.
    """
    keys = set(keys)
    monthly = sorted(k for k in keys if k.startswith("M"))
    latest = "20" + monthly[-1][1:] if monthly else max(k[1:5] for k in keys) + "12"
    y, m = int(latest[:4]), int(latest[4:6]) - (months - 1)
    while m <= 0:
        y, m = y - 1, m + 12
    since = f"{y:04d}{m:02d}"
    wanted = set()
    for k in keys:
        if k.startswith("M"):
            if "20" + k[1:] >= since:
                wanted.add(k)
            continue
        year, half = k[1:5], k[5:]
        if year < since[:4] or year > latest[:4]:
            continue
        if year == since[:4] and half == "-H1" and int(since[4:]) > 6:
            continue  # the window starts after June that year
        wanted.add(k)
    return since, wanted


def download(months: int = 12, cache_dir: str = DEFAULT_CACHE_DIR, kind: str = "traders") -> tuple[list[str], str]:
    """(paths to cached files covering the latest `months` months, earliest period "YYYYMM" to keep)."""
    os.makedirs(cache_dir, exist_ok=True)
    files = list_files(kind=kind)
    if not files:
        raise RuntimeError(f"no HMRC {kind} files found on uktradeinfo")
    since, wanted = window((k for _, k in files), months)
    this_year = time.strftime("%Y")
    paths = []
    for (flow, key), url in sorted(files.items()):
        if key not in wanted:
            continue
        path = os.path.join(cache_dir, f"{flow}s-{'stats-' if kind == 'stats' else ''}{key}.zip")
        # This year's archive bundles grow as months are added: refresh weekly.
        growing = key.startswith("A" + this_year) and os.path.exists(path) \
            and time.time() - os.path.getmtime(path) > 7 * 86_400
        if not os.path.exists(path) or growing:
            print(f"  HMRC {flow}s {key}: downloading")
            with open(path + ".part", "wb") as out:
                out.write(_get(url))
            os.replace(path + ".part", path)
        paths.append(path)
    print(f"  HMRC {kind} files: {len(paths)}, keeping {since[:4]}-{since[4:]} onwards")
    return paths, since


def _clean(field: str) -> str:
    return field.strip().strip("\"'").strip()


def _txt_members(zf: zipfile.ZipFile) -> Iterator[tuple[str, io.TextIOBase]]:
    """(name, text stream) for every .txt inside, including inside nested zips (archive bundles)."""
    for member in zf.namelist():
        lower = member.lower()
        if lower.endswith(".txt"):
            yield member, io.TextIOWrapper(zf.open(member), encoding="latin-1", newline="")
        elif lower.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(zf.read(member))) as inner:
                yield from _txt_members(inner)


def iter_records(path: str, since: str = "") -> Iterator[dict]:
    """{"flow", "period", "name", "postcode", "address", "codes"} per row; rows before `since` (YYYYMM) skipped."""
    flow = "import" if os.path.basename(path).lower().startswith("import") else "export"  # imports-…/exports-… cache names
    with zipfile.ZipFile(path) as zf:
        for _, text in _txt_members(zf):
            for line in text:
                cols = line.rstrip("\r\n").split("\t")
                if len(cols) < 10 or not cols[0].strip().isdigit():
                    continue
                period = cols[0].strip()
                if since and period < since:
                    continue
                codes = [c.strip() for c in cols[9:] if c.strip().isdigit()]
                yield {
                    "flow": flow,
                    "period": period,
                    "name": _clean(cols[2]),
                    "postcode": _clean(cols[8]),
                    "address": ", ".join(a for a in (_clean(c) for c in cols[3:8]) if a),
                    "codes": codes,
                }


def build_traders(paths: Iterable[str], since: str = "", codes_since: str = "") -> dict[tuple[str, str], dict]:
    """
    One record per trader (keyed on normalised name + postcode) across all
    the monthly files: the months it imported / exported and how many months
    each commodity code appeared. With codes_since (YYYYMM), codes are counted
    only from that month on; earlier ones are kept as a set, early_codes (a
    longer history read for the months traded, the goods measured on the
    latest year — tools/niche_hits.py).
    """
    from sourcer.matching import normalise_name, normalise_postcode

    traders: dict[tuple[str, str], dict] = {}
    for path in paths:
        for rec in iter_records(path, since):
            key = (normalise_name(rec["name"]), normalise_postcode(rec["postcode"]))
            if not key[0]:
                continue
            t = traders.setdefault(key, {
                "name": rec["name"], "postcode": rec["postcode"],
                "import_months": set(), "export_months": set(),
                "import_codes": Counter(), "export_codes": Counter(), "early_codes": set(),
            })
            t[f"{rec['flow']}_months"].add(rec["period"])
            if codes_since and rec["period"] < codes_since:
                t["early_codes"].update(rec["codes"])
            else:
                t[f"{rec['flow']}_codes"].update(set(rec["codes"]))
    return traders


def months_back(period: str, n: int) -> str:
    """ "202611", 2 -> "202609"."""
    y, m = int(period[:4]), int(period[4:6]) - n
    while m <= 0:
        y, m = y - 1, m + 12
    return f"{y:04d}{m:02d}"


RECENT_MONTHS = 3          # first customs records within the latest this many months of the files: a new flow
LAG_MONTHS = 2             # the files are published about this long after the month they cover
TRADE_UP_MONTHS = 4        # this many more months active than the year before: trade growing
_MONTH_NAMES = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()


def _month_label(period: str) -> str:
    return f"{_MONTH_NAMES[int(period[4:6]) - 1]} {period[:4]}"


def moment(trade: dict, latest: str, months: int = 24) -> Optional[dict]:
    """
    The moment a company's customs records show, or None: kind new_trader (its first records in `months` months,
    within the latest RECENT_MONTHS), new_import / new_export (that flow started recently; it traded the other way
    before) or trade_up (TRADE_UP_MONTHS+ more months active than the year before, or twice as many kinds of goods —
    5+ more). {kind, title, detail, since (YYYYMM), at (ISO date: when the files showed it)}.
    """
    imp, exp = set(trade.get("import_months") or ()), set(trade.get("export_months") or ())
    if not imp and not exp:
        return None
    recent = months_back(latest, RECENT_MONTHS - 1)
    year = months_back(latest, 11)
    def made(kind: str, title: str, detail: str, since: str) -> dict:
        shown = months_back(since, -LAG_MONTHS)
        return {"kind": kind, "title": title, "detail": detail, "since": since, "at": f"{shown[:4]}-{shown[4:]}-01"}
    every = imp | exp
    flows = " and ".join(w for w, m in (("imports", imp), ("exports", exp)) if m)
    goods = ", ".join(chapters(Counter(trade.get("import_codes") or {}) + Counter(trade.get("export_codes") or {}), 2))
    if min(every) >= recent:
        return made("new_trader", "New to importing / exporting (HMRC)",
                    f"first customs records in {months} months: {flows} from {_month_label(min(every))}"
                    + (f" ({goods})" if goods else ""), min(every))
    if imp and min(imp) >= recent and exp:
        return made("new_import", "Started importing (HMRC)",
                    f"imports from {_month_label(min(imp))}; exported before" + (f" ({goods})" if goods else ""), min(imp))
    if exp and min(exp) >= recent and imp:
        return made("new_export", "Started exporting (HMRC)",
                    f"exports from {_month_label(min(exp))}; imported before" + (f" ({goods})" if goods else ""), min(exp))
    now_n, before_n = len({p for p in every if p >= year}), len({p for p in every if p < year})
    late = set(trade.get("import_codes") or ()) | set(trade.get("export_codes") or ())
    early = set(trade.get("early_codes") or ())
    if before_n and now_n >= before_n + TRADE_UP_MONTHS:
        return made("trade_up", "Customs trade growing (HMRC)",
                    f"active in {now_n} of the last 12 months v {before_n} the year before", year)
    if early and len(late) >= 2 * len(early) and len(late) - len(early) >= 5:
        return made("trade_up", "Customs trade growing (HMRC)",
                    f"{len(late)} kinds of goods in the last 12 months v {len(early)} the year before", year)
    return None


def chapters(codes: Counter, top: int = 3) -> list[str]:
    """Most frequent 2-digit commodity chapters, e.g. ["22 beverages", "20 prepared fruit & veg"]."""
    counts: Counter = Counter()
    for code, months in codes.items():
        counts[code[:2]] += months
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:top]  # ties: lower chapter first, so output is stable
    return [f"{ch} {CHAPTER_NAMES.get(ch, 'goods')}" for ch, _ in ranked]


# Harmonised System chapters, short names.
CHAPTER_NAMES = {
    "01": "live animals", "02": "meat", "03": "fish & seafood", "04": "dairy & eggs", "05": "animal products",
    "06": "plants & flowers", "07": "vegetables", "08": "fruit & nuts", "09": "coffee, tea & spices",
    "10": "cereals", "11": "milling products", "12": "oil seeds", "13": "gums & resins", "14": "vegetable materials",
    "15": "fats & oils", "16": "prepared meat & fish", "17": "sugar & confectionery", "18": "cocoa & chocolate",
    "19": "bakery & cereal products", "20": "prepared fruit & veg", "21": "misc food preparations",
    "22": "beverages, spirits & wine", "23": "food waste & animal feed", "24": "tobacco", "25": "salt, stone & cement",
    "26": "ores", "27": "fuels & oils", "28": "inorganic chemicals", "29": "organic chemicals", "30": "pharmaceuticals",
    "31": "fertilisers", "32": "paints, dyes & inks", "33": "essential oils & cosmetics", "34": "soaps & waxes",
    "35": "proteins & glues", "36": "explosives", "37": "photographic goods", "38": "misc chemicals",
    "39": "plastics", "40": "rubber", "41": "hides & leather", "42": "leather goods & bags", "43": "furs",
    "44": "wood & timber", "45": "cork", "46": "basketware", "47": "pulp", "48": "paper & board",
    "49": "printed matter", "50": "silk", "51": "wool", "52": "cotton", "53": "vegetable fibres",
    "54": "man-made filaments", "55": "man-made fibres", "56": "wadding & rope", "57": "carpets",
    "58": "special fabrics", "59": "coated textiles", "60": "knitted fabrics", "61": "knitted clothing",
    "62": "woven clothing", "63": "made-up textiles", "64": "footwear", "65": "headgear", "66": "umbrellas",
    "67": "feathers & artificial flowers", "68": "stone & plaster articles", "69": "ceramics & tiles", "70": "glass",
    "71": "jewellery & precious metals", "72": "iron & steel", "73": "iron & steel articles", "74": "copper",
    "75": "nickel", "76": "aluminium", "78": "lead", "79": "zinc", "80": "tin", "81": "other base metals",
    "82": "tools & cutlery", "83": "misc metal articles", "84": "machinery", "85": "electrical & electronics",
    "86": "railway equipment", "87": "vehicles & parts", "88": "aircraft", "89": "ships & boats",
    "90": "instruments & medical devices", "91": "clocks & watches", "92": "musical instruments", "93": "arms",
    "94": "furniture & lighting", "95": "toys & sports goods", "96": "misc manufactured goods", "97": "art & antiques",
    "99": "special transactions",
}
