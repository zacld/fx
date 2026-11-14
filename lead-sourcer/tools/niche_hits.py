#!/usr/bin/env python3
"""
tools/niche_hits.py — how good each niche is, measured (sourcer/niches.py says how the numbers are used).

For every niche in config/fx_niches.json — SIC niches by the sector companies chose, goods niches by what HMRC's
monthly importer / exporter lists show them trading — and for every 4-digit customs heading: how many active companies
filing full / medium / group accounts are in it, how many of those show strong FX proof in their own filings (the FX
filings scan, filed FX score 50+), and how many of those name no forward contracts and no FX provider (still open).

    python3 tools/niche_hits.py --filings fx-filings.json [--bulk BasicCompanyData.zip] [--months 12] [--out niche_stats.json]

One pass over Companies House's bulk file and the last `months` of HMRC trader files (downloaded when not given).
Writes the numbers to --out for the finder (NICHE_STATS_FILE) and the Accounts page; prints a league table. Counts,
niche names and customs headings only in the log (public repo).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import absurd, bulk, hmrc, matching, niches as niche_rules  # noqa: E402

REGULAR_MONTHS = 3          # customs records in this many months: a regular trader
HEADING_MIN_STRONG = 5      # headings listed as suggestions need this many strong finds


def measure_all(niches: list[dict], companies: list[dict], trade_by_company: dict, filings: dict) -> dict:
    """{niche id: numbers} and [heading suggestions] from companies (bulk rows: number, sic_codes, accounts_category)."""
    members: dict[str, set[str]] = defaultdict(set)
    sized_numbers = {c["company_number"] for c in companies if c["accounts_category"] in niche_rules.SIZED}
    by_number = {c["company_number"]: c for c in companies}
    catch_all = niche_rules.catch_all_codes(niches)
    sic_niches = [(n, niche_rules.niche_codes(n, catch_all)) for n in niches if n.get("sic_codes")]
    goods = [n for n in niches if n.get("hmrc_codes")]
    for number in sized_numbers:
        sics = set(by_number[number]["sic_codes"])
        for n, codes in sic_niches:
            if sics & codes:   # its specific codes only: a catch-all code names no niche
                members[n["id"]].add(number)
        trade = trade_by_company.get(number)
        if trade and len(trade["import_months"] | trade["export_months"]) >= REGULAR_MONTHS:
            for _, n in niche_rules.goods_niches(trade, goods):
                members[n["id"]].add(number)

    def numbers(group: set[str]) -> dict:
        strong = [filings[x] for x in group if x in filings and float(filings[x].get("filed_fx_score") or 0) >= niche_rules.STRONG]
        return niche_rules.measure(len(group), len(strong), sum(niche_rules.is_open(r) for r in strong))

    stats = {n["id"]: {"name": n["name"], "kind": "goods" if n.get("hmrc_codes") else "sector", **numbers(members[n["id"]])}
             for n in niches}

    # Every 4-digit heading regular sized importers bring in, for new goods niches worth adding.
    covered = tuple(c for n in goods for c in n["hmrc_codes"])
    heading_members: dict[str, set[str]] = defaultdict(set)
    for number in sized_numbers:
        trade = trade_by_company.get(number)
        if not trade or len(trade["import_months"]) < REGULAR_MONTHS:
            continue
        codes = trade["import_codes"]
        total = sum(codes.values()) or 1
        per_heading: Counter = Counter()
        for code, m in codes.items():
            per_heading[str(code)[:4]] += m
        for heading, m in per_heading.items():
            if m >= niche_rules.GOODS_MIN_MONTHS and m / total >= niche_rules.GOODS_MIN_SHARE:
                heading_members[heading].add(number)
    headings = []
    for heading, group in heading_members.items():
        n = numbers(group)
        if n["strong"] >= HEADING_MIN_STRONG:
            headings.append({"heading": heading, "chapter": hmrc.CHAPTER_NAMES.get(heading[:2], ""),
                             "covered": heading.startswith(covered) or any(c.startswith(heading) for c in covered), **n})
    headings.sort(key=lambda h: -h["score"])
    return {"niches": stats, "headings": headings}


def enrich_tracked(tracked: dict, registry: dict, trade_by_company: dict, niches: list[dict]) -> dict:
    """{number: {niche, niche_kind, sic, absurd, shy}} for the Accounts + FX filings lists' companies (shy: hard to broker)."""
    out = {}
    catch_all = niche_rules.catch_all_codes(niches)
    for number, name in tracked.items():
        record = registry.get(number)
        sics = (record or {}).get("sic_codes") or []
        niche = niche_rules.company_niche(trade_by_company.get(number), sics, niches, catch_all)
        out[number] = {"niche": niche["name"] if niche else "", "niche_kind": ("goods" if niche.get("hmrc_codes") else "sector") if niche else "",
                       "sic": sics, "absurd": absurd.reason(name, record),
                       "shy": niche_rules.broker_shy(trade_by_company.get(number), sics, name, niches) or ""}
    return out


