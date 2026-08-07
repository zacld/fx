"""
Tests for volume bucketing and ranking logic.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from niche_finder.schema import bucket_volume, derive_call_style
from niche_finder.ranking import rank_niches
from niche_finder.structural import generate_structural_niches


# ── bucket_volume ───────────────────────────────────────────────────────────

def test_small_below_50():
    assert bucket_volume(0) == "small"
    assert bucket_volume(1) == "small"
    assert bucket_volume(49) == "small"


def test_good_50_to_199():
    assert bucket_volume(50) == "good"
    assert bucket_volume(100) == "good"
    assert bucket_volume(199) == "good"


def test_excellent_200_to_499():
    assert bucket_volume(200) == "excellent"
    assert bucket_volume(350) == "excellent"
    assert bucket_volume(499) == "excellent"


def test_capped_500_plus():
    assert bucket_volume(500) == "capped"
    assert bucket_volume(1000) == "capped"
    assert bucket_volume(10000) == "capped"


def test_boundary_values():
    assert bucket_volume(49) == "small"
    assert bucket_volume(50) == "good"
    assert bucket_volume(199) == "good"
    assert bucket_volume(200) == "excellent"
    assert bucket_volume(499) == "excellent"
    assert bucket_volume(500) == "capped"


# ── derive_call_style ───────────────────────────────────────────────────────

def test_confirmed_is_assertive():
    assert derive_call_style("confirmed") == "assertive"


def test_strong_inferred_is_assertive():
    assert derive_call_style("strong_inferred") == "assertive"


def test_moderate_inferred_is_qualifying():
    assert derive_call_style("moderate_inferred") == "qualifying"


def test_weak_inferred_is_qualifying():
    assert derive_call_style("weak_inferred") == "qualifying"


# ── rank_niches ─────────────────────────────────────────────────────────────

def _make_niche(**kwargs):
    """Build a minimal Niche for ranking tests."""
    from niche_finder.schema import Niche
    defaults = dict(
        niche="Test Niche",
        branch="structural",
        mechanism="test",
        mechanism_display="Test mechanism",
        mechanism_strength="confirmed",
        evidence_type="business_model",
        evidence_source="test source",
        payer_profile="",
        competition="moderate",
        competition_checked_at="2026-01-01T00:00:00+00:00",
        effective_volume_raw=200,
        effective_volume_bucket="excellent",
        call_style="assertive",
        fx_direction="pays_foreign",
        notes="test",
    )
    defaults.update(kwargs)
    return Niche(**defaults)


def test_competition_is_primary_sort():
    """Lower competition sorts first."""
    niches = [
        _make_niche(niche="C", competition="very_high"),
        _make_niche(niche="A", competition="very_low"),
        _make_niche(niche="B", competition="moderate"),
    ]
    ranked = rank_niches(niches)
    names = [n.niche for n in ranked]
    assert names == ["A", "B", "C"], f"Expected [A, B, C] by competition, got {names}"


def test_mechanism_strength_is_secondary_sort():
    """Higher mechanism strength (confirmed) sorts before weaker."""
    niches = [
        _make_niche(niche="W", competition="low", mechanism_strength="weak_inferred"),
        _make_niche(niche="C", competition="low", mechanism_strength="confirmed"),
        _make_niche(niche="M", competition="low", mechanism_strength="moderate_inferred"),
    ]
    ranked = rank_niches(niches)
    names = [n.niche for n in ranked]
    assert names == ["C", "M", "W"], f"Expected [C, M, W] by strength, got {names}"


def test_small_volume_sorts_last():
    """Small volume bucket sorts below good/excellent/capped."""
    niches = [
        _make_niche(niche="S", competition="low", effective_volume_bucket="small"),
        _make_niche(niche="G", competition="low", effective_volume_bucket="good"),
        _make_niche(niche="E", competition="low", effective_volume_bucket="excellent"),
    ]
    ranked = rank_niches(niches)
    last = ranked[-1].niche
    assert last == "S", f"Small volume should sort last, but last was {last!r}"


def test_unchecked_competition_sorts_last():
    """Empty competition (unchecked) sorts after all known competition levels."""
    niches = [
        _make_niche(niche="U", competition=""),
        _make_niche(niche="H", competition="very_high"),
        _make_niche(niche="L", competition="very_low"),
    ]
    ranked = rank_niches(niches)
    names = [n.niche for n in ranked]
    assert names[0] == "L", f"very_low should be first, got {names[0]!r}"
    assert names[-1] == "U", f"unchecked should be last, got {names[-1]!r}"


def test_structural_niches_rank_correctly():
    """Smoke test: ranked structural niches don't crash and return same count."""
    niches = generate_structural_niches()
    ranked = rank_niches(niches)
    assert len(ranked) == len(niches)
    # All should have empty competition (unchecked), so order is by mechanism_strength then volume
    # All structural are "confirmed" so volume is the only differentiator
    # Just verify no crashes and confirmed niches are present
    assert all(n.mechanism_strength == "confirmed" for n in ranked)


def test_rank_preserves_all_niches():
    """rank_niches must not drop or duplicate niches."""
    niches = generate_structural_niches()
    ranked = rank_niches(niches)
    assert set(n.niche for n in ranked) == set(n.niche for n in niches)
    assert len(ranked) == len(niches)


if __name__ == "__main__":
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
