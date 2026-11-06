#!/usr/bin/env python3
"""
tools/filings_crosscheck.py — cross-checks the Recent FX filings list (read-only: nothing is saved anywhere).

    python3 tools/filings_crosscheck.py filings.json accounts.json [--recheck 8]

1. Per month: companies, strong FX proof (50+), owned abroad.
2. Figures to doubt: an FX gain/loss under £1,000 at a £25m+ company (a "£1" is usually a £'000 or £m figure read
   as pounds), an FX line over 10% of turnover, forward contracts 50x bigger or smaller than the year before,
   turnover over £5bn.
3. Repeats: the same company twice, and group companies filing the same figures (period end + turnover, or period
   end + FX line) left as separate rows.
4. Against the main Accounts list (the finder's own reading of the same company): turnover more than 5% apart, the
   FX line apart (sign, or more than 10%), and the strong finds the finder hasn't checked yet.
5. --recheck N: the first N doubtful FX figures re-read from Companies House (two calls each, COMPANIES_HOUSE_API_KEY):
   every FX-looking tag in the filing with its scale and sign, to see which reading is right.

Public repo: company names, numbers and figures from their public accounts only — no people.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import accounts  # noqa: E402

_AMOUNT = re.compile(r"(?:US\$|\$|€|£|EUR|USD|GBP)\s?([\d,.]+)\s*(m|bn|k)?", re.I)
_UNITS = {"k": 1e3, "m": 1e6, "bn": 1e9}


def _num(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _amount(text: str) -> float | None:
    m = _AMOUNT.search(text or "")
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "")) * _UNITS.get((m.group(2) or "").lower(), 1)
    except ValueError:
        return None


def money(v: float | None) -> str:
    if v is None:
        return "—"
    a = abs(v)
    s = f"£{a / 1e9:.1f}bn" if a >= 1e9 else f"£{a / 1e6:.1f}m" if a >= 1e6 else f"£{a / 1e3:.0f}k" if a >= 1e3 else f"£{a:.0f}"
    return ("-" if v < 0 else "") + s


def who(r: dict) -> str:
    return f"{(r.get('company_name') or '?')[:44]} ({r.get('company_number')}, filed {r.get('filed', '')})"


def doubtful_figures(rows: list[dict]) -> dict[str, list[tuple[dict, str]]]:
    out: dict[str, list[tuple[dict, str]]] = defaultdict(list)
    for r in rows:
        fx, turnover = _num(r.get("fx_gain_loss_gbp")), _num(r.get("turnover_gbp"))
        if fx is not None and 0 < abs(fx) < 1000:
            out["FX gain/loss under £1,000 (a £'000 or £m figure read as pounds?)"].append(
                (r, f"FX {money(fx)} on turnover {money(turnover)} — {r.get('fx_gain_loss_evidence', '')[:120]}"))
        if fx is not None and turnover and abs(fx) > 0.10 * turnover:
            out["FX gain/loss over 10% of turnover"].append((r, f"FX {money(fx)} on turnover {money(turnover)}"))
        if turnover and turnover > 5e9:
            out["turnover over £5bn"].append((r, f"turnover {money(turnover)} ({r.get('turnover_basis', '')})"))
        forwards = r.get("fx_forwards") or ""
        for part in forwards.split(";"):
            now = _amount(part)
            prior_m = re.search(r"prior year ([^)]+)\)", part)
            before = _amount(prior_m.group(1)) if prior_m else None
            if now and before and max(now, before) / max(min(now, before), 1) >= 50:
                out["forward contracts 50x apart from the year before"].append(
                    (r, f"{part.strip()[:110]} — {(r.get('fx_forwards_evidence') or '')[:140]}"))
                break
    return out


def repeats(rows: list[dict]) -> tuple[list[str], list[list[dict]]]:
    numbers = Counter(r.get("company_number") for r in rows)
    twice = [n for n, c in numbers.items() if n and c > 1]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        end = r.get("period_end") or ""
        if r.get("turnover_gbp"):
            groups[("turnover", end, r["turnover_gbp"])].append(r)
        fx = _num(r.get("fx_gain_loss_gbp"))
        if fx is not None and abs(fx) >= 1000:
            groups[("fx", end, r["fx_gain_loss_gbp"])].append(r)
    seen, sets = set(), []
    for members in groups.values():
        key = frozenset(m.get("company_number") for m in members)
        if len(key) > 1 and key not in seen:
            seen.add(key)
            sets.append(members)
    return twice, sets


def against_main_list(rows: list[dict], main: list[dict]) -> dict:
    by_number = {m.get("company_number"): m for m in main if m.get("company_number")}
    both = [(r, by_number[r["company_number"]]) for r in rows if r.get("company_number") in by_number]
    turnover_apart, fx_apart = [], []
    for r, m in both:
        a, b = _num(r.get("turnover_gbp")), _num(m.get("turnover_gbp"))
        if a and b and abs(a - b) / max(a, b) > 0.05:
            turnover_apart.append((r, f"filings {money(a)} ({r.get('period_end', '')}) v main list {money(b)}"
                                      f" ({m.get('turnover_basis') or 'company'}, year to {m.get('turnover_period_end', '')})"))
        x, y = _num(r.get("fx_gain_loss_gbp")), _num(m.get("fx_gain_loss_gbp"))
        if x is not None and y is not None and (x * y < 0 or abs(x - y) / max(abs(x), abs(y), 1) > 0.10):
            fx_apart.append((r, f"filings FX {money(x)} v main list FX {money(y)}"))
    strong = [r for r in rows if (r.get("filed_fx_score") or 0) >= 50]
    unchecked = [r for r in strong if r.get("company_number") not in by_number]
    return {"both": len(both), "turnover_apart": turnover_apart, "fx_apart": fx_apart,
            "strong": len(strong), "strong_not_on_main": unchecked}


_TAG = re.compile(r"<ix:nonFraction\b([^>]*)>(.*?)</ix:nonFraction>", re.S | re.I)
_ATTR = re.compile(r'([\w:-]+)="([^"]*)"')
_FX_NAME = re.compile(r"exchange|foreign|currenc", re.I)


def recheck(r: dict, api_key: str) -> list[str]:
    """Every FX-looking tag in the company's latest filed accounts: name, displayed figure, scale, sign, context."""
    filing = accounts.latest_accounts_filing(r["company_number"], api_key)
    meta = ((filing or {}).get("links") or {}).get("document_metadata") or ""
    doc_id = meta.rstrip("/").split("/")[-1] if meta else ""
    document = accounts.fetch_ixbrl(doc_id, api_key) if doc_id else None
    if not document:
        return ["  (no tagged accounts to re-read)"]
    text = document.decode("utf-8", errors="replace")
    lines = []
    for attrs_text, shown in _TAG.findall(text):
        attrs = dict(_ATTR.findall(attrs_text))
        name = attrs.get("name", "")
        if not _FX_NAME.search(name):
            continue
        shown = " ".join(html.unescape(re.sub(r"<[^>]+>", "", shown)).split())
        lines.append(f"  {name.split(':')[-1][:60]:<60} shown {shown:>12} scale {attrs.get('scale', '0'):>2}"
                     f" sign {attrs.get('sign', '+'):>1} format {attrs.get('format', '').split(':')[-1]:<14}"
                     f" context {attrs.get('contextRef', '')[:30]}")
        if len(lines) >= 8:
            break
    return lines or ["  (no FX-named tags: the figure came from the notes' text)"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("filings")
    parser.add_argument("main_list")
    parser.add_argument("--recheck", type=int, default=0, help="doubtful FX figures to re-read from Companies House")
    args = parser.parse_args()
    rows = (json.load(open(args.filings, encoding="utf-8")) or {}).get("rows") or []
    try:
        main_rows = (json.load(open(args.main_list, encoding="utf-8")) or {}).get("rows") or []
    except (OSError, ValueError):
        main_rows = []

    print(f"FX filings list: {len(rows):,} companies; main Accounts list: {len(main_rows):,}\n")
    print("1. By month filed")
    months = defaultdict(list)
    for r in rows:
        months[(r.get("filed") or "")[:7]].append(r)
    for month in sorted(months, reverse=True):
        ms = months[month]
        print(f"  {month}: {len(ms):>5,} companies | strong FX proof (50+) {sum((r.get('filed_fx_score') or 0) >= 50 for r in ms):>4,}"
              f" | owned abroad, FX probably run there {sum(bool(r.get('run_from_abroad')) for r in ms):>3,}"
              f" | researched {sum(bool(r.get('research_checked')) for r in ms):>5,}")

    print("\n2. Figures to doubt")
    doubts = doubtful_figures(rows)
    for kind, found in doubts.items():
        print(f"  {kind}: {len(found)}")
        for r, why in found[:8]:
            print(f"    {who(r)}: {why}")
    if not doubts:
        print("  none")

    print("\n3. Repeats")
    twice, sets = repeats(rows)
    print(f"  the same company twice: {len(twice)}" + (f" ({', '.join(twice[:10])})" if twice else ""))
    print(f"  group companies filing the same figures, still separate rows: {len(sets)} sets")
    for members in sets[:12]:
        print("    " + " = ".join(f"{(m.get('company_name') or '?')[:34]} ({m.get('company_number')})" for m in members[:4])
              + f" — {money(_num(members[0].get('turnover_gbp')))} turnover, year to {members[0].get('period_end', '')}")

    print("\n4. Against the main Accounts list")
    if not main_rows:
        print("  main list not read")
    else:
        c = against_main_list(rows, main_rows)
        print(f"  on both lists: {c['both']:,} | strong finds (50+): {c['strong']:,}, not on the main list yet: "
              f"{len(c['strong_not_on_main']):,} (the finder takes them first, half its slots a run)")
        print(f"  turnover more than 5% apart: {len(c['turnover_apart'])}")
        for r, why in c["turnover_apart"][:8]:
            print(f"    {who(r)}: {why}")
        print(f"  FX gain/loss apart (sign, or more than 10%): {len(c['fx_apart'])}")
        for r, why in c["fx_apart"][:8]:
            print(f"    {who(r)}: {why}")

    api_key = os.environ.get("COMPANIES_HOUSE_API_KEY", "").strip()
    to_check = [r for kind, found in doubts.items() if kind.startswith("FX") for r, _ in found][: args.recheck]
    if to_check and api_key:
        print(f"\n5. Re-read from Companies House: {len(to_check)} doubtful FX figures")
        for r in to_check:
            print(f"  {who(r)} — list says FX {money(_num(r.get('fx_gain_loss_gbp')))}, turnover "
                  f"{money(_num(r.get('turnover_gbp')))}")
            for line in recheck(r, api_key):
                print(line)
    elif to_check:
        print("\n5. COMPANIES_HOUSE_API_KEY not set: nothing re-read")


if __name__ == "__main__":
    main()
