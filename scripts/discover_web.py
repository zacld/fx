"""
FX Discovery — discover_web.py

Web-first company discovery: search → website signals → Companies House validation.

Why this matters over CH-only discovery:
  Companies House searches company NAMES, not trading activity.
  Most importers don't have "import" in their name.
  "Thames Valley Drinks Ltd" won't appear in a CH "wine import" search —
  but they will appear in DuckDuckGo results for "wine importer UK".

Discovery flow:
  High-intent search query (from segment.high_intent_search_queries)
    ↓
  DuckDuckGo HTML search → company URLs
  (Fallback → Companies House keyword search when DDG yields nothing)
    ↓
  Filter out directories / news / social / marketplaces / aggregators
    ↓
  Scrape website (homepage + /about) — extract FX/B2B/secondary/negative signals
    ↓
  Reject if domain-name coherence fails or page is a multi-company directory
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
  WEB_REQUEST_DELAY_SECONDS=3.0       Politeness delay between DDG requests
"""

import os, re, time, random, logging, json, hashlib
from datetime import datetime, timezone
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
WEB_DISCOVERY_ENABLED                = os.getenv("WEB_DISCOVERY_ENABLED", "true").lower() == "true"
WEB_MAX_EVENTS                       = int(os.getenv("WEB_MAX_EVENTS", "5"))
WEB_MAX_SEGMENTS_PER_EVENT           = int(os.getenv("WEB_MAX_SEGMENTS_PER_EVENT", "3"))
WEB_MAX_MICRO_CATEGORIES_PER_SEGMENT = int(os.getenv("WEB_MAX_MICRO_CATEGORIES_PER_SEGMENT", "3"))
WEB_MAX_QUERIES_PER_MICRO_CATEGORY   = int(os.getenv("WEB_MAX_QUERIES_PER_MICRO_CATEGORY", "2"))
WEB_MAX_QUERIES_PER_SEGMENT          = int(os.getenv("WEB_MAX_QUERIES_PER_SEGMENT", "3"))
WEB_MAX_RESULTS_PER_QUERY            = int(os.getenv("WEB_MAX_RESULTS_PER_QUERY", "5"))
WEB_REQUEST_DELAY                    = float(os.getenv("WEB_REQUEST_DELAY_SECONDS", "3.0"))
# Category Priority Engine (Brain 1 scores each segment 0-100; Brain 2 only scrapes above threshold)
WEB_MAX_CATEGORIES_TO_SCRAPE         = int(os.getenv("WEB_MAX_CATEGORIES_TO_SCRAPE", "6"))
CATEGORY_MIN_SCORE_TO_SCRAPE         = int(os.getenv("CATEGORY_MIN_SCORE_TO_SCRAPE", "65"))

# Rotate user-agents to reduce fingerprinting
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
]


def _headers(referer: str = "") -> dict:
    return {
        "User-Agent":      random.choice(_USER_AGENTS),
        "Accept-Language": "en-GB,en;q=0.9",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        **({"Referer": referer} if referer else {}),
    }


# ── DOMAINS/PATTERNS TO SKIP ──────────────────────────────────────────────────
# Comprehensive blocklist — directories, news, social, gov, marketplaces, aggregators

SKIP_DOMAINS = {
    # ── UK trade directories / business listings ─────────────────────────────
    "yell.com", "yell.co.uk",
    "yelp.com", "yelp.co.uk",
    "freeindex.co.uk",
    "thomsonlocal.com",
    "scoot.co.uk",
    "cylex.co.uk", "cylex-uk.co.uk",
    "hotfrog.co.uk",
    "brownbook.net",
    "misterwhat.co.uk",
    "kompass.com", "uk.kompass.com",
    "checkatrade.com",
    "ratedpeople.com",
    "bark.com",
    "rated.co.uk",
    "mybuilder.com",
    "trustatrader.com",
    "trustmark.org.uk",
    "getapp.co.uk",
    "bizwiki.co.uk",
    "192.com",
    "ukbusinessdirectory.co.uk",

    # ── Company intelligence / aggregators / registries ───────────────────────
    "companieshouse.gov.uk",
    "find-and-update.company-information.service.gov.uk",
    "companies.house.gov.uk",
    "beta.companieshouse.gov.uk",
    "endole.co.uk",
    "duedil.com",
    "creditsafe.com",
    "experian.co.uk",
    "equifax.co.uk",
    "crunchbase.com",
    "pitchbook.com",
    "dnb.com", "dnb.co.uk",
    "opencorporates.com",
    "companieshouse.data.gov.uk",
    "bizdb.co.uk",
    "companycheck.co.uk",
    "companydata.co.uk",
    "bizbuysell.com",
    "globaldata.com",
    "ibisworld.com",
    "statista.com",
    "marketresearch.com",
    "mordorintelligence.com",
    "grandviewresearch.com",

    # ── Industry-specific aggregators / chemical directories ──────────────────
    "chemeurope.com",        # chemical industry directory
    "grokipedia.com",        # wiki/aggregator
    "ensun.io",              # company aggregator
    "europages.co.uk",       # European business directory
    "europages.com",
    "thomasnet.com",         # industrial components directory
    "alibaba.com",           # marketplace
    "made-in-china.com",
    "globalsources.com",
    "tradekey.com",
    "eceurope.com",
    "chemspider.com",        # chemical database
    "sigmaaldrich.com",      # chemical supplier database
    "icis.com",              # chemical market data
    "chemanalyst.com",
    "cheminfo.com",
    "chemidplus.nlm.nih.gov",
    "lookchem.com",
    "molbase.com",

    # ── Social media ─────────────────────────────────────────────────────────
    "linkedin.com",
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "youtube.com",
    "pinterest.com",
    "reddit.com",
    "whatsapp.com",
    "telegram.org",

    # ── News / media ─────────────────────────────────────────────────────────
    "bbc.co.uk", "bbc.com",
    "reuters.com",
    "ft.com",
    "bloomberg.com",
    "guardian.com", "theguardian.com",
    "telegraph.co.uk",
    "thetimes.co.uk",
    "independent.co.uk",
    "dailymail.co.uk",
    "sky.com",
    "itv.com",
    "forbes.com",
    "businessinsider.com",
    "techcrunch.com",
    "cityam.com",
    "thisismoney.co.uk",
    "thegrocer.co.uk",
    "foodmanufacture.co.uk",
    "just-drinks.com",
    "thedrinksbusiness.com",
    "decanter.com",
    "harpers.co.uk",
    "foodnavigator.com",
    "seafoodsource.com",
    "undercurrentnews.com",
    "chemweek.com",
    "icis.com",

    # ── Government / NGO / Trade associations ────────────────────────────────
    "gov.uk",
    "hmrc.gov.uk",
    "legislation.gov.uk",
    "parliament.uk",
    "nhs.uk",
    "acas.org.uk",
    "ico.org.uk",
    "fca.org.uk",
    "cma.gov.uk",
    "food.gov.uk",
    "wsta.co.uk",          # Wine and Spirit Trade Association
    "scotchwhisky.com",    # Scotch Whisky Association (editorial)
    "swa.org.uk",
    "fdf.org.uk",
    "seafish.org",
    "cefic.org",           # European Chemical Industry Council

    # ── Search / tech ────────────────────────────────────────────────────────
    "google.com", "google.co.uk",
    "bing.com",
    "yahoo.com",
    "duckduckgo.com",
    "wikipedia.org",
    "wikimedia.org",
    "wikidata.org",

    # ── Review / comparison sites ─────────────────────────────────────────────
    "trustpilot.com",
    "glassdoor.com",
    "reviews.co.uk",
    "reevoo.com",
    "feefo.com",
    "which.co.uk",
    "moneysavingexpert.com",
    "comparethemarket.com",

    # ── Reference / informational / encyclopaedia sites ──────────────────────
    # These are never valid FX-prospect websites. Bing in particular returns
    # them for queries like "italian wine importer UK" because they contain
    # country or product names in article text.
    "britannica.com", "britannica.co.uk", "britannicakids.com",
    "merriam-webster.com",
    "dictionary.com", "thesaurus.com",
    "encyclopedia.com",
    "thoughtco.com",
    # Note: wikipedia.org already present in Search/tech section above

    # ── Supermarkets / consumer grocery retailers ─────────────────────────────
    # Retail grocery pages appear when queries contain product names and the
    # product page text mentions import origin (e.g. "gin importer UK distributor"
    # → Morrisons product page for an imported gin). None is a B2B FX prospect.
    # Subdomain matching in should_skip_url() covers groceries.morrisons.com etc.
    "morrisons.com",
    "tesco.com",
    "sainsburys.co.uk",
    "asda.com",
    "waitrose.com",
    "marksandspencer.com",
    "ocado.com",
    "iceland.co.uk",
    "aldi.co.uk",
    "lidl.co.uk",
    "costco.co.uk",

    # ── Consumer wine / drinks retailers ─────────────────────────────────────
    # These import wine/spirits but are B2C end-retailers, not trade FX
    # prospects. The FX conversation belongs with the upstream importer/agent.
    "majestic.co.uk",
    "thedrinkshop.com",
    "laithwaites.co.uk",
    "thewinesociety.com",
    "wineowners.com",
    "virginwines.com",
    "slurp.co.uk",

    # ── Marketplaces / B2C retail ─────────────────────────────────────────────
    "amazon.co.uk", "amazon.com",
    "ebay.co.uk", "ebay.com",
    "etsy.com",
    "notonthehighstreet.com",
    "wayfair.co.uk",
    "asos.com",
    "next.co.uk",
    "argos.co.uk",
    "johnlewis.com",
    "gumtree.com",
    "preloved.co.uk",
    "onbuy.com",
    "manomano.co.uk",

    # ── Job boards / HR ──────────────────────────────────────────────────────
    "reed.co.uk",
    "indeed.com", "indeed.co.uk",
    "totaljobs.com",
    "cv-library.co.uk",
    "monster.co.uk",
    "jobs.co.uk",
    "glassdoor.co.uk",
    "seek.com",
    "linkedin.com",
    "fish4.co.uk",
    "workable.com",
    "caterer.com",
    "michaelpage.co.uk",
    "hays.co.uk",
    "robertwalters.co.uk",

    # ── AI / lead-gen / generic aggregators ──────────────────────────────────
    "clutch.co",
    "goodfirms.co",
    "g2.com",
    "capterra.com",
    "getapp.com",
    "sortlist.co.uk",
    "upcity.com",
    "semrush.com",
    "similarweb.com",
    "craft.co",           # company aggregator
    "zoominfo.com",
    "apollo.io",
    "leadiq.com",
    "hunter.io",
    "rocketreach.co",
}

