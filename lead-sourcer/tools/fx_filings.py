#!/usr/bin/env python3
"""
tools/fx_filings.py — the "Recent FX filings" list: Companies House's bulk
accounts files scanned for companies of at least FILINGS_MIN_TURNOVER (£25m)
whose filing shows FX (sourcer/filings.py).

    python3 tools/fx_filings.py --daily --previous filings.json --out filings.json
    python3 tools/fx_filings.py --month latest --previous filings.json --out filings.json
    python3 tools/fx_filings.py --zip Accounts_Bulk_Data-2026-11-04.zip --out hits.json

--daily reads the daily files (the last 60 days are online) not yet done; --month a monthly archive ("latest",
"next" — the newest not yet done — or a name like October2026). Files already done are remembered in the output
(files_done), so a run picks up where the last stopped. The log shows counts, timings and the strongest hits:
company names and what their public accounts say about FX — no people.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import filings, hooks  # noqa: E402

CACHE = os.path.join(os.path.expanduser("~"), ".cache", "fx-filings")


def load(path: str) -> dict:
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    return {}


def pick(args, done: set[str]) -> list[str]:
    if args.zip:
        return list(args.zip)
    if args.daily:
        files = [u for u in filings.list_files("daily") if args.redo or u.rsplit("/", 1)[-1] not in done]
        return sorted(files, reverse=True)[: args.max_files]   # newest first
    # newest first, whatever order the page lists them in
    monthly = sorted(filings.list_files("monthly"), key=lambda u: filings._sort_date(filings.filed_label(u)), reverse=True)
    if args.month == "latest":
        return monthly[:1] if monthly else []
    if args.month == "next":
        return [u for u in monthly if u.rsplit("/", 1)[-1] not in done][:1]
    return [u for u in monthly if args.month.lower() in u.lower()][:1]


def show(row: dict) -> str:
    size = hooks.short(float(row["turnover_gbp"])) if row.get("turnover_gbp") else "turnover not stated"
    facts = [row.get(k) for k in ("fx_forwards", "fx_today", "currencies_in_accounts", "turnover_regions") if row.get(k)]
    fx = row.get("fx_gain_loss_gbp")
    if fx:
        facts.insert(0, f"FX {'loss' if float(fx) < 0 else 'gain'} {hooks.short(abs(float(fx)))}")
    return f"  {row['filed_fx_score']:>3}  {row['company_name'][:44]:<44} {row['company_number']}  {size:<10} " \
           f"{' | '.join(facts)[:150]}"


DETAIL = [("turnover_check", "turnover check"), ("fx_gain_loss_evidence", "FX gain/loss from"),
          ("fx_today", "how they handle FX"), ("fx_today_evidence", "  from"), ("fx_forwards", "forwards"),
          ("fx_forwards_evidence", "  from"), ("currencies_in_accounts", "currencies"),
          ("currencies_in_accounts_evidence", "  from"), ("turnover_regions", "sales by region"),
          ("fx_balances", "balances"), ("fx_sensitivity", "sensitivity"), ("currency", "main currency"),
          ("currency_evidence", "  from"), ("filed_fx", "scored")]


def detail(row: dict) -> str:
    """Every fact of a hit with its quote, for checking the reader by eye (public accounts; no people)."""
    lines = [f"        filed {row['filed']}, year to {row['period_end']}, {row.get('turnover_basis') or 'company'} figures"
             + (f", FX {row['fx_gain_loss_gbp']} (prior {row.get('fx_gain_loss_prior_gbp') or 'n/a'})"
                if row.get("fx_gain_loss_gbp") else "")]
    for key, label in DETAIL:
        if row.get(key):
            text = " ".join(str(row[key]).split())
            lines.append(f"        {label}: {text[:260]}{'…' if len(text) > 260 else ''}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--daily", action="store_true", help="daily files not done yet")
    parser.add_argument("--month", default="", help="monthly archive: latest, next, or e.g. October2026")
    parser.add_argument("--zip", nargs="*", help="local or remote zip files instead")
    parser.add_argument("--max-files", type=int, default=12, help="most daily files a run")
    parser.add_argument("--previous", default="", help="the list so far (rows + files_done), merged into")
    parser.add_argument("--out", default="filings.json")
    parser.add_argument("--min-turnover", type=float, default=filings.MIN_TURNOVER)
    parser.add_argument("--limit", type=int, default=0, help="stop after this many filings a file (testing)")
    parser.add_argument("--top", type=int, default=40, help="hits shown in the log")
    parser.add_argument("--max-hits", type=int, default=0, help="stop once this many companies are found (a test)")
    parser.add_argument("--detail", action="store_true", help="every fact of every hit, with its quote")
    parser.add_argument("--redo", action="store_true", help="read files already done again (a test)")
    args = parser.parse_args()
    if not (args.daily or args.month or args.zip):
        parser.error("say --daily, --month or --zip")

    previous = load(args.previous)
    done = set(previous.get("files_done") or [])
    todo = pick(args, done)
    print(f"{len(todo)} file(s) to scan; {len(done)} done before; {len(previous.get('rows') or [])} companies listed")
    new_rows: list[dict] = []
    reread: set[str] = set()   # files read in full again: their earlier rows give way to this reading
    for url in todo:
        name = url.rsplit("/", 1)[-1]
        started = time.time()
        path = url if os.path.exists(url) else filings.download(url, CACHE)
        got = time.time() - started
        before = dict(filings.stats)
        hits = filings.scan(path, filings.filed_label(name), args.min_turnover, limit=args.limit,
                            max_hits=max(0, args.max_hits - len(new_rows)) if args.max_hits else 0)
        n = {k: filings.stats[k] - before.get(k, 0) for k in ("files", "read")}
        print(f"{name}: {os.path.getsize(path) / 1e6:,.0f}MB in {got:.0f}s | {n['files']:,} filings, "
              f"{n['read']:,} read past the quick screen, {len(hits):,} with FX at £{args.min_turnover / 1e6:g}m+ "
              f"| {time.time() - started - got:.0f}s")
        new_rows += hits
        if filings.stats["stopped_early"]:
            print(f"  stopped early: {name} isn't marked done, so the next run reads all of it")
        else:
            if name in done:
                reread.add(filings.filed_label(name))
            done.add(name)
        if not os.path.exists(url) and path.startswith(CACHE):
            os.remove(path)   # monthly archives are GBs: keep the disk free for the next
    kept = [r for r in previous.get("rows") or [] if r.get("filed") not in reread]
    rows = filings.merge(kept, new_rows)
    out = {"made_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "min_turnover": args.min_turnover,
           "files_done": sorted(done), "count": len(rows), "rows": rows}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"\n{len(new_rows):,} hits this run; {len(rows):,} companies on the list now")
    why = filings.stats["why"]
    if why:
        total = sum(why.values())
        print(f"\nWhere the {total:,} filings went:")
        for reason, n in sorted(why.items(), key=lambda kv: (not kv[0].startswith("screen"), kv[0] != "kept", -kv[1])):
            print(f"  {n:>7,}  {n / total:6.1%}  {reason}")
    if new_rows:
        scores = [r["filed_fx_score"] for r in new_rows]
        print(f"  filed FX score 50+: {sum(s >= 50 for s in scores):,} | 1-49: {sum(s < 50 for s in scores):,} | "
              f"with an FX gain/loss {sum(1 for r in new_rows if r.get('fx_gain_loss_gbp')):,} | forwards with a size "
              f"{sum(1 for r in new_rows if r.get('fx_forwards')):,} | how they handle FX "
              f"{sum(1 for r in new_rows if r.get('fx_today')):,} | currencies named "
              f"{sum(1 for r in new_rows if r.get('currencies_in_accounts')):,} | sales by region "
              f"{sum(1 for r in new_rows if r.get('turnover_regions')):,}")
        print(f"\nStrongest {min(args.top, len(new_rows))} (score, company, number, turnover, FX facts):")
        for row in sorted(new_rows, key=lambda r: -r["filed_fx_score"])[: args.top]:
            print(show(row))
            if args.detail:
                print(detail(row))


if __name__ == "__main__":
    main()
