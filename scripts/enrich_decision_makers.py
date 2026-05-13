"""
enrich_decision_makers.py v2 — Full decision-maker enrichment pipeline.

Five improvements over v1:
  1. Company name cleaner — strips page-title artifacts, slogans, legal suffixes
  2. Named-people extraction — JSON-LD, proximity regex, card heuristics (not just mailto:)
  3. Multi-page crawl — team + about + contact + probed pages (up to 5 pages)
  4. Role tier system — Tier 1 (FD/CFO/MD), Tier 2 (Commercial/Ops), Tier 3 (Generic)
  5. Route grade A–E + contact confidence score 0–100 written to every lead

Run: python3.11 scripts/enrich_decision_makers.py [--force]
Idempotent — re-running updates with improved data.
"""

import json, re, sys, time, smtplib, socket, logging, os, random, threading
import requests
from pathlib import Path
from urllib.parse import urljoin, urlparse, quote_plus
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import dns.resolver
    HAS_DNS = True
except ImportError:
    HAS_DNS = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

ROOT      = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "leads.json"

# ── Config ────────────────────────────────────────────────────────────────────
CH_API_KEY       = os.getenv("COMPANIES_HOUSE_API_KEY", "bf190544-f3dd-4dd3-b60b-d897c8ffebf8")
CH_BASE          = "https://api.company-information.service.gov.uk"
CH_TIMEOUT       = (4, 10)
CH_DELAY         = 0.4           # seconds between CH requests per worker
WEB_TIMEOUT      = (5, 12)
SMTP_TIMEOUT     = 2
WORKERS          = 5             # thread pool size
CHECKPOINT_EVERY = 40
MAX_OFFICERS     = 8             # cap per company
SMTP_PER_PERSON  = 3             # max SMTP probes per director
MAX_PAGES        = 5             # max web pages fetched per company
FORCE_REFRESH    = "--force" in sys.argv
# GitHub Actions (and most CI envs) block outbound SMTP port 25 — skip verification
SKIP_SMTP        = os.getenv("CI") == "true" or "--no-smtp" in sys.argv

# CH rate-limit guard: max 2 simultaneous CH calls
_ch_sem = threading.Semaphore(2)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Accept-Language": "en-GB,en;q=0.9",
}
SESSION = requests.Session()
SESSION.headers.update(HEADERS)

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(
    r"(?<![/\d])(?:\+44\s?\(?0?\)?\s?|\(?0)\s?\d{1,5}[)\s.\-]?\s?\d{2,4}[\s.\-]?\d{3,4}(?![/\d])"
)
JUNK_HOSTS = {
    "sentry.io", "wixpress.com", "example.com", "domain.com",
    "yourdomain.com", "email.com", "sentry-next.wixpress.com",
}

# ── Phone helpers ─────────────────────────────────────────────────────────────
def extract_phones_from_html(html: str) -> list[str]:
    """
    Extract UK phone numbers from HTML in priority order:
    tel: links → schema.org telephone → free text PHONE_RE.
    Returns normalised, deduplicated list.
    """
    phones: list[str] = []

    # 1. tel: links (highest confidence — deliberately placed by site owner)
    for m in re.finditer(r'href=["\']tel:([+\d\s()\-\.]{7,20})["\']', html, re.IGNORECASE):
        phones.append(m.group(1).strip())

    # 2. Schema.org / JSON-LD telephone property
    for m in re.finditer(r'"telephone"\s*:\s*"([^"]{7,20})"', html, re.IGNORECASE):
        phones.append(m.group(1).strip())

    # 3. Free text (strip tags first)
    text = re.sub(r"<[^>]+>", " ", html)
    for m in PHONE_RE.finditer(text):
        phones.append(m.group(0).strip())

    # Deduplicate by digit-only fingerprint
    seen: set[str] = set()
    out: list[str] = []
    for p in phones:
        digits = re.sub(r"[^\d+]", "", p)
        if len(digits) >= 10 and digits not in seen:
            seen.add(digits)
            out.append(re.sub(r"[\s\-\.]", " ", p).strip())
    return out


def best_phone(phones: list[str]) -> str | None:
    """
    Pick the most useful phone from a list.
    Prefer geographic (01/02) and mobile (07) over non-geo (0800/0300/0808).
    """
    if not phones:
        return None
    local = [p for p in phones if re.match(r"(\+44\s?[127]|0[127])", p)]
    return local[0] if local else phones[0]

