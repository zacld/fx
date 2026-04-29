"""
FX Discovery — exposure_mapper.py

Exposure Mapper: the intelligence layer between event detection and company discovery.

Instead of asking "which industries are related to this event?" it asks:
"Which UK business models are most financially exposed to this event through
FX, import/export activity, overseas supplier payments, overseas customer revenue,
commodity pricing, tariffs, shipping disruption, or margin pressure?"

Output: exposure-ranked target segments with high-intent search queries,
validation signals, and sales angles — not generic industry lists.
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

Given a market event, your job is to identify which UK business models are MOST financially exposed to this event — through FX payments, import/export dependency, overseas supplier or customer payments, commodity pricing, tariffs, shipping disruption, or margin pressure.

DO NOT produce generic industry lists. Produce an exposure-ranked target map.

The question is NOT: "which industries are related to this event?"
The question IS: "which UK businesses are writing cheques in foreign currency — or receiving foreign currency — because of this event, and how exposed are they financially?"

BUSINESS CATEGORIES TO CONSIDER (not exhaustive — think broadly):
- Food and drink importers/exporters
- Wine and alcohol importers
- Manufacturers importing raw materials
- Engineering firms with overseas supply chains
- Automotive parts distributors
- Electronics importers
- Furniture/homeware wholesalers
- Fashion/clothing wholesalers
- Construction material importers
- Machinery/component distributors
- Logistics and freight companies
- E-commerce brands sourcing overseas
- Travel companies paying overseas suppliers
- Commodity-linked businesses
- Energy/fuel-linked businesses
- Agriculture import/export
- Luxury goods exporters/importers
- Software/services with overseas revenue
- Any UK SME with recurring international payments

EXPOSURE TYPES TO IDENTIFY:
- Import cost exposure (paying overseas supplier in foreign currency)
- Export revenue exposure (receiving foreign currency from overseas customers)
- USD supplier exposure
- EUR supplier exposure
- Commodity price exposure
- Shipping/supply chain exposure
- Tariff/geopolitical exposure
- Interest-rate/macro exposure
- Currency mismatch (costs in FX, revenue in GBP)
- Margin compression from FX movement
- Recurring overseas supplier/customer payments

RANKING LOGIC — prioritise businesses with:
1. Direct FX exposure (paying or receiving foreign currency)
2. Import/export dependency
3. Overseas supplier or customer payments
4. Currency mismatch: FX costs vs GBP revenue
5. Recurring international transactions
6. Margin sensitivity to FX moves
7. UK SME suitability for FX sales
8. Clear decision-maker route (FD, CFO, MD, Founder, Commercial Director)

AVOID producing segments that are:
- Local consumer-only businesses
- Restaurants (unless they directly manage overseas supplier payments)
- Local retailers with no import/export activity
- Blogs, directories, news sites, marketplaces
- Companies unlikely to handle FX directly
- Companies outside the UK
- Businesses with only indirect/weak exposure

Return ONLY valid JSON — no markdown, no code fences. Be specific and commercial, not academic.

Schema:
{
  "event_summary": "1-2 sentences: what happened and the core FX/financial implication",
  "event_type": "Currency move | Tariff | Rate decision | Geopolitical | Commodity | Trade policy | Macro data | Supply chain | Other",
  "exposure_types": ["EUR supplier payment exposure", "import margin pressure"],
  "overall_sales_angle": "The overarching reason to call UK businesses today because of this event",
  "target_segments": [
    {
      "segment_name": "European food importers",
      "business_model": "UK-based importer buying stock from European suppliers and selling domestically in GBP",
      "exposure_level": "Very High",
      "exposure_type": "Import cost exposure",
      "likely_currency_pairs": ["GBP/EUR"],
      "why_affected": "A weaker GBP increases EUR supplier costs, reducing margin if selling prices remain GBP-based.",
      "why_financially_exposed": "Recurring supplier payments in EUR combined with domestic GBP revenue creates direct currency mismatch. Every GBP/EUR move hits margin.",
      "ideal_company_profile": "UK SME importer, wholesaler or distributor with European suppliers and B2B customers",
      "high_intent_search_queries": [
        "\"Italian food importer\" UK",
        "\"European food distributor\" UK",
        "\"wholesale food importer\" UK"
      ],
      "companies_house_terms": ["food import", "European wholesale", "food distributor"],
      "website_validation_signals": ["imported from Italy", "European suppliers", "wholesale distribution", "international sourcing"],
      "avoid_segments": ["local restaurants", "consumer-only food shops", "recipe blogs"],
      "sales_angle": "With GBP/EUR moving, businesses buying from European suppliers may want to review how they manage upcoming EUR payments and protect margin.",
      "exposure_thesis_template": "This company appears to import [product] from European suppliers and distribute to UK customers in GBP. If supplier invoices are in EUR, recent GBP/EUR movement may squeeze margin on upcoming payments."
    }
  ]
}

Rules:
- Return 4-7 target segments, ranked by exposure_level (Very High first)
- Each segment must be a specific, actionable business type — not broad like "manufacturers"
- high_intent_search_queries: 3-5 specific search queries that will find real companies. Use quoted phrases for precision.
- companies_house_terms: 3-5 short terms (1-2 words) for Companies House free-text search
- exposure_level must be one of: Very High / High / Medium / Low
- Be specific about WHY each segment is financially exposed — not just "they might be affected"

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
        event["exposure_map"]     = exposure_map
        event["target_segments"]  = exposure_map.get("target_segments", [])
        event["exposure_types"]   = exposure_map.get("exposure_types", [])
        event["overall_sales_angle"] = exposure_map.get("overall_sales_angle", event.get("sales_angle",""))

        # Build flattened search terms and CH terms from all segments
        all_search_queries = []
        all_ch_terms       = []
        for seg in event["target_segments"]:
            all_search_queries.extend(seg.get("high_intent_search_queries", []))
            all_ch_terms.extend(seg.get("companies_house_terms", []))

        event["all_search_queries"] = list(dict.fromkeys(all_search_queries))[:20]
        event["companies_house_terms"] = list(dict.fromkeys(all_ch_terms))[:10]

        log.info("  Exposure map: %d segments | top: %s (%s)",
                 len(event["target_segments"]),
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

    # Dedupe, keep top 15
    seen = set()
    result = []
    for t in all_terms:
        if t.lower() not in seen:
            seen.add(t.lower())
            result.append(t)
    return result[:15]
