"""
FX Discovery — ai_provider.py

AI provider abstraction for event-level reasoning only.
Tries providers in order and falls back gracefully.

Provider order:
  1. Gemini (primary)
  2. Grok / xAI (fallback on Gemini quota errors)
  3. Empty result → existing rule-based fallback in ingest.py

IMPORTANT — cost control:
  This module is ONLY called for event-level reasoning (exposure mapping).
  It is NOT called per-company, per-website, per-lead, or per-message.
  Company discovery and scoring remain rule-based at zero AI cost.
"""

import os, json, re, logging, time
import requests
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)

# ── ENV CONFIG ────────────────────────────────────────────────────────────────
AI_PRIMARY_PROVIDER  = os.getenv("AI_PRIMARY_PROVIDER",  "gemini")
AI_FALLBACK_PROVIDER = os.getenv("AI_FALLBACK_PROVIDER", "grok")
USE_PLAYBOOK_FALLBACK = os.getenv("USE_PLAYBOOK_FALLBACK", "true").lower() == "true"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

XAI_API_KEY  = os.getenv("XAI_API_KEY", "")
XAI_MODEL    = os.getenv("XAI_MODEL", "grok-3-mini-fast")
XAI_BASE_URL = "https://api.x.ai/v1"


# ── JSON EXTRACTION ───────────────────────────────────────────────────────────

def extract_json(text: str) -> dict:
    """
    Extract the first valid JSON object from a model response.
    Handles markdown code fences, leading text, and trailing commentary.
    """
    text = text.strip()
    # Strip markdown fences
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"```\s*$", "", text, flags=re.MULTILINE)
    text = text.strip()
    s, e = text.find("{"), text.rfind("}")
    if s == -1 or e == -1:
        raise ValueError(f"No JSON object found in response (length={len(text)})")
    return json.loads(text[s:e + 1])


# ── ERROR DETECTION ───────────────────────────────────────────────────────────

def is_quota_error(exc: Exception) -> bool:
    """Return True if the exception is a quota/rate-limit error."""
    msg = str(exc).lower()
    return any(k in msg for k in [
        "429", "quota", "rate", "resource_exhausted",
        "daily", "exhausted", "too many requests",
    ])


# ── PROVIDER CALLS ────────────────────────────────────────────────────────────

def _call_gemini(prompt: str) -> dict:
    """Call Gemini generate_content and return parsed JSON."""
    from google import genai
    from google.genai import types as genai_types
    client = genai.Client(api_key=GEMINI_API_KEY)
    r = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            max_output_tokens=16384,
            temperature=0.1,
            response_mime_type="application/json",
        ),
    )
    return extract_json(r.text)


def _call_grok(prompt: str) -> dict:
    """
    Call xAI Grok via OpenAI-compatible chat completions endpoint.
    Returns parsed JSON from the model response.
    """
    if not XAI_API_KEY:
        raise RuntimeError("XAI_API_KEY not set")

    headers = {
        "Authorization": f"Bearer {XAI_API_KEY}",
        "Content-Type":  "application/json",
    }
    payload = {
        "model": XAI_MODEL,
        "messages": [
            {
                "role":    "system",
                "content": (
                    "You are a precise JSON generator for an FX sales intelligence system. "
                    "Return ONLY valid JSON — no markdown code fences, no explanation, no commentary. "
                    "The first character of your response must be '{' and the last must be '}'."
                ),
            },
            {
                "role":    "user",
                "content": prompt,
            },
        ],
        "temperature": 0.1,
    }

    resp = requests.post(
        f"{XAI_BASE_URL}/chat/completions",
        json=payload,
        headers=headers,
        timeout=90,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    return extract_json(content)


# ── PUBLIC INTERFACE ──────────────────────────────────────────────────────────

def call_ai_for_event(prompt: str, event_label: str = "") -> tuple[dict, dict]:
    """
    Call AI for event-level reasoning. Tries providers in order, falls back gracefully.

    Args:
        prompt:       The full prompt string (same format used for Gemini)
        event_label:  Short label for logging (e.g. event headline)

    Returns:
        (result_dict, metadata_dict)

        result_dict:  Parsed JSON from the model, or {} if all providers failed
        metadata_dict:
            ai_provider_used:   "gemini" | "grok" | "playbook" | None
            ai_model_used:      model name string
            ai_fallback_reason: e.g. "gemini_quota" | "gemini_error" | "grok_error" | None
            ai_cached:          False (reserved for future caching)
    """
    label = event_label[:60] if event_label else "event"

    meta = {
        "ai_provider_used":   None,
        "ai_model_used":      None,
        "ai_fallback_reason": None,
        "ai_cached":          False,
    }

    # Build ordered provider list from config
    providers = []
    if AI_PRIMARY_PROVIDER == "gemini" and GEMINI_API_KEY:
        providers.append(("gemini", GEMINI_MODEL, _call_gemini))
    if AI_FALLBACK_PROVIDER == "grok" and XAI_API_KEY:
        providers.append(("grok", XAI_MODEL, _call_grok))

    attempted = []

    for provider_name, model_name, call_fn in providers:
        is_fallback = bool(attempted)
        fallback_tag = " [FALLBACK]" if is_fallback else ""

        log.info("  AI%s: %s / %s — %s", fallback_tag, provider_name, model_name, label)
        t0 = time.time()

        try:
            result = call_fn(prompt)
            elapsed = time.time() - t0

            meta["ai_provider_used"] = provider_name
            meta["ai_model_used"]    = model_name

            segs       = result.get("target_segments", [])
            micro_cats = sum(len(s.get("micro_categories", [])) for s in segs)
            log.info("  AI success: %s (%.1fs) — %d segments, %d micro-cats",
                     provider_name, elapsed, len(segs), micro_cats)

            if is_fallback:
                log.info("  (Gemini quota was exhausted — Grok handled this event)")

            return result, meta

        except Exception as exc:
            elapsed = time.time() - t0
            quota   = is_quota_error(exc)
            reason  = f"{provider_name}_{'quota' if quota else 'error'}"

            log.warning("  AI %s failed after %.1fs [%s]: %s",
                        provider_name, elapsed, reason, str(exc)[:120])

            if meta["ai_fallback_reason"] is None:
                meta["ai_fallback_reason"] = reason

            attempted.append(provider_name)
            # Brief pause before trying fallback
            if not is_fallback:
                time.sleep(2)

    # ── All providers failed ──────────────────────────────────────────────────
    reasons = " → ".join(attempted) if attempted else "no providers configured"
    if USE_PLAYBOOK_FALLBACK:
        log.warning("  All AI providers failed (%s) — returning empty result for rule-based fallback",
                    reasons)
        meta["ai_provider_used"] = "playbook"
        meta["ai_model_used"]    = "static"
        return {}, meta

    raise RuntimeError(
        f"All AI providers failed ({reasons}). "
        f"Set USE_PLAYBOOK_FALLBACK=true to use rule-based fallback instead."
    )
