"""
FX Discovery — ingest.py
Event Radar + Exposure Mapper

Pipeline:
  RSS headlines → commercial relevance pre-filter (rule-based, free)
                → triage (Gemini, only for score ≥ 5)
                → business impact translation (same Gemini call)
                → exposure mapper (second Gemini call per event)

Rate-limit safe:
  - Pre-filter eliminates noise before any AI call
  - Only processes headlines not already in events.json
  - Hard cap via DISCOVERY_MAX_EVENTS
  - Fallback mode if Gemini 429s
"""

import os, json, hashlib, logging, sys, time, re
from datetime import datetime, timezone
from pathlib import Path

import feedparser
from google import genai
from google.genai import errors as genai_errors
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

sys.path.insert(0, str(Path(__file__).parent))
from exposure_mapper import enrich_event_with_exposure_map

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
MAX_EVENTS     = int(os.getenv("DISCOVERY_MAX_EVENTS", "3"))

DATA_DIR    = Path(__file__).parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.json"
DATA_DIR.mkdir(exist_ok=True)

gemini = genai.Client(api_key=GEMINI_API_KEY)

RSS_FEEDS = [
    {"source": "BBC Business",     "url": "http://feeds.bbci.co.uk/news/business/rss.xml"},
    {"source": "Reuters Business", "url": "https://feeds.reuters.com/reuters/businessNews"},
    {"source": "FXStreet",         "url": "https://www.fxstreet.com/rss/news"},
    {"source": "Bank of England",  "url": "https://www.bankofengland.co.uk/rss/news"},
    {"source": "GOV.UK Trade",     "url": "https://www.gov.uk/search/news-and-communications.atom?keywords=trade"},
    {"source": "The Guardian Biz", "url": "https://www.theguardian.com/uk/business/rss"},
    {"source": "Sky News Biz",     "url": "https://feeds.skynews.com/feeds/rss/business.xml"},
]

# ─── COMMERCIAL RELEVANCE PRE-FILTER ─────────────────────────────
# Rule-based scoring before any AI call. Eliminates market noise (gold,
# DXY, stock indices, technical commentary) that can't drive SME FX leads.

_BOOST_RULES = [
    # Currency moves that directly affect UK business payments
    (r"\bgbp\b|\bpound\b|\bsterling\b",                          4),
    (r"\beur\b|\beuro\b",                                         2),
    (r"\busd\b|\bdollar\b",                                       2),
    # Trade policy — almost always actionable
    (r"\btariff|\btrade war|\btrade deal|\bimport duty|\bcustoms duty\b", 5),
    (r"\bsanction|\btrade ban|\btrade restriction|\bembargo\b",   4),
    (r"\bimport|\bexport\b",                                      3),
    # Rate decisions — affect borrowing costs and currency
    (r"\bbank of england|\bboe\b|\bbase rate\b",                  4),
    (r"\binterest rate|\brate decision|\brate cut|\brate hike\b", 3),
    (r"\bfed\b|\bfederal reserve\b|\becb\b|\brate rise\b",        2),
    # Supply chain and logistics
    (r"\bshipping cost|\bfreight|\bsupply chain disruption|\bcontainer\b", 4),
    (r"\bred sea|\bsuez|\bpanama canal\b",                        4),
    # Commodity moves that UK businesses actually buy
    (r"\boil price|\bcrude oil|\bwti|\bbrent\b",                  3),
    (r"\benergy price|\bgas price|\bfuel cost\b",                  3),
    (r"\bwheat|\bgrain|\bsteel|\bcopper|\baluminium\b",           2),
    # UK business direct impact
    (r"\buk business|\buk compan|\buk exporters|\buk importers\b", 4),
    (r"\binflation\b",                                             2),
    (r"\brecession\b",                                             2),
]

_PENALTY_RULES = [
    # Market commentary — no actionable business impact
    (r"\bgold\b|\bsilver\b|\bprecious metal\b",                   -3),
    (r"\bbitcoin|\bcrypto|\bethereum|\bdigital asset\b",          -5),
    (r"\bdow jones|\bs&p 500|\bnasdaq|\bstock market\b",          -3),
    (r"\bftse\b",                                                  -2),
    (r"\bdxy|\bdollar index\b",                                   -1),
    # Technical/trader language
    (r"\bholds above|\bbounces|\bfades after|\bslips after\b",    -3),
    (r"\btechnical analysis|\bresistance level|\bsupport level\b", -3),
    (r"\bbullish|\bbearish|\boverbought|\boversold\b",            -3),
    (r"\bspeculators|\boptions traders|\bfutures\b",              -2),
    # Generic market commentary
    (r"\bpowell comment|\bcomment by|\bspeech by\b",              -2),
]

