"""
FX Discovery v2 — discover.py

Reads events → Companies House search → website scrape → score
ONLY saves companies that make direct foreign currency payments.
"""

import os, re, json, time, hashlib, logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from tenacity import retry, stop_after_attempt, wait_exponential

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

COMPANIES_HOUSE_API_KEY  = os.environ["COMPANIES_HOUSE_API_KEY"]
MAX_SEARCH_TERMS         = int(os.getenv("DISCOVERY_MAX_SEARCH_TERMS",     "5"))
MAX_COMPANIES_PER_TERM   = int(os.getenv("DISCOVERY_MAX_COMPANIES_PER_TERM","8"))

DATA_DIR    = Path(__file__).parent.parent / "data"
EVENTS_FILE = DATA_DIR / "events.json"
LEADS_FILE  = DATA_DIR / "leads.json"
DATA_DIR.mkdir(exist_ok=True)

SCRAPE_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; FXDiscoveryBot/1.0)"}

# ── THE CORE SIGNAL: does this company MAKE foreign currency payments? ──
# These phrases on a website = strong evidence they pay overseas in foreign currency
FX_PAYMENT_SIGNALS = [
    # Direct import/sourcing language
    "we import", "we source", "sourced from", "imported from", "direct from",
    "importing from", "we buy from", "purchased from", "procured from",
    # Overseas supplier language
    "overseas supplier", "european supplier", "international supplier",
    "foreign supplier", "global supplier", "worldwide supplier",
    # Origin language
    "from italy", "from france", "from spain", "from germany", "from china",
    "from usa", "from america", "from japan", "from india", "from norway",
    "from australia", "from new zealand", "from south africa",
    "italian", "french", "spanish", "german", "chinese", "american",
    # Payment/currency language
    "foreign currency", "currency risk", "exchange rate", "fx exposure",
    "international payments", "overseas payments", "currency hedging",
    # Distribution/wholesale import language
    "importer", "import company", "import business", "we distribute",
    "exclusive importer", "uk importer", "sole importer",
]

# Weaker signals — still relevant but less conclusive
SECONDARY_SIGNALS = [
    "international", "global", "worldwide", "overseas", "export", "exports",
    "distribution", "distributor", "wholesale", "wholesaler",
    "logistics", "freight", "shipping", "customs",
    "europe", "european", "asia", "asian",
]

# SIC codes where businesses almost always make foreign currency payments
FX_SIC_CODES = {
    # Import/export wholesale trade
    "4600","4610","4620","4630","4631","4632","4633","4634","4635","4636",
    "4637","4638","4639","4641","4642","4643","4644","4645","4646","4647",
    "4648","4649","4650","4651","4652","4653","4654","4661","4662","4663",
    "4664","4665","4669","4671","4672","4673","4674","4675","4676","4677",
    # Manufacturing (often imports raw materials)
    "1010","1011","1012","1013","1020","1031","1032","1039","1041","1042",
    "1051","1052","1061","1062","1071","1072","1073","1081","1082","1083",
    "1084","1085","1086","1089","1091","1092","1101","1102","1103","1104",
    "1105","2011","2012","2013","2014","2015","2016","2020","2030","2041",
    # Freight and logistics
    "4910","4920","4930","4941","4942","5010","5020","5110","5121","5122",
    "5210","5221","5222","5223","5224","5229","5231","5232","5239","5240",
    # Travel (foreign currency transactions)
    "7911","7912","7990",
}

def now_iso(): return datetime.now(timezone.utc).isoformat()
def load_json(p): return json.loads(p.read_text()) if p.exists() else {}
def save_json(p, d): p.write_text(json.dumps(d, indent=2, default=str))
def lead_id(cn, eid): return hashlib.sha256(f"{cn}:{eid}".encode()).hexdigest()[:16]

# ── COMPANIES HOUSE ───────────────────────────────────────────────

@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=8))
def ch_search(query, n=10):
    r = requests.get("https://api.company-information.service.gov.uk/search/companies",
                     params={"q":query,"items_per_page":n}, auth=(COMPANIES_HOUSE_API_KEY,""), timeout=15)
    r.raise_for_status()
    return r.json().get("items", [])

@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=5))
def ch_profile(cn):
    r = requests.get(f"https://api.company-information.service.gov.uk/company/{cn}",
                     auth=(COMPANIES_HOUSE_API_KEY,""), timeout=15)
    if r.status_code == 404: return None
    r.raise_for_status()
    return r.json()

@retry(stop=stop_after_attempt(2), wait=wait_exponential(multiplier=1, min=1, max=5))
def ch_officers(cn):
    r = requests.get(f"https://api.company-information.service.gov.uk/company/{cn}/officers",
                     auth=(COMPANIES_HOUSE_API_KEY,""), timeout=15)
    if r.status_code == 404: return []
    r.raise_for_status()
    return [o for o in r.json().get("items",[]) if not o.get("resigned_on")]