# ── Role tier definitions ─────────────────────────────────────────────────────
# Each entry: (regex pattern, tier 1-3, canonical label)
ROLE_TIERS: list[tuple[str, int, str]] = [
    # Tier 1 — Finance & Ownership (best FX conversation targets)
    (r"financ\w* director|financial director",      1, "Finance Director"),
    (r"\bfd\b",                                     1, "Finance Director"),
    (r"chief financial officer|cfo",                1, "CFO"),
    (r"head of financ|head of accounts|head, finance", 1, "Head of Finance"),
    (r"treasury manager|treasurer",                 1, "Treasurer"),
    (r"finance manager",                            1, "Finance Manager"),
    (r"managing director|\bmd\b",                   1, "Managing Director"),
    (r"chief executive officer?|\bceo\b",           1, "CEO"),
    (r"\bfounder\b|\bco-founder\b",                 1, "Founder"),
    (r"\bowner\b",                                  1, "Owner"),
    (r"proprietor",                                 1, "Proprietor"),
    # Tier 2 — Commercial / Operations (secondary targets)
    (r"commercial director",                        2, "Commercial Director"),
    (r"operations director",                        2, "Operations Director"),
    (r"procurement director|purchasing director",   2, "Procurement Director"),
    (r"supply chain director",                      2, "Supply Chain Director"),
    (r"sales director",                             2, "Sales Director"),
    (r"purchasing manager|procurement manager",     2, "Purchasing Manager"),
    (r"accounts manager|accounts payable",          2, "Accounts Manager"),
    (r"general manager",                            2, "General Manager"),
    # Tier 3 — Generic / Fallback
    (r"\bdirector\b",                               3, "Director"),
    (r"company secretary|secretary",                3, "Company Secretary"),
    (r"non.?executive",                             3, "Non-Executive"),
]

# Canonical role labels used in named-people extraction from HTML
ROLE_LABELS = [label for _, _, label in ROLE_TIERS]
ROLE_LABEL_RE = re.compile(
    r"\b(" + "|".join(re.escape(l) for l in ROLE_LABELS) + r")\b",
    re.IGNORECASE,
)

STOP_WORDS = {
    "about", "the", "and", "for", "our", "your", "with", "from", "team",
    "meet", "home", "contact", "welcome", "services", "products", "company",
    "north", "south", "east", "west", "united", "great", "new", "old",
    "read", "more", "view", "profile", "click", "here", "back", "next",
    "first", "last", "find", "learn", "book", "call", "email", "send",
    "finance", "director", "manager", "head", "chief", "managing", "sales",
    "marketing", "operations", "procurement", "commercial", "supply", "chain",
    "limited", "limited", "group", "holdings", "plc", "ltd",
}

# ── Company name cleaner ──────────────────────────────────────────────────────
_TITLE_PREFIX_RE = re.compile(
    r"^(about\s+us|home|contact(\s+us)?|welcome\s+to|hello|news|blog|team|"
    r"our\s+team|meet\s+the\s+team|management|leadership)\s*[-–|:]\s*",
    re.IGNORECASE,
)
_SLOGAN_SUFFIX_RE = re.compile(
    r"\s*[-–—|]\s*.{10,80}$"   # anything after a separator that's 10+ chars
)
_LEGAL_RE = re.compile(
    r"\s+(limited|ltd\.?|plc|llp|llc|inc\.?|corp\.?|group|holdings?|uk|united kingdom)\s*$",
    re.IGNORECASE,
)


def clean_name_for_search(lead: dict) -> str:
    """
    Return a clean company name suitable for search/LinkedIn.
    CH names (ALL CAPS) are title-cased and legal suffixes stripped.
    Scraped names get page-title artifacts and slogans removed.
    """
    raw = (lead.get("company_name") or "").strip()
    if not raw:
        return ""

    # CH-sourced names are ALL CAPS — convert to Title Case
    if raw == raw.upper() and len(raw) > 2:
        raw = raw.title()

    # Strip page-title prefixes ("About Us - ", "Home | ")
    raw = _TITLE_PREFIX_RE.sub("", raw).strip()

    # Strip slogan suffixes after pipes/dashes (only when >3 words follow)
    for sep in ["|", "–", "—"]:
        if sep in raw:
            before, after = raw.split(sep, 1)
            if len(after.strip().split()) >= 3:
                raw = before.strip()
                break

    # For search purposes, strip generic legal/geographic suffixes
    raw = _LEGAL_RE.sub("", raw).strip()

    # Strip residual trailing punctuation
    raw = raw.rstrip("-–—|:,. ")

    return raw


def name_for_linkedin(lead: dict) -> str:
    """Short 3-word version of clean name for LinkedIn search."""
    clean = clean_name_for_search(lead)
    words = clean.split()
    # Keep up to 3 meaningful words
    return " ".join(words[:3]) if words else clean


# ── Role tier logic ───────────────────────────────────────────────────────────
def role_tier(role: str) -> tuple[int, str]:
    """Return (tier 1-3, canonical_label) for a role string."""
    r = (role or "").lower().replace("-", " ").replace("_", " ")
    for pattern, tier, label in ROLE_TIERS:
        if re.search(pattern, r):
            return tier, label
    return 3, role.title() if role else "Director"


def tier_label(tier: int) -> str:
    return {1: "Primary", 2: "Secondary", 3: "Fallback"}.get(tier, "Fallback")


