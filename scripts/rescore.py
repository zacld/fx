"""
rescore.py — Re-score all existing leads using stored fields only.
No new API calls. Adds differentiation via:
  - Company age (from incorporated date)
  - Company name trade signals (trading, international, import, etc.)
  - SIC tier (core wholesale vs generic)
  - Director found (+5)
  - Website found (+3)
  - Improved gate logic
Run after discover.py to rank the flat-50 QUEUE leads.
"""

import json, logging, re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import contacts as _contacts
import signals as _sig

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

DATA_DIR    = Path(__file__).parent.parent / "data"
LEADS_FILE  = DATA_DIR / "leads.json"
EVENTS_FILE = DATA_DIR / "events.json"

# ── SIC TIER BOOSTS ──────────────────────────────────────────────────────────
# Tier 1 — core import/export trade (highest FX probability)
SIC_TIER1 = {
    "4671","4672","4673","4674","4675","4676","4677",  # wholesale petroleum/chemicals
    "4631","4632","4633","4634","4635","4636","4637","4638","4639",  # food wholesale
    "4641","4642","4643","4644","4645","4646","4647","4648","4649",  # consumer goods wholesale
    "4610","4620","4630","4650","4660","4669",         # other specialist wholesale
    "5010","5020",                                      # sea freight
    "5110","5121","5122",                               # air freight
}
# Tier 2 — manufacturing that typically imports raw materials
SIC_TIER2 = {str(i) for i in range(1000, 3400)} | {
    "4651","4652","4653","4654",
    "46","4600",
}
# Tier 3 — wholesale / logistics (general)
SIC_TIER3 = {str(i) for i in range(4700, 4800)} | {
    "4910","4920","4930","4941","4942",
    "5210","5221","5222","5223","5224","5229",
    "5231","5232","5239","5240",
}

EXPOSURE_LEVEL_BOOST = {
    "Very High": 20,
    "High":      12,
    "Medium":     6,
    "Low":        0,
}

# ── ASSOCIATION / TRADE BODY DETECTION ───────────────────────────────────────
# These organisations are useful as source pages for mining member links, but
# they are NOT FX prospects and must never appear as HOT or WARM leads.
#
# Two complementary signals:
#   1. SIC code — 941xx / 9499x membership organisation codes
#   2. Company name — contains association/council/federation/etc.
#
# Either signal alone is sufficient to cap at SKIP (score ≤ 39).
ASSOCIATION_SICS = {
    "94110",  # Activities of business and employers' membership organisations
    "94120",  # Activities of professional membership organisations
    "94910",  # Activities of religious organisations
    "94920",  # Activities of political organisations
    "94990",  # Activities of other membership organisations NEC
}

_ASSOC_PATTERN = re.compile(
    r"\b(association|council|federation|institute|society|chamber|guild|"
    r"consortium|forum|alliance|authority|union|bureau|agency)\b",
    re.IGNORECASE,
)

# ── B2B / TRADE EVIDENCE ─────────────────────────────────────────────────────
# Signals that confirm a company is a genuine trade/commercial prospect.
# At least one must be present for a lead to reach WARM (score ≥ 65).
# A single weak geographic/FX signal (e.g. "from italy" in page body) is not
# enough to justify calling — there must also be evidence of commercial activity.
_B2B_TRADE_SIGNALS = {
    "wholesale", "wholesaler", "distributor", "distribution",
    "importer", "importing", "imported", "exporter", "exporting",
    "manufacturer", "manufacturing", "trade", "b2b",
    "supply chain", "agent", "agents", "reseller",
    "stockist", "supplier", "freight", "logistics",
    "cargo", "shipper", "forwarder",
}

# Bare nationality / region adjectives are NOT FX evidence on their own — they
# fire too broadly (a wine shop saying "Italian wine"). On legacy leads that
# stored them in fx_payment_signals, main() moves them into secondary_signals.
WEAK_ORIGIN_TOKENS = {
    "italian","french","spanish","german","chinese","american","japanese","portuguese",
    "greek","dutch","belgian","swedish","danish","norwegian","finnish","swiss","austrian",
    "polish","turkish","indian","thai","vietnamese","korean","mexican","brazilian",
    "australian","scandinavian","mediterranean","european","continental","oriental","asian",
    "iberian","nordic","african",
}

