"""
FX Discovery — discover.py

Company Discovery: uses exposure-ranked target segments from the Exposure Mapper
to find companies via Companies House, enrich them, score them by exposure intensity.

The scoring now prioritises financial exposure depth, not keyword similarity.

New scoring model:
- Exposure thesis match: does the company match the target segment's ideal profile?
- Direct FX signals: website language confirming import/export/overseas payments
- FX SIC codes: trade, manufacturing, logistics, wholesale
- Segment exposure level: Very High segments get score boost
- Event urgency
- Contact route availability
- Company activity and establishment
"""

import os, re, json, time, hashlib, logging, sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

COMPANIES_HOUSE_API_KEY = os.environ["COMPANIES_HOUSE_API_KEY"]
MAX_COMPANIES_PER_TERM  = int(os.getenv("DISCOVERY_MAX_COMPANIES_PER_TERM", "8"))

DATA_DIR    = Path(__file__).parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.json"
LEADS_FILE  = DATA_DIR / "leads.json"
DATA_DIR.mkdir(exist_ok=True)

SCRAPE_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; FXDiscoveryBot/1.0)"}

# ── DIRECT FX PAYMENT SIGNALS (high weight) ─────────────────────────────
FX_PAYMENT_SIGNALS = [
    "we import","we source","sourced from","imported from","direct from",
    "importing from","we buy from","purchased from","procured from",
    "overseas supplier","european supplier","international supplier","foreign supplier",
    "global supplier","worldwide supplier",
    "from italy","from france","from spain","from germany","from china","from usa",
    "from america","from japan","from india","from norway","from australia",
    "from new zealand","from south africa","from denmark","from netherlands",
    "italian","french","spanish","german","chinese","american","japanese",
    "foreign currency","currency risk","exchange rate","fx exposure",
    "international payments","overseas payments","currency hedging","fx risk",
    "importer","import company","import business","exclusive importer",
    "uk importer","sole importer","we distribute","import and distribute",
    "export","exports","exporting","we export","overseas customers","global customers",
    "international customers","us customers","american customers","european customers",
]

# ── SECONDARY SIGNALS (lower weight) ────────────────────────────────────
SECONDARY_SIGNALS = [
    "international","global","worldwide","overseas","distribution","distributor",
    "wholesale","wholesaler","logistics","freight","shipping","customs",
    "europe","european","asia","asian","north america","south america",
    "supply chain","supplier","sourcing","procurement",
]

# ── FX-RELEVANT SIC CODES ────────────────────────────────────────────────
FX_SIC_CODES = {
    # Wholesale trade (major importer/exporter category)
    "46","4600","4610","4620","4630","4631","4632","4633","4634","4635","4636",
    "4637","4638","4639","4641","4642","4643","4644","4645","4646","4647",
    "4648","4649","4650","4651","4652","4653","4654","4661","4662","4663",
    "4664","4665","4669","4671","4672","4673","4674","4675","4676","4677",
    # Manufacturing (often imports raw materials/components)
    "10","11","12","13","14","15","16","17","18","19","20","21","22","23",
    "24","25","26","27","28","29","30","31","32","33",
    "1010","1011","1012","1020","1031","1041","1051","1071","1081",
    "2011","2012","2013","2014","2015","2016","2020","2030","2041",
    # Freight / logistics / shipping
    "4910","4920","4930","4941","4942","5010","5020","5110","5121","5122",
    "5210","5221","5222","5223","5224","5229","5231","5232","5239","5240",
    # Travel (overseas supplier payments)
    "7911","7912","7990",
    # Retail with import potential
    "47","4711","4719","4730","4741","4742","4743","4751","4761","4771",
    "4772","4773","4774","4775","4776","4777","4778","4779","4791","4799",
}

def now_iso(): return datetime.now(timezone.utc).isoformat()
def load_json(p): return json.loads(p.read_text()) if p.exists() else {}
def save_json(p, d): p.write_text(json.dumps(d, indent=2, default=str))
def lead_id(cn, eid): return hashlib.sha256(f"{cn}:{eid}".encode()).hexdigest()[:16]

# ── COMPANIES HOUSE ──────────────────────────────────────────────────────

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=8))
def ch_search(query, n=10):
    r = requests.get(
        "https://api.company-information.service.gov.uk/search/companies",
        params={"q":query,"items_per_page":n},
        auth=(COMPANIES_HOUSE_API_KEY,""), timeout=15
    )
    r.raise_for_status()
    return r.json().get("items", [])

@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=5))
def ch_profile(cn):
    r = requests.get(
        f"https://api.company-information.service.gov.uk/company/{cn}",
        auth=(COMPANIES_HOUSE_API_KEY,""), timeout=15
    )
    if r.status_code == 404: return None
    r.raise_for_status()
    return r.json()

