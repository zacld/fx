"""
FX Discovery — discover_web.py

Web-first company discovery: search → website signals → Companies House validation.

Why this matters over CH-only discovery:
  Companies House searches company NAMES, not trading activity.
  Most importers don't have "import" in their name.
  "Thames Valley Drinks Ltd" won't appear in a "wine import" CH search —
  but they will appear in Google/DuckDuckGo results.

Discovery flow:
  High-intent search query (from segment.high_intent_search_queries)
    ↓
  DuckDuckGo HTML search → company URLs
    ↓
  Filter out directories / news / social / marketplaces
    ↓
  Scrape website (homepage + /about) — extract FX/B2B/secondary/negative signals
    ↓
  If enough signals: Companies House validation (name match, active status, SIC)
    ↓
  Score → add to leads with company_source="web_search"

Core principle: Fewer leads, more conviction.

Environment variables (all optional — safe defaults):
  WEB_DISCOVERY_ENABLED=true          Set to "false" to skip this step entirely
  WEB_MAX_EVENTS=5                    Max events to process per run
  WEB_MAX_SEGMENTS_PER_EVENT=3        Max segments per event
  WEB_MAX_QUERIES_PER_SEGMENT=3       Max search queries per segment
  WEB_MAX_RESULTS_PER_QUERY=8         Max URLs to visit per query
  WEB_REQUEST_DELAY_SECONDS=2.5       Politeness delay between requests
"""

import os, re, time, logging, json, hashlib
from pathlib import Path
from urllib.parse import quote, urlparse, parse_qs, unquote

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

DATA_DIR    = Path(__file__).parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.json"
LEADS_FILE  = DATA_DIR / "leads.json"
DATA_DIR.mkdir(exist_ok=True)

COMPANIES_HOUSE_API_KEY = os.getenv("COMPANIES_HOUSE_API_KEY", "")

# ── ENV CONTROLS ──────────────────────────────────────────────────────────────
WEB_DISCOVERY_ENABLED      = os.getenv("WEB_DISCOVERY_ENABLED", "true").lower() == "true"
WEB_MAX_EVENTS             = int(os.getenv("WEB_MAX_EVENTS", "5"))
WEB_MAX_SEGMENTS_PER_EVENT = int(os.getenv("WEB_MAX_SEGMENTS_PER_EVENT", "3"))
WEB_MAX_QUERIES_PER_SEGMENT= int(os.getenv("WEB_MAX_QUERIES_PER_SEGMENT", "3"))
WEB_MAX_RESULTS_PER_QUERY  = int(os.getenv("WEB_MAX_RESULTS_PER_QUERY", "8"))
WEB_REQUEST_DELAY          = float(os.getenv("WEB_REQUEST_DELAY_SECONDS", "2.5"))

SCRAPE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# ── DOMAINS TO SKIP ───────────────────────────────────────────────────────────
# Directories, news, social, government, marketplaces — not company websites
SKIP_DOMAINS = {
    # UK trade directories
    "yell.com", "yell.co.uk", "yelp.com", "yelp.co.uk",
    "freeindex.co.uk", "freeindex.com",
    "thomsonlocal.com", "scoot.co.uk",
    "cylex.co.uk", "cylex-uk.co.uk",
    "hotfrog.co.uk", "hotfrog.com",
    "brownbook.net", "misterwhat.co.uk",
    "kompass.com", "uk.kompass.com",
    "checkatrade.com", "ratedpeople.com", "bark.com", "rated.co.uk",
    "mybuilder.com", "trustatrader.com", "trustmark.org.uk",
    # Business intelligence / credit
    "companieshouse.gov.uk", "endole.co.uk", "duedil.com",
    "find-and-update.company-information.service.gov.uk",
    "companies.house.gov.uk", "beta.companieshouse.gov.uk",
    "creditsafe.com", "experian.co.uk", "equifax.co.uk",
    "crunchbase.com", "pitchbook.com", "dnb.com", "dnb.co.uk",
    "opencorporates.com", "companieshouse.data.gov.uk",
    "bizdb.co.uk", "companycheck.co.uk", "companydata.co.uk",
    # Social media
    "linkedin.com", "facebook.com", "instagram.com", "twitter.com",
    "x.com", "tiktok.com", "youtube.com", "pinterest.com",
    "reddit.com", "whatsapp.com", "telegram.org",
    # News / media
    "bbc.co.uk", "bbc.com", "reuters.com", "ft.com", "bloomberg.com",
    "guardian.com", "theguardian.com", "telegraph.co.uk", "thetimes.co.uk",
    "independent.co.uk", "dailymail.co.uk", "sky.com", "itv.com",
    "forbes.com", "businessinsider.com", "techcrunch.com",
    "cityam.com", "thisismoney.co.uk",
    # Government / NGO
    "gov.uk", "hmrc.gov.uk", "legislation.gov.uk", "parliament.uk",
    "nhs.uk", "acas.org.uk", "ico.org.uk", "fca.org.uk",
    # Search engines / tech
    "google.com", "google.co.uk", "bing.com", "yahoo.com",
    "duckduckgo.com", "ask.com",
    "wikipedia.org", "wikimedia.org", "wikidata.org",
    # Review sites
    "trustpilot.com", "glassdoor.com", "reviews.co.uk",
    "reevoo.com", "feefo.com", "which.co.uk",
    # Marketplaces / retail
    "amazon.co.uk", "amazon.com", "ebay.co.uk", "ebay.com",
    "etsy.com", "notonthehighstreet.com", "wayfair.co.uk",
    "asos.com", "next.co.uk", "argos.co.uk", "johnlewis.com",
    "gumtree.com", "preloved.co.uk",
    # Job boards / recruitment
    "reed.co.uk", "indeed.com", "indeed.co.uk", "totaljobs.com",
    "cv-library.co.uk", "monster.co.uk", "jobs.co.uk",
    "glassdoor.co.uk", "seek.com",
}

