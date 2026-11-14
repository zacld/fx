"""
tools/mss_probe.py — the shape of the modern slavery statement registry's yearly download (read-only, prints no
people's names): its columns, how many statements, and the values of the size, sector and country columns, so the
registry can be used as a discovery source (companies with £36m+ turnover and their supply-chain countries).
"""

from __future__ import annotations

import csv
import io
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sourcer import registries  # noqa: E402

PERSON = ("person", "approv", "signator", "contact", "email", "phone", "name of")


def main() -> None:
    for year in (2026, 2025, 2024):
        text = registries.fetch(registries.MSS_URL.format(year=year))
        if not text:
            print(f"{year}: no file")
            continue
        rows = list(csv.DictReader(io.StringIO(text)))
        cols = list(rows[0].keys()) if rows else []
        print(f"{year}: {len(rows):,} statements; columns: {cols}")
        for col in cols:
            low = col.lower()
            if any(p in low for p in PERSON) and "organisation" not in low and "company" not in low:
                print(f"  {col}: (people — not printed)")
                continue
            values = Counter((r.get(col) or "").strip() for r in rows)
            filled = sum(n for v, n in values.items() if v)
            sample = [v[:80] for v, _ in values.most_common(8) if v]
            print(f"  {col}: {filled:,} filled, {len(values):,} distinct; top: {sample}")
        # list-like columns (countries, sectors): split on ; or , and count the parts
        for col in cols:
            if any(k in col.lower() for k in ("countr", "sector", "turnover", "risk")):
                parts = Counter(p.strip() for r in rows for p in (r.get(col) or "").replace("|", ";").split(";") if p.strip())
                print(f"  parts of {col}: {len(parts):,} distinct; top 25: {parts.most_common(25)}")
        break


if __name__ == "__main__":
    main()