# Company name words that signal FX-paying business
NAME_TRADE_WORDS = [
    "trading","international","imports","import","export","exports","wholesale",
    "distribution","distributor","global","worldwide","overseas",
]
NAME_ORIGIN_WORDS = [
    "italian","french","spanish","german","chinese","mediterranean","atlantic",
    "pacific","european","nordic","iberian","nordic","iberian","scandinavian",
    "oriental","asian","american","african",
]

def sic_tier(sic_codes):
    for code in sic_codes:
        c = code.replace(" ","")
        if any(c.startswith(t) or t.startswith(c[:4]) for t in SIC_TIER1): return 1
        if any(c.startswith(t) or t.startswith(c[:2]) for t in SIC_TIER2): return 2
        if any(c.startswith(t) for t in SIC_TIER3):                         return 3
    return 0

def sic_boost(sic_codes):
    t = sic_tier(sic_codes)
    return {1: 15, 2: 10, 3: 7, 0: 0}[t]

def name_signal_score(name):
    n = name.lower()
    trade  = sum(1 for w in NAME_TRADE_WORDS  if w in n)
    origin = sum(1 for w in NAME_ORIGIN_WORDS if w in n)
    return min(8, trade * 3 + origin * 4)

def age_score(incorporated):
    if not incorporated:
        return 0
    try:
        year = int(str(incorporated)[:4])
        age  = datetime.now(timezone.utc).year - year
        if age >= 20: return 8    # pre-2006, established FX relationships
        if age >= 10: return 5    # 2006-2016, solid business
        if age >= 5:  return 2    # 2016-2021, growing
        if age >= 2:  return 0    # 2021-2024, too new
        return -5                 # incorporated last year
    except Exception:
        return 0

def extract_domain(website):
    if not website: return None
    try:
        netloc = urlparse(website).netloc.lower().replace("www.", "")
        return netloc if netloc else None
    except Exception:
        return None

# Websites that are industry news/trade publications or sector aggregators,
# NOT the actual company's website. enrich_websites sometimes latches onto these.
# ── HARD-SKIP DOMAINS ────────────────────────────────────────────────────────
# Content/retail sites that are NEVER valid FX prospects, even if they contain
# import/country/product references in their page text.
# These leads are capped at SKIP (score ≤ 39) regardless of other signals.
# This is the rescore-time equivalent of SKIP_DOMAINS in discover_web.py,
# catching leads already in the database from before the domain was blocked.
HARD_SKIP_DOMAINS = {
    # Reference / encyclopaedia
    "britannica.com", "britannica.co.uk", "britannicakids.com",
    "merriam-webster.com",
    "dictionary.com", "thesaurus.com",
    "encyclopedia.com",
    "thoughtco.com",
    "wikipedia.org",
    # Supermarkets / consumer grocery
    "morrisons.com",
    "tesco.com",
    "sainsburys.co.uk",
    "asda.com",
    "waitrose.com",
    "marksandspencer.com",
    "ocado.com",
    "iceland.co.uk",
    "aldi.co.uk",
    "lidl.co.uk",
    "costco.co.uk",
    # Consumer wine / drinks retail
    "majestic.co.uk",
    "thedrinkshop.com",
    "laithwaites.co.uk",
    "thewinesociety.com",
    "wineowners.com",
    "virginwines.com",
}

KNOWN_BAD_DOMAINS = {
    # Trade publications / news
    "foodmanufacture.co.uk", "foodnavigator.com", "fooddrinkeurope.eu",
    "thegrocer.co.uk", "just-drinks.com", "just-food.com",
    "meatinfo.co.uk", "fruitnet.com", "freshplaza.com",
    "harpers.co.uk", "decanter.com", "thedrinksbusiness.com",
    "morningadvertiser.co.uk", "barbob.co.uk",
    "oilprice.com", "hydrocarbons-technology.com", "offshore-technology.com",
    "gasworld.com", "icis.com", "chemicalwatch.com",
    "chemeurope.com", "chemicalprocessing.com",
    "seafoodsource.com", "undercurrentnews.com", "fishfocus.co.uk",
    # News aggregators / directories with "italianfood", "seafood" etc in subdomain
    "news.italianfood.net", "italianfood.net",
    # Generic sector portals
    "ukfoodanddrink.org", "fdf.org.uk", "seafish.org",
    "gov.uk", "companieshouse.gov.uk",
    # Known aggregators / data sites
    "grokipedia.com", "ensun.io", "craft.co", "zoominfo.com",
    "opencorporates.com", "companieshouse.gov.uk",
    # Alberta/Canadian pallet company (wrong geography)
    "albertapallet.ca",
    # Investment/marketplace sites masquerading as companies
    "whiskyinvestdirect.com", "whiskyintelligence.com",
    # Legal directories / firm aggregators
    "thelawyer.com", "legalcheek.com", "chambers.com",
    # Travel aggregators / booking engines
    "kayak.co.uk", "kayak.com", "aito.com", "expedia.co.uk",
    # Article/blog pages from wrong-domain companies
    "luxurytribune.com", "luxurydaily.com", "womanandhome.com",
    "shiptothemoon.com",
    # Trade/supplier directories
    "j5fashion.com", "gemimports.co.uk", "thewholesaler.co.uk",
    "dinainternational.co.uk",
}

