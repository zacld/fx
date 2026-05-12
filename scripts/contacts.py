"""
contacts.py — pull contact routes out of a company's own website HTML.

No API calls. Given the raw HTML already fetched during website validation,
extract: phone numbers, on-page emails, and links to the contact / about / team
pages. best_contact_route(lead) then turns the lead's combined fields (these +
the Companies-House director + the guessed generic emails) into a one-line
"how to get in front of a decision-maker" suggestion.

Brain 3 responsibility per CLAUDE.md ("Extracts phone, email, contact page";
"Gate 5 — Contact route"). Parses a *fresh* soup from the raw HTML rather than
the cleaned text soup used for signal extraction, so header/footer (where the
phone + contact link usually live) aren't stripped.
"""

import re
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

# Role-prefix priorities (lower index = better for an FX conversation)
_FINANCE_PREFIXES = ("accounts", "finance", "ap", "ar", "payments", "treasury", "purchasing", "procurement")
_GENERIC_PREFIXES = ("info", "enquiries", "enquiry", "hello", "contact", "office", "admin", "sales", "mail", "team")
_JUNK_EMAIL_HOSTS = ("sentry.io", "wixpress.com", "example.com", "domain.com", "email.com",
                     "yourdomain.com", "sentry-next.wixpress.com")

_PAGE_KEYWORDS = {
    "contact_page": ("contact", "contact-us", "contactus", "get-in-touch"),
    "about_page":   ("about", "about-us", "aboutus", "who-we-are", "our-story", "our-company", "the-company"),
    "team_page":    ("team", "our-team", "meet-the-team", "people", "our-people", "management",
                     "leadership", "directors", "staff", "key-people"),
}

# UK-ish phone numbers in free text: optional +44 / leading 0, then 9-13 more digits
# allowing spaces / brackets / hyphens. Conservative to avoid grabbing dates / IDs.
_PHONE_RE = re.compile(
    r"(?<![\d/])(?:\+44\s?\(?0?\)?\s?|\(?0)\s?\d{1,5}[)\s.-]?\s?\d{2,4}[\s.-]?\d{3,4}(?![\d/])"
)
_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")


def _norm_phone(raw):
    digits = re.sub(r"[^\d+]", "", raw or "")
    digits = re.sub(r"^\+440", "+44", digits)
    digits = re.sub(r"^00", "+", digits)
    n = re.sub(r"\D", "", digits)
    if not (9 <= len(n) <= 13):
        return None
    return re.sub(r"\s+", " ", (raw or "").strip())


def _registrable(netloc):
    netloc = (netloc or "").lower().split(":")[0]
    return re.sub(r"^www\d*\.", "", netloc)


def _same_site(url, base_domain):
    try:
        host = urlparse(url).netloc
        return _registrable(host) == base_domain or not host
    except Exception:
        return False


def _email_rank(email):
    local = email.split("@", 1)[0].lower()
    if local in _FINANCE_PREFIXES:                          return 0
    if any(local.startswith(p) for p in _FINANCE_PREFIXES): return 1
    if local in _GENERIC_PREFIXES:                          return 2
    if any(local.startswith(p) for p in _GENERIC_PREFIXES): return 3
    return 4


