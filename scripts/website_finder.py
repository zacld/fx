"""
website_finder.py — Domain-guessing website discovery without paid APIs.

Strategy:
1. Strip legal suffixes from company name
2. Generate domain candidates (.co.uk preferred for UK companies)
3. Verify with GET (not HEAD — many servers block HEAD)
4. Score by: loads + company tokens in title/body + not parked + TLD preference
5. Return best candidate above threshold; fallback to DuckDuckGo
"""

import re, logging
from urllib.parse import urlparse, quote

import requests
from bs4 import BeautifulSoup

log = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}

_LEGAL_STRIP = re.compile(
    r"""
    \s*
    (
      \bltd\.?$       | \blimited\.?$  | \bplc\.?$     |
      \bllp\.?$       | \blp\.?$       | \binc\.?$     |
      \bcorp\.?$      | \bcorporation$ | \bholdings?$  |
      \bgroup$        | \buk$          | \b&\s*co\.?$  |
      \bco\.?$
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Geographic qualifiers that clutter domain generation
_GEO_STRIP = re.compile(
    r"""
    \s*
    (
      \buk\s*&\s*ireland\b  |   # UK & Ireland
      \b&\s*ireland\b       |   # & Ireland
      \buk\s*limited\b      |   # UK Limited
      \buk\s*ltd\b          |   # UK Ltd
      \(uk\)                |   # (UK)
      \(holdings?\)         |   # (Holdings)
      \(wholesale\)         |   # (Wholesale)
      \(trading\)           |   # (Trading)
      \(international\)         # (International)
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)

PARKED_SIGNALS = [
    "domain for sale", "buy this domain", "this domain is for sale",
    "parked by", "sedo.com", "dan.com", "undeveloped.com",
    "godaddy", "register your domain", "website coming soon",
    "website under construction", "just another wordpress site",
]

SKIP_DOMAINS = {
    "yell.com", "yelp.com", "companieshouse.gov.uk", "endole.co.uk",
    "duedil.com", "crunchbase.com", "linkedin.com", "facebook.com",
    "twitter.com", "instagram.com", "youtube.com", "google.com",
    "gov.uk", "wikipedia.org", "trustpilot.com", "cylex.co.uk",
    "dnb.com", "find-and-update.company-information.service.gov.uk",
    "companies.house.gov.uk",
}


def clean_for_domain(company_name: str) -> list:
    """Strip legal suffixes, geographic qualifiers, return word list for domains."""
    n = company_name.strip()
    # Strip geographic qualifiers first (UK & Ireland, (UK), etc.)
    n = _GEO_STRIP.sub("", n).strip()
    # Strip legal suffixes repeatedly (handles "& Co Ltd")
    for _ in range(4):
        prev = n
        n = _LEGAL_STRIP.sub("", n).strip().rstrip(".,&-")
        if n == prev:
            break
    n = re.sub(r"[^\w\s]", " ", n)
    stopwords = {"and", "the", "of", "for", "&", "uk", "ireland"}
    return [w for w in n.split() if w.lower() not in stopwords]


def generate_domain_candidates(words: list) -> list:
    """Return (domain_with_tld, tld_preference) in priority order.

    Prioritised .co.uk first, limited to top candidates to keep
    the request count reasonable (~10 max per company).
    """
    if not words:
        return []

    variants = []
    joined = "".join(w.lower() for w in words)
    variants.append(joined)

    if len(words) >= 2:
        variants.append("".join(w.lower() for w in words[:2]))
        variants.append("-".join(w.lower() for w in words[:2]))

    if len(words) >= 3:
        variants.append("".join(w.lower() for w in words[:3]))
        variants.append("-".join(w.lower() for w in words[:3]))

    if len(words) > 3:
        variants.append("-".join(w.lower() for w in words))

    seen = set()
    candidates = []
    for v in variants:
        if v in seen or len(v) < 3:
            continue
        seen.add(v)
        candidates.append((v + ".co.uk", 1.3))
        candidates.append((v + ".com",   1.0))

    # .net and .org.uk only for the single most-likely variant
    if variants:
        v = variants[0]
        candidates.append((v + ".net",    0.8))
        candidates.append((v + ".org.uk", 0.7))

    return candidates


def _is_parked(title: str, body: str) -> bool:
    combined = (title + " " + body[:800]).lower()
    return any(sig in combined for sig in PARKED_SIGNALS)


def _match_score(title: str, body: str, tokens: list) -> int:
    t_hits = sum(1 for t in tokens if t in title.lower())
    b_hits  = sum(1 for t in tokens if t in body.lower()[:4000])
    score = 0
    if t_hits >= 2:   score += 30
    elif t_hits >= 1: score += 18
    if b_hits >= 2:   score += 12
    elif b_hits >= 1: score +=  6
    return score


def _fetch_and_score(url: str, tokens: list) -> tuple:
    """
    GET url, return (final_url, raw_score, is_parked).
    raw_score -1 means parked; 0 means failed/blocked.
    """
    try:
        resp = requests.get(url, headers=HEADERS, timeout=6, allow_redirects=True)
        if resp.status_code not in (200, 301, 302):
            return None, 0, False

        final        = resp.url
        req_domain   = urlparse(url).netloc.lower().replace("www.", "")
        final_domain = urlparse(final).netloc.lower().replace("www.", "")
        if any(s in final_domain for s in SKIP_DOMAINS):
            return None, 0, False
        # Cross-domain redirect with no company token = parking/redirect service
        if final_domain != req_domain and not any(t in final_domain for t in tokens):
            return None, -1, True

        try:
            soup  = BeautifulSoup(resp.text, "html.parser")
            title = (soup.title.string or "") if soup.title else ""
            body  = soup.get_text(" ", strip=True)
        except Exception:
            title, body = "", ""

        if _is_parked(title, body):
            return final, -1, True

        score = 10  # base: loaded
        if ".co.uk" in url:
            score += 10
        score += _match_score(title, body, tokens)
        return final, score, False

    except (requests.exceptions.ConnectionError,
            requests.exceptions.Timeout,
            requests.exceptions.TooManyRedirects):
        return None, 0, False
    except Exception as exc:
        log.debug("fetch error %s: %s", url, exc)
        return None, 0, False


def find_website_guess(company_name: str, company_number: str = None) -> tuple:
    """
    Guess and verify a company website from its name.

    Returns (url, confidence, source):
      confidence: "high" | "medium" | "low"
      source:     "domain_guess" | "ddg_search"
    Returns (None, None, None) if nothing found above threshold.
    """
    words = clean_for_domain(company_name)
    if not words:
        return None, None, None

    tokens = [w.lower() for w in words if len(w) > 2]
    candidates = generate_domain_candidates(words)

    best_url, best_score, best_conf = None, 0.0, None

    for domain, tld_pref in candidates:
        for scheme in ("https://", "http://"):
            url = f"{scheme}www.{domain}"
            final, raw, parked = _fetch_and_score(url, tokens)
            if parked:
                break  # both schemes will be parked
            if final and raw > 0:
                adjusted = raw * tld_pref
                if adjusted > best_score:
                    best_score = adjusted
                    best_url   = final
                    if   raw >= 45: best_conf = "high"
                    elif raw >= 25: best_conf = "medium"
                    else:           best_conf = "low"
                if best_conf == "high":
                    log.debug("High-confidence hit early exit: %s → %s", company_name, final)
                    return best_url, best_conf, "domain_guess"
                break  # https worked, skip http

    THRESHOLD = 22
    if best_url and best_score >= THRESHOLD:
        log.debug("Domain guess: %s → %s (%s, %.1f)", company_name, best_url, best_conf, best_score)
        return best_url, best_conf, "domain_guess"

    return _ddg_fallback(company_name)


def _ddg_fallback(company_name: str) -> tuple:
    """DuckDuckGo HTML search as last resort."""
    words  = clean_for_domain(company_name)
    tokens = {w.lower() for w in words if len(w) > 3}

    try:
        query = f'"{company_name}" official website'
        url   = f"https://duckduckgo.com/html/?q={quote(query)}"
        resp  = requests.get(url, headers=HEADERS, timeout=10)
        if resp.status_code != 200:
            return None, None, None

        soup = BeautifulSoup(resp.text, "html.parser")
        for el in soup.select("a.result__url, .result__extras__url, .result__url"):
            href = el.get("href", "") or el.get_text("").strip()
            if not href:
                continue
            if not href.startswith("http"):
                href = "https://" + href.lstrip("/")
            try:
                domain = urlparse(href).netloc.lower().replace("www.", "")
            except Exception:
                continue
            if not domain or any(s in domain for s in SKIP_DOMAINS):
                continue
            # Require at least one company token to appear in the domain
            if tokens and not any(t in domain for t in tokens):
                continue
            log.debug("DDG fallback: %s → %s", company_name, href)
            return href, "low", "ddg_search"

    except Exception as exc:
        log.debug("DDG failed for %s: %s", company_name, exc)

    return None, None, None
