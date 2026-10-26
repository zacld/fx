"""
sourcer/register_cache.py — one company's Companies House lookups (latest
accounts read, officers, owners, charges) kept on disk between runs, so the
daily finder doesn't re-fetch and re-read every company each morning.

A company is looked up again when its entry is older than CACHE_DAYS, or
sooner when the monthly bulk file shows newer accounts (`accounts_made_up_to`
changed). Off unless REGISTER_CACHE_DAYS is set (the finder workflow sets 7).
"""

from __future__ import annotations

import json
import os
import time
from typing import Optional

CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "fx-lead-sourcer", "register")
CACHE_DAYS = float(os.environ.get("REGISTER_CACHE_DAYS", "0"))
# What was read from a filing (incl. OCR) doesn't change until newer accounts are filed: kept longer.
FACTS_DAYS = float(os.environ.get("REGISTER_FACTS_DAYS", "90"))


def _path(number: str) -> str:
    return os.path.join(CACHE_DIR, f"{number}.json")


def load(number: str, made_up_to: str = "", days: Optional[float] = None) -> Optional[dict]:
    """
    The stored lookups for this company, or None when missing, older than
    `days` (default CACHE_DAYS) or the accounts have moved on.
    """
    if CACHE_DAYS <= 0 or not number:
        return None
    try:
        if time.time() - os.path.getmtime(_path(number)) > (CACHE_DAYS if days is None else days) * 86400:
            return None
        with open(_path(number), encoding="utf-8") as f:
            entry = json.load(f)
    except (OSError, ValueError):
        return None
    return entry if entry.get("made_up_to", "") == (made_up_to or "") else None


def store(number: str, made_up_to: str, entry: dict) -> None:
    if CACHE_DAYS <= 0 or not number:
        return
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = _path(number) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({**entry, "made_up_to": made_up_to or ""}, f)
    os.replace(tmp, _path(number))
