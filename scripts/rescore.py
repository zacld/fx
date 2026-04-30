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
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

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

    # Gate: no FX evidence and no FX SIC → cap at SKIP threshold
    has_fx  = lead.get("pays_fx_confirmed") or len(fx_sigs) > 0
    has_sic = sb > 0
    if not has_fx and not has_sic:
        score = min(score, 39)
        reasons.append("⚠ No direct FX evidence")

    if   score >= 80: priority = "HOT"
    elif score >= 60: priority = "WARM"
    elif score >= 40: priority = "QUEUE"
    else:             priority = "SKIP"

    return score, priority, reasons


def main():
    leads  = json.loads(LEADS_FILE.read_text())
    events = json.loads(EVENTS_FILE.read_text()) if EVENTS_FILE.exists() else {}
    urgency_map = {eid: int(ev.get("urgency_score") or 0) for eid, ev in events.items()}
    log.info("Rescoring %d leads…", len(leads))

    hot = warm = queue = skip = 0
    for k, lead in leads.items():
        old_score    = lead.get("score", 0)
        old_priority = lead.get("priority", "QUEUE")
        new_score, new_priority, reasons = rescore(lead, urgency_map)

        lead["score"]            = new_score
        lead["priority"]         = new_priority
        lead["scoring_reasons"]  = reasons
        lead["rescored_at"]      = datetime.now(timezone.utc).isoformat()
        lead["guessed_emails"]   = guess_emails(
            lead.get("director_name",""), lead.get("website","")
        )

        if new_priority != old_priority:
            log.info("  %s → %s  (score %d → %d)  %s",
                     old_priority, new_priority, old_score, new_score,
                     lead.get("company_name","")[:40])

        if   new_priority == "HOT":   hot   += 1
        elif new_priority == "WARM":  warm  += 1
        elif new_priority == "QUEUE": queue += 1
        else:                         skip  += 1

    # Remove SKIPped leads (they were already below threshold)
    leads = {k:v for k,v in leads.items() if v.get("priority") != "SKIP"}

    LEADS_FILE.write_text(json.dumps(leads, indent=2, default=str))

    # Sync to public/data/
    public = Path(__file__).parent.parent / "public" / "data"
    public.mkdir(parents=True, exist_ok=True)
    (public / "leads.json").write_text(LEADS_FILE.read_text())

    log.info("Done — HOT: %d  WARM: %d  QUEUE: %d  SKIP/removed: %d  Total: %d",
             hot, warm, queue, skip, len(leads))


if __name__ == "__main__":
    main()