# ── PATH PATTERNS TO SKIP ────────────────────────────────────────────────────
# Even on otherwise OK domains, these paths are not company homepages
SKIP_PATH_PATTERNS = [
    r"/blog/", r"/news/", r"/press/", r"/article/", r"/articles/",
    r"/forum/", r"/community/", r"/wiki/", r"/help/", r"/support/",
    r"/jobs/", r"/careers/", r"/recruit",
    r"/login", r"/signup", r"/register", r"/checkout",
    r"/search\?", r"/results\?", r"/find\?",
]

# ── SIGNAL LISTS ──────────────────────────────────────────────────────────────

# High-conviction FX payment signals — company pays overseas suppliers / invoices in FX
FX_PAYMENT_SIGNALS = [
    "we import","we source","sourced from","imported from","direct from",
    "importing from","we buy from","purchased from","procured from",
    "overseas supplier","european supplier","international supplier","foreign supplier",
    "global supplier","worldwide supplier",
    "from italy","from france","from spain","from germany","from china","from usa",
    "from america","from japan","from india","from norway","from australia",
    "from new zealand","from south africa","from denmark","from netherlands",
    "italian","french","spanish","german","chinese","american","japanese",
    "foreign currency","currency risk","exchange rate","fx exposure",
    "international payments","overseas payments","currency hedging","fx risk",
    "importer","import company","import business","exclusive importer",
    "uk importer","sole importer","we distribute","import and distribute",
    "export","exports","exporting","we export","overseas customers","global customers",
    "international customers","us customers","american customers","european customers",
]

# B2B / trade signals — this is a business-to-business company, not a consumer shop
B2B_SIGNALS = [
    "wholesale","wholesaler","wholesale only","trade only","trade prices",
    "trade customers","trade enquiries","distributor","distribution",
    "minimum order","bulk order","bulk pricing","bulk discount",
    "b2b","business to business","business customers","corporate customers",
    "stockist","stockists","nationwide stockists","become a stockist",
    "reseller","resellers","agent","agents","authorised dealer",
    "contract manufacturing","own label","private label","white label",
    "we supply","we manufacture and supply","supply chain",
    "catalogue available","brochure available","price list",
    "no vat","ex vat","plus vat","+vat",
]

# Secondary signals — international / logistics activity (lower weight)
SECONDARY_SIGNALS = [
    "international","global","worldwide","overseas","distribution",
    "logistics","freight","shipping","customs","clearance",
    "europe","european","asia","asian","north america","south america",
    "supply chain","supplier","sourcing","procurement",
    "currency","forex","exchange","sterling","dollar","euro",
]

# Negative signals — strongly suggests NOT a relevant lead
NEGATIVE_SIGNALS = [
    "restaurant","cafe","coffee shop","takeaway","food delivery",
    "hair salon","nail salon","beauty salon","barber",
    "recruitment agency","job agency","staffing agency","we hire","submit your cv",
    "estate agent","letting agent","property management","rental property",
    "blog","personal blog","my thoughts","travel diary",
    "local delivery only","local area only","uk delivery only","mainland uk only",
    "dental","dentist","gp surgery","medical practice","clinic","pharmacy",
    "nursery","primary school","secondary school","sixth form","university",
    "charity","not for profit","non profit","registered charity",
    "plumber","electrician","roofer","builder","handyman","decorator",
    "personal trainer","fitness instructor","yoga","pilates","gym",
]


# ── UTILITIES ─────────────────────────────────────────────────────────────────

def now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()

def lead_id(identifier: str, event_id: str) -> str:
    return hashlib.sha256(f"web:{identifier}:{event_id}".encode()).hexdigest()[:16]

def domain_from_url(url: str) -> str | None:
    try:
        netloc = urlparse(url).netloc.lower()
        netloc = re.sub(r"^www\d*\.", "", netloc)
        return netloc if netloc else None
    except Exception:
        return None

def jaccard_similarity(a: str, b: str) -> float:
    """Token-level Jaccard similarity between two strings."""
    if not a or not b:
        return 0.0
    tok_a = set(re.findall(r"[a-z]+", a.lower()))
    tok_b = set(re.findall(r"[a-z]+", b.lower()))
    # Remove stopwords that don't help name matching
    stops = {"ltd","limited","plc","llp","uk","the","and","of","co","company","group"}
    tok_a -= stops
    tok_b -= stops
    if not tok_a or not tok_b:
        return 0.0
    return len(tok_a & tok_b) / len(tok_a | tok_b)

def name_tokens(name: str) -> set:
    """Significant tokens from a company name."""
    stops = {"ltd","limited","plc","llp","uk","the","and","of","co","company","group",
             "services","solutions","trading","enterprises","holdings"}
    return set(re.findall(r"[a-z]+", name.lower())) - stops


# ── URL FILTERING ─────────────────────────────────────────────────────────────

