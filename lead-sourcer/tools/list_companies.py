#!/usr/bin/env python3
"""
tools/list_companies.py — print the companies in a finance_contacts_test.csv
(or fx_companies.csv) to the log, so they can be checked against another
data source.

Company names and numbers are public Companies House data. The guessed
finance contact is NOT printed: only a short fingerprint of first initial +
surname (sha256, 8 chars), so a name from elsewhere can be compared without
any person's name appearing in the (public) Actions log.

    python3 tools/list_companies.py finance_contacts_test.csv
"""

from __future__ import annotations

import csv
import hashlib
import sys


def fingerprint(name: str) -> str:
    words = [w.strip(".,").upper() for w in name.split() if w.strip(".,").upper() not in
             {"MR", "MRS", "MS", "MISS", "DR", "SIR", "DAME", "PROF"}]
    if len(words) < 2:
        return ""
    return hashlib.sha256(f"{words[0][0]} {words[-1]}".encode()).hexdigest()[:8]


def main() -> None:
    with open(sys.argv[1], newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    print("company_number|company_name|website|guess_fingerprint|guess_source")
    for r in rows:
        source = (r.get("finance_contact_source") or "").split(" — ")[0]
        print("|".join([r["company_number"], r["company_name"], r.get("website", ""),
                        fingerprint(r.get("finance_contact", "")), source]))
    print(f"rows: {len(rows)}")


if __name__ == "__main__":
    main()
