"""
enrich_website_intelligence.py — Extract business intelligence from company websites.

For each lead, crawls product/supplier/trade/about pages and extracts:
  1. FX evidence snippets  — actual sentences from the website proving exposure
  2. Country evidence       — Italy, Germany, USA etc. found in context
  3. Supplier evidence      — "European suppliers", "Italian producers" etc.
  4. Import/export evidence — "imported from", "sourced from", "direct from"
  5. Inferred currency pairs — countries → GBP/EUR, GBP/USD etc.
  6. Currency reason        — human-readable "why this pair" sentence
  7. Size signals           — warehouse, nationwide, trade customers, etc.
  8. FX likelihood score    — 0-100, separate from route_grade (contact quality)
  9. Website confidence reason — human-readable explanation of confidence level

Run AFTER discover_web.py/enrich_contacts.py and BEFORE final rescore.
  python3.11 scripts/enrich_website_intelligence.py [--force]

Idempotent — re-running skips already-enriched leads unless --force given.
"""

import json, re, sys, time, logging, os
from pathlib import Path
from urllib.parse import urlparse, urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

ROOT      = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "leads.json"

# ── Config ────────────────────────────────────────────────────────────────────
WEB_TIMEOUT      = (5, 14)
WORKERS          = 8
MAX_PAGES        = 6             # pages to crawl per company for intelligence
MAX_SNIPPETS     = 5             # max evidence snippets to store
CHECKPOINT_EVERY = 50
FORCE_REFRESH    = "--force" in sys.argv

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Accept-Language": "en-GB,en;q=0.9",
}
SESSION = requests.Session()
SESSION.headers.update(HEADERS)

# ── Bad domain blocklist (Python mirror of packages/pipeline/src/sources/blocklists.ts) ──
SKIP_DOMAINS = {
    # Directories / listings
    "yell.com","yell.co.uk","yelp.com","yelp.co.uk","freeindex.co.uk","thomsonlocal.com",
    "scoot.co.uk","cylex.co.uk","cylex-uk.co.uk","hotfrog.co.uk","brownbook.net","misterwhat.co.uk",
    "kompass.com","uk.kompass.com","checkatrade.com","ratedpeople.com","bark.com","rated.co.uk",
    "mybuilder.com","trustatrader.com","trustmark.org.uk","getapp.co.uk","bizwiki.co.uk","192.com",
    "ukbusinessdirectory.co.uk","thewholesaler.co.uk","europages.com","europages.co.uk",
    "thomasnet.com","globalspec.com","techpages.com","kompass.fr","wlw.de","firmendb.de",
    # Company intelligence / aggregators
    "companieshouse.gov.uk","find-and-update.company-information.service.gov.uk",
    "endole.co.uk","duedil.com","creditsafe.com","experian.co.uk","equifax.co.uk",
    "crunchbase.com","opencorporates.com","companycheck.co.uk","companydata.co.uk",
    "bizdb.co.uk","globaldata.com","ibisworld.com","statista.com","zoominfo.com",
    "apollo.io","leadiq.com","hunter.io","rocketreach.co","craft.co","ensun.io",
    # Review / comparison
    "trustpilot.com","reviews.co.uk","reviews.io","reevoo.com","feefo.com",
    "which.co.uk","moneysavingexpert.com","comparethemarket.com","glassdoor.com",
    "tripadvisor.com","tripadvisor.co.uk","booking.com","airbnb.com","airbnb.co.uk",
    # Social media
    "linkedin.com","facebook.com","instagram.com","twitter.com","x.com","tiktok.com",
    "youtube.com","pinterest.com","reddit.com","whatsapp.com","telegram.org","snapchat.com",
    # News / media
    "bbc.co.uk","bbc.com","reuters.com","ft.com","bloomberg.com","theguardian.com",
    "telegraph.co.uk","thetimes.co.uk","independent.co.uk","dailymail.co.uk","sky.com",
    "forbes.com","businessinsider.com","cityam.com","thegrocer.co.uk","foodmanufacture.co.uk",
    "just-drinks.com","thedrinksbusiness.com","decanter.com","harpers.co.uk",
    "foodnavigator.com","seafoodsource.com","undercurrentnews.com","chemweek.com",
    "wired.com","techcrunch.com","venturebeat.com","marketwatch.com","wsj.com",
    # Government / NGO
    "gov.uk","hmrc.gov.uk","legislation.gov.uk","parliament.uk","nhs.uk","fca.org.uk",
    "food.gov.uk","wsta.co.uk","scotchwhisky.com","swa.org.uk","fdf.org.uk","seafish.org",
    # Marketplaces
    "amazon.co.uk","amazon.com","ebay.co.uk","ebay.com","etsy.com","alibaba.com",
    "aliexpress.com","made-in-china.com","globalsources.com","tradekey.com",
    "notonthehighstreet.com","wayfair.co.uk","asos.com","next.co.uk","argos.co.uk",
    "onbuy.com","manomano.co.uk","gumtree.com","preloved.co.uk","depop.com",
    # Job boards
    "reed.co.uk","indeed.com","indeed.co.uk","totaljobs.com","cv-library.co.uk",
    "monster.co.uk","jobs.co.uk","seek.com","caterer.com","michaelpage.co.uk","hays.co.uk",
    # Property
    "rightmove.co.uk","zoopla.co.uk","onthemarket.com","propertypal.com","daft.ie",
    # Reference / search
    "google.com","google.co.uk","bing.com","yahoo.com","duckduckgo.com","wikipedia.org",
}