def should_skip_url(url: str) -> tuple[bool, str]:
    """
    Returns (skip, reason). True = skip this URL.
    Checks domain blocklist and path patterns.
    """
    if not url or not url.startswith("http"):
        return True, "not a valid http URL"

    domain = domain_from_url(url)
    if not domain:
        return True, "could not parse domain"

    # Check exact domain and parent domains (e.g. "yell.com" blocks "www.yell.com")
    for skip in SKIP_DOMAINS:
        if domain == skip or domain.endswith("." + skip):
            return True, f"skip domain: {skip}"

    parsed = urlparse(url)
    path = (parsed.path or "").lower()
    for pattern in SKIP_PATH_PATTERNS:
        if re.search(pattern, path):
            return True, f"skip path pattern: {pattern}"

    return False, ""


# ── DUCKDUCKGO SEARCH ─────────────────────────────────────────────────────────

def ddg_search(query: str, n: int = 10) -> list:
    """
    Search DuckDuckGo HTML interface.
    Returns list of {url, title, snippet} dicts, filtered by SKIP_DOMAINS.
    """
    results = []
    try:
        resp = requests.get(
            "https://duckduckgo.com/html/",
            params={"q": query},
            headers=SCRAPE_HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
    except Exception as exc:
        log.debug("DDG request failed for %r: %s", query, exc)
        return results

    soup = BeautifulSoup(resp.text, "html.parser")

    for result in soup.select(".result"):
        if len(results) >= n:
            break

        # DDG wraps result links as redirect URLs: //duckduckgo.com/l/?uddg=ENCODED_URL
        link_tag = result.select_one(".result__a")
        if not link_tag:
            continue

        href = link_tag.get("href", "")
        # Extract real URL from uddg= parameter
        if "uddg=" in href:
            try:
                # href may be protocol-relative: //duckduckgo.com/l/?uddg=...
                if href.startswith("//"):
                    href = "https:" + href
                parsed = urlparse(href)
                uddg = parse_qs(parsed.query).get("uddg", [None])[0]
                if uddg:
                    url = unquote(uddg)
                else:
                    continue
            except Exception:
                continue
        elif href.startswith("http"):
            url = href
        else:
            continue

        skip, _ = should_skip_url(url)
        if skip:
            continue

        title   = link_tag.get_text(strip=True)
        snippet_tag = result.select_one(".result__snippet")
        snippet = snippet_tag.get_text(strip=True) if snippet_tag else ""

        results.append({"url": url, "title": title, "snippet": snippet})

    log.debug("DDG %r → %d results", query[:60], len(results))
    return results


# ── WEBSITE VALIDATION ────────────────────────────────────────────────────────

def _fetch_text(url: str, timeout: int = 10) -> str:
    """Fetch a URL and return cleaned plain text. Empty string on failure."""
    try:
        resp = requests.get(url, headers=SCRAPE_HEADERS, timeout=timeout, allow_redirects=True)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script","style","nav","footer","header","meta","link"]):
            tag.decompose()
        return soup.get_text(" ", strip=True)
    except Exception as exc:
        log.debug("Fetch failed %s: %s", url, exc)
        return ""


def validate_website(url: str, name_tokens_set: set, segment_signals: list) -> dict:
    """
    Fetch homepage (and /about if homepage is sparse) and extract signals.
    Returns a validation dict with:
      fx_signals, b2b_signals, secondary_signals, negative_signals,
      segment_signals_found, snippet, name_on_page, website_confidence,
      pays_fx, is_b2b, text_length
    """
    empty = {
        "fx_signals": [], "b2b_signals": [], "secondary_signals": [],
        "negative_signals": [], "segment_signals_found": [],
        "snippet": "", "name_on_page": False,
        "website_confidence": "low", "pays_fx": False, "is_b2b": False,
        "text_length": 0,
    }
    if not url:
        return empty

    text = _fetch_text(url)

    # If homepage is sparse, also try /about
    if len(text) < 400:
        parsed = urlparse(url)
        about_url = f"{parsed.scheme}://{parsed.netloc}/about"
        about_text = _fetch_text(about_url)
        text = text + " " + about_text

    if not text.strip():
        return empty

    tlow = text.lower()
    snippet = re.sub(r"\s+", " ", text)[:800]

    fx_sigs  = sorted({s for s in FX_PAYMENT_SIGNALS if s in tlow})
    b2b_sigs = sorted({s for s in B2B_SIGNALS        if s in tlow})
    sec_sigs = sorted({s for s in SECONDARY_SIGNALS  if s in tlow})
    neg_sigs = sorted({s for s in NEGATIVE_SIGNALS   if s in tlow})
    seg_sigs = sorted({s for s in (segment_signals or []) if s.lower() in tlow})

    # Check if company name tokens appear on their own page (reduces false positives)
    words_on_page = set(re.findall(r"[a-z]+", tlow))
    name_on_page  = len(name_tokens_set & words_on_page) >= max(1, len(name_tokens_set) * 0.5)

    pays_fx = len(fx_sigs) >= 1 or len(sec_sigs) >= 3
    is_b2b  = len(b2b_sigs) >= 1

    # ── Website confidence ──
    #   high:   FX signals found AND name tokens appear on site
    #   medium: FX OR strong B2B signals (company is a trade business)
    #   low:    only secondary signals
    #   none:   no useful signals
    if fx_sigs and name_on_page:
        confidence = "high"
    elif fx_sigs or len(b2b_sigs) >= 2:
        confidence = "medium"
    elif sec_sigs or b2b_sigs:
        confidence = "low"
    else:
        confidence = "none"

    return {
        "fx_signals":             fx_sigs,
        "b2b_signals":            b2b_sigs,
        "secondary_signals":      sec_sigs,
        "negative_signals":       neg_sigs,
        "segment_signals_found":  seg_sigs,
        "snippet":                snippet,
        "name_on_page":           name_on_page,
        "website_confidence":     confidence,
        "pays_fx":                pays_fx,
        "is_b2b":                 is_b2b,
        "text_length":            len(text),
    }


# ── COMPANIES HOUSE VALIDATION ────────────────────────────────────────────────

@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=2, max=6))
def _ch_search_api(query: str, n: int = 5) -> list:
    if not COMPANIES_HOUSE_API_KEY:
        return []
    r = requests.get(
        "https://api.company-information.service.gov.uk/search/companies",
        params={"q": query, "items_per_page": n},
        auth=(COMPANIES_HOUSE_API_KEY, ""),
        timeout=15,
    )
    r.raise_for_status()
    return r.json().get("items", [])


