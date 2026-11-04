"""
sourcer/group.py — a subsidiary's UK parent and its consolidated accounts.

A subsidiary's own accounts often say little about FX — the group's treasury
does it, and the parent's consolidated accounts carry the currency-risk note,
the forward contracts and the group's turnover. An audit-exempt subsidiary may
file no figures at all. So for a company owned by a UK company (its PSC
register names a corporate owner with a Companies House number), the parent's
latest accounts are read the way the company's own are
(accounts.facts_from_latest_accounts). Only a figure that stands for the
group counts (consolidated, or at least the subsidiary's own size —
is_group_figure); a parent without one (an intermediate holding company
exempt from consolidating, or one whose own turnover is a few management
charges) leads one level up, to its own UK parent (MAX_HOPS).

Each parent is read once and cached (register_cache lookup "group", FACTS_DAYS),
so twenty subsidiaries of one group cost one read; at most READS_MAX_PER_RUN
new parents are read a run (cached ones are always used). Public records only,
no extra sources.
"""

from __future__ import annotations

import os
import re
import threading
from typing import Optional

from sourcer import accounts, companies_house, hooks, register_cache

MAX_HOPS = 2
READS_MAX_PER_RUN = int(os.environ.get("GROUP_READS_MAX", "200"))
# A Companies House number: 8 digits (shorter ones are zero-padded), or two letters and six digits (SC, NI, OC…).
_CH_NUMBER = re.compile(r"^(?:\d{1,8}|[A-Z]{2}\d{6})$")

stats = {"read": 0, "cached": 0, "skipped": 0}
_lock = threading.Lock()
_parent_locks: dict[str, threading.Lock] = {}


def uk_parent(owners: list[dict]) -> Optional[tuple[str, str]]:
    """(company number, name) of the current corporate owner registered at Companies House, or None."""
    for o in owners or []:
        if o.get("kind") != "corporate" or o.get("ceased_on"):
            continue
        number = (o.get("registration_number") or "").replace(" ", "").upper()
        if not _CH_NUMBER.match(number):
            continue
        if o.get("country") and not hooks.is_uk(o["country"]):
            continue   # a foreign registry's number: not a Companies House filing
        return (number.zfill(8) if number.isdigit() else number), o.get("name", "")
    return None


def _read_parent(number: str, name: str, api_key: str) -> Optional[dict]:
    """{"facts", "parent": [number, name] | None} for one parent, from the cache or read now (None: over budget)."""
    with _lock:
        lock = _parent_locks.setdefault(number, threading.Lock())
    with lock:   # two subsidiaries of one parent at once: the second waits for the first's read
        found, cached = register_cache.load_lookup("group", number, days=register_cache.FACTS_DAYS)
        if found and isinstance(cached, dict) and cached.get("facts_version") == accounts.FACTS_VERSION:
            with _lock:
                stats["cached"] += 1
            return cached
        with _lock:
            if stats["read"] >= READS_MAX_PER_RUN:
                stats["skipped"] += 1
                return None
            stats["read"] += 1
        facts = accounts.facts_from_latest_accounts(number, api_key)
        up = None
        if not facts or facts.get("turnover") is None or facts.get("turnover_basis") != "group":
            up = uk_parent(companies_house.get_owners(number, api_key))   # its own owner, if this isn't the group
        entry = {"facts": facts, "parent": list(up) if up else None, "name": name,
                 "facts_version": accounts.FACTS_VERSION}
        register_cache.store_lookup("group", number, entry)
        return entry


def is_group_figure(facts: dict, own_turnover: Optional[float] = None) -> bool:
    """
    Whether a parent's turnover stands for the group: a consolidated figure, or at least as big as the
    subsidiary's own. A holding company's own turnover (£5.8m of management charges over a £240m group, or £0) isn't.
    """
    turnover = facts.get("turnover")
    if not turnover or turnover <= 0:
        return False
    return facts.get("turnover_basis") == "group" or bool(own_turnover and turnover >= own_turnover)


def parent_accounts(owners: list[dict], api_key: str, own_turnover: Optional[float] = None) -> Optional[dict]:
    """
    {"number", "name", "turnover", "facts", "hops"} for the nearest UK parent whose latest accounts give the
    group's turnover (is_group_figure), or None: no UK parent, none of them files one within MAX_HOPS, or this
    run's parent reads are used up.
    """
    parent = uk_parent(owners)
    for hop in range(1, MAX_HOPS + 1):
        if not parent:
            return None
        number, name = parent
        entry = _read_parent(number, name, api_key)
        if entry is None:
            return None
        facts = entry.get("facts") or {}
        if is_group_figure(facts, own_turnover):
            return {"number": number, "name": name or entry.get("name", ""), "turnover": facts["turnover"],
                    "facts": facts, "hops": hop}
        parent = tuple(entry["parent"]) if entry.get("parent") else None
    return None


def label(group: dict) -> str:
    """ "PARENT HOLDINGS LIMITED (01234567)", saying when it's the parent's parent."""
    up = " — the parent's parent" if group.get("hops", 1) > 1 else ""
    return f"{group['name']} ({group['number']}){up}"
