"""
FX Discovery v2 — ingest.py
Free APIs only. Gemini 2.0 Flash.

ANY world event gets analysed. The only question asked is:
"Which UK businesses make payments in foreign currency because of this?"
"""

import os, json, hashlib, logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import feedparser
from google import genai
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential

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
    {"source": "BBC News",         "url": "http://feeds.bbci.co.uk/news/rss.xml"},
    {"source": "BBC Business",     "url": "http://feeds.bbci.co.uk/news/business/rss.xml"},
    {"source": "Reuters Business", "url": "https://feeds.reuters.com/reuters/businessNews"},
    {"source": "FXStreet",         "url": "https://www.fxstreet.com/rss/news"},
    {"source": "Bank of England",  "url": "https://www.bankofengland.co.uk/rss/news"},
    {"source": "GOV.UK Trade",     "url": "https://www.gov.uk/search/news-and-communications.atom?keywords=trade"},
    {"source": "The Guardian Biz", "url": "https://www.theguardian.com/uk/business/rss"},
    {"source": "Sky News",         "url": "https://feeds.skynews.com/feeds/rss/business.xml"},
]

# Cast wide — any world event could create FX exposure for UK businesses
KEYWORDS = [
    # Markets & currency
    "currency","exchange rate","sterling","pound","gbp","euro","eur","dollar","usd",
    "forex","fx","rate","rates","inflation","interest rate","cpi","pmi",
    "bank of england","boe","federal reserve","fed","ecb","monetary policy",
    # Trade & tariffs
    "tariff","tariffs","trade","import","export","sanction","customs","duty",
    "trade deal","trade war","supply chain","wto",
    # Commodities & energy
    "oil","gas","opec","energy","fuel","commodity","commodities","wheat","grain",
    "copper","steel","aluminium","shipping","freight","container",
    # Geopolitics — any of these can move currency
    "war","conflict","ukraine","russia","china","iran","israel","middle east",
    "sanctions","embargo","nato","brexit","election",
    # Economics
    "recession","gdp","growth","unemployment","jobs","wages",
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
    if s == -1 or e == -1: raise ValueError(f"No JSON: {text[:200]}")
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
                seen[key] = {"id":key,"source":feed["source"],"source_url":link,"headline":title,"summary":summary[:500]}
    result = list(seen.values())[:MAX_EVENTS]
    log.info("Fetched %d relevant items across %d feeds", len(result), len(RSS_FEEDS))
    return result


# THE CORE PROMPT — the only question that matters is who pays FX because of this
PROMPT = """You are an FX sales intelligence system for Universal Partners, a UK B2B foreign exchange broker.

Your ONLY job: given any world event, identify which UK businesses now need to buy or sell foreign currency as a direct result.

THE CORE LOGIC:
- An event happens anywhere in the world
- Ask: does this change the cost, risk or uncertainty of overseas payments for any UK business?
- If yes: which specific UK businesses make those overseas payments?
- THOSE are the leads — not businesses vaguely affected, but businesses writing cheques in foreign currency

EXAMPLES OF CORRECT REASONING:
- Oil price spike → UK businesses that BUY oil or fuel from overseas suppliers in USD → they pay more USD
- Trump tariff on EU goods → UK importers of EU products paying EUR → their EUR invoices just got more expensive/uncertain  
- GBP falls vs EUR → any UK business paying European suppliers in EUR → their costs just rose in GBP terms
- War disrupts shipping routes → UK importers relying on those routes → supply uncertainty + freight cost FX impact
- China factory closures → UK businesses sourcing from China paying in CNY/USD → supply chain + currency risk
- BoE rate cut → UK businesses with EUR/USD forward contracts → hedging strategy needs reviewing
- US election result → USD volatility → any UK business with USD payment obligations

ONLY identify businesses that DIRECTLY make foreign currency payments. NOT businesses that are indirectly affected.

Return ONLY valid JSON — no markdown, no code fences.

Schema:
{{"event_type":"Tariff|Rate change|Currency move|Geopolitical|Commodity|Trade policy|Supply chain|Other",
"summary":"2-3 sentences: what happened AND which UK businesses now face foreign currency payment exposure as a result",
"fx_payment_logic":"One sentence explaining EXACTLY why these businesses make foreign currency payments — this is the sales hook",
"affected_sectors":["UK seafood importers paying USD to Norwegian suppliers","UK wine merchants paying EUR to French producers"],
"currency_pairs":["GBP/USD","GBP/EUR"],
"urgency_score":8,
"companies_house_terms":["seafood import","fish wholesale","wine import","food wholesale"],
"sales_angle":"One sentence: the specific reason to call TODAY referencing the event AND the foreign currency payment",
"who_pays_fx":["Specific description of UK businesses making the foreign currency payments"],
"who_benefits":["UK businesses that benefit from this movement"],
"is_relevant":true}}

Rules:
- companies_house_terms: ONLY terms that find UK businesses making overseas payments in foreign currency (importers, overseas buyers). Max 5 terms, 1-2 words each.
- urgency_score 1-10. 7+ = call today. Below 4 = not relevant enough.
- If no UK businesses make foreign currency payments as a result, set is_relevant: false.
- sales_angle MUST reference: (1) the specific event, (2) the foreign currency, (3) the payment/cost impact.

Source: {source}
Headline: {headline}
Summary: {summary}"""


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
def analyse(item):
    r = gemini.models.generate_content(
        model=GEMINI_MODEL,
        contents=PROMPT.format(source=item["source"], headline=item["headline"], summary=item.get("summary",""))
    )
    return extract_json(r.text)

def main():
    log.info("=== FX Ingest — any world event → who pays FX ===")
    existing = load_events()
    items    = fetch_rss_items()
    saved = skipped = failed = 0

    for item in items:
        if item["id"] in existing:
            skipped += 1
            continue
        try:
            a       = analyse(item)
            urgency = int(a.get("urgency_score") or 0)
            event   = {
                **item,
                "detected_at":           now_iso(),
                "event_type":            a.get("event_type"),
                "summary":               a.get("summary") or item.get("summary"),
                "fx_payment_logic":      a.get("fx_payment_logic"),
                "affected_sectors":      a.get("affected_sectors", []),
                "currency_pairs":        a.get("currency_pairs", []),
                "urgency_score":         urgency,
                "companies_house_terms": a.get("companies_house_terms", []),
                "sales_angle":           a.get("sales_angle"),
                "who_pays_fx":           a.get("who_pays_fx", []),
                "who_benefits":          a.get("who_benefits", []),
                "status":                "ready" if a.get("is_relevant") and urgency >= 4 else "low_relevance",
            }
            existing[item["id"]] = event
            log.info("Saved  urgency=%-2d  %-12s  %s", urgency, event["status"], item["headline"][:60])
            saved += 1
        except Exception as exc:
            log.error("Failed: %s | %s", item.get("headline","?")[:50], exc)
            failed += 1

    save_events(existing)
    log.info("=== Done: %d saved  %d skipped  %d failed  |  %d total ===", saved, skipped, failed, len(existing))

if __name__ == "__main__":
    main()