@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=5))
def ch_officers(cn):
    r = requests.get(
        f"https://api.company-information.service.gov.uk/company/{cn}/officers",
        auth=(COMPANIES_HOUSE_API_KEY,""), timeout=15
    )
    if r.status_code == 404: return []
    r.raise_for_status()
    return [o for o in r.json().get("items",[]) if not o.get("resigned_on")]

def extract_director(officers):
    priority = ["finance-director","managing-director","chief-executive",
                "chief-financial-officer","commercial-director","director","company-secretary"]
    for role in priority:
        for o in officers:
            if role in (o.get("officer_role","")).lower().replace(" ","-"):
                name = o.get("name","")
                if "," in name:
                    p = name.split(",",1)
                    name = f"{p[1].strip()} {p[0].strip().title()}"
                return {"name": name.strip(), "role": o.get("officer_role","Director")}
    if officers:
        name = officers[0].get("name","")
        if "," in name:
            p = name.split(",",1)
            name = f"{p[1].strip()} {p[0].strip().title()}"
        return {"name": name.strip(), "role": officers[0].get("officer_role","Officer")}
    return None

def sic_codes_from_profile(profile):
    return [str(s) for s in (profile or {}).get("sic_codes", [])]

def has_fx_sic(sic_codes):
    for code in sic_codes:
        clean = code.replace(" ","")
        # Match prefix (e.g. "46" matches "46310")
        for fx_code in FX_SIC_CODES:
            if clean.startswith(fx_code) or fx_code.startswith(clean[:2]):
                return True
    return False

# ── WEBSITE SCRAPING ─────────────────────────────────────────────────────

def scrape_website(url, validation_signals=None):
    """
    Scrape website, detect FX payment signals.
    validation_signals: segment-specific signals from the Exposure Mapper.
    """
    if not url:
        return {"fx_signals":[],"secondary_signals":[],"segment_signals":[],"snippet":"","pays_fx":False}
    try:
        res = requests.get(url, headers=SCRAPE_HEADERS, timeout=10, allow_redirects=True)
        res.raise_for_status()
        soup = BeautifulSoup(res.text, "html.parser")
        for tag in soup(["script","style","nav","footer","header","meta"]): tag.decompose()
        text = soup.get_text(" ", strip=True)
        tlow = text.lower()
        snippet = re.sub(r"\s+", " ", text)[:800]

        fx_sigs  = sorted({s for s in FX_PAYMENT_SIGNALS if s in tlow})
        sec_sigs = sorted({s for s in SECONDARY_SIGNALS   if s in tlow})

        # Check segment-specific validation signals from Exposure Mapper
        seg_sigs = []
        if validation_signals:
            seg_sigs = sorted({s.lower() for s in validation_signals if s.lower() in tlow})

        # Company PAYS FX if: strong direct signal, or segment signal hit, or 3+ secondary
        pays_fx = len(fx_sigs) >= 1 or len(seg_sigs) >= 1 or len(sec_sigs) >= 3

        return {
            "fx_signals": fx_sigs,
            "secondary_signals": sec_sigs,
            "segment_signals": seg_sigs,
            "snippet": snippet,
            "pays_fx": pays_fx,
        }
    except Exception as exc:
        log.debug("Scrape failed %s: %s", url, exc)
        return {"fx_signals":[],"secondary_signals":[],"segment_signals":[],"snippet":"","pays_fx":False}

# ── EXPOSURE SCORING ─────────────────────────────────────────────────────

EXPOSURE_LEVEL_BOOST = {
    "Very High": 20,
    "High":      12,
    "Medium":    6,
    "Low":       0,
}

