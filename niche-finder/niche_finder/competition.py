"""
Competition check: search for whether FX brokers/fintechs are already publishing
targeted marketing content for a given niche mechanism.

Supports two providers, detected automatically from environment:
  - anthropic    → claude-sonnet-4-6 with built-in web_search_20250305 tool
  - gemini       → Gemini with built-in Google Search grounding (requires only GEMINI_API_KEY)

Competition is the primary ranking signal. A niche that's very_low today can become
crowded once other brokers find it, so competition_checked_at is recorded and
--recheck-competition re-checks stale niches without re-running mechanism strength
(a structural fact that doesn't change).

Searches are run concurrently via ThreadPoolExecutor.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import replace
from datetime import datetime, timezone
from typing import List, Optional

from .schema import Niche

logger = logging.getLogger(__name__)


# ── JSON extraction ─────────────────────────────────────────────────────────

def _extract_json(text: str) -> dict:
    """
    Pull the first valid JSON object out of a free-form text response.
    Walks character-by-character to find a balanced {…} block.
    """
    start = text.find("{")
    if start == -1:
        raise ValueError("No JSON object found in response text")

    depth = 0
    for i, ch in enumerate(text[start:], start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = text[start : i + 1]
                try:
                    return json.loads(candidate)
                except json.JSONDecodeError:
                    pass

    raise ValueError(f"Could not parse balanced JSON from response: {text[:300]}")


# ── Provider factory ─────────────────────────────────────────────────────────

def make_competition_client(
    anthropic_api_key: Optional[str] = None,
    gemini_api_key: Optional[str] = None,
    gemini_model_name: str = "gemini-2.5-flash",
    # Legacy params — kept for backward compat, ignored
    serper_api_key: Optional[str] = None,
) -> dict:
    """
    Return a provider dict based on which keys are available.

    Priority: Anthropic > Gemini (with built-in Google Search grounding).
    Raises ValueError if no viable key is found.
    """
    if anthropic_api_key:
        import anthropic as _anthropic
        return {
            "provider": "anthropic",
            "client": _anthropic.Anthropic(api_key=anthropic_api_key),
        }

    if gemini_api_key:
        try:
            from google import genai as _genai
            from google.genai import types as _types
        except ImportError:
            raise ImportError(
                "google-genai is not installed. Run: pip install google-genai"
            )
        gemini_client = _genai.Client(api_key=gemini_api_key)
        return {
            "provider": "gemini",
            "gemini_client": gemini_client,
            "gemini_model_name": gemini_model_name,
        }

    raise ValueError(
        "No usable API keys found. Need either ANTHROPIC_API_KEY or GEMINI_API_KEY."
    )


# ── Shared competition analysis prompt ──────────────────────────────────────

_COMPETITION_PROMPT = """\
You are assessing how crowded a niche is with FX broker and payments fintech marketing.

Niche: {niche}
Mechanism: {mechanism_display}
FX direction: {fx_direction}

Search the web for evidence that FX brokers, currency specialists, or payments \
fintechs are already publishing targeted sales or marketing content about this \
specific niche. The companies to look for include: Corpay, Kantox, Argentex, \
Equals Money, Wise Business, Ebury, TransferMate, Caxton, Centtrip, Western Union \
Business Solutions, moneycorp, Currencies Direct, OFX, Airwallex, Convera.

Look for: blog posts, landing pages, sector guides, whitepapers, or case studies \
from FX/payments companies explicitly targeting companies in this sector for their \
FX exposure. A dedicated page or article on the FX company's own site targeting \
this niche is the clearest signal.

Example of HIGH competition: Kantox publishes "Currency Management Automation for \
the Food Industry" — that is concrete evidence the food manufacturer niche is \
already being worked.

No such dedicated content existing is itself the signal: the niche is clear.

After searching, respond with ONLY this JSON object (no preamble, no markdown):
{{
  "competition": "<very_low|low|moderate|high|very_high>",
  "evidence": "<one sentence: specific content you found, or confirmation nothing exists>",
  "competitor_examples": ["<company: specific page or article title>"]
}}