# ── Name parsing ──────────────────────────────────────────────────────────────
def parse_ch_name(raw: str) -> dict:
    """
    CH names: "SMITH, James David" → {full_name, first_name, last_name, initials}
    """
    raw = raw.strip()
    if "," in raw:
        last, rest = raw.split(",", 1)
        last  = last.strip().title()
        parts = rest.strip().split()
        first = parts[0].capitalize() if parts else ""
    else:
        parts = raw.split()
        last  = parts[-1].title() if parts else ""
        first = parts[0].capitalize() if len(parts) > 1 else ""

    full = f"{first} {last}".strip() if first else last
    return {
        "full_name":  full,
        "first_name": first,
        "last_name":  last,
        "initials":   "".join(p[0].upper() for p in full.split() if p),
    }


# ── Companies House ───────────────────────────────────────────────────────────
def ch_officers(company_number: str) -> list[dict]:
    """Fetch all ACTIVE officers, sorted Tier-1 first."""
    url = f"{CH_BASE}/company/{company_number}/officers"
    with _ch_sem:
        try:
            r = requests.get(
                url, auth=(CH_API_KEY, ""), timeout=CH_TIMEOUT,
                params={"items_per_page": 50},
            )
            time.sleep(CH_DELAY)
            if not r.ok:
                return []
            items = r.json().get("items", [])
        except Exception as e:
            log.debug("CH error %s: %s", company_number, e)
            return []

    active = [o for o in items if not o.get("resigned_on")]
    active.sort(key=lambda o: role_tier(o.get("officer_role", ""))[0])
    return active[:MAX_OFFICERS]


# ── Website fetching ──────────────────────────────────────────────────────────
def fetch(url: str) -> str:
    try:
        r = SESSION.get(url, timeout=WEB_TIMEOUT, allow_redirects=True)
        ct = r.headers.get("content-type", "")
        if r.ok and "text/html" in ct:
            return r.text[:500_000]   # cap HTML size
    except Exception:
        pass
    return ""


def head_ok(url: str) -> bool:
    try:
        r = SESSION.head(url, timeout=(3, 6), allow_redirects=True)
        return r.ok
    except Exception:
        return False


def domain_of(url: str) -> str:
    try:
        h = urlparse(url).hostname or ""
        return re.sub(r"^www\d*\.", "", h.lower())
    except Exception:
        return ""


# ── Named-people extraction from HTML ────────────────────────────────────────
_NAME_RE = re.compile(r"\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\b")


def _flatten_jsonld(obj) -> list:
    """Recursively yield all dicts from a JSON-LD structure."""
    if isinstance(obj, list):
        out = []
        for item in obj:
            out.extend(_flatten_jsonld(item))
        return out
    if isinstance(obj, dict):
        out = [obj]
        for v in obj.values():
            if isinstance(v, (list, dict)):
                out.extend(_flatten_jsonld(v))
        return out
    return []


def extract_named_people(html: str, domain: str) -> list[dict]:
    """
    Find named people + roles from a team/about/contact page.
    Three passes: JSON-LD, proximity regex, card heuristic.
    Returns list of {name, role, email, source, tier, tier_label}.
    """
    if not html:
        return []

    found: dict[str, dict] = {}   # name.lower() → person dict

    # ── Pass 1: JSON-LD schema.org/Person ────────────────────────────
    for m in re.finditer(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.IGNORECASE
    ):
        try:
            obj = json.loads(m.group(1))
            for node in _flatten_jsonld(obj):
                if not isinstance(node, dict):
                    continue
                t = node.get("@type", "")
                if "Person" not in (t if isinstance(t, str) else " ".join(t)):
                    continue
                name  = (node.get("name") or "").strip()
                jrole = (node.get("jobTitle") or node.get("roleName") or "").strip()
                email = (node.get("email") or "").replace("mailto:", "").strip()
                if name and len(name.split()) >= 2:
                    tier_n, tier_lbl = role_tier(jrole)
                    key = name.lower()
                    found[key] = {
                        "name": name, "role": jrole, "tier": tier_n,
                        "tier_label": tier_lbl, "source": "jsonld",
                        "email": email if "@" in email else "",
                    }
        except Exception:
            pass

    # ── Pass 2: Proximity — name within ±100 chars of a known role ───
    text = re.sub(r"<[^>]+>", " ", html)
    text = re.sub(r"\s+", " ", text)

    for role_m in ROLE_LABEL_RE.finditer(text):
        role_str = role_m.group(1)
        start, end = role_m.start(), role_m.end()
        window = text[max(0, start - 120): end + 120]
        for nm in _NAME_RE.finditer(window):
            fname = nm.group(1)
            lname_rest = nm.group(2)
            if fname.lower() in STOP_WORDS:
                continue
            lname = lname_rest.split()[0]
            if lname.lower() in STOP_WORDS:
                continue
            full = f"{fname} {lname_rest.split()[0]}"
            tier_n, tier_lbl = role_tier(role_str)
            key = full.lower()
            if key not in found:
                found[key] = {
                    "name": full, "role": role_str, "tier": tier_n,
                    "tier_label": tier_lbl, "source": "proximity", "email": "",
                }

    # ── Pass 3: mailto: links with surrounding name context ──────────
    for m in re.finditer(
        r'(.{0,150})<a[^>]+href=["\']mailto:([^"\'?]+)["\'][^>]*>([^<]*)</a>(.{0,150})',
        html, re.IGNORECASE | re.DOTALL,
    ):
        before, email, link_text, after = (
            m.group(1), m.group(2).strip().lower(),
            m.group(3), m.group(4),
        )
        host = email.split("@")[-1] if "@" in email else ""
        if not host or any(host.endswith(j) for j in JUNK_HOSTS):
            continue
        if domain and not (host == domain or host.endswith(f".{domain}")):
            continue
        context = re.sub(r"<[^>]+>", " ", before + link_text + after)
        context = re.sub(r"\s+", " ", context).strip()
        # Try to find a name in the context
        for nm in _NAME_RE.finditer(context):
            fname, lname_rest = nm.group(1), nm.group(2)
            if fname.lower() in STOP_WORDS:
                continue
            lname = lname_rest.split()[0]
            full  = f"{fname} {lname}"
            key   = full.lower()
            # Try to find a role in the same context
            rm    = ROLE_LABEL_RE.search(context)
            role_str = rm.group(1) if rm else ""
            tier_n, tier_lbl = role_tier(role_str)
            if key not in found:
                found[key] = {
                    "name": full, "role": role_str, "tier": tier_n,
                    "tier_label": tier_lbl, "source": "mailto_context",
                    "email": email,
                }
            elif not found[key].get("email") and email:
                found[key]["email"] = email

    people = list(found.values())
    people.sort(key=lambda p: p.get("tier", 3))
    return people