def extract_director(officers):
    priority = ["finance-director","managing-director","chief-executive","director","company-secretary"]
    for role in priority:
        for o in officers:
            if role in (o.get("officer_role","")).lower().replace(" ","-"):
                name = o.get("name","")
                if "," in name:
                    p = name.split(",",1)
                    name = f"{p[1].strip()} {p[0].strip().title()}"
                return {"name": name, "role": o.get("officer_role","Director")}
    if officers:
        name = officers[0].get("name","")
        if "," in name:
            p = name.split(",",1)
            name = f"{p[1].strip()} {p[0].strip().title()}"
        return {"name": name, "role": officers[0].get("officer_role","Officer")}
    return None

def sic_codes_from_profile(profile):
    return [str(s) for s in (profile or {}).get("sic_codes", [])]

def has_fx_sic(sic_codes):
    for code in sic_codes:
        clean = code.replace(" ","")[:4]
        if clean in FX_SIC_CODES: return True
    return False

# ── WEBSITE SCRAPING ─────────────────────────────────────────────

def find_website(company_name, company_number):
    """Try Google search to find company website."""
    try:
        q   = f'"{company_name}" UK official site'
        url = f"https://www.google.com/search?q={requests.utils.quote(q)}&num=5"
        res = requests.get(url, headers=SCRAPE_HEADERS, timeout=10)
        if res.status_code != 200: return None
        soup  = BeautifulSoup(res.text, "html.parser")
        skip  = ["google","facebook","linkedin","twitter","instagram","youtube",
                 "gov.uk","companieshouse","wikipedia","yelp","yell.com","trustpilot"]
        for link in soup.find_all("a", href=True):
            href = link.get("href","")
            if href.startswith("/url?q="):
                actual = href.split("/url?q=")[1].split("&")[0]
                parsed = urlparse(actual)
                domain = parsed.netloc.lower()
                if domain and not any(s in domain for s in skip) and parsed.scheme in ("http","https"):
                    return actual
    except Exception as exc:
        log.debug("Website search failed for %s: %s", company_name, exc)
    return None

def scrape_website(url):
    """Scrape website, detect FX payment signals."""
    if not url: return {"fx_signals":[], "secondary_signals":[], "snippet":"", "pays_fx": False}
    try:
        res = requests.get(url, headers=SCRAPE_HEADERS, timeout=10, allow_redirects=True)
        res.raise_for_status()
        soup = BeautifulSoup(res.text, "html.parser")
        for tag in soup(["script","style","nav","footer","header","meta"]): tag.decompose()
        text  = soup.get_text(" ", strip=True)
        tlow  = text.lower()
        snippet = re.sub(r"\s+", " ", text)[:600]
        fx_signals  = sorted({s for s in FX_PAYMENT_SIGNALS  if s in tlow})
        sec_signals = sorted({s for s in SECONDARY_SIGNALS   if s in tlow})
        # Company PAYS FX if: strong direct signal found, OR 2+ secondary signals
        pays_fx = len(fx_signals) >= 1 or len(sec_signals) >= 3
        return {"fx_signals": fx_signals, "secondary_signals": sec_signals, "snippet": snippet, "pays_fx": pays_fx}
    except Exception as exc:
        log.debug("Scrape failed %s: %s", url, exc)
        return {"fx_signals":[], "secondary_signals":[], "snippet":"", "pays_fx": False}

# ── SCORING ──────────────────────────────────────────────────────

def score_lead(item, profile, event, web, sic_codes):
    score   = 0
    reasons = []

    # 1. Direct FX payment signals on website (0-35) — THE most important signal
    fx_sigs = web.get("fx_signals", [])
    if fx_sigs:
        s = min(35, 10 + len(fx_sigs) * 5)
        score += s
        reasons.append(f"Direct FX payment language: {', '.join(fx_sigs[:4])}")
    
    # 2. Secondary import/international signals (0-15)
    sec_sigs = web.get("secondary_signals", [])
    if sec_sigs:
        s = min(15, len(sec_sigs) * 3)
        score += s
        reasons.append(f"International activity signals: {', '.join(sec_sigs[:4])}")

    # 3. SIC code = importer/manufacturer/freight (0-20)
    if has_fx_sic(sic_codes):
        score += 20
        reasons.append(f"SIC code indicates import/trade/manufacturing: {', '.join(sic_codes[:2])}")

    # 4. Event urgency (0-15)
    urgency = int(event.get("urgency_score") or 0)
    if urgency >= 7:
        score += 15
        reasons.append("High urgency market event")
    elif urgency >= 4:
        score += 8
        reasons.append("Moderate urgency event")

    # 5. Company active + contact available (0-15)
    if (item.get("company_status","")).lower() == "active":
        score += 8
        reasons.append("Active on Companies House")
    if web.get("snippet") or item.get("address_snippet"):
        score += 7
        reasons.append("Contact route available")

    score = min(score, 100)

    # GATE: if no FX payment evidence at all, cap at QUEUE regardless of score
    if not web.get("pays_fx") and not has_fx_sic(sic_codes):
        score = min(score, 39)
        reasons.append("⚠️ No direct FX payment evidence found")

    if score >= 80:   priority = "HOT"
    elif score >= 60: priority = "WARM"
    elif score >= 40: priority = "QUEUE"
    else:             priority = "SKIP"

    return {"score": score, "priority": priority, "reasons": reasons}