# ── SOURCE-PAGE MINING INFRASTRUCTURE ────────────────────────────────────────
# Mineable domains: trade associations / industry bodies whose MEMBER/DIRECTORY
# pages are valuable discovery sources. These are NOT added as leads themselves —
# they're fetched to extract company links.
# Note: some of these also appear in SKIP_DOMAINS (e.g. wsta.co.uk, fdf.org.uk).
# SKIP_DOMAINS governs whether a URL is treated as a LEAD.
# MINEABLE_DOMAINS governs whether a page is MINED for company links.
MINEABLE_DOMAINS = {
    # Wine & spirits
    "wsta.co.uk",           # Wine & Spirit Trade Association — /members
    "swa.org.uk",           # Scotch Whisky Association — /members
    # Food & drink
    "fdf.org.uk",           # Food & Drink Federation — /members
    "seafish.org",          # Seafish — /industry
    "brc.org.uk",           # British Retail Consortium
    # Manufacturing & materials
    "bpf.co.uk",            # British Plastics Federation — /members
    "makeuk.org",           # Make UK (manufacturers) — /members
    "eef.org.uk",           # Make UK legacy domain
    # Automotive & engineering
    "smmt.co.uk",           # Society of Motor Manufacturers — /members
    # Logistics & freight
    "bifa.org",             # British International Freight Association — /members
    "logistics.org.uk",     # Logistics UK — /members
    # Coffee & beverages
    "bca.org.uk",           # British Coffee Association — /members
    # Travel
    "abta.com",             # ABTA travel agents — /members
    # Chemicals
    "bcia.org.uk",          # British Chemical Importers Association
    # Timber
    "ttf.co.uk",            # Timber Trade Federation — /members
    # General trade / importers
    "bia.org.uk",           # British Importers Association
    "exportuk.co.uk",
}

# Path patterns that identify member/directory pages on ANY domain
MINEABLE_PATH_PATTERNS = [
    r"/members?(/|$)",
    r"/member-list",
    r"/our-members",
    r"/directory(/|$|\?)",
    r"/find-a-member",
    r"/find-a-supplier",
    r"/approved-suppliers?",
    r"/trade-list",
    r"/supplier-directory",
    r"/industry-directory",
]


def _is_mineable_source_page(url: str, title: str) -> bool:
    """
    Returns True if this URL is a mineable source page (trade association
    member list, industry directory) rather than a direct lead candidate.
    Source pages are fetched to extract company links — never scored as leads.
    """
    domain = domain_from_url(url) or ""
    path   = urlparse(url).path.lower()

    # Known mineable trade body domains
    for md in MINEABLE_DOMAINS:
        if domain == md or domain.endswith("." + md):
            return True

    # Path-based detection (any domain)
    for pattern in MINEABLE_PATH_PATTERNS:
        if re.search(pattern, path, re.I):
            return True

    return False


def mine_source_page(url: str, max_links: int = 15) -> list:
    """
    Fetch a trade association member list or industry directory page and
    extract company website links for downstream validation.

    Rules:
    - Never adds the source page itself as a lead.
    - Applies SKIP_DOMAINS to extracted links.
    - Caps at max_links per page.
    - Only called when direct company candidates < 3 for a query.

    Returns list of {url, title, snippet, from_source_page, source_page_url}.
    """
    # TODO: Wire this into the main query loop (Phase 2 of source-page rollout).
    # Currently callable but not yet integrated into process_event().
    # Integration requires routing mineable URLs out of the normal candidate pipeline
    # and into this function when direct_candidates < 3.
    extracted   = []
    seen_domains: set = set()
    source_domain = domain_from_url(url) or ""

    try:
        resp = requests.get(url, headers=_headers(), timeout=(5, 15), allow_redirects=True)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception as exc:
        log.debug("mine_source_page: fetch failed %s: %s", url, exc)
        return extracted

    from urllib.parse import urljoin

    for link_tag in soup.find_all("a", href=True):
        if len(extracted) >= max_links:
            break

        href = link_tag.get("href", "").strip()
        if not href:
            continue
        if not href.startswith("http"):
            href = urljoin(url, href)
        if not href.startswith("http"):
            continue

        skip, _ = should_skip_url(href)
        if skip:
            continue

        domain = domain_from_url(href)
        if not domain or domain == source_domain or domain in seen_domains:
            continue

        title = link_tag.get_text(strip=True)
        if not title or len(title) < 3 or len(title) > 120:
            continue

        seen_domains.add(domain)
        extracted.append({
            "url":             href,
            "title":           title,
            "snippet":         f"Extracted from source page: {url}",
            "from_source_page": True,
            "source_page_url": url,
        })

    log.debug("mine_source_page: %s → %d links extracted", url[:60], len(extracted))
    return extracted


# Path-level patterns: skip even on otherwise OK domains
SKIP_PATH_PATTERNS = [
    r"/blog/",
    r"/news/",
    r"/press-release",
    r"/article/",
    r"/articles/",
    r"/forum/",
    r"/community/",
    r"/wiki/",
    r"/help/",
    r"/support/faq",
    r"/jobs/",
    r"/careers/",
    r"/recruit",
    r"/vacancies",
    r"/login",
    r"/signup",
    r"/register",
    r"/checkout",
    r"/basket",
    r"/cart",
    r"/search\?",
    r"/results\?",
    r"/find\?",
    r"/category/",
    r"/tag/",
    r"/author/",
    r"\.pdf$",
    r"\.doc$",
]

# Title patterns that indicate directory pages / aggregator results
SKIP_TITLE_PATTERNS = [
    r"^\d+\s+(companies|businesses|suppliers|importers|exporters|distributors|wholesalers)",
    r"^(top|best|leading|largest|biggest)\s+\d+",
    r"^list of\s",
    r"directory\s*(of|for)",
    r"\bsuppliers?\s+in\s+",
    r"\bcompanies?\s+in\s+",
    r"^search results",
    r"trade show",
    r"\bmarket report\b",
    r"\bindustry report\b",
    r"\bcompare\s+",
    r"\breviews?\s+(of|for)\b",
    r"^(find|discover)\s+(a|the|your)\s+",
    r"\d+\s+importer",    # "50 importers in UK"
    r"\d+\s+exporter",
    r"\d+\s+supplier",
    r"database of\s",
    r"register of\s",
]


# ── SIGNAL LISTS ──────────────────────────────────────────────────────────────

FX_PAYMENT_SIGNALS = [
    "we import","we source","sourced from","imported from","direct from",
    "importing from","we buy from","purchased from","procured from",
    "overseas supplier","european supplier","international supplier","foreign supplier",
    "global supplier","worldwide supplier",
    "from italy","from france","from spain","from germany","from china","from usa",
    "from america","from japan","from india","from norway","from australia",
    "from new zealand","from south africa","from denmark","from netherlands",
    "foreign currency","currency risk","exchange rate","fx exposure",
    "international payments","overseas payments","currency hedging","fx risk",
    "importer","import company","import business","exclusive importer",
    "uk importer","sole importer","we distribute","import and distribute",
    "export","exports","exporting","we export","overseas customers","global customers",
    "international customers","us customers","american customers","european customers",
]

B2B_SIGNALS = [
    "wholesale","wholesaler","wholesale only","trade only","trade prices",
    "trade customers","trade enquiries","distributor","distribution",
    "minimum order","bulk order","bulk pricing","bulk discount",
    "b2b","business to business","business customers","corporate customers",
    "stockist","stockists","nationwide stockists","become a stockist",
    "reseller","resellers","agent","agents","authorised dealer","authorized dealer",
    "contract manufacturing","own label","private label","white label",
    "we supply","we manufacture and supply","supply chain",
    "catalogue available","brochure available","price list",
    "no vat","ex vat","plus vat","+vat",
]

SECONDARY_SIGNALS = [
    "international","global","worldwide","overseas","distribution",
    "logistics","freight","shipping","customs","clearance",
    "europe","european","asia","asian","north america","south america",
    "supply chain","supplier","sourcing","procurement",
    "currency","forex","exchange","sterling","dollar","euro",
    # Country adjectives — demoted from FX signals: indicate international links
    # but fire too broadly on service businesses mentioning destinations/nationalities
    "french","german","italian","american","chinese","japanese","spanish",
    "norwegian","australian","danish","dutch","indian",
]

NEGATIVE_SIGNALS = [
    "restaurant","cafe","coffee shop","takeaway","food delivery","just eat",
    "hair salon","nail salon","beauty salon","barber","hairdresser",
    "recruitment agency","job agency","staffing agency","we hire","submit your cv",
    "estate agent","letting agent","property management","rental property","for sale",
    "blog","personal blog","my thoughts","travel diary","lifestyle",
    "local delivery only","local area only","uk delivery only","mainland uk only",
    "dental","dentist","gp surgery","medical practice","clinic","pharmacy",
    "nursery","primary school","secondary school","sixth form","university",
    "charity","not for profit","non profit","registered charity","donate",
    "plumber","electrician","roofer","builder","handyman","decorator",
    "personal trainer","fitness instructor","yoga","pilates","gym","crossfit",
    "wedding","event planning","party planning","catering for weddings",
    "under construction","coming soon","parked domain","placeholder",
]

# ── UTILITIES ─────────────────────────────────────────────────────────────────

