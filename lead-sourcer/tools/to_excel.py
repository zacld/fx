#!/usr/bin/env python3
"""
tools/to_excel.py — turn an fx_companies.csv from an earlier run into the
Excel workbook the finder now writes (opens in Google Sheets too).

    python3 tools/to_excel.py fx_companies.csv [--output fx_companies.xlsx]
"""

from __future__ import annotations

import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import CSV_FIELDS, sections  # noqa: E402
from sourcer import excel  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("csv")
    parser.add_argument("--output", default="fx_companies.xlsx")
    args = parser.parse_args()
    with open(args.csv, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fields = [c for c in CSV_FIELDS if c in (reader.fieldnames or [])] + \
                 [c for c in (reader.fieldnames or []) if c not in CSV_FIELDS]
    excel.write_workbook(rows, fields, args.output, section_order=sections())
    print(f"{len(rows):,} companies, {sum(excel.is_checked(r) for r in rows):,} checked -> {args.output}")


if __name__ == "__main__":
    main()