def extract_emails_from_html(html: str, domain: str) -> list[str]:
    """All on-domain emails from mailto: links and free text."""
    emails = set()
    for m in re.finditer(r'href=["\']mailto:([^"\'?]+)', html, re.IGNORECASE):
        e = m.group(1).strip().lower()
        if "@" in e:
            emails.add(e)
    for m in EMAIL_RE.finditer(re.sub(r"<[^>]+>", " ", html)):
        emails.add(m.group(0).lower())
    if domain:
        emails = {e for e in emails if e.split("@")[-1] in (domain, f"www.{domain}")}
    return [e for e in emails if not any(e.endswith(j) for j in JUNK_HOSTS)]


# ── Multi-page discovery ──────────────────────────────────────────────────────
TEAM_SLUGS = [
    "team", "our-team", "meet-the-team", "people", "our-people",
    "management", "leadership", "directors", "staff", "key-people",
    "about", "about-us", "who-we-are", "company", "the-company",
]


def discover_pages(lead: dict) -> list[str]:
    """
    Return up to MAX_PAGES candidate URLs to scrape for people data.
    Priority: known stored URLs → probed slugs → homepage.
    """
    website = (lead.get("website") or "").rstrip("/")
    if not website:
        return []

    # Start with known pages already found by pipeline
    candidates: list[str] = []
    for field in ("team_page", "about_page", "contact_page"):
        url = lead.get(field)
        if url and url not in candidates:
            candidates.append(url)

    # Probe additional slugs (HEAD requests to check existence)
    if len(candidates) < MAX_PAGES:
        for slug in TEAM_SLUGS:
            if len(candidates) >= MAX_PAGES:
                break
            url = f"{website}/{slug}"
            if url not in candidates and head_ok(url):
                candidates.append(url)

    # Always include homepage (last priority)
    if website not in candidates:
        candidates.append(website)

    return candidates[:MAX_PAGES]


# ── SMTP verification ─────────────────────────────────────────────────────────
_mx_cache: dict[str, list[str]] = {}
_mx_lock  = threading.Lock()


def get_mx(domain: str) -> list[str]:
    with _mx_lock:
        if domain in _mx_cache:
            return _mx_cache[domain]
    if not HAS_DNS:
        with _mx_lock:
            _mx_cache[domain] = []
        return []
    try:
        records = dns.resolver.resolve(domain, "MX", lifetime=4)
        hosts   = [str(r.exchange).rstrip(".") for r in sorted(records, key=lambda r: r.preference)]
    except Exception:
        hosts = []
    with _mx_lock:
        _mx_cache[domain] = hosts
    return hosts


def mx_provider(mx_hosts: list[str]) -> str:
    """Detect email provider from MX hostnames → 'google' | 'microsoft' | 'zoho' | 'other'."""
    for host in mx_hosts:
        h = host.lower()
        if any(k in h for k in ("google", "googlemail", "aspmx")):
            return "google"
        if any(k in h for k in ("outlook", "protection.outlook", "onmicrosoft")):
            return "microsoft"
        if "zoho" in h:
            return "zoho"
    return "other"