@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=5))
def _ch_profile_api(cn: str) -> dict | None:
    if not COMPANIES_HOUSE_API_KEY:
        return None
    r = requests.get(
        f"https://api.company-information.service.gov.uk/company/{cn}",
        auth=(COMPANIES_HOUSE_API_KEY, ""),
        timeout=15,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=5))
def _ch_officers_api(cn: str) -> list:
    if not COMPANIES_HOUSE_API_KEY:
        return []
    r = requests.get(
        f"https://api.company-information.service.gov.uk/company/{cn}/officers",
        auth=(COMPANIES_HOUSE_API_KEY, ""),
        timeout=15,
    )
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return [o for o in r.json().get("items", []) if not o.get("resigned_on")]


def _extract_director(officers: list) -> dict | None:
    priority = [
        "finance-director","managing-director","chief-executive",
        "chief-financial-officer","commercial-director","director","company-secretary",
    ]
    for role in priority:
        for o in officers:
            if role in (o.get("officer_role","")).lower().replace(" ","-"):
                return _format_officer(o)
    if officers:
        return _format_officer(officers[0])
    return None


def _format_officer(o: dict) -> dict:
    name = o.get("name","")
    if "," in name:
        parts = name.split(",", 1)
        name = f"{parts[1].strip()} {parts[0].strip().title()}"
    return {"name": name.strip(), "role": o.get("officer_role","Director")}


def ch_validate(company_name: str, domain: str = None) -> dict | None:
    """
    Validate a company via Companies House.
    Returns enriched dict or None if no confident match.

    Matching strategy:
      1. Search CH by company_name
      2. Jaccard similarity ≥ 0.35 between search result name and our name
      3. Fetch full profile + officers for best match
    """
    if not COMPANIES_HOUSE_API_KEY:
        log.debug("CH validation skipped — no API key")
        return None

    try:
        items = _ch_search_api(company_name, n=5)
    except Exception as exc:
        log.debug("CH search failed for %r: %s", company_name, exc)
        return None

    if not items:
        return None

    # Find best name match
    best_item = None
    best_score = 0.0
    for item in items:
        score = jaccard_similarity(company_name, item.get("title",""))
        if score > best_score:
            best_score = score
            best_item = item

    if best_score < 0.35 or not best_item:
        log.debug("CH name match too weak for %r (best=%.2f)", company_name, best_score)
        return None

    cn = best_item.get("company_number","")
    if not cn:
        return None

    # Fetch full profile
    try:
        profile = _ch_profile_api(cn)
    except Exception as exc:
        log.debug("CH profile failed %s: %s", cn, exc)
        profile = None

    if not profile:
        return None

    status = (profile.get("company_status") or "").lower()
    if status not in ("active", ""):
        log.debug("Company %s is not active (%s)", cn, status)
        # Still return but flag it
        pass

    sic_codes = [str(s) for s in profile.get("sic_codes", [])]
    incorporated = profile.get("date_of_creation","")
    address = profile.get("registered_office_address", {})
    address_str = ", ".join(filter(None, [
        address.get("address_line_1",""),
        address.get("locality",""),
        address.get("postal_code",""),
    ]))

    # Officers
    try:
        officers = _ch_officers_api(cn)
    except Exception:
        officers = []

    director = _extract_director(officers)

    return {
        "company_number":    cn,
        "company_name":      best_item.get("title",""),
        "company_status":    status,
        "sic_codes":         sic_codes,
        "incorporated":      incorporated,
        "registered_address":address_str,
        "director_name":     director["name"] if director else None,
        "director_role":     director["role"] if director else None,
        "ch_name_match":     round(best_score, 3),
        "ch_confidence":     "high" if best_score >= 0.7 else "medium" if best_score >= 0.5 else "low",
    }


# ── SCORING ───────────────────────────────────────────────────────────────────

FX_SIC_PREFIXES = {
    "46","47","10","11","12","13","14","15","16","17","18","19",
    "20","21","22","23","24","25","26","27","28","29","30","31","32","33",
    "49","50","51","52","53",
}

def _has_fx_sic(sic_codes: list) -> bool:
    for code in sic_codes:
        clean = code.replace(" ","")
        for prefix in FX_SIC_PREFIXES:
            if clean.startswith(prefix):
                return True
    return False

