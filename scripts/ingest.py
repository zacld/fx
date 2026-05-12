"""
FX Discovery — ingest.py
Event Radar + Exposure Mapper (combined single Gemini call per event)

Pipeline:
  RSS headlines → commercial relevance pre-filter (rule-based, free)
                → ONE Gemini call per event: triage + exposure map combined
                → events.json with full segment data ready for discover.py

Rate-limit design:
  - Pre-filter eliminates noise before any AI call (typically cuts 70-80% of headlines)
  - ONE Gemini call per event (halved from previous 2-call approach)
  - Hard cap via DISCOVERY_MAX_EVENTS env var
  - Exponential backoff with 3 retries on transient errors
  - Automatic fallback mode if Gemini 429s — produces usable events from rules alone
  - Fallback events include target_segments, CH terms — discover.py still runs fully
"""

import os, json, hashlib, logging, sys, time, re
from datetime import datetime, timezone
from pathlib import Path

import feedparser
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

# AI provider abstraction (Gemini → Grok → static playbook)
from ai_provider import call_ai_for_event
from exposure_mapper import _validate_and_infer_segments

MAX_EVENTS  = int(os.getenv("DISCOVERY_MAX_EVENTS", "3"))

DATA_DIR    = Path(__file__).parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.json"
DATA_DIR.mkdir(exist_ok=True)

RSS_FEEDS = [
    {"source": "BBC Business",     "url": "http://feeds.bbci.co.uk/news/business/rss.xml"},
    {"source": "Reuters Business", "url": "https://feeds.reuters.com/reuters/businessNews"},
    {"source": "FXStreet",         "url": "https://www.fxstreet.com/rss/news"},
    {"source": "Bank of England",  "url": "https://www.bankofengland.co.uk/rss/news"},
    {"source": "GOV.UK Trade",     "url": "https://www.gov.uk/search/news-and-communications.atom?keywords=trade"},
    {"source": "The Guardian Biz", "url": "https://www.theguardian.com/uk/business/rss"},
    {"source": "Sky News Biz",     "url": "https://feeds.skynews.com/feeds/rss/business.xml"},
]

# ─── COMMERCIAL RELEVANCE PRE-FILTER ──────────────────────────────────────
# Rule-based scoring BEFORE any AI call. Eliminates market noise.
# Typical: ~70-80% of headlines filtered out here, saving significant Gemini quota.

_BOOST_RULES = [
    (r"\bgbp\b|\bpound\b|\bsterling\b",                                    4),
    (r"\beur\b|\beuro\b",                                                   2),
    (r"\busd\b|\bdollar\b",                                                 2),
    (r"\btariff|\btrade war|\btrade deal|\bimport duty|\bcustoms duty\b",   5),
    (r"\bsanction|\btrade ban|\btrade restriction|\bembargo\b",             4),
    (r"\bimport|\bexport\b",                                                3),
    (r"\bbank of england|\bboe\b|\bbase rate\b",                            4),
    (r"\binterest rate|\brate decision|\brate cut|\brate hike\b",           3),
    (r"\bfed\b|\bfederal reserve\b|\becb\b|\brate rise\b",                  2),
    (r"\bshipping cost|\bfreight|\bsupply chain disruption|\bcontainer\b",  4),
    (r"\bred sea|\bsuez|\bpanama canal\b",                                  4),
    (r"\boil price|\bcrude oil|\bwti|\bbrent\b",                            3),
    (r"\benergy price|\bgas price|\bfuel cost\b",                           3),
    (r"\bwheat|\bgrain|\bsteel|\bcopper|\baluminium\b",                     2),
    (r"\buk business|\buk compan|\buk exporters|\buk importers\b",          4),
    (r"\binflation\b",                                                       2),
    (r"\brecession\b",                                                       2),
]

_PENALTY_RULES = [
    (r"\bgold\b|\bsilver\b|\bprecious metal\b",                            -3),
    (r"\bbitcoin|\bcrypto|\bethereum|\bdigital asset\b",                   -5),
    (r"\bdow jones|\bs&p 500|\bnasdaq|\bstock market\b",                   -3),
    (r"\bftse\b",                                                           -2),
    (r"\bdxy|\bdollar index\b",                                             -1),
    (r"\bholds above|\bbounces|\bfades after|\bslips after\b",             -3),
    (r"\btechnical analysis|\bresistance level|\bsupport level\b",         -3),
    (r"\bbullish|\bbearish|\boverbought|\boversold\b",                     -3),
    (r"\bspeculators|\boptions traders|\bfutures\b",                       -2),
    (r"\bpowell comment|\bcomment by|\bspeech by\b",                       -2),
]

# Gate 1: must contain at least one entry keyword to enter the pipeline at all
_ENTRY_KEYWORDS = re.compile(
    r"\b(currency|exchange rate|sterling|pound|gbp|euro|eur|dollar|usd|"
    r"forex|fx|tariff|trade|import|export|sanction|supply chain|"
    r"oil|gas|opec|energy|fuel|commodity|commodities|shipping|freight|"
    r"inflation|interest rate|bank of england|boe|fed|ecb|"
    r"war|conflict|ukraine|russia|china|iran|sanctions|"
    r"recession|gdp|growth)\b",
    re.IGNORECASE,
)


