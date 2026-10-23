"""
enrich_contacts.py — Improve email & phone coverage on existing leads.

Four-pass approach (no paid APIs):
  Pass 1 — Scrape contact/about/team pages for real mailto: emails + tel: phones
  Pass 2 — Google (DDG) site:domain search for indexed email addresses
  Pass 3 — MX lookup + SMTP RCPT TO verification of guessed patterns
  Pass 4 — Rank/dedupe all sources; write best contact route

Run: python3.11 scripts/enrich_contacts.py
Safe to re-run (idempotent). Skips leads that already have a verified email.
"""

import json, re, time, smtplib, socket, logging, os, random
from pathlib import Path
from urllib.parse import urljoin, urlparse, quote_plus
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import dns.resolver

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s")
log = logging.getLogger(__name__)

ROOT      = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "leads.json"

# ── Config ────────────────────────────────────────────────────────────────────
TIMEOUT          = (4, 10)
WORKERS          = 8           # parallel web workers
SMTP_TIMEOUT     = 2           # 2s is enough — live mailservers respond in <1s
CHECKPOINT_EVERY = 50
SKIP_ALREADY_VERIFIED = True   # skip leads that already have contact_email
SMTP_PRIORITY_ONLY    = True   # only SMTP-probe HOT/WARM leads (not all 446)
COMMON_PFX_LIMIT      = 3      # only probe info@, accounts@, sales@ — not all 8

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

EMAIL_RE  = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
PHONE_RE  = re.compile(
    r"(?<![/\d])(?:\+44\s?\(?0?\)?\s?|\(?0)\s?\d{1,5}[)\s.\-]?\s?\d{2,4}[\s.\-]?\d{3,4}(?![/\d])"
)

JUNK_HOSTS  = {"sentry.io","wixpress.com","example.com","domain.com","yourdomain.com",
               "email.com","sentry-next.wixpress.com","mailchimp.com","sendgrid.com"}
FINANCE_PFX = ["accounts","finance","ap","ar","payments","treasury","purchasing","procurement"]
GENERIC_PFX = ["info","enquiries","enquiry","hello","contact","office","admin","sales","mail","team"]
COMMON_PFX  = FINANCE_PFX + GENERIC_PFX   # try these via SMTP if no real email found

CONTACT_SLUGS = [
    "contact", "contact-us", "contactus", "get-in-touch", "reach-us",
    "about", "about-us", "aboutus", "who-we-are",
    "team", "our-team", "meet-the-team", "people", "management",
]


# ── Helpers ───────────────────────────────────────────────────────────────────
def domain_of(url: str) -> str:
    try:
        h = urlparse(url).hostname or ""
        return re.sub(r"^www\d*\.", "", h.lower())
    except Exception:
        return ""


def email_rank(email: str) -> int:
    local = email.split("@")[0].lower()
    if local in FINANCE_PFX:        return 0
    if any(local.startswith(p) for p in FINANCE_PFX): return 1
    if local in GENERIC_PFX:        return 2
    if any(local.startswith(p) for p in GENERIC_PFX): return 3
    return 4   # personal or unknown


def norm_phone(raw: str) -> str | None:
    digits = re.sub(r"[^\d+]", "", raw)
    digits = re.sub(r"^\+440", "+44", digits)
    n = re.sub(r"\D", "", digits)
    if not 9 <= len(n) <= 13:
        return None
    return raw.strip()


def clean_emails(emails: list[str], domain: str) -> list[str]:
    """Filter junk, restrict to company domain, dedupe, sort by rank."""
    seen, out = set(), []
    for e in emails:
        e = e.lower().strip()
        if e in seen:
            continue
        at = e.find("@")
        if at < 1 or at == len(e) - 1:
            continue
        host = e[at+1:]
        if any(host == j or host.endswith("."+j) for j in JUNK_HOSTS):
            continue
        if domain and not (host == domain or host.endswith("."+domain)):
            continue
        seen.add(e)
        out.append(e)
    out.sort(key=email_rank)
    return out


