#!/usr/bin/env python3
"""
tools/sector_hits.py — which sectors (SIC codes) the FX filings scan's companies actually sit in, against how many
full / medium / group-accounts companies each sector has: the hit rate says where proven FX flows are common. Sectors
the finder's niches (config/fx_niches.json) don't already cover, with enough proven companies, are the ones worth
adding as candidates.

    python3 tools/sector_hits.py --filings fx-filings.json [--bulk BasicCompanyData.zip] [--min-strong 10]

One pass over Companies House's bulk file (downloaded when --bulk isn't given). Read-only; counts and sector names
only in the log (public repo). Prints a JSON line, "SECTORS:", with the suggested SIC codes.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from sourcer import bulk  # noqa: E402

SIZED = ("full", "medium", "group")   # main.LIKELY_CATEGORIES: accounts big enough to be in the band
STRONG = 50                           # filed FX proof that counts as strong (the finder's priority bar)


def niche_sics(path: str) -> set[str]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    niches = data["niches"] if isinstance(data, dict) else data
    return {str(s) for n in niches for s in n.get("sic_codes", [])}


def rank(sized: Counter, found: Counter, strong: Counter, covered: set[str], min_strong: int) -> list[dict]:
    """Sectors with min_strong+ strong finds, by hit rate (strong finds per 100 sized companies), not yet covered."""
    out = []
    for sic, n in strong.items():
        if n < min_strong or sic in covered or not sized[sic]:
            continue
        out.append({"sic": sic, "strong": n, "found": found[sic], "sized": sized[sic],
                    "rate": round(100 * n / sized[sic], 1)})
    return sorted(out, key=lambda x: (-x["rate"], -x["strong"]))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--filings", required=True)
    parser.add_argument("--bulk", default="")
    parser.add_argument("--niches", default=os.path.join(os.path.dirname(__file__), "..", "config", "fx_niches.json"))
    parser.add_argument("--min-strong", type=int, default=10)
    parser.add_argument("--min-rate", type=float, default=2.0, help="strong finds per 100 sized companies")
    args = parser.parse_args()

    with open(args.filings, encoding="utf-8") as f:
        rows = (json.load(f) or {}).get("rows") or []
    score = {r["company_number"]: float(r.get("filed_fx_score") or 0) for r in rows if r.get("company_number")}
    covered = niche_sics(args.niches)
    path = args.bulk or bulk.download()

    sized, found, strong, names = Counter(), Counter(), Counter(), {}
    it = bulk.iter_rows(path)
    header = next(it)
    col = {name: i for i, name in enumerate(header)}
    sic_cols = [col[c] for c in bulk.SIC_COLUMNS]
    for values in it:
        if len(values) < len(header) or values[col["CompanyStatus"]].strip() != "Active":
            continue
        sics = []
        for i in sic_cols:
            code = bulk.sic_code(values[i])
            if code:
                sics.append(code)
                names.setdefault(code, values[i].split(" - ", 1)[-1].strip())
        number = values[col["CompanyNumber"]].strip()
        if bulk.normalise_category(values[col["Accounts.AccountCategory"]]) in SIZED:
            sized.update(sics)
        if number in score:
            found.update(sics)
            if score[number] >= STRONG:
                strong.update(sics)

    print(f"FX filings companies: {len(score):,} ({sum(s >= STRONG for s in score.values()):,} strong); "
          f"sectors the niches cover: {len(covered)}")
    in_niches = sum(n for s, n in strong.items() if s in covered)
    print(f"Strong finds' sector codes inside the niches: {in_niches:,}; outside: {sum(strong.values()) - in_niches:,}\n")
    ranked = rank(sized, found, strong, covered, args.min_strong)
    print(f"{'SIC':6} {'rate':>6} {'strong':>7} {'found':>6} {'sized':>7}  sector")
    for x in ranked[:60]:
        print(f"{x['sic']:6} {x['rate']:>5}% {x['strong']:>7} {x['found']:>6} {x['sized']:>7}  {names.get(x['sic'], '')[:70]}")
    pick = [x for x in ranked if x["rate"] >= args.min_rate]
    print("\nSECTORS: " + json.dumps([{"sic": x["sic"], "name": names.get(x["sic"], ""), "rate": x["rate"],
                                        "strong": x["strong"]} for x in pick]))


if __name__ == "__main__":
    main()
