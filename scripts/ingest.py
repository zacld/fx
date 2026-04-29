"""
FX Discovery — ingest.py
Event Radar + Exposure Mapper

Flow:
1. Pull RSS feeds → filter for market-relevant headlines
2. Triage: is this FX relevant? What's the urgency?
3. Exposure Mapper: which UK business models are financially exposed, and how?
4. Save enriched event with ranked target segments and high-intent search queries
"""

import os, json, hashlib, logging, sys
from datetime import datetime, timezone
from pathlib import Path

import feedparser
from google import genai
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential

sys.path.insert(0, str(Path(__file__).parent))
from exposure_mapper import enrich_event_with_exposure_map

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
MAX_EVENTS     = int(os.getenv("DISCOVERY_MAX_EVENTS", "10"))

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
    result = list(seen.values())[:MAX_EVENTS]
    log.info("Fetched %d relevant items", len(result))
    return result

TRIAGE_PROMPT = """You are screening market news for FX sales relevance for a UK foreign exchange broker.

Does this event create direct foreign currency payment exposure for UK businesses?
This means: does it affect the cost of overseas payments, the value of overseas revenue,
or the risk of currency moves for UK companies making or receiving international payments?

Return ONLY valid JSON:
{{"is_fx_relevant": true,
  "urgency_score": 8,
  "event_type": "Tariff | Rate change | Currency move | Geopolitical | Commodity | Trade policy | Supply chain | Macro data | Other",
  "summary": "2-3 sentences: what happened and the core FX/financial implication for UK businesses",
  "currency_pairs": ["GBP/USD"],
  "sales_angle": "One-sentence reason to call UK businesses today because of this event"
}}

Rules:
- urgency_score 1-10. 8+ = call today. Below 5 = not worth calling about.
- is_fx_relevant: false if the event has no real FX exposure for UK businesses
- Be specific and commercial, not academic

Headline: {headline}
Summary: {summary}"""

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
def triage_event(item):
    r = gemini.models.generate_content(
        model=GEMINI_MODEL,
        contents=TRIAGE_PROMPT.format(headline=item["headline"], summary=item.get("raw_summary",""))
    )
    return extract_json(r.text)

def main():
    log.info("=== FX Ingest — Event Radar + Exposure Mapper ===")
    existing = load_events()
    items    = fetch_rss_items()
    saved = skipped = failed = 0

    for item in items:
        if item["id"] in existing:
            skipped += 1
            continue

        log.info("Processing: %s", item["headline"][:70])
        try:
            # Step 1: Triage
            triage  = triage_event(item)
            urgency = int(triage.get("urgency_score") or 0)

            if not triage.get("is_fx_relevant") or urgency < 4:
                log.info("  Skip (not FX relevant, urgency=%d)", urgency)
                existing[item["id"]] = {**item,"detected_at":now_iso(),"status":"low_relevance","urgency_score":urgency}
                continue

            # Step 2: Build base event
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

            # Step 3: Exposure Mapper — THE CORE UPGRADE
            log.info("  Running Exposure Mapper...")
            event = enrich_event_with_exposure_map(event)

            existing[item["id"]] = event
            saved += 1

        except Exception as exc:
            log.error("  Failed: %s | %s", item.get("headline","?")[:50], exc)
            failed += 1

    save_events(existing)

    # Copy to public/data for dashboard
    public_dir = Path(__file__).parent.parent / "public" / "data"
    public_dir.mkdir(parents=True, exist_ok=True)
    (public_dir / "events.json").write_text(EVENTS_FILE.read_text())

    log.info("=== Done: %d saved  %d skipped  %d failed  |  %d total ===",
             saved, skipped, failed, len(existing))

if __name__ == "__main__":
    main()
