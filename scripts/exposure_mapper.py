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

load_dotenv()
log = logging.getLogger(__name__)

# AI provider abstraction (Gemini → Grok → static playbook)
from ai_provider import call_ai_for_event

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
TWO-LEVEL EXPOSURE ANALYSIS — REQUIRED FOR ALL EVENTS
═══════════════════════════════════════
For ALL events, and especially for commodity / fuel / shipping / supply-chain events,
evaluate two levels of exposure and include both in your segments.

LEVEL 1 — DIRECT EXPOSURE
Who pays the cost directly?
  - Airlines paying jet fuel / aviation fuel surcharges
  - Shipping companies paying bunker fuel costs
  - Freight operators with direct fuel exposure
  - Energy-intensive manufacturers

LEVEL 2 — SECOND-ORDER SME EXPOSURE (often commercially superior)
Who gets hit THROUGH their supply chain, freight costs, or supplier pricing?
  - Importers using air freight or sea freight (freight surcharges passed through)
  - Distributors with overseas suppliers (landed cost increases)
  - Manufacturers with long-haul supply chains (input cost increases)
  - E-commerce brands importing stock from Asia or USA (air freight cost rise)
  - Food importers relying on chilled / fast air logistics
  - Medical device importers using express air freight
  - Tour operators with fixed-price packages including fuel surcharges
  - ANY UK SME paying overseas suppliers for goods shipped by air or sea

For FX sales, LEVEL 2 often produces better SME targets than LEVEL 1:
  - Level 1 targets (airlines, shipping lines) are typically PLCs or global groups
  - Level 2 targets are UK SMEs with FDs/MDs reachable by outbound
  - Level 2 targets have recurring import/FX payment flows that can be hedged

RULE: For commodity / fuel / shipping events, you MUST include at least 3 Level 2 segments.
Tag each segment with: "direct_or_second_order": "direct" | "second_order" | "both"

═══════════════════════════════════════
SME ACCESSIBILITY SCORING — REQUIRED FOR EVERY SEGMENT
═══════════════════════════════════════
Every segment must include sme_accessibility_score (0-100):

  80-100: Many UK SMEs exist, decision-makers reachable, company websites available
          Examples: food importers, wine importers, chemical distributors, machinery importers
          Hundreds or thousands of UK companies in this niche.

  60-79:  Good SME presence but some large players dominate
          Examples: freight forwarders, logistics brokers, specialist distributors
          Mix of SMEs and larger companies; still plenty of reachable targets.

  40-59:  Limited SME population or structurally harder to reach
          Examples: specialist aerospace parts traders, niche commodity traders

  0-39:   Oligopolistic, PLC-dominated, or too few UK operators
          Examples: UK commercial airlines (~10 operators), global shipping lines (non-UK multinationals)
          Avoid making these the ONLY categories — always pair with Level 2 segments.

FINAL SCRAPE SCORE:
  final_scrape_score = round(0.7 × category_priority_score + 0.3 × sme_accessibility_score)
  This is what Brain 3 will actually use to select categories.
  Compute and include it for every segment.

SME accessibility rewards:
  - Many UK SMEs likely exist in this niche
  - Decision-makers (FD/MD/CFO) are reachable by outbound
  - Company websites exist and validate FX exposure
  - Not dominated by PLCs or multinationals
  - Sufficient population to generate 10+ leads

SME accessibility penalises:
  - Oligopolistic markets (fewer than 20 UK operators)
  - PLC-heavy sectors where junior outbound won't reach the buyer
  - Global shipping lines, major airlines — not SME-accessible
  - Sectors where the commercial buyer is not reachable by phone/email