# ── Pass 1: Web scraping ──────────────────────────────────────────────────────
def fetch_text(url: str, timeout=TIMEOUT) -> str:
    try:
        r = SESSION.get(url, timeout=timeout, allow_redirects=True)
        if r.ok and "text/html" in r.headers.get("content-type",""):
            return r.text
    except Exception:
        pass
    return ""


def extract_from_html(html: str, base_url: str, domain: str) -> dict:
    """Pull emails, phones, and page links from raw HTML."""
    emails, phones = [], []

    # mailto: links
    for m in re.finditer(r'href=["\']mailto:([^"\'?]+)', html, re.IGNORECASE):
        e = m.group(1).strip().lower()
        if "@" in e:
            emails.append(e)

    # tel: links
    for m in re.finditer(r'href=["\']tel:([^"\']+)', html, re.IGNORECASE):
        p = norm_phone(m.group(1))
        if p:
            phones.append(p)

    # free-text email scan
    for m in EMAIL_RE.finditer(re.sub(r"<[^>]+>", " ", html)):
        emails.append(m.group(0))

    # free-text phone scan
    stripped = re.sub(r"<[^>]+>", " ", html)
    for m in PHONE_RE.finditer(stripped):
        p = norm_phone(m.group(0))
        if p:
            phones.append(p)

    # detect contact/about/team page URLs
    pages: dict[str, str | None] = {"contact_page": None, "about_page": None, "team_page": None}
    for m in re.finditer(r'href=["\']([^"\'#]+)["\']', html, re.IGNORECASE):
        href = m.group(1).strip()
        if not href or href.startswith(("mailto:", "tel:", "javascript:")):
            continue
        try:
            abs_url = urljoin(base_url, href)
        except Exception:
            continue
        if domain and domain_of(abs_url) != domain:
            continue
        path_part = (urlparse(abs_url).path + " " + href).lower()
        if not pages["contact_page"] and any(k in path_part for k in ["contact","get-in-touch","reach"]):
            pages["contact_page"] = abs_url
        if not pages["about_page"] and any(k in path_part for k in ["about","who-we-are","our-story","our-company"]):
            pages["about_page"] = abs_url
        if not pages["team_page"] and any(k in path_part for k in ["team","people","management","leadership","directors","staff"]):
            pages["team_page"] = abs_url

    return {
        "emails": clean_emails(emails, domain),
        "phones": list(dict.fromkeys(p for p in phones if p)),
        **pages,
    }


def scrape_lead_pages(lead: dict) -> dict:
    """
    Fetch homepage + contact/about/team pages.
    Returns merged email/phone/page data.
    """
    website = lead.get("website","")
    if not website:
        return {}

    domain = domain_of(website)
    all_emails: list[str] = []
    all_phones: list[str] = []
    pages: dict[str, str | None] = {"contact_page": None, "about_page": None, "team_page": None}

    # respect existing pages we already know
    for k in pages:
        if lead.get(k):
            pages[k] = lead[k]

    # --- homepage ---
    html = fetch_text(website)
    if html:
        r = extract_from_html(html, website, domain)
        all_emails.extend(r["emails"])
        all_phones.extend(r["phones"])
        for k in pages:
            if not pages[k] and r.get(k):
                pages[k] = r[k]

    # --- contact page (existing or discovered) ---
    contact_url = pages["contact_page"]
    if not contact_url:
        # try common slugs
        for slug in ["contact", "contact-us", "get-in-touch"]:
            for sep in ["/", "/en/"]:
                trial = urljoin(website.rstrip("/") + "/", sep.lstrip("/") + slug)
                h = fetch_text(trial)
                if h and "@" in h:
                    contact_url = trial
                    html2 = h
                    break
            if contact_url:
                break
        else:
            html2 = ""
    else:
        html2 = fetch_text(contact_url)

    if html2:
        r2 = extract_from_html(html2, contact_url or website, domain)
        all_emails.extend(r2["emails"])
        all_phones.extend(r2["phones"])
        for k in pages:
            if not pages[k] and r2.get(k):
                pages[k] = r2[k]

    # --- about/team pages if still no email ---
    if not all_emails:
        for page_key in ["about_page", "team_page"]:
            url = pages[page_key]
            if url:
                h = fetch_text(url)
                if h:
                    r3 = extract_from_html(h, url, domain)
                    all_emails.extend(r3["emails"])
                    all_phones.extend(r3["phones"])
                if all_emails:
                    break

    final_emails = clean_emails(all_emails, domain)
    final_phones = list(dict.fromkeys(p for p in all_phones if p))[:3]

    return {
        "contact_email":       final_emails[0] if final_emails else None,
        "contact_emails_found": final_emails[:4],
        "contact_phone":       final_phones[0] if final_phones else None,
        "contact_phones":      final_phones,
        "contact_page":        pages["contact_page"],
        "about_page":          pages["about_page"],
        "team_page":           pages["team_page"],
    }


