"""
signals.py — Centralised FX signal definitions for the FX Discovery pipeline.

Single source of truth imported by discover_web.py, discover.py, and rescore.py.

Design rules:
  - Bare nationality adjectives (italian, french, german…) are NEVER direct FX evidence.
    They go into ORIGIN_ADJECTIVES and are stored in fx_origin_hints, not fx_payment_signals.
  - Contextual matches (e.g. "French suppliers", "sourced from Germany") ARE evidence.
    These are extracted by extract_contextual_fx() and returned as fx_payment_signals.
  - SECONDARY_SIGNALS contains trade/international activity words only — no bare adjectives.
"""

import re
from urllib.parse import urlparse


# ── BARE NATIONALITY / COUNTRY ADJECTIVES ─────────────────────────────────────
# These are origin hints only — they fire on ANY business mentioning cuisine,
# wine regions, or destinations. A wine shop saying "Italian Chianti" is NOT
# an FX payment signal. Only become evidence via CONTEXTUAL_FX_PATTERNS below.
ORIGIN_ADJECTIVES: frozenset[str] = frozenset({
    "italian", "french", "spanish", "german", "chinese", "american", "japanese",
    "portuguese", "greek", "dutch", "belgian", "swedish", "danish", "norwegian",
    "finnish", "swiss", "austrian", "polish", "turkish", "indian", "thai",
    "vietnamese", "korean", "mexican", "brazilian", "australian", "scandinavian",
    "mediterranean", "continental", "oriental", "iberian", "nordic", "african",
})

# Backward-compatible alias used in rescore.py
WEAK_ORIGIN_TOKENS: frozenset[str] = ORIGIN_ADJECTIVES


# ── CONTEXTUAL FX PATTERNS ────────────────────────────────────────────────────
# Nationality adjective + sourcing / trade language → real (if weak) FX evidence.
# Examples that match:
#   "French suppliers"        "Italian producers"       "German components"
#   "sourced from Italy"      "imported from France"    "direct from Spain"
#   "supplier from Germany"   "by French manufacturers"

_ADJ = "|".join(sorted(ORIGIN_ADJECTIVES))
_SRC = (
    r"supplier|suppliers|producer|producers|manufacturer|manufacturers|"
    r"factory|factories|partner|partners|vineyard|vineyards|"
    r"importer|importers|ingredient|ingredients|component|components|"
    r"part|parts|material|materials|brand|brands|wholesaler|wholesalers|"
    r"distributor|distributors|source|sourcing|origin|origins|"
    r"grown|farmed|crafted|made|brewed|distilled|winery|wineries"
)

CONTEXTUAL_FX_PATTERNS: list[re.Pattern] = [
    # "French suppliers", "Italian producers", "German components"
    re.compile(rf"\b({_ADJ})\s+({_SRC})\b", re.IGNORECASE),
    # "sourced from Italy", "imported from France", "direct from Germany"
    re.compile(
        rf"\b(sourced|imported|procured|purchased|shipped|brought|direct)\s+from\s+({_ADJ})\b",
        re.IGNORECASE,
    ),
    # "supplier from France", "suppliers in Germany"
    re.compile(rf"\bsupplier[s]?\s+(from|in)\s+({_ADJ})\b", re.IGNORECASE),
    # "from Italian manufacturers", "by French producers"
    re.compile(rf"\b(from|by|with)\s+({_ADJ})\s+({_SRC})\b", re.IGNORECASE),
]


def extract_contextual_fx(text: str) -> list[str]:
    """
    Return list of contextually matched FX phrases (e.g. "french suppliers").
    These represent genuine sourcing evidence even though they contain nationality
    adjectives. Deduped, max 6 returned.
    """
    tlow = text.lower()
    seen: set[str] = set()
    matches: list[str] = []
    for pat in CONTEXTUAL_FX_PATTERNS:
        for m in pat.finditer(tlow):
            phrase = m.group(0).strip()
            if phrase not in seen:
                seen.add(phrase)
                matches.append(phrase)
            if len(matches) >= 6:
                return matches
    return matches