def now_iso():
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
    if not a or not b:
        return 0.0
    stops = {"ltd","limited","plc","llp","uk","the","and","of","co","company","group"}
    tok_a = set(re.findall(r"[a-z]+", a.lower())) - stops
    tok_b = set(re.findall(r"[a-z]+", b.lower())) - stops
    if not tok_a or not tok_b:
        return 0.0
    return len(tok_a & tok_b) / len(tok_a | tok_b)

def name_tokens(name: str) -> set:
    stops = {"ltd","limited","plc","llp","uk","the","and","of","co","company","group",
             "services","solutions","trading","enterprises","holdings","international"}
    return set(re.findall(r"[a-z]+", name.lower())) - stops

def _domain_tokens(domain: str) -> set:
    """Extract meaningful tokens from a domain name."""
    # Remove TLD and www, split on hyphens
    base = domain.lower()
    base = re.sub(r"\.(co\.uk|com|co|uk|net|org|io|biz)$", "", base)
    return set(re.findall(r"[a-z]{3,}", base))


# ── URL / TITLE FILTERING ─────────────────────────────────────────────────────

def should_skip_url(url: str) -> tuple[bool, str]:
    """Returns (skip, reason). True = skip this URL."""
    if not url or not url.startswith("http"):
        return True, "not a valid http URL"

    domain = domain_from_url(url)
    if not domain:
        return True, "could not parse domain"

    # Check blocklist (exact + parent domain matching)
    for skip in SKIP_DOMAINS:
        if domain == skip or domain.endswith("." + skip):
            return True, f"blocked domain: {skip}"

    parsed = urlparse(url)
    path = (parsed.path or "").lower()
    for pattern in SKIP_PATH_PATTERNS:
        if re.search(pattern, path):
            return True, f"blocked path: {pattern}"

    return False, ""


def should_skip_title(title: str) -> tuple[bool, str]:
    """Returns (skip, reason). True = skip this result (directory listing etc.)."""
    if not title:
        return False, ""
    tl = title.lower()
    for pattern in SKIP_TITLE_PATTERNS:
        if re.search(pattern, tl):
            return True, f"title pattern: {pattern}"
    return False, ""


def domain_coherent_with_name(domain: str, search_title: str) -> bool:
    """
    Check that the domain plausibly belongs to the company in the title.
    Rejects: grokipedia.com for "AMSONS LTD", chemeurope.com for "KILCO CHEMICALS".
    Passes:  resourcechemicals.co.uk for "RESOURCE CHEMICALS LIMITED".

    Rule: domain tokens must share ≥1 meaningful token with company name,
    OR the domain is a common company-website pattern (short brand name).
    """
    d_tok = _domain_tokens(domain)
    n_tok = name_tokens(search_title)

    if not n_tok:
        return True  # can't check, give benefit of doubt

    # If there's overlap → coherent
    if d_tok & n_tok:
        return True

    # Allow short brand domains (≤10 chars base) — e.g. "pearl" for "Pearl Chemicals"
    # Check if any name token appears in the full domain string
    domain_str = domain.split(".")[0].lower()
    for tok in n_tok:
        if len(tok) >= 4 and tok in domain_str:
            return True

    # Allow if domain is very short/brand-like AND not a known aggregator
    base = domain.split(".")[0]
    if len(base) <= 8:
        return True   # short brand domains are often valid

    return False


# ── DUCKDUCKGO SEARCH ─────────────────────────────────────────────────────────

# Shared session with cookies for better DDG compatibility
_ddg_session = requests.Session()
_ddg_initialized = False


def _init_ddg_session():
    """Pre-warm DDG session with a homepage visit."""
    global _ddg_initialized
    if _ddg_initialized:
        return
    try:
        _ddg_session.headers.update(_headers())
        _ddg_session.get("https://duckduckgo.com/", timeout=(5, 10))
        _ddg_initialized = True
    except Exception:
        pass


def ddg_search(query: str, n: int = 10) -> tuple[list, dict]:
    """
    Search DuckDuckGo HTML interface.
    Returns (results, meta) where:
      results = list of {url, title, snippet} dicts filtered by SKIP_DOMAINS/SKIP_TITLES
      meta    = {status, raw_count, filtered_count}
        status: "blocked"  — DDG returned soft-block / short response
                "timeout"  — request timed out or network error
                "empty"    — DDG returned valid response but 0 results
                "filtered" — DDG returned results but all blocked by SKIP_DOMAINS/SKIP_TITLES
                "ok"       — at least 1 result passed filters
    Falls back gracefully on block/rate-limit.
    """
    _init_ddg_session()
    results  = []
    raw_count = 0
    meta = {"status": "ok", "raw_count": 0, "filtered_count": 0}

    try:
        _ddg_session.headers.update(_headers("https://duckduckgo.com/"))
        resp = _ddg_session.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query},
            timeout=(5, 15),
        )
        # 202 = DDG soft-blocking (returns homepage HTML instead of results)
        if resp.status_code == 202 or len(resp.text) < 5000:
            log.debug("DDG soft-block for %r (status=%d, len=%d)", query, resp.status_code, len(resp.text))
            meta["status"] = "blocked"
            return results, meta
        resp.raise_for_status()
    except requests.exceptions.Timeout:
        log.debug("DDG timeout for %r", query)
        meta["status"] = "timeout"
        return results, meta
    except Exception as exc:
        log.debug("DDG request failed for %r: %s", query, exc)
        meta["status"] = "timeout"
        return results, meta

    soup = BeautifulSoup(resp.text, "html.parser")

    for result in soup.select(".result"):
        if len(results) >= n:
            break

        link_tag = result.select_one(".result__a")
        if not link_tag:
            continue

        href = link_tag.get("href", "")
        url = None

        # DDG redirect format: //duckduckgo.com/l/?uddg=ENCODED_URL
        if "uddg=" in href:
            try:
                if href.startswith("//"):
                    href = "https:" + href
                uddg = parse_qs(urlparse(href).query).get("uddg", [None])[0]
                if uddg:
                    url = unquote(uddg)
            except Exception:
                continue
        elif href.startswith("http"):
            url = href
        else:
            continue

        if not url:
            continue

        raw_count += 1

        skip_url, reason = should_skip_url(url)
        if skip_url:
            log.debug("  Skip URL (%s): %s", reason, url[:60])
            continue

        title   = link_tag.get_text(strip=True)
        skip_title, reason = should_skip_title(title)
        if skip_title:
            log.debug("  Skip title (%s): %s", reason, title[:60])
            continue

        snippet_tag = result.select_one(".result__snippet")
        snippet = snippet_tag.get_text(strip=True) if snippet_tag else ""

        results.append({"url": url, "title": title, "snippet": snippet})

    meta["raw_count"]      = raw_count
    meta["filtered_count"] = len(results)
    if raw_count == 0:
        meta["status"] = "empty"
    elif len(results) == 0:
        meta["status"] = "filtered"  # DDG returned results but all blocked by SKIP lists

    log.debug("DDG %r → %d/%d results (status=%s)", query[:60], len(results), raw_count, meta["status"])
    return results, meta


# ── BING HTML SEARCH (secondary source when DDG is blocked/timeout) ──────────

# Separate session from DDG — different fingerprint, different cookie jar.
# Using Edge user-agents: Bing is Microsoft's engine and Edge is Microsoft's browser,
# which makes Edge UAs less likely to trigger bot detection on Bing.
_BING_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.2277.83",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.2277.83",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
]

_bing_session = requests.Session()
_bing_initialized = False


def _init_bing_session():
    """
    Initialise Bing session headers.

    Deliberately does NOT visit the Bing homepage first.
    A homepage warm-up visit causes Bing to set cookies that switch it to the
    AI Copilot layout, which has no standard li.b_algo result elements.
    A cold session with appropriate headers returns the classic HTML result page.
    """
    global _bing_initialized
    if _bing_initialized:
        return
    _bing_session.headers.update({
        "User-Agent":      random.choice(_BING_USER_AGENTS),
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
    })
    _bing_initialized = True


