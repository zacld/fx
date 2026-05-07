"""
FX Discovery — discover_web.py  [ARCHITECTURE STUB — not yet in pipeline]

Web-first company discovery to complement Companies House search.

Problem with CH-only discovery:
  Companies House searches company NAMES, not trading activity.
  Most importers don't have "import" in their name.
  A UK wine importer called "Thames Valley Drinks Ltd" won't appear in a
  "wine import" CH search — but they will appear in Google/directory searches.

Intended discovery flow (web-first):
  Exposure segment (from ingest.py)
    ↓
  High-intent web search queries (from segment.high_intent_search_queries)
    ↓
  Return domain + company name from search results
    ↓
  Scrape company website — confirm FX/import/export signals
    ↓
  Companies House validation — active status, director, SIC code
    ↓
  Score and add to leads

Sources to search (in priority order):
  1. DuckDuckGo HTML search (free, no auth)
  2. Yell.com / FreeIndex / Kompass directories (UK trade directories)
  3. LinkedIn company search (manual only — do not scrape)
  4. Companies House full-text search (currently primary, move to validation role)

How to integrate into pipeline:
  - Add this script to run_pipeline.py BEFORE discover.py
  - discover_web.py writes leads.json with company_source="web_search"
  - discover.py continues to add CH-discovered companies (company_source="companies_house")
  - rescore.py processes all leads regardless of source

Status: Architecture documented. Implementation pending.
The key functions are stubbed below with clear specs.
"""

import re, time, logging, json, hashlib
from pathlib import Path
from urllib.parse import quote, urlparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)

DATA_DIR    = Path(__file__).parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.json"
LEADS_FILE  = DATA_DIR / "leads.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-GB,en;q=0.9",
}

# Domains to skip in search results — directories, news, social
SKIP_DOMAINS = {
    "yell.com", "yelp.com", "companieshouse.gov.uk", "endole.co.uk",
    "duedil.com", "crunchbase.com", "linkedin.com", "facebook.com",
    "twitter.com", "instagram.com", "youtube.com", "google.com",
    "gov.uk", "wikipedia.org", "trustpilot.com", "cylex.co.uk",
    "dnb.com", "find-and-update.company-information.service.gov.uk",
    "companies.house.gov.uk", "amazon.co.uk", "ebay.co.uk",
    "checkatrade.com", "ratedpeople.com", "bark.com",
}


# ─── STUB: DuckDuckGo search ─────────────────────────────────────────────

def ddg_search(query: str, n: int = 10) -> list:
    """
    Search DuckDuckGo HTML interface.
    Returns list of {url, title, snippet} dicts.

    Implementation:
    - GET https://duckduckgo.com/html/?q={quote(query)}
    - Parse result links with BeautifulSoup
    - Filter out SKIP_DOMAINS
    - Return up to n results

    Note: DuckDuckGo rate-limits aggressive scrapers. Add 2-3s sleep between calls.
    """
    raise NotImplementedError("Implement web-first discovery")


# ─── STUB: UK Trade Directory search ──────────────────────────────────────

def directory_search(query: str, source: str = "yell") -> list:
    """
    Search UK trade directories for businesses matching a query.

    Sources to implement:
    - Yell.com: https://www.yell.com/ucs/UcsSearchAction.do?keywords={query}
    - FreeIndex: https://www.freeindex.co.uk/search.htm?query={query}
    - Kompass UK: https://uk.kompass.com/searchCompanies?text={query}

    Returns list of {company_name, website, address, phone} dicts.
    """
    raise NotImplementedError("Implement directory search")


# ─── STUB: Validate via Companies House ───────────────────────────────────

def ch_validate(company_name: str, domain: str = None) -> dict:
    """
    Given a company name found via web search, validate via Companies House.

    Process:
    1. Search CH by company_name
    2. Find best match (fuzzy name match + domain match if available)
    3. Return company_number, status, sic_codes, officers, registered_address

    Returns None if no match found with confidence.
    """
    raise NotImplementedError("Implement CH validation")


# ─── STUB: Main web discovery loop ────────────────────────────────────────

def discover_from_web(event: dict, leads: dict) -> int:
    """
    For each high-intent search query in the event's target segments,
    search the web, scrape top results, validate via CH, score and add to leads.

    Flow:
    1. For each segment in event.target_segments:
       a. For each query in segment.high_intent_search_queries:
          - ddg_search(query)
          - For each result URL:
            * Skip if in SKIP_DOMAINS or already seen
            * Scrape website for FX signals
            * If signals found: ch_validate(company_name, domain)
            * If validated: score and add to leads with company_source="web_search"
          - Sleep 2-3s between queries

    Priority: "web_search" leads with strong FX website signals
    should score higher than CH leads with no FX website evidence.
    """
    raise NotImplementedError("Implement web discovery loop")


if __name__ == "__main__":
    log.warning("discover_web.py is an architecture stub — not yet implemented.")
    log.warning("See docstrings for implementation spec.")
    log.warning("Current discovery uses discover.py (Companies House-based).")
