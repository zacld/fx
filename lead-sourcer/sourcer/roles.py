"""
sourcer/roles.py — rank Companies House directors as FX contacts.

The patterns and their order are a port of ROLE_PATTERNS in
packages/core/src/people.ts (the FX pipeline's decision-maker stage), so
this tool and the pipeline agree on who to ask for first: finance (Finance
Director, CFO, treasurer), then ownership (MD, CEO, founder, owner), then
commercial/procurement, then any other director.

Classified from the officer's filed `occupation`, which is the person's own
job title. That's reliable for an owner-managed business (the "Finance
Director" listed is that company's FD); at a bigger group a non-executive's
occupation can describe their job somewhere else, so treat it as a lead
for Cognism to confirm, not a fact.
"""

from __future__ import annotations

import re
from typing import Optional

# (pattern, tier, canonical label). First match wins, so more specific
# patterns sit above less specific ones ("Finance Director" before "Director").
ROLE_PATTERNS: list[tuple[re.Pattern[str], int, str]] = [
    # Tier 1 — finance + ownership
    (re.compile(r"\b(financ\w* director|financial director)\b", re.I), 1, "Finance Director"),
    (re.compile(r"\bFD\b"), 1, "Finance Director"),
    (re.compile(r"\b(chief financial officer|CFO)\b", re.I), 1, "CFO"),
    (re.compile(r"\b(head of finance|head of accounts)\b", re.I), 1, "Head of Finance"),
    (re.compile(r"\b(treasury manager|treasurer)\b", re.I), 1, "Treasurer"),
    (re.compile(r"\b(finance manager)\b", re.I), 1, "Finance Manager"),
    # Not in people.ts: Companies House-only. Owner-managed companies' finance
    # directors very often file their occupation as "Chartered Accountant".
    (re.compile(r"\baccountant\b", re.I), 1, "Accountant"),
    (re.compile(r"\b(managing director|MD)\b", re.I), 1, "Managing Director"),
    (re.compile(r"\b(chief executive officer?|CEO)\b", re.I), 1, "CEO"),
    (re.compile(r"\b(co-?founder|founder)\b", re.I), 1, "Founder"),
    (re.compile(r"\b(owner|proprietor)\b", re.I), 1, "Owner"),
    # Tier 2 — commercial / ops / procurement
    (re.compile(r"\b(commercial director)\b", re.I), 2, "Commercial Director"),
    (re.compile(r"\b(operations director|ops director)\b", re.I), 2, "Operations Director"),
    (re.compile(r"\b(procurement director|purchasing director)\b", re.I), 2, "Procurement Director"),
    (re.compile(r"\b(supply chain director)\b", re.I), 2, "Supply Chain Director"),
    (re.compile(r"\b(sales director)\b", re.I), 2, "Sales Director"),
    (re.compile(r"\b(purchasing manager|procurement manager)\b", re.I), 2, "Purchasing Manager"),
    (re.compile(r"\b(accounts manager|accounts payable)\b", re.I), 2, "Accounts Manager"),
    (re.compile(r"\b(general manager)\b", re.I), 2, "General Manager"),
    # Tier 3 — fallback
    (re.compile(r"\b(director)\b", re.I), 3, "Director"),
    (re.compile(r"\b(company secretary|secretary)\b", re.I), 3, "Company Secretary"),
    (re.compile(r"\bnon-?executive\b", re.I), 3, "Non-Executive"),
]


def classify_role(text: str) -> Optional[tuple[int, str]]:
    """(tier, canonical label) for a free-text role/occupation, or None."""
    if not text:
        return None
    for pattern, tier, label in ROLE_PATTERNS:
        if pattern.search(text):
            return tier, label
    return None


def _rank(text: str) -> int:
    """Position of the first matching pattern — lower is a better FX contact."""
    if text:
        for i, (pattern, _tier, _label) in enumerate(ROLE_PATTERNS):
            if pattern.search(text):
                return i
    return len(ROLE_PATTERNS)


FINANCE_LABELS = {"Finance Director", "CFO", "Head of Finance", "Treasurer", "Finance Manager", "Accountant"}
LEADER_LABELS = {"Managing Director", "CEO", "Founder", "Owner"}


def _label(director: dict) -> str:
    return (classify_role(director.get("occupation") or "") or (0, ""))[1]


def pick_fx_contact(directors: list[dict]) -> Optional[dict]:
    """
    The director to ask for first about overseas payments: best-ranked
    occupation, ties broken by longest-serving (more likely the owner-manager
    than a recent appointment). None if there are no directors.
    """
    if not directors:
        return None
    return min(
        directors,
        key=lambda d: (_rank(d.get("occupation") or ""), d.get("appointed_on") or "9999-12-31"),
    )


def pick_finance_director(directors: list[dict]) -> Optional[dict]:
    """The best-ranked director whose filed occupation is a finance role, or None."""
    return pick_fx_contact([d for d in directors if _label(d) in FINANCE_LABELS])


def pick_lead_director(directors: list[dict], exclude: Optional[dict] = None) -> Optional[dict]:
    """
    MD / CEO / founder / owner by filed occupation; failing that the
    best-ranked remaining director (usually the longest-serving, as most
    file "Director"). `exclude` is the finance director, already reported.
    """
    others = [d for d in directors if d is not exclude]
    return pick_fx_contact([d for d in others if _label(d) in LEADER_LABELS] or others)
