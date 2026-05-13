"""
enrich_decision_makers.py — Build a full decision-makers array for every lead.

For each lead with a Companies House number:
  1. Pull ALL current officers from CH API (/company/{n}/officers)
  2. Parse names, roles, tenures
  3. Generate email patterns per person (firstname@, f.lastname@, etc.)
  4. SMTP-verify patterns against the company's mail server
  5. Generate targeted LinkedIn + Google search URLs per person
  6. Scrape website team/about page to match named contacts to directors
  7. Write decision_makers[] array to lead

Run: python3.11 scripts/enrich_decision_makers.py
Idempotent — re-running updates/extends existing decision_makers data.
"""

import json, re, time, smtplib, socket, logging, os, random, requests
from pathlib import Path
from urllib.parse import urljoin, urlparse, quote_plus
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import dns.resolver
    HAS_DNS = True
except ImportError:
    HAS_DNS = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s")
log = logging.getLogger(__name__)

ROOT      = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "leads.json"

# ── Config ────────────────────────────────────────────────────────────────────
CH_API_KEY        = os.getenv("COMPANIES_HOUSE_API_KEY", "bf190544-f3dd-4dd3-b60b-d897c8ffebf8")
CH_BASE           = "https://api.company-information.service.gov.uk"
CH_TIMEOUT        = (3, 8)
CH_DELAY          = 0.35          # seconds between CH calls (stay under 600/5min)
WEB_TIMEOUT       = (4, 10)
SMTP_TIMEOUT      = 2
WORKERS           = 6
CHECKPOINT_EVERY  = 30
MAX_OFFICERS      = 6             # cap per company (ignore mass-director shells)
SMTP_PER_PERSON   = 3             # max email patterns to SMTP-verify per director
FORCE_REFRESH     = False         # set True to re-pull even if decision_makers exists

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
}
SESSION = requests.Session()
SESSION.headers.update(HEADERS)

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(
    r"(?<![/\d])(?:\+44\s?\(?0?\)?\s?|\(?0)\s?\d{1,5}[)\s.\-]?\s?\d{2,4}[\s.\-]?\d{3,4}(?![/\d])"
)
JUNK_HOSTS = {"sentry.io","wixpress.com","example.com","domain.com","yourdomain.com","email.com"}

PRIORITY_ROLES = ["managing director", "md", "chief executive", "ceo",
                   "finance director", "fd", "chief financial officer", "cfo",
                   "commercial director", "director", "secretary"]


# ── Name parsing ──────────────────────────────────────────────────────────────
def parse_ch_name(raw: str) -> dict:
    """
    CH returns names as "SMITH, James David" or "JONES, Sarah".
    Returns: {full_name, first_name, last_name, initials}
    """
    raw = raw.strip()
    if "," in raw:
        last, rest = raw.split(",", 1)
        last  = last.strip().title()
        parts = rest.strip().split()
        first = parts[0].capitalize() if parts else ""
        middle = " ".join(p.capitalize() for p in parts[1:]) if len(parts) > 1 else ""
    else:
        parts = raw.split()
        last  = parts[-1].title() if parts else ""
        first = parts[0].capitalize() if len(parts) > 1 else ""
        middle = ""

    full = f"{first} {last}".strip() if first else last
    initials = "".join(p[0].upper() for p in full.split() if p)
    return {"full_name": full, "first_name": first, "last_name": last,
            "initials": initials, "middle": middle}


def role_priority(role: str) -> int:
    role = role.lower().replace("-", " ").replace("_", " ")
    for i, r in enumerate(PRIORITY_ROLES):
        if r in role:
            return i
    return 99


# ── Companies House ───────────────────────────────────────────────────────────
def ch_officers(company_number: str) -> list[dict]:
    """Fetch all ACTIVE officers for a company."""
    url = f"{CH_BASE}/company/{company_number}/officers"
    try:
        r = requests.get(url, auth=(CH_API_KEY, ""), timeout=CH_TIMEOUT,
                         params={"items_per_page": 50})
        if not r.ok:
            return []
        data = r.json()
        items = data.get("items", [])
        # Filter out resigned officers
        active = [o for o in items if not o.get("resigned_on")]
        # Sort by role priority (MD/FD first)
        active.sort(key=lambda o: role_priority(o.get("officer_role", "")))
        return active[:MAX_OFFICERS]
    except Exception as e:
        log.debug("CH officers error for %s: %s", company_number, e)
        return []


