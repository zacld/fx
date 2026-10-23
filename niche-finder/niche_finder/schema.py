"""
Core types, enums, and derived-field helpers for the Niche Finder Engine.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from typing import Optional


# ── Valid values ────────────────────────────────────────────────────────────

BRANCHES = ("structural", "contingent")

MECHANISM_STRENGTHS = ("confirmed", "strong_inferred", "moderate_inferred", "weak_inferred")

COMPETITION_LEVELS = ("very_low", "low", "moderate", "high", "very_high")

VOLUME_BUCKETS = ("small", "good", "excellent", "capped")

CALL_STYLES = ("assertive", "qualifying")

FX_DIRECTIONS = ("pays_foreign", "receives_foreign", "both")

EVIDENCE_TYPES = (
    "business_model",       # structural: the model itself proves the exposure
    "industry_report",      # contingent: confirmed by sector research
    "company_filing",       # contingent: financial filings or CH filings
    "trade_press",          # contingent: documented in trade publications
    "association",          # contingent: industry body confirms the relationship
    "payer_profile_inherited",  # contingent: inherited from known payer table
    "inferred",             # contingent: logical inference, no hard public source
)


# ── Volume bucketing ────────────────────────────────────────────────────────

def bucket_volume(raw: int) -> str:
    """
    Bucket a raw company-count estimate into a qualitative tier.

    500+ and 200-499 are treated roughly equivalently in ranking — both
    represent dial-able scale. The distinction that matters is small (<50).
    """
    if raw < 50:
        return "small"
    if raw < 200:
        return "good"
    if raw < 500:
        return "excellent"
    return "capped"


# ── Call-style derivation ───────────────────────────────────────────────────

def derive_call_style(mechanism_strength: str) -> str:
    """
    Assertive opener when the FX exposure is structurally certain;
    qualifying opener when we're inferring and need to confirm first.
    """
    if mechanism_strength in ("confirmed", "strong_inferred"):
        return "assertive"
    return "qualifying"


# ── Niche dataclass ─────────────────────────────────────────────────────────

@dataclass
class Niche:
    niche: str
    branch: str                     # structural | contingent
    mechanism: str                  # machine-readable mechanism key
    mechanism_display: str          # human-readable label
    mechanism_strength: str         # confirmed | strong_inferred | moderate_inferred | weak_inferred
    evidence_type: str
    evidence_source: str
    payer_profile: str              # named payer from profiles table, or ""
    competition: str                # very_low | low | moderate | high | very_high | ""
    competition_checked_at: str     # ISO-8601 UTC timestamp, or ""
    effective_volume_raw: int
    effective_volume_bucket: str    # small | good | excellent | capped
    call_style: str                 # assertive | qualifying (derived)
    fx_direction: str               # pays_foreign | receives_foreign | both
    notes: str
    overlaps_with: str = ""      # name of any existing niche with the same mechanism, or ""

    def is_competition_stale(self, older_than_days: int = 30) -> bool:
        """True if competition has never been checked or is past the staleness threshold."""
        if not self.competition_checked_at:
            return True
        try:
            checked = datetime.fromisoformat(self.competition_checked_at.replace("Z", "+00:00"))
            age_days = (datetime.now(timezone.utc) - checked).days
            return age_days >= older_than_days
        except ValueError:
            return True

    def as_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Niche":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


# ── CSV column order ────────────────────────────────────────────────────────

CSV_FIELDS = [
    "niche",
    "branch",
    "mechanism",
    "mechanism_display",
    "mechanism_strength",
    "evidence_type",
    "evidence_source",
    "payer_profile",
    "competition",
    "competition_checked_at",
    "effective_volume_raw",
    "effective_volume_bucket",
    "call_style",
    "fx_direction",
    "notes",
    "overlaps_with",
]