def bing_search(query: str, n: int = 10) -> tuple[list, dict]:
    """
    Search Bing HTML interface. Secondary source when DDG is blocked or times out.

    Returns (results, meta) with the same structure as ddg_search():
      results = list of {url, title, snippet, from_bing: True}
      meta    = {status, raw_count, filtered_count}
        status: "blocked"  — Bing returned bot-detection / very short response
                "timeout"  — request timed out
                "empty"    — valid response but 0 results
                "filtered" — results returned but all blocked by skip lists
                "ok"       — at least 1 result passed filters
    """
    _init_bing_session()
    results   = []
    raw_count = 0
    meta = {"status": "ok", "raw_count": 0, "filtered_count": 0}

    try:
        _bing_session.headers.update({"User-Agent": random.choice(_BING_USER_AGENTS)})
        resp = _bing_session.get(
            "https://www.bing.com/search",
            params={
                "q":       query,
                "setlang": "en-GB",
                "cc":      "GB",
                "setmkt":  "en-GB",
                # Note: do NOT pass count= here. Bing serves a different
                # (often b_algo-free) page layout when count is forced low.
            },
            timeout=(5, 18),
        )
        # Bot-detection: Bing returns 200 but with a very short page (CAPTCHA/redirect)
        if resp.status_code == 200 and len(resp.text) < 4000:
            log.debug("Bing soft-block for %r (len=%d)", query[:50], len(resp.text))
            meta["status"] = "blocked"
            return results, meta
        if resp.status_code in (429, 503):
            meta["status"] = "blocked"
            return results, meta
        resp.raise_for_status()
    except requests.exceptions.Timeout:
        log.debug("Bing timeout for %r", query[:50])
        meta["status"] = "timeout"
        return results, meta
    except Exception as exc:
        log.debug("Bing request failed for %r: %s", query[:50], exc)
        meta["status"] = "timeout"
        return results, meta

    soup = BeautifulSoup(resp.text, "html.parser")

    # Bing result structure: <li class="b_algo"> → <h2><a href="..."> for title+URL
    # Snippet: .b_caption > p  OR  p.b_algoSlug
    #
    # URL extraction: Bing wraps all hrefs in click-tracking redirects
    # (https://www.bing.com/ck/a?...&u=a1<base64url>&ntb=1).
    # The real destination URL is base64url-encoded after the "a1" prefix in the u= param.
    # We decode it; if that fails, we extract the domain from the <cite> element.

    import base64 as _b64

    def _decode_bing_url(href: str) -> str | None:
        """Extract the real destination URL from a Bing click-tracking redirect."""
        if not href or "bing.com/ck/a" not in href:
            return href if href and href.startswith("http") else None
        try:
            qs = parse_qs(urlparse(href).query)
            u_val = qs.get("u", [None])[0]
            if not u_val or not u_val.startswith("a1"):
                return None
            # Strip the 2-character "a1" magic prefix, then decode base64url
            b64 = u_val[2:]
            # Add padding if needed
            padding = (4 - len(b64) % 4) % 4
            decoded = _b64.urlsafe_b64decode(b64 + "=" * padding).decode("utf-8", errors="ignore")
            if decoded.startswith("http"):
                return decoded
        except Exception:
            pass
        return None

    def _cite_to_url(cite_tag) -> str | None:
        """
        Fallback: reconstruct a URL from Bing's <cite> display element.
        cite text format: "https://www.example.co.uk › products › widgets"
        """
        if not cite_tag:
            return None
        text = cite_tag.get_text(" ", strip=True)
        # Replace Bing's › separator with /
        text = re.sub(r"\s*›\s*", "/", text).strip()
        if text.startswith("http"):
            return text
        if "." in text.split("/")[0]:
            return "https://" + text
        return None

    for item in soup.select("#b_results > li.b_algo"):
        if len(results) >= n:
            break

        link_tag = item.select_one("h2 > a")
        if not link_tag:
            continue

        # 1. Try to decode Bing's click-tracking redirect
        raw_href = link_tag.get("href", "") or link_tag.get("data-url", "")
        url = _decode_bing_url(raw_href)

        # 2. Fall back to cite element if decode failed
        if not url:
            cite_tag = item.select_one("cite") or item.select_one(".b_attribution cite")
            url = _cite_to_url(cite_tag)

        if not url or not url.startswith("http"):
            continue

        raw_count += 1

        skip_url, reason = should_skip_url(url)
        if skip_url:
            log.debug("  Bing skip URL (%s): %s", reason, url[:60])
            continue

        title = link_tag.get_text(strip=True)
        skip_title, reason = should_skip_title(title)
        if skip_title:
            log.debug("  Bing skip title (%s): %s", reason, title[:60])
            continue

        snippet_tag = item.select_one(".b_caption > p") or item.select_one("p.b_algoSlug")
        snippet = snippet_tag.get_text(strip=True) if snippet_tag else ""

        results.append({
            "url":       url,
            "title":     title,
            "snippet":   snippet,
            "from_bing": True,
        })

    meta["raw_count"]      = raw_count
    meta["filtered_count"] = len(results)
    if raw_count == 0:
        meta["status"] = "empty"
    elif len(results) == 0:
        meta["status"] = "filtered"

    log.debug("Bing %r → %d/%d results (status=%s)", query[:60], len(results), raw_count, meta["status"])
    return results, meta


# ── COMPANIES HOUSE KEYWORD SEARCH (fallback when DDG fails) ─────────────────

# Single-word generic terms that produce useless CH name matches.
# e.g. "low cost air" → core="low" → CH returns "LOW COST BEER LTD", "LOW COST BALING LTD"
# When the extracted core keyword is one of these, skip CH fallback entirely.
_CH_FALLBACK_TOO_GENERIC = {
    "low", "high", "budget", "cheap", "fast", "global", "local", "national",
    "domestic", "regional", "specialist", "corporate", "group", "direct",
    "international", "premier", "elite", "premium", "express", "rapid",
    "online", "digital", "smart", "best", "top", "new", "old",
}


def _extract_core_keyword(query: str) -> str:
    """
    Extract the most specific industry keyword from a search query for CH fallback.
    "delicatessen wholesale UK" → "delicatessen"
    '"wine importer" UK' → "wine importer"
    '"chemical distributor" imports UK' → "chemical distributor"
    """
    # Remove quotes and strip generic terms
    generic = {"uk", "british", "england", "london", "importer", "exporter",
               "imports", "exports", "import", "export", "wholesale", "wholesaler",
               "supplier", "distributor", "manufacturer", "company", "business"}
    # Try to extract a quoted phrase first
    quoted = re.findall(r'"([^"]+)"', query)
    if quoted:
        # Use quoted phrase directly (it's the most specific)
        return quoted[0]
    # Otherwise use the first meaningful token(s)
    tokens = [t for t in query.split() if t.lower() not in generic and len(t) >= 3]
    return " ".join(tokens[:2]) if tokens else query.split()[0]


def ch_keyword_search(query: str, max_results: int = 10) -> list:
    """
    Search Companies House by keyword. Returns active companies.
    Used as fallback when DDG returns nothing.

    Extracts the core industry keyword from the query to avoid false matches
    (e.g. "delicatessen wholesale UK" → searches CH for "delicatessen", not "wholesale"
    which would match unrelated companies like AIRSOFT WHOLESALE).

    Each result: {url, title, snippet, from_ch: True}
    """
    if not COMPANIES_HOUSE_API_KEY:
        return []

    core_kw = _extract_core_keyword(query)
    if not core_kw:
        return []

    results = []
    try:
        resp = requests.get(
            "https://api.company-information.service.gov.uk/search/companies",
            params={"q": core_kw, "items_per_page": max_results},
            auth=(COMPANIES_HOUSE_API_KEY, ""),
            timeout=(5, 15),
        )
        resp.raise_for_status()
        items = resp.json().get("items", [])
    except Exception as exc:
        log.debug("CH keyword search failed for %r: %s", core_kw, exc)
        return results

    log.debug("CH fallback: %r → %r → %d items", query[:50], core_kw, len(items))

    for item in items:
        status = (item.get("company_status") or "").lower()
        if status not in ("active", ""):
            continue

        name = item.get("title", "")
        cn   = item.get("company_number", "")
        if not name or not cn:
            continue

        results.append({
            "url":       None,   # website guessed later
            "title":     name,
            "snippet":   f"Companies House: {cn} — {item.get('description','')}",
            "from_ch":   True,
            "ch_number": cn,
        })

    log.debug("CH fallback %r → %d active candidates", core_kw, len(results))
    return results


# ── WEBSITE VALIDATION ────────────────────────────────────────────────────────

def _fetch_text(url: str, timeout: int = 12) -> tuple[str, str]:
    """Fetch a URL, return (clean_text, final_url_after_redirects). Empty string on failure.
    Uses (connect_timeout=5, read_timeout) split to prevent silent TCP SYN hangs on
    unresponsive servers (e.g. Azure-hosted sites that drop SYN packets)."""
    try:
        resp = requests.get(url, headers=_headers(), timeout=(5, timeout), allow_redirects=True)
        resp.raise_for_status()
        final_url = resp.url
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "meta", "link", "noscript"]):
            tag.decompose()
        return soup.get_text(" ", strip=True), final_url
    except Exception as exc:
        log.debug("Fetch failed %s: %s", url, exc)
        return "", url


def _count_company_references(text: str) -> int:
    """
    Count how many distinct company names are referenced on a page.
    A high count suggests this is a directory / aggregator page.
    """
    # Look for patterns like "Ltd", "Limited", "PLC", "LLP" indicating company names
    count = len(re.findall(r"\b(limited|ltd|plc|llp|inc|corp)\b", text, re.I))
    return count


def validate_website(url: str, name_tokens_set: set, segment_signals: list) -> dict:
    """
    Fetch homepage (and /about if sparse) and extract signals.
    Includes quality gates:
      - reject parked/placeholder pages
      - reject multi-company directory pages
      - check name coherence on the actual page content

    Returns validation dict.
    """
    empty = {
        "fx_signals": [], "b2b_signals": [], "secondary_signals": [],
        "negative_signals": [], "segment_signals_found": [],
        "snippet": "", "name_on_page": False,
        "website_confidence": "none", "pays_fx": False, "is_b2b": False,
        "text_length": 0, "reject_reason": "",
    }
    if not url:
        return empty

    text, final_url = _fetch_text(url)
    pages_scraped   = 1

    # Multi-page scraping: fetch extra pages when homepage is thin on signals.
    # Hard cap: 4 pages per domain. Early stop: once FX signal count reaches 3.
    _EXTRA_PATHS     = ["/about", "/about-us", "/products", "/services",
                        "/distribution", "/what-we-do", "/our-products"]
    _MAX_PAGES       = 4
    _EARLY_STOP_SIGS = 3

    if len(text) < 2000:  # homepage is sparse — try extra paths
        parsed = urlparse(url)
        base   = f"{parsed.scheme}://{parsed.netloc}"
        for path in _EXTRA_PATHS:
            if pages_scraped >= _MAX_PAGES:
                break
            # Early stop: check provisional FX signal count on combined text so far
            provisional_fx = sum(1 for s in FX_PAYMENT_SIGNALS if s in text.lower())
            if provisional_fx >= _EARLY_STOP_SIGS:
                break
            extra_text, _ = _fetch_text(base + path)
            if extra_text and extra_text not in text:
                text          += " " + extra_text
                pages_scraped += 1

    if len(text) < 100:
        return {**empty, "reject_reason": "page too sparse / unreadable"}

    tlow = text.lower()
    snippet = re.sub(r"\s+", " ", text)[:800]

    # ── Quality gate: parking / placeholder pages ───────────────────────────
    parking_signals = [
        "domain is for sale", "this domain is available", "buy this domain",
        "parked by", "this site is coming soon", "under construction",
        "website coming soon", "domain parking", "register this domain",
        "404 not found", "page not found",
    ]
    if any(p in tlow for p in parking_signals):
        return {**empty, "reject_reason": "parked or placeholder page"}

    # ── Quality gate: multi-company directory / aggregator ──────────────────
    company_ref_count = _count_company_references(text)
    if company_ref_count > 15:
        return {**empty, "reject_reason": f"appears to be a directory (company refs: {company_ref_count})"}

    # ── Signal extraction ────────────────────────────────────────────────────
    fx_sigs  = sorted({s for s in FX_PAYMENT_SIGNALS if s in tlow})
    b2b_sigs = sorted({s for s in B2B_SIGNALS        if s in tlow})
    sec_sigs = sorted({s for s in SECONDARY_SIGNALS  if s in tlow})
    neg_sigs = sorted({s for s in NEGATIVE_SIGNALS   if s in tlow})
    seg_sigs = sorted({s for s in (segment_signals or []) if s.lower() in tlow})

    # ── Name-on-page check ──────────────────────────────────────────────────
    words_on_page = set(re.findall(r"[a-z]+", tlow))
    name_on_page  = bool(name_tokens_set) and (
        len(name_tokens_set & words_on_page) >= max(1, len(name_tokens_set) * 0.5)
    )

    pays_fx = len(fx_sigs) >= 1 or len(sec_sigs) >= 3
    is_b2b  = len(b2b_sigs) >= 1

    # ── Website confidence ───────────────────────────────────────────────────
    #   high:   FX/import signals found AND name tokens on page
    #   medium: FX signals present (even without name match), OR strong B2B (3+)
    #   low:    only secondary/B2B signals — some trade activity but weak evidence
    #   none:   no positive signals
    if fx_sigs and name_on_page:
        confidence = "high"
    elif fx_sigs:
        confidence = "medium"
    elif len(b2b_sigs) >= 3 and name_on_page:
        confidence = "medium"
    elif b2b_sigs or sec_sigs:
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
        "pages_scraped":          pages_scraped,
        "reject_reason":          "",
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
        timeout=(5, 15),
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
        timeout=(5, 15),
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
        timeout=(5, 15),
    )
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return [o for o in r.json().get("items", []) if not o.get("resigned_on")]