def extract_contact_info(html, base_url, company_domain=None):
    """
    html          : raw HTML string of the homepage
    base_url      : the (final) URL the HTML came from — used to resolve relative links
    company_domain: bare domain (e.g. "acmewine.co.uk"); if omitted, derived from base_url.
                    Only on-page emails / page links on this domain are kept.
    Returns a dict of contact fields (all keys always present).
    """
    out = {
        "contact_phone": None, "contact_phones": [],
        "contact_email": None, "contact_emails_found": [],
        "contact_page": None, "about_page": None, "team_page": None,
    }
    if not html:
        return out

    try:
        base_domain = _registrable(company_domain) if company_domain else _registrable(urlparse(base_url).netloc)
    except Exception:
        base_domain = ""

    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return out

    phones, emails = [], []

    for a in soup.select('a[href^="tel:"]'):
        p = _norm_phone(a.get("href", "")[4:])
        if p:
            phones.append(p)
    for a in soup.select('a[href^="mailto:"]'):
        e = a.get("href", "")[7:].split("?")[0].strip().lower()
        if "@" in e:
            emails.append(e)

    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        absu = urljoin(base_url, href)
        if base_domain and not _same_site(absu, base_domain):
            continue
        hay = (urlparse(absu).path + " " + (a.get_text(" ", strip=True) or "")).lower()
        for field, kws in _PAGE_KEYWORDS.items():
            if out[field]:
                continue
            if any(re.search(rf"(^|[/\s\-_]){re.escape(k)}([/\s\-_]|$)", hay) for k in kws):
                out[field] = absu

    # free-text scan (catches phones/emails not wrapped in links)
    text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
    for m in _PHONE_RE.findall(text):
        p = _norm_phone(m)
        if p:
            phones.append(p)
    for m in _EMAIL_RE.findall(text):
        emails.append(m.strip().lower())

    seen_e, clean_e = set(), []
    for e in emails:
        if e in seen_e or "@" not in e:
            continue
        host = e.split("@", 1)[1]
        if any(host.endswith(j) for j in _JUNK_EMAIL_HOSTS):
            continue
        if base_domain and not (host == base_domain or host.endswith("." + base_domain)):
            continue
        seen_e.add(e)
        clean_e.append(e)
    clean_e.sort(key=_email_rank)

    seen_p, clean_p = set(), []
    for p in phones:
        key = re.sub(r"\D", "", p)
        if not key or key in seen_p:
            continue
        seen_p.add(key)
        clean_p.append(p)

    out["contact_phones"]       = clean_p[:3]
    out["contact_phone"]        = clean_p[0] if clean_p else None
    out["contact_emails_found"] = clean_e[:4]
    out["contact_email"]        = clean_e[0] if clean_e else None
    return out


# ── ROUTE SUGGESTION ─────────────────────────────────────────────────────────────

CONTACT_FIELDS = ("contact_phone", "contact_phones", "contact_email",
                  "contact_emails_found", "contact_page", "about_page", "team_page")


def has_contact_route(lead):
    return bool(
        lead.get("contact_phone") or lead.get("contact_email") or lead.get("contact_emails_found")
        or lead.get("contact_page") or lead.get("director_name") or lead.get("guessed_emails")
        or lead.get("website")
    )


def best_contact_route(lead):
    phone        = lead.get("contact_phone")
    emails_found = lead.get("contact_emails_found") or ([lead["contact_email"]] if lead.get("contact_email") else [])
    contact_page = lead.get("contact_page")
    director     = lead.get("director_name")
    role         = lead.get("director_role")
    generic      = [e.get("email") for e in (lead.get("generic_emails") or lead.get("guessed_emails") or []) if isinstance(e, dict) and e.get("email")]
    website      = lead.get("website")

    fin = next((e for e in emails_found if "@" in e and e.split("@", 1)[0].lower() in _FINANCE_PREFIXES), None)
    if fin:
        return (f"Email {fin} directly (accounts/finance) — say you'd like a quick word with whoever "
                f"handles supplier payments / currency.")
    if phone:
        who = "the Finance Director / MD" if not director else (f"{director}" + (f" ({role})" if role else ""))
        return f"Call the switchboard on {phone} — ask for {who}."
    real_generic = next((e for e in emails_found if "@" in e and e.split("@", 1)[0].lower() in _GENERIC_PREFIXES), None)
    if real_generic:
        return f"Email {real_generic} — ask to be put through to whoever handles supplier payments / FX."
    if contact_page:
        who = "the Finance Director / MD" if not director else (f"{director}" + (f" ({role})" if role else ""))
        return f"Use the contact page ({contact_page}) — ask for {who}."
    if director:
        return (f"Look up {director}" + (f" ({role})" if role else "") +
                " on LinkedIn (or use the Companies-House director route), then call the switchboard.")
    if generic:
        return f"Find the switchboard number from the website; failing that, try {generic[0]}."
    if website:
        return f"Pull the phone number / contact page from {website}."
    return "No contact route yet — needs manual research (try Companies House for a director, then the website)."