EXPOSURE_LEVEL_BOOST = {"Very High": 20, "High": 12, "Medium": 6, "Low": 0}


def score_web_lead(validation: dict, ch_data: dict | None, segment: dict, event: dict) -> tuple[int, str, list]:
    """
    Web-specific lead scoring.
    Returns (score, priority, reasons).
    """
    score   = 0
    reasons = []
    fx_sigs  = validation.get("fx_signals", [])
    b2b_sigs = validation.get("b2b_signals", [])
    sec_sigs = validation.get("secondary_signals", [])
    neg_sigs = validation.get("negative_signals", [])
    seg_sigs = validation.get("segment_signals_found", [])
    conf     = validation.get("website_confidence", "none")

    # 1. Website confidence (+10 / +20 / +30)
    if conf == "high":
        score += 30
        reasons.append("Website verified — strong FX signal match with name on page (+30)")
    elif conf == "medium":
        score += 20
        reasons.append("Website shows FX/trade signals — medium confidence (+20)")
    elif conf == "low":
        score += 10
        reasons.append("Website shows weak trade signals (+10)")
    else:
        score -= 10
        reasons.append("No useful website signals (−10)")

    # 2. FX payment signals (+3 each, max 25)
    if fx_sigs:
        s = min(25, len(fx_sigs) * 3)
        score += s
        reasons.append(f"Direct FX payment signals: {', '.join(fx_sigs[:3])} (+{s})")

    # 3. B2B signals (+2 each, max 12)
    if b2b_sigs:
        s = min(12, len(b2b_sigs) * 2)
        score += s
        reasons.append(f"B2B/trade signals: {', '.join(b2b_sigs[:3])} (+{s})")

    # 4. Secondary signals (+1 each, max 8)
    if sec_sigs:
        s = min(8, len(sec_sigs))
        score += s
        reasons.append(f"International activity signals: {len(sec_sigs)} found (+{s})")

    # 5. Segment-specific signals (+4 each, max 12)
    if seg_sigs:
        s = min(12, len(seg_sigs) * 4)
        score += s
        reasons.append(f"Segment-specific signals: {', '.join(seg_sigs[:2])} (+{s})")

    # 6. Negative signals (−5 each, floor at 0 for this component)
    if neg_sigs:
        s = min(score, len(neg_sigs) * 5)
        score -= s
        reasons.append(f"⚠ Negative signals: {', '.join(neg_sigs[:2])} (−{s})")

    # 7. Exposure level boost (from segment)
    exp_level = segment.get("exposure_level", "")
    exp_boost = EXPOSURE_LEVEL_BOOST.get(exp_level, 0)
    if exp_boost:
        score += exp_boost
        reasons.append(f"Segment exposure: {exp_level} (+{exp_boost})")

    # 8. Companies House validation
    if ch_data:
        status = ch_data.get("company_status","")
        if status == "active":
            score += 15
            reasons.append(f"Active on Companies House (+15)")
        else:
            score += 5
            reasons.append(f"Found on Companies House — status: {status} (+5)")

        if _has_fx_sic(ch_data.get("sic_codes",[])):
            score += 10
            reasons.append(f"FX-relevant SIC code: {', '.join(ch_data.get('sic_codes',[])[:2])} (+10)")

        if ch_data.get("director_name"):
            score += 5
            reasons.append(f"Director found: {ch_data['director_name']} (+5)")
    else:
        score -= 5
        reasons.append("Not validated on Companies House (−5)")

    score = max(0, min(score, 100))

    # Hard gate: no FX/B2B evidence at all → cap at SKIP
    has_evidence = fx_sigs or len(b2b_sigs) >= 2 or len(sec_sigs) >= 3
    if not has_evidence:
        score = min(score, 39)
        reasons.append("⚠ Insufficient trade evidence — capped at SKIP threshold")

    if   score >= 80: priority = "HOT"
    elif score >= 60: priority = "WARM"
    elif score >= 40: priority = "QUEUE"
    else:             priority = "SKIP"

    return score, priority, reasons


# ── EXPOSURE THESIS ───────────────────────────────────────────────────────────

def build_exposure_thesis(
    company_name: str,
    domain: str,
    validation: dict,
    ch_data: dict | None,
    segment: dict,
    event: dict,
) -> str:
    """
    Build a specific, evidence-backed exposure thesis for this company.
    Uses segment template + website evidence rather than generic text.
    """
    fx_sigs  = validation.get("fx_signals", [])
    b2b_sigs = validation.get("b2b_signals", [])
    sec_sigs = validation.get("secondary_signals", [])
    seg_name = segment.get("segment_name", "")
    why_exposed = segment.get("why_financially_exposed", "")
    fx_logic    = segment.get("fx_payment_logic", "")
    margin_risk = segment.get("margin_risk", "")

    parts = []

    # Lead with segment thesis
    if why_exposed:
        parts.append(why_exposed)

    # Add website evidence
    if fx_sigs:
        sample = fx_sigs[:2]
        parts.append(f"Website signals confirm: {', '.join(sample)}.")
    elif b2b_sigs:
        parts.append(f"B2B trade signals found: {', '.join(b2b_sigs[:2])}.")

    # Add event linkage
    event_headline = event.get("headline", event.get("title", ""))
    if event_headline:
        parts.append(f"This company is likely affected by: {event_headline}.")

    # Add FX payment logic from segment
    if fx_logic:
        parts.append(fx_logic)

    # Add margin risk
    if margin_risk:
        parts.append(f"Risk: {margin_risk}")

    return " ".join(parts) if parts else f"{company_name} ({domain}) — identified as FX-exposed via web discovery."