# ── Email pattern generation ──────────────────────────────────────────────────
def email_patterns(first: str, last: str, domain: str) -> list[str]:
    """Generate likely email patterns for a person."""
    f = re.sub(r"[^a-z]", "", first.lower())
    l = re.sub(r"[^a-z]", "", last.lower())
    if not f or not l or not domain:
        return []
    patterns = [
        f"{f}@{domain}",
        f"{f}.{l}@{domain}",
        f"{f[0]}.{l}@{domain}",
        f"{f[0]}{l}@{domain}",
        f"{f}{l[0]}@{domain}",
        f"{f}_{l}@{domain}",
    ]
    # Dedupe preserving order
    seen = set()
    out = []
    for p in patterns:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


# ── SMTP verification ─────────────────────────────────────────────────────────
_mx_cache: dict[str, list[str]] = {}

def get_mx(domain: str) -> list[str]:
    if domain in _mx_cache:
        return _mx_cache[domain]
    if not HAS_DNS:
        _mx_cache[domain] = []
        return []
    try:
        records = dns.resolver.resolve(domain, "MX", lifetime=4)
        hosts = [str(r.exchange).rstrip(".") for r in sorted(records, key=lambda r: r.preference)]
        _mx_cache[domain] = hosts
        return hosts
    except Exception:
        _mx_cache[domain] = []
        return []


def is_catch_all(domain: str, mx: list[str]) -> bool:
    probe = f"zzz_probe_{random.randint(10000,99999)}@{domain}"
    return smtp_verify(probe, mx) is True


def smtp_verify(email: str, mx: list[str]) -> bool | None:
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
                if code == 250:  return True
                if code in (550,551,552,553): return False
                return None
        except Exception:
            continue
    return None


def verify_patterns(patterns: list[str], domain: str) -> list[dict]:
    """Verify email patterns via SMTP. Returns list with smtp_verified field."""
    mx = get_mx(domain)
    if not mx:
        return [{"email": p, "smtp_verified": None} for p in patterns]

    catch_all = is_catch_all(domain, mx)
    results = []
    for p in patterns[:SMTP_PER_PERSON]:
        v = None if catch_all else smtp_verify(p, mx)
        results.append({"email": p, "smtp_verified": v, "catch_all": catch_all})
        time.sleep(0.2)
    return results


# ── Website team page extraction ──────────────────────────────────────────────
def fetch(url: str) -> str:
    try:
        r = SESSION.get(url, timeout=WEB_TIMEOUT, allow_redirects=True)
        if r.ok and "text/html" in r.headers.get("content-type",""):
            return r.text
    except Exception:
        pass
    return ""


def domain_of(url: str) -> str:
    try:
        h = urlparse(url).hostname or ""
        return re.sub(r"^www\d*\.", "", h.lower())
    except Exception:
        return ""


def extract_team_contacts(html: str, base_url: str, domain: str) -> list[dict]:
    """
    Parse team/about page for named contacts with emails/phones.
    Returns list of {name, email, phone, context}.
    """
    contacts = []
    if not html:
        return contacts

    # Find all mailto: links with surrounding text context
    for m in re.finditer(
        r'(.{0,120})<a[^>]+href=["\']mailto:([^"\'?]+)["\'][^>]*>([^<]*)</a>(.{0,120})',
        html, re.IGNORECASE | re.DOTALL
    ):
        before, email, link_text, after = m.group(1), m.group(2), m.group(3), m.group(4)
        email = email.strip().lower()
        host  = email.split("@")[-1] if "@" in email else ""
        if not host or any(host.endswith(j) for j in JUNK_HOSTS):
            continue
        if domain and not (host == domain or host.endswith("."+domain)):
            continue
        context = re.sub(r"<[^>]+>", " ", before + link_text + after).strip()
        context = re.sub(r"\s+", " ", context)[:200]
        contacts.append({"email": email, "context": context})

    return contacts