def score_commercial_relevance(headline: str, summary: str = "") -> tuple:
    """
    Rule-based commercial relevance score (0-10). No API calls.
    ≥ 7: strong event · 5-6: moderate · < 5: skip
    """
    text = f"{headline} {summary}".lower()
    score = 0
    reasons = []
    for pattern, points in _BOOST_RULES:
        if re.search(pattern, text, re.IGNORECASE):
            score += points
            if points >= 3:
                reasons.append(f"+{points} {pattern[:30]}")
    for pattern, points in _PENALTY_RULES:
        if re.search(pattern, text, re.IGNORECASE):
            score += points
            if points <= -2:
                reasons.append(f"{points} {pattern[:30]}")
    score = max(0, min(10, round(score / 2)))
    reason = "; ".join(reasons[:3]) if reasons else "no strong signals"
    return score, reason


# ─── COMBINED ANALYSIS PROMPT ─────────────────────────────────────────────
# ONE Gemini call per event that does BOTH:
#   1. Event triage (commercial relevance, business impact translation)
#   2. Exposure mapping (target segments with FX payment logic)
#
# Previous approach: 2 calls per event (triage call + exposure mapper call)
# Now: 1 call per event — halves Gemini quota usage

COMBINED_ANALYSIS_PROMPT = """You are a business FX exposure analyst for Universal Partners, a UK B2B foreign exchange broker.

Given a market event, do TWO things in ONE response:

═══════════════════════════════════════
PART 1 — EVENT TRIAGE
═══════════════════════════════════════

Assess whether this event creates ACTIONABLE FX exposure for identifiable UK businesses.

We are NOT building a news summariser.
We are building a BUSINESS EXPOSURE TRANSLATOR.

COMMERCIAL RELEVANCE (1-10):
  9-10: Direct currency/tariff/rate move → specific UK businesses immediately pay more or receive less in FX
  7-8:  Commodity/supply chain move → named UK business types directly exposed
  5-6:  Macro event → indirect but mappable exposure, specific business types can be named
  3-4:  Possibly relevant → hard to link to specific businesses
  1-2:  Market commentary → no actionable business exposure

URGENCY (1-10):
  8-10: Businesses with upcoming FX payments should act now
  5-7:  Good outreach hook, worth monitoring
  1-4:  Minor or slow-moving

REJECT if:
- Technical commentary (holds above, bounces, fades, support/resistance levels)
- Gold, crypto, stock indices with no direct UK business FX link
- Pure trader positioning or market sentiment
- No specific UK business type can be identified as financially exposed

Only set is_fx_relevant: true if commercial_relevance >= 5 AND specific UK business types can be named.

═══════════════════════════════════════
PART 2 — EXPOSURE MAPPING (if fx_relevant = true)
═══════════════════════════════════════

Classify event_breadth first, then produce the correct number of segments:
  broad_currency or broad_macro → 8-12 segments (many UK business models affected)
  tariff or commodity           → 5-8 segments
  sector_specific               → 3-5 segments

The question is NOT "which industries are related?"
The question IS "which UK businesses are writing cheques in foreign currency because of this event, and exactly HOW does their financial position change?"

For each segment:
- segment_name: SPECIFIC ("European wine importers" not "food companies")
- business_model: describe WHO pays WHAT CURRENCY to WHOM (actual payment flow)
- fx_payment_logic: step-by-step description of the ACTUAL FX transaction
- margin_risk: quantify if possible ("3% GBP/EUR move ≈ £15k on £500k annual buy")
- payment_timing_risk: describe the timing exposure window (invoice terms, order-to-pay gap)
- affected_payment_flow: the actual payment (currency, counterparty, typical amount, frequency)
- category_priority_score: integer 0-100 scoring commercial scraping priority for this segment. Score it on:
    - direct payment-flow exposure (0-30): how directly do they pay/receive foreign currency?
    - recurring FX payment likelihood (0-20): is this a regular payment flow, not one-off?
    - margin sensitivity (0-15): are margins thin enough that FX moves cause pain?
    - UK SME suitability (0-15): are these typically UK SMEs with FD/MD reachable?
    - website evidence availability (0-10): will their website show import/export/international signals?
    - contactability (0-10): is there a realistic contact route?
  CRITICAL: every segment MUST include category_priority_score. Segments scoring < 65 will not be scraped.
- micro_categories: 3-5 specific sub-niches within this segment. Each must have:
    - name: specific sub-niche (e.g. "French wine importers UK", not just "wine importers")
    - why: one sentence explaining the specific FX exposure logic for this sub-niche
    - search_queries: 2-3 quoted search queries that find REAL UK companies in this sub-niche
    - companies_house_terms: 2-3 short name terms that appear in CH company names for this sub-niche

Do NOT include high_intent_search_queries or companies_house_terms at the segment level.
All search terms live inside micro_categories only.

STRICT AVOID RULES — never include:
- Consumer-only local businesses (restaurants, coffee shops, hairdressers)
- Businesses where the FX link requires more than 2 logical steps
- Blogs, directories, news sites, marketplaces
- Companies outside the UK

═══════════════════════════════════════
RETURN ONLY VALID JSON — no markdown, no code fences
═══════════════════════════════════════

{{
  "is_fx_relevant": true,
  "commercial_relevance": 8,
  "commercial_relevance_reason": "Direct GBP/EUR move — UK importers face higher landed costs immediately",
  "event_type": "Currency move",
  "urgency_score": 8,
  "what_happened": "One factual sentence describing the specific event",
  "what_changed_financially": "What specifically moved — rate, tariff level, commodity price",
  "who_pays_more": "Specific UK business types facing higher costs",
  "who_receives_less": "Specific UK business types earning less (or 'none')",
  "currency_mismatch_businesses": "Business types with FX costs but GBP revenue",
  "margin_risk": "High",
  "payment_timing_risk": "High",
  "affected_payment_flow": "GBP revenue vs EUR supplier costs",
  "summary": "2-3 sentences: what happened, the financial implication, why UK businesses should care today",
  "currency_pairs": ["GBP/EUR"],
  "fx_payment_logic": "One paragraph: WHY specific UK businesses pay FX because of this, in plain English",
  "sales_angle": "One sentence a sales rep can say TODAY to open a conversation",
  "business_impact_summary": "2-3 sentences: which specific UK business types are affected, what changes in their costs/revenue/margin, why today is a relevant moment to call them",
  "exposure_types": ["EUR supplier payment exposure", "import margin pressure"],
  "overall_sales_angle": "The sharpest single reason to call UK businesses today",
  "event_breadth": "broad_currency",
  "target_segments": [
    {{
      "segment_name": "European wine and spirits importers",
      "category_priority_score": 88,
      "business_model": "UK importer buying from French/Italian/Spanish producers, selling to UK trade in GBP. Supplier invoices in EUR. Margins 15-25%.",
      "exposure_level": "Very High",
      "exposure_type": "Import cost exposure — EUR supplier payments vs GBP revenue",
      "likely_currency_pairs": ["GBP/EUR"],
      "fx_payment_logic": "Importer receives invoice from French producer in EUR → converts GBP to EUR → if GBP has fallen since order was placed, the conversion costs more GBP → margin compressed",
      "margin_risk": "High — 3% GBP/EUR move on £500k annual buy ≈ £15k margin erosion if unhedged",
      "payment_timing_risk": "High — 30-90 day payment terms create open FX window between order and payment",
      "affected_payment_flow": "EUR payments to European producers, typically £50k-£500k per shipment, quarterly",
      "website_validation_signals": ["imported from", "direct from the producer", "European vineyards", "exclusive importer", "sourced from"],
      "avoid_segments": ["retail wine shops without own import operations", "supermarkets", "pub chains"],
      "sales_angle": "Upcoming EUR wine payments now cost more in GBP than when orders were placed.",
      "exposure_thesis_template": "This company imports wine/spirits from European producers. GBP/EUR move increases GBP cost of upcoming EUR supplier invoices.",
      "micro_categories": [
        {{
          "name": "French wine importers UK",
          "why": "Pay EUR to French producers, sell GBP to UK trade — margin directly hit by GBP/EUR fall",
          "search_queries": ["\"french wine importer\" UK", "\"bordeaux importer\" UK", "french wine distributor UK wholesale"],
          "companies_house_terms": ["french wine", "bordeaux wines", "wine france"]
        }},
        {{
          "name": "Italian wine and food importers UK",
          "why": "EUR-invoiced Italian suppliers with GBP-only UK revenue creates direct currency mismatch",
          "search_queries": ["\"italian wine importer\" UK", "\"italian food importer\" UK", "italian deli wholesale UK"],
          "companies_house_terms": ["italian wine", "vino import", "italian foods"]
        }},
        {{
          "name": "European spirits importers UK",
          "why": "Premium spirits invoiced in EUR; GBP/EUR moves directly affect landed cost per case",
          "search_queries": ["\"spirits importer\" UK", "\"gin importer\" UK distributor", "european spirits wholesale UK"],
          "companies_house_terms": ["spirits import", "distillery uk", "spirits wholesale"]
        }}
      ]
    }}
  ]
}}

If is_fx_relevant is FALSE, return ONLY:
{{
  "is_fx_relevant": false,
  "commercial_relevance": 2,
  "commercial_relevance_reason": "Technical market commentary with no actionable UK business exposure",
  "urgency_score": 1,
  "target_segments": []
}}

Headline: {headline}
Summary: {summary}"""


