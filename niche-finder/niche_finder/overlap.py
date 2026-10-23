"""
Mechanism overlap detection for contingent niches.

Before accepting a new contingent niche into the output, compare its underlying
FX mechanism against every niche already in the dataset. Two niches overlap when
they target the same structural reason a company crosses a currency boundary — even
if the business type label differs.

The check produces one of three outcomes:

  "none"     — mechanisms are distinct; accept the niche as a new row
  "overlap"  — same mechanism as an existing niche; merge rather than add a duplicate
               (the contingent niche would set its overlaps_with field and be flagged
               for manual review, since a true merge may need human judgement)
  "adjacent" — related mechanisms, meaningfully different sub-case; accept the niche
               but set overlaps_with so a human reviewer can see the relationship

Why use an LLM rather than string matching?
  Mechanism keys like "us_platform_spend" and a contingent niche described as
  "UK SaaS companies paying cloud bills in USD" share no surface-level string
  similarity but are mechanically identical. String distance would miss this.
  An LLM that understands the payment-flow semantics catches it reliably.

Why does this matter?
  A duplicate niche with a fresh competition check can return a different score
  (because the search framing is slightly different), producing two rows with the
  same mechanism showing "very_low" and "moderate" — misleading. Overlap detection
  surfaces this inconsistency before it reaches the output.

Performance: runs once per contingent niche at scoring time; not on structural
niches (which are defined in a controlled table and don't need dynamic overlap
checking).
"""

from __future__ import annotations

import json
import logging
from dataclasses import replace
from typing import List, Optional, Tuple

from .schema import Niche
from .competition import _extract_json  # reuse the same JSON extractor

logger = logging.getLogger(__name__)


_OVERLAP_PROMPT = """\
You are checking whether a NEW niche's FX mechanism is the same as, or meaningfully \
overlaps with, any niche in an EXISTING dataset.

Two niches have the SAME mechanism when the underlying reason a company is exposed \
to foreign-currency risk is structurally identical — even if the business-type label \
differs. Example of same mechanism:
  - EXISTING: "UK SaaS companies with significant cloud infrastructure spend"
    mechanism: pays USD for AWS/GCP/Azure cloud billing because US platforms bill
    in USD by default regardless of customer location
  - NEW: "UK e-commerce retailers with AWS hosting"
    mechanism: pays USD for AWS hosting because AWS bills in USD
  → These are the SAME mechanism. The new niche would duplicate the existing one.

Two niches are ADJACENT (related but distinct) when the mechanism is genuinely
different even if the sector sounds similar. Example:
  - EXISTING: "UK food & beverage manufacturers" (buys EUR-priced capital equipment
    from Italian/German makers)
  - NEW: "UK frozen food importers" (pays EUR to European suppliers for finished goods)
  → The payment flow is different (capex vs COGS); these are distinct niches.

NEW niche to evaluate:
  Name: {new_niche}
  Mechanism display: {new_mechanism_display}
  Evidence source (describes the FX exposure): {new_evidence_source}

EXISTING niches (name → mechanism description):
{existing_niches_text}

Return ONLY this JSON (no preamble, no markdown):
{{
  "overlap_type": "<none|overlap|adjacent>",
  "overlapping_niche": "<exact name from existing list, or empty string if none>",
  "reason": "<one sentence explaining the judgement>"
}}

Definitions:
  none     — the new niche has a clearly distinct FX mechanism from all existing ones
  overlap  — same FX mechanism as an existing niche (should merge, not duplicate)
  adjacent — related mechanism, but genuinely different payment flow or sub-case
"""


def detect_mechanism_overlap(
    new_niche: Niche,
    existing_niches: List[Niche],
    competition_client: dict,
) -> Tuple[str, str, str]:
    """
    Compare a new (contingent) niche against all existing niches.

    Returns (overlap_type, overlapping_niche_name, reason) where:
      overlap_type ∈ {"none", "overlap", "adjacent"}
      overlapping_niche_name — name of the existing niche, or ""
      reason — one-sentence explanation
    """
    if not existing_niches:
        return "none", "", "no existing niches to compare against"

    existing_text = "\n".join(
        f"  - {n.niche!r}: {n.mechanism_display} — {n.evidence_source[:120]}"
        for n in existing_niches
    )

    prompt = _OVERLAP_PROMPT.format(
        new_niche=new_niche.niche,
        new_mechanism_display=new_niche.mechanism_display,
        new_evidence_source=new_niche.evidence_source[:300],
        existing_niches_text=existing_text,
    )

    try:
        provider = competition_client.get("provider")

        if provider == "anthropic":
            client = competition_client["client"]
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=400,
                messages=[{"role": "user", "content": prompt}],
            )
            text = "\n".join(
                b.text for b in response.content if hasattr(b, "text") and b.text
            )

        elif provider == "gemini":
            gemini_client = competition_client["gemini_client"]
            model_name = competition_client["gemini_model_name"]
            response = gemini_client.models.generate_content(
                model=model_name,
                contents=prompt,
            )
            text = response.text

        else:
            raise ValueError(f"Unknown provider: {provider!r}")

        parsed = _extract_json(text)
        overlap_type = parsed.get("overlap_type", "none").strip().lower()
        if overlap_type not in ("none", "overlap", "adjacent"):
            logger.warning("Unexpected overlap_type %r, defaulting to 'none'", overlap_type)
            overlap_type = "none"

        overlapping = parsed.get("overlapping_niche", "").strip()
        reason = parsed.get("reason", "").strip()

        logger.info(
            "  overlap check %r → %s%s",
            new_niche.niche[:50],
            overlap_type,
            f" (vs '{overlapping[:40]}')" if overlapping else "",
        )
        return overlap_type, overlapping, reason

    except Exception as exc:
        logger.warning("Overlap check failed for %r: %s", new_niche.niche, exc)
        return "none", "", f"check failed: {exc}"


def apply_overlap_result(
    new_niche: Niche,
    overlap_type: str,
    overlapping_niche: str,
    reason: str,
) -> Optional[Niche]:
    """
    Apply the overlap detection result to the new niche.

    Returns:
      - None if overlap_type == "overlap" (exclude the duplicate from output)
      - The niche with overlaps_with set if adjacent
      - The niche unchanged if no overlap
    """
    if overlap_type == "overlap":
        logger.warning(
            "Excluding %r — same mechanism as existing niche %r (%s)",
            new_niche.niche,
            overlapping_niche,
            reason,
        )
        return None

    if overlap_type == "adjacent" and overlapping_niche:
        logger.info(
            "Marking %r as adjacent to %r (%s)",
            new_niche.niche,
            overlapping_niche,
            reason,
        )
        return replace(new_niche, overlaps_with=overlapping_niche)

    return new_niche