# Initial keyword filter — must have at least one of these to enter the pipeline at all
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
    Rule-based commercial relevance score (0-10) for UK SME FX sales.
    Returns (score, reason_string). No API calls.

    Scoring intent:
      ≥ 7  → strong event, definitely process
      5-6  → moderate event, process if capacity allows
      < 5  → noise, skip
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
            score += points  # points are negative
            if points <= -2:
                reasons.append(f"{points} {pattern[:30]}")

    score = max(0, min(10, round(score / 2)))  # normalise: raw scores ~0-20 → 0-10
    reason = "; ".join(reasons[:3]) if reasons else "no strong signals"
    return score, reason


# ─── TRIAGE PROMPT (business impact translation) ──────────────────
# This is the "brain" that turns a headline into a commercial opportunity.
# It does NOT just classify — it translates the event into business impact.

TRIAGE_PROMPT = """You are a business FX exposure analyst for a UK B2B foreign exchange broker.

Your job is NOT to summarise market news.
Your job is to TRANSLATE a market event into its direct financial impact on UK businesses.

Think like a sales director asking: "Which businesses should we call today, and why?"

Given the headline and summary below, answer these questions:

1. What actually happened? (one factual sentence)
2. What changed financially? (what moved: currency, rate, commodity price, tariff level)
3. Who pays more as a result? (which business types face higher costs)
4. Who receives less as a result? (which business types face lower revenue)
5. Who has a currency mismatch? (costs in FX, revenue in GBP — or vice versa)
6. Who faces margin pressure? (buying price up, selling price fixed)
7. Who has payment timing risk? (upcoming FX payment that may now cost more)
8. Which specific business models are most exposed TODAY?

REJECT this headline if:
- It is technical trading commentary (holds above, bounces, fades)
- It is about gold, crypto, or stock indices with no business FX link
- It describes only market sentiment or trader positioning
- No UK business can clearly be identified as exposed

SCORING:
commercial_relevance 1-10:
  9-10: Direct currency/tariff/rate move with clear UK business exposure
  7-8:  Commodity or supply chain move with identifiable business types
  5-6:  Macro event with indirect but mappable business exposure
  3-4:  Possibly relevant but hard to link to specific businesses
  1-2:  Market commentary, no actionable business exposure

Only set "is_fx_relevant": true if commercial_relevance >= 5 AND we can name specific business types.

Return ONLY valid JSON, no markdown:
{{
  "is_fx_relevant": true,
  "commercial_relevance": 8,
  "commercial_relevance_reason": "Direct GBP/EUR move — UK importers buying from European suppliers face higher landed costs",
  "event_type": "Currency move | Tariff | Rate decision | Geopolitical | Commodity | Trade policy | Supply chain | Macro data",
  "urgency_score": 8,
  "what_happened": "One factual sentence: the specific event that occurred",
  "what_changed_financially": "What specifically moved — currency rate, tariff level, commodity price, rate",
  "who_pays_more": "Which business types now face higher costs (specific, not generic)",
  "who_receives_less": "Which business types now earn less (or none if not applicable)",
  "currency_mismatch_businesses": "Business types with costs in foreign currency but revenue in GBP",
  "margin_risk": "High | Medium | Low",
  "payment_timing_risk": "High | Medium | Low",
  "affected_payment_flow": "e.g. GBP revenue vs EUR supplier costs",
  "summary": "2-3 sentences: what happened, the financial implication, and why UK businesses should care",
  "currency_pairs": ["GBP/EUR"],
  "fx_payment_logic": "One paragraph: WHY specific UK businesses pay FX because of this, and what the risk is to them in plain English",
  "sales_angle": "One sentence a sales rep can say TODAY to open a conversation with an affected business"
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

def extract_json(text):
    text = text.strip().replace("```json", "").replace("```", "").strip()
    s, e = text.find("{"), text.rfind("}")
    if s == -1 or e == -1: raise ValueError("No JSON found")
    return json.loads(text[s:e+1])


def fetch_rss_items():
    """Fetch RSS, apply entry keyword filter and commercial relevance pre-score."""
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

            # Gate 1: must contain at least one entry keyword
            if not _ENTRY_KEYWORDS.search(f"{title} {summary}"):
                continue

            # Gate 2: commercial relevance pre-score
            rel_score, rel_reason = score_commercial_relevance(title, summary)
            if rel_score < 4:
                log.debug("  Skip (relevance %d/10): %s", rel_score, title[:60])
                continue

            key = dedupe_id(feed["source"], title)
            if key not in seen:
                seen[key] = {
                    "id":                    key,
                    "source":                feed["source"],
                    "source_url":            link,
                    "headline":              title,
                    "raw_summary":           summary[:600],
                    "pre_relevance_score":   rel_score,
                    "pre_relevance_reason":  rel_reason,
                }

    result = sorted(seen.values(), key=lambda x: x["pre_relevance_score"], reverse=True)
    log.info("Pre-filter: %d relevant items (from RSS feeds)", len(result))
    return result


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=2, min=5, max=60),
    retry=retry_if_exception_type(Exception),
)
def triage_event_api(item):
    r = gemini.models.generate_content(
        model=GEMINI_MODEL,
        contents=TRIAGE_PROMPT.format(
            headline=item["headline"],
            summary=item.get("raw_summary", ""),
        )
    )
    return extract_json(r.text)


def build_fallback_event(item):
    """
    Rule-based fallback when Gemini is rate-limited.
    Produces a usable event from headline alone.
    """
    headline = item["headline"].lower()
    summary  = item.get("raw_summary", "").lower()
    text     = f"{headline} {summary}"

    if any(x in text for x in ["tariff", "tariffs", "trade war", "customs duty"]):
        event_type = "Tariff"
        pairs      = ["GBP/USD", "GBP/EUR"]
        segments   = ["UK importers paying overseas suppliers", "UK exporters to US or EU"]
        ch_terms   = ["import trading", "food international", "wines wholesale", "manufacturing international"]
        fx_logic   = "New or increased tariffs raise the cost of imported goods. UK businesses buying stock from overseas suppliers face higher landed costs and margin pressure."
    elif any(x in text for x in ["oil", "crude", "opec", "petroleum", "fuel", "energy"]):
        event_type = "Commodity"
        pairs      = ["GBP/USD"]
        segments   = ["UK petroleum and fuel importers", "UK chemical importers", "UK manufacturers buying commodity inputs"]
        ch_terms   = ["chemicals wholesale", "chemical supplies", "petroleum wholesale", "fuel trading"]
        fx_logic   = "Energy and commodity prices move in USD. UK businesses buying commodities or fuel face higher GBP costs when oil moves up, or when GBP weakens against USD simultaneously."
    elif any(x in text for x in ["rate", "boe", "fed", "ecb", "interest", "monetary"]):
        event_type = "Rate decision"
        pairs      = ["GBP/USD", "GBP/EUR"]
        segments   = ["UK importers with upcoming supplier payments", "UK exporters with USD or EUR revenue"]
        ch_terms   = ["food international", "wines wholesale", "seafood wholesale", "trading international"]
        fx_logic   = "Interest rate decisions move currency values. UK businesses with overseas supplier payments or customer receipts face changed FX costs depending on which currency moved."
    elif any(x in text for x in ["shipping", "freight", "supply chain", "container", "red sea"]):
        event_type = "Supply chain"
        pairs      = ["GBP/USD"]
        segments   = ["UK importers dependent on sea freight", "UK manufacturers with overseas suppliers"]
        ch_terms   = ["import trading", "food wholesale", "chemicals wholesale", "manufacturing international"]
        fx_logic   = "Shipping disruption raises freight costs (priced in USD) and delays overseas supplier deliveries. UK importers face both higher freight bills and stock uncertainty."
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
        segments = ["UK importers paying in EUR or USD", "UK businesses with overseas supplier invoices"]
        ch_terms = ["wines wholesale", "food international", "foods wholesale", "import trading"]
        fx_logic = "A currency move directly affects the GBP cost of any overseas supplier invoice or the GBP value of any overseas customer receipt. UK businesses with recurring international payments are immediately exposed."
    else:
        event_type = "Macro data"
        pairs      = ["GBP/USD", "GBP/EUR"]
        segments   = ["UK businesses with overseas payments", "UK importers and exporters"]
        ch_terms   = ["food international", "import trading", "international trading"]
        fx_logic   = "Macro events can shift currency values and affect UK businesses with overseas payment obligations."

    return {
        **item,
        "detected_at":         now_iso(),
        "event_type":          event_type,
        "summary":             item.get("raw_summary", "") or item["headline"],
        "currency_pairs":      pairs,
        "urgency_score":       6,
        "fx_payment_logic":    fx_logic,
        "margin_risk":         "Medium",
        "payment_timing_risk": "Medium",
        "affected_payment_flow": f"GBP revenue vs {'/'.join(pairs)} supplier costs" if pairs else "overseas payments",
        "sales_angle":         f"Recent {event_type.lower()} may affect UK businesses with overseas payments. Worth reviewing FX exposure.",
        "status":              "ready",
        "fallback_mode":       True,
        "companies_house_terms": ch_terms,
        "target_segments": [
            {
                "segment_name":              seg,
                "exposure_level":            "High",
                "exposure_type":             f"{event_type} exposure",
                "likely_currency_pairs":     pairs,
                "companies_house_terms":     ch_terms[:4],
                "website_validation_signals":["import", "overseas", "international", "wholesale", "distribution"],
                "fx_payment_logic":          fx_logic,
                "margin_risk":               "Medium",
                "payment_timing_risk":       "Medium",
                "sales_angle":               f"Recent {event_type.lower()} may affect businesses in this sector with overseas payment exposure.",
            }
            for seg in segments
        ],
    }


def main():
    log.info("=== FX Ingest (max %d new events) ===", MAX_EVENTS)
    existing = load_events()
    items    = fetch_rss_items()

    # Only process items we haven't seen before
    new_items = [i for i in items if i["id"] not in existing]
    log.info("%d new items to process (skipping %d already seen)",
             len(new_items), len(items) - len(new_items))

    # Process highest-relevance items first, up to cap
    new_items = new_items[:MAX_EVENTS]

    saved = failed = rate_limited = fallback_used = 0
    rate_limit_hit = False

    for item in new_items:
        log.info("Processing [rel=%d/10]: %s", item.get("pre_relevance_score", 0), item["headline"][:70])

        if rate_limit_hit:
            log.info("  Rate limit hit earlier — using fallback")
            try:
                event = build_fallback_event(item)
                event = enrich_event_with_exposure_map(event)
            except Exception:
                event = build_fallback_event(item)
            existing[item["id"]] = event
            fallback_used += 1
            saved += 1
            continue

        try:
            triage  = triage_event_api(item)
            urgency = int(triage.get("urgency_score") or 0)
            comm_rel = int(triage.get("commercial_relevance") or 0)

            # Reject if not FX relevant OR commercial relevance too low
            if not triage.get("is_fx_relevant") or urgency < 4 or comm_rel < 5:
                log.info("  Skip (not commercially relevant — score=%d, urgency=%d)",
                         comm_rel, urgency)
                existing[item["id"]] = {
                    **item,
                    "detected_at":          now_iso(),
                    "status":               "low_relevance",
                    "urgency_score":        urgency,
                    "commercial_relevance": comm_rel,
                    "commercial_relevance_reason": triage.get("commercial_relevance_reason", ""),
                }
                continue

            log.info("  ✓ Commercially relevant (score=%d/10, urgency=%d/10) — %s",
                     comm_rel, urgency, triage.get("commercial_relevance_reason", "")[:60])

            event = {
                **item,
                "detected_at":                  now_iso(),
                "event_type":                   triage.get("event_type"),
                "summary":                      triage.get("summary") or item.get("raw_summary", ""),
                "currency_pairs":               triage.get("currency_pairs", []),
                "urgency_score":                urgency,
                "commercial_relevance":         comm_rel,
                "commercial_relevance_reason":  triage.get("commercial_relevance_reason", ""),
                # Business impact translation — the new fields
                "what_happened":                triage.get("what_happened", ""),
                "what_changed_financially":     triage.get("what_changed_financially", ""),
                "who_pays_more":                triage.get("who_pays_more", ""),
                "who_receives_less":            triage.get("who_receives_less", ""),
                "currency_mismatch_businesses": triage.get("currency_mismatch_businesses", ""),
                "margin_risk":                  triage.get("margin_risk", ""),
                "payment_timing_risk":          triage.get("payment_timing_risk", ""),
                "affected_payment_flow":        triage.get("affected_payment_flow", ""),
                "fx_payment_logic":             triage.get("fx_payment_logic", ""),
                "sales_angle":                  triage.get("sales_angle", ""),
                "status":                       "ready",
            }

            log.info("  Running Exposure Mapper...")
            try:
                event = enrich_event_with_exposure_map(event)
            except Exception as exc:
                if is_rate_limit_error(exc):
                    log.warning("  Exposure Mapper rate limited — using fallback segments")
                    rate_limit_hit = True
                    fallback = build_fallback_event(item)
                    event["target_segments"]       = fallback["target_segments"]
                    event["companies_house_terms"] = fallback["companies_house_terms"]
                    event["fallback_mode"]         = True
                else:
                    log.warning("  Exposure Mapper failed: %s", exc)

            existing[item["id"]] = event
            saved += 1
            log.info("  ✓ Saved (urgency=%d, relevance=%d, %d segments%s)",
                     urgency, comm_rel, len(event.get("target_segments", [])),
                     " [fallback]" if event.get("fallback_mode") else "")

            time.sleep(2)

        except Exception as exc:
            if is_rate_limit_error(exc):
                log.warning("  429 Rate limit — switching to fallback mode")
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
        log.warning("=== Rate limit was hit. Run again in 1-2 minutes for full AI analysis ===")


if __name__ == "__main__":
    main()
