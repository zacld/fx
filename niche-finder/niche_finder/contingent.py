"""
Contingent niche scoring via the Anthropic API with web search.

Contingent niches are business models that MIGHT have FX exposure depending on
a specific client/vendor relationship. The API call looks for a confirmable public
evidence source (industry report, trade press, company filing, association data)
that proves the relationship involves a foreign currency.

A "reject" outcome means no plausible evidence source exists — the niche is logged
but excluded from all output. It's a one-time gate; re-running won't change a reject
unless the underlying evidence landscape has materially changed.

mechanism_strength values for contingent niches (never "confirmed" — that's structural):
  strong_inferred    — solid public evidence; relationship and currency clearly documented
  moderate_inferred  — reasonable evidence; currency likely but could be via GBP intermediary
  weak_inferred      — logical inference only; limited public confirmation found
  reject             — no plausible evidence; excluded from output
"""

from __future__ import annotations

import csv
import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import List, Optional

from .schema import Niche, bucket_volume, derive_call_style
from .competition import _extract_json  # reuse the same JSON extractor

logger = logging.getLogger(__name__)


# ── Prompt ──────────────────────────────────────────────────────────────────

_SCORING_PROMPT = """\
You are evaluating whether a UK business niche has confirmed FX exposure via a \
specific counterparty relationship.

Niche to evaluate: {niche}
Mechanism hypothesis: {mechanism_hypothesis}
Payer/counterparty hint: {payer_profile_hint}

Search for PUBLIC evidence (industry reports, company financial filings, trade \
press, trade association websites, published case studies) that confirms:
1. UK companies in this niche genuinely transact with the named foreign counterparty
2. That payment or receipt is likely denominated in a foreign currency — not settled \
   in GBP via a UK intermediary

Example of strong evidence: ZOO Digital Group plc (AIM-listed) publishes annual \
reports in USD, explicitly stating their functional currency follows their Netflix \
and Disney client base — that is strong_inferred evidence that UK audiobook/localisation \
studios working for Hollywood studios receive USD.

Only use "confirmed" for structural niches (which this tool doesn't handle).

Return ONLY this JSON (no preamble, no markdown):
{{
  "mechanism_strength": "<strong_inferred|moderate_inferred|weak_inferred|reject>",
  "evidence_type": "<industry_report|company_filing|trade_press|association|payer_profile_inherited|inferred>",
  "evidence_source": "<specific source name and why it confirms this — one to two sentences>",
  "effective_volume_raw": <integer: estimated number of UK companies in this niche>,
  "fx_direction": "<pays_foreign|receives_foreign|both>",
  "payer_profile": "<named payer if it matches the payer profiles table (AWS, Hollywood/OTT Studios, etc.), else empty string>",
  "notes": "<one sentence summary of the FX exposure>",
  "reject_reason": "<only populate if reject: explain why no evidence was found>"
}}
"""

_KNOWN_PAYER_PROFILES_NOTE = """\

Known payer profiles whose currency is already established:
- AWS / Azure / GCP: bill UK customers in USD by default (confirmed)
- Salesforce / Oracle / SAP: USD-denominated licensing (confirmed)
- Hollywood / OTT Studios (Netflix, Disney+, Apple TV+, Amazon Prime): pay UK \
  localisation/content vendors in USD (confirmed — see ZOO Digital Group plc annual reports)
"""


# ── Score one contingent candidate ─────────────────────────────────────────