def now_iso(): return datetime.now(timezone.utc).isoformat()
def normalise(t): return " ".join((t or "").lower().split())
def dedupe_id(source, title): return hashlib.sha256(f"{source}:{normalise(title)}".encode()).hexdigest()[:16]
def load_events(): return json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
def save_events(e): EVENTS_FILE.write_text(json.dumps(e, indent=2, default=str))

def is_rate_limit_error(exc):
    msg = str(exc).lower()
    return "429" in msg or "quota" in msg or "rate" in msg or "resource_exhausted" in msg


def fetch_rss_items():
    """Fetch RSS, apply keyword gate and commercial relevance pre-score."""
    seen = {}
    for feed in RSS_FEEDS:
        try:
            parsed = feedparser.parse(feed["url"])
        except Exception as exc:
            log.warning("Feed error %s: %s", feed["source"], exc)
            continue
        for entry in parsed.entries[:25]:
            title   = (entry.get("title")   or "").strip()
            link    = (entry.get("link")    or "").strip()
            summary = (entry.get("summary") or "").strip()
            if not title: continue
            if not _ENTRY_KEYWORDS.search(f"{title} {summary}"):
                continue
            rel_score, rel_reason = score_commercial_relevance(title, summary)
            _min_rel = int(os.getenv("DISCOVERY_MIN_RELEVANCE", "4"))
            if rel_score < _min_rel:
                log.debug("  Skip (relevance %d/10, threshold=%d): %s", rel_score, _min_rel, title[:60])
                continue
            key = dedupe_id(feed["source"], title)
            if key not in seen:
                seen[key] = {
                    "id":                   key,
                    "source":               feed["source"],
                    "source_url":           link,
                    "headline":             title,
                    "raw_summary":          summary[:600],
                    "pre_relevance_score":  rel_score,
                    "pre_relevance_reason": rel_reason,
                }
    result = sorted(seen.values(), key=lambda x: x["pre_relevance_score"], reverse=True)
    log.info("Pre-filter: %d relevant items (from RSS feeds)", len(result))
    return result


