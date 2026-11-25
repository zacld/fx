"""
tools/owner_search.py — who really owns each lead, by web search (sourcer/owner_search.py), best leads first.

    python3 tools/owner_search.py --tracked tracked.json --order lead_order.json --cache owners_cache.json \
        --out owners.json --max 150

Gemini with Google Search first (GEMINI_API_KEY; sourcer/owner_search.gemini_read), else one search a company through
the finder's search APIs within their allowances (keys SEARCH1API_KEY, TAVILY_API_KEY, EXA_API_KEY, BRAVE_API_KEY,
SERPER_API_KEY — any not set is skipped; `*_MONTHLY` caps). An owner found is kept FOUND_DAYS, a "nothing found" tried
again after RETRY_DAYS; a good lead Gemini hasn't answered for yet (`gemini_at`) is asked once whatever the older way
found. --only-first asks only about the --first list (Zac's good leads; the nightly run, 25 Nov 2026: "only run on good
leads"); --budget stops starting new companies after that many seconds (a Gemini call takes about a minute). Gemini's Google searches are billed one by one, so the month's count is carried in the output
and Gemini stops at GEMINI_SEARCHES_MONTHLY (4,500 — inside the 5,000 free a month; the search APIs take the rest).
--numbers searches just those companies (the ownership sample). Prints counts and company names (this month's searches
per provider are kept in the output, so the caps hold across runs); a person named as the owner is printed as "a person"
(the repo is public).
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
GEMINI_SEARCHES_MONTHLY = int(os.environ.get("GEMINI_SEARCHES_MONTHLY", "4500"))


def _load(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return default


def _save(path: str, obj) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


def due(entry: dict, today: date) -> bool:
    if not entry:
        return True
    when = date.fromisoformat(entry.get("searched", "2000-01-01"))
    return when < today - timedelta(days=FOUND_DAYS if entry.get("owner") else RETRY_DAYS)


def gemini_due(entry: dict) -> bool:
    """A good lead Gemini hasn't checked yet (searched only the older way — e.g. while Gemini's model was closed to the
    key, Nov 2026) is asked once, whatever it found; after that the usual FOUND_DAYS / RETRY_DAYS."""
    return not (entry or {}).get("gemini_at")


def shown(e: dict) -> str:
    if not e.get("owner"):
        return "nothing found"
    who = "a person" if e.get("kind") == "person" else e["owner"]
    path = " → ".join("a person" if c.get("kind") == "person" else c["owner"] for c in e.get("chain") or [])
    if path and " → " in path:
        who = path
    return f"{who}{' (' + e['country'] + ')' if e.get('country') else ''} [{e.get('kind')}, {e.get('sites')} site(s), read by {e.get('read_by', 'rules')}]"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracked", required=True)
    ap.add_argument("--order", default="")
    ap.add_argument("--cache", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=150)
    ap.add_argument("--parents", default="", help="parents.json (tools/parents_from_accounts.py): companies whose accounts name the owner aren't searched")
    ap.add_argument("--first", default="", help="good_leads.json (apps/web/scripts/rank-leads.mjs): Zac's new prospects — searched "
                    "first, even when their accounts already name an owner (Zac, 23 Nov 2026: a Gemini search dedicated to each "
                    "good lead — is it the ultimate parent, is it owned in the UK)")
    ap.add_argument("--only-first", action="store_true", help="ask only about the --first list (Zac's good leads), "
                    "none of the other leads (25 Nov 2026)")
    ap.add_argument("--budget", type=int, default=0, help="seconds: stop starting new companies after this long (0: no limit)")
    ap.add_argument("--check", action="store_true", help="one search with each provider's key first: which work")
    ap.add_argument("--numbers", default="", help="comma-separated company numbers: search just these")
    args = ap.parse_args()
    if args.check:
        for name, state in profiles.check_providers("who owns Walker Books").items():
            print(f"  search provider {name}: {state}")

    tracked = _load(args.tracked, {})
    tracked = tracked.get("companies", tracked) if isinstance(tracked, dict) else {}
    names = {n: (v.get("name") if isinstance(v, dict) else v) or "" for n, v in tracked.items()}
    cache = _load(args.cache, {}) or {}
    found = dict(cache.get("companies", {}))
    today = date.today()
    # this month's searches per provider, carried between runs (each run starts on a fresh machine)
    month = today.strftime("%Y-%m")
    carried = (cache.get("usage") or {}).get(month) or {}
    gemini_before = int(carried.get("gemini_searches") or 0)       # Gemini's Google searches this month
    carried = {k: v for k, v in carried.items() if k != "gemini_searches"}
    if carried:
        os.makedirs(profiles.CACHE_DIR, exist_ok=True)
        merged = {k: max(v, profiles.usage().get(k, 0)) for k, v in carried.items()}
        _save(profiles._usage_path(), {**profiles.usage(), **merged})

    def usage_now() -> dict:
        return {**profiles.usage(), "gemini_searches": gemini_before + owner_search.GEMINI_USAGE["searches"]}
    if not profiles.api_key() and not os.environ.get("GEMINI_API_KEY"):
        print("Owner search: no search key set (SEARCH1API_KEY / TAVILY_API_KEY / EXA_API_KEY / SERPER_API_KEY) — skipped")
        _save(args.out, {"made_at": today.isoformat(), "companies": found, "usage": {month: usage_now()}})
        return

    if args.numbers:
        queue = [n.strip() for n in args.numbers.split(",") if n.strip()]
    else:
        order = _load(args.order, [])
        order = order.get("order", order) if isinstance(order, dict) else order
        first = _load(args.first, [])
        first = [str(n) for n in (first.get("companies", []) if isinstance(first, dict) else first)]
        seen = set()
        queue = [n for n in first + ([] if args.only_first else list(order) + list(names)) if not (n in seen or seen.add(n))]
        answered = {n for n, p in ((_load(args.parents, {}) or {}).get("companies", {}) or {}).items() if p.get("ultimate_parent")}
        answered -= set(first)
        gemini_on = bool(os.environ.get("GEMINI_API_KEY")) and not owner_search.GEMINI_SPENT \
            and not (GEMINI_SEARCHES_MONTHLY and gemini_before >= GEMINI_SEARCHES_MONTHLY)
        good = set(first)

        def waiting_now(n: str) -> bool:
            e = found.get(n)
            return due(e, today) or (gemini_on and n in good and gemini_due(e))
        queue = [n for n in queue if names.get(n) and waiting_now(n) and n not in answered]
        if first or args.only_first:
            waiting = sum(1 for n in first if names.get(n) and waiting_now(n))
            print(f"Owner search: {len(first)} good leads {'only' if args.only_first else 'first'} "
                  f"({waiting} due a search now; the rest searched lately)")
        if answered:
            print(f"Owner search: {len(answered)} companies' own accounts already name the owner — not searched")

    import time
    started = time.monotonic()
    searched = owners = errors = 0
    for n in queue:
        if searched >= args.max:
            break
        if args.budget and time.monotonic() - started > args.budget:
            print(f"Owner search: {args.budget // 60} minutes used — stopping; the rest wait for the next run")
            break
        name = names.get(n) or ""
        if not name:
            continue
        if (GEMINI_SEARCHES_MONTHLY and not owner_search.GEMINI_SPENT
                and gemini_before + owner_search.GEMINI_USAGE["searches"] >= GEMINI_SEARCHES_MONTHLY):
            owner_search.GEMINI_SPENT.append("monthly search cap")
            print(f"Owner search: Gemini's {GEMINI_SEARCHES_MONTHLY:,} Google searches for the month used — the search APIs take the rest")
        if owner_search.AI_SPENT and os.environ.get("GROQ_API_KEY") and (owner_search.GEMINI_SPENT or not os.environ.get("GEMINI_API_KEY")):
            print("Owner search: the AI reader's free allowance is used for today — stopping; the rest wait for tomorrow")
            break
        calls_before = owner_search.GEMINI_USAGE["calls"]
        r = owner_search.search(n, name)
        asked_gemini = owner_search.GEMINI_USAGE["calls"] > calls_before
        if r.get("error"):
            errors += 1
            if errors >= 3:
                print("Owner search: searches failing (allowance used or keys rejected) — stopping:",
                      "; ".join(f"{p['name']}: {p['why']}" for p in profiles.search_problems()) or "no answer")
                break
            continue
        searched += 1
        entry = {k: v for k, v in r.items() if k != "none"}
        if not entry.get("owner") and (found.get(n) or {}).get("owner"):
            # nothing this time but an owner found before: keep it (the same question can bring back other results)
            entry = {**found[n], "rechecked": today.isoformat()}
        entry["searched"] = today.isoformat()
        if asked_gemini:
            entry["gemini_at"] = today.isoformat()      # Gemini answered for it (an owner or none): not again until due
        found[n] = entry
        owners += bool(entry.get("owner"))
        if args.numbers:
            print(f"  {name} ({n}): {shown(entry)}")
    _save(args.out, {"made_at": today.isoformat(), "companies": found, "usage": {month: usage_now()}})
    total = sum(1 for e in found.values() if e.get("owner"))
    print(f"Owner search: {searched} searched this run, {owners} owners found; {total} companies with an owner on file")
    g = owner_search.GEMINI_USAGE
    print(f"Gemini + Google Search ({(owner_search._gemini_model or ['no model'])[0]}): {g['calls']} calls, "
          f"{g['searches']} Google searches ({gemini_before + g['searches']:,} of {GEMINI_SEARCHES_MONTHLY:,} this month), "
          f"{g['tokens']:,} tokens, {g['verified']} owners found on the page cited, {g['dropped']} answers dropped "
          f"(no source backs the owner: asked through the search APIs instead), {g['failed']} failed"
          + ("" if os.environ.get("GEMINI_API_KEY") else " — no GEMINI_API_KEY"))
    if owner_search.GEMINI_DROPS:
        print("  why the cited pages didn't back them: " + ", ".join(f"{k} {v}" for k, v in sorted(
            owner_search.GEMINI_DROPS.items(), key=lambda kv: -kv[1])))
    u = owner_search.AI_USAGE
    print(f"AI reader (Groq {owner_search.GROQ_MODEL}): {u['calls']} calls, {u['tokens']:,} tokens, "
          f"{u['dropped']} answers dropped (not in the results), {u['failed']} failed"
          + ("" if os.environ.get("GROQ_API_KEY") else " — no GROQ_API_KEY: read by rules"))


if __name__ == "__main__":
    main()
