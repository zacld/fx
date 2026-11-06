#!/usr/bin/env python3
"""
tools/reader_audit.py — the accounts readers, as they are now, on real filings: each company in a sample of the
Recent FX filings list is read again from Companies House (its latest accounts, two calls) and

  * compared with what the list holds (turnover, FX gain/loss, forward contracts) — same, changed, or now a check;
  * held to rules a right reading never breaks: no FX figure under £1,000 at a £10m+ company, none over 20% of
    turnover, no turnover over £5bn without the staff, turnover per head between £5k and £20m, this year's
    turnover within 20x of last year's, cost of sales under twice turnover, forward contracts under 20x turnover
    and within 50x of last year's, an FX figure within 1,000x of last year's, regions adding to no more than
    turnover (+15%).

    python3 tools/reader_audit.py filings.json [--sample 250]

A clean run is the bar: every rule broken is printed with the company, the figures and the line they came from.
Read-only; public repo: company names, numbers and public accounts figures only.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import accounts, filings, fx_notes  # noqa: E402

_AMOUNT = re.compile(r"(US\$|\$|€|£|¥)\s?([\d,.]+)\s*(m|bn|k)?", re.I)
_UNITS = {"k": 1e3, "m": 1e6, "bn": 1e9}


def short(v) -> str:
    if v is None or v == "":
        return "—"
    v = float(v)
    a = abs(v)
    s = f"£{a / 1e9:.1f}bn" if a >= 1e9 else f"£{a / 1e6:.1f}m" if a >= 1e6 else f"£{a / 1e3:.0f}k" if a >= 1e3 else f"£{a:.0f}"
    return ("-" if v < 0 else "") + s


def forward_sizes(text: str) -> list[tuple[float, float | None]]:
    """(this year, last year) per forward line in fx_forwards, in the line's own currency units."""
    out = []
    for part in (text or "").split(";"):
        amounts = []
        for m in _AMOUNT.finditer(part):
            try:
                amounts.append(float(m.group(2).replace(",", "")) * _UNITS.get((m.group(3) or "").lower(), 1))
            except ValueError:
                pass
        if amounts:
            prior = amounts[1] if "prior year" in part and len(amounts) > 1 else None
            out.append((amounts[0], prior))
    return out


def broken_rules(f: dict, cols: dict) -> list[str]:
    """The rules a reading breaks (empty when it's sound)."""
    out = []
    t, tp, fx, fxp = f.get("turnover"), f.get("turnover_prior"), f.get("fx_gain_loss"), f.get("fx_gain_loss_prior")
    staff, cost = f.get("employees") or 0, f.get("cost_of_sales")
    if fx is not None and fx != 0 and abs(fx) < accounts.FX_MIN_PLAUSIBLE and t and t >= accounts.FX_MIN_PLAUSIBLE_TURNOVER:
        out.append(f"FX {short(fx)} under £1,000 at {short(t)} turnover")
    if fx is not None and t and abs(fx) > accounts.FX_MAX_SHARE_OF_TURNOVER * t:
        out.append(f"FX {short(fx)} over 20% of turnover {short(t)}")
    if fx and fxp and min(abs(fx), abs(fxp)) >= 1 and max(abs(fx), abs(fxp)) / min(abs(fx), abs(fxp)) > 1000:
        out.append(f"FX {short(fx)} v last year {short(fxp)}: over 1,000x apart")
    if t and t > accounts.MAX_PLAUSIBLE_TURNOVER and staff < 1_000:
        out.append(f"turnover {short(t)} over £5bn with {staff or 'no'} staff")
    if t and staff and not 5_000 <= t / staff <= 20_000_000:
        out.append(f"turnover {short(t)} for {staff} staff ({short(t / staff)} a head)")
    if t and tp and tp > 0 and not 1 / 20 <= t / tp <= 20:
        out.append(f"turnover {short(t)} v last year {short(tp)}: over 20x apart")
    if t and cost and cost > 2 * t:
        out.append(f"cost of sales {short(cost)} over twice turnover {short(t)}")
    regions = sum(r.get("value", 0) for r in f.get("regions") or [] if r.get("value"))
    if t and regions > 1.15 * t:
        out.append(f"regions add to {short(regions)}, over turnover {short(t)}")
    for what, limit, label in (("fx_sensitivity", 0.5, "half"), ("fx_balances", 3.0, "3x")):
        for size, _ in forward_sizes(cols.get(what, "")):
            if t and size > limit * t:
                out.append(f"{what.replace('fx_', '')} {short(size)} over {label} turnover {short(t)}: "
                           f"{cols.get(what, '')[:90]}")
    for size, prior in forward_sizes(cols.get("fx_forwards", "")):
        if t and size > 20 * t:
            out.append(f"forward contracts {short(size)} over 20x turnover {short(t)}")
        if prior and min(size, prior) > 0 and max(size, prior) / min(size, prior) >= 50:
            out.append(f"forward contracts {short(size)} v last year {short(prior)}: 50x apart")
    return out