# ── LEAD CREATION ─────────────────────────────────────────────────────────────

def create_lead(
    url: str,
    domain: str,
    search_title: str,
    validation: dict,
    ch_data: dict | None,
    segment: dict,
    event: dict,
    event_id: str,
    score: int,
    priority: str,
    reasons: list,
) -> tuple[str, dict]:
    """
    Create a lead dict compatible with the existing leads.json format.
    Returns (lead_id, lead_dict).
    """
    # Prefer CH-verified name, fall back to search title
    company_name = (ch_data or {}).get("company_name") or search_title or domain

    # Derive a stable ID from domain + event_id
    lid = lead_id(domain, event_id)

    thesis = build_exposure_thesis(
        company_name, domain, validation, ch_data, segment, event
    )

    seg_sigs = validation.get("segment_signals_found", [])

    lead = {
        # ── Identity ──
        "company_name":       company_name,
        "company_number":     (ch_data or {}).get("company_number"),
        "company_status":     (ch_data or {}).get("company_status", "unknown"),
        "company_source":     "web_search",
        "sic_codes":          (ch_data or {}).get("sic_codes", []),
        "incorporated":       (ch_data or {}).get("incorporated"),
        "registered_address": (ch_data or {}).get("registered_address"),
        # ── Contact ──
        "director_name":      (ch_data or {}).get("director_name"),
        "director_role":      (ch_data or {}).get("director_role"),
        # ── Website ──
        "website":            url,
        "website_domain":     domain,
        "website_confidence": validation.get("website_confidence", "low"),
        "website_source":     "ddg_search",
        "website_snippet":    validation.get("snippet","")[:400],
        # ── FX signals ──
        "fx_payment_signals": validation.get("fx_signals", []),
        "b2b_signals":        validation.get("b2b_signals", []),
        "secondary_signals":  validation.get("secondary_signals", []),
        "segment_signals":    seg_sigs,
        "pays_fx_confirmed":  validation.get("pays_fx", False),
        "signal_count":       (
            len(validation.get("fx_signals",[]))
            + len(validation.get("b2b_signals",[]))
            + len(validation.get("secondary_signals",[]))
        ),
        # ── Scoring ──
        "score":              score,
        "priority":           priority,
        "scoring_reasons":    reasons,
        # ── Exposure ──
        "event_id":           event_id,
        "event_headline":     event.get("headline", event.get("title","")),
        "segment_name":       segment.get("segment_name",""),
        "segment_business_model": segment.get("business_model",""),
        "exposure_level":     segment.get("exposure_level",""),
        "exposure_type":      segment.get("exposure_type",""),
        "exposure_confidence":_compute_exposure_confidence(validation, segment),
        "why_affected":       thesis,
        "why_financially_exposed": segment.get("why_financially_exposed",""),
        "fx_payment_logic":   segment.get("fx_payment_logic",""),
        "margin_risk":        segment.get("margin_risk",""),
        "payment_timing_risk":segment.get("payment_timing_risk",""),
        "affected_payment_flow":segment.get("affected_payment_flow",""),
        "business_impact_summary":event.get("business_impact_summary",""),
        "trigger_headline":   event.get("trigger_headline",""),
        # ── Validation ──
        "ch_name_match":      (ch_data or {}).get("ch_name_match"),
        "ch_confidence":      (ch_data or {}).get("ch_confidence"),
        # ── Metadata ──
        "discovered_at":      now_iso(),
        "rescored_at":        now_iso(),
        "multi_event_trigger":False,
        "multi_event_count":  1,
        "guessed_emails":     [],   # populated by rescore.py
        "linkedin_url":       None,
        "call_opener":        None,
        "email_draft":        None,
        "outreach_status":    "new",
    }

    return lid, lead


def _compute_exposure_confidence(validation: dict, segment: dict) -> str:
    """Derive exposure_confidence from website evidence + segment."""
    fx_sigs  = validation.get("fx_signals", [])
    b2b_sigs = validation.get("b2b_signals", [])
    sec_sigs = validation.get("secondary_signals", [])
    wc       = validation.get("website_confidence","none")
    exp_lvl  = segment.get("exposure_level","")
    pays_fx  = validation.get("pays_fx", False)

    evidence = 0
    if pays_fx:                          evidence += 3
    if len(fx_sigs) >= 2:                evidence += 3
    elif len(fx_sigs) == 1:              evidence += 2
    if len(b2b_sigs) >= 2:               evidence += 1
    if len(sec_sigs) >= 3:               evidence += 1
    if wc == "high":                     evidence += 2
    elif wc in ("medium","confirmed"):   evidence += 1
    if exp_lvl == "Very High":           evidence += 2
    elif exp_lvl == "High":              evidence += 1

    if evidence >= 7: return "high"
    if evidence >= 4: return "medium"
    if evidence >= 1: return "low"
    return "none"


# ── EVENT PROCESSING ──────────────────────────────────────────────────────────