═══════════════════════════════════════
RANKING PRIORITY
═══════════════════════════════════════
Rank segments by final_scrape_score (not just category_priority_score):
1. Directness of FX exposure (do they literally pay or receive foreign currency?)
2. Exposure size (larger recurring FX volumes = higher rank)
3. Margin sensitivity (thin-margin importers/distributors hit hardest)
4. Payment timing risk (upcoming invoice due dates create urgency)
5. SME accessibility (are there many UK SMEs in this niche that Zac can actually call?)

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
      "direct_or_second_order": "second_order",
      "category_priority_score": 88,
      "sme_accessibility_score": 85,
      "final_scrape_score": 87,
      "why_sme_accessible": "Thousands of UK wine importers registered at Companies House, most are SMEs with reachable FDs or MDs, company websites clearly show import activity.",
      "business_model": "UK importers buying wine and spirits from French, Italian, Spanish producers, selling to UK on-trade and off-trade in GBP. Supplier invoices in EUR, all UK revenue in GBP. Margins typically 15-25%.",
      "exposure_level": "Very High",
      "exposure_type": "Import cost exposure — EUR supplier payments vs GBP revenue",
      "likely_currency_pairs": ["GBP/EUR"],
      "why_affected": "GBP weakening against EUR directly increases the GBP cost of every EUR-denominated supplier invoice, squeezing gross margin on each shipment.",
      "why_financially_exposed": "Recurring quarterly or monthly EUR payments to European producers with no GBP revenue offset. A 2% GBP/EUR move on £500k annual buy = £10k margin erosion.",
      "fx_payment_logic": "Importer receives invoice from French producer in EUR → converts GBP to EUR to pay → if GBP has fallen since pricing was set, conversion costs more GBP than budgeted → margin compressed immediately",
      "margin_risk": "High — gross margins typically 15-25%, a 3-5% GBP/EUR adverse move can eliminate 10-20% of gross profit on a shipment if unhedged",
      "payment_timing_risk": "High — wine importers typically have 30-90 day payment terms, creating an open FX window between order and payment.",
      "affected_payment_flow": "EUR payments to European wine producers, typically £50k-£500k per shipment, quarterly or on harvest cycle",
      "ideal_company_profile": "UK SME wine importer or distributor, 5-50 staff, buying direct from European producers. FD or MD makes payment decisions.",
      "micro_categories": [
        {
          "name": "French wine importers UK",
          "why": "Bordeaux, Burgundy, Champagne producers invoice in EUR; GBP weakness hits every shipment",
          "search_queries": ["\"French wine importer\" UK", "\"wine from France\" wholesale UK distributor"],
          "companies_house_terms": ["French wine", "wine France", "Bordeaux wine"]
        },
        {
          "name": "Italian wine and spirits importers UK",
          "why": "Prosecco, Barolo, Grappa sourced in EUR from Italian producers",
          "search_queries": ["\"Italian wine importer\" UK", "\"wine from Italy\" wholesale UK"],
          "companies_house_terms": ["Italian wine", "wine Italy", "Prosecco"]
        },
        {
          "name": "Spanish and Portuguese wine importers UK",
          "why": "Rioja, Cava, Port — recurring EUR supplier invoices",
          "search_queries": ["\"Spanish wine importer\" UK", "\"wine from Spain\" distributor UK"],
          "companies_house_terms": ["Spanish wine", "wine Spain", "Rioja"]
        },
        {
          "name": "European premium spirits importers UK",
          "why": "Cognac, Calvados, European liqueurs — EUR purchase costs on premium products",
          "search_queries": ["\"spirits importer\" UK European", "\"Cognac importer\" UK distributor"],
          "companies_house_terms": ["spirits import", "spirits wholesale", "liqueur import"]
        }
      ],
      "website_validation_signals": ["imported from", "direct from the producer", "European vineyards", "exclusive importer", "sourced from Italy", "French wine"],
      "avoid_segments": ["retail wine shops with no import activity", "supermarkets", "pub chains", "wine blogs"],
      "sales_angle": "With GBP/EUR moving, any upcoming EUR wine payments cost more in GBP than when orders were placed. Worth a conversation about protecting margin on the next shipment.",
      "exposure_thesis_template": "This business appears to import wine/spirits directly from European producers, with revenue in GBP. If supplier invoices are in EUR, the recent GBP/EUR move is increasing the GBP cost of upcoming stock payments."
    }
  ]
}

═══════════════════════════════════════
REQUIRED FIELDS — EVERY SEGMENT MUST INCLUDE ALL FOUR
═══════════════════════════════════════
These fields are REQUIRED on every target_segment. A response missing any of them is invalid.