def write_moments(path: str, trade: dict, latest: str, tracked: dict, months: int) -> None:
    """Customs moments (hmrc.moment) for the lists' companies — triggers on the lead score — and for companies not on
    them that file full / medium / group accounts — new importers / exporters the finder checks first. Saved as the
    store's "moments"."""
    items = []
    for number, e in trade.items():
        m = hmrc.moment(e, latest, months) if latest else None
        if not m:
            continue
        on_list = number in tracked
        if not on_list and (m["kind"] == "trade_up" or e["company"].get("accounts_category") not in niche_rules.SIZED):
            continue
        items.append({"id": f"{m['kind']}:{number}:{m['since']}", "company_number": number,
                      "company_name": tracked.get(number) or e["company"].get("company_name", ""), "tracked": on_list,
                      "hot": False, "url": hmrc.LATEST_PAGE, **m})
    items.sort(key=lambda i: (i["at"], i["company_name"]), reverse=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"made_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "latest": latest, "months": months,
                   "count": len(items), "items": items}, f)
    kinds = Counter((i["kind"], i["tracked"]) for i in items)
    print(f"Customs moments (files to {latest}): " + ", ".join(
        f"{k} {kinds[(k, True)]} on the lists / {kinds[(k, False)]} new" for k in ("new_trader", "new_import", "new_export", "trade_up")))
    for i in [i for i in items if not i["tracked"]][:15]:
        print(f"  {i['kind']:<11} {i['company_name'][:50]:<50} {i['detail'][:80]}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--filings", required=True)
    parser.add_argument("--bulk", default="")
    parser.add_argument("--months", type=int, default=12)
    parser.add_argument("--niches", default=os.path.join(os.path.dirname(__file__), "..", "config", "fx_niches.json"))
    parser.add_argument("--out", default="niche_stats.json")
    parser.add_argument("--tracked", default="", help="{number: name} of the Accounts + FX filings lists' companies")
    parser.add_argument("--enrich-out", default="", help="each tracked company's niche, sector codes and absurd check")
    parser.add_argument("--traders-out", default="", help="{company number: months of customs records} (tools/psc_deals.py)")
    parser.add_argument("--history-months", type=int, default=24,
                        help="customs months read for the moments (new importers / exporters, trade growing)")
    parser.add_argument("--moments-out", default="", help="customs moments: the lists' companies, and new traders to check")
    args = parser.parse_args()

    with open(args.filings, encoding="utf-8") as f:
        filings = {r["company_number"]: r for r in (json.load(f) or {}).get("rows") or [] if r.get("company_number")}
    with open(args.niches, encoding="utf-8") as f:
        niches = json.load(f)["niches"]
    history = max(args.months, args.history_months)
    paths, since = hmrc.download(history)
    # the latest month in the files, from the cached monthly names (imports-M2609.zip); a year back from it: the measured window
    latest = max((m.group(1) for m in (re.search(r"-M(\d{4})\.zip$", p) for p in paths) if m), default="")
    latest = "20" + latest if latest else ""
    since12 = hmrc.months_back(latest, args.months - 1) if latest else since
    traders = hmrc.build_traders(paths, since, codes_since=since12)
    if not latest:
        latest = max((p for t in traders.values() for p in t["import_months"] | t["export_months"]), default="")
    print(f"HMRC: {len(traders):,} traders over {history} months (to {latest}); measured on {args.months}; "
          f"FX filings companies: {len(filings):,}")
    sics = {str(s) for n in niches for s in n.get("sic_codes", [])}
    tracked = {}
    if args.tracked:
        with open(args.tracked, encoding="utf-8") as f:
            tracked = json.load(f) or {}
    registry: dict = {}
    candidates, by_postcode, by_name = bulk.scan(
        args.bulk or bulk.download(), sics, set(niche_rules.SIZED),
        postcodes={pc for _, pc in traders}, names={n for n, _ in traders},
        numbers=set(tracked) or None, registry=registry if tracked else None)
    trade_full = matching.match_all(traders, by_postcode, by_name)
    if args.moments_out:
        write_moments(args.moments_out, trade_full, latest, tracked, history)
    # the measured window: the latest args.months (codes were only counted from then)
    trade_by_company = {}
    for n, e in trade_full.items():
        t = {**e, "import_months": {p for p in e["import_months"] if p >= since12},
             "export_months": {p for p in e["export_months"] if p >= since12}}
        if t["import_months"] or t["export_months"]:
            trade_by_company[n] = t
    companies = {c["company_number"]: c for c in candidates}
    for e in trade_by_company.values():
        companies.setdefault(e["company"]["company_number"], e["company"])
    print(f"Matched traders: {len(trade_by_company):,}; companies measured: {len(companies):,}")

    result = measure_all(niches, list(companies.values()), trade_by_company, filings)   # sized ones only, inside
    if args.traders_out:
        with open(args.traders_out, "w", encoding="utf-8") as f:
            json.dump({n: len(e["import_months"] | e["export_months"]) for n, e in trade_by_company.items()
                       if len(e["import_months"] | e["export_months"]) >= REGULAR_MONTHS}, f)
    if args.enrich_out:
        enrich = enrich_tracked(tracked, registry, trade_by_company, niches)
        with open(args.enrich_out, "w", encoding="utf-8") as f:
            json.dump({"made_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "companies": enrich}, f)
        why = Counter(e["absurd"].split(" — ")[0].split(" (sector")[0].split(", by its name")[0] for e in enrich.values() if e["absurd"])
        print(f"Tracked companies: {len(tracked):,}; on the register {len(registry):,}; with a niche "
              f"{sum(1 for e in enrich.values() if e['niche']):,}; absurd {sum(why.values()):,}: "
              + ", ".join(f"{k} {n}" for k, n in why.most_common()))
    result["made_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    result["basis"] = (f"HMRC importer/exporter lists ({args.months} months, regular = {REGULAR_MONTHS}+ months), Companies "
                       f"House bulk file (full / medium / group accounts), FX filings scan (strong = filed FX score "
                       f"{niche_rules.STRONG}+; open = no forwards or FX provider named)")
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f)

    rows = sorted(result["niches"].items(), key=lambda kv: -kv[1]["score"])
    print(f"\n{'score':>6} {'rate':>6} {'open':>5} {'strong':>6} {'sized':>6}  verdict  kind    niche")
    for _id, s in rows:
        print(f"{s['score']:>6} {s['hit_rate']:>5}% {round(100 * s['open_share']):>4}% {s['strong']:>6} {s['sized']:>6}  "
              f"{s['verdict']:<7}  {s['kind']:<6}  {s['name'][:70]}")
    print(f"\nKeep {sum(s['verdict'] == 'keep' for _, s in rows)}, drop {sum(s['verdict'] == 'drop' for _, s in rows)}, "
          f"too few to tell {sum(s['verdict'] == 'few' for _, s in rows)}")
    print(f"\nCustoms headings ({HEADING_MIN_STRONG}+ strong finds), best first — * = not in a goods niche yet:")
    for h in result["headings"][:60]:
        print(f"  {'*' if not h['covered'] else ' '} {h['heading']}  {h['score']:>6} {h['hit_rate']:>5}% open {round(100 * h['open_share'])}% "
              f"strong {h['strong']} sized {h['sized']}  ({h['chapter']})")


if __name__ == "__main__":
    main()
