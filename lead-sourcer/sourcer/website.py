"""
sourcer/website.py — the company's own website, read only when the public
register and filed accounts haven't named a finance person.

  1. Find the site: guess domains from the company name (acmewines.co.uk,
     acme-wines.com, ...) and accept one only if the page shows the
     company's registration number (UK companies must publish it on their
     website) or its full registered name.
  2. Read at most 4 pages: the homepage plus up to 3 team / leadership /
     about / contact pages linked from it. robots.txt is respected.
  3. Keep names next to a finance title (Finance Director, CFO, Financial
     Controller, Treasurer, ...) and generic company emails (info@,
     accounts@, finance@ ...). Never personal emails, phone numbers, or
     anything from LinkedIn or social sites.
"""

from __future__ import annotations

import html as htmllib
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Iterable, Optional

from sourcer import matching, people

USER_AGENT = "fx-lead-sourcer/1.0 (+https://github.com/zacld/fx)"
TIMEOUT_SECONDS = 6
MAX_BYTES = 1_500_000
MAX_PAGES = 4
MAX_DOMAIN_GUESSES = 6
WORKERS = int(os.environ.get("WEBSITE_WORKERS", "12"))  # sites looked up at once (each is a different host)
PAUSE_SECONDS = 0.3

_DROP_WORDS = {"GROUP", "HOLDINGS", "HOLDING", "INTERNATIONAL", "SERVICES", "TRADING", "AND"}
_PAGE_WORDS = (("team", 3), ("leadership", 3), ("management", 3), ("board", 3), ("directors", 3),
               ("people", 2), ("who-we-are", 2), ("who we are", 2), ("about", 1), ("contact", 1))
_SOCIAL = ("linkedin.", "facebook.", "twitter.", "x.com", "instagram.", "youtube.", "tiktok.")
GENERIC_EMAIL_PREFIXES = ("info", "enquiries", "enquiry", "sales", "accounts", "finance", "hello", "contact", "office",
                          "admin", "treasury", "payments", "purchasing", "orders", "reception", "mail",
                          "customerservice", "customer.service", "customerservices")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

Fetcher = Callable[[str], Optional[tuple[str, str]]]


def fetch(url: str) -> Optional[tuple[str, str]]:
    """(final URL, text) for an HTML or text page, or None on any failure."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            ctype = resp.headers.get("Content-Type", "")
            if "html" not in ctype and "text/plain" not in ctype:
                return None
            charset = resp.headers.get_content_charset() or "utf-8"
            return resp.geturl(), resp.read(MAX_BYTES).decode(charset, "replace")
    except Exception:  # noqa: BLE001 — DNS failures, timeouts, TLS errors, 4xx/5xx: no site here
        return None


_WEB_ADDRESS_RE = re.compile(r"\b(?:https?://)?(www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+)", re.I)
_NOT_COMPANY_SITES = ("gov.uk", "companieshouse", "frc.org", "icaew", "accaglobal", "icas.com", "legislation")


def addresses_in_text(text: str, limit: int = 3) -> list[str]:
    """Homepages written in a document ("www.acmewines.co.uk"), skipping regulators' sites; most frequent first."""
    counts: dict[str, int] = {}
    for host in _WEB_ADDRESS_RE.findall(text):
        host = host.lower().rstrip(".")
        if not any(n in host for n in _NOT_COMPANY_SITES):
            counts[host] = counts.get(host, 0) + 1
    ranked = sorted(counts, key=lambda h: -counts[h])
    return [f"https://{h}/" for h in ranked[:limit]]


def candidate_domains(company_name: str) -> list[str]:
    """Likely homepages from the company name, most likely first."""
    words = [re.sub(r"[^a-z0-9]", "", w) for w in matching.normalise_name(company_name).lower().split()]
    words = [w for w in words if w]
    if not words:
        return []
    core = [w for w in words if w.upper() not in _DROP_WORDS] or words
    labels = ["".join(words), "".join(w for w in words if w != "and"), "".join(core), "-".join(core)]
    if len(core) > 2:
        labels.append("".join(core[:2]))
    urls = []
    for label in dict.fromkeys(labels):
        if 2 < len(label) <= 63:
            for tld in (".co.uk", ".com"):
                urls.append(f"https://www.{label}{tld}/")
    return urls[:MAX_DOMAIN_GUESSES]


def page_text(html: str) -> str:
    """Visible text of a page: scripts, styles and tags removed."""
    html = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h\d|td|tr|span|a)>", "\n", html)
    return htmllib.unescape(re.sub(r"<[^>]+>", " ", html))


def confirms_company(text: str, company_number: str, company_name: str) -> str:
    """"high" if the page shows the registration number, "medium" for the full registered name, else ""."""
    number = company_number.strip().upper()
    flat = " ".join(text.upper().split())
    if number.isdigit() and len(number.lstrip("0")) >= 5:
        if re.search(rf"(?<!\d)0*{int(number)}(?!\d)", flat):  # a whole number, not part of a longer one
            return "high"
    elif number and number in flat.replace(" ", ""):
        return "high"
    name = " ".join(company_name.upper().replace("&", "AND").split())
    return "medium" if name and name in flat.replace("&", "AND") else ""