def build_fx_reason(event, web, sic_codes):
    parts = []
    # Lead with the payment logic — WHY do they pay FX
    if event.get("fx_payment_logic"):
        parts.append(event["fx_payment_logic"])
    # Then the specific currencies
    pairs = event.get("currency_pairs", []) or []
    if pairs:
        parts.append(f"Currency exposure: {', '.join(pairs)}.")
    # Then the website evidence
    fx_sigs = web.get("fx_signals", [])
    if fx_sigs:
        parts.append(f"Website confirms: {', '.join(fx_sigs[:3])}.")
    return " ".join(parts) or "Potential FX exposure based on sector and market event."

def infer_sector(event):
    who = event.get("who_pays_fx") or event.get("affected_sectors") or []
    return str(who[0]) if who else "Unknown"

# ── MAIN ─────────────────────────────────────────────────────────

def process_event(event, leads):
    terms = (event.get("companies_house_terms") or [])[:MAX_SEARCH_TERMS]
    seen  = set()
    saved = 0

    log.info("Event: %s (urgency=%d)", event["headline"][:70], event["urgency_score"])

    for term in terms:
        try:
            results = ch_search(term, n=MAX_COMPANIES_PER_TERM)
            log.info("  CH '%-30s' → %d results", term[:30], len(results))

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

                    # Find website
                    website = (profile or {}).get("website")
                    if not website:
                        time.sleep(0.5)
                        website = find_website(item.get("title",""), cn)

                    web     = scrape_website(website) if website else {"fx_signals":[],"secondary_signals":[],"snippet":"","pays_fx":False}
                    scoring = score_lead(item, profile, event, web, sic_codes)

                    if scoring["priority"] == "SKIP":
                        log.debug("  SKIP  %s  (score=%d, pays_fx=%s)", item.get("title","")[:40], scoring["score"], web.get("pays_fx"))
                        continue

                    addr = (profile or {}).get("registered_office_address") or {}
                    addr_str = ", ".join(filter(None,[
                        addr.get("address_line_1"), addr.get("locality"), addr.get("postal_code")
                    ])) if isinstance(addr, dict) else str(addr)

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
                        "sector":                infer_sector(event),
                        "trigger_headline":      event["headline"],
                        "fx_exposure":           ", ".join(event.get("currency_pairs",[]) or []),
                        "fx_reason":             build_fx_reason(event, web, sic_codes),
                        "fx_payment_logic":      event.get("fx_payment_logic",""),
                        "fx_payment_signals":    web.get("fx_signals",[]),
                        "secondary_signals":     web.get("secondary_signals",[]),
                        "pays_fx_confirmed":     web.get("pays_fx", False),
                        "score":                 scoring["score"],
                        "priority":              scoring["priority"],
                        "scoring_reasons":       scoring["reasons"],
                        "suggested_next_step":   (
                            f"Call switchboard — ask for {director['name']} ({director['role']}). "
                            if director else "Call switchboard — ask for Finance Director or MD. "
                        ) + f"Hook: {event.get('sales_angle','')}",
                        "status": "new",
                    }

                    leads[lid] = lead
                    saved += 1
                    log.info("  %-6s score=%-3d pays_fx=%-5s  %-40s  %s",
                             scoring["priority"], scoring["score"], str(web.get("pays_fx")),
                             item.get("title","")[:40], director["name"] if director else "—")

                except Exception as exc:
                    log.warning("  Enrich failed %s: %s", item.get("title","?")[:30], exc)

        except Exception as exc:
            log.error("  CH search failed (%s): %s", term[:30], exc)

    return saved

def main():
    log.info("=== FX Discovery — who pays foreign currency because of this? ===")
    events = load_json(EVENTS_FILE)
    leads  = load_json(LEADS_FILE)

    ready = sorted(
        [e for e in events.values() if e.get("status")=="ready" and int(e.get("urgency_score") or 0)>=4],
        key=lambda e: e.get("urgency_score",0), reverse=True
    )
    log.info("Found %d ready events", len(ready))

    total = 0
    for event in ready[:5]:
        total += process_event(event, leads)
        events[event["id"]]["status"] = "discovered"

    save_json(LEADS_FILE,  leads)
    save_json(EVENTS_FILE, events)
    log.info("=== Done: %d new leads (%d total) ===", total, len(leads))

if __name__ == "__main__":
    main()
