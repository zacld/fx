"""
Tests for the _extract_json helper used by both competition and contingent modules.

This is the critical defensive layer — a bad API response must never crash
a whole batch. These tests cover: clean JSON, JSON wrapped in markdown,
JSON buried in prose, malformed responses, and nested objects.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from niche_finder.competition import _extract_json


def test_bare_json():
    text = '{"competition": "very_low", "evidence": "nothing found", "competitor_examples": []}'
    result = _extract_json(text)
    assert result["competition"] == "very_low"
    assert result["evidence"] == "nothing found"
    assert result["competitor_examples"] == []


def test_json_with_preamble():
    text = 'Here is my analysis:\n\n{"competition": "low", "evidence": "one mention", "competitor_examples": ["Equals Money: blog post"]}'
    result = _extract_json(text)
    assert result["competition"] == "low"


def test_json_in_markdown_code_block():
    text = (
        "Based on my search:\n\n"
        "```json\n"
        '{"competition": "moderate", "evidence": "Ebury targets this", "competitor_examples": ["Ebury"]}\n'
        "```\n"
    )
    result = _extract_json(text)
    assert result["competition"] == "moderate"


def test_json_buried_in_long_prose():
    text = (
        "I searched extensively for FX broker content targeting UK SaaS companies. "
        "My findings indicate moderate competition. "
        '{"competition": "high", "evidence": "Multiple fintechs publish AWS FX content", '
        '"competitor_examples": ["Airwallex: AWS billing post", "Wise: cloud costs guide"]} '
        "This concludes my analysis."
    )
    result = _extract_json(text)
    assert result["competition"] == "high"
    assert len(result["competitor_examples"]) == 2


def test_nested_json_returns_outer():
    # The extractor should return the first complete balanced object
    text = '{"a": 1, "nested": {"b": 2}}'
    result = _extract_json(text)
    assert result["a"] == 1
    assert result["nested"] == {"b": 2}


def test_json_with_newlines_in_values():
    text = '{"competition": "very_high", "evidence": "Many brokers\\nactively target this", "competitor_examples": []}'
    result = _extract_json(text)
    assert result["competition"] == "very_high"


def test_raises_on_no_json():
    try:
        _extract_json("No JSON here, just plain text with no curly braces")
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


def test_raises_on_unclosed_json():
    try:
        _extract_json('{"competition": "low", "evidence": "incomplete...')
        assert False, "Should have raised ValueError"
    except ValueError:
        pass


def test_contingent_scoring_json():
    """Validate the shape expected from the contingent scoring API call."""
    text = (
        '{"mechanism_strength": "strong_inferred", "evidence_type": "company_filing", '
        '"evidence_source": "ZOO Digital annual report confirms USD functional currency", '
        '"effective_volume_raw": 85, "fx_direction": "receives_foreign", '
        '"payer_profile": "Hollywood/OTT Studios (USD)", '
        '"notes": "UK localisation studios receive USD from Netflix/Disney", '
        '"reject_reason": ""}'
    )
    result = _extract_json(text)
    assert result["mechanism_strength"] == "strong_inferred"
    assert result["effective_volume_raw"] == 85
    assert result["fx_direction"] == "receives_foreign"


def test_reject_json():
    text = (
        '{"mechanism_strength": "reject", "evidence_type": "inferred", '
        '"evidence_source": "", "effective_volume_raw": 0, "fx_direction": "pays_foreign", '
        '"payer_profile": "", "notes": "", '
        '"reject_reason": "No public evidence of foreign currency transactions found"}'
    )
    result = _extract_json(text)
    assert result["mechanism_strength"] == "reject"
    assert result["reject_reason"] != ""


def test_json_with_unicode():
    text = '{"competition": "low", "evidence": "Café importers with €EUR exposure", "competitor_examples": []}'
    result = _extract_json(text)
    assert "€EUR" in result["evidence"]


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
