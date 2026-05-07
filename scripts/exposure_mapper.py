"""
FX Discovery — exposure_mapper.py

Exposure Mapper: the intelligence layer between event detection and company discovery.

Instead of asking "which industries are related to this event?" it asks:
"Which UK business models are most financially exposed to this event through
FX, import/export activity, overseas supplier payments, overseas customer revenue,
commodity pricing, tariffs, shipping disruption, or margin pressure?"

Output: exposure-ranked target segments with high-intent search queries,
validation signals, and sales angles — not generic industry lists.

Segment count targets by event breadth:
  broad_currency  — GBP/EUR, GBP/USD, broad sterling/dollar moves → 8-12 segments
  broad_macro     — rate decisions, inflation, quantitative easing  → 8-10 segments
  commodity       — oil, gas, grain, metals price moves            → 6-10 segments
  tariff          — tariff/trade policy shock                      → 6-9 segments
  sector_specific — narrowly affects one sector                   → 4-7 segments
"""

import os, json, logging
from pathlib import Path
from dotenv import load_dotenv
from google import genai
from tenacity import retry, stop_after_attempt, wait_exponential

load_dotenv()
log = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
gemini         = genai.Client(api_key=GEMINI_API_KEY)

EXPOSURE_MAPPER_PROMPT = """You are an FX sales intelligence system for Universal Partners, a UK B2B foreign exchange broker.

Given a market event, identify which UK business models are MOST financially exposed — through actual FX payment flows, import/export dependency, overseas supplier or customer payments, commodity pricing, tariffs, or margin compression.

═══════════════════════════════════════
CORE PRINCIPLE
═══════════════════════════════════════
We are NOT building a news summariser.
We are building a BUSINESS EXPOSURE TRANSLATOR.

The question is NOT: "which industries are related to this event?"
The question IS: "which UK businesses are writing cheques in foreign currency — or receiving foreign currency — because of this event, and exactly HOW does this event change their financial position?"

DO NOT produce generic industry lists. Each segment must describe a SPECIFIC business model with a SPECIFIC FX payment flow that is DIRECTLY impacted by this event.

BAD: "Manufacturers" — too broad, no FX payment logic
GOOD: "UK furniture importers buying from Italian/German manufacturers, invoiced in EUR, selling in GBP — margin squeezed when GBP/EUR falls"

═══════════════════════════════════════
SEGMENT COUNT — CRITICAL RULE
═══════════════════════════════════════
First, classify the event breadth:
  "broad_currency"  — broad sterling, dollar, or euro move (GBP/EUR, GBP/USD, USD strength, EUR move)
  "broad_macro"     — rate decisions, inflation data, quantitative easing, central bank policy
  "commodity"       — oil, gas, grain, metals, shipping rates
  "tariff"          — tariff/trade policy shock (US tariffs, Brexit-related)
  "sector_specific" — narrowly affects one sector (e.g., specific country sanction on one product)

THEN produce:
  broad_currency  → 10–12 target segments (UK has many import-heavy business models all affected)
  broad_macro     → 8–10 target segments
  commodity       → 7–10 target segments
  tariff          → 6–9 target segments
  sector_specific → 4–7 target segments

For broad_currency events like "GBP/EUR weakness" or "GBP/USD weakness", you MUST cover the full
range of UK import-heavy business models — not just food and wine. Think across ALL categories of
UK businesses that pay EUR or USD supplier invoices:

  ALWAYS include for GBP/EUR weakness:
  01. European wine and spirits importers (classic, high exposure)
  02. European food and delicatessen importers (Italian, French, Spanish etc.)
  03. Furniture and interiors importers (Scandinavian, Italian, German sourcing)
  04. Automotive parts distributors (German, French, Italian OEM parts)
  05. Construction material importers (European stone, tile, timber, fittings)
  06. Machinery and industrial equipment distributors (German, Italian plant)
  07. Fashion, textile and apparel wholesalers (Italian, French, Spanish brands)
  08. Medical device and laboratory equipment distributors (German, Dutch sourcing)
  09. Packaging and raw material importers (European paper, plastic, glass)
  10. Travel and DMC companies paying European hotel/supplier invoices
  11. E-commerce/DTC brands sourcing stock from European manufacturers
  12. Chemicals and specialty ingredients distributors (REACH-registered European)

  ALWAYS include for GBP/USD weakness:
  01. US technology and software licence payers (SaaS, enterprise software)
  02. Petroleum and fuel traders (USD-priced commodity)
  03. Electronics and semiconductor importers (USD-denominated supply chain)
  04. Food raw material importers — grain, soy, sugar (USD commodity pricing)
  05. Pharmaceutical and medical device importers (USD sourcing from US/Asia)
  06. Scotch whisky and premium spirits exporters (USD export revenue)
  07. UK freight and shipping brokers paying USD vessel fees
  08. Aerospace and engineering parts importers (USD supply chain)
  09. Financial services firms with USD settlements
  10. UK exporters to USD markets (reduced GBP-equivalent revenue)

═══════════════════════════════════════
BUSINESS MODELS TO CONSIDER
═══════════════════════════════════════
Think in terms of WHO IS PAYING WHAT CURRENCY TO WHOM:
- UK importers paying EUR/USD/other to overseas suppliers, selling in GBP
- UK exporters receiving EUR/USD from overseas customers, paying costs in GBP
- UK distributors with exclusive European/US supply arrangements
- UK wholesalers sourcing stock from specific overseas countries
- UK manufacturers using imported raw materials priced in USD/EUR
- UK travel operators paying overseas hotels, airlines, ground handlers
- UK e-commerce brands drop-shipping or sourcing from overseas
- UK professional services firms billing in foreign currency
- UK food and drink importers with recurring supplier payments
- UK engineering/industrial firms with overseas supply chains
- UK packaging and materials companies with European raw material suppliers
- UK construction sector importers (stone, tile, timber, fittings)
- UK automotive parts distributors (German/French/Italian OEM supply chains)
- UK fashion and apparel wholesalers (European brand/manufacturer sourcing)
- UK medical and laboratory equipment distributors (European/US supply chains)

═══════════════════════════════════════
EXPOSURE TYPES
═══════════════════════════════════════
- Import cost exposure (paying overseas supplier in foreign currency)
- Export revenue exposure (receiving foreign currency from overseas customers)
- USD commodity pricing exposure (commodity priced in USD, revenue in GBP)
- Currency mismatch: FX costs vs GBP revenue
- Margin compression from adverse FX movement
- Payment timing risk (invoices due, outstanding FX exposure window)
- Tariff/geopolitical cost exposure
- Shipping/freight cost exposure
- Supply chain disruption with FX re-sourcing cost

═══════════════════════════════════════
RANKING PRIORITY
═══════════════════════════════════════
Rank segments by:
1. Directness of FX exposure (do they literally pay or receive foreign currency?)
2. Exposure size (larger recurring FX volumes = higher rank)
3. Margin sensitivity (thin-margin importers/distributors hit hardest)
4. Payment timing risk (upcoming invoice due dates create urgency)
5. Suitability for UK B2B FX sales (SME FD/CFO/MD reachable)

═══════════════════════════════════════
STRICT AVOID RULES — DO NOT OUTPUT THESE
═══════════════════════════════════════
NEVER include:
- Local consumer-only businesses (coffee shops, hairdressers, local retail)
- Restaurants (unless they DIRECTLY manage large overseas supplier payments)
- Businesses with only indirect or vague FX exposure
- Sectors with no plausible recurring FX payment flows
- Blogs, directories, news sites, marketplaces, aggregators
- Companies outside the UK
- Any segment where the FX link requires more than 2 logical steps

═══════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════
Return ONLY valid JSON — no markdown, no code fences, no commentary.

{
  "event_summary": "1-2 sentences: what happened and the direct FX/financial implication for UK businesses",
  "business_impact_summary": "2-3 sentences: specifically which UK businesses are affected, what changes in their costs/revenue/margin, and why today is a relevant moment to call them",
  "event_type": "Currency move | Tariff | Rate decision | Geopolitical | Commodity | Trade policy | Macro data | Supply chain | Other",
  "event_breadth": "broad_currency | broad_macro | commodity | tariff | sector_specific",
  "exposure_types": ["EUR supplier payment exposure", "import margin pressure"],
  "overall_sales_angle": "The single sharpest reason to call a UK FD/MD today because of this event — specific, urgent, commercial",
  "target_segments": [
    {
      "segment_name": "European wine and spirits importers",
      "business_model": "UK importers buying wine and spirits from French, Italian, Spanish producers, selling to UK on-trade and off-trade in GBP. Supplier invoices in EUR, all UK revenue in GBP. Margins typically 15-25%.",
      "exposure_level": "Very High",
      "exposure_type": "Import cost exposure — EUR supplier payments vs GBP revenue",
      "likely_currency_pairs": ["GBP/EUR"],
      "why_affected": "GBP weakening against EUR directly increases the GBP cost of every EUR-denominated supplier invoice, squeezing gross margin on each shipment.",
      "why_financially_exposed": "Recurring quarterly or monthly EUR payments to European producers with no GBP revenue offset. A 2% GBP/EUR move on £500k annual buy = £10k margin erosion. Thin-margin business cannot absorb this passively.",
      "fx_payment_logic": "Importer receives invoice from French producer in EUR → converts GBP to EUR to pay → if GBP has fallen since pricing was set, conversion costs more GBP than budgeted → margin on that stock shipment is compressed immediately",
      "margin_risk": "High — gross margins typically 15-25%, a 3-5% GBP/EUR adverse move can eliminate 10-20% of gross profit on a shipment if unhedged",
      "payment_timing_risk": "High — wine importers typically have 30-90 day payment terms, creating an open FX window between order confirmation and payment. Multiple shipments often in-flight simultaneously.",
      "affected_payment_flow": "EUR payments to European wine producers and négociants, typically £50k-£500k per shipment, quarterly or on harvest cycle",
      "ideal_company_profile": "UK SME wine importer or distributor, 5-50 staff, buying direct from European producers, supplying restaurants, hotels, or UK retail. FD or MD makes payment decisions.",
      "high_intent_search_queries": [
        "\"wine importer\" UK site:linkedin.com OR site:companieshouse.gov.uk",
        "\"Italian wine importer\" UK",
        "\"French wine distributor\" UK",
        "\"wine merchant\" import wholesale UK",
        "\"spirits importer\" UK distributor"
      ],
      "companies_house_terms": ["wine import", "wine merchant", "spirits importer", "wine distributor"],
      "website_validation_signals": ["imported from", "direct from the producer", "European vineyards", "exclusive importer", "sourced from Italy", "French wine"],
      "avoid_segments": ["retail wine shops with no import activity", "supermarkets", "pub chains", "wine blogs", "wine subscription boxes without own import operations"],
      "sales_angle": "With GBP/EUR moving, any upcoming EUR wine payments are now costing more in GBP than when orders were placed. Worth a conversation about protecting margin on the next shipment.",
      "exposure_thesis_template": "This business appears to import [wine/spirits] directly from European producers, with revenue in GBP. If supplier invoices are in EUR, the recent GBP/EUR move is increasing the GBP cost of upcoming stock payments relative to when orders were confirmed."
    }
  ]
}

═══════════════════════════════════════
RULES
═══════════════════════════════════════
- Classify event_breadth first, then apply the correct segment count range
- For broad_currency and broad_macro events, you MUST produce at least 8 segments
- Each segment_name must be SPECIFIC — "European wine importers" not "food companies"
- business_model must describe the actual payment flow: who pays what currency to whom
- fx_payment_logic: step-by-step description of the actual FX transaction — be precise
- margin_risk: quantify if possible (e.g. "3% GBP/EUR move = ~£X margin impact")
- payment_timing_risk: describe the timing exposure window (invoice terms, order-to-pay gap)
- affected_payment_flow: describe the actual payment (currency, counterparty, typical amount, frequency)
- high_intent_search_queries: 3-5 queries that find REAL companies. Use quoted phrases. Be specific.
- companies_house_terms: 3-5 short terms (1-2 words) that appear in REAL UK company names
- exposure_level: Very High / High / Medium / Low only
- avoid_segments: must be specific to THIS segment — not a generic list

Market event to analyse:
Source: {source}
Headline: {headline}
Summary: {summary}
"""

