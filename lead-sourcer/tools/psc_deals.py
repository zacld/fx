#!/usr/bin/env python3
"""
tools/psc_deals.py — the last WINDOW_DAYS of company purchases from Companies House's free ownership snapshot
(sourcer/owners.py): bought by private equity, sold to an employee ownership trust, bought by an overseas group, and
UK companies buying subsidiaries (the buyer is the lead). Kept when the company is active, big enough to file full /
medium / group accounts (or already on the lists) and shows an FX sign — on the Accounts or FX filings lists, a regular
importer / exporter in HMRC's records (--traders, from tools/niche_hits.py), an FX niche, or a buyer abroad.

    python3 tools/psc_deals.py --tracked tracked.json --traders traders.json --out deals.json [--bulk BasicCompanyData.zip]

Saved as the store's "deals" (the Accounts page's New money tab, the lead score, the finder's discoveries). Counts and
company names only in the log.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import bulk, niches as niche_rules, owners  # noqa: E402

SIZED = set(niche_rules.SIZED)
CACHE = os.path.join(os.path.expanduser("~"), ".cache", "fx-lead-sourcer", "psc")


def _load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def fx_signs(deal: dict, record: dict, tracked: dict, traders: dict, niches: list[dict], catch_all: set) -> list[str]:
    n = deal["company_number"]
    signs = []
    if n in tracked:
        signs.append("on your lists")
    months = traders.get(n)
    if months:
        signs.append(f"imports/exports in {months} of the last 12 months (HMRC)")
    niche = niche_rules.sector_niche(record.get("sic_codes") or [], niches, catch_all)
    if niche:
        signs.append(f"FX niche: {niche['name']}")
    if deal["kind"] == "overseas_buyer":
        signs.append(f"owner abroad ({deal['other_country']})")
    return signs


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tracked", default="tracked.json")
    p.add_argument("--traders", default="traders.json")
    p.add_argument("--niches", default=os.path.join(os.path.dirname(__file__), "..", "config", "fx_niches.json"))
    p.add_argument("--bulk", default="")
    p.add_argument("--zip", default="", help="a downloaded snapshot (else the latest is fetched)")
    p.add_argument("--window", type=int, default=owners.WINDOW_DAYS)
    p.add_argument("--out", default="deals.json")
    args = p.parse_args()

    tracked = _load(args.tracked, {}) or {}
    traders = _load(args.traders, {}) or {}
    niches = (_load(args.niches, {}) or {}).get("niches") or []
    catch_all = niche_rules.catch_all_codes(niches)
    zip_path = args.zip or owners.download(owners.snapshot_url(), CACHE)
    print(f"PSC snapshot: {os.path.basename(zip_path)} ({os.path.getsize(zip_path) / 1e9:.1f} GB)")
    changes = owners.recent_changes(owners.corporate_records(zip_path), window_days=args.window)
    print(f"Companies with a new corporate owner in the last {args.window} days: {len(changes):,}")

    # Names, status, size and sector codes of every company involved (targets and UK buyers), one bulk-file pass
    numbers = set(changes)
    for c in changes.values():
        for d in c["new"]:
            n = owners.ch_number((d.get("identification") or {}).get("registration_number") or "")
            if n:
                numbers.add(n)
    registry: dict = {}
    bulk.scan(args.bulk or bulk.download(), set(), set(), numbers=numbers, registry=registry)
    names = {n: r.get("name", "") for n, r in registry.items()}
    found = owners.deals(changes, names)
    kept, why_out = [], Counter()
    for d in found:
        rec = registry.get(d["company_number"])
        if not rec or rec.get("status", "").lower() != "active":
            why_out["not active"] += 1
            continue
        if rec.get("category") not in SIZED and d["company_number"] not in tracked:
            why_out["too small to file full / medium / group accounts"] += 1
            continue
        signs = fx_signs(d, rec, tracked, traders, niches, catch_all)
        if not signs:
            why_out["no FX sign"] += 1
            continue
        d.update(company_name=d["company_name"] or rec.get("name", ""), tracked=d["company_number"] in tracked,
                 fx_signs=signs, sic=rec.get("sic_codes") or [], accounts_category=rec.get("category", ""))
        kept.append(d)
    kept.sort(key=lambda d: d["date"], reverse=True)
    made = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"made_at": made, "window_days": args.window, "count": len(kept), "items": kept}, f)
    kinds = Counter(d["kind"] for d in found)
    kept_kinds = Counter(d["kind"] for d in kept)
    print(f"Deals found: {dict(kinds)}; kept (active, an FX sign): {dict(kept_kinds)}; left out: {dict(why_out)}")
    print(f"On your lists: {sum(d['tracked'] for d in kept)}")
    for d in kept[:25]:
        print(f"  {d['date']}  {d['kind']:<15} {d['company_name'][:45]:<45} — {d['detail'][:90]} [{'; '.join(d['fx_signs'])[:80]}]")


if __name__ == "__main__":
    main()