# ── Intelligence page slugs (business evidence, NOT people) ──────────────────
INTEL_SLUGS = [
    # Product/brand evidence (proves what they sell / source)
    "products", "our-products", "product-range", "range", "brands", "our-brands",
    "catalogue", "catalog", "collections", "collection",
    # Supplier / sourcing evidence (proves WHERE they buy)
    "suppliers", "our-suppliers", "sourcing", "supply-chain",
    "partners", "our-partners", "producer", "producers",
    # Trade / wholesale evidence (proves B2B)
    "wholesale", "trade", "trade-account", "trade-accounts", "trade-customers",
    "distribution", "distributors", "stockists", "resellers",
    # Import/export explicit
    "imports", "exports", "import", "export", "international",
    # Company story (often mentions origins, sourcing countries)
    "about", "about-us", "our-story", "story", "history", "who-we-are",
]

# ── Country → currency pair mapping ──────────────────────────────────────────
# Ordered: check most-specific patterns first
COUNTRY_MAP: list[tuple[str, str, str]] = [
    # EUR zone
    (r"\b(italy|italian)\b",                        "Italy",       "GBP/EUR"),
    (r"\b(france|french)\b",                        "France",      "GBP/EUR"),
    (r"\b(germany|german|deutsch)\b",               "Germany",     "GBP/EUR"),
    (r"\b(spain|spanish)\b",                        "Spain",       "GBP/EUR"),
    (r"\b(portugal|portuguese)\b",                  "Portugal",    "GBP/EUR"),
    (r"\b(netherlands|dutch|holland)\b",            "Netherlands", "GBP/EUR"),
    (r"\b(belgium|belgian)\b",                      "Belgium",     "GBP/EUR"),
    (r"\b(austria|austrian)\b",                     "Austria",     "GBP/EUR"),
    (r"\b(greece|greek|grecian)\b",                 "Greece",      "GBP/EUR"),
    (r"\b(scandinavia\w*|sweden|swedish|denmark|danish|norway|norwegian|finland|finnish)\b",
                                                     "Scandinavia", "GBP/EUR"),
    (r"\b(europe|european|continental)\b",          "Europe",      "GBP/EUR"),
    # USD zone
    (r"\b(usa|united states|america\b|american)\b", "USA",         "GBP/USD"),
    (r"\b(china|chinese|prc)\b",                    "China",       "GBP/USD"),
    (r"\b(hong kong)\b",                            "Hong Kong",   "GBP/USD"),
    (r"\b(india|indian)\b",                         "India",       "GBP/USD"),
    (r"\b(canada|canadian)\b",                      "Canada",      "GBP/USD"),
    (r"\b(asia\b|asian)\b",                         "Asia",        "GBP/USD"),
    (r"\b(global|worldwide|international)\b",       "Global",      "GBP/USD"),
    # Other
    (r"\b(japan|japanese)\b",                       "Japan",       "GBP/JPY"),
    (r"\b(australia|australian)\b",                 "Australia",   "GBP/AUD"),
    (r"\b(new zealand|kiwi)\b",                     "New Zealand", "GBP/AUD"),
    (r"\b(switzerland|swiss)\b",                    "Switzerland", "GBP/CHF"),
    (r"\b(poland|polish)\b",                        "Poland",      "GBP/PLN"),
    (r"\b(south africa|south african)\b",           "South Africa","GBP/ZAR"),
    (r"\b(turkey|turkish)\b",                       "Turkey",      "GBP/TRY"),
    (r"\b(brazil|brazilian)\b",                     "Brazil",      "GBP/USD"),
    (r"\b(mexico|mexican)\b",                       "Mexico",      "GBP/USD"),
    (r"\b(middle east|uae|dubai|saudi)\b",          "Middle East", "GBP/USD"),
]