1. "direct_or_second_order": "direct" | "second_order" | "both"
   direct      = segment pays the FX/fuel/commodity cost directly (airlines, shipping lines, fuel buyers)
   second_order = segment exposed through supply chain, freight surcharges, or landed input prices
   both        = both apply to this niche

2. "sme_accessibility_score": integer 0–100
   How many reachable UK SMEs exist in this niche?
   0–39:  Oligopolistic / PLC-dominated (e.g. UK airlines ~10 operators, global shipping lines)
   40–59: Limited or specialist population
   60–79: Mixed — some SMEs among larger players
   80–100: Many UK SMEs, reachable FDs/MDs, findable websites

3. "final_scrape_score": integer 0–100
   MUST equal: round(0.7 × category_priority_score + 0.3 × sme_accessibility_score)
   This is the score Brain 3 uses to rank and filter categories.
   A direct airline segment with category_priority_score=90 but sme_accessibility_score=25
   gets final_scrape_score = round(0.7×90 + 0.3×25) = round(63+7.5) = 71
   A food importer segment with category_priority_score=88 and sme_accessibility_score=85
   gets final_scrape_score = round(0.7×88 + 0.3×85) = round(61.6+25.5) = 87

4. "why_sme_accessible": string (1 sentence)
   Why UK SMEs exist in this niche and why decision-makers are reachable by outbound sales.

IMPORTANT: Do not omit these fields to save space. They are the primary mechanism by which
second-order SME-rich categories outrank PLC-heavy direct categories in discovery.
If you include airlines (sme_accessibility_score ~25) and food importers (sme_accessibility_score ~85),
the food importers will correctly outrank the airlines in final_scrape_score.

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
- exposure_level: Very High / High / Medium / Low only
- avoid_segments: must be specific to THIS segment — not a generic list
- Each segment MUST include a micro_categories array with 3-5 micro-categories
- Each micro-category must have: name (specific sub-niche), why (1 sentence explaining the FX logic for this sub-niche), search_queries (2-3 specific quoted-phrase queries that will find REAL UK companies), companies_house_terms (2-3 short 1-2 word terms that appear in real UK company names)
- micro_categories must be MORE SPECIFIC than the parent segment — e.g. "European wine importers" breaks into: French wine importers UK, Italian wine importers UK, Spanish wine importers UK, European premium spirits UK
- Do NOT include high_intent_search_queries or companies_house_terms at the segment level — all queries and CH terms now live inside micro_categories only
- Each segment MUST include ALL THREE score fields:
    category_priority_score (0-100): commercial FX opportunity
      Score 90-100: Direct, recurring FX payment flow, thin margins, strong UK SME fit, easy to find evidence
      Score 75-89: Clear FX exposure, good commercial fit, findable on web
      Score 65-74: Likely FX exposure, some evidence available — above scrape threshold
      Score 50-64: Indirect or infrequent FX exposure — below scrape threshold, do not scrape
      Score < 50:  Weak FX link — list for completeness only, will not be scraped
      Scoring dimensions: direct payment-flow exposure (30pts), recurring FX likelihood (20pts), margin sensitivity (15pts), UK SME suitability (15pts), website evidence availability (10pts), contactability (10pts)

    sme_accessibility_score (0-100): how reachable are UK SMEs in this niche?
      80-100: Many UK SMEs, websites available, FD/MD reachable by outbound
      60-79:  Good SME presence, mix with larger companies
      40-59:  Limited population or specialist/hard-to-reach
      0-39:   Oligopolistic, PLC-dominated, or fewer than 20 UK operators

    final_scrape_score (0-100): round(0.7 × category_priority_score + 0.3 × sme_accessibility_score)
      This is what Brain 3 uses to select which categories to scrape.
      Segments with final_scrape_score < 65 will not be scraped.

