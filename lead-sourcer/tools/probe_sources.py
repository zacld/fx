#!/usr/bin/env python3
"""
tools/probe_sources.py — one-off check of what each candidate FX-indicator
source actually offers, run on GitHub (which can reach them; the dev sandbox
can't). Prints structure and aggregate counts only — page links, field
names, concept names, how many records have a field — never anyone's
personal details, because Actions logs on this repo are readable.

    COMPANIES_HOUSE_API_KEY=... python3 tools/probe_sources.py [bulk.zip]
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import accounts, bulk, companies_house  # noqa: E402

UA = {"User-Agent": "fx-lead-sourcer-probe/1.0 (+https://github.com/zacld/fx)"}
LINK_WORDS = re.compile(r"trader|importer|exporter|bulk|dataset|award|register|transaction|\.zip|\.csv|\.xlsx|\.ods", re.I)


def fetch(url: str, headers: dict | None = None, limit: int = 3_000_000) -> tuple[int, str, bytes]:
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read(limit)
    except urllib.error.HTTPError as e:
        return e.code, "", b""
    except Exception as e:  # noqa: BLE001
        return 0, str(e)[:80], b""


def section(title: str) -> None:
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def show_links(url: str, max_links: int = 40) -> None:
    status, ctype, body = fetch(url)
    print(f"{url} -> HTTP {status} {ctype[:40]} {len(body):,} bytes")
    if not body:
        return
    html = body.decode("utf-8", "replace")
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    print(f"  title: {(title.group(1).strip() if title else '')[:100]}")
    seen = set()
    for href, text in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S | re.I):
        text = re.sub(r"<[^>]+>|\s+", " ", text).strip()
        if (LINK_WORDS.search(href) or LINK_WORDS.search(text)) and href not in seen:
            seen.add(href)
            print(f"  link: {text[:70]!r} -> {urllib.parse.urljoin(url, href)[:150]}")
            if len(seen) >= max_links:
                break


def govuk_search(query: str, count: int = 8) -> None:
    url = "https://www.gov.uk/api/search.json?" + urllib.parse.urlencode({"q": query, "count": count})
    status, _, body = fetch(url)
    print(f"gov.uk search {query!r} -> HTTP {status}")
    if body:
        for r in json.loads(body).get("results", []):
            print(f"  {r.get('title', '')[:80]!r} -> https://www.gov.uk{r.get('link', '')}")


def probe_hmrc() -> None:
    section("HMRC uktradeinfo — importer/exporter (trader) data")
    for url in ("https://www.uktradeinfo.com/",
                "https://www.uktradeinfo.com/trade-data/latest-bulk-datasets/",
                "https://www.uktradeinfo.com/trade-data/"):
        show_links(url)
    status, ctype, body = fetch("https://api.uktradeinfo.com/$metadata")
    print(f"api.uktradeinfo.com/$metadata -> HTTP {status} {ctype[:40]} {len(body):,} bytes")
    if body:
        text = body.decode("utf-8", "replace")
        print("  entity sets:", sorted(set(re.findall(r'EntitySet Name="([^"]+)"', text))))
        for m in re.finditer(r'<EntityType Name="(Trader[^"]*)"(.*?)</EntityType>', text, re.S):
            print(f"  {m.group(1)} fields:", re.findall(r'Property Name="([^"]+)"', m.group(2)))
    status, _, body = fetch("https://api.uktradeinfo.com/Trader?$top=2")
    print(f"api.uktradeinfo.com/Trader?$top=2 -> HTTP {status}")
    if body:
        try:
            rows = json.loads(body).get("value", [])
            print("  record fields:", sorted(rows[0].keys()) if rows else "(no rows)")
        except ValueError:
            print("  (not JSON)")


def probe_govuk_lists() -> None:
    section("gov.uk lists — AWRS, King's Award, UK Export Finance")
    govuk_search("Alcohol Wholesaler Registration Scheme register")
    show_links("https://www.gov.uk/check-the-awrs-register", 15)
    govuk_search("King's Awards for Enterprise International Trade winners")
    govuk_search("UK Export Finance transaction data")


def probe_companies_house(numbers: list[str]) -> None:
    section("Companies House API — fields on officers, PSCs, charges")
    key = companies_house.get_api_key()
    if not key:
        print("no COMPANIES_HOUSE_API_KEY — skipped")
        return
    base = companies_house.CH_BASE
    officer_keys, psc_kinds, psc_keys, charge_keys = Counter(), Counter(), Counter(), Counter()
    with_occ = with_nat = with_res = officers = 0
    for n in numbers:
        companies_house._throttle()
        data = companies_house._get(f"{base}/company/{n}/officers", {"items_per_page": 50}, key) or {}
        for o in data.get("items", []):
            officers += 1
            officer_keys.update(o.keys())
            with_occ += bool(o.get("occupation"))
            with_nat += bool(o.get("nationality"))
            with_res += bool(o.get("country_of_residence"))
        companies_house._throttle()
        data = companies_house._get(f"{base}/company/{n}/persons-with-significant-control", {}, key) or {}
        for p in data.get("items", []):
            psc_kinds[p.get("kind", "")] += 1
            psc_keys.update(p.keys())
        companies_house._throttle()
        data = companies_house._get(f"{base}/company/{n}/charges", {}, key) or {}
        for c in data.get("items", []):
            charge_keys.update(c.keys())
    print(f"companies sampled: {len(numbers)}; officers: {officers}; with occupation {with_occ}, "
          f"nationality {with_nat}, country_of_residence {with_res}")
    print("officer fields:", dict(officer_keys))
    print("PSC kinds:", dict(psc_kinds))
    print("PSC fields:", dict(psc_keys))
    print("charge fields:", dict(charge_keys))


def probe_ixbrl(numbers: list[str]) -> None:
    section("Filed accounts (iXBRL) — which FX-related figures are tagged")
    key = companies_house.get_api_key()
    if not key:
        print("no COMPANIES_HOUSE_API_KEY — skipped")
        return
    concepts, dims, docs = Counter(), Counter(), 0
    fx_words = re.compile(r"exchange|foreign|currenc|derivativ|forward|hedg|geograph|overseas|export|region|countr", re.I)
    for n in numbers:
        filing = accounts.latest_accounts_filing(n, key)
        if not filing or filing.get("paper_filed"):
            continue
        doc_id = ((filing.get("links") or {}).get("document_metadata") or "").rstrip("/").rsplit("/", 1)[-1]
        doc = accounts.fetch_ixbrl(doc_id, key) if doc_id else None
        if not doc:
            continue
        docs += 1
        text = doc.decode("utf-8", "replace")
        names = set(re.findall(r'<ix:non(?:fraction|numeric)[^>]*\bname="([^"]+)"', text, re.I))
        concepts.update(c for c in names if fx_words.search(c))
        dims.update(set(m for m in re.findall(r'dimension="([^"]+)"', text) if fx_words.search(m)))
    print(f"iXBRL documents read: {docs} of {len(numbers)} companies")
    print("FX-related concepts (documents using each):")
    for c, k in concepts.most_common(40):
        print(f"  {k:3}  {c}")
    print("FX-related dimensions:")
    for d, k in dims.most_common(15):
        print(f"  {k:3}  {d}")


def probe_hmrc_files() -> None:
    section("HMRC importer/exporter detail files — layout (names masked)")
    for label, url in (("importers", "https://www.uktradeinfo.com/media/xyzl4prn/importers2608.zip"),
                       ("exporters", "https://www.uktradeinfo.com/media/3vrhrwag/exporters2608.zip")):
        status, ctype, body = fetch(url, limit=20_000_000)
        print(f"{label}: HTTP {status} {ctype[:40]} {len(body):,} bytes")
        if not body:
            continue
        import io, zipfile
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            for info in zf.infolist():
                print(f"  member {info.filename} {info.file_size:,} bytes")
                lines = zf.read(info.filename).decode("latin-1").splitlines()
                print(f"  lines: {len(lines):,}")
                widths = Counter(len(l) for l in lines[:2000])
                print(f"  common line lengths: {widths.most_common(5)}")
                delims = {d: lines[1].count(d) for d in "|,\t;" if len(lines) > 1}
                print(f"  delimiter counts on line 2: {delims}")
                for l in lines[:4]:
                    # Mask letters so trader names/addresses don't land in public logs; keep shape + digits.
                    print("  shape:", re.sub(r"[A-Za-z]", "x", l)[:240])
                code_re = re.compile(r"(?<!\d)\d{8}(?!\d)")
                codes = Counter()
                with_code = 0
                for l in lines:
                    found = code_re.findall(l)
                    codes.update(found)
                    with_code += bool(found)
                print(f"  distinct 8-digit codes: {len(codes):,}; lines with one: {with_code:,}")


def probe_hmrc_archive() -> None:
    section("HMRC bulk data archive — how older months are listed")
    from sourcer import hmrc
    for page in (hmrc.ARCHIVE_PAGE, hmrc.LATEST_PAGE):
        status, ctype, body = fetch(page)
        print(f"{page} -> HTTP {status} {len(body):,} bytes")
        html = body.decode("utf-8", "replace")
        hits = [(h, re.sub(r"<[^>]+>|\\s+", " ", t).strip())
                for h, t in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', html, re.S | re.I)
                if re.search(r"import|export|trader|detail|archive|20\\d\\d", h + t, re.I)]
        for h, t in hits[:80]:
            print(f"  {t[:60]!r} -> {h[:140]}")
    print("list_files() finds:", sorted(hmrc.list_files()))


def probe_hmrc_stats() -> None:
    section("HMRC trade statistics (goods x country x value) — layout")
    import io, zipfile
    for label, url in (("imports", "https://www.uktradeinfo.com/media/13ddzgep/bdsimp2608.zip"),
                       ("exports", "https://www.uktradeinfo.com/media/jeqdrxd2/bdsexp2608.zip"),
                       ("control", "https://www.uktradeinfo.com/media/hqzbfp0x/smka122608.zip")):
        status, ctype, body = fetch(url, limit=30_000_000)
        print(f"{label}: HTTP {status} {len(body):,} bytes")
        if not body:
            continue
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            for info in zf.infolist():
                lines = zf.read(info.filename).decode("latin-1").splitlines()
                print(f"  member {info.filename} {info.file_size:,} bytes, {len(lines):,} lines")
                for l in lines[:6]:   # aggregate national statistics, no traders
                    print("   ", l[:260])


def main() -> None:
    if "--hmrc-stats" in sys.argv:
        probe_hmrc_stats()
        return
    if "--hmrc-archive" in sys.argv:
        probe_hmrc_archive()
        return
    probe_hmrc_files()
    probe_hmrc()
    probe_govuk_lists()
    sample: list[str] = []
    if len(sys.argv) > 1 and os.path.exists(sys.argv[1]):
        # Medium/large wine, spirits, machinery and freight companies from the bulk file.
        found = bulk.find_candidates(sys.argv[1], {"46342", "46341", "46690", "52290"}, {"medium", "full"})
        sample = [c["company_number"] for c in found[::max(1, len(found) // 40)]][:40]
    probe_companies_house(sample[:10] or ["00445790"])
    probe_ixbrl(sample)


if __name__ == "__main__":
    main()
