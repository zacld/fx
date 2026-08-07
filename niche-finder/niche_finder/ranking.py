"""
Ranking logic for niches.

Sort order (do not blend into a composite score — keep axes separate):
  1. Competition: lowest first (very_low → very_high)
  2. Mechanism strength: highest first (confirmed → weak_inferred)
  3. Volume bucket: small ranks below the other three (which are roughly equivalent)

Niches with no competition data sort last within their mechanism-strength tier
(treating unknown competition as the worst case until checked).
"""

from __future__ import annotations

from typing import List

from .schema import Niche


_COMPETITION_RANK = {
    "very_low": 0,
    "low": 1,
    "moderate": 2,
    "high": 3,
    "very_high": 4,
    "": 5,  # unchecked — treat as worst until checked
}

_STRENGTH_RANK = {
    "confirmed": 0,
    "strong_inferred": 1,
    "moderate_inferred": 2,
    "weak_inferred": 3,
}

# small < everything else (treat good/excellent/capped as equivalent)
_VOLUME_RANK = {
    "small": 1,
    "good": 0,
    "excellent": 0,
    "capped": 0,
}


def _sort_key(niche: Niche) -> tuple:
    return (
        _COMPETITION_RANK.get(niche.competition, 5),
        _STRENGTH_RANK.get(niche.mechanism_strength, 9),
        _VOLUME_RANK.get(niche.effective_volume_bucket, 1),
    )


def rank_niches(niches: List[Niche]) -> List[Niche]:
    """Return a new list sorted by (competition asc, strength asc, volume asc)."""
    return sorted(niches, key=_sort_key)