def sample(rows: list[dict], n: int) -> list[dict]:
    """The rows the cross-check doubted first, then the strongest, then a fixed random draw."""
    doubted = []
    for r in rows:
        fx = float(r["fx_gain_loss_gbp"]) if r.get("fx_gain_loss_gbp") else None
        t = float(r["turnover_gbp"]) if r.get("turnover_gbp") else None
        if (t and t > 5e9) or (fx and abs(fx) < 1000) or fx_notes.forward_evidence_doubtful(r.get("fx_forwards_evidence", "")):
            doubted.append(r)
    strongest = sorted(rows, key=lambda r: -(r.get("filed_fx_score") or 0))[:60]
    rest = [r for r in rows if r not in doubted and r not in strongest]
    random.Random(7).shuffle(rest)
    picked, seen = [], set()
    for r in doubted[:70] + strongest + rest:
        if r["company_number"] not in seen:
            seen.add(r["company_number"])
            picked.append(r)
    return picked[:n]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("filings")
    parser.add_argument("--sample", type=int, default=250)
    parser.add_argument("--numbers", default="", help="comma-separated company numbers: read these, with the tags behind them")
    args = parser.parse_args()
    api_key = os.environ.get("COMPANIES_HOUSE_API_KEY", "").strip()
    if not api_key:
        sys.exit("COMPANIES_HOUSE_API_KEY not set")
    rows = (json.load(open(args.filings, encoding="utf-8")) or {}).get("rows") or []
    wanted = [n.strip() for n in args.numbers.split(",") if n.strip()]
    picked = ([next((r for r in rows if r["company_number"] == n), {"company_number": n, "company_name": n}) for n in wanted]
              if wanted else sample(rows, args.sample))
    print(f"Reader audit: {len(picked)} of the list's {len(rows):,} companies read again with today's readers\n")
    tally, broken, changes = Counter(), [], []
    for r in picked:
        filing = accounts.latest_accounts_filing(r["company_number"], api_key)
        meta = ((filing or {}).get("links") or {}).get("document_metadata") or ""
        doc = accounts.fetch_ixbrl(meta.rstrip("/").split("/")[-1], api_key) if meta else None
        if not doc:
            tally["no tagged accounts to read (paper / PDF only)"] += 1
            continue
        try:
            f = accounts.extract_facts(doc)
        except Exception as e:  # noqa: BLE001 — a reader crash is itself a finding
            broken.append((r, [f"reader crashed: {type(e).__name__}: {e}"[:160]]))
            tally["reader crashed"] += 1
            continue
        f["format"] = "ixbrl"
        if wanted:
            print(f"{r.get('company_name')} ({r['company_number']}): staff {f.get('employees')}, turnover "
                  f"{short(f.get('turnover'))} (prior {short(f.get('turnover_prior'))}) from {f.get('turnover_source', '')[:200]}")
            scanner = accounts._IxbrlScanner()
            try:
                scanner.feed(doc.decode("utf-8", errors="replace"))
            except Exception:  # noqa: BLE001
                pass
            for fact in scanner.facts:
                if fact["concept"] in accounts.EMPLOYEE_CONCEPTS:
                    c = scanner.contexts.get(fact["context"]) or {}
                    print(f"    {fact['concept']} shown {fact.get('text', '').strip()!r} scale {fact.get('scale')} "
                          f"format {fact.get('format')} end {c.get('end')} members {c.get('members')} "
                          f"row …{fact.get('before', '')[-80:]!r}")
            print(f"    employee-like concepts: {sorted(x for x in scanner.concepts if 'mploy' in x)[:8]}")
        cols = fx_notes.columns(f, r.get("company_name", ""), "")
        tally["read"] += 1
        made_up = ((filing.get("description_values") or {}).get("made_up_date") or "")
        if r.get("period_end") and made_up and made_up != r["period_end"]:
            tally["a newer set of accounts than the list's (not compared)"] += 1
        else:
            pairs = (("turnover", r.get("turnover_gbp"), f.get("turnover")),
                     ("FX gain/loss", r.get("fx_gain_loss_gbp"), f.get("fx_gain_loss")),
                     ("forward contracts", r.get("fx_forwards") or "", cols.get("fx_forwards") or ""))
            for what, old, new in pairs:
                if what == "forward contracts":
                    same = old == new
                else:
                    same = (old in ("", None) and new is None) or (old not in ("", None) and new is not None
                                                                   and abs(float(old) - new) < 1)
                tally[f"{what}: {'same' if same else 'changed'}"] += 1
                if not same:
                    why = (f.get("fx_gain_loss_check") if what == "FX gain/loss" else
                           f.get("turnover_check") if what == "turnover" else "")
                    show = (lambda v: v or "—") if what == "forward contracts" else short
                    changes.append(f"{r['company_name'][:40]} ({r['company_number']}) {what}: {show(old)} -> {show(new)}"
                                   + (f" [{why[:110]}]" if why else ""))
        rules = broken_rules(f, cols)
        if rules:
            broken.append((r, rules + [f"source: FX {f.get('fx_gain_loss_evidence', '')[:90]}; turnover "
                                       f"{f.get('turnover_source', '')[:60]}; forwards {cols.get('fx_forwards_evidence', '')[:90]}"]))
    for k, v in sorted(tally.items()):
        print(f"  {k}: {v}")
    print(f"\nChanged from the list ({len(changes)}):")
    for line in changes[:60]:
        print(f"  {line}")
    print(f"\nRules broken by today's readings: {len(broken)} companies" + (" — none: clean" if not broken else ""))
    for r, rules in broken:
        print(f"  {r['company_name'][:44]} ({r['company_number']}):")
        for rule in rules:
            print(f"      {rule}")


if __name__ == "__main__":
    main()