def find_team_page(website: str, known_team_url: str | None) -> str:
    """Find the team/about page URL."""
    if known_team_url:
        return known_team_url
    base = website.rstrip("/")
    for slug in ["team", "our-team", "about", "about-us", "people",
                 "management", "leadership", "directors", "meet-the-team"]:
        url = f"{base}/{slug}"
        try:
            r = SESSION.head(url, timeout=(3,6), allow_redirects=True)
            if r.ok:
                return url
        except Exception:
            pass
    return ""


def match_director_to_contact(director: dict, contacts: list[dict]) -> str | None:
    """Try to find a team-page email that belongs to this director."""
    fname = director.get("first_name","").lower()
    lname = director.get("last_name","").lower()
    for c in contacts:
        email_local = c["email"].split("@")[0].lower()
        ctx = c.get("context","").lower()
        # Email pattern match
        if fname and lname:
            if fname in email_local or lname in email_local:
                return c["email"]
        # Context name match
        if fname and lname:
            if fname in ctx and lname in ctx:
                return c["email"]
    return None


# ── LinkedIn / Google search URLs ─────────────────────────────────────────────
def linkedin_url(full_name: str, company_name: str) -> str:
    co_short = " ".join(company_name.split()[:3])
    return (f"https://www.google.com/search?q=site:linkedin.com/in+"
            f"{quote_plus(chr(34)+full_name+chr(34))}+"
            f"{quote_plus(chr(34)+co_short+chr(34))}")


def linkedin_name_only(full_name: str) -> str:
    return (f"https://www.google.com/search?q=site:linkedin.com/in+"
            f"{quote_plus(chr(34)+full_name+chr(34))}")


def google_email_search(full_name: str, domain: str) -> str:
    return (f"https://www.google.com/search?q="
            f"{quote_plus(chr(34)+full_name+chr(34))}+"
            f"{quote_plus(chr(34)+'@'+domain+chr(34))}")