# ── Pass 2: DDG site:domain search for published emails ───────────────────────
def ddg_site_emails(domain: str) -> list[str]:
    """DuckDuckGo search for any emails published on the domain."""
    try:
        q = f'"{domain}" "@{domain}"'
        url = f"https://html.duckduckgo.com/html/?q={quote_plus(q)}"
        r = SESSION.get(url, timeout=TIMEOUT)
        if not r.ok:
            return []
        emails = EMAIL_RE.findall(r.text)
        return clean_emails(emails, domain)[:4]
    except Exception:
        return []


# ── Pass 3: MX lookup + SMTP verification ────────────────────────────────────
_mx_cache: dict[str, list[str]] = {}

def get_mx(domain: str) -> list[str]:
    if domain in _mx_cache:
        return _mx_cache[domain]
    try:
        records = dns.resolver.resolve(domain, "MX", lifetime=5)
        mx = sorted(records, key=lambda r: r.preference)
        hosts = [str(r.exchange).rstrip(".") for r in mx]
        _mx_cache[domain] = hosts
        return hosts
    except Exception:
        _mx_cache[domain] = []
        return []


def smtp_verify(email: str, mx_hosts: list[str], sender="verify@example.com") -> bool | None:
    """
    Returns True if mailbox accepted, False if rejected, None if inconclusive
    (catch-all, greylisted, connection refused, etc).
    """
    if not mx_hosts:
        return None
    for mx in mx_hosts[:2]:
        try:
            with smtplib.SMTP(timeout=SMTP_TIMEOUT) as s:
                s.connect(mx, 25)
                s.ehlo_or_helo_if_needed()
                s.mail(sender)
                code, _ = s.rcpt(email)
                s.rset()
                if code == 250:
                    return True
                if code in (550, 551, 552, 553):
                    return False
                return None   # 451, 452, etc — inconclusive
        except (smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected,
                socket.timeout, OSError):
            continue
    return None


def verify_common_prefixes(domain: str) -> list[dict]:
    """
    Try info@, sales@, accounts@ etc via SMTP. Return verified ones first,
    then unverified generics as fallback.
    """
    mx = get_mx(domain)
    results: list[dict] = []
    for pfx in COMMON_PFX[:COMMON_PFX_LIMIT]:   # cap probes
        email = f"{pfx}@{domain}"
        verdict = smtp_verify(email, mx)
        results.append({"email": email, "smtp_verified": verdict})
        time.sleep(0.3)
    # sort: True first, None second, False last
    results.sort(key=lambda x: {True: 0, None: 1, False: 2}[x.get("smtp_verified")])
    return results


