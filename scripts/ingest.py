"""
FX Discovery — ingest.py
Event Radar + Exposure Mapper

Rate limit safe:
- Only calls Gemini for new events not already in events.json
- Fallback mode: if Gemini 429s, creates a basic event from headline alone
- Hard cap: MAX 3 Gemini calls per run by default (change via DISCOVERY_MAX_EVENTS)
- Exponential backoff on 429
"""

import os, json, hashlib, logging, sys, time
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

# Hard cap: 3 Gemini calls per run. Override with DISCOVERY_MAX_EVENTS=5 in .env
MAX_EVENTS     = int(os.getenv("DISCOVERY_MAX_EVENTS", "3"))

DATA_DIR    = Path(__file__).parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.json"
DATA_DIR.mkdir(exist_ok=True)

gemini = genai.Client(api_key=GEMINI_API_KEY)

RSS_FEEDS = [
    {"source": "BBC Business",     "url": "http://feeds.bbci.co.uk/news/business/rss.xml"},
    {"source": "BBC News",         "url": "http://feeds.bbci.co.uk/news/rss.xml"},
    {"source": "Reuters Business", "url": "https://feeds.reuters.com/reuters/businessNews"},
    {"source": "FXStreet",         "url": "https://www.fxstreet.com/rss/news"},
    {"source": "Bank of England",  "url": "https://www.bankofengland.co.uk/rss/news"},
    {"source": "GOV.UK Trade",     "url": "https://www.gov.uk/search/news-and-communications.atom?keywords=trade"},
    {"source": "The Guardian Biz", "url": "https://www.theguardian.com/uk/business/rss"},
    {"source": "Sky News Biz",     "url": "https://feeds.skynews.com/feeds/rss/business.xml"},
]

KEYWORDS = [
    "currency","exchange rate","sterling","pound","gbp","euro","eur","dollar","usd",
    "forex","fx","rate","inflation","interest rate","bank of england","boe","fed","ecb",
    "tariff","tariffs","trade","import","export","sanction","customs","duty","supply chain",
    "oil","gas","opec","energy","fuel","commodity","commodities","wheat","grain","copper","steel",
    "shipping","freight","container","war","conflict","ukraine","russia","china","iran",
    "israel","middle east","sanctions","recession","gdp","growth","unemployment","wages","election",
]

def now_iso(): return datetime.now(timezone.utc).isoformat()
def normalise(t): return " ".join((t or "").lower().split())
def is_relevant(title, summary=""): return any(k in normalise(f"{title} {summary}") for k in KEYWORDS)
def dedupe_id(source, title): return hashlib.sha256(f"{source}:{normalise(title)}".encode()).hexdigest()[:16]
def load_events(): return json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
def save_events(e): EVENTS_FILE.write_text(json.dumps(e, indent=2, default=str))

def is_rate_limit_error(exc):
    msg = str(exc).lower()
    return "429" in msg or "quota" in msg or "rate" in msg or "resource_exhausted" in msg

def extract_json(text):
    text = text.strip().replace("```json","").replace("```","").strip()
    s, e = text.find("{"), text.rfind("}")
    if s == -1 or e == -1: raise ValueError("No JSON found")
    return json.loads(text[s:e+1])

def fetch_rss_items():
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
            if not title or not is_relevant(title, summary): continue
            key = dedupe_id(feed["source"], title)
            if key not in seen:
                seen[key] = {"id":key,"source":feed["source"],"source_url":link,
                             "headline":title,"raw_summary":summary[:600]}
    result = list(seen.values())
    log.info("Fetched %d relevant items from RSS", len(result))
    return result