def _domain_in_set(website: str, domain_set: set) -> bool:
    """Return True if the lead's website domain (or any parent) is in domain_set."""
    dom = extract_domain(website) or ""
    if dom in domain_set:
        return True
    for entry in domain_set:
        if dom.endswith("." + entry):
            return True
    return False

def is_hard_skip_domain(website: str) -> bool:
    """True for content/retail sites that are never FX prospects."""
    return _domain_in_set(website, HARD_SKIP_DOMAINS)

def is_known_bad_domain(website: str) -> bool:
    dom = extract_domain(website) or ""
    if dom in KNOWN_BAD_DOMAINS:
        return True
    # Catch subdomains of bad roots
    for bad in KNOWN_BAD_DOMAINS:
        if dom.endswith("." + bad):
            return True
    return False

def guess_emails(director_name, website):
    """
    Generate the 4 most common UK SME email patterns.
    Returns list of dicts with {pattern, email} or empty list.
    """
    domain = extract_domain(website)
    if not domain or not director_name:
        return []

    # Parse first / last from cleaned name ("Priya Kaur", "Tim Chase")
    parts = re.sub(r"[^a-zA-Z\s\-]", "", director_name).split()
    parts = [p for p in parts if len(p) > 1]   # strip initials
    if len(parts) < 2:
        return []

    first = parts[0].lower()
    last  = parts[-1].lower()
    f     = first[0]

    return [
        {"pattern": "firstname@",           "email": f"{first}@{domain}"},
        {"pattern": "firstname.lastname@",   "email": f"{first}.{last}@{domain}"},
        {"pattern": "f.lastname@",           "email": f"{f}.{last}@{domain}"},
        {"pattern": "flastname@",            "email": f"{f}{last}@{domain}"},
    ]