def verify_guessed_patterns(lead: dict) -> list[dict]:
    """SMTP-verify the top guessed patterns from the lead."""
    guessed = lead.get("guessed_emails") or []
    domain  = domain_of(lead.get("website",""))
    if not domain or not guessed:
        return []
    mx = get_mx(domain)
    if not mx:
        return guessed   # can't verify — return as-is

    # detect catch-all: test a random address
    probe = f"xrandomprobe{random.randint(10000,99999)}@{domain}"
    if smtp_verify(probe, mx) is True:
        # catch-all — verification useless, return guessed unmodified
        return guessed

    results = []
    for g in guessed[:6]:
        email = g.get("email","")
        if not email:
            continue
        verdict = smtp_verify(email, mx)
        results.append({**g, "smtp_verified": verdict})
        time.sleep(0.3)
    results.sort(key=lambda x: {True: 0, None: 1, False: 2}[x.get("smtp_verified")])
    return results


# ── Contact route builder ─────────────────────────────────────────────────────
def build_contact_route(lead: dict) -> str:
    phone   = lead.get("contact_phone")
    emails  = lead.get("contact_emails_found") or []
    cp      = lead.get("contact_page")
    dir_n   = lead.get("director_name","")
    dir_r   = lead.get("director_role","")
    guessed = lead.get("guessed_emails") or []
    website = lead.get("website","")

    fin = next((e for e in emails if e.split("@")[0].lower() in FINANCE_PFX), None)
    if fin:
        return f"Email {fin} directly (accounts/finance) — ask to speak with whoever handles foreign supplier payments."
    if phone:
        who = f"{dir_n}{' (' + dir_r + ')' if dir_r else ''}" if dir_n else "the Finance Director / MD"
        return f"Call the switchboard on {phone} — ask for {who}."
    gen = next((e for e in emails if e.split("@")[0].lower() in GENERIC_PFX), None)
    if gen:
        return f"Email {gen} — ask to be put through to whoever handles supplier payments / FX."
    if cp:
        who = dir_n or "the Finance Director / MD"
        return f"Use the contact page ({cp}) — ask for {who}."
    if dir_n:
        return f"Look up {dir_n}{' (' + dir_r + ')' if dir_r else ''} on LinkedIn, then call the switchboard."
    best_guessed = next((g.get("email") for g in guessed if g.get("smtp_verified") is True), None)
    if best_guessed:
        return f"Try {best_guessed} (SMTP-verified pattern)."
    if guessed:
        return f"Try {guessed[0].get('email','')} (unverified pattern — check manually)."
    if website:
        return f"Pull the phone / contact page from {website}."
    return "No contact route yet — needs manual research."


# ── Main enrichment loop ──────────────────────────────────────────────────────
def enrich_lead(lead: dict) -> dict:
    """Run all four passes on a single lead. Returns updated lead dict."""
    website = lead.get("website","")
    domain  = domain_of(website)
    already = lead.get("contact_email")

    # Pass 1 — scrape pages
    scraped = scrape_lead_pages(lead)
    lead.update({k: v for k, v in scraped.items() if v})  # don't overwrite with None

    # Pass 2 — DDG site: search (only if still no email)
    if not lead.get("contact_email") and domain:
        ddg_emails = ddg_site_emails(domain)
        if ddg_emails:
            existing = lead.get("contact_emails_found") or []
            merged   = clean_emails(existing + ddg_emails, domain)
            lead["contact_emails_found"] = merged[:4]
            lead["contact_email"]        = merged[0] if merged else None
            if merged:
                log.info("    DDG found: %s", merged[0])

    # Pass 3 — SMTP verify guessed patterns (only for allowed leads)
    smtp_allowed = lead.pop("_smtp_allowed", True)
    if domain and smtp_allowed:
        updated_guessed = verify_guessed_patterns(lead)
        if updated_guessed:
            lead["guessed_emails"] = updated_guessed
            # if top guess is SMTP-verified and we still have no real email
            best = next((g.get("email") for g in updated_guessed if g.get("smtp_verified") is True), None)
            if best and not lead.get("contact_email"):
                lead["contact_email"] = best
                lead["contact_emails_found"] = [best] + (lead.get("contact_emails_found") or [])
                lead["contact_emails_found"] = list(dict.fromkeys(lead["contact_emails_found"]))[:4]
                log.info("    SMTP verified: %s", best)

        # If still no real email, try common prefixes (capped by COMMON_PFX_LIMIT)
        if not lead.get("contact_email"):
            common = verify_common_prefixes(domain)
            confirmed = [c for c in common if c.get("smtp_verified") is True]
            if confirmed:
                lead["contact_email"]        = confirmed[0]["email"]
                existing = lead.get("contact_emails_found") or []
                lead["contact_emails_found"] = list(dict.fromkeys([confirmed[0]["email"]] + existing))[:4]
                log.info("    Common prefix verified: %s", confirmed[0]["email"])

    # Pass 4 — rebuild contact route
    lead["best_contact_route"] = build_contact_route(lead)

    return lead