def _format_officer(o: dict) -> dict:
    name = o.get("name", "")
    if "," in name:
        parts = name.split(",", 1)
        name = f"{parts[1].strip()} {parts[0].strip().title()}"
    return {"name": name.strip(), "role": o.get("officer_role", "Director")}


def _extract_director(officers: list) -> dict | None:
    priority = [
        "finance-director", "managing-director", "chief-executive",
        "chief-financial-officer", "commercial-director", "director", "company-secretary",
    ]
    for role in priority:
        for o in officers:
            if role in (o.get("officer_role", "")).lower().replace(" ", "-"):
                return _format_officer(o)
    if officers:
        return _format_officer(officers[0])
    return None


def ch_validate(company_name: str, domain: str = None) -> dict | None:
    """
    Validate a company via Companies House.
    Fuzzy name match (Jaccard ≥ 0.35). Returns enriched dict or None.
    """
    if not COMPANIES_HOUSE_API_KEY:
        return None

    try:
        items = _ch_search_api(company_name, n=5)
    except Exception as exc:
        log.debug("CH search failed for %r: %s", company_name, exc)
        return None

    if not items:
        return None

    best_item  = None
    best_score = 0.0
    for item in items:
        score = jaccard_similarity(company_name, item.get("title", ""))
        if score > best_score:
            best_score = score
            best_item  = item

    if best_score < 0.35 or not best_item:
        log.debug("CH name match weak for %r (best=%.2f)", company_name, best_score)
        return None

    cn = best_item.get("company_number", "")
    if not cn:
        return None

    try:
        profile = _ch_profile_api(cn)
    except Exception as exc:
        log.debug("CH profile failed %s: %s", cn, exc)
        return None

    if not profile:
        return None

    status      = (profile.get("company_status") or "").lower()
    sic_codes   = [str(s) for s in profile.get("sic_codes", [])]
    incorporated = profile.get("date_of_creation", "")
    addr        = profile.get("registered_office_address", {})
    address_str = ", ".join(filter(None, [
        addr.get("address_line_1", ""),
        addr.get("locality", ""),
        addr.get("postal_code", ""),
    ]))

    try:
        officers  = _ch_officers_api(cn)
    except Exception:
        officers  = []

    director = _extract_director(officers)

    return {
        "company_number":    cn,
        "company_name":      best_item.get("title", ""),
        "company_status":    status,
        "sic_codes":         sic_codes,
        "incorporated":      incorporated,
        "registered_address": address_str,
        "director_name":     director["name"] if director else None,
        "director_role":     director["role"] if director else None,
        "ch_name_match":     round(best_score, 3),
        "ch_confidence":     "high" if best_score >= 0.7 else "medium" if best_score >= 0.5 else "low",
    }


# ── WEBSITE DISCOVERY FOR CH CANDIDATES ──────────────────────────────────────

def _guess_website_for_ch(company_name: str, company_number: str) -> str | None:
    """Try to find a website for a CH-discovered company via domain guessing."""
    try:
        # Import the existing website_finder
        import sys
        sys.path.insert(0, str(Path(__file__).parent))
        from website_finder import find_website_guess
        url, confidence, source = find_website_guess(company_name, company_number)
        if url and confidence in ("high", "medium"):
            return url
    except Exception as exc:
        log.debug("website_finder failed for %r: %s", company_name, exc)
    return None


# ── SCORING ───────────────────────────────────────────────────────────────────

FX_SIC_PREFIXES = {
    "46", "47",   # wholesale and retail trade
    "10", "11", "12", "13", "14", "15", "16", "17", "18", "19",
    "20", "21", "22", "23", "24", "25", "26", "27", "28", "29",
    "30", "31", "32", "33",  # manufacturing
    "49", "50", "51", "52", "53",  # transport / logistics
}

EXPOSURE_LEVEL_BOOST = {"Very High": 20, "High": 12, "Medium": 6, "Low": 0}


def _has_fx_sic(sic_codes: list) -> bool:
    for code in sic_codes:
        clean = code.replace(" ", "")
        for prefix in FX_SIC_PREFIXES:
            if clean.startswith(prefix):
                return True
    return False