def rescore(lead, urgency_map):
    score   = 0
    reasons = []

    # 1. Website FX signals (0-30)
    fx_sigs = lead.get("fx_payment_signals", [])
    if fx_sigs:
        s = min(30, 8 + len(fx_sigs) * 4)
        score += s
        reasons.append(f"Direct FX payment signals: {', '.join(fx_sigs[:3])}")

    # 2. Secondary international signals (0-10)
    sec_sigs = lead.get("secondary_signals", [])
    if sec_sigs:
        s = min(10, len(sec_sigs) * 2)
        score += s
        reasons.append(f"International activity signals ({len(sec_sigs)})")

    # 3. SIC code — tiered boost (0-15)
    sic_codes = lead.get("sic_codes", [])
    sb = sic_boost(sic_codes)
    if sb:
        score += sb
        t = sic_tier(sic_codes)
        tier_label = {1:"core trade/wholesale", 2:"manufacturing", 3:"logistics/retail"}[t]
        reasons.append(f"SIC tier {t} ({tier_label}): {', '.join(sic_codes[:2])}")

    # 4. Exposure level boost (0-20)
    exp_boost = EXPOSURE_LEVEL_BOOST.get(lead.get("exposure_level", ""), 0)
    if exp_boost:
        score += exp_boost
        reasons.append(f"Segment exposure: {lead.get('exposure_level')} — {lead.get('exposure_type','')[:40]}")

    # 5. Event urgency (0-10)
    urgency = urgency_map.get(lead.get("event_id",""), 0)
    if urgency >= 7:
        score += 10
        reasons.append(f"High urgency event (score {urgency}/10)")
    elif urgency >= 4:
        score += 5

    # 6. Company name trade signals (0-8)
    ns = name_signal_score(lead.get("company_name", ""))
    if ns:
        score += ns
        reasons.append(f"Company name signals trade/international activity (+{ns})")

    # 7. Company age (−5 to +8)
    a = age_score(lead.get("incorporated"))
    score += a
    if a > 0:
        reasons.append(f"Established company (+{a}) — incorporated {str(lead.get('incorporated',''))[:4]}")
    elif a < 0:
        reasons.append(f"Very new company ({a}) — incorporated {str(lead.get('incorporated',''))[:4]}")

    # 8. Director found (+5)
    if lead.get("director_name"):
        score += 5
        reasons.append(f"Director found: {lead['director_name']}")

    # 9. Website — tiered (+25/+15/+8/−20)
    conf = lead.get("website_confidence")
    src  = lead.get("website_source", "")
    if lead.get("website"):
        if conf == "high":
            score += 25
            reasons.append(f"Website verified — strong name match ({src})")
        elif conf in ("medium", "confirmed"):
            score += 15
            reasons.append(f"Website verified ({src})")
        elif conf == "low":
            score += 8
            reasons.append(f"Website found — low confidence ({src})")
        else:
            # CH-provided URL or legacy lead without confidence field
            score += 15
            reasons.append("Website confirmed")
    else:
        score -= 20
        reasons.append("No website found (−20)")

    # 10. Active status (+5)
    if (lead.get("company_status") or "").lower() == "active":
        score += 5
        reasons.append("Active on Companies House")

    score = min(score, 100)

    # ── Evidence gates — these enforce conviction thresholds ──────────────
    has_fx      = lead.get("pays_fx_confirmed") or len(fx_sigs) > 0
    has_intl    = has_fx or len(sec_sigs) >= 3
    has_sic     = sb > 0
    has_website = bool(lead.get("website"))
    wc          = lead.get("website_confidence", "")

    # Gate -1: hard-skip content / retail domains → force SKIP regardless of signals
    # Encyclopaedias, supermarkets, and consumer retailers are never FX prospects.
    # They may have geographic/import text in their pages (product descriptions,
    # country-of-origin info) but that does not make them callable businesses.
    if has_website and is_hard_skip_domain(lead.get("website", "")):
        score = min(score, 39)
        dom = extract_domain(lead.get("website", ""))
        reasons.append(f"⚠ Content/retail site ({dom}) — not a B2B prospect, capped at SKIP")
        has_website = False

    # Gate 0: known-bad domain (trade publication / news site / sector portal)
    # enrich_websites sometimes latches onto industry news rather than the company's own site.
    if has_website and is_known_bad_domain(lead.get("website", "")):
        score = min(score, 49)
        dom = extract_domain(lead.get("website", ""))
        reasons.append(f"⚠ Bad domain ({dom}) — trade publication/aggregator, not company site")
        has_website = False   # treat same as no-website for subsequent gates

    # Gate A: no website → hard cap at SKIP
    # A company with no website at all has zero direct evidence. Not callable.
    if not has_website:
        score = min(score, 39)
        reasons.append("⚠ No website — SKIP cap (no direct evidence)")

    # Gate B: no FX signals + no secondary signals → cap at SKIP unless strong SIC
    # A company with a website but no trade signals found is not call-worthy.
    if has_website and not has_fx and not has_intl:
        if has_sic:
            score = min(score, 55)   # QUEUE, not WARM
            reasons.append("⚠ No website FX signals — QUEUE cap (SIC only)")
        else:
            score = min(score, 39)
            reasons.append("⚠ No trade evidence at all — SKIP")

    # Gate C: HOT requires direct FX signal OR pays_fx_confirmed on website
    # Having a good SIC code and a website is not enough for HOT.
    if score >= 80 and not has_fx:
        score = 79
        reasons.append("⚠ HOT capped → WARM: no direct FX signal on website")

    # Gate D: WARM requires at least some international evidence
    # B2B-only domestic companies shouldn't be WARM without international signals.
    if score >= 60 and not has_intl and has_website:
        if wc not in ("high", "medium", "confirmed"):
            score = 55
            reasons.append("⚠ WARM capped → QUEUE: low website confidence, no FX signals")

    # ── Gate E: Association / trade body → force SKIP ─────────────────────
    # Trade bodies and membership organisations are useful as source pages for
    # mining member links, but they are NOT callable FX prospects.
    # Either a membership-organisation SIC code OR an association-type name
    # pattern is sufficient to cap at SKIP (score ≤ 39).
    sic_codes = lead.get("sic_codes", [])
    is_assoc_sic  = any(str(s).strip() in ASSOCIATION_SICS for s in sic_codes)
    is_assoc_name = bool(_ASSOC_PATTERN.search(lead.get("company_name", "")))
    if is_assoc_sic or is_assoc_name:
        score = min(score, 39)
        trigger = "SIC" if is_assoc_sic else "name pattern"
        reasons.append(
            f"⚠ Trade/membership organisation ({trigger}) — capped at SKIP"
        )

    # ── Gate F: Dissolved company → force SKIP ────────────────────────────
    # A dissolved company has no active trading relationship to call on.
    # Website signals may still be present (domain often stays live) but the
    # company itself is not callable. Cap at SKIP regardless of other scores.
    if (lead.get("company_status") or "").lower() == "dissolved":
        score = min(score, 39)
        reasons.append("⚠ Dissolved company — capped at SKIP")

    # ── Gate G: WARM/HOT requires B2B / trade evidence ────────────────────
    # A single weak geographic/FX signal (e.g. "from italy" appearing in body
    # text) is not enough commercial conviction to justify a call. The company
    # must also show at least one B2B / trade / commercial signal.
    #
    # Short-circuit order (any TRUE bypasses the cap):
    #   1. Signal set match — fx/b2b/secondary signals contain a known B2B term
    #   2. Any non-empty b2b_signals — even non-standard phrases like "trade
    #      customers" or "minimum order" confirm commercial activity
    #   3. pays_fx_confirmed — scraper confirmed FX payment activity on the site
    #   4. Company name — contains a B2B/trade word as a substring
    if score >= 65:
        all_sigs = set(
            (lead.get("fx_payment_signals") or [])
            + (lead.get("b2b_signals") or [])
            + (lead.get("secondary_signals") or [])
        )
        has_b2b_evidence = bool(all_sigs & _B2B_TRADE_SIGNALS)
        # Any non-empty b2b_signals list proves commercial activity
        if not has_b2b_evidence:
            has_b2b_evidence = bool(lead.get("b2b_signals"))
        # pays_fx_confirmed means the scraper found confirmed FX payment signals
        if not has_b2b_evidence:
            has_b2b_evidence = lead.get("pays_fx_confirmed", False)
        # Company name substring match (e.g. "IMPORTS", "EXPORT", "WHOLESALE")
        if not has_b2b_evidence:
            name_lower = lead.get("company_name", "").lower()
            has_b2b_evidence = any(w in name_lower for w in _B2B_TRADE_SIGNALS)
        if not has_b2b_evidence:
            score = min(score, 64)
            reasons.append(
                "⚠ No B2B/trade evidence on website — capped below WARM"
            )

    # ── Gate H: empty exposure thesis → cap at QUEUE ─────────────────────
    # If neither why_affected nor exposure_thesis provides a meaningful
    # explanation (< 40 chars each), the lead lacks a credible call reason.
    # Cap at QUEUE so Zac can research before calling.
    if score >= 60:
        thesis_a = (lead.get("why_affected") or "").strip()
        thesis_b = (lead.get("exposure_thesis") or "").strip()
        if len(thesis_a) < 40 and len(thesis_b) < 40:
            score = min(score, 59)
            reasons.append("⚠ No exposure thesis — capped at QUEUE (why_affected/exposure_thesis both thin)")

    # ── Gate I: large / unreachable organisation → cap at QUEUE ──────────
    # PLCs, state-owned firms, and global corporations are not realistic
    # SME cold-call targets for outbound FX sales.
    if lead.get("is_large_org"):
        score = min(score, 49)
        reasons.append("⚠ Large/unreachable organisation — capped at QUEUE")

    if   score >= 80: priority = "HOT"
    elif score >= 60: priority = "WARM"
    elif score >= 40: priority = "QUEUE"
    else:             priority = "SKIP"

    return score, priority, reasons