def extract_origin_hints(text: str) -> list[str]:
    """
    Return list of bare nationality adjectives found in the text.
    These go into fx_origin_hints only — never into fx_payment_signals.
    """
    tlow = text.lower()
    # Whole-word match only
    return sorted({adj for adj in ORIGIN_ADJECTIVES if re.search(rf"\b{adj}\b", tlow)})


# ── DIRECT FX PAYMENT SIGNALS (high weight) ──────────────────────────────────
# Explicit import / export / payment / sourcing language. No bare adjectives.
FX_PAYMENT_SIGNALS: list[str] = [
    "we import", "we source", "sourced from", "imported from", "direct from",
    "importing from", "we buy from", "purchased from", "procured from",
    "overseas supplier", "european supplier", "international supplier", "foreign supplier",
    "global supplier", "worldwide supplier",
    "from italy", "from france", "from spain", "from germany", "from china", "from usa",
    "from america", "from japan", "from india", "from norway", "from australia",
    "from new zealand", "from south africa", "from denmark", "from netherlands",
    "from europe", "from asia", "from the us", "from the usa", "from the eu",
    "foreign currency", "currency risk", "exchange rate", "fx exposure",
    "international payments", "overseas payments", "currency hedging", "fx risk",
    "importer", "import company", "import business", "exclusive importer",
    "uk importer", "sole importer", "we distribute", "import and distribute",
    "export", "exports", "exporting", "we export", "overseas customers", "global customers",
    "international customers", "us customers", "american customers", "european customers",
]

# ── SECONDARY / TRADE SIGNALS (lower weight) ─────────────────────────────────
# Indicates trade / international presence but weaker than direct payment signals.
# No bare nationality adjectives — those live in ORIGIN_ADJECTIVES above.
SECONDARY_SIGNALS: list[str] = [
    "international", "global", "worldwide", "overseas", "distribution", "distributor",
    "wholesale", "wholesaler", "logistics", "freight", "shipping", "customs", "clearance",
    "europe", "european", "asia", "north america", "south america",
    "supply chain", "supplier", "sourcing", "procurement",
    "currency", "forex", "exchange", "sterling", "dollar", "euro", "euros", "dollars",
    "import", "export", "trading",
]

# ── B2B SIGNALS ───────────────────────────────────────────────────────────────
B2B_SIGNALS: list[str] = [
    "wholesale", "wholesaler", "wholesale only", "trade only", "trade prices",
    "trade customers", "trade enquiries", "distributor", "distribution",
    "minimum order", "bulk order", "bulk pricing", "bulk discount",
    "b2b", "business to business", "business customers", "corporate customers",
    "stockist", "stockists", "nationwide stockists", "become a stockist",
    "reseller", "resellers", "agent", "agents", "authorised dealer", "authorized dealer",
    "contract manufacturing", "own label", "private label", "white label",
    "we supply", "we manufacture and supply", "supply chain",
    "catalogue available", "brochure available", "price list",
    "no vat", "ex vat", "plus vat", "+vat",
]

# ── NEGATIVE SIGNALS ──────────────────────────────────────────────────────────
NEGATIVE_SIGNALS: list[str] = [
    "restaurant", "cafe", "coffee shop", "takeaway", "food delivery", "just eat",
    "hair salon", "nail salon", "beauty salon", "barber", "hairdresser",
    "recruitment agency", "job agency", "staffing agency", "we hire", "submit your cv",
    "estate agent", "letting agent", "property management", "rental property", "for sale",
    "blog", "personal blog", "my thoughts", "travel diary", "lifestyle",
    "local delivery only", "local area only", "uk delivery only", "mainland uk only",
    "dental", "dentist", "gp surgery", "medical practice", "clinic", "pharmacy",
    "nursery", "primary school", "secondary school", "sixth form", "university",
    "charity", "not for profit", "non profit", "registered charity", "donate",
    "plumber", "electrician", "roofer", "builder", "handyman", "decorator",
    "personal trainer", "fitness instructor", "yoga", "pilates", "gym", "crossfit",
    "wedding", "event planning", "party planning", "catering for weddings",
    "under construction", "coming soon", "parked domain", "placeholder",
]


