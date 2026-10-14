"""
sourcer/email_guesser.py — fallback email-pattern generation.

Used when Hunter.io has no key / no quota / no data for a domain. Generates
the most common UK corporate email pattern candidates for a named person.
Always marked email_confidence = "unverified_guess" by the caller — this
module never claims certainty.
"""

from __future__ import annotations

import re


def _clean(part: str) -> str:
    """Lowercase, strip anything that isn't a-z (handles hyphens, apostrophes, accents)."""
    part = part.lower()
    return re.sub(r"[^a-z]", "", part)


def guess_emails(first_name: str, last_name: str, domain: str) -> list[str]:
    """
    Generate likely email candidates in descending order of how common the
    pattern is at UK corporates:
      1. first.last@domain      (most common)
      2. firstinitiallast@domain
      3. first@domain
    Returns [] if first/last name or domain is missing.
    """
    first = _clean(first_name)
    last = _clean(last_name)
    domain = (domain or "").strip().lower()

    if not first or not last or not domain:
        return []

    return [
        f"{first}.{last}@{domain}",
        f"{first[0]}{last}@{domain}",
        f"{first}@{domain}",
    ]


def best_guess(first_name: str, last_name: str, domain: str) -> str:
    """Convenience: just the single most-likely pattern, or "" if unavailable."""
    candidates = guess_emails(first_name, last_name, domain)
    return candidates[0] if candidates else ""