def score_web_lead(
    validation: dict,
    ch_data: dict | None,
    segment: dict,
    event: dict,
) -> tuple[int, str, list]:
    """
    Web-specific lead scoring with strict evidence gates.

    HOT (≥80): must have direct FX/import/export/international evidence on website.
    WARM (≥60): must have FX OR strong B2B + segment match.
    QUEUE (≥40): some trade evidence but not conclusive.
    SKIP (<40): no real evidence of FX exposure.
    """
    score   = 0
    reasons = []
    fx_sigs  = validation.get("fx_signals",  [])
    b2b_sigs = validation.get("b2b_signals", [])
    sec_sigs = validation.get("secondary_signals", [])
    neg_sigs = validation.get("negative_signals", [])
    seg_sigs = validation.get("segment_signals_found", [])
    conf     = validation.get("website_confidence", "none")

    # 1. Website confidence base score
    if conf == "high":
        score += 25
        reasons.append("Strong FX signals on website, name confirmed (+25)")
    elif conf == "medium":
        score += 15
        reasons.append("FX/trade signals found on website (+15)")
    elif conf == "low":
        score += 8
        reasons.append("Weak trade signals on website (+8)")
    else:
        score -= 15
        reasons.append("No useful website signals (−15)")

    # 2. FX payment signals (+4 each, max 28)
    if fx_sigs:
        s = min(28, len(fx_sigs) * 4)
        score += s
        reasons.append(f"Direct FX signals: {', '.join(fx_sigs[:3])} (+{s})")

    # 3. B2B signals (+2 each, max 10) — only meaningful alongside FX evidence
    if b2b_sigs:
        s = min(10, len(b2b_sigs) * 2)
        score += s
        reasons.append(f"B2B/trade signals: {', '.join(b2b_sigs[:3])} (+{s})")

    # 4. Secondary signals (+1 each, max 6)
    if sec_sigs:
        s = min(6, len(sec_sigs))
        score += s
        reasons.append(f"International activity signals ({len(sec_sigs)}) (+{s})")

    # 5. Segment-specific signals (+5 each, max 15)
    if seg_sigs:
        s = min(15, len(seg_sigs) * 5)
        score += s
        reasons.append(f"Segment-specific signals: {', '.join(seg_sigs[:2])} (+{s})")

    # 6. Negative signals (−5 each, removes up to all positive score from signals)
    if neg_sigs:
        penalty = min(score, len(neg_sigs) * 5)
        score  -= penalty
        reasons.append(f"⚠ Negative signals: {', '.join(neg_sigs[:2])} (−{penalty})")

    # 7. Exposure level boost (from segment)
    exp_level = segment.get("exposure_level", "")
    exp_boost = EXPOSURE_LEVEL_BOOST.get(exp_level, 0)
    if exp_boost:
        score += exp_boost
        reasons.append(f"Segment exposure: {exp_level} (+{exp_boost})")

    # 8. CH validation
    if ch_data:
        status = ch_data.get("company_status", "")
        if status == "active":
            score += 12
            reasons.append("Active on Companies House (+12)")
        else:
            score += 4
            reasons.append(f"Found on CH — status: {status} (+4)")

        if _has_fx_sic(ch_data.get("sic_codes", [])):
            score += 10
            reasons.append(f"FX-relevant SIC: {', '.join(ch_data.get('sic_codes',[])[:2])} (+10)")

        if ch_data.get("director_name"):
            score += 5
            reasons.append(f"Director: {ch_data['director_name']} (+5)")

        if ch_data.get("ch_confidence") == "high":
            score += 3
            reasons.append("Strong CH name match (+3)")
    else:
        score -= 8
        reasons.append("Not validated on CH (−8)")

    score = max(0, min(score, 100))

    # ── Hard evidence gates ──────────────────────────────────────────────────

    has_direct_fx  = bool(fx_sigs) or bool(seg_sigs)
    has_intl       = bool(fx_sigs) or len(sec_sigs) >= 2 or bool(seg_sigs)
    has_any_trade  = bool(fx_sigs) or len(b2b_sigs) >= 2 or len(sec_sigs) >= 2

    # Gate 1: HOT requires direct FX/import/export/international evidence on website
    # B2B-only without FX/international signals should never be HOT
    if score >= 80 and not has_direct_fx:
        score = 79
        reasons.append("⚠ HOT capped → WARM: no direct FX/import signals on website")

    # Gate 2: WARM requires at least some FX or international evidence
    # B2B-only (no international signals) should be QUEUE at best
    if score >= 60 and not has_intl:
        score = 59
        reasons.append("⚠ WARM capped → QUEUE: no FX/international signals, B2B-only")

    # Gate 3: QUEUE minimum: some trade evidence required
    if not has_any_trade:
        score = min(score, 39)
        reasons.append("⚠ Capped SKIP: no trade evidence (FX, B2B, or international)")

    # Gate 4: low website confidence → cap at QUEUE (not WARM or HOT)
    if conf == "low" and score >= 60:
        score = 59
        reasons.append("⚠ Capped QUEUE: low website confidence")

    # Gate 5: website confidence none → SKIP
    if conf == "none":
        score = min(score, 35)
        reasons.append("⚠ Capped SKIP: no useful website signals")

    # Gate 6: negative signals dominate → cap at QUEUE
    if neg_sigs and len(neg_sigs) >= len(fx_sigs) + 1:
        score = min(score, 49)
        reasons.append("⚠ Negative signals limit priority")

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
    Build a specific, evidence-backed exposure thesis.
    Combines segment knowledge + website evidence + event linkage.
    """
    fx_sigs  = validation.get("fx_signals", [])
    b2b_sigs = validation.get("b2b_signals", [])
    seg_name = segment.get("segment_name", "")
    why_exposed = segment.get("why_financially_exposed", "")
    fx_logic    = segment.get("fx_payment_logic", "")
    margin_risk = segment.get("margin_risk", "")
    event_headline = event.get("headline", event.get("title", ""))
    sic_codes   = (ch_data or {}).get("sic_codes", [])

    parts = []

    # 1. Lead with what the website shows
    if fx_sigs:
        sample = fx_sigs[:2]
        if "importer" in fx_sigs or "import" in " ".join(fx_sigs):
            parts.append(f"Website identifies as an importer ({', '.join(sample)}).")
        elif "exporter" in " ".join(fx_sigs) or "export" in " ".join(fx_sigs):
            parts.append(f"Website identifies as an exporter ({', '.join(sample)}).")
        else:
            parts.append(f"Website shows: {', '.join(sample)}.")
    elif b2b_sigs:
        parts.append(f"B2B trade business ({', '.join(b2b_sigs[:2])}).")

    # 2. Add segment-specific exposure logic
    if why_exposed:
        parts.append(why_exposed)
    elif fx_logic:
        parts.append(fx_logic)

    # 3. Link to the event
    if event_headline:
        parts.append(f"Likely affected by: {event_headline}.")

    # 4. Margin/timing risk
    if margin_risk:
        parts.append(f"Risk: {margin_risk}")

    # 5. Fallback if parts is very thin
    if not parts or (len(parts) == 1 and not fx_sigs):
        if seg_name:
            parts.append(f"Identified as potential {seg_name} via web discovery.")

    return " ".join(parts) if parts else (
        f"{company_name} — identified via web search as a potential {seg_name or 'FX-exposed'} business."
    )


# ── LEAD CREATION ─────────────────────────────────────────────────────────────

def _compute_exposure_confidence(validation: dict, segment: dict) -> str:
    fx_sigs  = validation.get("fx_signals", [])
    b2b_sigs = validation.get("b2b_signals", [])
    sec_sigs = validation.get("secondary_signals", [])
    wc       = validation.get("website_confidence", "none")
    exp_lvl  = segment.get("exposure_level", "")
    pays_fx  = validation.get("pays_fx", False)

    ev = 0
    if pays_fx:                        ev += 3
    if len(fx_sigs) >= 2:              ev += 3
    elif len(fx_sigs) == 1:            ev += 2
    if len(b2b_sigs) >= 2:             ev += 1
    if len(sec_sigs) >= 3:             ev += 1
    if wc == "high":                   ev += 2
    elif wc in ("medium","confirmed"): ev += 1
    if exp_lvl == "Very High":         ev += 2
    elif exp_lvl == "High":            ev += 1

    if ev >= 7: return "high"
    if ev >= 4: return "medium"
    if ev >= 1: return "low"
    return "none"


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
    website_source: str = "ddg_search",
) -> tuple[str, dict]:
    company_name = (ch_data or {}).get("company_name") or search_title or domain
    lid = lead_id(domain, event_id)

    thesis = build_exposure_thesis(
        company_name, domain, validation, ch_data, segment, event
    )

    lead = {
        "id":                 lid,
        "company_name":       company_name,
        "company_number":     (ch_data or {}).get("company_number"),
        "company_status":     (ch_data or {}).get("company_status", "unknown"),
        "company_source":     "web_search",
        "sic_codes":          (ch_data or {}).get("sic_codes", []),
        "incorporated":       (ch_data or {}).get("incorporated"),
        "registered_address": (ch_data or {}).get("registered_address"),
        "director_name":      (ch_data or {}).get("director_name"),
        "director_role":      (ch_data or {}).get("director_role"),
        "website":            url,
        "website_domain":     domain,
        "website_confidence": validation.get("website_confidence", "low"),
        "website_source":     website_source,
        "website_snippet":    validation.get("snippet", "")[:400],
        "fx_payment_signals": validation.get("fx_signals", []),
        "b2b_signals":        validation.get("b2b_signals", []),
        "secondary_signals":  validation.get("secondary_signals", []),
        "segment_signals":    validation.get("segment_signals_found", []),
        "pays_fx_confirmed":  validation.get("pays_fx", False),
        "pages_scraped":      validation.get("pages_scraped", 1),
        "signal_count": (
            len(validation.get("fx_signals", []))
            + len(validation.get("b2b_signals", []))
            + len(validation.get("secondary_signals", []))
        ),
        "score":              score,
        "priority":           priority,
        "scoring_reasons":    reasons,
        "event_id":           event_id,
        "event_headline":     event.get("headline", event.get("title", "")),
        "segment_name":       segment.get("segment_name", ""),
        "segment_business_model": segment.get("business_model", ""),
        "exposure_level":     segment.get("exposure_level", ""),
        "exposure_type":      segment.get("exposure_type", ""),
        "exposure_confidence": _compute_exposure_confidence(validation, segment),
        "why_affected":       thesis,
        "why_financially_exposed": segment.get("why_financially_exposed", ""),
        "fx_payment_logic":   segment.get("fx_payment_logic", ""),
        "margin_risk":        segment.get("margin_risk", ""),
        "payment_timing_risk": segment.get("payment_timing_risk", ""),
        "affected_payment_flow": segment.get("affected_payment_flow", ""),
        "business_impact_summary": event.get("business_impact_summary", ""),
        "trigger_headline":   event.get("trigger_headline", ""),
        "ch_name_match":      (ch_data or {}).get("ch_name_match"),
        "ch_confidence":      (ch_data or {}).get("ch_confidence"),
        "discovered_at":      now_iso(),
        "rescored_at":        now_iso(),
        "multi_event_trigger": False,
        "multi_event_count":  1,
        "linked_event_ids":   [event_id],
        "guessed_emails":     [],
        "linkedin_url":       None,
        "call_opener":        None,
        "email_draft":        None,
        "outreach_status":    "new",
    }

    return lid, lead


# ── EVENT PROCESSING ──────────────────────────────────────────────────────────

def process_event(event: dict, event_id: str, leads: dict, stats: dict) -> int:
    """
    Process one event: search → validate → CH → score → add to leads.
    """
    added    = 0
    breadth  = event.get("event_breadth", "sector_specific")
    all_segs = event.get("target_segments", [])

    # ── Category Priority Engine (Brain 1 → Brain 2 handoff) ──────────────────
    # Brain 2 scores each segment 0-100 via final_scrape_score (preferred) or
    # category_priority_score (backward compat). final_scrape_score blends
    # commercial opportunity with SME accessibility.
    # Only segments above CATEGORY_MIN_SCORE_TO_SCRAPE are passed to Brain 3,
    # capped at WEB_MAX_CATEGORIES_TO_SCRAPE.

    def _scrape_score(seg: dict) -> int:
        """final_scrape_score when present, else category_priority_score."""
        return int(seg.get("final_scrape_score") or seg.get("category_priority_score") or 0)

    has_scores = any(s.get("category_priority_score") is not None for s in all_segs)

    if has_scores:
        above_threshold = [s for s in all_segs if _scrape_score(s) >= CATEGORY_MIN_SCORE_TO_SCRAPE]
        segments = sorted(above_threshold, key=lambda s: -_scrape_score(s))[:WEB_MAX_CATEGORIES_TO_SCRAPE]

        if not segments:
            # Nothing above threshold — fall back to top N by score (don't skip the event)
            log.warning("  No segments above threshold (%d) — using top %d by score",
                        CATEGORY_MIN_SCORE_TO_SCRAPE, WEB_MAX_CATEGORIES_TO_SCRAPE)
            segments = sorted(all_segs, key=lambda s: -_scrape_score(s))[:WEB_MAX_CATEGORIES_TO_SCRAPE]

        # Show direct vs second_order breakdown
        direct_count = sum(1 for s in segments if s.get("direct_or_second_order","direct") == "direct")
        second_count = len(segments) - direct_count
        score_label = "final_scrape_score" if any(s.get("final_scrape_score") for s in segments) else "category_priority_score"
        log.info("  Category priority: %d/%d segments selected (threshold=%d, max=%d, score=%s, direct=%d, 2nd-order=%d)",
                 len(segments), len(all_segs), CATEGORY_MIN_SCORE_TO_SCRAPE, WEB_MAX_CATEGORIES_TO_SCRAPE,
                 score_label, direct_count, second_count)
        for seg in segments:
            fss = seg.get("final_scrape_score") or "—"
            cps = seg.get("category_priority_score") or "—"
            sme = seg.get("sme_accessibility_score") or "—"
            d2  = seg.get("direct_or_second_order") or "?"
            log.info("    [fss=%s cps=%s sme=%s %s] %s", fss, cps, sme, d2, seg.get("segment_name","?"))
    else:
        # Old format: position-based cap (backward compat)
        if breadth in ("broad_currency", "broad_macro"):
            seg_limit = WEB_MAX_SEGMENTS_PER_EVENT
        else:
            seg_limit = max(4, WEB_MAX_SEGMENTS_PER_EVENT // 2)
        segments = all_segs[:seg_limit]
        log.info("  No category scores — using position cap (%d segments)", len(segments))

    if not segments:
        log.info("  No target segments — skipping event")
        return 0

    # Build domain + company_number indices for dedup
    domain_index: dict[str, str] = {}  # domain → lead_id
    cn_index:     dict[str, list] = {}  # company_number → [lead_ids]
    for lid, lead in leads.items():
        d  = lead.get("website_domain") or domain_from_url(lead.get("website", ""))
        cn = lead.get("company_number")
        if d:
            domain_index[d] = lid
        if cn:
            cn_index.setdefault(cn, []).append(lid)

    seen_this_event: set = set()

    for seg in segments:
        seg_name    = seg.get("segment_name", "(unnamed)")
        seg_signals = seg.get("segment_signals", [])
        micro_cats  = seg.get("micro_categories", [])[:WEB_MAX_MICRO_CATEGORIES_PER_SEGMENT]

        if micro_cats:
            # New format: collect queries from all micro-categories
            queries = []
            for mc in micro_cats:
                mc_queries = mc.get("search_queries", [])[:WEB_MAX_QUERIES_PER_MICRO_CATEGORY]
                queries.extend(mc_queries)
            log.info("    Segment: %s (%d micro-cats, %d queries)",
                     seg_name[:55], len(micro_cats), len(queries))
            stats["segments_searched"]    = stats.get("segments_searched", 0) + 1
            stats["micro_cats_searched"]  = stats.get("micro_cats_searched", 0) + len(micro_cats)
        else:
            # Backward compat: flat query format (old events without micro_categories)
            queries = seg.get("high_intent_search_queries", [])[:WEB_MAX_QUERIES_PER_SEGMENT]
            log.info("    Segment: %s (%d queries)", seg_name[:55], len(queries))
            stats["segments_searched"] = stats.get("segments_searched", 0) + 1

        if not queries:
            continue

        for query in queries:
            log.info("      Query: %s", query[:72])
            stats["queries_run"] += 1

            # ── Primary: DDG search ─────────────────────────────────────────
            results, ddg_meta = ddg_search(query, n=WEB_MAX_RESULTS_PER_QUERY)
            ddg_status = ddg_meta["status"]
            stats[f"ddg_{ddg_status}"] = stats.get(f"ddg_{ddg_status}", 0) + 1
            time.sleep(WEB_REQUEST_DELAY + random.uniform(0, 1.5))

            # ── Secondary: Bing HTML when DDG is blocked / timed out ────────
            bing_status = "not_run"
            if not results and ddg_status in ("blocked", "timeout", "empty"):
                bing_results, bing_meta = bing_search(query, n=WEB_MAX_RESULTS_PER_QUERY)
                bing_status = bing_meta["status"]
                stats[f"bing_{bing_status}"] = stats.get(f"bing_{bing_status}", 0) + 1
                if bing_results:
                    results = bing_results
                    stats["bing_candidates_kept"] = (
                        stats.get("bing_candidates_kept", 0) + len(bing_results)
                    )
                    log.debug("      Bing fallback → %d results", len(bing_results))
                # Conservative delay: Bing is the backup, don't hammer it
                time.sleep(WEB_REQUEST_DELAY * 0.9 + random.uniform(0, 1.2))

            # ── Tertiary: CH keyword search when DDG + Bing both fail ───────
            ch_fallback_info = "not_run"
            if not results:
                core_kw = _extract_core_keyword(query)

                # Skip CH fallback if extracted keyword is a single generic word
                # that will produce irrelevant company name matches
                is_too_generic = (
                    core_kw.lower() in _CH_FALLBACK_TOO_GENERIC
                    or (len(core_kw.split()) == 1 and len(core_kw) <= 4)
                )
                if is_too_generic:
                    log.debug("      CH fallback skip: core keyword %r too generic", core_kw)
                    stats["ch_fallback_skipped_generic"] = stats.get("ch_fallback_skipped_generic", 0) + 1
                    ch_fallback_info = f"skipped(generic={core_kw!r})"
                else:
                    log.debug("      DDG=%s Bing=%s → CH fallback: %r → core=%r",
                              ddg_status, bing_status, query[:35], core_kw)
                    ch_results = ch_keyword_search(query, max_results=WEB_MAX_RESULTS_PER_QUERY)
                    stats["ch_fallback_used"] = stats.get("ch_fallback_used", 0) + 1

                    if ch_results:
                        # For CH candidates without URLs, try domain guessing
                        for r in ch_results:
                            if not r.get("url"):
                                guessed = _guess_website_for_ch(r["title"], r.get("ch_number",""))
                                r["url"] = guessed
                        results = [r for r in ch_results if r.get("url")]
                        no_url_count = len(ch_results) - len(results)
                        ch_fallback_info = f"ch={len(ch_results)}_candidates,usable={len(results)},no_url={no_url_count}"
                        log.debug("      CH fallback → %d/%d candidates with URLs", len(results), len(ch_results))
                        if no_url_count:
                            stats["ch_candidates_no_url"] = stats.get("ch_candidates_no_url", 0) + no_url_count
                    else:
                        ch_fallback_info = f"ch=0_candidates(core={core_kw!r})"
                        stats["ch_zero_candidates"] = stats.get("ch_zero_candidates", 0) + 1

            if not results:
                # Build a compact source summary for the INFO log
                _src_parts = [f"DDG={ddg_status}"]
                if bing_status != "not_run":
                    _src_parts.append(f"Bing={bing_status}")
                if ch_fallback_info != "not_run":
                    _src_parts.append(f"CH={ch_fallback_info}")
                log.info("      ✗ 0 candidates: %s", " | ".join(_src_parts))
                stats["query_dead_end"] = stats.get("query_dead_end", 0) + 1
                continue

            for result in results:
                stats["raw_candidates"] = stats.get("raw_candidates", 0) + 1
                url    = result.get("url", "")
                title  = result.get("title", "")
                domain = domain_from_url(url) if url else None

                if not url or not domain:
                    stats["rejected_no_domain"] = stats.get("rejected_no_domain",0)+1
                    continue

                # Dedup by domain within this event
                if domain in seen_this_event:
                    stats["rejected_duplicate"] = stats.get("rejected_duplicate",0)+1
                    continue

                # Dedup by domain across all leads for THIS event
                existing_lid = domain_index.get(domain)
                if existing_lid and leads[existing_lid].get("event_id") == event_id:
                    stats["rejected_duplicate"] = stats.get("rejected_duplicate",0)+1
                    seen_this_event.add(domain)
                    continue

                seen_this_event.add(domain)

                # Domain–name coherence check
                if not domain_coherent_with_name(domain, title):
                    log.debug("      Skip: domain %s incoherent with %r", domain, title[:40])
                    stats["rejected_incoherent"] = stats.get("rejected_incoherent",0)+1
                    continue

                # ── Validate website ────────────────────────────────────────
                name_tok = name_tokens(title)
                val = validate_website(url, name_tok, seg_signals)
                time.sleep(WEB_REQUEST_DELAY * 0.3 + random.uniform(0, 0.5))

                if val.get("reject_reason"):
                    log.debug("      Rejected (%s): %s", val["reject_reason"], url[:60])
                    stats["rejected_validation"] = stats.get("rejected_validation",0)+1
                    continue

                # Reject if negative signals dominate
                neg = val.get("negative_signals", [])
                fx  = val.get("fx_signals", [])
                b2b = val.get("b2b_signals", [])
                if len(neg) > max(len(fx), len(b2b)):
                    log.debug("      Rejected (negatives dominate): %s", url[:60])
                    stats["rejected_negative"] = stats.get("rejected_negative",0)+1
                    continue

                # Reject if zero positive signals
                if not fx and not b2b and len(val.get("secondary_signals",[])) < 2:
                    log.debug("      Rejected (no signals): %s", url[:60])
                    stats["rejected_no_signals"] = stats.get("rejected_no_signals",0)+1
                    continue

                conf = val.get("website_confidence","none")
                stats[f"conf_{conf}"] = stats.get(f"conf_{conf}",0)+1

                # ── CH validation ───────────────────────────────────────────
                ch_data = None
                already_known_cn = False  # flag: this company already has a lead
                if conf in ("high","medium") and COMPANIES_HOUSE_API_KEY:
                    ch_data = ch_validate(title, domain)
                    time.sleep(WEB_REQUEST_DELAY * 0.4 + random.uniform(0, 0.3))

                    # Multi-event trigger: same company_number already exists
                    if ch_data and ch_data.get("company_number"):
                        cn = ch_data["company_number"]
                        if cn in cn_index:
                            already_known_cn = True
                            for elid in cn_index[cn]:
                                el = leads[elid]
                                if event_id not in el.get("linked_event_ids",
                                                          [el.get("event_id","")]):
                                    prev  = el.get("multi_event_count", 1)
                                    boost = min(8, prev * 4)
                                    el["multi_event_trigger"] = True
                                    el["multi_event_count"]   = prev + 1
                                    el.setdefault("linked_event_ids",
                                                  [el.get("event_id","")]).append(event_id)
                                    el["score"] = min(100, el.get("score",0) + boost)
                                    el["scoring_reasons"].append(
                                        f"Multi-event: also exposed via "
                                        f"'{event.get('headline','')}' (+{boost})"
                                    )
                                    s = el["score"]
                                    el["priority"] = (
                                        "HOT" if s>=80 else "WARM" if s>=60
                                        else "QUEUE" if s>=40 else "SKIP"
                                    )
                                    log.info("        ↑ Multi-event +%d: %s",
                                             boost, el.get("company_name","")[:35])
                                    stats["multi_event_updates"] = (
                                        stats.get("multi_event_updates",0)+1)

                # If company is already known (same CN, different event), don't
                # create a duplicate lead — the multi-event boost is enough.
                if already_known_cn:
                    log.debug("      Skipping duplicate CN (multi-event updated): %s", title[:40])
                    stats["rejected_duplicate"] = stats.get("rejected_duplicate",0)+1
                    continue

                stats["validated_companies"] = stats.get("validated_companies", 0) + 1

                # ── Score ───────────────────────────────────────────────────
                s, priority, reasons = score_web_lead(val, ch_data, seg, event)

                if priority == "SKIP":
                    log.debug("      SKIP (%d): %s", s, url[:60])
                    stats["rejected_low_score"] = stats.get("rejected_low_score",0)+1
                    continue

                # ── Create lead ─────────────────────────────────────────────
                # Track which source method actually found this company
                if result.get("from_ch"):
                    _website_source = "ch_fallback"
                elif result.get("from_bing"):
                    _website_source = "bing_search"
                elif result.get("from_source_page"):
                    _website_source = "source_page"
                else:
                    _website_source = "ddg_search"

                lid, lead = create_lead(
                    url=url, domain=domain, search_title=title,
                    validation=val, ch_data=ch_data,
                    segment=seg, event=event, event_id=event_id,
                    score=s, priority=priority, reasons=reasons,
                    website_source=_website_source,
                )

                domain_index[domain] = lid
                if ch_data and ch_data.get("company_number"):
                    cn_index.setdefault(ch_data["company_number"],[]).append(lid)

                leads[lid] = lead
                added += 1

                stats[f"p_{priority}"] = stats.get(f"p_{priority}",0)+1
                log.info("        ✓ [%s %d] %s — %s [src=%s]", priority, s,
                         lead["company_name"][:35], domain, _website_source)

    return added


# ── QUALITY SUMMARY ───────────────────────────────────────────────────────────

def print_quality_summary(stats: dict, leads: dict):
    web_leads = [(lid, v) for lid, v in leads.items()
                 if v.get("company_source") == "web_search"]

    elapsed = time.time() - stats.get("start_time", time.time())
    mins, secs = divmod(int(elapsed), 60)
    call_ready = stats.get("p_HOT", 0) + stats.get("p_WARM", 0)

    log.info("")
    log.info("══════════════════════════════════════════")
    log.info("  RUN SUMMARY")
    log.info("  Events processed:        %d", stats.get("events_processed", 0))
    log.info("  Segments searched:       %d", stats.get("segments_searched", 0))
    log.info("  Micro-categories:        %d", stats.get("micro_cats_searched", 0))
    log.info("  Queries run:             %d", stats.get("queries_run", 0))
    log.info("  Raw candidates seen:     %d", stats.get("raw_candidates", 0))
    log.info("  Validated companies:     %d", stats.get("validated_companies", 0))
    log.info("  Duplicates rejected:     %d", stats.get("rejected_duplicate", 0))
    log.info("  Call-ready (HOT/WARM):   %d", call_ready)
    log.info("  Runtime:                 %dm %ds", mins, secs)
    log.info("══════════════════════════════════════════")
    log.info("  Web Discovery Detail")
    log.info("  ────────────────────────────────────────")
    log.info("  Query dead-ends:         %d", stats.get("query_dead_end",0))
    log.info("  DDG — ok:                %d", stats.get("ddg_ok",0))
    log.info("  DDG — blocked/timeout:   %d", stats.get("ddg_blocked",0) + stats.get("ddg_timeout",0))
    log.info("  DDG — empty (0 results): %d", stats.get("ddg_empty",0))
    log.info("  DDG — filtered:          %d", stats.get("ddg_filtered",0))
    log.info("  Bing — ok:               %d", stats.get("bing_ok",0))
    log.info("  Bing — blocked/timeout:  %d", stats.get("bing_blocked",0) + stats.get("bing_timeout",0))
    log.info("  Bing — empty:            %d", stats.get("bing_empty",0))
    log.info("  Bing — filtered:         %d", stats.get("bing_filtered",0))
    log.info("  Bing candidates kept:    %d", stats.get("bing_candidates_kept",0))
    log.info("  CH fallback used:        %d", stats.get("ch_fallback_used",0))
    log.info("  CH fallback skipped (generic kw): %d", stats.get("ch_fallback_skipped_generic",0))
    log.info("  CH zero candidates:      %d", stats.get("ch_zero_candidates",0))
    log.info("  CH candidates, no URL:   %d", stats.get("ch_candidates_no_url",0))
    log.info("  Source pages mined:      %d", stats.get("source_pages_mined",0))
    log.info("  Source-page extracted:   %d", stats.get("source_page_extracted",0))
    log.info("  ────────────────────────────────────────")
    log.info("  Rejected (duplicate):   %d", stats.get("rejected_duplicate",0))
    log.info("  Rejected (incoherent):  %d", stats.get("rejected_incoherent",0))
    log.info("  Rejected (validation):  %d", stats.get("rejected_validation",0))
    log.info("  Rejected (negative):    %d", stats.get("rejected_negative",0))
    log.info("  Rejected (no signal):   %d", stats.get("rejected_no_signals",0))
    log.info("  Rejected (low score):   %d", stats.get("rejected_low_score",0))
    log.info("  Multi-event updates:    %d", stats.get("multi_event_updates",0))
    log.info("  ────────────────────────────────────────")
    log.info("  Confidence — high:      %d", stats.get("conf_high",0))
    log.info("  Confidence — medium:    %d", stats.get("conf_medium",0))
    log.info("  Confidence — low:       %d", stats.get("conf_low",0))
    log.info("  ────────────────────────────────────────")
    log.info("  HOT added:   %d", stats.get("p_HOT",0))
    log.info("  WARM added:  %d", stats.get("p_WARM",0))
    log.info("  QUEUE added: %d", stats.get("p_QUEUE",0))
    log.info("  Total web leads: %d", stats.get("leads_added",0))
    log.info("  ────────────────────────────────────────")
    log.info("  Leads by source:")
    _src_counts: dict = {}
    for _, _l in web_leads:
        _s = _l.get("website_source", "unknown")
        _src_counts[_s] = _src_counts.get(_s, 0) + 1
    for _src in ("ddg_search", "bing_search", "ch_fallback", "source_page"):
        log.info("    %-22s %d", _src, _src_counts.get(_src, 0))
    log.info("══════════════════════════════════════════")

    top = sorted(web_leads, key=lambda x: -x[1].get("score",0))[:10]
    if top:
        log.info("  Top web leads by score:")
        for lid, l in top:
            fx_n = len(l.get("fx_payment_signals",[]))
            log.info("    [%s %d] %s — %s  (FX:%d, CH:%s)",
                     l.get("priority","?"), l.get("score",0),
                     l.get("company_name","")[:32], l.get("website_domain",""),
                     fx_n, "✓" if l.get("company_number") else "—")
    log.info("")


# ── MAIN ──────────────────────────────────────────────────────────────────────

def main():
    if not WEB_DISCOVERY_ENABLED:
        log.info("Web discovery disabled (WEB_DISCOVERY_ENABLED=false) — skipping")
        return

    if not COMPANIES_HOUSE_API_KEY:
        log.warning("COMPANIES_HOUSE_API_KEY not set — CH validation skipped")

    log.info("=== Web-First Discovery ===")
    log.info("Config: events=%d  segs=%d  micro-cats=%d  q/micro-cat=%d  results=%d  delay=%.1fs",
             WEB_MAX_EVENTS, WEB_MAX_SEGMENTS_PER_EVENT,
             WEB_MAX_MICRO_CATEGORIES_PER_SEGMENT, WEB_MAX_QUERIES_PER_MICRO_CATEGORY,
             WEB_MAX_RESULTS_PER_QUERY, WEB_REQUEST_DELAY)

    events = json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
    leads  = json.loads(LEADS_FILE.read_text())  if LEADS_FILE.exists()  else {}

    if not events:
        log.warning("No events found in %s", EVENTS_FILE)
        return

    # Select events that have segments and haven't been web-discovered yet
    ready = {eid: ev for eid, ev in events.items()
             if ev.get("target_segments") and not ev.get("web_discovery_done")}
    if not ready:
        # Re-process all events if all are already done
        ready = {eid: ev for eid, ev in events.items() if ev.get("target_segments")}

    ready = dict(list(ready.items())[:WEB_MAX_EVENTS])
    log.info("Events to process: %d / %d", len(ready), len(events))

    stats = {
        "queries_run": 0,
        "leads_added": 0,
        "segments_searched": 0,
        "micro_cats_searched": 0,
        "raw_candidates": 0,
        "validated_companies": 0,
        "events_processed": 0,
        "start_time": time.time(),
    }

    for event_id, event in ready.items():
        headline = event.get("headline", event.get("title", ""))[:65]
        log.info("")
        log.info("── Event: %s", headline)

        n = process_event(event, event_id, leads, stats)
        stats["leads_added"] += n
        stats["events_processed"] += 1

        events[event_id]["web_discovery_done"] = True
        events[event_id]["web_discovery_at"]   = now_iso()

        log.info("  └─ %d leads added", n)

        # Incremental save
        LEADS_FILE.write_text(json.dumps(leads, indent=2, default=str))
        EVENTS_FILE.write_text(json.dumps(events, indent=2, default=str))

    LEADS_FILE.write_text(json.dumps(leads, indent=2, default=str))
    EVENTS_FILE.write_text(json.dumps(events, indent=2, default=str))

    public = Path(__file__).parent.parent / "public" / "data"
    public.mkdir(parents=True, exist_ok=True)
    (public / "leads.json").write_text(LEADS_FILE.read_text())

    print_quality_summary(stats, leads)
    log.info("=== Done — %d leads added, %d total ===", stats["leads_added"], len(leads))


if __name__ == "__main__":
    main()