def analyse_event_api(item):
    """
    AI call for event triage + exposure map.
    Uses call_ai_for_event() which tries Gemini → Grok → static playbook.
    Returns (analysis_dict, ai_meta_dict).
    """
    prompt = COMBINED_ANALYSIS_PROMPT.format(
        headline=item["headline"],
        summary=item.get("raw_summary", ""),
    )
    result, ai_meta = call_ai_for_event(prompt, item.get("headline", ""))
    return result, ai_meta


def _extract_ch_terms(target_segments):
    """Flatten CH terms and search queries from micro_categories (new format)
    with backward compat for old segment-level fields."""
    ch_terms       = []
    search_queries = []
    for seg in target_segments:
        # New format: queries and terms live in micro_categories
        for mc in seg.get("micro_categories", []):
            ch_terms.extend(mc.get("companies_house_terms", []))
            search_queries.extend(mc.get("search_queries", []))
        # Backward compat: old events have these at segment level
        ch_terms.extend(seg.get("companies_house_terms", []))
        search_queries.extend(seg.get("high_intent_search_queries", []))
    return (
        list(dict.fromkeys(ch_terms))[:30],
        list(dict.fromkeys(search_queries))[:50],
    )


def build_fallback_event(item):
    """
    Rule-based fallback when Gemini is unavailable (429 / outage).
    Produces a usable event with target_segments from headline alone.
    discover.py can run fully on these — no Gemini needed downstream.
    """
    headline = item["headline"].lower()
    summary  = item.get("raw_summary", "").lower()
    text     = f"{headline} {summary}"

    if any(x in text for x in ["tariff", "tariffs", "trade war", "customs duty"]):
        event_type = "Tariff"
        pairs      = ["GBP/USD", "GBP/EUR"]
        fx_logic   = "New or increased tariffs raise the cost of imported goods. UK businesses buying stock from overseas suppliers face higher landed costs and margin pressure immediately."
        impact     = "UK importers with US or EU suppliers now face higher input costs. Businesses that priced stock before the tariff announcement will see margin compression on committed orders."
        segments = [
            {"segment_name": "UK importers of US/EU goods",
             "business_model": "UK distributor or retailer sourcing stock from US or European suppliers, selling domestically in GBP",
             "exposure_level": "Very High", "exposure_type": "Tariff cost exposure",
             "likely_currency_pairs": ["GBP/USD", "GBP/EUR"],
             "fx_payment_logic": "Tariff added to import invoice → higher total cost in foreign currency → more GBP needed to pay → margin compressed",
             "margin_risk": "High — tariff applies directly to cost of goods, compressing margins on committed orders",
             "payment_timing_risk": "High — goods already ordered before tariff announcement now cost more",
             "affected_payment_flow": "USD/EUR payments to overseas suppliers, typically monthly or per-shipment",
             "companies_house_terms": ["import trading", "distribution international", "foods wholesale"],
             "website_validation_signals": ["we import", "sourced from", "imported from", "overseas supplier", "international supplier"],
             "high_intent_search_queries": ["\"food importer\" UK", "\"product distributor\" UK wholesale", "\"import trading\" UK"],
             "sales_angle": "With tariffs increasing import costs, businesses may want to review how they manage upcoming USD/EUR supplier payments.",
             "exposure_thesis_template": "This company appears to import goods from overseas and sell in GBP. If supplier invoices are in USD or EUR, the new tariffs are increasing the GBP cost of upcoming orders."},
            {"segment_name": "UK manufacturers importing raw materials",
             "business_model": "UK manufacturer sourcing raw materials or components from US/EU, selling finished goods in GBP",
             "exposure_level": "High", "exposure_type": "Input cost exposure",
             "likely_currency_pairs": ["GBP/USD", "GBP/EUR"],
             "fx_payment_logic": "Tariff on imported components/materials → higher cost per unit → margin compressed on finished goods priced in GBP",
             "margin_risk": "High — cost of production increases without ability to immediately reprice finished goods",
             "payment_timing_risk": "Medium — manufacturers typically plan orders further ahead",
             "affected_payment_flow": "USD/EUR payments for raw materials and components, typically monthly",
             "companies_house_terms": ["manufacturing international", "components wholesale", "industrial trading"],
             "website_validation_signals": ["we manufacture", "components sourced", "raw materials", "international supply chain"],
             "high_intent_search_queries": ["\"manufacturer\" UK international supply", "\"components distributor\" UK"],
             "sales_angle": "Tariffs on imported components are increasing production costs for UK manufacturers with overseas supply chains.",
             "exposure_thesis_template": "This company appears to manufacture using imported materials or components. Tariffs on these inputs increase production costs that are difficult to immediately pass on."},
        ]
        ch_terms = ["import trading", "food international", "wines wholesale", "manufacturing international", "distribution international"]
    elif any(x in text for x in ["oil", "crude", "opec", "petroleum", "fuel", "energy"]):
        event_type = "Commodity"
        pairs      = ["GBP/USD"]
        fx_logic   = "Energy and commodity prices are denominated in USD. UK businesses buying commodities or fuel face higher GBP costs when oil/energy prices rise, or when GBP weakens against USD."
        impact     = "UK importers of petroleum products, chemicals, and commodity-dependent manufacturers face higher input costs. Energy-intensive businesses face higher operating costs."
        segments = [
            {"segment_name": "UK petroleum and fuel importers",
             "business_model": "UK distributor buying petroleum products priced in USD, selling to UK trade customers in GBP",
             "exposure_level": "Very High", "exposure_type": "USD commodity pricing exposure",
             "likely_currency_pairs": ["GBP/USD"],
             "fx_payment_logic": "Crude/fuel priced in USD → UK importer pays in USD → GBP/USD move changes GBP cost of every delivery",
             "margin_risk": "High — commodity margin is thin, USD price moves directly impact GBP profitability",
             "payment_timing_risk": "High — spot market purchases with immediate USD exposure",
             "affected_payment_flow": "USD payments to commodity suppliers, typically per-delivery",
             "companies_house_terms": ["petroleum wholesale", "fuel trading", "chemical supplies"],
             "website_validation_signals": ["petroleum", "fuel distribution", "chemical distribution", "we supply", "industrial chemicals"],
             "high_intent_search_queries": ["\"fuel importer\" UK", "\"petroleum distributor\" UK", "\"chemical wholesaler\" UK"],
             "sales_angle": "With oil prices moving in USD, any UK business buying petroleum or chemicals faces GBP cost uncertainty on upcoming deliveries.",
             "exposure_thesis_template": "This company appears to import or distribute petroleum products or chemicals priced in USD. Recent USD commodity price moves directly affect GBP costs."},
            {"segment_name": "UK chemical and industrial input importers",
             "business_model": "UK importer/distributor of industrial chemicals, plastics, or raw materials priced in USD",
             "exposure_level": "High", "exposure_type": "USD commodity input exposure",
             "likely_currency_pairs": ["GBP/USD"],
             "fx_payment_logic": "Commodity inputs priced in USD → USD payment to overseas supplier → GBP cost moves with USD rate",
             "margin_risk": "Medium — some ability to pass through to customers but with lag",
             "payment_timing_risk": "Medium — typically 30-60 day payment terms",
             "affected_payment_flow": "USD payments to commodity producers, monthly or per-order",
             "companies_house_terms": ["chemicals wholesale", "industrial supplies", "plastics wholesale"],
             "website_validation_signals": ["industrial chemicals", "chemical distribution", "raw materials", "overseas supplier"],
             "high_intent_search_queries": ["\"chemical distributor\" UK", "\"industrial chemical\" wholesale UK"],
             "sales_angle": "Oil price moves affect the USD cost of chemical inputs — businesses with overseas supplier invoices in USD may want to review their FX exposure.",
             "exposure_thesis_template": "This company appears to import chemicals or industrial inputs priced in USD. Oil price moves affect the USD cost of these inputs."},
        ]
        ch_terms = ["chemicals wholesale", "petroleum wholesale", "fuel trading", "chemical supplies", "manufacturing international"]
    elif any(x in text for x in ["rate", "boe", "fed", "ecb", "interest", "monetary"]):
        event_type = "Rate decision"
        pairs      = ["GBP/USD", "GBP/EUR"]
        fx_logic   = "Interest rate decisions shift currency values. UK businesses with overseas supplier payments or overseas customer revenue face changed FX costs or receipts depending on which currency moved and in which direction."
        impact     = "Rate decisions move exchange rates. UK businesses with regular overseas payments or receipts are affected — importers face changed costs, exporters face changed revenue in GBP terms."
        segments = [
            {"segment_name": "UK importers with upcoming supplier payments",
             "business_model": "UK distributor or wholesaler with regular EUR or USD supplier invoices due for payment",
             "exposure_level": "High", "exposure_type": "Interest rate / currency move exposure",
             "likely_currency_pairs": ["GBP/USD", "GBP/EUR"],
             "fx_payment_logic": "Rate decision moves GBP → pending supplier invoice now costs more or less GBP → margin impact on goods already ordered",
             "margin_risk": "High for businesses with near-term invoices due",
             "payment_timing_risk": "High — businesses with invoices due in the next 30-60 days are immediately exposed",
             "affected_payment_flow": "EUR or USD supplier payments, monthly or per-order",
             "companies_house_terms": ["food international", "wines wholesale", "seafood wholesale"],
             "website_validation_signals": ["imported from", "overseas supplier", "european supplier", "international supplier"],
             "high_intent_search_queries": ["\"food importer\" UK", "\"wine importer\" UK", "\"wholesale importer\" UK"],
             "sales_angle": "Rate-driven currency move means upcoming overseas supplier invoices now cost more in GBP than when orders were placed.",
             "exposure_thesis_template": "This company appears to import goods from overseas with invoices in EUR or USD. Rate-driven currency moves affect the GBP cost of upcoming supplier payments."},
            {"segment_name": "UK exporters receiving overseas revenue",
             "business_model": "UK business exporting goods or services, receiving payment in EUR or USD",
             "exposure_level": "High", "exposure_type": "Export revenue FX exposure",
             "likely_currency_pairs": ["GBP/EUR", "GBP/USD"],
             "fx_payment_logic": "Overseas customer pays in EUR/USD → UK exporter converts to GBP → rate move changes GBP value of that receipt",
             "margin_risk": "Medium — revenue in GBP terms changes without cost structure change",
             "payment_timing_risk": "Medium — outstanding invoices in foreign currency are at risk",
             "affected_payment_flow": "EUR or USD receipts from overseas customers, monthly or per-invoice",
             "companies_house_terms": ["exports international", "trading international", "manufacturing exports"],
             "website_validation_signals": ["we export", "international customers", "overseas customers", "global customers"],
             "high_intent_search_queries": ["\"uk exporter\" international customers", "\"manufacturer\" UK export"],
             "sales_angle": "Currency moves from rate decisions affect the GBP value of any outstanding overseas customer invoices.",
             "exposure_thesis_template": "This company appears to export goods or services with revenue in EUR or USD. Rate-driven currency moves affect how much GBP they receive from overseas customers."},
        ]
        ch_terms = ["food international", "wines wholesale", "trading international", "exports international", "international trading"]
    elif any(x in text for x in ["shipping", "freight", "supply chain", "container", "red sea"]):
        event_type = "Supply chain"
        pairs      = ["GBP/USD"]
        fx_logic   = "Shipping and freight costs are denominated in USD. UK importers face both higher freight bills and possible stock delays. Higher shipping costs compress landed cost margins on imported goods."
        impact     = "UK importers dependent on sea freight face higher logistics costs in USD. Manufacturing businesses with overseas suppliers face both higher freight bills and supply uncertainty."
        segments = [
            {"segment_name": "UK importers dependent on sea freight",
             "business_model": "UK importer shipping stock from Asia, US, or other regions by container, paying freight in USD",
             "exposure_level": "Very High", "exposure_type": "Freight cost exposure in USD",
             "likely_currency_pairs": ["GBP/USD"],
             "fx_payment_logic": "Freight booked in USD → UK importer pays USD freight charges → GBP/USD move affects total landed cost of goods",
             "margin_risk": "High — freight is a significant component of landed cost for sea-shipped goods",
             "payment_timing_risk": "High — freight typically paid before or on delivery, short window",
             "affected_payment_flow": "USD freight payments to shipping lines, per-container or per-shipment",
             "companies_house_terms": ["import trading", "food wholesale", "wholesale international"],
             "website_validation_signals": ["imported from", "we import", "directly from", "overseas", "asia", "china"],
             "high_intent_search_queries": ["\"importer\" UK wholesale", "\"import trading\" UK"],
             "sales_angle": "With shipping costs rising in USD, UK importers face higher landed costs on every container — good time to review FX exposure on freight payments.",
             "exposure_thesis_template": "This company appears to import goods by sea. Rising freight costs in USD and supply chain disruption increase landed costs and FX uncertainty."},
        ]
        ch_terms = ["import trading", "food wholesale", "wholesale international", "chemicals wholesale", "manufacturing international"]
    elif any(x in text for x in ["pound", "sterling", "gbp", "euro", "eur", "dollar", "usd", "currency", "exchange"]):
        event_type = "Currency move"
        pairs = []
        if any(x in text for x in ["pound", "sterling", "gbp"]):
            pairs.append("GBP/USD")
            if any(x in text for x in ["euro", "eur", "european"]):
                pairs.append("GBP/EUR")
        elif any(x in text for x in ["euro", "eur"]):
            pairs.append("GBP/EUR")
        else:
            pairs = ["GBP/USD", "GBP/EUR"]
        fx_logic = "A currency move directly affects the GBP cost of any overseas supplier invoice or the GBP value of any overseas customer receipt. UK businesses with recurring international payments are immediately exposed."
        impact   = "UK businesses with overseas supplier invoices or overseas customer revenue are directly affected. Importers face changed input costs; exporters face changed revenue in GBP terms."
        segments = [
            {"segment_name": "UK food and drink importers",
             "business_model": "UK importer or distributor buying food/drink from European or international suppliers, selling in GBP",
             "exposure_level": "Very High", "exposure_type": "Import cost exposure — EUR/USD supplier payments vs GBP revenue",
             "likely_currency_pairs": pairs,
             "fx_payment_logic": "Supplier invoice in EUR or USD → convert GBP to pay → currency move changes GBP cost relative to when order was placed",
             "margin_risk": "High — thin margins in food distribution amplify FX impact",
             "payment_timing_risk": "High — invoices due monthly, often 30-60 day terms from order",
             "affected_payment_flow": "EUR or USD payments to overseas food producers, monthly or per-shipment",
             "companies_house_terms": ["food international", "wines wholesale", "seafood wholesale", "foods import"],
             "website_validation_signals": ["imported from", "from italy", "from france", "european supplier", "sourced from"],
             "high_intent_search_queries": ["\"food importer\" UK", "\"wine importer\" UK", "\"seafood importer\" UK"],
             "sales_angle": "Currency move means upcoming overseas food supplier payments now cost more in GBP than when orders were placed.",
             "exposure_thesis_template": "This company appears to import food or drink from overseas suppliers. Currency moves affect the GBP cost of upcoming supplier payments relative to when orders were confirmed."},
            {"segment_name": "UK furniture and homeware importers",
             "business_model": "UK wholesaler or distributor importing furniture, homeware, or consumer goods from Europe or Asia, selling to UK trade in GBP",
             "exposure_level": "Very High", "exposure_type": "Import cost exposure — EUR/USD vs GBP",
             "likely_currency_pairs": pairs,
             "fx_payment_logic": "Furniture/homeware invoice from European or Asian supplier in EUR/USD → GBP conversion at payment → adverse move compresses margin on stock already ordered",
             "margin_risk": "High — furniture margins typically 25-40% but currency moves can take 10-20% of that",
             "payment_timing_risk": "High — lead times of 60-120 days create long FX exposure window",
             "affected_payment_flow": "EUR or USD payments to European/Asian furniture producers, quarterly",
             "companies_house_terms": ["furniture wholesale", "furniture import", "homeware wholesale"],
             "website_validation_signals": ["imported from", "european design", "sourced from", "italian furniture", "scandinavian"],
             "high_intent_search_queries": ["\"furniture importer\" UK", "\"homeware wholesaler\" UK", "\"furniture distributor\" UK"],
             "sales_angle": "Currency moves affect the GBP cost of furniture and homeware importers' overseas stock orders — worth reviewing upcoming payment exposure.",
             "exposure_thesis_template": "This company appears to import furniture or homeware from overseas suppliers. Currency moves affect the GBP cost of upcoming stock orders, especially for goods with long lead times."},
        ]
        ch_terms = ["wines wholesale", "food international", "foods wholesale", "furniture import", "homeware wholesale", "seafood wholesale"]
    else:
        event_type = "Macro data"
        pairs      = ["GBP/USD", "GBP/EUR"]
        fx_logic   = "Macro events can shift currency values and affect UK businesses with overseas payment obligations or overseas revenue."
        impact     = "Macro data may move GBP. UK businesses with overseas supplier payments or overseas customer revenue could be affected."
        segments = [
            {"segment_name": "UK businesses with regular overseas payments",
             "business_model": "UK importer or exporter with recurring FX payments or receipts",
             "exposure_level": "High", "exposure_type": "Currency exposure — GBP vs overseas currencies",
             "likely_currency_pairs": pairs,
             "fx_payment_logic": "Macro data shifts GBP expectations → currency moves → GBP cost of overseas payments or GBP value of overseas receipts changes",
             "margin_risk": "Medium — depends on business model and FX volumes",
             "payment_timing_risk": "Medium — depends on upcoming payment schedule",
             "affected_payment_flow": "EUR or USD payments to overseas suppliers, or receipts from overseas customers",
             "companies_house_terms": ["food international", "import trading", "international trading"],
             "website_validation_signals": ["international", "overseas", "import", "export", "global"],
             "high_intent_search_queries": ["\"importer\" UK", "\"exporter\" UK international"],
             "sales_angle": "Macro uncertainty affecting GBP is a good time to review FX exposure on upcoming international payments.",
             "exposure_thesis_template": "This company appears to have overseas payment obligations or international revenue. Macro-driven GBP moves affect the cost or value of these FX transactions."},
        ]
        ch_terms = ["food international", "import trading", "international trading", "exports international"]

    ch_terms_deduped, search_queries = _extract_ch_terms(segments)

    return {
        **item,
        "detected_at":            now_iso(),
        "event_type":             event_type,
        "summary":                item.get("raw_summary", "") or item["headline"],
        "currency_pairs":         pairs,
        "urgency_score":          6,
        "commercial_relevance":   item.get("pre_relevance_score", 5),
        "commercial_relevance_reason": "Fallback event — Gemini unavailable",
        "what_happened":          item["headline"],
        "what_changed_financially": f"Market {event_type.lower()} with direct FX implications for UK businesses",
        "who_pays_more":          "UK importers with overseas supplier invoices",
        "who_receives_less":      "UK exporters with overseas customer revenue (if GBP strengthened)",
        "currency_mismatch_businesses": "UK businesses with FX costs and GBP revenue",
        "margin_risk":            "Medium",
        "payment_timing_risk":    "Medium",
        "affected_payment_flow":  f"GBP revenue vs {'/'.join(pairs)} supplier costs" if pairs else "overseas payments",
        "fx_payment_logic":       fx_logic,
        "business_impact_summary": impact,
        "sales_angle":            f"Recent {event_type.lower()} may affect UK businesses with overseas payments. Worth reviewing FX exposure.",
        "overall_sales_angle":    f"Recent {event_type.lower()} creates FX exposure for UK businesses with international payment flows.",
        "exposure_types":         [f"{event_type} exposure"],
        "status":                 "ready",
        "fallback_mode":          True,
        "target_segments":        segments,
        "companies_house_terms":  ch_terms[:10],
        "all_search_queries":     search_queries[:20],
    }


