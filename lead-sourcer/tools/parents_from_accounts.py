"""
tools/parents_from_accounts.py — who owns each lead, from its own latest accounts, best leads first (Zac, 17 Nov 2026:
checking who owns a company is 80% of his time, and paid Google search isn't available). Every subsidiary's accounts
must name its ultimate parent and where it's incorporated ("The ultimate parent undertaking is Acme Holding GmbH, a
company incorporated in Germany"); the readers already pick that sentence out (`control.ultimate_parent`), but only as
the nightly finder re-reads accounts in its own order. This reads the top leads' accounts first — Companies House's free
API, no search, no AI.

    python3 tools/parents_from_accounts.py --tracked tracked.json --order lead_order.json --cache parents_cache.json \
        --out parents.json --max 400

Kept per company: {ultimate_parent, country, evidence, accounts_url, read}; a company whose accounts name none is kept as
{none: True, read} and read again after RETRY_DAYS (new accounts get filed). Prints counts and company names only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sourcer import accounts, companies_house  # noqa: E402

RETRY_DAYS = 120
FOUND_DAYS = 365


def _load(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return default


def due(entry: dict, today: date) -> bool:
    if not entry:
        return True
    when = date.fromisoformat(entry.get("read", "2000-01-01"))
    return when < today - timedelta(days=FOUND_DAYS if entry.get("ultimate_parent") else RETRY_DAYS)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracked", required=True)
    ap.add_argument("--order", default="")
    ap.add_argument("--cache", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=400)
    ap.add_argument("--numbers", default="", help="comma-separated company numbers: read just these (the ownership sample)")
    args = ap.parse_args()

    today = date.today()
    tracked = _load(args.tracked, {})
    tracked = tracked.get("companies", tracked) if isinstance(tracked, dict) else {}
    names = {n: (v.get("name") if isinstance(v, dict) else v) or "" for n, v in tracked.items()}
    found = dict((_load(args.cache, {}) or {}).get("companies", {}))
    key = companies_house.get_api_key()
    if not key:
        print("Parents from accounts: no COMPANIES_HOUSE_API_KEY — skipped")
        json.dump({"made_at": today.isoformat(), "companies": found}, open(args.out, "w"))
        return
    order = _load(args.order, [])
    order = order.get("order", order) if isinstance(order, dict) else order
    seen: set = set()
    queue = [n for n in list(order) + list(names) if not (n in seen or seen.add(n)) and names.get(n) and due(found.get(n), today)]
    if args.numbers:
        queue = [n.strip() for n in args.numbers.split(",") if n.strip() and names.get(n.strip())]

    read = named = abroad = failed = 0
    for n in queue[:args.max]:
        try:
            facts = accounts.facts_from_latest_accounts(n, key)
        except Exception as e:  # noqa: BLE001 — one bad filing never stops the run
            facts, failed = None, failed + 1
            print(f"  {names[n]} ({n}): not read ({type(e).__name__})")
        read += 1
        parent = (facts or {}).get("ultimate_parent") or ""
        if parent:
            country = facts.get("ultimate_parent_country") or ""
            found[n] = {"ultimate_parent": parent, "country": country, "evidence": facts.get("ultimate_parent_evidence") or "",
                        "accounts_url": facts.get("accounts_url") or "", "read": today.isoformat()}
            named += 1
            if args.numbers:
                print(f"  {names[n]} ({n}): {parent} ({country or 'country not stated'})")
            abroad += not any(w in country.lower() for w in ("united kingdom", "england", "scotland", "wales", "northern ireland",
                                                             "great britain", "jersey", "guernsey", "isle of man", "uk"))
        elif facts is not None:
            found[n] = {"none": True, "read": today.isoformat()}
    json.dump({"made_at": today.isoformat(), "companies": found}, open(args.out, "w"))
    total = sum(1 for e in found.values() if e.get("ultimate_parent"))
    print(f"Parents from accounts: {read} read this run, {named} name an ultimate parent ({abroad} abroad), {failed} failed; "
          f"{total} companies with a parent from their accounts on file; {max(0, len(queue) - args.max)} still to read")


if __name__ == "__main__":
    main()