- Each segment MUST include:
    direct_or_second_order: "direct" | "second_order" | "both"
    why_sme_accessible: 1 sentence explaining why many reachable UK SMEs exist (or why they don't)

Market event to analyse:
Source: {source}
Headline: {headline}
Summary: {summary}
"""

# ── Rule-based Brain 2 field inference ───────────────────────────────────────
# Used when Gemini omits required segment fields (direct_or_second_order,
# sme_accessibility_score, final_scrape_score, why_sme_accessible).
# Applied defensively — does not override values Gemini DID provide.

_DIRECT_TERMS = {
    "airline", "airlines", "air cargo", "air freight operator", "aviation operator",
    "shipping line", "maritime shipping", "container shipping", "tanker operator",
    "bulk carrier", "ferry operator", "ferry service",
    "power generator", "power station", "power plant",
    "utility", "utilities", "electricity supplier", "gas supplier", "energy supplier",
    "oil major", "petroleum producer", "refinery", "fuel buyer", "fuel trader",
}

_SECOND_ORDER_TERMS = {
    "importer", "importers", "importing",
    "distributor", "distributors", "distribution",
    "wholesaler", "wholesale", "wholesalers",
    "manufacturer", "manufacturers", "manufacturing",
    "food processor", "food processing", "food producer",
    "beverage", "coffee roaster", "coffee importer",
    "chocolate", "confectionery", "bakery", "bakeries",
    "seafood", "fish importer", "seafood importer",
    "electronics importer", "electrical importer",
    "machinery importer", "component distributor",
    "e-commerce", "ecommerce", "online retailer",
    "packaging supplier", "packaging manufacturer",
    "textile", "fashion", "apparel", "clothing wholesaler",
    "chemical distributor", "chemical importer",
    "pharmaceutical importer", "medical device",
    "wine importer", "spirits importer",
    "freight surcharge", "landed cost", "supply chain cost",
}

_LOW_SME_TERMS = {
    "airline", "airlines", "air cargo airline", "air cargo operator",
    "shipping line", "maritime", "container shipping line",
    "tanker", "bulk carrier", "ferry operator",
    "power generator", "power station", "utility", "utilities",
    "oil major", "petroleum producer", "refinery",
    "global carrier", "national grid",
}

_HIGH_SME_TERMS = {
    "importer", "importers",
    "distributor", "distributors",
    "wholesaler", "wholesale",
    "food processor", "food producer", "food manufacturer",
    "beverage", "coffee", "chocolate", "confectionery", "bakery",
    "seafood", "fish",
    "electronics", "electrical",
    "machinery", "component",
    "e-commerce", "ecommerce",
    "packaging",
    "textile", "fashion", "apparel", "clothing",
    "chemical", "pharmaceutical", "medical device",
    "wine", "spirits",
}


def _infer_segment_fields(seg: dict) -> dict:
    """
    Rule-based inference for missing Brain 2 required fields.
    Only sets fields that are absent — never overrides values Gemini returned.
    Returns the updated segment dict.
    """
    name = (seg.get("segment_name") or "").lower()
    inferred = []

    # 1. direct_or_second_order
    if not seg.get("direct_or_second_order"):
        is_direct  = any(t in name for t in _DIRECT_TERMS)
        is_second  = any(t in name for t in _SECOND_ORDER_TERMS)
        if is_second and not is_direct:
            val = "second_order"
        elif is_direct and not is_second:
            val = "direct"
        elif is_direct and is_second:
            val = "both"
        else:
            val = "direct"   # conservative default
        seg["direct_or_second_order"] = val
        inferred.append(f"direct_or_second_order={val!r}")

    # 2. sme_accessibility_score
    if seg.get("sme_accessibility_score") is None:
        is_low  = any(t in name for t in _LOW_SME_TERMS)
        is_high = any(t in name for t in _HIGH_SME_TERMS)
        if is_low and not is_high:
            score = 28        # Oligopolistic / PLC-heavy
        elif is_high and not is_low:
            score = 80        # Many UK SMEs
        elif is_high and is_low:
            score = 55        # Mixed
        else:
            score = 60        # Neutral default
        seg["sme_accessibility_score"] = score
        inferred.append(f"sme_accessibility_score={score}")

    # 3. final_scrape_score
    if seg.get("final_scrape_score") is None:
        cps = seg.get("category_priority_score") or 0
        sme = seg.get("sme_accessibility_score") or 60
        fss = round(0.7 * cps + 0.3 * sme)
        seg["final_scrape_score"] = fss
        inferred.append(f"final_scrape_score={fss}")

    # 4. why_sme_accessible
    if not seg.get("why_sme_accessible"):
        sme = seg.get("sme_accessibility_score", 60)
        d2  = seg.get("direct_or_second_order", "direct")
        if sme >= 75:
            msg = "[inferred] Many UK SMEs in this niche with reachable FDs/MDs and findable company websites."
        elif sme <= 40:
            msg = "[inferred] Low SME accessibility — sector dominated by PLCs or very few UK operators."
        else:
            msg = "[inferred] Mixed sector; some UK SMEs present alongside larger companies."
        seg["why_sme_accessible"] = msg
        inferred.append("why_sme_accessible")

    if inferred:
        log.debug("  Inferred on %r: %s", seg.get("segment_name","?")[:40], ", ".join(inferred))

    return seg


def _validate_and_infer_segments(segments: list, ai_provider: str) -> list:
    """
    Validate required Brain 2 fields on every segment.
    Logs a warning for any that Gemini omitted, then applies rule-based inference.
    Returns the updated segments list.
    """
    required = [
        "direct_or_second_order",
        "sme_accessibility_score",
        "final_scrape_score",
        "why_sme_accessible",
    ]
    missing_counts  = {f: 0 for f in required}
    missing_examples = {f: [] for f in required}

    for seg in segments:
        name = seg.get("segment_name", "unknown")[:45]
        for field in required:
            val = seg.get(field)
            absent = val is None or val == ""
            if absent:
                missing_counts[field] += 1
                if len(missing_examples[field]) < 3:
                    missing_examples[field].append(name)

    any_missing = any(v > 0 for v in missing_counts.values())
    if any_missing:
        log.warning(
            "%s omitted required Brain 2 fields — applying rule-based inference:",
            ai_provider,
        )
        for field, count in missing_counts.items():
            if count > 0:
                ex = "; ".join(missing_examples[field])
                log.warning("  %-30s missing on %d/%d  (e.g. %s)",
                            field, count, len(segments), ex)
    else:
        log.info("Brain 2 fields complete — all %d segments have required fields", len(segments))

    # Apply inference (only fills fields that are still absent)
    for seg in segments:
        _infer_segment_fields(seg)

    # Log post-inference summary
    direct_n  = sum(1 for s in segments if s.get("direct_or_second_order") == "direct")
    second_n  = sum(1 for s in segments if s.get("direct_or_second_order") == "second_order")
    both_n    = sum(1 for s in segments if s.get("direct_or_second_order") == "both")
    scores    = [(s.get("segment_name","?")[:35], s.get("final_scrape_score",0))
                 for s in segments]
    scores.sort(key=lambda x: -x[1])
    log.info("  Brain 2 post-inference: direct=%d  second_order=%d  both=%d", direct_n, second_n, both_n)
    for name, fss in scores:
        cps = next((s.get("category_priority_score",0) for s in segments if s.get("segment_name","")[:35] == name), 0)
        sme = next((s.get("sme_accessibility_score",0) for s in segments if s.get("segment_name","")[:35] == name), 0)
        d2  = next((s.get("direct_or_second_order","?") for s in segments if s.get("segment_name","")[:35] == name), "?")
        log.info("    [fss=%3d cps=%3d sme=%3d %-12s] %s", fss, cps, sme, d2, name)

    return segments


def map_exposures(event: dict) -> dict:
    """
    Takes a raw event dict and returns an exposure map with
    ranked target segments, high-intent search queries, and sales angles.
    Uses call_ai_for_event() which tries Gemini → Grok → empty {} for static fallback.
    """
    prompt = EXPOSURE_MAPPER_PROMPT.format(
        source=event.get("source", ""),
        headline=event.get("headline", ""),
        summary=event.get("raw_summary") or event.get("summary", ""),
    )
    result, ai_meta = call_ai_for_event(prompt, event.get("headline", ""))

    # Store provider metadata on the event (caller merges into event dict)
    event["_ai_meta"] = ai_meta

    if not result:
        # All providers failed — caller will handle gracefully via existing fallback
        log.warning("map_exposures: all AI providers failed, returning empty map")
        return {}

    # ── Micro-category compliance check ──────────────────────────────────────
    # Separates two failure modes: (a) model dropped micro_categories from output,
    # vs (b) the iteration code failed to read them.
    segs = result.get("target_segments", [])
    missing_micro = [
        s.get("segment_name", "unknown segment")
        for s in segs
        if not s.get("micro_categories")
    ]
    total_micro = sum(len(s.get("micro_categories", [])) for s in segs)

    if missing_micro:
        log.warning(
            "%s returned %d target_segments but %d are missing micro_categories. Examples: %s",
            ai_meta.get("ai_provider_used", "AI"), len(segs), len(missing_micro), missing_micro[:3],
        )
    if len(segs) >= 4 and total_micro == 0:
        log.warning(
            "Broad event returned segments but no micro-categories — "
            "discovery will fall back to flat segment queries."
        )

    log.info("Exposure map parsed: %d segments, %d micro-categories [provider=%s]",
             len(segs), total_micro, ai_meta.get("ai_provider_used", "?"))

    return result

def enrich_event_with_exposure_map(event: dict) -> dict:
    """
    Runs the exposure mapper on an event and merges results back into the event dict.
    Returns the enriched event. Fails gracefully on rate limits.
    """
    try:
        exposure_map = map_exposures(event)

        # Pull AI provider metadata set by map_exposures() and clean up temp key
        ai_meta = event.pop("_ai_meta", {})
        event["ai_provider_used"]   = ai_meta.get("ai_provider_used")
        event["ai_model_used"]      = ai_meta.get("ai_model_used")
        event["ai_fallback_reason"] = ai_meta.get("ai_fallback_reason")

        event["exposure_map"]          = exposure_map
        event["target_segments"]       = exposure_map.get("target_segments", [])
        event["exposure_types"]        = exposure_map.get("exposure_types", [])
        event["overall_sales_angle"]   = exposure_map.get("overall_sales_angle", event.get("sales_angle",""))
        event["business_impact_summary"] = exposure_map.get("business_impact_summary", "")
        event["event_breadth"]         = exposure_map.get("event_breadth", "sector_specific")

        # Validate Brain 2 required fields and apply rule-based inference for any missing
        if event["target_segments"]:
            event["target_segments"] = _validate_and_infer_segments(
                event["target_segments"],
                ai_meta.get("ai_provider_used", "AI")
            )

        # Build flattened search queries and CH terms from micro_categories (new format)
        # with backward compat for old events that have segment-level queries
        all_search_queries = []
        all_ch_terms       = []
        total_micro_cats   = 0
        for seg in event["target_segments"]:
            for mc in seg.get("micro_categories", []):
                all_search_queries.extend(mc.get("search_queries", []))
                all_ch_terms.extend(mc.get("companies_house_terms", []))
                total_micro_cats += 1
            # Backward compat: also collect any segment-level terms (old events)
            all_search_queries.extend(seg.get("high_intent_search_queries", []))
            all_ch_terms.extend(seg.get("companies_house_terms", []))

        event["all_search_queries"]     = list(dict.fromkeys(all_search_queries))[:50]
        event["companies_house_terms"]  = list(dict.fromkeys(all_ch_terms))[:30]
        event["total_micro_categories"] = total_micro_cats

        n = len(event["target_segments"])
        breadth = event["event_breadth"]
        log.info("  Exposure map: %d segments, %d micro-cats [%s, provider=%s] | top: %s (%s)",
                 n, total_micro_cats, breadth, ai_meta.get("ai_provider_used", "?"),
                 event["target_segments"][0]["segment_name"] if event["target_segments"] else "none",
                 event["target_segments"][0]["exposure_level"] if event["target_segments"] else "—")

    except Exception as exc:
        msg = str(exc).lower()
        if "429" in msg or "quota" in msg or "rate" in msg or "resource_exhausted" in msg:
            log.warning("  Exposure Mapper rate limited — will use fallback segments")
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

        # Segment-level CH terms (backward compat for old events)
        all_terms.extend(seg.get("companies_house_terms", []))
        # Micro-category CH terms (new format)
        for mc in seg.get("micro_categories", []):
            all_terms.extend(mc.get("companies_house_terms", []))

    # Dedupe, keep top 40
    seen = set()
    result = []
    for t in all_terms:
        if t.lower() not in seen:
            seen.add(t.lower())
            result.append(t)
    return result[:40]