TRIAGE_PROMPT = """You are screening market news for FX sales relevance for a UK foreign exchange broker.

Does this event create direct foreign currency payment exposure for UK businesses?

Return ONLY valid JSON:
{{"is_fx_relevant": true,
  "urgency_score": 8,
  "event_type": "Tariff | Rate change | Currency move | Geopolitical | Commodity | Trade policy | Supply chain | Macro data | Other",
  "summary": "2-3 sentences: what happened and the core FX implication for UK businesses",
  "currency_pairs": ["GBP/USD"],
  "sales_angle": "One-sentence reason to call UK businesses today"
}}

Headline: {headline}
Summary: {summary}"""

@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=2, min=5, max=60),
    retry=retry_if_exception_type(Exception),
)
def triage_event_api(item):
    """Call Gemini with retry and rate-limit awareness."""
    r = gemini.models.generate_content(
        model=GEMINI_MODEL,
        contents=TRIAGE_PROMPT.format(
            headline=item["headline"],
            summary=item.get("raw_summary","")
        )
    )
    return extract_json(r.text)

def build_fallback_event(item):
    """
    If Gemini is rate-limited, build a basic but usable event from the headline alone.
    Rule-based keyword matching — no AI required.
    Uses broad search terms that will find real companies.
    """
    headline = item["headline"].lower()
    summary  = item.get("raw_summary","").lower()
    text     = f"{headline} {summary}"

    # Determine event type from keywords
    if any(x in text for x in ["tariff","tariffs","trade war","customs","duty","wto"]):
        event_type = "Tariff"
        pairs = ["GBP/USD", "GBP/EUR"]
        segments = ["UK importers paying overseas suppliers", "UK exporters to US or EU"]
        ch_terms = ["import trading", "food international", "wines wholesale", "manufacturing international"]
    elif any(x in text for x in ["oil","crude","opec","petroleum","fuel","energy","gas"]):
        event_type = "Commodity"
        pairs = ["GBP/USD"]
        segments = ["UK petroleum and fuel importers", "UK chemical importers", "UK manufacturers buying commodity inputs"]
        ch_terms = ["chemicals wholesale", "chemical supplies", "petroleum wholesale", "fuel trading", "industrial chemicals"]
    elif any(x in text for x in ["rate","boe","fed","ecb","interest","monetary","inflation"]):
        event_type = "Rate change"
        pairs = ["GBP/USD", "GBP/EUR"]
        segments = ["UK importers with upcoming payments", "UK exporters with USD or EUR revenue"]
        ch_terms = ["food international", "wines wholesale", "seafood wholesale", "trading international"]
    elif any(x in text for x in ["war","conflict","iran","russia","ukraine","israel","sanctions","geopolit"]):
        event_type = "Geopolitical"
        pairs = ["GBP/USD"]
        segments = ["UK businesses paying USD supplier invoices", "UK energy and commodity buyers"]
        ch_terms = ["import trading", "food international", "chemicals wholesale", "trading international"]
    elif any(x in text for x in ["pound","sterling","gbp","euro","eur","dollar","usd","currency","exchange"]):
        event_type = "Currency move"
        pairs = []
        if any(x in text for x in ["pound","sterling","gbp"]):
            pairs.append("GBP/USD")
            if any(x in text for x in ["euro","eur","european"]):
                pairs.append("GBP/EUR")
        elif any(x in text for x in ["euro","eur"]):
            pairs.append("GBP/EUR")
        else:
            pairs = ["GBP/USD", "GBP/EUR"]
        segments = ["UK importers paying in EUR or USD", "UK businesses with overseas supplier invoices"]
        ch_terms = ["wines wholesale", "food international", "foods wholesale", "import trading", "international trading"]
    else:
        event_type = "Other"
        pairs = ["GBP/USD", "GBP/EUR"]
        segments = ["UK businesses with overseas payments", "UK importers and exporters"]
        ch_terms = ["food international", "import trading", "international trading", "trading wholesale"]

    urgency = 6  # Moderate default for fallback events

    return {
        **item,
        "detected_at":        now_iso(),
        "event_type":         event_type,
        "summary":            item.get("raw_summary","") or item["headline"],
        "currency_pairs":     pairs,
        "urgency_score":      urgency,
        "sales_angle":        f"Recent {event_type.lower()} event may affect UK businesses with overseas payments. Worth reviewing FX exposure.",
        "status":             "ready",
        "fallback_mode":      True,
        "companies_house_terms": ch_terms,
        "target_segments":    [
            {
                "segment_name": seg,
                "exposure_level": "High",
                "exposure_type": f"{event_type} exposure",
                "likely_currency_pairs": pairs,
                "companies_house_terms": ch_terms[:4],
                "website_validation_signals": ["import","overseas","international","wholesale","distribution"],
                "sales_angle": f"Recent {event_type.lower()} may affect businesses in this sector with overseas payment exposure.",
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
    log.info("%d new items to process (skipping %d already seen)", len(new_items), len(items)-len(new_items))

    # Hard cap to protect rate limits
    new_items = new_items[:MAX_EVENTS]

    saved = failed = rate_limited = fallback_used = 0
    rate_limit_hit = False

    for item in new_items:
        log.info("Processing: %s", item["headline"][:70])

        # If already rate-limited this run, use fallback for remaining items
        if rate_limit_hit:
            log.info("  Rate limit hit earlier — using fallback for remaining items")
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

            if not triage.get("is_fx_relevant") or urgency < 4:
                log.info("  Skip (not FX relevant, urgency=%d)", urgency)
                existing[item["id"]] = {**item, "detected_at":now_iso(),
                                         "status":"low_relevance", "urgency_score":urgency}
                continue

            event = {
                **item,
                "detected_at":    now_iso(),
                "event_type":     triage.get("event_type"),
                "summary":        triage.get("summary") or item.get("raw_summary",""),
                "currency_pairs": triage.get("currency_pairs", []),
                "urgency_score":  urgency,
                "sales_angle":    triage.get("sales_angle"),
                "status":         "ready",
            }

            log.info("  Running Exposure Mapper...")
            try:
                event = enrich_event_with_exposure_map(event)
            except Exception as exc:
                if is_rate_limit_error(exc):
                    log.warning("  Exposure Mapper rate limited — using fallback segments")
                    rate_limit_hit = True
                    fallback = build_fallback_event(item)
                    event["target_segments"]     = fallback["target_segments"]
                    event["companies_house_terms"] = fallback["companies_house_terms"]
                    event["fallback_mode"]        = True
                else:
                    log.warning("  Exposure Mapper failed: %s", exc)

            existing[item["id"]] = event
            saved += 1
            log.info("  ✓ Saved (urgency=%d, %d segments%s)",
                     urgency,
                     len(event.get("target_segments",[])),
                     " [fallback]" if event.get("fallback_mode") else "")

            # Small delay between Gemini calls to avoid rate limits
            time.sleep(2)

        except Exception as exc:
            if is_rate_limit_error(exc):
                log.warning("  429 Rate limit hit — switching to fallback mode for rest of run")
                rate_limit_hit = True
                rate_limited += 1
                # Use fallback instead of failing
                event = build_fallback_event(item)
                existing[item["id"]] = event
                fallback_used += 1
                saved += 1
                log.info("  ✓ Fallback event created (no AI needed)")
                time.sleep(10)  # Back off before any more calls
            else:
                log.error("  Failed: %s | %s", item.get("headline","?")[:50], exc)
                failed += 1

    save_events(existing)

    # Copy to public/data
    public_dir = Path(__file__).parent.parent / "public" / "data"
    public_dir.mkdir(parents=True, exist_ok=True)
    (public_dir / "events.json").write_text(EVENTS_FILE.read_text())

    log.info("=== Done: %d saved (%d fallback)  %d failed  %d rate-limited  |  %d total ===",
             saved, fallback_used, failed, rate_limited, len(existing))

    if rate_limit_hit:
        log.warning("=== Rate limit was hit. Run again in 1-2 minutes for full AI analysis ===")

if __name__ == "__main__":
    main()
