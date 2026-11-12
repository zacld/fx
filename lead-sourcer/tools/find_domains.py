"""
tools/find_domains.py — every lead's own website, so Cognism, Zint and a quick Google can match the company.

    python3 tools/find_domains.py --tracked tracked.json --order lead_order.json --cache domains.json --out domains.json

Companies in --order (best lead first) go first, then the rest of --tracked ({company number: name}). An address is
guessed from the registered name and kept only when the site shows the company's registration number or full
registered name (sourcer/website.find_site: the homepage and at most two of its legal / contact / about pages, robots.txt
respected). Found sites are kept; companies with none are tried again after RETRY_DAYS. Stops starting new companies
after --budget seconds. No search APIs, no AI. Prints counts and company names only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sourcer import website  # noqa: E402

RETRY_DAYS = 30
WORKERS = 24          # each company is a different website


def _load(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def queue(tracked: dict, order: list, cache: dict, today: date) -> list[tuple[str, str]]:
    """(number, name) still to look up: best leads first; a site already found never again, a "none" after RETRY_DAYS."""
    sites, tried = cache.get("sites", {}), cache.get("none", {})
    stale = (today - timedelta(days=RETRY_DAYS)).isoformat()
    out = []
    for number in dict.fromkeys([*[n for n in order if n in tracked], *tracked]):
        if number in sites or tried.get(number, "") > stale:
            continue
        out.append((number, tracked[number]))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--tracked", required=True)
    ap.add_argument("--order", default="")
    ap.add_argument("--cache", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=4000)
    ap.add_argument("--budget", type=int, default=2400, help="seconds before no new company is started")
    args = ap.parse_args()

    tracked = _load(args.tracked, {})
    order = _load(args.order, []) if args.order else []
    cache = _load(args.cache, {}) if args.cache else {}
    sites, none = dict(cache.get("sites", {})), dict(cache.get("none", {}))
    today = date.today()
    todo = queue(tracked, order, cache, today)[:args.max]
    print(f"Websites: {len(tracked):,} companies tracked, {len(sites):,} sites already found, {len(todo):,} to look up",
          flush=True)

    start, found, done = time.monotonic(), [], 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        pending = {}
        items = iter(todo)

        def submit_next() -> bool:
            if time.monotonic() - start > args.budget:
                return False
            nxt = next(items, None)
            if nxt is None:
                return False
            pending[pool.submit(website.find_site, nxt[0], nxt[1])] = nxt
            return True

        for _ in range(WORKERS * 2):
            if not submit_next():
                break
        while pending:
            for fut in as_completed(list(pending)):
                number, name = pending.pop(fut)
                try:
                    got = fut.result()
                except Exception:  # noqa: BLE001 — one odd site never stops the run
                    got = {"website": ""}
                done += 1
                if got.get("website"):
                    sites[number] = {"website": got["website"], "confidence": got["confidence"], "found": today.isoformat()}
                    none.pop(number, None)
                    found.append((name, got["website"], got["confidence"]))
                else:
                    none[number] = today.isoformat()
                if done % 250 == 0:
                    print(f"  {done:,} looked up, {len(found):,} sites found", flush=True)
                submit_next()
                break

    left = len(todo) - done
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"made_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "count": len(sites),
                   "sites": sites, "none": none}, f)
    high = sum(1 for _, _, c in found if c == "high")
    print(f"Looked up {done:,} ({left:,} left for the next run): found {len(found):,} "
          f"({high:,} showing the company number, {len(found) - high:,} its full name); "
          f"{len(sites):,} of {len(tracked):,} tracked companies now have a website "
          f"({round(100 * len(sites) / max(1, len(tracked)))}%)")
    for name, site, conf in found[:15]:
        print(f"  {name} — {site} ({conf})")


if __name__ == "__main__":
    main()