def score_lead(item, profile, event, web, sic_codes, segment=None):
    """
    Score by exposure intensity, not keyword similarity.
    """
    score   = 0
    reasons = []

    # 1. Direct FX payment signals on website (0-30) — most important
    fx_sigs = web.get("fx_signals", [])
    if fx_sigs:
        s = min(30, 8 + len(fx_sigs) * 4)
        score += s
        reasons.append(f"Direct FX payment language on website: {', '.join(fx_sigs[:4])}")

    # 2. Segment-specific validation signals (0-15)
    seg_sigs = web.get("segment_signals", [])
    if seg_sigs:
        s = min(15, len(seg_sigs) * 5)
        score += s
        reasons.append(f"Matches target segment signals: {', '.join(seg_sigs[:3])}")

    # 3. Secondary international signals (0-10)
    sec_sigs = web.get("secondary_signals", [])
    if sec_sigs:
        s = min(10, len(sec_sigs) * 2)
        score += s
        reasons.append(f"International activity signals: {', '.join(sec_sigs[:3])}")

    # 4. FX-relevant SIC code (0-15)
    if has_fx_sic(sic_codes):
        score += 15
        reasons.append(f"SIC code indicates import/wholesale/manufacturing: {', '.join(sic_codes[:2])}")

    # 5. Segment exposure level boost (0-20)
    if segment:
        boost = EXPOSURE_LEVEL_BOOST.get(segment.get("exposure_level",""), 0)
        if boost > 0:
            score += boost
            reasons.append(f"Target segment exposure: {segment.get('exposure_level','?')} — {segment.get('exposure_type','')}")

    # 6. Event urgency (0-10)
    urgency = int(event.get("urgency_score") or 0)
    if urgency >= 7:
        score += 10
        reasons.append("High urgency market event")
    elif urgency >= 4:
        score += 5

    # 7. Company active (0-5) + contact available (0-5)
    if (item.get("company_status","")).lower() == "active":
        score += 5
        reasons.append("Active on Companies House")
    if web.get("snippet"):
        score += 5
        reasons.append("Website confirmed active")

    score = min(score, 100)

    # GATE: no FX evidence at all → cap at QUEUE
    if not web.get("pays_fx") and not has_fx_sic(sic_codes):
        score = min(score, 39)
        reasons.append("⚠ No direct FX payment evidence found")

    if   score >= 80: priority = "HOT"
    elif score >= 60: priority = "WARM"
    elif score >= 40: priority = "QUEUE"
    else:             priority = "SKIP"

    return {"score": score, "priority": priority, "reasons": reasons}

def build_exposure_thesis(company_name, event, web, segment, sic_codes):
    """
    Build a plain-English exposure thesis explaining WHY this specific company
    is financially exposed to this specific event.
    """
    parts = []

    # Use the segment's template if available
    template = (segment or {}).get("exposure_thesis_template","")
    if template:
        parts.append(template.replace("This company", company_name))
    elif segment:
        bm = segment.get("business_model","")
        if bm:
            parts.append(f"{company_name} appears to operate as: {bm}.")

    # Add FX payment logic from event
    if event.get("fx_payment_logic"):
        parts.append(event["fx_payment_logic"])

    # Add website signal evidence
    fx_sigs = web.get("fx_signals",[])
    if fx_sigs:
        parts.append(f"Website confirms FX activity: {', '.join(fx_sigs[:3])}.")

    # Add currency pair context
    pairs = event.get("currency_pairs",[]) or (segment or {}).get("likely_currency_pairs",[])
    if pairs:
        parts.append(f"Currency exposure: {', '.join(pairs)}.")

    if not parts:
        return "Potential FX exposure based on sector, SIC code, and market event."

    return " ".join(parts)

def build_fx_reason(event, web, segment, sic_codes):
    """Short FX reason for the lead card."""
    if segment and segment.get("why_financially_exposed"):
        return segment["why_financially_exposed"]
    if event.get("fx_payment_logic"):
        return event["fx_payment_logic"]
    return "Potential FX exposure based on sector and market event."

# ── MAIN DISCOVERY ───────────────────────────────────────────────────────