# ── LARGE / UNREACHABLE ORGANISATION DETECTION ───────────────────────────────
# PLCs, state-owned firms, global corporations, and household-name brands are
# not realistic SME cold-call targets for outbound FX sales. Detect and cap them.

_LARGE_ORG_NAME_RES: list[re.Pattern] = [
    re.compile(r"\bplc\b", re.IGNORECASE),
    re.compile(r"\b(group|holdings|holding)\b.{0,30}\bplc\b", re.IGNORECASE),
    re.compile(r"\b(global|worldwide|international)\s+(corporation|corp|group)\b", re.IGNORECASE),
    re.compile(r"\bnational\s+(airline|rail|grid|shipping|freight|carrier)\b", re.IGNORECASE),
    re.compile(r"\bstate[\s\-]owned\b", re.IGNORECASE),
]

_LARGE_ORG_WEBSITE_PHRASES: frozenset[str] = frozenset({
    "listed on the",
    "stock exchange",
    "publicly traded",
    "listed company",
    "global offices in",
    "offices in over",
    "worldwide offices",
    "we operate in over",
    "operating in over",
    "worldwide network of",
    "global network of",
    "state-owned",
    "government-owned",
    "over 10,000 employees",
    "over 5,000 employees",
    "ftse 100",
    "ftse 250",
    "annual revenue of",
    "billion turnover",
    "billion in revenue",
})

_LARGE_ORG_DOMAINS: frozenset[str] = frozenset({
    # Global shipping lines
    "cosco.co.uk", "cosco.com", "cosco-shipping.com",
    "maersk.com", "maersk.co.uk",
    "cma-cgm.com", "msc.com", "hapag-lloyd.com",
    # Global logistics / couriers
    "dhl.com", "dhl.co.uk",
    "fedex.com", "fedex.co.uk",
    "ups.com", "ups.co.uk",
    "dpd.co.uk", "evri.com", "royalmail.com",
    # Major airlines
    "britishairways.com", "ba.com",
    "easyjet.com", "ryanair.com", "jet2.com",
    "lufthansa.com", "klm.com", "airfrance.com",
    # UK supermarkets / major retailers
    "tesco.com", "sainsburys.co.uk", "morrisons.com",
    "asda.com", "waitrose.com", "marksandspencer.com",
    "iceland.co.uk", "aldi.co.uk", "lidl.co.uk",
    # Global e-commerce
    "amazon.co.uk", "amazon.com", "ebay.co.uk", "ebay.com",
    # Major spirits / drinks PLCs
    "diageo.com", "pernod-ricard.com", "bacardi.com",
    "hendricksgin.com",   # William Grant & Sons
    "williamgrant.com",
    # Major energy
    "shell.com", "shell.co.uk", "bp.com", "exxonmobil.com",
    # Major FMCG
    "unilever.com", "unilever.co.uk",
    "nestle.com", "nestle.co.uk",
    "mondelez.com", "pg.com",
})


def is_large_org(company_name: str, website: str, page_text: str = "") -> bool:
    """
    Return True if this appears to be a PLC, state-owned firm, global corporation,
    or other large organisation not suitable for SME outbound cold-calling.

    Uses three independent checks:
      1. Known large-org domains
      2. Company name pattern matching (plc, group plc, state-owned, etc.)
      3. Website text phrases (requires 2+ matches to avoid false positives)
    """
    name_lower = (company_name or "").lower()
    text_lower = (page_text or "").lower()

    # 1. Domain check
    try:
        dom = urlparse(website or "").netloc.lower()
        dom = re.sub(r"^www\d*\.", "", dom)
    except Exception:
        dom = ""
    if dom in _LARGE_ORG_DOMAINS:
        return True
    for d in _LARGE_ORG_DOMAINS:
        if dom.endswith("." + d):
            return True

    # 2. Company name pattern
    for pat in _LARGE_ORG_NAME_RES:
        if pat.search(name_lower):
            return True

    # 3. Website text — need 2+ phrase hits to avoid false positives
    if text_lower:
        hits = sum(1 for phrase in _LARGE_ORG_WEBSITE_PHRASES if phrase in text_lower)
        if hits >= 2:
            return True

    return False
