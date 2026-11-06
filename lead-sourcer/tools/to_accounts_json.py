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
import re
import sys
from collections import Counter
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import sections  # noqa: E402
from sourcer import accounts as readers, excel  # noqa: E402

_GREW = re.compile(r"grew (\d[\d,]*)%|up (\d[\d,]*)% from", re.I)


def _num(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def sanity(row: dict) -> list[str]:
    """
    The last gate before the Accounts page: the readers' sense checks (sourcer/accounts.py) applied to the row as it
    will be shown, whatever reader or cached reading produced it. A figure that fails is cleared and says why; a
    call line built on one goes with it. Returns what was changed (for the log).
    """
    done = []
    t, fx, staff = _num(row.get("turnover_gbp")), _num(row.get("fx_gain_loss_gbp")), _num(row.get("employees")) or 0
    if t and t > readers.MAX_PLAUSIBLE_TURNOVER and staff < 1_000:
        row.update(turnover_gbp="", fx_wallet_low_gbp="", fx_wallet_high_gbp="", fx_estimate="",
                   turnover_check=f"turnover read as £{t / 1e9:,.1f}bn: too big to be right; check the accounts")
        t = None
        done.append("turnover over £5bn")
    if fx and abs(fx) < readers.FX_MIN_PLAUSIBLE and t and t >= readers.FX_MIN_PLAUSIBLE_TURNOVER:
        row.update(fx_gain_loss_gbp="", fx_gain_loss_prior_gbp="", recent_fx_loss="",
                   fx_gain_loss_check=f"FX figure read as £{fx:,.0f} at a company with £{t / 1e6:,.1f}m turnover: "
                                      f"probably in £'000; check the accounts")
        done.append("FX under £1,000")
    elif fx and t and abs(fx) > readers.FX_MAX_SHARE_OF_TURNOVER * t:
        row.update(fx_gain_loss_gbp="", fx_gain_loss_prior_gbp="", recent_fx_loss="",
                   fx_gain_loss_check=f"FX figure £{fx:,.0f} is over 20% of turnover: likely another figure; check the accounts")
        done.append("FX over 20% of turnover")
    sens = re.search(r"[£$€]\s?([\d,.]+)\s*(k|m|bn)?\b", (row.get("fx_sensitivity") or "").split(" — ")[0])
    if sens and t:
        size = float(sens.group(1).replace(",", "")) * {"k": 1e3, "m": 1e6, "bn": 1e9}.get(sens.group(2) or "", 1)
        if size > 0.5 * t:
            row["fx_sensitivity"] = ""
            done.append("sensitivity over half of turnover")
    parts = re.findall(r"£\s?([\d,.]+)\s*(k|m|bn)?\b", row.get("turnover_regions") or "")
    if t and parts and sum(float(a.replace(",", "")) * {"k": 1e3, "m": 1e6, "bn": 1e9}.get(u, 1)
                           for a, u in parts) > readers.REGIONS_MAX_SHARE * t:
        row.update(turnover_regions="", overseas_turnover_share="")
        done.append("regions over turnover")
    for key in ("fact_1", "fact_2", "opener"):   # growth built on a misread last year (a note number read as turnover)
        m = _GREW.search(row.get(key) or "")
        if m and int((m.group(1) or m.group(2)).replace(",", "")) > 500:
            row[key] = ""
            done.append(f"{key}: growth over 500%")
    if staff and t and t / staff > readers.MAX_TURNOVER_PER_HEAD:
        row["employees"] = ""
        done.append("holding company's staff")
    return done


def accounts(rows: list[dict], made_at: str = "") -> dict:
    fixed = Counter()
    for r in rows:
        if excel.is_checked(r):
            fixed.update(sanity(r))
    if fixed:
        print("Sense checks before upload: " + ", ".join(f"{k} {n}" for k, n in fixed.items()))
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
