#!/usr/bin/env python3
"""
tools/to_accounts_json.py — the finder's list (fx_companies.csv, after the
confirmation step) as the JSON the dashboard's Accounts page reads. Only
companies checked in full go in, in list order (best first); empty fields
are left out to keep it small.

    python3 tools/to_accounts_json.py fx_companies.csv [--output accounts.json]

The JSON holds finance contacts' names, so it is never committed or put on
the public site: the finder workflow uploads it to the site's private
Netlify Blobs store, and the page fetches it through a password check
(apps/web/netlify/functions/accounts.mjs).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import sections  # noqa: E402
from sourcer import excel  # noqa: E402


def accounts(rows: list[dict], made_at: str = "") -> dict:
    checked = [{k: v for k, v in r.items() if k and v not in ("", None)} for r in rows if excel.is_checked(r)]
    for rank, r in enumerate(checked, 1):
        r["rank"] = rank
    present = list(dict.fromkeys(r.get("section", "") for r in checked if r.get("section")))
    order = [s for s in sections() if s in present] + [s for s in present if s not in sections()]
    return {"made_at": made_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sections": order,
            "count": len(checked), "rows": checked}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv")
    parser.add_argument("--output", default="accounts.json")
    args = parser.parse_args()
    with open(args.csv, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    data = accounts(rows)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{data['count']:,} checked companies of {len(rows):,} -> {args.output}")


if __name__ == "__main__":
    main()