def compute_exposure_confidence(lead):
    """
    Derive exposure_confidence from available evidence on the lead.
    HIGH: strong FX signals on a verified website + high exposure level
    MEDIUM: some evidence (FX signals OR verified website + segment match)
    LOW: mostly inferred (SIC code, segment only)
    NONE: no evidence at all
    """
    fx_sigs  = lead.get("fx_payment_signals", [])
    sec_sigs = lead.get("secondary_signals", [])
    seg_sigs = lead.get("segment_signals", [])
    wc       = lead.get("website_confidence")
    exp_lvl  = lead.get("exposure_level", "")
    pays_fx  = lead.get("pays_fx_confirmed", False)

    evidence = 0
    if pays_fx:                             evidence += 3
    if len(fx_sigs) >= 2:                   evidence += 3
    elif len(fx_sigs) == 1:                 evidence += 2
    if len(seg_sigs) >= 1:                  evidence += 2
    if len(sec_sigs) >= 3:                  evidence += 1
    if wc in ("high",):                     evidence += 2
    elif wc in ("medium", "confirmed"):     evidence += 1
    if exp_lvl == "Very High":              evidence += 2
    elif exp_lvl == "High":                 evidence += 1

    if evidence >= 7: return "high"
    if evidence >= 4: return "medium"
    if evidence >= 1: return "low"
    return "none"