def _ranked(candidates: Iterable[tuple[str, str]], base_url: str, limit: int) -> list[str]:
    """Same-site URLs (with their link text) most likely to name the finance team, best first."""
    host = urllib.parse.urlparse(base_url).netloc.lower().removeprefix("www.")
    scored: dict[str, int] = {}
    for href, text in candidates:
        url = urllib.parse.urljoin(base_url, href.strip())
        parsed = urllib.parse.urlparse(url)
        if (parsed.scheme not in ("http", "https") or parsed.netloc.lower().removeprefix("www.") != host
                or url.rstrip("/") == base_url.rstrip("/")):
            continue
        hay = (parsed.path + " " + re.sub(r"<[^>]+>", " ", text)).lower()
        score = max((w for k, w in _PAGE_WORDS if k in hay), default=0)
        if score:
            scored[url] = max(scored.get(url, 0), score)
    return [u for u, _ in sorted(scored.items(), key=lambda kv: (-kv[1], len(kv[0])))][:limit]


def team_links(html: str, base_url: str, limit: int = MAX_PAGES - 1) -> list[str]:
    """Same-site links most likely to name the finance team, best first."""
    return _ranked(re.findall(r'(?is)<a\b[^>]*href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', html), base_url, limit)


_LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.I)


def sitemap_links(base_url: str, fetcher: Fetcher, robots: urllib.robotparser.RobotFileParser,
                  limit: int = MAX_PAGES - 1) -> list[str]:
    """
    Team / leadership pages listed in the site's sitemap, best first: for sites whose homepage doesn't link to
    them (menus built by scripts, pages only in the footer). The sitemap robots.txt names, else /sitemap.xml;
    for a sitemap index, the one child sitemap for pages. At most two small XML files; no pages fetched here.
    """
    got = fetcher(next(iter(robots.site_maps() or []), "") or urllib.parse.urljoin(base_url, "/sitemap.xml"))
    xml = got[1] if got else ""
    if re.search(r"<sitemapindex", xml, re.I):
        children = _LOC.findall(xml)
        child = next((c for c in children if re.search(r"page", c, re.I)), children[0] if children else "")
        got = fetcher(child) if child else None
        xml = got[1] if got else ""
    return _ranked(((u, "") for u in _LOC.findall(xml)), base_url, limit)


def generic_emails(text: str, site_host: str) -> list[str]:
    """Generic company addresses on the site's own domain (info@, accounts@, ...)."""
    domain = site_host.lower().removeprefix("www.")
    found = []
    for email in _EMAIL_RE.findall(text):
        local, _, host = email.lower().partition("@")
        if (host == domain or host.endswith("." + domain)) and local.startswith(GENERIC_EMAIL_PREFIXES):
            if email.lower() not in found:
                found.append(email.lower())
    return found


def _robots(base_url: str, fetcher: Fetcher) -> urllib.robotparser.RobotFileParser:
    parser = urllib.robotparser.RobotFileParser()
    got = fetcher(urllib.parse.urljoin(base_url, "/robots.txt"))
    parser.parse(got[1].splitlines() if got else [])
    return parser


def look_up(company_number: str, company_name: str, fetcher: Optional[Fetcher] = None, pause: Optional[float] = None,
            hints: Iterable[str] = ()) -> dict:
    """
    {"website", "confidence", "people", "emails"} — empty values when no
    site could be confirmed as this company's. `hints` (web addresses
    printed in the accounts) are tried before guesses from the name; they
    still have to show the company's number or name.
    """
    fetcher = fetcher or fetch
    pause = PAUSE_SECONDS if pause is None else pause
    result = {"website": "", "confidence": "", "people": [], "emails": [], "qualified": []}
    for guess in dict.fromkeys([*hints, *candidate_domains(company_name)]):
        got = fetcher(guess)
        if not got:
            continue
        url, html = got
        if any(s in urllib.parse.urlparse(url).netloc for s in _SOCIAL):
            continue
        texts = [page_text(html)]
        confidence = confirms_company(texts[0], company_number, company_name)
        robots = _robots(url, fetcher)
        links = team_links(html, url)
        if not any(re.search(r"team|leadership|management|board|directors", link, re.I) for link in links):
            # no team page linked from the homepage: the sitemap may list one
            links = list(dict.fromkeys(sitemap_links(url, fetcher, robots) + links))[:MAX_PAGES - 1]
        for link in links:
            if not robots.can_fetch(USER_AGENT, link):
                continue
            time.sleep(pause)
            page = fetcher(link)
            if page:
                texts.append(page_text(page[1]))
                confidence = confidence or confirms_company(texts[-1], company_number, company_name)
        if not confidence:
            continue  # someone else's site at a lookalike domain
        host = urllib.parse.urlparse(url).netloc
        everything = "\n".join(texts)
        result.update(website=f"{urllib.parse.urlparse(url).scheme}://{host}/", confidence=confidence,
                      people=people.finance_people(everything, company_name), emails=generic_emails(everything, host),
                      qualified=people.qualified_people(everything))
        return result
    return result


def look_up_many(companies: Iterable[tuple], fetcher: Optional[Fetcher] = None,
                 workers: Optional[int] = None) -> dict[str, dict]:
    """
    {company_number: look_up(...)} for many (company_number, company_name[,
    hints]) tuples, several at once: each company is a different website,
    so this is no harder on any one site than looking them up one by one.
    """
    companies = list(companies)
    with ThreadPoolExecutor(max_workers=max(1, min(workers or WORKERS, len(companies) or 1))) as pool:
        results = pool.map(lambda c: look_up(c[0], c[1], fetcher, hints=c[2] if len(c) > 2 else ()), companies)
        return {c[0]: result for c, result in zip(companies, results)}