_COUNTRY_RES = [(re.compile(p, re.IGNORECASE), label, pair) for p, label, pair in COUNTRY_MAP]

# Require country mention to appear NEAR a sourcing/import context word
SOURCING_CONTEXT = re.compile(
    r"(import|export|sourc|supply|supplier|partner|producer|manufacturer|"
    r"warehouse|distrib|wholesale|from|origin|made in|based in|ship)",
    re.IGNORECASE,
)

# ── FX evidence keywords ──────────────────────────────────────────────────────
FX_KEYWORDS = [
    # Direct import/export language
    "import", "importer", "importing", "imported from",
    "export", "exporter", "exporting",
    "direct from", "sourced from", "source from", "sourcing from",
    "shipped from", "manufactured in", "made in", "produced in",
    "origin", "country of origin",
    # Supplier language
    "overseas supplier", "foreign supplier", "international supplier",
    "european supplier", "italian supplier", "german supplier",
    "global supplier", "overseas producer",
    # Payment / currency language
    "pay in euros", "pay in dollars", "eur invoice", "usd invoice",
    "foreign currency", "exchange rate", "fx", "hedging", "hedge",
    "currency risk", "currency exposure",
    # Trade language
    "wholesale", "distributor", "distribution partner",
    "trade account", "trade customer",
]
FX_KW_RE = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in FX_KEYWORDS) + r")\b",
    re.IGNORECASE,
)

# Supplier phrase patterns
SUPPLIER_PHRASE_RE = re.compile(
    r"(sourc\w* (from|directly|in)|import\w* from|direct from|"
    r"(european|italian|french|german|spanish|american|global|overseas) (supplier|producer|manufacturer|partner|brand)|"
    r"(supplier|producer|manufacturer|partner)s? (in|from|across) \w+|"
    r"family.{0,10}(producer|farm|vineyard|winery|grower)|"
    r"(wholesale|trade) (supplier|distributor|partner))",
    re.IGNORECASE,
)

# ── Size signal patterns ──────────────────────────────────────────────────────
SIZE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bwarehouse\b", re.I),                    "warehouse"),
    (re.compile(r"\bdistribution cent(er|re)\b", re.I),     "distribution centre"),
    (re.compile(r"\bnationwide\b", re.I),                   "nationwide"),
    (re.compile(r"\bestab(lished)?\s+(in\s+)?(18|19|20)\d{2}\b", re.I), "long-established"),
    (re.compile(r"\bfamily[\s-](business|company|run|owned)\b", re.I), "family business"),
    (re.compile(r"\btrade (customers?|accounts?|only)\b", re.I),       "trade customers"),
    (re.compile(r"\b(large|extensive|wide|broad)\s+(stock|range|selection|inventory)\b", re.I), "large stock range"),
    (re.compile(r"\bfleet\s+of\b", re.I),                   "vehicle fleet"),
    (re.compile(r"\bshowroom\b", re.I),                     "showroom"),
    (re.compile(r"\bB2B\b"),                                "B2B"),
    (re.compile(r"\bwholesale\b", re.I),                    "wholesale"),
    (re.compile(r"\b(multi.?site|multiple sites?|multiple locations?)\b", re.I), "multi-site"),
    (re.compile(r"\bnational(ly)? deliver\w*\b", re.I),     "national delivery"),
    (re.compile(r"\b\d{2,4}\s+(employees?|staff|people)\b", re.I), "sizeable workforce"),
    (re.compile(r"\b(over|more than)\s+(50|100|200|500)\s+(customers?|clients?)\b", re.I), "large customer base"),
    (re.compile(r"\bexport\w*\s+to\s+\d+\s+(countries|markets)\b", re.I), "exports to multiple countries"),
    (re.compile(r"\b(award.?winning|industry.?leading|market.?leading)\b", re.I), "award-winning"),
]