def classify_lead(lead: dict, events: dict) -> dict:
    """
    Derives lead_type, awareness_level, and saving_opportunity from existing fields.
    No API calls — pure logic.

    lead_type:
      trigger_exposed  — this specific event directly affects their payment flows
      evergreen_saving — import/wholesale business likely paying FX through the bank
      both             — multi-event trigger AND strong import signals
      unknown          — insufficient data

    awareness_level: how much does their website indicate FX awareness?
      high   — fx_payment_signals ≥ 3 OR pays_fx_confirmed
      medium — fx_payment_signals ≥ 1
      low    — no visible FX signals

    saving_opportunity: estimated value of a conversation
      high   — score ≥ 85 with strong FX evidence
      medium — score ≥ 65
      low    — below threshold
    """
    score    = lead.get("score", 0)
    multi    = lead.get("multi_event_trigger", False)
    # SIC codes stored as a list ("sic_codes") — check all of them
    sic_list = lead.get("sic_codes") or []
    if not sic_list and lead.get("sic_code"):
        sic_list = [str(lead["sic_code"])]
    sic_list = [str(s).strip() for s in sic_list if s]
    fx_sigs  = len(lead.get("fx_payment_signals") or [])
    paid_fx  = lead.get("pays_fx_confirmed", False)
    event_id = lead.get("event_id", "")
    event    = events.get(event_id, {})
    breadth  = event.get("event_breadth", "")

    # is_trigger: True if this event type directly causes FX exposure.
    # Fallback: if the lead has an event_id but that event is no longer in events.json
    # (e.g. cleared between runs), treat it as trigger-type — the event_id proves it
    # was discovered against a real event, so 'unknown' is wrong. is_evergreen below
    # may also apply; the 'both' branch will handle that correctly.
    stale_event  = bool(event_id and not event)
    is_trigger   = bool(event_id and (breadth in ("broad_currency", "broad_macro", "tariff", "commodity") or stale_event))
    # is_evergreen: three routes to qualification:
    #   1. Import/wholesale SIC (46/47) + any FX evidence
    #   2. Manufacturing SIC (10-33) + confirmed FX on website (pays_fx_confirmed)
    #   3. Any SIC + strong FX signal count (3+ signals = clear recurring FX payer)
    in_import_sic = any(s in SIC_TIER1 or s[:2] in {"46", "47"} for s in sic_list)
    in_mfg_sic    = any(s[:2].isdigit() and 10 <= int(s[:2]) <= 33 for s in sic_list if len(s) >= 2)
    is_evergreen  = (
        (in_import_sic and (fx_sigs > 0 or paid_fx))
        or (in_mfg_sic and paid_fx)
        or (fx_sigs >= 3)   # 3+ FX signals on website = clear FX payer regardless of SIC
    )

    if multi or (is_trigger and is_evergreen):
        lead_type = "both"
    elif is_trigger:
        lead_type = "trigger_exposed"
    elif is_evergreen:
        lead_type = "evergreen_saving"
    else:
        lead_type = "unknown"

    awareness = "high" if (fx_sigs >= 3 or paid_fx) else ("medium" if fx_sigs >= 1 else "low")
    saving    = "high" if (score >= 85 and (fx_sigs >= 2 or paid_fx)) else ("medium" if score >= 65 else "low")

    lead["lead_type"]          = lead_type
    lead["awareness_level"]    = awareness
    lead["saving_opportunity"] = saving
    return lead


