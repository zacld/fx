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
from collections import Counter
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import filings, hmrc, hooks  # noqa: E402

CACHE = os.path.join(os.path.expanduser("~"), ".cache", "fx-filings")


def load(path: str) -> dict:
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    return {}


# Files read again in the current rescan round (a new round, a new field: every file once more). Round 2, 8 Nov
# 2026: no-turnover filings with FX kept for a group check, and 24 months of HMRC records.
RESCAN_FIELD = "files_rescanned_r3"

# What's looked up per company after the scan (Companies House calls), carried over when its filing is read again.
LOOKED_UP = ("directors", "director_count", "incumbent_bank", "incumbent_bank_url", "lenders", "owner", "triggers",
             "fd_search_url", "research_checked", "moved_up", "history_checked")


def pick(args, done: set[str], rescanned: set[str] = frozenset()) -> list[str]:
    if args.zip:
        return list(args.zip)
    if args.month == "rescan":
        return pick_rescan(args.max_files, rescanned)
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


def pick_rescan(max_files: int, rescanned: set[str]) -> list[str]:
    """
    The next files to read again at today's floor (Nov 2026: £25m -> £20m): the day files newer than the newest
    monthly archive first (up to max_files), then the monthly archives one a run, newest first — each file once
    (files_rescanned). Nothing left: [] (the chain stops).
    """
    monthly = sorted(filings.list_files("monthly"), key=lambda u: filings._sort_date(filings.filed_label(u)), reverse=True)
    newest_month = filings._sort_date(filings.filed_label(monthly[0]))[:7] if monthly else ""
    daily = [u for u in filings.list_files("daily") if filings._sort_date(filings.filed_label(u))[:7] > newest_month]
    pending = sorted((u for u in daily if u.rsplit("/", 1)[-1] not in rescanned), reverse=True)
    if pending:
        return pending[:max_files]
    return [u for u in monthly if u.rsplit("/", 1)[-1] not in rescanned][:1]


def show(row: dict) -> str:
    size = hooks.short(float(row["turnover_gbp"])) if row.get("turnover_gbp") else \
        (f"est. {row['size_estimate'].replace('likely ', '')}" if row.get("size_estimate") else "turnover not stated")
    facts = [row.get(k) for k in ("fx_forwards", "fx_today", "currencies_in_accounts", "turnover_regions", "hmrc_trade")
             if row.get(k)]
    fx = row.get("fx_gain_loss_gbp")
    if fx:
        facts.insert(0, f"FX {'loss' if float(fx) < 0 else 'gain'} {hooks.short(abs(float(fx)))}")
    return f"  {row['filed_fx_score']:>3}  {row['company_name'][:44]:<44} {row['company_number']}  {size:<10} " \
           f"{' | '.join(facts)[:150]}"