def is_catch_all(domain: str, mx: list[str]) -> bool:
    """Test 3 random probes — catch-all only if 2+ return True (majority vote)."""
    probes = [f"zzz{random.randint(10000, 99999)}@{domain}" for _ in range(3)]
    hits = sum(1 for p in probes if smtp_check(p, mx) is True)
    return hits >= 2


def smtp_check(email: str, mx: list[str]) -> bool | None:
    if not mx:
        return None
    for host in mx[:2]:
        try:
            with smtplib.SMTP(timeout=SMTP_TIMEOUT) as s:
                s.connect(host, 25)
                s.ehlo_or_helo_if_needed()
                s.mail("check@example.com")
                code, _ = s.rcpt(email)
                s.rset()
                if code == 250:
                    return True
                if code in (550, 551, 552, 553):
                    return False
                return None
        except Exception:
            continue
    return None


def verify_patterns(patterns: list[str], domain: str) -> list[dict]:
    if SKIP_SMTP:
        # CI environment — return unverified candidates (SMTP port 25 is blocked)
        return [{"email": p, "smtp_verified": None, "catch_all": None} for p in patterns[:SMTP_PER_PERSON]]
    mx        = get_mx(domain)
    catch_all = is_catch_all(domain, mx) if mx else False
    results   = []
    for p in patterns[:SMTP_PER_PERSON]:
        v = None if catch_all else smtp_check(p, mx)
        results.append({"email": p, "smtp_verified": v, "catch_all": catch_all})
        time.sleep(0.15)
    return results


# ── Email pattern generation ──────────────────────────────────────────────────
def email_patterns(first: str, last: str, domain: str, mx_hosts: list[str] | None = None) -> list[str]:
    """
    Generate email candidates ordered by likelihood for the detected mail provider.
    Google Workspace → firstname@ most common.
    Microsoft 365    → firstname.lastname@ most common.
    """
    f = re.sub(r"[^a-z]", "", first.lower())
    l = re.sub(r"[^a-z]", "", last.lower())
    if not f or not l or not domain:
        return []

    provider = mx_provider(mx_hosts or [])

    all_p = {
        "f":      f"{f}@{domain}",
        "f_l":    f"{f}.{l}@{domain}",
        "fi_l":   f"{f[0]}.{l}@{domain}",
        "fil":    f"{f[0]}{l}@{domain}",
        "fli":    f"{f}{l[0]}@{domain}",
        "f_ul":   f"{f}_{l}@{domain}",
    }

    if provider == "google":
        order = ["f", "f_l", "fi_l", "fil", "fli", "f_ul"]
    elif provider == "microsoft":
        order = ["f_l", "f", "fi_l", "fil", "fli", "f_ul"]
    else:
        order = ["f", "f_l", "fi_l", "fil", "fli", "f_ul"]

    seen, out = set(), []
    for key in order:
        p = all_p[key]
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


# ── Yell.com phone fallback ───────────────────────────────────────────────────
def yell_phone_lookup(company_name: str) -> str | None:
    """
    Search Yell.com for the company and return the first listed phone number.
    Used as a last-resort fallback when no phone found on the company's own site.
    Rate: max 1 request per company, only called when contact_phone is empty.
    """
    try:
        clean = re.sub(r"\s+(ltd\.?|limited|plc|llp)\s*$", "", company_name, flags=re.IGNORECASE).strip()
        if not clean or len(clean) < 3:
            return None
        url = (
            "https://www.yell.com/ucs/UcsSearchAction.do"
            f"?keywords={quote_plus(clean)}&location=uk&scrambleSeed=1"
        )
        r = SESSION.get(url, timeout=(5, 10))
        if not r.ok:
            return None
        html = r.text

        # tel: links in search results (most reliable)
        phones = []
        for m in re.finditer(r'href=["\']tel:([+\d\s()\-\.]{7,20})["\']', html, re.IGNORECASE):
            phones.append(m.group(1).strip())

        if not phones:
            # Fallback: PHONE_RE on stripped text
            text = re.sub(r"<[^>]+>", " ", html)
            for m in PHONE_RE.finditer(text):
                phones.append(m.group(0).strip())

        return best_phone(phones)
    except Exception:
        return None


# ── LinkedIn / Google search URLs ─────────────────────────────────────────────
def li_person_url(full_name: str, co_short: str) -> str:
    return (
        f"https://www.google.com/search?q=site:linkedin.com/in+"
        f"{quote_plus(chr(34)+full_name+chr(34))}+"
        f"{quote_plus(chr(34)+co_short+chr(34))}"
    )


def li_name_only_url(full_name: str) -> str:
    return (
        f"https://www.google.com/search?q=site:linkedin.com/in+"
        f"{quote_plus(chr(34)+full_name+chr(34))}"
    )