def main():
    leads  = json.loads(LEADS_FILE.read_text())
    events = json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
    urgency_map = {eid: int(ev.get("urgency_score") or 0) for eid, ev in events.items()}
    log.info("Rescoring %d leads…", len(leads))

    hot = warm = queue = skip = 0
    reclassified = 0
    for k, lead in leads.items():
        # Backfill id from dict key (old web-discovered leads may be missing it)
        if not lead.get("id"):
            lead["id"] = k
        # Backfill website_domain from website URL (some older leads are missing it)
        if lead.get("website") and not lead.get("website_domain"):
            lead["website_domain"] = extract_domain(lead["website"]) or ""
        # Backfill is_large_org for legacy leads (field added after initial scrape).
        # Only needs the company name + domain — no page text — which is enough
        # to catch known PLCs, global corps, and large-org domains (COSCO, Hendricks, etc.)
        if lead.get("is_large_org") is None:
            lead["is_large_org"] = _sig.is_large_org(
                lead.get("company_name", ""),
                lead.get("website", "") or "",
            )

        # Reclassify legacy leads: bare nationality adjectives are origin hints, not
        # FX evidence — move them out of fx_payment_signals into secondary_signals.
        # (Idempotent: fresh leads no longer contain these in fx_payment_signals.)
        raw_fx = lead.get("fx_payment_signals") or []
        weak   = [s for s in raw_fx if str(s).lower() in WEAK_ORIGIN_TOKENS]
        if weak:
            lead["fx_payment_signals"] = [s for s in raw_fx if str(s).lower() not in WEAK_ORIGIN_TOKENS]
            lead["secondary_signals"]  = list(dict.fromkeys(list(lead.get("secondary_signals") or []) + weak))
            lead["fx_origin_hints"]    = list(dict.fromkeys(list(lead.get("fx_origin_hints") or []) + weak))
            reclassified += 1
        old_score    = lead.get("score", 0)
        old_priority = lead.get("priority", "QUEUE")
        new_score, new_priority, reasons = rescore(lead, urgency_map)

        lead["score"]             = new_score
        lead["priority"]          = new_priority
        lead["scoring_reasons"]   = reasons
        lead["rescored_at"]       = datetime.now(timezone.utc).isoformat()
        lead["exposure_confidence"] = compute_exposure_confidence(lead)
        lead["signal_count"]      = len(lead.get("fx_payment_signals",[])) + len(lead.get("secondary_signals",[]))
        lead["guessed_emails"]    = guess_emails(
            lead.get("director_name",""), lead.get("website","")
        )
        # Ensure contact fields present on legacy leads, then suggest a contact route
        for _cf in _contacts.CONTACT_FIELDS:
            lead.setdefault(_cf, [] if _cf in ("contact_phones", "contact_emails_found") else None)
        lead["best_contact_route"] = _contacts.best_contact_route(lead)
        # Ensure company_source is set for all leads
        if not lead.get("company_source"):
            lead["company_source"] = "companies_house"
        # Classify lead_type, awareness_level, saving_opportunity
        classify_lead(lead, events)

        if new_priority != old_priority:
            log.info("  %s → %s  (score %d → %d)  %s",
                     old_priority, new_priority, old_score, new_score,
                     lead.get("company_name","")[:40])

        if   new_priority == "HOT":   hot   += 1
        elif new_priority == "WARM":  warm  += 1
        elif new_priority == "QUEUE": queue += 1
        else:                         skip  += 1

    # ── DEDUPLICATION PASS ───────────────────────────────────────────────
    # Collapse multiple leads for the same company_number into ONE lead.
    # The highest-scoring lead is kept; others are merged into it.
    # This eliminates the problem of "FINE WINES & SPIRITS LIMITED" appearing
    # 3 times (once per matching event) in the dashboard / call list.
    cn_groups = defaultdict(list)
    for lid, lead in leads.items():
        cn = lead.get("company_number")
        if cn:
            cn_groups[cn].append((lid, lead.get("score", 0)))

    duplicates_removed = 0
    multi_count = 0

    for cn, lid_score_pairs in cn_groups.items():
        if len(lid_score_pairs) <= 1:
            continue

        multi_count += 1
        # Sort by score descending — keep the best one
        lid_score_pairs.sort(key=lambda x: -x[1])
        best_lid  = lid_score_pairs[0][0]
        other_lids = [p[0] for p in lid_score_pairs[1:]]

        # Merge event context into the winning lead
        best = leads[best_lid]
        all_event_ids = list({
            eid for lid in [best_lid] + other_lids
            for eid in (leads[lid].get("linked_event_ids") or [leads[lid].get("event_id","")]) if eid
        })
        all_segments = list({
            leads[lid].get("segment_name","") for lid in [best_lid] + other_lids
            if leads[lid].get("segment_name","")
        })
        all_events_text = list({
            leads[lid].get("event_headline","") or leads[lid].get("trigger_headline","")
            for lid in [best_lid] + other_lids
        } - {""})

        best["multi_event_trigger"]  = True
        best["multi_event_count"]    = len(lid_score_pairs)
        best["linked_event_ids"]     = all_event_ids
        best["linked_segments"]      = all_segments
        best["linked_event_headlines"] = all_events_text

        # Score boost for multi-event exposure
        boost = min(8, (len(lid_score_pairs) - 1) * 4)
        best["score"] = min(100, best["score"] + boost)
        best["scoring_reasons"].append(
            f"Multi-event trigger: {len(lid_score_pairs)} separate events flag this company (+{boost})"
        )
        s = best["score"]
        best["priority"] = "HOT" if s>=80 else "WARM" if s>=60 else "QUEUE" if s>=40 else "SKIP"

        # Remove the lower-scoring duplicates
        for lid in other_lids:
            leads.pop(lid, None)
            duplicates_removed += 1

    if multi_count:
        log.info("Deduplication: %d companies merged (%d duplicate leads removed)",
                 multi_count, duplicates_removed)

    # ── DOMAIN DEDUPLICATION PASS ─────────────────────────────────────────────
    # If two leads with DIFFERENT company_numbers share the same website domain,
    # at least one has been assigned the wrong website by enrich_websites.
    # Fix: strip the website from the lower-scoring lead (Gate A will then cap it).
    dom_groups: dict[str, list] = defaultdict(list)
    for lid, lead in leads.items():
        dom = extract_domain(lead.get("website", ""))
        if dom:
            dom_groups[dom].append((lid, lead.get("score", 0)))

    domain_collisions = 0
    for dom, lid_score_pairs in dom_groups.items():
        if len(lid_score_pairs) <= 1:
            continue
        # Check they're different company numbers (same-CN already handled above)
        cns = {leads[p[0]].get("company_number","") for p in lid_score_pairs}
        if len(cns) <= 1:
            continue
        # Keep the highest-scoring lead's website; strip it from the rest
        lid_score_pairs.sort(key=lambda x: -x[1])
        best_lid = lid_score_pairs[0][0]
        for lid, _ in lid_score_pairs[1:]:
            lead = leads[lid]
            log.info("  Domain collision (%s): stripping website from %s (keeping for %s)",
                     dom, lead.get("company_name","")[:35], leads[best_lid].get("company_name","")[:35])
            lead["website"]            = None
            lead["website_confidence"] = None
            lead["website_source"]     = "collision_stripped"
            for _cf in _contacts.CONTACT_FIELDS:          # contact info came from the wrong site
                lead[_cf] = [] if _cf in ("contact_phones", "contact_emails_found") else None
            lead["best_contact_route"] = _contacts.best_contact_route(lead)
            # Re-apply Gate A — no website → SKIP cap
            s = lead.get("score", 0)
            if s > 39:
                lead["score"] = 39
                lead["priority"] = "SKIP"
                lead["scoring_reasons"].append(
                    f"⚠ Website collision ({dom}) — stripped, SKIP cap (no verified website)"
                )
            domain_collisions += 1

    if domain_collisions:
        log.info("Domain dedup: %d leads had website stripped (duplicate domain)", domain_collisions)

    # Remove SKIPped leads (below threshold — not worth working)
    leads = {k:v for k,v in leads.items() if v.get("priority") != "SKIP"}

    LEADS_FILE.write_text(json.dumps(leads, indent=2, default=str))

    # Sync to public/data/
    public = Path(__file__).parent.parent / "public" / "data"
    public.mkdir(parents=True, exist_ok=True)
    (public / "leads.json").write_text(LEADS_FILE.read_text())

    if reclassified:
        log.info("Reclassified %d leads — moved bare nationality adjectives out of fx_payment_signals", reclassified)
    log.info("Done — HOT: %d  WARM: %d  QUEUE: %d  SKIP/removed: %d  Total: %d",
             hot, warm, queue, skip, len(leads))


if __name__ == "__main__":
    main()