def main():
    log.info("=== Contact Enrichment — %s ===", DATA_FILE.name)

    with open(DATA_FILE) as f:
        data = json.load(f)

    is_dict = isinstance(data, dict)
    leads   = list(data.values()) if is_dict else data
    keys    = list(data.keys())    if is_dict else None

    # Prioritise leads without email, skip already-verified if flag set
    hot_warm_ids = {i for i, l in enumerate(leads) if l.get("priority") in ("HOT","WARM")}
    to_process = []
    to_skip    = []
    for i, lead in enumerate(leads):
        if SKIP_ALREADY_VERIFIED and lead.get("contact_email"):
            to_skip.append(i)
        elif not lead.get("website"):
            to_skip.append(i)
        else:
            # Tag whether SMTP is allowed for this lead
            lead["_smtp_allowed"] = (not SMTP_PRIORITY_ONLY) or (i in hot_warm_ids)
            to_process.append(i)

    log.info("Leads to enrich: %d  |  Already have email (skip): %d  |  No website (skip): %d",
             len(to_process), len([i for i in to_skip if leads[i].get("contact_email")]),
             len([i for i in to_skip if not leads[i].get("website")]))

    enriched = improved = 0

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(enrich_lead, leads[i]): i for i in to_process}
        done = 0
        for future in as_completed(futures):
            idx = futures[future]
            done += 1
            try:
                updated = future.result()
                was_blank = not leads[idx].get("contact_email")
                leads[idx] = updated
                enriched += 1
                if was_blank and updated.get("contact_email"):
                    improved += 1
                    log.info("[%d/%d] ✓ %s → %s",
                             done, len(to_process),
                             updated.get("company_name","?")[:35],
                             updated.get("contact_email",""))
                else:
                    log.info("[%d/%d]   %s — no new email",
                             done, len(to_process),
                             updated.get("company_name","?")[:35])
            except Exception as e:
                log.warning("[%d/%d] Error on %s: %s", done, len(to_process),
                            leads[idx].get("company_name","?"), e)

            if done % CHECKPOINT_EVERY == 0:
                _save(data, leads, keys, is_dict, DATA_FILE)
                log.info("  ✓ Checkpoint saved (%d/%d)", done, len(to_process))

    _save(data, leads, keys, is_dict, DATA_FILE)

    # copy to public
    import shutil
    for dst in [ROOT/"public"/"data"/"leads.json", ROOT/"apps"/"web"/"public"/"data"/"leads.json"]:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DATA_FILE, dst)

    log.info("=== Done — enriched %d leads, %d gained a new email ===", enriched, improved)


def _save(data, leads, keys, is_dict, path):
    if is_dict:
        out = {keys[i]: leads[i] for i in range(len(leads))}
    else:
        out = leads
    with open(path, "w") as f:
        json.dump(out, f, indent=2)


if __name__ == "__main__":
    main()