def li_company_url(clean_name: str) -> str:
    return (
        f"https://www.google.com/search?q=site:linkedin.com/company+"
        f"{quote_plus(chr(34)+clean_name+chr(34))}"
    )


def google_email_url(full_name: str, domain: str) -> str:
    return (
        f"https://www.google.com/search?q="
        f"{quote_plus(chr(34)+full_name+chr(34))}+"
        f"{quote_plus(chr(34)+'@'+domain+chr(34))}"
    )


# ── Route grade + contact confidence ─────────────────────────────────────────
def compute_route_grade(lead: dict, dms: list[dict]) -> str:
    """
    A  Named Tier-1 (FD/CFO/MD) + verified email OR direct phone
    B  Named Tier-1 + guessed email OR contact page
    C  Named person (any tier) + phone OR email OR contact page
    D  No person but has phone OR company email
    E  Website / contact page only
    F  Nothing useful
    """
    tier1      = [d for d in dms if d.get("tier") == 1]
    any_person = len(dms) > 0
    v_email    = any(d.get("email_verified") and d.get("email") for d in dms)
    g_email    = any(d.get("email_guesses") for d in dms)
    has_phone  = bool(lead.get("contact_phone"))
    has_cpage  = bool(lead.get("contact_page"))
    has_cemail = bool(lead.get("contact_email"))
    has_web    = bool(lead.get("website"))

    if tier1 and (v_email or has_phone):           return "A"
    if tier1 and (g_email or has_cpage or has_cemail): return "B"
    if any_person and (has_phone or has_cemail or has_cpage): return "C"
    if has_phone or has_cemail:                    return "D"
    if has_web or has_cpage:                       return "E"
    return "F"


def compute_contact_confidence(lead: dict, dms: list[dict]) -> int:
    """0-100 score reflecting how actionable the contact route is."""
    score = 0

    # Best person tier (max 35)
    if dms:
        best_tier = min(d.get("tier", 3) for d in dms)
        score += {1: 35, 2: 22, 3: 10}.get(best_tier, 10)

    # Email quality (max 30)
    if any(d.get("email_verified") and d.get("email") for d in dms):
        score += 30
    elif any(d.get("email_guesses") for d in dms):
        score += 14
    elif lead.get("contact_email"):
        score += 10

    # Phone (max 20)
    if lead.get("contact_phone"):
        score += 20

    # Contact / team page (max 10)
    if lead.get("contact_page"):
        score += 6
    if lead.get("team_page") or lead.get("about_page"):
        score += 4

    return min(100, score)


