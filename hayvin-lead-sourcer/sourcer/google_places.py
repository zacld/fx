"""
sourcer/google_places.py — Google Places API (New) helpers.

Used only to confirm a Tier 2/3 company is still trading and to pull its
website domain — never its phone number, that's explicitly out of scope
for this tool.

Degrades gracefully: returns None when GOOGLE_PLACES_API_KEY is unset or
a lookup fails, so callers skip this enrichment step instead of crashing.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Optional
from urllib.parse import urlparse

PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"

# Explicitly excludes phoneNumbers — phone lookup is out of scope for this tool.
FIELD_MASK = "places.displayName,places.websiteUri,places.businessStatus,places.formattedAddress"


def get_api_key() -> Optional[str]:
    key = os.environ.get("GOOGLE_PLACES_API_KEY", "").strip()
    return key or None


def find_company(name: str, locality_hint: str = "UK") -> Optional[dict]:
    """
    Text-search Google Places for a company name (optionally scoped with a
    locality hint, e.g. a registered-office town) and return the top match as
    {"display_name", "domain", "business_status", "formatted_address"},
    or None if no key, no match, or the business looks closed.

    Deliberately does not read/return the `phoneNumbers` field — that lookup
    is handled by a separate tool, not this one.
    """
    api_key = get_api_key()
    if not api_key:
        return None

    query = f"{name} {locality_hint}".strip()
    body = json.dumps({"textQuery": query, "maxResultCount": 1}).encode()
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": FIELD_MASK,
    }

    try:
        req = urllib.request.Request(PLACES_SEARCH_URL, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"WARNING: Google Places lookup failed for '{name}': HTTP {e.code}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"WARNING: Google Places lookup failed for '{name}': {e}", file=sys.stderr)
        return None

    places = data.get("places") or []
    if not places:
        return None

    place = places[0]
    status = place.get("businessStatus", "OPERATIONAL")
    if status not in ("OPERATIONAL", ""):
        # CLOSED_TEMPORARILY / CLOSED_PERMANENTLY — don't hand back a dead lead.
        return None

    website = place.get("websiteUri", "")
    return {
        "display_name": place.get("displayName", {}).get("text", name),
        "domain": _extract_domain(website),
        "business_status": status,
        "formatted_address": place.get("formattedAddress", ""),
    }


def _extract_domain(url: str) -> str:
    if not url:
        return ""
    netloc = urlparse(url).netloc or urlparse(f"//{url}").netloc
    return netloc.lower().removeprefix("www.")
