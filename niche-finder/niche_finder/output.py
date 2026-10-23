"""
Write niches to CSV and JSON, and load them back from JSON.

Both formats use the same field order (CSV_FIELDS). The JSON output is what
the dashboard reads; the CSV is for spreadsheet review.
"""

from __future__ import annotations

import csv
import json
import os
from typing import List

from .schema import Niche, CSV_FIELDS


def write_csv(niches: List[Niche], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        for niche in niches:
            writer.writerow(niche.as_dict())


def write_json(niches: List[Niche], path: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump([n.as_dict() for n in niches], f, indent=2, ensure_ascii=False)


def load_json(path: str) -> List[Niche]:
    with open(path, encoding="utf-8") as f:
        records = json.load(f)
    return [Niche.from_dict(r) for r in records]