def main():
    log.info("=== FX Ingest (max %d new events, 1 Gemini call per event) ===", MAX_EVENTS)
    existing = load_events()
    items    = fetch_rss_items()

    new_items = [i for i in items if i["id"] not in existing]
    log.info("%d new items to process (skipping %d already seen)",
             len(new_items), len(items) - len(new_items))

    new_items = new_items[:MAX_EVENTS]

    saved = failed = rate_limited = fallback_used = 0
    rate_limit_hit = False

    for item in new_items:
        log.info("Processing [rel=%d/10]: %s", item.get("pre_relevance_score", 0), item["headline"][:70])

        # If we already hit rate limits this run, use fallback for remaining items
        if rate_limit_hit:
            log.info("  Rate limit hit earlier — using rule-based fallback")
            event = build_fallback_event(item)
            existing[item["id"]] = event
            fallback_used += 1
            saved += 1
            continue

        try:
            analysis, ai_meta = analyse_event_api(item)

            # Empty result → ai_provider returned playbook fallback
            if not analysis:
                log.info("  AI returned empty (all providers failed or playbook) — using rule-based fallback")
                event = build_fallback_event(item)
                event.update({
                    "ai_provider_used":   ai_meta.get("ai_provider_used"),
                    "ai_model_used":      ai_meta.get("ai_model_used"),
                    "ai_fallback_reason": ai_meta.get("ai_fallback_reason"),
                })
                existing[item["id"]] = event
                fallback_used += 1
                saved += 1
                continue

            urgency  = int(analysis.get("urgency_score") or 0)
            comm_rel = int(analysis.get("commercial_relevance") or 0)

            # Reject if not commercially relevant
            if not analysis.get("is_fx_relevant") or urgency < 4 or comm_rel < 5:
                log.info("  Skip (not commercially relevant — score=%d, urgency=%d): %s",
                         comm_rel, urgency, analysis.get("commercial_relevance_reason","")[:60])
                existing[item["id"]] = {
                    **item,
                    "detected_at":                  now_iso(),
                    "status":                       "low_relevance",
                    "urgency_score":                urgency,
                    "commercial_relevance":         comm_rel,
                    "commercial_relevance_reason":  analysis.get("commercial_relevance_reason", ""),
                    "ai_provider_used":             ai_meta.get("ai_provider_used"),
                    "ai_model_used":                ai_meta.get("ai_model_used"),
                    "ai_fallback_reason":           ai_meta.get("ai_fallback_reason"),
                }
                continue

            log.info("  ✓ Commercially relevant (score=%d/10, urgency=%d/10) [%s] — %s",
                     comm_rel, urgency, ai_meta.get("ai_provider_used", "?"),
                     analysis.get("commercial_relevance_reason", "")[:60])

            # Extract CH terms and search queries from segments
            target_segments = analysis.get("target_segments", [])
            # Validate Brain 2 required fields and apply rule-based inference for any missing
            if target_segments:
                target_segments = _validate_and_infer_segments(
                    target_segments,
                    ai_meta.get("ai_provider_used", "AI")
                )
            ch_terms, search_queries = _extract_ch_terms(target_segments)

            event = {
                **item,
                "detected_at":                  now_iso(),
                "event_type":                   analysis.get("event_type"),
                "summary":                      analysis.get("summary") or item.get("raw_summary", ""),
                "currency_pairs":               analysis.get("currency_pairs", []),
                "urgency_score":                urgency,
                "commercial_relevance":         comm_rel,
                "commercial_relevance_reason":  analysis.get("commercial_relevance_reason", ""),
                # Business impact translation
                "what_happened":                analysis.get("what_happened", ""),
                "what_changed_financially":     analysis.get("what_changed_financially", ""),
                "who_pays_more":                analysis.get("who_pays_more", ""),
                "who_receives_less":            analysis.get("who_receives_less", ""),
                "currency_mismatch_businesses": analysis.get("currency_mismatch_businesses", ""),
                "margin_risk":                  analysis.get("margin_risk", ""),
                "payment_timing_risk":          analysis.get("payment_timing_risk", ""),
                "affected_payment_flow":        analysis.get("affected_payment_flow", ""),
                "fx_payment_logic":             analysis.get("fx_payment_logic", ""),
                "sales_angle":                  analysis.get("sales_angle", ""),
                "business_impact_summary":      analysis.get("business_impact_summary", ""),
                "exposure_types":               analysis.get("exposure_types", []),
                "overall_sales_angle":          analysis.get("overall_sales_angle", ""),
                # Exposure mapping (now in same call)
                "event_breadth":               analysis.get("event_breadth", "sector_specific"),
                "target_segments":              target_segments,
                "total_micro_categories":       sum(len(s.get("micro_categories", [])) for s in target_segments),
                "companies_house_terms":        ch_terms,
                "all_search_queries":           search_queries,
                "status":                       "ready",
                # AI provider metadata
                "ai_provider_used":             ai_meta.get("ai_provider_used"),
                "ai_model_used":                ai_meta.get("ai_model_used"),
                "ai_fallback_reason":           ai_meta.get("ai_fallback_reason"),
            }

            existing[item["id"]] = event
            saved += 1
            log.info("  ✓ Saved (urgency=%d, relevance=%d, %d segments, provider=%s)",
                     urgency, comm_rel, len(target_segments), ai_meta.get("ai_provider_used", "?"))

            # Brief pause between events
            time.sleep(2)

        except Exception as exc:
            if is_rate_limit_error(exc):
                log.warning("  Rate limit — switching to rule-based fallback for remaining items")
                rate_limit_hit = True
                rate_limited += 1
                event = build_fallback_event(item)
                existing[item["id"]] = event
                fallback_used += 1
                saved += 1
                time.sleep(10)
            else:
                log.error("  Failed: %s | %s", item.get("headline", "?")[:50], exc)
                failed += 1

    save_events(existing)

    public_dir = Path(__file__).parent.parent / "public" / "data"
    public_dir.mkdir(parents=True, exist_ok=True)
    (public_dir / "events.json").write_text(EVENTS_FILE.read_text())

    log.info("=== Done: %d saved (%d fallback)  %d failed  %d rate-limited  |  %d total ===",
             saved, fallback_used, failed, rate_limited, len(existing))

    if rate_limit_hit:
        log.warning("=== Rate limit hit. Run again in 1-2 minutes for full AI analysis. ===")


if __name__ == "__main__":
    main()