def score_contingent(row: dict, payer_profiles: dict, client) -> Optional[Niche]:
    """
    Score a single contingent candidate row.

    Returns a Niche on success, or None if the niche is rejected or the call fails.
    row must have keys: niche, mechanism_hypothesis, payer_profile_hint (optional).
    """
    niche_name = row.get("niche", "").strip()
    mechanism_hypothesis = row.get("mechanism_hypothesis", "").strip()
    payer_hint = row.get("payer_profile_hint", "").strip() or "Unknown"

    if not niche_name or not mechanism_hypothesis:
        logger.warning("Skipping row with missing niche or mechanism_hypothesis: %r", row)
        return None

    prompt = (
        _SCORING_PROMPT.format(
            niche=niche_name,
            mechanism_hypothesis=mechanism_hypothesis,
            payer_profile_hint=payer_hint,
        )
        + _KNOWN_PAYER_PROFILES_NOTE
    )

    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=800,
            tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
            messages=[{"role": "user", "content": prompt}],
        )

        text_parts = [
            block.text
            for block in response.content
            if hasattr(block, "text") and block.text
        ]
        raw_text = "\n".join(text_parts).strip()
        parsed = _extract_json(raw_text)

        strength = parsed.get("mechanism_strength", "").strip().lower()
        if strength == "reject":
            reason = parsed.get("reject_reason", "no evidence found")
            logger.info("Rejected %r: %s", niche_name, reason)
            return None

        if strength not in ("strong_inferred", "moderate_inferred", "weak_inferred"):
            raise ValueError(f"Unexpected mechanism_strength: {strength!r}")

        raw_vol = int(parsed.get("effective_volume_raw", 50))
        evidence_type = parsed.get("evidence_type", "inferred")
        evidence_source = parsed.get("evidence_source", "")
        fx_direction = parsed.get("fx_direction", "pays_foreign")
        payer_profile = parsed.get("payer_profile", "")
        notes = parsed.get("notes", "")

        # mechanism_display for contingent niches is the hypothesis itself
        mechanism_display = mechanism_hypothesis

        return Niche(
            niche=niche_name,
            branch="contingent",
            mechanism=mechanism_hypothesis.lower().replace(" ", "_")[:40],
            mechanism_display=mechanism_display,
            mechanism_strength=strength,
            evidence_type=evidence_type,
            evidence_source=evidence_source,
            payer_profile=payer_profile,
            competition="",           # checked separately in competition.py
            competition_checked_at="",
            effective_volume_raw=raw_vol,
            effective_volume_bucket=bucket_volume(raw_vol),
            call_style=derive_call_style(strength),
            fx_direction=fx_direction,
            notes=notes,
        )

    except Exception as exc:
        logger.error("Contingent scoring failed for %r: %s", niche_name, exc)
        return None


# ── Load candidates CSV ─────────────────────────────────────────────────────

def load_candidates_csv(path: str) -> List[dict]:
    """
    Load contingent candidates from a CSV file.

    Expected columns: niche, mechanism_hypothesis, payer_profile_hint (optional).
    Extra columns are ignored. Missing payer_profile_hint defaults to "".
    """
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(
                {
                    "niche": row.get("niche", "").strip(),
                    "mechanism_hypothesis": row.get("mechanism_hypothesis", "").strip(),
                    "payer_profile_hint": row.get("payer_profile_hint", "").strip(),
                }
            )
    return rows


# ── Batch (concurrent) with overlap detection ────────────────────────────────

def score_contingent_batch(
    rows: List[dict],
    payer_profiles: dict,
    client,
    max_workers: int = 8,
    existing_niches: Optional[List[Niche]] = None,
    competition_client: Optional[dict] = None,
) -> List[Niche]:
    """
    Score a batch of contingent candidates concurrently, then run overlap detection.

    Overlap detection compares each scored niche against existing_niches (typically
    the structural niches already in the dataset). Two niches with the same underlying
    FX mechanism produce confusing, inconsistent competition scores — overlap detection
    surfaces this before it reaches the output.

    If overlap_type == "overlap": exclude the new niche (it's a duplicate of an
    existing row that already has a competition score).

    If overlap_type == "adjacent": keep the new niche but set overlaps_with so a
    human reviewer can see the relationship.

    existing_niches and competition_client are both optional. If not provided,
    overlap detection is skipped.
    """
    from .overlap import detect_mechanism_overlap, apply_overlap_result

    logger.info(
        "Scoring %d contingent candidates (max_workers=%d)…", len(rows), max_workers
    )

    scored: List[Niche] = []

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(score_contingent, row, payer_profiles, client): row
            for row in rows
        }
        for future in as_completed(futures):
            row = futures[future]
            try:
                niche = future.result()
                if niche is not None:
                    scored.append(niche)
            except Exception as exc:
                logger.error(
                    "Unexpected error scoring %r: %s", row.get("niche", "?"), exc
                )

    # ── Overlap detection (sequential — depends on accumulating accepted set) ──
    results: List[Niche] = []
    if existing_niches is not None and competition_client is not None:
        logger.info("Running overlap detection for %d scored niches…", len(scored))
        all_so_far = list(existing_niches)  # structural + already accepted contingent
        for niche in scored:
            overlap_type, overlapping, reason = detect_mechanism_overlap(
                niche, all_so_far, competition_client
            )
            final_niche = apply_overlap_result(niche, overlap_type, overlapping, reason)
            if final_niche is not None:
                results.append(final_niche)
                all_so_far.append(final_niche)  # prevent duplicates within the batch too
    else:
        results = scored

    rejected_count = len(rows) - len(results)
    logger.info(
        "Contingent scoring complete: %d accepted, %d rejected/failed/duplicate out of %d",
        len(results),
        rejected_count,
        len(rows),
    )
    return results
