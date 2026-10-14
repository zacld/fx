"""
sourcer/hunter.py — Hunter.io email finding helpers.

Free tier: 25 searches + 1000 verifications/month — burn it carefully.
Degrades gracefully: returns None when HUNTER_API_KEY is unset, or when the
call fails (bad key, quota exhausted, rate limit) so callers fall back to
email_guesser.py instead of crashing.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

DOMAIN_SEARCH_URL = "https://api.hunter.io/v2/domain-search"
EMAIL_FINDER_URL = "https://api.hunter.io/v2/email-finder"


def get_api_key() -> Optional[str]:
    key = os.environ.get("HUNTER_API_KEY", "").strip()
    return key or None


def _get(url: str, params: dict) -> Optional[dict]:
    qs = urllib.parse.urlencode(params)
    full_url = f"{url}?{qs}"
    try:
        with urllib.request.urlopen(full_url, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print("WARNING: Hunter.io rate limit / quota exhausted — falling back to guesses.", file=sys.stderr)
        elif e.code in (401, 403):
            print("WARNING: Hunter.io auth failed — check HUNTER_API_KEY.", file=sys.stderr)
        else:
            print(f"WARNING: Hunter.io request failed: HTTP {e.code}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"WARNING: Hunter.io request failed: {e}", file=sys.stderr)
        return None


def domain_pattern(domain: str) -> Optional[dict]:
    """
    Hunter's confirmed email pattern for a domain, e.g. {"pattern": "{first}.{last}",
    "confidence": 87}. Returns None if no key or no data.
    """
    api_key = get_api_key()
    if not api_key:
        return None

    data = _get(DOMAIN_SEARCH_URL, {"domain": domain, "api_key": api_key, "limit": 1})
    if not data:
        return None

    result = data.get("data", {})
    pattern = result.get("pattern")
    if not pattern:
        return None
    return {"pattern": pattern, "confidence": result.get("emails", [{}])[0].get("confidence") if result.get("emails") else None}


def find_person_email(first_name: str, last_name: str, domain: str) -> Optional[dict]:
    """
    Hunter's Email Finder for a named person at a domain.
    Returns {"email": ..., "confidence": 0-100} or None.
    """
    api_key = get_api_key()
    if not api_key:
        return None

    data = _get(EMAIL_FINDER_URL, {
        "domain": domain,
        "first_name": first_name,
        "last_name": last_name,
        "api_key": api_key,
    })
    if not data:
        return None

    result = data.get("data", {})
    email = result.get("email")
    if not email:
        return None
    return {"email": email, "confidence": result.get("score")}