DETAIL = [("incumbent_bank", "bank"), ("owner", "owner"), ("triggers", "triggers"), ("moved_up", "trigger"), ("bank_debt", "bank debt"), ("size_estimate", "size"), ("size_estimate_basis", "  from"), ("hmrc_trade", "customs"),
          ("turnover_check", "turnover check"), ("fx_gain_loss_evidence", "FX gain/loss from"),
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
    parser.add_argument("--month", default="", help="monthly archive: latest, next, or e.g. October2026; rescan: the "
                                                    "next file not yet read again at today's floor")
    parser.add_argument("--zip", nargs="*", help="local or remote zip files instead")
    parser.add_argument("--max-files", type=int, default=12, help="most daily files a run")
    parser.add_argument("--previous", default="", help="the list so far (rows + files_done), merged into")
    parser.add_argument("--out", default="filings.json")
    parser.add_argument("--min-turnover", type=float, default=filings.MIN_TURNOVER)
    parser.add_argument("--limit", type=int, default=0, help="stop after this many filings a file (testing)")
    parser.add_argument("--top", type=int, default=40, help="hits shown in the log")
    parser.add_argument("--max-hits", type=int, default=0, help="stop once this many companies are found (a test)")
    parser.add_argument("--detail", action="store_true", help="every fact of every hit, with its quote")
    parser.add_argument("--research-max", type=int, default=1500, help="companies researched a run (3 calls each)")
    parser.add_argument("--history-max", type=int, default=2500, help="filing histories read a run (moved up flag)")
    parser.add_argument("--hmrc-months", type=int, default=filings.CUSTOMS_MONTHS,
                        help="months of HMRC importer/exporter lists (0: off)")
    parser.add_argument("--redo", action="store_true", help="read files already done again (a test)")
    parser.add_argument("--chain-left", type=int, default=-1,
                        help="a chained backfill/rescan: links still to run after this one (kept in the list, so a "
                             "link dropped from GitHub's queue is restarted by the next daily scan)")
    parser.add_argument("--chain-mode", default="", help="the chained runs' mode (next, rescan)")
    args = parser.parse_args()
    if not (args.daily or args.month or args.zip):
        parser.error("say --daily, --month or --zip")

    previous = load(args.previous)
    done = set(previous.get("files_done") or [])
    rescanned = set(previous.get(RESCAN_FIELD) or [])
    todo = pick(args, done, rescanned)
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
              f"{n['read']:,} read past the quick screen, {len(hits):,} big enough (£{args.min_turnover / 1e6:g}m+, filed or estimated) "
              f"| {time.time() - started - got:.0f}s")
        new_rows += hits
        if filings.stats["stopped_early"]:
            print(f"  stopped early: {name} isn't marked done, so the next run reads all of it")
        else:
            if name in done:
                reread.add(filings.filed_label(name))
            done.add(name)
            if args.month == "rescan":
                rescanned.add(name)
        if not os.path.exists(url) and path.startswith(CACHE):
            os.remove(path)   # monthly archives are GBs: keep the disk free for the next
    customs = None
    if args.hmrc_months and new_rows:
        try:
            paths, since = hmrc.download(args.hmrc_months)
            customs = filings.customs_index(hmrc.build_traders(paths, since))
            print(f"HMRC importer/exporter lists: {len(customs):,} traders over {args.hmrc_months} months")
        except Exception as e:  # noqa: BLE001 — customs records are a check, the filings still stand
            print(f"WARNING: HMRC lists unavailable ({type(e).__name__}: {e}); filings without FX are dropped")
    found = len(new_rows)
    new_rows, decided = filings.finalise(new_rows, customs, args.hmrc_months)
    for reason in [r for r in filings.stats["why"] if r.startswith(("kept:", "read: big"))]:
        del filings.stats["why"][reason]   # the scan's provisional verdicts: the customs check decides them
    filings.stats["why"].update(decided)
    print(f"{found:,} big enough; {len(new_rows):,} with FX in their filing or customs records")
    kept = [r for r in previous.get("rows") or [] if r.get("filed") not in reread]
    # a company read again keeps what was looked up for it before (research, filing history), so no calls repeat
    earlier = {r["company_number"]: r for r in previous.get("rows") or [] if r.get("company_number")}
    for r in new_rows:
        old = earlier.get(r.get("company_number")) or {}
        for k in LOOKED_UP:
            if k in old and k not in r:
                r[k] = old[k]
    rows = filings.merge(kept, new_rows)
    # Moved up from small accounts: each listed company's filing history, once (kept on the row), capped a run.
    api_key = os.environ.get("COMPANIES_HOUSE_API_KEY", "")
    todo_history = [r for r in rows if not r.get("history_checked")][: args.history_max]
    if api_key and todo_history:
        started, moved = time.time(), 0
        for r in todo_history:
            items = filings.accounts_history(r["company_number"], api_key)
            if items is None:
                continue   # the call failed: try again next run
            r["moved_up"] = filings.moved_up(items)
            r["history_checked"] = datetime.now(timezone.utc).date().isoformat()
            moved += bool(r["moved_up"])
        print(f"Filing histories read: {len(todo_history):,} in {time.time() - started:.0f}s; moved up from small "
              f"accounts: {moved:,}; {sum(1 for r in rows if not r.get('history_checked')):,} left for the next run")
    elif todo_history:
        print(f"COMPANIES_HOUSE_API_KEY not set: {len(todo_history):,} filing histories not read")
    # Mini research: directors, incumbent bank and lenders, owner, triggers (three calls each), once per company.
    # rows waiting for a group check first: they can't be listed (or dropped) until it's done
    todo_research = sorted((r for r in rows if not r.get("research_checked")),
                           key=lambda r: r.get("group_check") != filings.GROUP_PENDING)[: args.research_max]
    if api_key and todo_research:
        started = time.time()
        for r in todo_research:
            try:
                r.update(filings.research(r["company_number"], r["company_name"], api_key, row=r))
            except Exception as e:  # noqa: BLE001 — one company's lookup mustn't stop the rest
                print(f"  research failed for {r['company_number']}: {type(e).__name__}")
        done_now = [r for r in todo_research if r.get("research_checked")]
        print(f"Mini research: {len(done_now):,} companies in {time.time() - started:.0f}s; incumbent bank found "
              f"{sum(1 for r in done_now if r.get('incumbent_bank')):,}; with triggers "
              f"{sum(1 for r in done_now if r.get('triggers')):,}; overseas parent "
              f"{sum(1 for r in done_now if 'overseas parent' in r.get('owner', '')):,}; "
              f"{sum(1 for r in rows if not r.get('research_checked')):,} left for the next run")
    # Companies filing no turnover whose group check found no UK parent, or a group under the floor: not listed.
    checked_out = [r for r in rows if r.get("group_check") not in (None, "", "in band", filings.GROUP_PENDING)]
    if checked_out or any(r.get("group_check") for r in rows):
        print(f"Group checks (no turnover filed, FX in the filing): in the band {sum(r.get('group_check') == 'in band' for r in rows):,}, "
              f"waiting {sum(r.get('group_check') == filings.GROUP_PENDING for r in rows):,}, dropped {len(checked_out):,} "
              f"({', '.join(f'{k} {v}' for k, v in Counter(r['group_check'].split(' (')[0] for r in checked_out).most_common())})")
        gone = {id(r) for r in checked_out}
        rows = [r for r in rows if id(r) not in gone]
    # Today's sanity rules on every row (no calls): implausible FX / turnover figures and forward sizes to a check.
    print(f"Figures moved to a check by today's rules: {filings.tidy(rows):,} companies")
    # Owned from abroad with no sign of running FX locally: ranked lower (hooks.ABROAD_RULES), every row, no calls.
    abroad = filings.mark_abroad(rows)
    print(f"Owned from abroad, FX probably run there: {abroad:,} of {len(rows):,} (ranked "
          f"{filings.hooks.ABROAD_RULES['points']} points lower; owned abroad but runs FX locally: "
          f"{sum(1 for r in rows if filings.owner_abroad(r)[0] and not r['run_from_abroad']):,})")
    chain_left = args.chain_left if args.chain_left >= 0 else int(previous.get("chain_left") or 0)
    chain_mode = args.chain_mode or previous.get("chain_mode") or ""
    if args.chain_left >= 0 and not todo:
        chain_left = 0   # nothing left to read: the chain is done
    out = {"made_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "min_turnover": args.min_turnover,
           "chain_left": chain_left, "chain_mode": chain_mode,
           "files_done": sorted(done), RESCAN_FIELD: sorted(rescanned), "files_scanned": len(todo), "count": len(rows), "rows": rows}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"\n{len(new_rows):,} hits this run; {len(rows):,} companies on the list now")
    why = filings.stats["why"]
    if why:
        total = sum(why.values())
        print(f"\nWhere the {total:,} filings went:")
        for reason, n in sorted(why.items(), key=lambda kv: (not kv[0].startswith("screen"), kv[0] != "kept", -kv[1])):
            print(f"  {n:>7,}  {n / total:6.1%}  {reason}")
            for example in filings.stats["examples"].get(reason, []):
                print(f"                     e.g. {example}")
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