def process_event(event, leads):
    """
    For each event, use the Exposure Mapper's target segments to generate
    high-intent Companies House search queries, then enrich and score companies.
    """
    target_segments = event.get("target_segments", [])
    if not target_segments:
        log.warning("  No target segments for event: %s", event.get("headline","?")[:60])
        return 0

    # Use CH terms from the exposure map
    ch_terms = event.get("companies_house_terms", [])
    if not ch_terms:
        # Fallback: extract from segments
        for seg in target_segments:
            ch_terms.extend(seg.get("companies_house_terms", []))
        ch_terms = list(dict.fromkeys(ch_terms))[:10]

    seen  = set()
    saved = 0

    log.info("Event: %s (urgency=%d, %d segments, %d CH terms)",
             event["headline"][:60], event["urgency_score"],
             len(target_segments), len(ch_terms))

    # Map CH terms back to their segments for scoring context
    term_to_segment = {}
    for seg in target_segments:
        for term in seg.get("companies_house_terms", []):
            term_to_segment[term.lower()] = seg

    for term in ch_terms[:8]:
        try:
            results = ch_search(term, n=MAX_COMPANIES_PER_TERM)
            log.info("  CH '%-28s' → %d results", term[:28], len(results))

            # Find best matching segment for this term
            segment = term_to_segment.get(term.lower(), target_segments[0] if target_segments else None)

            for item in results:
                cn = item.get("company_number","")
                if not cn or cn in seen: continue
                seen.add(cn)
                if (item.get("company_status","")).lower() not in ("active",""): continue

                lid = lead_id(cn, event["id"])
                if lid in leads: continue

                try:
                    time.sleep(0.3)
                    profile  = ch_profile(cn)
                    officers = ch_officers(cn)
                    director = extract_director(officers)
                    sic_codes= sic_codes_from_profile(profile)

                    # Get website
                    website = (profile or {}).get("website")

                    # Scrape with segment-specific validation signals
                    validation_signals = (segment or {}).get("website_validation_signals", [])
                    web = scrape_website(website, validation_signals) if website else {
                        "fx_signals":[],"secondary_signals":[],"segment_signals":[],"snippet":"","pays_fx":False
                    }

                    # Score by exposure intensity
                    scoring = score_lead(item, profile, event, web, sic_codes, segment)

                    if scoring["priority"] == "SKIP":
                        continue

                    addr = (profile or {}).get("registered_office_address") or {}
                    addr_str = ", ".join(filter(None,[
                        addr.get("address_line_1"), addr.get("locality"), addr.get("postal_code")
                    ])) if isinstance(addr, dict) else str(addr)

                    # Build the exposure thesis — the core new field
                    exposure_thesis = build_exposure_thesis(
                        item.get("title","the company"), event, web, segment, sic_codes
                    )

                    lead = {
                        "id":                    lid,
                        "event_id":              event["id"],
                        "created_at":            now_iso(),
                        "company_name":          item.get("title","Unknown"),
                        "company_number":        cn,
                        "company_status":        item.get("company_status"),
                        "company_type":          item.get("company_type"),
                        "address":               addr_str,
                        "incorporated":          item.get("date_of_creation"),
                        "sic_codes":             sic_codes,
                        "website":               website,
                        "director_name":         director["name"] if director else None,
                        "director_role":         director["role"] if director else None,

                        # Segment context from Exposure Mapper
                        "segment_name":          (segment or {}).get("segment_name",""),
                        "segment_business_model":(segment or {}).get("business_model",""),
                        "exposure_level":        (segment or {}).get("exposure_level",""),
                        "exposure_type":         (segment or {}).get("exposure_type",""),
                        "why_affected":          (segment or {}).get("why_affected",""),

                        # Event context
                        "trigger_headline":      event["headline"],
                        "event_type":            event.get("event_type",""),
                        "fx_exposure":           ", ".join(
                            (segment or {}).get("likely_currency_pairs") or event.get("currency_pairs",[])
                        ),

                        # Scoring
                        "score":                 scoring["score"],
                        "priority":              scoring["priority"],
                        "scoring_reasons":       scoring["reasons"],

                        # THE KEY NEW FIELD
                        "exposure_thesis":       exposure_thesis,
                        "fx_reason":             build_fx_reason(event, web, segment, sic_codes),
                        "fx_payment_logic":      event.get("fx_payment_logic",""),

                        # Website evidence
                        "fx_payment_signals":    web.get("fx_signals",[]),
                        "segment_signals":       web.get("segment_signals",[]),
                        "secondary_signals":     web.get("secondary_signals",[]),
                        "pays_fx_confirmed":     web.get("pays_fx", False),

                        # Sales context
                        "sales_angle":           (segment or {}).get("sales_angle") or event.get("sales_angle",""),
                        "suggested_next_step": (
                            f"Call {director['name']} ({director['role']}) — " if director
                            else "Call switchboard, ask for Finance Director or MD — "
                        ) + f"{(segment or {}).get('sales_angle') or event.get('sales_angle','')}",

                        "status": "new",
                    }

                    leads[lid] = lead
                    saved += 1
                    log.info("  %-6s  score=%-3d  %-40s  %s",
                             scoring["priority"], scoring["score"],
                             item.get("title","")[:40],
                             director["name"] if director else "—")

                except Exception as exc:
                    log.warning("  Enrich failed %s: %s", item.get("title","?")[:30], exc)

        except Exception as exc:
            log.error("  CH search failed (%s): %s", term[:30], exc)

    return saved

def main():
    log.info("=== FX Discovery — Exposure-Ranked Company Discovery ===")
    events = load_json(EVENTS_FILE)
    leads  = load_json(LEADS_FILE)

    ready = sorted(
        [e for e in events.values()
         if e.get("status")=="ready" and int(e.get("urgency_score") or 0) >= 4],
        key=lambda e: e.get("urgency_score",0), reverse=True
    )
    log.info("Found %d ready events", len(ready))

    total = 0
    for event in ready[:5]:
        total += process_event(event, leads)
        events[event["id"]]["status"] = "discovered"

    save_json(LEADS_FILE,  leads)
    save_json(EVENTS_FILE, events)

    # Copy to public/data for dashboard
    public_dir = Path(__file__).parent.parent / "public" / "data"
    public_dir.mkdir(parents=True, exist_ok=True)
    (public_dir / "leads.json").write_text(LEADS_FILE.read_text())
    (public_dir / "events.json").write_text(EVENTS_FILE.read_text())

    log.info("=== Done: %d new leads (%d total) ===", total, len(leads))

if __name__ == "__main__":
    main()