Competition scale:
  very_low  — no targeted FX/payments marketing found for this niche
  low       — one or two passing references, no dedicated campaigns
  moderate  — some targeted content exists (1-2 companies with relevant pages)
  high      — multiple fintechs have dedicated landing pages or article series
  very_high — saturated; widely targeted with dedicated campaigns by 3+ players
"""


# ── Anthropic provider ───────────────────────────────────────────────────────

def _anthropic_check(niche: Niche, client) -> dict:
    prompt = _COMPETITION_PROMPT.format(
        niche=niche.niche,
        mechanism_display=niche.mechanism_display,
        fx_direction=niche.fx_direction,
    )
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
    return _extract_json("\n".join(text_parts))


# ── Gemini provider (built-in Google Search grounding) ──────────────────────

def _gemini_check(niche: Niche, gemini_client, gemini_model_name: str) -> dict:
    """
    Run competition check via Gemini with built-in Google Search grounding.

    Uses the google_search tool built into the Gemini API — no separate
    search API key required.
    """
    from google.genai import types

    prompt = _COMPETITION_PROMPT.format(
        niche=niche.niche,
        mechanism_display=niche.mechanism_display,
        fx_direction=niche.fx_direction,
    )

    response = gemini_client.models.generate_content(
        model=gemini_model_name,
        contents=prompt,
        config=types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())]
        ),
    )
    return _extract_json(response.text)


# ── Single-niche dispatcher ──────────────────────────────────────────────────

def check_competition(niche: Niche, competition_client: dict) -> Niche:
    """
    Run a competition check for one niche using the given provider client.

    Returns an updated copy of the niche with competition fields filled.
    On failure, logs the error and returns the niche unchanged.
    """
    try:
        provider = competition_client["provider"]

        if provider == "anthropic":
            parsed = _anthropic_check(niche, competition_client["client"])
        elif provider == "gemini":
            parsed = _gemini_check(
                niche,
                competition_client["gemini_client"],
                competition_client["gemini_model_name"],
            )
        else:
            raise ValueError(f"Unknown provider: {provider!r}")

        competition = parsed.get("competition", "").strip().lower()
        if competition not in ("very_low", "low", "moderate", "high", "very_high"):
            raise ValueError(f"Unexpected competition value: {competition!r}")

        checked_at = datetime.now(timezone.utc).isoformat()
        evidence = parsed.get("evidence", "")[:80]
        logger.info("  ✓  %-50s → %-12s  %s", niche.niche[:50], competition, evidence)
        return replace(niche, competition=competition, competition_checked_at=checked_at)

    except Exception as exc:
        logger.warning("Competition check failed for %r: %s", niche.niche, exc)
        return niche


# ── Batch (concurrent) ──────────────────────────────────────────────────────

def check_competition_batch(
    niches: List[Niche],
    competition_client: dict,
    max_workers: int = 6,
    older_than_days: Optional[int] = None,
) -> List[Niche]:
    """
    Run competition checks concurrently.

    If older_than_days is set, skips niches whose data is still fresh.
    Returns a new list in the same order as the input.
    """
    to_check = []
    unchanged = {}

    for i, n in enumerate(niches):
        if older_than_days is not None and not n.is_competition_stale(older_than_days):
            unchanged[i] = n
        else:
            to_check.append((i, n))

    if not to_check:
        logger.info("All niches have fresh competition data — nothing to recheck.")
        return list(niches)

    provider = competition_client.get("provider", "?")
    logger.info(
        "Checking competition for %d niches via %s (workers=%d)…",
        len(to_check), provider, max_workers,
    )

    results: dict[int, Niche] = dict(unchanged)

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(check_competition, n, competition_client): i
            for i, n in to_check
        }
        for future in as_completed(futures):
            idx = futures[future]
            try:
                results[idx] = future.result()
            except Exception as exc:
                logger.error("Thread error for niche index %d: %s", idx, exc)
                results[idx] = niches[idx]

    return [results[i] for i in range(len(niches))]