# ── Core enrichment per lead ──────────────────────────────────────────────────
def enrich_lead(lead: dict) -> dict:
    ch_num  = lead.get("company_number","")
    website = lead.get("website","")
    co_name = lead.get("company_name","")
    domain  = domain_of(website)

    # Fetch all CH officers
    officers = ch_officers(ch_num) if ch_num else []
    time.sleep(CH_DELAY)

    if not officers:
        # Fall back to single director already on lead
        dn = lead.get("director_name","")
        dr = lead.get("director_role","director")
        if dn:
            parsed = {"full_name": dn, "first_name": dn.split()[0] if dn else "",
                      "last_name": dn.split()[-1] if dn else "", "initials":"", "middle":""}
            officers_parsed = [{"name_parsed": parsed, "officer_role": dr,
                                 "appointed_on": None, "raw": dn}]
        else:
            officers_parsed = []
    else:
        officers_parsed = []
        for o in officers:
            parsed = parse_ch_name(o.get("name",""))
            officers_parsed.append({
                "name_parsed": parsed,
                "officer_role": o.get("officer_role","director"),
                "appointed_on": o.get("appointed_on"),
                "raw": o.get("name",""),
            })

    if not officers_parsed:
        return lead

    # Scrape team page once (shared across all directors)
    team_url  = find_team_page(website, lead.get("team_page"))
    team_html = fetch(team_url) if team_url else ""
    team_contacts = extract_team_contacts(team_html, team_url or website, domain) if team_html else []

    # Also check about page
    about_url  = lead.get("about_page","")
    if about_url and not team_contacts:
        about_html = fetch(about_url)
        team_contacts = extract_team_contacts(about_html, about_url, domain)

    # Build decision_makers list
    decision_makers = []
    for o in officers_parsed:
        np      = o["name_parsed"]
        fname   = np["first_name"]
        lname   = np["last_name"]
        full    = np["full_name"]
        role    = o["officer_role"]

        dm: dict = {
            "name":          full,
            "first_name":    fname,
            "last_name":     lname,
            "role":          role,
            "appointed_on":  o.get("appointed_on"),
            "email":         None,
            "email_source":  None,
            "email_verified": None,
            "email_guesses": [],
            "phone":         None,
            "linkedin_search":      linkedin_url(full, co_name),
            "linkedin_name_only":   linkedin_name_only(full),
            "google_email_search":  google_email_search(full, domain) if domain else None,
        }

        # 1. Try to find email on team page
        team_email = match_director_to_contact(np, team_contacts)
        if team_email:
            dm["email"]        = team_email
            dm["email_source"] = "website_team_page"
            dm["email_verified"] = True   # it's a real published email

        # 2. Generate + SMTP-verify patterns
        if domain:
            patterns = email_patterns(fname, lname, domain)
            if patterns:
                verified = verify_patterns(patterns, domain)
                dm["email_guesses"] = verified
                # Use first SMTP-confirmed pattern if no team email
                if not dm["email"]:
                    best = next((v for v in verified if v.get("smtp_verified") is True), None)
                    if best:
                        dm["email"]          = best["email"]
                        dm["email_source"]   = "smtp_verified"
                        dm["email_verified"] = True

        decision_makers.append(dm)

    lead["decision_makers"] = decision_makers

    # Back-fill top-level fields from best decision maker
    if decision_makers:
        best_dm = decision_makers[0]  # already sorted by role priority
        if not lead.get("director_name") and best_dm.get("name"):
            lead["director_name"] = best_dm["name"]
            lead["director_role"] = best_dm["role"]
        # Promote verified email to contact_email if better than current
        if best_dm.get("email") and not lead.get("contact_email"):
            lead["contact_email"] = best_dm["email"]

    return lead


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    log.info("=== Decision Maker Enrichment ===")

    with open(DATA_FILE) as f:
        data = json.load(f)

    is_dict = isinstance(data, dict)
    leads   = list(data.values()) if is_dict else data
    keys    = list(data.keys())   if is_dict else None

    to_process = []
    for i, lead in enumerate(leads):
        if not FORCE_REFRESH and lead.get("decision_makers"):
            continue
        if not lead.get("company_number") and not lead.get("director_name"):
            continue
        to_process.append(i)

    has_ch = sum(1 for i in to_process if leads[i].get("company_number"))
    log.info("To process: %d leads  |  %d with CH number  |  Skipping %d (already done)",
             len(to_process), has_ch, len(leads) - len(to_process))

    enriched = gained_email = gained_multi = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(enrich_lead, leads[i]): i for i in to_process}
        done = 0
        for future in as_completed(futures):
            idx = futures[future]
            done += 1
            try:
                updated       = future.result()
                leads[idx]    = updated
                dms           = updated.get("decision_makers", [])
                enriched     += 1
                if len(dms) > 1:
                    gained_multi += 1
                verified_emails = [dm for dm in dms if dm.get("email_verified")]
                if verified_emails:
                    gained_email += 1
                    log.info("[%d/%d] ✓ %s — %d DMs, %d verified email(s): %s",
                             done, len(to_process),
                             updated.get("company_name","?")[:35],
                             len(dms), len(verified_emails),
                             ", ".join(dm["email"] for dm in verified_emails[:2]))
                else:
                    log.info("[%d/%d]   %s — %d DMs, no verified email",
                             done, len(to_process),
                             updated.get("company_name","?")[:35], len(dms))
            except Exception as e:
                log.warning("[%d/%d] Error: %s — %s",
                            done, len(to_process), leads[idx].get("company_name","?"), e)

            if done % CHECKPOINT_EVERY == 0:
                _save(data, leads, keys, is_dict)
                log.info("  ✓ Checkpoint saved (%d/%d)", done, len(to_process))

    _save(data, leads, keys, is_dict)

    import shutil
    for dst in [ROOT/"public"/"data"/"leads.json",
                ROOT/"apps"/"web"/"public"/"data"/"leads.json"]:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DATA_FILE, dst)

    log.info("=== Done — %d leads enriched | %d multi-director | %d with verified email ===",
             enriched, gained_multi, gained_email)


def _save(data, leads, keys, is_dict):
    out = {keys[i]: leads[i] for i in range(len(leads))} if is_dict else leads
    with open(DATA_FILE, "w") as f:
        json.dump(out, f, indent=2)


if __name__ == "__main__":
    main()
