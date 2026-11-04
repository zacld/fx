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


# --- Other per-company lookups: the company's website, finance appointments in the news ----------------------------
# Re-read every day they took ~20 minutes of each finder run and rarely change: kept LOOKUP_CACHE_DAYS (7), under the
# same directory (so the workflow's register cache saves them too), only while the register cache is on.
LOOKUP_DAYS = float(os.environ.get("LOOKUP_CACHE_DAYS", "7"))


def _lookup_path(kind: str, number: str) -> str:
    return os.path.join(CACHE_DIR, kind, f"{number}.json")


def load_lookup(kind: str, number: str, days: Optional[float] = None) -> tuple[bool, object]:
    """(found, value) for this company's `kind` lookup ("website", "news") from the last LOOKUP_DAYS (or `days`)."""
    days = LOOKUP_DAYS if days is None else days
    if CACHE_DAYS <= 0 or days <= 0 or not number:
        return False, None
    try:
        if time.time() - os.path.getmtime(_lookup_path(kind, number)) > days * 86400:
            return False, None
        with open(_lookup_path(kind, number), encoding="utf-8") as f:
            return True, json.load(f)["value"]
    except (OSError, ValueError, KeyError):
        return False, None


def store_lookup(kind: str, number: str, value: object) -> None:
    if CACHE_DAYS <= 0 or LOOKUP_DAYS <= 0 or not number:
        return
    path = _lookup_path(kind, number)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump({"value": value}, f)
        os.replace(path + ".tmp", path)
    except (OSError, TypeError, ValueError):
        pass   # a value that won't store is simply looked up again next run


def cached_many(kind: str, items: list[tuple], look_up_many, stale=None) -> tuple[dict, int]:
    """
    look_up_many(items) for the companies (item[0] = company number) not looked up in the last LOOKUP_DAYS, the
    others from the cache: ({company_number: value}, how many came from the cache). `stale(item, value)` True looks
    a cached company up again anyway (a website lookup that found nothing, with a new address to try).
    """
    hits, todo = {}, []
    for item in items:
        found, value = load_lookup(kind, item[0])
        if found and not (stale and stale(item, value)):
            hits[item[0]] = value
        else:
            todo.append(item)
    fresh = look_up_many(todo) if todo else {}
    for number, value in fresh.items():
        store_lookup(kind, number, value)
    return {**hits, **fresh}, len(hits)