# ── Website confidence reason ─────────────────────────────────────────────────
def generate_confidence_reason(lead: dict) -> str:
    conf    = (lead.get("website_confidence") or "").lower()
    src     = (lead.get("website_source") or "").replace("_", " ")
    domain  = lead.get("website_domain") or ""
    ch_name = (lead.get("company_name") or "").lower()
    sigs    = len(lead.get("fx_payment_signals") or [])

    if conf in ("high", "confirmed"):
        parts = []
        if sigs >= 3:
            parts.append(f"{sigs} FX/trade signals found on website")
        if src:
            parts.append(f"discovered via {src}")
        if domain and any(tok in domain for tok in ch_name.split()[:2] if len(tok) > 3):
            parts.append("domain name matches company name")
        return "High confidence: " + ("; ".join(parts) if parts else "strong website + signal match")
    elif conf == "medium":
        return "Medium confidence: website found but weaker signal match — worth validating manually"
    elif conf == "low":
        return "Low confidence: website uncertain, check domain before calling"
    elif conf == "guessed":
        return "Guessed: no verified website found — domain inferred from company name"
    return "Unknown: website confidence not assessed"


# ── Page fetching + cleaning ──────────────────────────────────────────────────
def fetch(url: str) -> str:
    try:
        r = SESSION.get(url, timeout=WEB_TIMEOUT, allow_redirects=True)
        ct = r.headers.get("content-type", "")
        if r.ok and "text/html" in ct:
            return r.text[:600_000]
    except Exception:
        pass
    return ""


def head_ok(url: str) -> bool:
    try:
        r = SESSION.head(url, timeout=(3, 6), allow_redirects=True)
        return r.ok
    except Exception:
        return False


def domain_of(url: str) -> str:
    try:
        h = urlparse(url).hostname or ""
        return re.sub(r"^www\d*\.", "", h.lower())
    except Exception:
        return ""


def is_bad_domain(url: str) -> bool:
    d = domain_of(url)
    if not d:
        return True
    for bad in SKIP_DOMAINS:
        if d == bad or d.endswith(f".{bad}"):
            return True
    return False