def extract_json(text):
    text = text.strip().replace("```json","").replace("```","").strip()
    s, e = text.find("{"), text.rfind("}")
    if s == -1 or e == -1: raise ValueError("No JSON found")
    return json.loads(text[s:e+1])

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
def map_exposures(event: dict) -> dict:
    """
    Takes a raw event dict and returns an exposure map with
    ranked target segments, high-intent search queries, and sales angles.
    """
    r = gemini.models.generate_content(
        model=GEMINI_MODEL,
        contents=EXPOSURE_MAPPER_PROMPT.format(
            source=event.get("source",""),
            headline=event.get("headline",""),
            summary=event.get("raw_summary") or event.get("summary",""),
        )
    )
    return extract_json(r.text)

def enrich_event_with_exposure_map(event: dict) -> dict:
    """
    Runs the exposure mapper on an event and merges results back into the event dict.
    Returns the enriched event. Fails gracefully on rate limits.
    """
    try:
        exposure_map = map_exposures(event)
        event["exposure_map"]          = exposure_map
        event["target_segments"]       = exposure_map.get("target_segments", [])
        event["exposure_types"]        = exposure_map.get("exposure_types", [])
        event["overall_sales_angle"]   = exposure_map.get("overall_sales_angle", event.get("sales_angle",""))
        event["business_impact_summary"] = exposure_map.get("business_impact_summary", "")
        event["event_breadth"]         = exposure_map.get("event_breadth", "sector_specific")

        # Build flattened search terms and CH terms from all segments
        all_search_queries = []
        all_ch_terms       = []
        for seg in event["target_segments"]:
            all_search_queries.extend(seg.get("high_intent_search_queries", []))
            all_ch_terms.extend(seg.get("companies_house_terms", []))

        event["all_search_queries"]    = list(dict.fromkeys(all_search_queries))[:30]
        event["companies_house_terms"] = list(dict.fromkeys(all_ch_terms))[:20]

        n = len(event["target_segments"])
        breadth = event["event_breadth"]
        log.info("  Exposure map: %d segments [%s] | top: %s (%s)",
                 n, breadth,
                 event["target_segments"][0]["segment_name"] if event["target_segments"] else "none",
                 event["target_segments"][0]["exposure_level"] if event["target_segments"] else "—")

    except Exception as exc:
        msg = str(exc).lower()
        if "429" in msg or "quota" in msg or "rate" in msg or "resource_exhausted" in msg:
            log.warning("  Exposure Mapper rate limited (429) — will use fallback segments")
            raise  # Re-raise so ingest.py can catch and apply fallback
        log.error("  Exposure mapper failed: %s", exc)
        event["target_segments"]  = []
        event["exposure_types"]   = []
        event["exposure_map"]     = {}
        event["event_breadth"]    = "sector_specific"

    return event


def build_ch_search_terms(event: dict) -> list:
    """
    Builds Companies House search terms that will actually find companies.
    CH searches match company NAMES — not SIC codes or activity descriptions.
    Most importers don't have "import" in their name.
    Uses broad product/trade terms that appear in real UK company names.
    """
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from ch_search_strategy import get_search_terms_for_segment

    all_terms = []
    segments = event.get("target_segments", [])

    for seg in segments:
        seg_terms = get_search_terms_for_segment(
            seg.get("segment_name",""),
            seg.get("exposure_type",""),
        )
        all_terms.extend(seg_terms)

        # Also keep any specific CH terms from the Gemini output
        all_terms.extend(seg.get("companies_house_terms", []))

    # Dedupe, keep top 25 (more for broad events)
    seen = set()
    result = []
    for t in all_terms:
        if t.lower() not in seen:
            seen.add(t.lower())
            result.append(t)
    return result[:25]