# ── Core enrichment per lead ──────────────────────────────────────────────────
def enrich_lead(lead: dict) -> dict:
    ch_num      = lead.get("company_number", "")
    website     = lead.get("website", "")
    co_name     = lead.get("company_name", "")
    domain      = domain_of(website)
    co_clean    = clean_name_for_search(lead)
    co_short    = name_for_linkedin(lead)

    # ── 1. CH officers ───────────────────────────────────────────────
    officers = ch_officers(ch_num) if ch_num else []

    if not officers:
        dn = lead.get("director_name", "")
        dr = lead.get("director_role", "director")
        if dn:
            parsed = {
                "full_name": dn, "first_name": dn.split()[0] if dn else "",
                "last_name": dn.split()[-1] if dn else "", "initials": "",
            }
            raw_officers = [{"name_parsed": parsed, "officer_role": dr, "appointed_on": None}]
        else:
            raw_officers = []
    else:
        raw_officers = []
        for o in officers:
            raw_officers.append({
                "name_parsed": parse_ch_name(o.get("name", "")),
                "officer_role": o.get("officer_role", "director"),
                "appointed_on": o.get("appointed_on"),
            })

    if not raw_officers:
        # Still compute grade/confidence with whatever contact data exists
        lead["route_grade"]         = compute_route_grade(lead, [])
        lead["contact_confidence"]  = compute_contact_confidence(lead, [])
        lead["company_linkedin"]    = li_company_url(co_clean)
        return lead

    # ── 2. Multi-page scrape ─────────────────────────────────────────
    pages_to_scrape = discover_pages(lead)
    all_html        = ""
    all_people: list[dict] = []   # from named-people extraction
    all_emails: list[str]  = []
    all_phones: list[str]  = []   # phones from every crawled page

    for page_url in pages_to_scrape:
        html = fetch(page_url)
        if not html:
            continue
        all_html += " " + html
        people = extract_named_people(html, domain)
        for p in people:
            if not any(x["name"].lower() == p["name"].lower() for x in all_people):
                all_people.append(p)
        all_emails.extend(extract_emails_from_html(html, domain))
        all_phones.extend(extract_phones_from_html(html))

    # Update contact_phone from multi-page scrape if not already set
    if all_phones and not lead.get("contact_phone"):
        phone = best_phone(all_phones)
        if phone:
            lead["contact_phone"] = phone
            lead["phone_source"]  = "multi_page_scrape"

    # Dedupe emails
    seen_e, clean_emails = set(), []
    for e in all_emails:
        if e not in seen_e:
            seen_e.add(e)
            clean_emails.append(e)

    # ── 3. Build decision_makers list ────────────────────────────────
    decision_makers = []

    for o in raw_officers:
        np    = o["name_parsed"]
        fname = np["first_name"]
        lname = np["last_name"]
        full  = np["full_name"]
        raw_role = o["officer_role"]
        tier_n, tier_lbl = role_tier(raw_role)

        dm: dict = {
            "name":             full,
            "first_name":       fname,
            "last_name":        lname,
            "role":             raw_role,
            "tier":             tier_n,
            "tier_label":       tier_lbl,
            "appointed_on":     o.get("appointed_on"),
            "email":            None,
            "email_source":     None,
            "email_verified":   None,
            "email_guesses":    [],
            "phone":            None,
            "linkedin_search":  li_person_url(full, co_short) if full else None,
            "linkedin_name_only": li_name_only_url(full) if full else None,
            "google_email_search": google_email_url(full, domain) if domain and full else None,
        }

        # a) Match a named-person email from the HTML extraction
        website_person = _match_person(np, all_people)
        if website_person and website_person.get("email"):
            dm["email"]          = website_person["email"]
            dm["email_source"]   = "website_page"
            dm["email_verified"] = True   # published on company website

        # b) Match any on-domain email by name pattern (local part contains name)
        if not dm["email"] and domain:
            matched = _match_email_by_name(fname, lname, clean_emails)
            if matched:
                dm["email"]        = matched
                dm["email_source"] = "website_email_found"
                dm["email_verified"] = True

        # c) SMTP-verify generated patterns (MX-aware ordering)
        if domain:
            mx_hosts = get_mx(domain)   # cached after first call per domain
            patterns = email_patterns(fname, lname, domain, mx_hosts)
            if patterns:
                verified = verify_patterns(patterns, domain)
                dm["email_guesses"] = verified
                if not dm["email"]:
                    best = next((v for v in verified if v.get("smtp_verified") is True), None)
                    if best:
                        dm["email"]          = best["email"]
                        dm["email_source"]   = "smtp_verified"
                        dm["email_verified"] = True

        decision_makers.append(dm)

    # Also add people found on website but NOT in CH officers
    for p in all_people:
        already = any(
            _name_similarity(p["name"], d["name"]) for d in decision_makers
        )
        if not already and p.get("role") and p["tier"] <= 2:
            tier_n, tier_lbl = role_tier(p.get("role", ""))
            dm = {
                "name":          p["name"],
                "first_name":    p["name"].split()[0] if p["name"] else "",
                "last_name":     p["name"].split()[-1] if p["name"] else "",
                "role":          p.get("role", ""),
                "tier":          tier_n,
                "tier_label":    tier_lbl,
                "appointed_on":  None,
                "email":         p.get("email") or None,
                "email_source":  "website_page" if p.get("email") else None,
                "email_verified": bool(p.get("email")),
                "email_guesses": [],
                "phone":         None,
                "linkedin_search": li_person_url(p["name"], co_short),
                "linkedin_name_only": li_name_only_url(p["name"]),
                "google_email_search": google_email_url(p["name"], domain) if domain else None,
                "source":        "website_only",
            }
            decision_makers.append(dm)

    # Final sort: Tier 1 first, then 2, then 3
    decision_makers.sort(key=lambda d: d.get("tier", 3))

    # ── 3b. Yell.com phone fallback ──────────────────────────────────
    # Only if we still have no phone after scraping all company pages
    if not lead.get("contact_phone") and co_clean:
        yell_phone = yell_phone_lookup(co_clean)
        if yell_phone:
            lead["contact_phone"] = yell_phone
            lead["phone_source"]  = "yell_lookup"
            log.debug("Yell phone for %s: %s", co_clean, yell_phone)

    # ── 4. Compute route grade + confidence ──────────────────────────
    lead["decision_makers"]      = decision_makers
    lead["route_grade"]          = compute_route_grade(lead, decision_makers)
    lead["contact_confidence"]   = compute_contact_confidence(lead, decision_makers)
    lead["company_linkedin"]     = li_company_url(co_clean)
    lead["company_name_clean"]   = co_clean

    # Back-fill top-level fields from best director
    if decision_makers:
        best = decision_makers[0]
        if not lead.get("director_name") and best.get("name"):
            lead["director_name"] = best["name"]
            lead["director_role"] = best["role"]
        if best.get("email") and not lead.get("contact_email"):
            lead["contact_email"] = best["email"]

    return lead


# ── Name-matching helpers ─────────────────────────────────────────────────────
def _match_person(np: dict, people: list[dict]) -> dict | None:
    fname = np["first_name"].lower()
    lname = np["last_name"].lower()
    for p in people:
        parts = p["name"].lower().split()
        if fname in parts and lname in parts:
            return p
        if fname and lname and (fname in p["name"].lower() or lname in p["name"].lower()):
            return p
    return None