def html_to_text(html: str) -> str:
    """Strip HTML tags, collapse whitespace."""
    text = re.sub(r"<script[^>]*>.*?</script>", " ", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&[a-z#0-9]+;", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


# ── Intelligence page discovery ───────────────────────────────────────────────
def discover_intel_pages(lead: dict) -> list[str]:
    """
    Find business-evidence pages: product/supplier/trade/about.
    Separate from DM enrichment which focuses on team/leadership pages.
    """
    website = (lead.get("website") or "").rstrip("/")
    if not website or is_bad_domain(website):
        return []

    candidates: list[str] = [website]   # always include homepage

    # Known pages already stored by pipeline
    for field in ("about_page", "contact_page"):
        url = lead.get(field)
        if url and url not in candidates and not is_bad_domain(url):
            candidates.append(url)

    # Probe slugs with HEAD requests
    for slug in INTEL_SLUGS:
        if len(candidates) >= MAX_PAGES:
            break
        url = f"{website}/{slug}"
        if url not in candidates and head_ok(url):
            candidates.append(url)

    return candidates[:MAX_PAGES]


# ── Evidence extraction ───────────────────────────────────────────────────────
def extract_evidence_snippets(text: str, max_n: int = MAX_SNIPPETS) -> list[str]:
    """
    Find the most FX-relevant sentences from clean page text.
    Returns actual website text — the gold for call openers.
    """
    # Split on sentence boundaries
    sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z\d])", text)
    scored: list[tuple[int, str]] = []

    for sent in sentences:
        sent = sent.strip()
        if len(sent) < 30 or len(sent) > 400:
            continue
        # Skip navigation / boilerplate snippets
        if re.match(r"^(click|read|learn|find out|discover|contact us|call us|home|menu)", sent, re.I):
            continue
        kw_hits = len(FX_KW_RE.findall(sent))
        if kw_hits == 0:
            continue
        # Bonus for supplier/country language
        bonus = len(SUPPLIER_PHRASE_RE.findall(sent))
        score = kw_hits * 2 + bonus * 3
        scored.append((score, sent))

    scored.sort(key=lambda x: -x[0])

    # Deduplicate (skip near-duplicates)
    seen_prefixes: set[str] = set()
    snippets = []
    for _, sent in scored:
        prefix = sent[:40].lower().strip()
        if prefix in seen_prefixes:
            continue
        seen_prefixes.add(prefix)
        snippets.append(sent)
        if len(snippets) >= max_n:
            break

    return snippets


def extract_country_evidence(text: str) -> tuple[list[str], list[str]]:
    """
    Returns (countries_found, currency_pairs_inferred).
    Only matches countries that appear near a sourcing/trade context word.
    """
    countries: list[str] = []
    pairs: list[str] = []
    seen_countries: set[str] = set()
    seen_pairs: set[str] = set()

    # Scan in a sliding window — country must be within 150 chars of a sourcing word
    for cre, label, pair in _COUNTRY_RES:
        for m in cre.finditer(text):
            start = max(0, m.start() - 150)
            end   = min(len(text), m.end() + 150)
            window = text[start:end]
            if SOURCING_CONTEXT.search(window):
                if label not in seen_countries:
                    seen_countries.add(label)
                    countries.append(label)
                if pair not in seen_pairs:
                    seen_pairs.add(pair)
                    pairs.append(pair)

    return countries, pairs


def extract_supplier_evidence(text: str) -> list[str]:
    """
    Find specific supplier/sourcing phrases from website text.
    These are the phrases that become call openers.
    """
    phrases: list[str] = []
    seen: set[str] = set()
    for m in SUPPLIER_PHRASE_RE.finditer(text):
        # Get the broader context (the sentence containing the match)
        start = max(0, m.start() - 30)
        end   = min(len(text), m.end() + 80)
        chunk = text[start:end].strip()
        chunk = re.sub(r"\s+", " ", chunk)
        # Trim to ~120 chars
        if len(chunk) > 120:
            chunk = chunk[:120].rsplit(" ", 1)[0] + "…"
        key = chunk[:40].lower()
        if key not in seen and len(chunk) > 20:
            seen.add(key)
            phrases.append(chunk)
            if len(phrases) >= 5:
                break
    return phrases


def extract_import_export_evidence(text: str) -> list[str]:
    """Specific import/export/sourcing phrases."""
    ie_re = re.compile(
        r"(import\w*\s+from\s+\w+|export\w*\s+to\s+\w+|sourc\w*\s+(directly\s+)?from\s+\w+|"
        r"direct\s+from\s+\w+|made\s+in\s+\w+|produced\s+in\s+\w+|"
        r"(our\s+)?supplier[s]?\s+(in|from|across)\s+\w+|"
        r"(manufactured|produced|grown|harvested)\s+(in|by)\s+\w+)",
        re.IGNORECASE,
    )
    found: list[str] = []
    seen: set[str] = set()
    for m in ie_re.finditer(text):
        phrase = m.group(0).strip()
        key    = phrase.lower()[:30]
        if key not in seen:
            seen.add(key)
            found.append(phrase)
            if len(found) >= 5:
                break
    return found


def extract_size_signals(text: str) -> list[str]:
    """Find business-size indicators."""
    signals: list[str] = []
    seen: set[str] = set()
    for pattern, label in SIZE_PATTERNS:
        if label in seen:
            continue
        if pattern.search(text):
            seen.add(label)
            signals.append(label)
    return signals[:8]


