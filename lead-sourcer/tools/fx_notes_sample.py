#!/usr/bin/env python3
"""
tools/fx_notes_sample.py — what the currency-note readers find in real
accounts, and what they may be missing.

For each company: its latest accounts read the way the finder reads them
(accounts.facts_from_latest_accounts, OCR included), then the columns the
Accounts page shows — forward contracts, currencies named, foreign-currency
balances, sensitivity, turnover by region, the main currency's source and the
filed-FX score — and, for tagged / text filings, the lines that look like
currency facts but weren't read ("missed?"), to improve the readers on.

Accounts are public records and these lines carry no personal names, so the
output is the log only (public repo: no attachments).

    COMPANIES_HOUSE_API_KEY=... python3 tools/fx_notes_sample.py --accounts sample.json --max 40
    COMPANIES_HOUSE_API_KEY=... python3 tools/fx_notes_sample.py 00795535 SC302951
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sourcer import accounts, fx_notes, hooks, incumbent, pdf  # noqa: E402

LOOKS_LIKE = re.compile(r"forward\s+(?:foreign\s+)?(?:exchange|currency)?\s*contract|currency\s+risk|denominated\s+in|"
                        r"sensitivity|geographical|by\s+destination|currency\s+profile", re.I)
DIGITS = re.compile(r"\d[\d,]{2,}|\d+(?:\.\d+)?\s?(?:m|million)\b|\d+\s?%", re.I)


def short(s: str, n: int = 170) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def document_text(number: str, api_key: str) -> str:
    """The latest accounts as the readers see them (tagged filings laid out as rows; PDFs' text layer, no OCR)."""
    filing = accounts.latest_accounts_filing(number, api_key)
    if not filing:
        return ""
    doc_id = ((filing.get("links") or {}).get("document_metadata") or "").rstrip("/").rsplit("/", 1)[-1]
    if not doc_id:
        return ""
    document = None if filing.get("paper_filed") else accounts.fetch_ixbrl(doc_id, api_key)
    if document:
        return accounts.ixbrl_table_text(document.decode("utf-8", errors="replace"))
    text, how = pdf.to_text(accounts.fetch_pdf(doc_id, api_key) or b"")
    return text if how == "pdf" else ""


def sample(number: str, label: str, api_key: str, stats: Counter) -> None:
    print(f"\n=== {number} {label}")
    facts = accounts.facts_from_latest_accounts(number, api_key)
    if not facts:
        print("  no accounts read")
        stats["no accounts read"] += 1
        return
    stats[f"format {facts.get('format', '?')}"] += 1
    cols = fx_notes.columns(facts, label or number, facts.get("accounts_url", ""))
    today = incumbent.columns(facts, [])
    exposure = hooks.currency_exposure(label or number, facts, [], {})
    row = {**cols, "fx_today": today["fx_today"],
           "fx_gain_loss_gbp": str(round(facts["fx_gain_loss"])) if facts.get("fx_gain_loss") is not None else ""}
    score, lines = fx_notes.filed_proof(row)
    print(f"  format {facts.get('format')} | turnover {hooks.short(facts['turnover']) if facts.get('turnover') else '—'}"
          f" | filed FX score {score}")
    for key in ("fx_forwards", "currencies_in_accounts", "fx_balances", "fx_sensitivity", "turnover_regions"):
        if cols[key]:
            stats[key] += 1
            print(f"  {key}: {short(cols[key], 220)}")
    if cols["fx_forwards_evidence"]:
        print(f"    from: {short(cols['fx_forwards_evidence'], 260)}")
    if today["fx_today"]:
        stats["fx_today " + today["fx_today"].split(":")[0]] += 1
        print(f"  fx_today: {today['fx_today']}")
    if row["fx_gain_loss_gbp"]:
        stats["fx gain/loss"] += 1
    stats["main currency from " + (hooks.CURRENCY_SOURCES.get(exposure["rule"]) or "none")] += 1
    print(f"  main currency: {exposure['currency'] or '—'} ({hooks.CURRENCY_SOURCES.get(exposure['rule'], 'none')})")
    stats["filed FX score 50+" if score >= 50 else "filed FX score 1-49" if score else "filed FX score 0"] += 1
    if facts.get("format") == "scanned pdf":
        return
    text = document_text(number, api_key)
    read = " ".join(" ".join(str(x.get("sentence", "")) for x in facts.get(k) or [])
                    for k in ("fx_forwards", "fx_balances", "fx_sensitivity", "fx_currencies"))
    missed = []
    for line in text.split("\n"):
        if LOOKS_LIKE.search(line) and DIGITS.search(line) and short(line, 60)[:40] not in read \
                and not re.search(r"denominated in (?:pounds )?sterling", line, re.I):
            missed.append(short(line))
    for line in list(dict.fromkeys(missed))[:4]:
        print(f"  missed? {line}")
    stats["with possible misses"] += bool(missed)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("numbers", nargs="*")
    parser.add_argument("--accounts", help="accounts.json-style rows: an even spread through the list is sampled")
    parser.add_argument("--max", type=int, default=40)
    args = parser.parse_args()
    api_key = os.environ.get("COMPANIES_HOUSE_API_KEY", "")
    if not api_key:
        sys.exit("COMPANIES_HOUSE_API_KEY is not set")
    picks: list[tuple[str, str]] = [(n.upper(), "") for n in args.numbers]
    if args.accounts:
        with open(args.accounts, encoding="utf-8") as f:
            rows = [r for r in json.load(f) if r.get("turnover_gbp")]
        step = max(1, len(rows) // max(1, args.max))
        picks += [(r["company_number"], r.get("company_name", "")) for r in rows[::step]][: args.max]
    stats: Counter = Counter()
    for number, label in picks:
        try:
            sample(number, label, api_key, stats)
        except Exception as e:  # noqa: BLE001 — one bad filing shouldn't stop the sample
            print(f"  failed: {type(e).__name__}: {e}")
            stats["failed"] += 1
    print(f"\nSummary of {len(picks)} companies:")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