def _match_email_by_name(first: str, last: str, emails: list[str]) -> str | None:
    f = re.sub(r"[^a-z]", "", first.lower()) if first else ""
    l = re.sub(r"[^a-z]", "", last.lower()) if last else ""
    for e in emails:
        local = e.split("@")[0].lower()
        if f and l and (f in local and l in local[:len(local)]):
            return e
        if f and len(f) >= 3 and local.startswith(f):
            return e
    return None


def _name_similarity(a: str, b: str) -> bool:
    a_parts = set(a.lower().split())
    b_parts = set(b.lower().split())
    return bool(a_parts & b_parts) and (a_parts & b_parts) != {""}


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    log.info("=== Decision Maker Enrichment v2 ===")
    if FORCE_REFRESH:
        log.info("  --force: re-enriching all leads")

    with open(DATA_FILE) as f:
        data = json.load(f)

    is_dict = isinstance(data, dict)
    leads   = list(data.values()) if is_dict else data
    keys    = list(data.keys())   if is_dict else None

    to_process = []
    for i, lead in enumerate(leads):
        if not FORCE_REFRESH and lead.get("decision_makers") and lead.get("route_grade"):
            continue
        if not lead.get("company_number") and not lead.get("director_name"):
            # Still compute grade for leads with existing contact data
            lead["route_grade"]        = compute_route_grade(lead, [])
            lead["contact_confidence"] = compute_contact_confidence(lead, [])
            continue
        to_process.append(i)

    has_ch = sum(1 for i in to_process if leads[i].get("company_number"))
    log.info(
        "To enrich: %d leads  |  %d with CH#  |  Skipping %d",
        len(to_process), has_ch, len(leads) - len(to_process),
    )

    enriched = multi_dm = verified_any = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(enrich_lead, leads[i]): i for i in to_process}
        done = 0
        for future in as_completed(futures):
            idx = futures[future]
            done += 1
            try:
                updated    = future.result()
                leads[idx] = updated
                dms        = updated.get("decision_makers", [])
                grade      = updated.get("route_grade", "?")
                conf       = updated.get("contact_confidence", 0)
                enriched  += 1
                if len(dms) > 1:
                    multi_dm += 1
                v_emails = [d for d in dms if d.get("email_verified") and d.get("email")]
                if v_emails:
                    verified_any += 1
                    log.info(
                        "[%d/%d] ✓ %-38s  Grade %s  %d%%  %d DMs  ✉ %s",
                        done, len(to_process),
                        updated.get("company_name", "?")[:38],
                        grade, conf, len(dms), v_emails[0]["email"],
                    )
                else:
                    log.info(
                        "[%d/%d]   %-38s  Grade %s  %d%%  %d DMs",
                        done, len(to_process),
                        updated.get("company_name", "?")[:38],
                        grade, conf, len(dms),
                    )
            except Exception as e:
                log.warning(
                    "[%d/%d] Error: %s — %s",
                    done, len(to_process), leads[idx].get("company_name", "?"), e,
                )

            if done % CHECKPOINT_EVERY == 0:
                _save(data, leads, keys, is_dict)
                log.info("  ── checkpoint %d/%d ──", done, len(to_process))

    _save(data, leads, keys, is_dict)

    # Copy to public dirs
    import shutil
    for dst in [
        ROOT / "public" / "data" / "leads.json",
        ROOT / "apps" / "web" / "public" / "data" / "leads.json",
    ]:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DATA_FILE, dst)

    # Summary
    grades = {}
    for l in leads:
        g = l.get("route_grade", "?")
        grades[g] = grades.get(g, 0) + 1

    # Phone source summary
    phone_sources: dict[str, int] = {}
    yell_hits = 0
    for l in leads:
        src = l.get("phone_source", "")
        if src:
            phone_sources[src] = phone_sources.get(src, 0) + 1
        if src == "yell_lookup":
            yell_hits += 1
    has_phone = sum(1 for l in leads if l.get("contact_phone"))

    log.info(
        "=== Done — %d enriched | %d multi-director | %d with verified email ===",
        enriched, multi_dm, verified_any,
    )
    log.info(
        "Route grades: %s",
        "  ".join(f"{g}={n}" for g, n in sorted(grades.items())),
    )
    log.info(
        "Phone coverage: %d/%d (%.0f%%)  |  Sources: %s",
        has_phone, len(leads), 100 * has_phone / max(len(leads), 1),
        "  ".join(f"{k}={v}" for k, v in sorted(phone_sources.items())),
    )


def _save(data, leads, keys, is_dict):
    out = {keys[i]: leads[i] for i in range(len(leads))} if is_dict else leads
    with open(DATA_FILE, "w") as f:
        json.dump(out, f, indent=2)


if __name__ == "__main__":
    main()