# ── Currency reason sentence ──────────────────────────────────────────────────
def build_currency_reason(countries: list[str], pairs: list[str], snippets: list[str]) -> str:
    """Generate a human-readable reason for the inferred currency pair."""
    if not pairs:
        return ""

    primary_pair = pairs[0]
    country_str  = ", ".join(countries[:3])

    # Try to use an actual website snippet as the hook
    best_snippet = ""
    for s in snippets[:3]:
        if len(s) < 200:
            best_snippet = s
            break

    if best_snippet:
        return f"Website mentions {country_str} → likely {primary_pair} exposure. Evidence: \"{best_snippet[:120]}\""
    elif country_str:
        return f"Website mentions {country_str} in a sourcing/trade context → likely {primary_pair} exposure"
    else:
        return f"Inferred {primary_pair} from trade language on website"


# ── FX likelihood score ───────────────────────────────────────────────────────
def compute_fx_likelihood(lead: dict, evidence: dict) -> int:
    """
    0-100 score for how likely this company actually HAS FX payment exposure.
    Route grade (A-E) = contact quality. FX likelihood = evidence quality.
    Best leads: high FX likelihood + grade A/B route.
    """
    score = 0

    # Evidence snippets (actual text from website) — max 28
    n_snippets = len(evidence.get("fx_evidence_snippets") or [])
    score += min(28, n_snippets * 8)

    # Supplier evidence phrases — max 20
    n_supplier = len(evidence.get("supplier_evidence") or [])
    score += min(20, n_supplier * 7)

    # Country evidence with currency inference — max 22
    n_countries = len(evidence.get("country_evidence") or [])
    n_pairs     = len(evidence.get("inferred_currency_pairs") or [])
    if n_countries:
        score += min(14, n_countries * 5)
    if n_pairs:
        score += 8

    # Import/export explicit phrases — max 15
    n_ie = len(evidence.get("import_export_evidence") or [])
    score += min(15, n_ie * 5)

    # Existing FX payment signals from pipeline — max 10
    existing_sigs = len(lead.get("fx_payment_signals") or [])
    score += min(10, existing_sigs * 3)

    # Size signals (bigger company = more FX) — max 5
    n_size = len(evidence.get("size_signals") or [])
    if n_size >= 2:
        score += 5
    elif n_size == 1:
        score += 2

    return min(100, score)


