#!/usr/bin/env python3
"""
tools/niche_search.py — the Accounts page's Niche search (sourcer/discover.py): every UK company whose customs
records carry the goods Zac typed, matched to Companies House.

    python3 tools/niche_search.py --requests searches.json --results results.json [--check]
        [--filings fx-filings.json] [--tracked tracked.json] [--bulk BasicCompanyData.zip] [--months 12]

--requests: the store's "searches" ({searches: [{id, text, asked_at}]}, written by the page); --results: the store's
"search_results" ({results: {id: …}}, written only here), updated in place for searches not done yet (or asked
again) and cleared of searches the page removed. --check prints pending=N (for the workflow) and stops.
The log prints the search words, counts and company names only (public repo).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import bulk, discover, hmrc, matching  # noqa: E402


def _load(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f) or {}
    except (OSError, ValueError):
        return {}


def pending(requests: dict, results: dict) -> list[dict]:
    done = results.get("results") or {}
    return [r for r in requests.get("searches") or []
            if r.get("id") and r.get("text") and (done.get(r["id"]) or {}).get("asked_at") != r.get("asked_at")]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--requests", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--filings", default="")
    parser.add_argument("--tracked", default="")
    parser.add_argument("--bulk", default="")
    parser.add_argument("--months", type=int, default=12)
    args = parser.parse_args()

    requests, results = _load(args.requests), _load(args.results)
    todo = pending(requests, results)
    if args.check:
        print(f"pending={len(todo)}")
        return
    asked = {r["id"] for r in requests.get("searches") or [] if r.get("id")}
    kept = {k: v for k, v in (results.get("results") or {}).items() if k in asked}
    if not todo:
        print("Niche search: nothing waiting")
        with open(args.results, "w", encoding="utf-8") as f:
            json.dump({**results, "results": kept}, f)
        return

    codes = {r["id"]: discover.commodity_codes(r["text"]) for r in todo}
    for r in todo:
        print(f"Search \"{r['text'][:60]}\": {len(codes[r['id']])} customs codes")
    prefixes = tuple(sorted({c["code"] for cs in codes.values() for c in cs}))
    tracked = _load(args.tracked) if args.tracked else {}
    filings = {r["company_number"]: r for r in (_load(args.filings).get("rows") or []) if r.get("company_number")} if args.filings else {}
    trade = {}
    if prefixes:
        paths, since = hmrc.download(args.months)
        traders = {k: t for k, t in hmrc.build_traders(paths, since).items()
                   if any(str(c).startswith(prefixes) for f in ("import_codes", "export_codes") for c in t[f])}
        print(f"HMRC: {len(traders):,} traders carry the codes over {args.months} months")
        _, by_postcode, by_name = bulk.scan(args.bulk or bulk.download(), set(), set(),
                                            postcodes={pc for _, pc in traders}, names={n for n, _ in traders})
        trade = matching.match_all(traders, by_postcode, by_name)
        print(f"Matched to Companies House: {len(trade):,}")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for r in todo:
        cs = codes[r["id"]]
        rows = discover.search(trade, [c["code"] for c in cs], tracked, filings)
        sized = [x for x in rows if x["accounts_category"] in discover.SIZED]
        kept[r["id"]] = {"id": r["id"], "text": r["text"], "asked_at": r.get("asked_at", ""), "done_at": now,
                         "months": args.months, "codes": cs, "rows": rows,
                         "counts": {"companies": len(rows), "sized": len(sized), "new_sized": sum(1 for x in sized if not x["tracked"])},
                         "note": "" if cs else "No customs code's description names it — try the customs wording "
                                               "(e.g. \"unmanned aircraft\" for drones) or a customs code."}
        print(f"  \"{r['text'][:60]}\": {len(rows)} companies, {len(sized)} filing full / medium / group accounts, "
              f"{kept[r['id']]['counts']['new_sized']} not on the lists")
        for x in sized[:10]:
            print(f"    {x['company_name'][:50]:<50} {x['accounts_category']:<6} {x['months']:>2} months  {x['share']:>3}% of its trade")
    with open(args.results, "w", encoding="utf-8") as f:
        json.dump({"made_at": now, "results": kept}, f)


if __name__ == "__main__":
    main()
