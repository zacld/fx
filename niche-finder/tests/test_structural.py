"""
Sanity checks for the structural niche generator.

These run without any API key — structural generation is purely in-process.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from niche_finder.structural import generate_structural_niches, STRUCTURAL_TABLE
from niche_finder.schema import (
    MECHANISM_STRENGTHS, BRANCHES, FX_DIRECTIONS, VOLUME_BUCKETS, CALL_STYLES,
)


def test_returns_niches():
    niches = generate_structural_niches()
    assert len(niches) > 0, "Should return at least one niche"


def test_count_matches_table():
    expected = sum(len(m["niches"]) for m in STRUCTURAL_TABLE)
    actual = len(generate_structural_niches())
    assert actual == expected, f"Expected {expected} niches, got {actual}"


def test_six_mechanisms():
    mechanisms = {m["mechanism"] for m in STRUCTURAL_TABLE}
    assert len(mechanisms) == 6, (
        f"Expected exactly 6 structural mechanisms, got {len(mechanisms)}. "
        "If you're adding a 7th, check it isn't a contingent niche in disguise."
    )


def test_all_branch_structural():
    niches = generate_structural_niches()
    for n in niches:
        assert n.branch == "structural", f"{n.niche}: branch should be 'structural'"


def test_all_strength_confirmed():
    niches = generate_structural_niches()
    for n in niches:
        assert n.mechanism_strength == "confirmed", (
            f"{n.niche}: structural niches must have mechanism_strength='confirmed'"
        )


def test_all_call_style_assertive():
    niches = generate_structural_niches()
    for n in niches:
        assert n.call_style == "assertive", (
            f"{n.niche}: confirmed/strong_inferred niches should have call_style='assertive'"
        )


def test_volume_buckets_valid():
    niches = generate_structural_niches()
    for n in niches:
        assert n.effective_volume_bucket in VOLUME_BUCKETS, (
            f"{n.niche}: invalid volume bucket {n.effective_volume_bucket!r}"
        )


def test_fx_directions_valid():
    niches = generate_structural_niches()
    for n in niches:
        assert n.fx_direction in FX_DIRECTIONS, (
            f"{n.niche}: invalid fx_direction {n.fx_direction!r}"
        )


def test_competition_empty_on_structural_generation():
    """Structural generation leaves competition blank — it's populated by a separate step."""
    niches = generate_structural_niches()
    for n in niches:
        assert n.competition == "", (
            f"{n.niche}: competition should be empty until check_competition_batch runs"
        )
        assert n.competition_checked_at == "", (
            f"{n.niche}: competition_checked_at should be empty until check runs"
        )


def test_no_missing_required_fields():
    niches = generate_structural_niches()
    for n in niches:
        assert n.niche.strip(), f"niche name must not be empty"
        assert n.mechanism.strip(), f"{n.niche}: mechanism key must not be empty"
        assert n.mechanism_display.strip(), f"{n.niche}: mechanism_display must not be empty"
        assert n.evidence_source.strip(), f"{n.niche}: evidence_source must not be empty"
        assert n.effective_volume_raw > 0, f"{n.niche}: effective_volume_raw must be positive"


def test_us_platform_niches_have_payer_profile():
    niches = generate_structural_niches()
    us_platform = [n for n in niches if n.mechanism == "us_platform_spend"]
    assert len(us_platform) > 0, "us_platform_spend mechanism should produce niches"
    for n in us_platform:
        assert n.payer_profile.strip(), (
            f"{n.niche}: us_platform_spend niches should have a payer_profile set"
        )


def test_non_us_platform_niches_empty_payer_by_default():
    niches = generate_structural_niches()
    non_us = [n for n in niches if n.mechanism != "us_platform_spend"]
    # Not all must be empty (some could be set) — just verify no accidental 'None' strings
    for n in non_us:
        assert n.payer_profile is not None, f"{n.niche}: payer_profile should be str, not None"
        assert n.payer_profile != "None", f"{n.niche}: payer_profile should be '' not 'None'"


if __name__ == "__main__":
    # Quick manual run
    passed = failed = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {name}")
                passed += 1
            except AssertionError as e:
                print(f"  FAIL  {name}: {e}")
                failed += 1
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
