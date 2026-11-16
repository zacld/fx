"""
tools/owner_search.py — who really owns each lead, by web search (sourcer/owner_search.py), best leads first.

    python3 tools/owner_search.py --tracked tracked.json --order lead_order.json --cache owners_cache.json \
        --out owners.json --max 150

One search a company through the finder's search APIs within their allowances (keys SEARCH1API_KEY, TAVILY_API_KEY,
EXA_API_KEY, SERPER_API_KEY — any not set is skipped; `*_MONTHLY` caps). An owner found is kept FOUND_DAYS, a
"nothing found" tried again after RETRY_DAYS. --numbers searches just those companies (the ownership sample). Prints
counts and company names (this month's searches per provider are kept in the output, so the caps hold across runs); a person named as the owner is printed as "a person" (the repo is public).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sourcer import owner_search, profiles  # noqa: E402

FOUND_DAYS = 180
RETRY_DAYS = 60


def _load(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return default


def due(entry: dict, today: date) -> bool:
    if not entry:
        return True
    when = date.fromisoformat(entry.get("searched", "2000-01-01"))
    return when < today - timedelta(days=FOUND_DAYS if entry.get("owner") else RETRY_DAYS)


def shown(e: dict) -> str:
    if not e.get("owner"):
        return "nothing found"
    who = "a person" if e.get("kind") == "person" else e["owner"]
    return f"{who}{' (' + e['country'] + ')' if e.get('country') else ''} [{e.get('kind')}, {e.get('sites')} site(s)]"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracked", required=True)
    ap.add_argument("--order", default="")
    ap.add_argument("--cache", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=150)
    ap.add_argument("--numbers", default="", help="comma-separated company numbers: search just these")
    args = ap.parse_args()

    tracked = _load(args.tracked, {})
    tracked = tracked.get("companies", tracked) if isinstance(tracked, dict) else {}
    names = {n: (v.get("name") if isinstance(v, dict) else v) or "" for n, v in tracked.items()}
    cache = _load(args.cache, {}) or {}
    found = dict(cache.get("companies", {}))
    today = date.today()
    # this month's searches per provider, carried between runs (each run starts on a fresh machine)
    month = today.strftime("%Y-%m")
    carried = (cache.get("usage") or {}).get(month) or {}
    if carried:
        os.makedirs(profiles.CACHE_DIR, exist_ok=True)
        merged = {k: max(v, profiles.usage().get(k, 0)) for k, v in carried.items()}
        json.dump({**profiles.usage(), **merged}, open(profiles._usage_path(), "w"))
    if not profiles.api_key():
        print("Owner search: no search key set (SEARCH1API_KEY / TAVILY_API_KEY / EXA_API_KEY / SERPER_API_KEY) — skipped")
        json.dump({"made_at": today.isoformat(), "companies": found, "usage": {month: carried}}, open(args.out, "w"))
        return

    if args.numbers:
        queue = [n.strip() for n in args.numbers.split(",") if n.strip()]
    else:
        order = _load(args.order, [])
        order = order.get("order", order) if isinstance(order, dict) else order
        seen = set()
        queue = [n for n in list(order) + list(names) if not (n in seen or seen.add(n))]
        queue = [n for n in queue if names.get(n) and due(found.get(n), today)]

    searched = owners = errors = 0
    for n in queue:
        if searched >= args.max:
            break
        name = names.get(n) or ""
        if not name:
            continue
        r = owner_search.search(n, name)
        if r.get("error"):
            errors += 1
            if errors >= 3:
                print("Owner search: searches failing (allowance used or keys rejected) — stopping:",
                      "; ".join(f"{p['name']}: {p['why']}" for p in profiles.search_problems()) or "no answer")
                break
            continue
        searched += 1
        entry = {k: v for k, v in r.items() if k != "none"}
        entry["searched"] = today.isoformat()
        found[n] = entry
        owners += bool(entry.get("owner"))
        if args.numbers:
            print(f"  {name} ({n}): {shown(entry)}")
    json.dump({"made_at": today.isoformat(), "companies": found, "usage": {month: profiles.usage()}}, open(args.out, "w"))
    total = sum(1 for e in found.values() if e.get("owner"))
    print(f"Owner search: {searched} searched this run, {owners} owners found; {total} companies with an owner on file")


if __name__ == "__main__":
    main()