def process_event(event: dict, event_id: str, leads: dict, stats: dict) -> int:
    """
    Process one event: for each segment, run DDG search queries, validate results,
    score and add to leads. Returns count of new leads added.
    """
    added   = 0
    segments = event.get("target_segments", [])[:WEB_MAX_SEGMENTS_PER_EVENT]

    if not segments:
        log.info("  No target segments — skipping")
        return 0

    # Build index of domains and company numbers already in leads
    domain_index = {}
    cn_index     = {}
    for lid, lead in leads.items():
        d = lead.get("website_domain") or domain_from_url(lead.get("website",""))
        if d:
            domain_index[d] = lid
        cn = lead.get("company_number")
        if cn:
            if cn not in cn_index:
                cn_index[cn] = []
            cn_index[cn].append(lid)

    seen_domains_this_event: set = set()

    for seg in segments:
        seg_name = seg.get("segment_name","(unnamed)")
        queries  = seg.get("high_intent_search_queries", [])[:WEB_MAX_QUERIES_PER_SEGMENT]
        seg_signals = seg.get("segment_signals", [])

        if not queries:
            log.info("    Segment %r — no search queries", seg_name[:40])
            continue

        log.info("    Segment: %s (%d queries)", seg_name[:50], len(queries))

        for query in queries:
            log.info("      Query: %s", query[:70])
            stats["queries_run"] += 1

            results = ddg_search(query, n=WEB_MAX_RESULTS_PER_QUERY)
            time.sleep(WEB_REQUEST_DELAY)

            for result in results:
                url   = result["url"]
                title = result.get("title","")
                domain = domain_from_url(url)

                if not domain:
                    stats["rejected_no_domain"] += 1
                    continue

                # Skip if we've already seen this domain for this event
                if domain in seen_domains_this_event:
                    stats["rejected_duplicate"] += 1
                    continue

                # Skip if already a known lead for this event (same domain + event)
                existing_lid = domain_index.get(domain)
                if existing_lid and leads[existing_lid].get("event_id") == event_id:
                    stats["rejected_duplicate"] += 1
                    seen_domains_this_event.add(domain)
                    continue

                seen_domains_this_event.add(domain)

                # ── Validate website ──
                log.debug("      Validating %s", url)
                name_tok = name_tokens(title)
                val = validate_website(url, name_tok, seg_signals)
                time.sleep(WEB_REQUEST_DELAY * 0.4)  # shorter delay for secondary fetches

                # Reject if negative signals dominate
                neg = val.get("negative_signals", [])
                fx  = val.get("fx_signals", [])
                b2b = val.get("b2b_signals", [])
                if len(neg) > len(fx) + len(b2b):
                    log.debug("        Rejected (negative signals): %s", url)
                    stats["rejected_negative"] += 1
                    continue

                # Reject if no signals at all
                if not fx and not b2b and len(val.get("secondary_signals",[])) < 2:
                    log.debug("        Rejected (no signals): %s", url)
                    stats["rejected_no_signals"] += 1
                    continue

                conf = val.get("website_confidence","none")
                stats[f"confidence_{conf}"] = stats.get(f"confidence_{conf}", 0) + 1

                # ── Companies House validation ──
                ch_data = None
                if conf in ("high","medium"):
                    log.debug("        CH validate: %s", title[:50])
                    ch_data = ch_validate(title, domain)
                    time.sleep(WEB_REQUEST_DELAY * 0.6)

                    # If we have a CH company number, check if already in leads for another event
                    # (multi-event trigger — boost existing lead rather than duplicate)
                    if ch_data and ch_data.get("company_number"):
                        cn = ch_data["company_number"]
                        if cn in cn_index:
                            # Update existing leads with multi-event flag
                            for existing_lid in cn_index[cn]:
                                existing_lead = leads[existing_lid]
                                if existing_lead.get("event_id") != event_id:
                                    prev_count = existing_lead.get("multi_event_count", 1)
                                    existing_lead["multi_event_trigger"] = True
                                    existing_lead["multi_event_count"]   = prev_count + 1
                                    boost = min(8, prev_count * 4)
                                    existing_lead["score"] = min(100, existing_lead.get("score",0) + boost)
                                    old_s = existing_lead["score"]
                                    existing_lead["scoring_reasons"].append(
                                        f"Multi-event trigger: also exposed via '{event.get('headline','')}' (+{boost})"
                                    )
                                    s = existing_lead["score"]
                                    existing_lead["priority"] = (
                                        "HOT" if s>=80 else "WARM" if s>=60 else "QUEUE" if s>=40 else "SKIP"
                                    )
                                    log.info("        ↑ Multi-event boost for %s (+%d)",
                                             existing_lead.get("company_name","")[:40], boost)
                                    stats["multi_event_updates"] = stats.get("multi_event_updates",0) + 1

                # ── Score ──
                s, priority, reasons = score_web_lead(val, ch_data, seg, event)

                if priority == "SKIP":
                    log.debug("        Scored SKIP (%d) — not adding: %s", s, url)
                    stats["rejected_low_score"] += 1
                    continue

                # ── Create lead ──
                lid, lead = create_lead(
                    url=url, domain=domain, search_title=title,
                    validation=val, ch_data=ch_data,
                    segment=seg, event=event, event_id=event_id,
                    score=s, priority=priority, reasons=reasons,
                )

                # Update domain/cn indices
                domain_index[domain] = lid
                if ch_data and ch_data.get("company_number"):
                    cn = ch_data["company_number"]
                    cn_index.setdefault(cn,[]).append(lid)

                leads[lid] = lead
                added += 1

                stats[f"priority_{priority}"] = stats.get(f"priority_{priority}",0) + 1
                log.info("        ✓ [%s %d] %s — %s", priority, s,
                         lead["company_name"][:40], domain)

    return added


