#!/usr/bin/env python3
"""
tools/adzuna_sample.py — are Adzuna's job adverts worth wiring in? For the strongest companies on the Recent FX
filings list, one search each (hard cap MAX_CALLS) for finance / treasury adverts, then counts: companies with any
advert, finance roles (Finance Director, Financial Controller, treasury…), adverts whose text mentions currencies
or FX. Public job adverts only; no people's names are logged.

    ADZUNA_APP_ID=... ADZUNA_APP_KEY=... python3 tools/adzuna_sample.py filings.json

Keys come from the GitHub secrets ADZUNA_APP_ID / ADZUNA_APP_KEY, never the command line or the log.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.adzuna.com/v1/api/jobs/gb/search/1"
MAX_CALLS = int(os.environ.get("ADZUNA_MAX_CALLS", "50"))      # the test's whole budget: never more
PAUSE_SECONDS = float(os.environ.get("ADZUNA_PAUSE_SECONDS", "3"))   # well under any per-minute limit
FINANCE_WORDS = "finance financial accountant controller treasury treasurer CFO accounts payable credit"
FINANCE_TITLE = re.compile(r"\b(?:finance|financial|accountant|controller|treasur\w*|CFO|FD|accounts?|credit|payroll)\b", re.I)
SENIOR = re.compile(r"\b(?:finance\s+director|CFO|chief\s+financial|head\s+of\s+finance|financial\s+controller|"
                    r"group\s+financial|treasur\w*)\b", re.I)
FX_TEXT = re.compile(r"foreign\s+(?:exchange|currenc\w*)|\bFX\b|multi[- ]currency|currenc\w+|hedg\w+|\b(?:USD|EUR)\b|"
                     r"dollars?|euros?|international\s+payments|overseas\s+(?:suppliers?|payments?)|import\w*|export\w*", re.I)
_BRACKETS = re.compile(r"\([^)]*\)")
_LEGAL = re.compile(r"\b(?:LIMITED|LTD|PLC|LLP|HOLDINGS|GROUP|UK)\b\.?", re.I)


def short_name(name: str) -> str:
    """ "ACME FOODS (UK) LIMITED" -> "ACME FOODS": how adverts usually name the employer."""
    return " ".join(_LEGAL.sub(" ", _BRACKETS.sub(" ", name)).split()) or name


def search(company: str, app_id: str, app_key: str) -> tuple[list[dict], str]:
    params = {"app_id": app_id, "app_key": app_key, "results_per_page": 20, "what_or": FINANCE_WORDS,
              "what_phrase": company, "max_days_old": 120, "content-type": "application/json"}
    # not "company": that filter only takes Adzuna's own employer names and answers 400 for any other (first run:
    # 44 of 50). The name as a phrase finds adverts mentioning it; the employer check below keeps the company's own.
    req = urllib.request.Request(f"{API}?{urllib.parse.urlencode(params)}", headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp).get("results") or [], ""
    except urllib.error.HTTPError as e:
        body = e.read()[:200].decode("utf-8", "replace").replace(app_key, "…").replace(app_id, "…")
        return [], f"HTTP {e.code} {' '.join(body.split())[:120]}".strip()
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        return [], type(e).__name__


def main() -> None:
    app_id, app_key = os.environ.get("ADZUNA_APP_ID", "").strip(), os.environ.get("ADZUNA_APP_KEY", "").strip()
    if not (app_id and app_key):
        sys.exit("ADZUNA_APP_ID / ADZUNA_APP_KEY are not set (GitHub secrets)")
    with open(sys.argv[1], encoding="utf-8") as f:
        rows = (json.load(f) or {}).get("rows") or []
    picks = sorted((r for r in rows if r.get("company_name")),
                   key=lambda r: (-(r.get("filed_fx_score") or 0), -float(r.get("turnover_gbp") or 0)))[:MAX_CALLS]
    print(f"{len(rows):,} companies on the filings list; searching Adzuna for the {len(picks)} strongest "
          f"(one call each, {MAX_CALLS} at most, {PAUSE_SECONDS:g}s apart)\n")
    calls = with_ads = finance = senior = fx = 0
    errors: list[str] = []
    for r in picks:
        if calls >= MAX_CALLS:
            break
        name = short_name(r["company_name"])
        results, error = search(name, app_id, app_key)
        calls += 1
        if error:
            errors.append(error)
            print(f"  {name[:40]:<40} {error}")
            if error[:8] in ("HTTP 401", "HTTP 403", "HTTP 429") or (error.startswith("HTTP 400") and calls >= 3
                                                                    and len(errors) == calls):
                print("  stopping: requests refused (key, limit or a bad search)")
                break
            time.sleep(PAUSE_SECONDS)
            continue
        # adverts whose employer is this company (a recruiter's "our client" doesn't count)
        key = [w for w in name.lower().split() if w not in ("the", "&", "and")][:2]
        own = [j for j in results if all(w in (j.get("company") or {}).get("display_name", "").lower() for w in key)]
        titles = [j.get("title", "") for j in own]
        fin = [t for t in titles if FINANCE_TITLE.search(t)]
        sen = [t for t in titles if SENIOR.search(t)]
        fx_ads = [j for j in own if FX_TEXT.search(f"{j.get('title', '')} {j.get('description', '')}")]
        with_ads += bool(own)
        finance += bool(fin)
        senior += bool(sen)
        fx += bool(fx_ads)
        line = f"  {name[:40]:<40} adverts {len(own):>2} | finance {len(fin)} | senior {len(sen)} | FX words {len(fx_ads)}"
        if fin:
            line += f" | e.g. {'; '.join(dict.fromkeys(t[:50] for t in fin))[:120]}"
        print(line)
        for j in fx_ads[:1]:
            text = " ".join(f"{j.get('title', '')}: {j.get('description', '')}".split())
            m = FX_TEXT.search(text)
            print(f"      FX in the advert: …{text[max(0, m.start() - 80):m.end() + 80]}…")
        time.sleep(PAUSE_SECONDS)
    n = max(1, calls - len(errors))
    print(f"\n{calls} calls made ({len(errors)} failed). Of {n} companies searched: any advert of their own "
          f"{with_ads} ({with_ads / n:.0%}) | a finance role {finance} ({finance / n:.0%}) | a senior finance role "
          f"{senior} ({senior / n:.0%}) | an advert mentioning currency / FX / trade abroad {fx} ({fx / n:.0%})")


if __name__ == "__main__":
    main()
