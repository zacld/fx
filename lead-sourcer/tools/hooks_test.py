#!/usr/bin/env python3
"""
tools/hooks_test.py — the call hooks and currency exposure (sourcer/hooks.py)
for the first N checked companies of an earlier finder list, from fresh
Companies House records (latest accounts, officers, owners, charges — the
same calls the finder makes). Writes a CSV with the nine new columns plus a
`check` column flagging weak evidence or a failed read. The log shows
counts only: names stay in the CSV.

    COMPANIES_HOUSE_API_KEY=... python3 tools/hooks_test.py fx_companies.csv --top 10 --output hooks_test.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import DEFAULT_NICHES_FILE  # noqa: E402
from sourcer import accounts, companies_house, excel, hooks, incumbent, qualify  # noqa: E402


def checks(facts, cols: dict) -> list[str]:
    """Why a row's evidence is weak, or what failed."""
    out = []
    if facts is None:
        out.append("accounts not read (no filing, no document, or PDF unreadable)")
    else:
        if facts.get("format") == "scanned pdf":
            out.append("scanned accounts: OCR of the first pages only")
        if facts.get("format") != "ixbrl":
            out.append("no tagged figures: FX gain/loss can't be read")
        if not facts.get("filed_on"):
            out.append("filing date missing")
    if not cols["fact_1"]:
        out.append("no fact qualified")
    if cols["currency_confidence"] == hooks.LOW:
        out.append("currency is the niche default only")
    elif cols["currency_confidence"] == hooks.MEDIUM and cols["currency_evidence"].startswith("HMRC"):
        out.append("currency from customs records (country-based estimate)")
    elif cols["currency_confidence"] == hooks.MEDIUM:
        out.append("currency evidence medium: check the quote")
    if cols["currency_direction"] == hooks.UNKNOWN:
        out.append("direction unknown")
    if any(f.startswith('"') for f in (cols["fact_1"], cols["fact_2"])):
        out.append("a fact quotes accounts wording: check it")
    if not cols["opener"]:
        out.append("no opener (nothing solid enough)")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv")
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--output", default="hooks_test.csv")
    args = parser.parse_args()
    key = companies_house.get_api_key()
    if not key:
        sys.exit("COMPANIES_HOUSE_API_KEY is not set")
    with open(DEFAULT_NICHES_FILE, encoding="utf-8") as f:
        niches = {n["name"]: n for n in json.load(f)["niches"]}
    with open(args.csv, newline="", encoding="utf-8") as f:
        rows = [r for r in csv.DictReader(f) if excel.is_checked(r)][:args.top]
    out, stats = [], Counter()
    for r in rows:
        number = r["company_number"]
        facts = accounts.facts_from_latest_accounts(number, key)
        officers = companies_house.get_active_officers(number, key)
        owners = companies_house.get_owners(number, key)
        charges = companies_house.get_charges(number, key)
        niche = niches.get(r.get("fx_niche", ""), {"name": r.get("fx_niche", ""), "currency_pairs": []})
        customs = {"imports": r.get("import_currencies", ""), "exports": r.get("export_currencies", ""),
                   "import_months": int(r.get("hmrc_import_months") or 0),
                   "export_months": int(r.get("hmrc_export_months") or 0)}
        cols = hooks.columns(r["company_name"], facts, officers, charges, owners, niche, customs=customs)
        cols.update(incumbent.columns(facts, charges))
        cols.update(qualify.assess(owners, facts, {"confidence": cols["currency_confidence"]}, cols["fx_today"],
                                   customs["import_months"] + customs["export_months"], r.get("own_bank_client") == "yes",
                                   os.environ.get("OWN_BANK", ""), r.get("pe_backed", "")))
        flags = checks(facts, cols)
        out.append({"company_name": r["company_name"], "company_number": number,
                    "accounts_format": (facts or {}).get("format", "not read"), **cols, "check": "; ".join(flags)})
        stats["with a fact"] += bool(cols["fact_1"])
        stats["with two facts"] += bool(cols["fact_2"])
        stats[f"currency {cols['currency_confidence'] or 'none'}"] += 1
        stats["with an opener"] += bool(cols["opener"])
        stats[f"qualified {cols['qualified']}"] += 1
        stats["with incumbent bank"] += bool(cols["incumbent_bank"])
        stats["with facility end date"] += bool(cols["facility_ends"])
        stats["with FX today"] += bool(cols["fx_today"])
        stats[f"accounts {(facts or {}).get('format', 'not read')}"] += 1
    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(out[0]) if out else ["company_name"])
        writer.writeheader()
        writer.writerows(out)
    print(f"{len(out)} companies -> {args.output}")
    for k, v in sorted(stats.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