# ── QUALITY SUMMARY ───────────────────────────────────────────────────────────

def print_quality_summary(stats: dict, leads: dict):
    """Log a quality summary table after web discovery."""
    total = stats.get("urls_visited", 0)
    added = stats.get("leads_added", 0)

    log.info("")
    log.info("══════════════════════════════════════════")
    log.info("  Web Discovery Quality Summary")
    log.info("══════════════════════════════════════════")
    log.info("  Queries run:          %d", stats.get("queries_run",0))
    log.info("  URLs visited:         %d", total)
    log.info("  Rejected (duplicate): %d", stats.get("rejected_duplicate",0))
    log.info("  Rejected (negative):  %d", stats.get("rejected_negative",0))
    log.info("  Rejected (no signal): %d", stats.get("rejected_no_signals",0))
    log.info("  Rejected (low score): %d", stats.get("rejected_low_score",0))
    log.info("  Multi-event updates:  %d", stats.get("multi_event_updates",0))
    log.info("  ──────────────────────────────────────")
    log.info("  Confidence — high:   %d", stats.get("confidence_high",0))
    log.info("  Confidence — medium: %d", stats.get("confidence_medium",0))
    log.info("  Confidence — low:    %d", stats.get("confidence_low",0))
    log.info("  ──────────────────────────────────────")
    log.info("  HOT leads added:  %d", stats.get("priority_HOT",0))
    log.info("  WARM leads added: %d", stats.get("priority_WARM",0))
    log.info("  QUEUE leads added:%d", stats.get("priority_QUEUE",0))
    log.info("  Total leads added: %d", added)
    log.info("══════════════════════════════════════════")

    # Top 10 web leads by score
    web_leads = sorted(
        [(lid, v) for lid, v in leads.items() if v.get("company_source") == "web_search"],
        key=lambda x: x[1].get("score",0),
        reverse=True,
    )[:10]

    if web_leads:
        log.info("")
        log.info("  Top web leads:")
        for lid, lead in web_leads:
            log.info("    [%s %d] %s — %s",
                     lead.get("priority","?"),
                     lead.get("score",0),
                     lead.get("company_name","")[:35],
                     lead.get("website_domain",""))
    log.info("")


# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    if not WEB_DISCOVERY_ENABLED:
        log.info("Web discovery disabled (WEB_DISCOVERY_ENABLED=false) — skipping")
        return

    if not COMPANIES_HOUSE_API_KEY:
        log.warning("COMPANIES_HOUSE_API_KEY not set — CH validation will be skipped")

    log.info("=== Web-First Discovery ===")
    log.info("Config: max_events=%d  max_segments=%d  max_queries=%d  max_results=%d  delay=%.1fs",
             WEB_MAX_EVENTS, WEB_MAX_SEGMENTS_PER_EVENT,
             WEB_MAX_QUERIES_PER_SEGMENT, WEB_MAX_RESULTS_PER_QUERY, WEB_REQUEST_DELAY)

    # Load data
    events = json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
    leads  = json.loads(LEADS_FILE.read_text())  if LEADS_FILE.exists()  else {}

    if not events:
        log.warning("No events found in %s", EVENTS_FILE)
        return

    # Select events to process — prefer those not yet web-discovered,
    # fall back to all events up to WEB_MAX_EVENTS
    ready_events = {
        eid: ev for eid, ev in events.items()
        if ev.get("target_segments") and not ev.get("web_discovery_done")
    }
    if not ready_events:
        # Re-process all events if all already done
        ready_events = {
            eid: ev for eid, ev in events.items()
            if ev.get("target_segments")
        }

    ready_events = dict(list(ready_events.items())[:WEB_MAX_EVENTS])
    log.info("Events to process: %d / %d", len(ready_events), len(events))

    stats = {
        "queries_run": 0,
        "urls_visited": 0,
        "rejected_duplicate": 0,
        "rejected_negative": 0,
        "rejected_no_signals": 0,
        "rejected_no_domain": 0,
        "rejected_low_score": 0,
        "leads_added": 0,
    }

    for event_id, event in ready_events.items():
        headline = event.get("headline", event.get("title",""))[:60]
        log.info("")
        log.info("── Event: %s", headline)

        new_count = process_event(event, event_id, leads, stats)
        stats["leads_added"] += new_count

        # Mark as web-discovered so we don't re-run unless forced
        events[event_id]["web_discovery_done"] = True
        events[event_id]["web_discovery_at"]   = now_iso()

        log.info("  Event complete — %d leads added", new_count)

        # Save incrementally after each event
        LEADS_FILE.write_text(json.dumps(leads, indent=2, default=str))
        EVENTS_FILE.write_text(json.dumps(events, indent=2, default=str))

    # Final save + sync to public/data/
    LEADS_FILE.write_text(json.dumps(leads, indent=2, default=str))
    EVENTS_FILE.write_text(json.dumps(events, indent=2, default=str))

    public = Path(__file__).parent.parent / "public" / "data"
    public.mkdir(parents=True, exist_ok=True)
    (public / "leads.json").write_text(LEADS_FILE.read_text())

    print_quality_summary(stats, leads)
    log.info("=== Web discovery complete — %d leads added, %d total in pipeline ===",
             stats["leads_added"], len(leads))


if __name__ == "__main__":
    main()