# ── Core enrichment per lead ──────────────────────────────────────────────────
def enrich_lead_intelligence(lead: dict) -> dict:
    website = lead.get("website", "")
    if not website or is_bad_domain(website):
        # Still generate confidence reason from existing data
        lead["website_confidence_reason"] = generate_confidence_reason(lead)
        if not lead.get("fx_likelihood_score"):
            lead["fx_likelihood_score"] = 0
        return lead

    # ── 1. Discover and crawl pages ──────────────────────────────────
    pages = discover_intel_pages(lead)
    combined_text = ""

    for url in pages:
        html = fetch(url)
        if html:
            combined_text += " " + html_to_text(html)

    combined_text = re.sub(r"\s+", " ", combined_text).strip()

    # ── 2. Extract intelligence ──────────────────────────────────────
    snippets     = extract_evidence_snippets(combined_text)
    countries, pairs = extract_country_evidence(combined_text)
    supplier_ev  = extract_supplier_evidence(combined_text)
    ie_evidence  = extract_import_export_evidence(combined_text)
    size_signals = extract_size_signals(combined_text)
    curr_reason  = build_currency_reason(countries, pairs, snippets)
    conf_reason  = generate_confidence_reason(lead)

    evidence = {
        "fx_evidence_snippets":   snippets,
        "country_evidence":       countries,
        "supplier_evidence":      supplier_ev,
        "import_export_evidence": ie_evidence,
        "inferred_currency_pairs":pairs,
        "currency_reason":        curr_reason,
        "size_signals":           size_signals,
    }

    fx_score = compute_fx_likelihood(lead, evidence)

    # ── 3. Write to lead ─────────────────────────────────────────────
    lead["fx_evidence_snippets"]    = snippets
    lead["country_evidence"]        = countries
    lead["supplier_evidence"]       = supplier_ev
    lead["import_export_evidence"]  = ie_evidence
    lead["inferred_currency_pairs"] = pairs
    lead["currency_reason"]         = curr_reason
    lead["size_signals"]            = size_signals
    lead["fx_likelihood_score"]     = fx_score
    lead["website_confidence_reason"] = conf_reason

    # Merge inferred currency pairs into existing fx_exposure (if not already there)
    existing_exposure = lead.get("fx_exposure") or ""
    for p in pairs:
        if p not in existing_exposure:
            existing_exposure = (existing_exposure + f", {p}").strip(", ")
    if existing_exposure:
        lead["fx_exposure"] = existing_exposure

    return lead


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    log.info("=== Website Intelligence Enrichment ===")
    if FORCE_REFRESH:
        log.info("  --force: re-enriching all leads")

    with open(DATA_FILE) as f:
        data = json.load(f)

    is_dict = isinstance(data, dict)
    leads   = list(data.values()) if is_dict else data
    keys    = list(data.keys())   if is_dict else None

    to_process = [
        i for i, l in enumerate(leads)
        if FORCE_REFRESH or not l.get("fx_likelihood_score")
    ]

    log.info("To process: %d leads  |  Skipping %d", len(to_process), len(leads) - len(to_process))

    enriched = found_snippets = found_countries = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(enrich_lead_intelligence, leads[i]): i for i in to_process}
        done = 0
        for future in as_completed(futures):
            idx = futures[future]
            done += 1
            try:
                updated    = future.result()
                leads[idx] = updated
                enriched  += 1
                snips = len(updated.get("fx_evidence_snippets") or [])
                ctrs  = len(updated.get("country_evidence") or [])
                pairs = updated.get("inferred_currency_pairs") or []
                fxs   = updated.get("fx_likelihood_score", 0)
                if snips:
                    found_snippets += 1
                if ctrs:
                    found_countries += 1

                if snips > 0 or pairs:
                    log.info(
                        "[%d/%d] ✓ %-40s  FX:%d%%  %d snippets  %s",
                        done, len(to_process),
                        updated.get("company_name","?")[:40],
                        fxs, snips,
                        " ".join(pairs[:2]) or "no pairs",
                    )
                else:
                    log.info(
                        "[%d/%d]   %-40s  FX:%d%%",
                        done, len(to_process),
                        updated.get("company_name","?")[:40],
                        fxs,
                    )
            except Exception as e:
                log.warning("[%d/%d] Error %s: %s",
                           done, len(to_process), leads[idx].get("company_name","?"), e)

            if done % CHECKPOINT_EVERY == 0:
                _save(data, leads, keys, is_dict)
                log.info("  ── checkpoint %d/%d ──", done, len(to_process))

    _save(data, leads, keys, is_dict)

    import shutil
    for dst in [
        ROOT / "public" / "data" / "leads.json",
        ROOT / "apps" / "web" / "public" / "data" / "leads.json",
    ]:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DATA_FILE, dst)

    # FX likelihood distribution
    buckets = {"80+": 0, "60-79": 0, "40-59": 0, "20-39": 0, "<20": 0}
    for l in leads:
        s = l.get("fx_likelihood_score", 0)
        if s >= 80: buckets["80+"] += 1
        elif s >= 60: buckets["60-79"] += 1
        elif s >= 40: buckets["40-59"] += 1
        elif s >= 20: buckets["20-39"] += 1
        else: buckets["<20"] += 1

    log.info(
        "=== Done — %d enriched | %d with evidence snippets | %d with country inference ===",
        enriched, found_snippets, found_countries,
    )
    log.info("FX likelihood distribution: %s",
             "  ".join(f"{k}={v}" for k, v in buckets.items()))


def _save(data, leads, keys, is_dict):
    out = {keys[i]: leads[i] for i in range(len(leads))} if is_dict else leads
    with open(DATA_FILE, "w") as f:
        json.dump(out, f, indent=2)


if __name__ == "__main__":
    main()
