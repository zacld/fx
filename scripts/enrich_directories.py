"""
enrich_directories.py — Multi-source phone cross-reference.

Sources (in order of reliability):
  1. Company's own website  — /contact, /contact-us, /find-us, /about (most reliable)
  2. Hotfrog UK             — works without Cloudflare block; improved name matching
  3. Bing search            — "company name" postcode phone → extract from results page

For each lead with a website but no phone (or all leads with --force):
  1. Searches each source by company name + postcode
  2. Cross-references fingerprinted results for confidence scoring
  3. Picks best phone (geographic > mobile > freephone, boosted by postcode match)
  4. Records how many sources confirmed this number

Adds/updates:
  contact_phone        : best phone found across all sources
  phone_source         : "own_website" | "hotfrog" | "bing" | "multi_source"
  phone_source_count   : int — number of sources that confirmed this number
  phone_sources        : list[str] — which sources had a matching number
  all_phones_found     : list[str] — all distinct phones discovered

Skips leads that already have contact_phone unless --force.
Run: python3.11 scripts/enrich_directories.py [--force]
"""

import json, logging, os, re, shutil, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus, urljoin, urlparse
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

ROOT      = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "leads.json"
FORCE     = "--force" in sys.argv

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
}

# Request timeout per source
TIMEOUT = 10

# Phone extraction regex — UK numbers in various formats
PHONE_RE = re.compile(
    r"""(?:
        0[12]\d{3}[\s\-]?\d{6}           |   # 01xxx xxxxxx or 02x xxxx xxxx
        0[12]\d[\s\-]?\d{4}[\s\-]?\d{4}  |   # 01x xxxx xxxx
        07\d{3}[\s\-]?\d{6}              |   # 07xxx xxxxxx (mobile)
        0800[\s\-]?\d{3}[\s\-]?\d{4}     |   # 0800 xxx xxxx (freephone)
        0845[\s\-]?\d{3}[\s\-]?\d{4}     |   # 0845 numbers
        \+44[\s\-]?\d{2,4}[\s\-]?\d{4,8}     # +44 format
    )""",
    re.VERBOSE,
)

# Tel: href links (most precise — deliberate markup)
TEL_HREF_RE = re.compile(r'href=["\']tel:([\+0-9\s\-\(\)]{7,20})["\']', re.I)

# UK postcode area → expected area code prefixes for geo-matching
POSTCODE_AREA_PREFIXES: dict[str, list[str]] = {
    "AB": ["01224","01330","01346","01358","01467","01651","01771"],
    "AL": ["01727","01582"],
    "B":  ["0121","01675","01564"],
    "BA": ["01225","01373","01761","01749"],
    "BB": ["01254","01282","01200"],
    "BD": ["01274","01535","01943"],
    "BH": ["01202","01425"],
    "BL": ["01204","01706"],
    "BN": ["01273","01903","01444","01342","01825","01323"],
    "BR": ["020","01689"],
    "BS": ["0117","01275","01934","01454","01453"],
    "CA": ["01228","01900","01697","01768"],
    "CB": ["01223","01353","01763","01799"],
    "CF": ["029","01443","01656","01446"],
    "CH": ["01244","01513"],
    "CM": ["01245","01277","01279","01371","01376"],
    "CO": ["01206","01255","01376","01787"],
    "CR": ["020"],
    "CT": ["01227","01303","01304","01843"],
    "CV": ["024","01788","01926"],
    "CW": ["01270","01606","01477"],
    "DA": ["01322","020"],
    "DD": ["01382","01307","01828"],
    "DE": ["01332","01283","01629","01773"],
    "DG": ["01387","01556","01671","01644"],
    "DH": ["0191","01388","01207"],
    "DL": ["01325","01388","01677","01748"],
    "DN": ["01302","01405","01427","01724"],
    "DT": ["01305","01258","01308","01747"],
    "DY": ["01384","01562","01299","01902"],
    "E":  ["020"],
    "EC": ["020"],
    "EH": ["0131","01875","01968","01506","01620"],
    "EN": ["020","01992","01707"],
    "EX": ["01392","01271","01769","01884","01398"],
    "FK": ["01786","01324","01259"],
    "FY": ["01253","01524","01772"],
    "G":  ["0141"],
    "GL": ["01452","01242","01285","01386","01594"],
    "GU": ["01483","01252","01276","01420"],
    "GY": ["01481"],
    "HA": ["020"],
    "HD": ["01484","01924","01422"],
    "HG": ["01423","01765","01677"],
    "HP": ["01442","01494","01844","01296","01582"],
    "HR": ["01432","01531","01544","01568"],
    "HS": ["01851","01870","01876","01859"],
    "HU": ["01482","01964","01430"],
    "HX": ["01422","01484"],
    "IG": ["020"],
    "IP": ["01473","01394","01728","01638","01449"],
    "IV": ["01463","01349","01955","01381","01667"],
    "JE": ["01534"],
    "KA": ["01563","01292","01465","01655"],
    "KT": ["020","01372","01932"],
    "KW": ["01955","01408","01847"],
    "KY": ["01592","01334","01337","01577"],
    "L":  ["0151"],
    "LA": ["01524","01229","01228"],
    "LD": ["01597","01982","01591"],
    "LE": ["0116","01455","01858"],
    "LL": ["01492","01745","01341","01758","01766","01678"],
    "LN": ["01522","01507","01673","01529","01526"],
    "LS": ["0113","01943"],
    "LU": ["01582","01525"],
    "M":  ["0161"],
    "ME": ["01634","01795","01622"],
    "MK": ["01908","01525","01280","01327"],
    "ML": ["01698","01555","01236"],
    "N":  ["020"],
    "NE": ["0191"],
    "NG": ["0115","01636","01623","01773","01777"],
    "NN": ["01604","01327","01536","01933"],
    "NP": ["01633","01873","01291","01594"],
    "NR": ["01603","01263","01553","01328"],
    "NW": ["020"],
    "OL": ["01706","01457"],
    "OX": ["01865","01608","01295","01491","01235"],
    "PA": ["0141","01505","01475","01496"],
    "PE": ["01733","01553","01775","01780","01832"],
    "PH": ["01738","01250","01887","01796"],
    "PL": ["01752","01822","01579","01548"],
    "PO": ["023","01983","01243","01329"],
    "PR": ["01772","01254","01257","01995"],
    "RG": ["01189","01256","01488","01635"],
    "RH": ["01293","01342","01306","01737","01403"],
    "RM": ["020","01708"],
    "S":  ["0114","01709","01226","01302","01246","01909"],
    "SA": ["01792","01656","01437","01994","01269","01239"],
    "SE": ["020"],
    "SG": ["01438","01462","01920","01279"],
    "SK": ["0161","01663","01625","01298","01457"],
    "SL": ["01753","01628"],
    "SM": ["020"],
    "SN": ["01793","01249","01672","01285","01380"],
    "SO": ["023","01590","01794","01962","01489"],
    "SP": ["01722","01258","01747"],
    "SR": ["0191","01388"],
    "SS": ["01268","01702","01375"],
    "ST": ["01782","01538","01889","01785","01543"],
    "SW": ["020"],
    "SY": ["01743","01691","01686","01938","01654","01588"],
    "TA": ["01823","01278","01460","01643"],
    "TD": ["01896","01573","01289","01450"],
    "TF": ["01952","01691"],
    "TN": ["01892","01580","01323","01424","01273"],
    "TQ": ["01803","01626","01548","01364"],
    "TR": ["01872","01326","01736","01637"],
    "TS": ["01642","01325","01287"],
    "TW": ["020"],
    "UB": ["020"],
    "W":  ["020"],
    "WA": ["01925","01744","01928","01606"],
    "WC": ["020"],
    "WD": ["01923","01442","020"],
    "WF": ["01924","01977","01226","01484"],
    "WN": ["01942","01695","01257"],
    "WR": ["01905","01386","01527","01684"],
    "WS": ["01922","01543","01902","01384"],
    "WV": ["01902","01384","01543"],
    "YO": ["01904","01723","01653","01751","01947","01439"],
    "ZE": ["01595"],
}

# Pages to check on company's own website for phone numbers
CONTACT_PATHS = [
    "/contact", "/contact-us", "/contact_us", "/contactus",
    "/find-us", "/find_us", "/findus",
    "/get-in-touch", "/reach-us", "/reach_us",
    "/about-us", "/about_us", "/about",
    "/locations", "/our-locations",
]

# ── Phone utilities ───────────────────────────────────────────────

def postcode_area(postcode: str) -> str:
    m = re.match(r"([A-Z]{1,2})", postcode.strip().upper())
    return m.group(1) if m else ""

def geo_score(phone: str, postcode: str) -> int:
    if not postcode:
        return 0
    area  = postcode_area(postcode)
    prefs = POSTCODE_AREA_PREFIXES.get(area, [])
    d     = re.sub(r"\D", "", phone)
    if d.startswith("44"):
        d = "0" + d[2:]
    for p in prefs:
        if d.startswith(p):
            return 2
    return 0

def phone_score(phone: str, postcode: str = "") -> int:
    d = re.sub(r"\D", "", phone)
    if d.startswith("44"):
        d = "0" + d[2:]
    base = 0
    if d.startswith("01") or d.startswith("02"): base = 3
    elif d.startswith("07"):                      base = 2
    elif d.startswith("0800") or d.startswith("0808"): base = 1
    return base + geo_score(phone, postcode)

def normalise_phone(raw: str) -> str:
    d = re.sub(r"[\s\-\(\)]", "", raw)
    if d.startswith("+44"):
        d = "0" + d[3:]
    elif d.startswith("44") and len(d) >= 11:
        d = "0" + d[2:]
    if len(d) == 11:
        # 3-digit area codes (020/023/024/028/029): format as 0XX XXXX XXXX
        if d[1:3] in ("20", "23", "24", "28", "29"):
            return f"{d[:3]} {d[3:7]} {d[7:]}"
        # Known 4-digit area codes: 0113-0118 (major cities), 0121, 0131, 0141, 0151, 0161, 0191
        four = d[:4]
        if four in ("0113","0114","0115","0116","0117","0118","0121","0131","0141","0151","0161","0191"):
            return f"{four} {d[4:7]} {d[7:]}"
        # Default: 5-digit area code + 6-digit subscriber (most 01xxx/07xxx numbers)
        return f"{d[:5]} {d[5:]}"
    return d

def fingerprint(phone: str) -> str:
    d = re.sub(r"\D", "", phone)
    if d.startswith("44"):
        d = "0" + d[2:]
    return d

def extract_phones_from_html(html: str, near_text: str = "") -> list[str]:
    """
    Extract phone numbers from HTML text, dedup by digit fingerprint.
    If near_text is given, score by proximity to that text in the HTML.
    """
    found: dict[str, str] = {}

    # Tel: links first (most reliable — deliberate markup)
    for m in TEL_HREF_RE.finditer(html):
        raw = m.group(1).strip()
        fp  = fingerprint(raw)
        if 9 <= len(fp) <= 13:
            found[fp] = normalise_phone(raw)

    # Fallback: regex on visible text
    for m in PHONE_RE.finditer(html):
        raw = m.group(0).strip()
        fp  = fingerprint(raw)
        if fp and 9 <= len(fp) <= 13:
            found.setdefault(fp, normalise_phone(raw))

    return list(found.values())

def extract_phones_near_name(html: str, company_name: str, window: int = 1500) -> list[str]:
    """
    Extract phones from HTML, but only from a region near the company name.
    Falls back to full-page extraction if company name not found.
    """
    # Build search terms: strip common suffixes, take first 2+ significant words
    clean = re.sub(r"\b(ltd|limited|plc|llp|group|uk|holdings?)\b", "", company_name, flags=re.I).strip()
    words = [w for w in re.split(r"\W+", clean) if len(w) >= 4]
    search_terms = words[:2] if words else [company_name[:10]]

    html_lower = html.lower()
    best_idx = -1
    for term in search_terms:
        idx = html_lower.find(term.lower())
        if idx >= 0:
            best_idx = idx
            break

    if best_idx >= 0:
        snippet = html[max(0, best_idx - window // 4) : best_idx + window]
        phones = extract_phones_from_html(snippet)
        if phones:
            return phones
        # Widen the search if nothing in the narrow window
        snippet = html[max(0, best_idx - window) : best_idx + window * 2]
        phones = extract_phones_from_html(snippet)
        if phones:
            return phones

    # Company name not found in page — fall back to full extraction
    return extract_phones_from_html(html)

def extract_postcode(address: str) -> str:
    if not address:
        return ""
    m = re.search(r"\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b", address.upper())
    return m.group(1) if m else ""

# ── Source 1: Company's own website ──────────────────────────────

def search_own_website(company_name: str, website: str, postcode: str = "") -> list[str]:
    """
    Scrape the company's own website — contact, about, find-us pages.
    This is the most reliable source: the number is definitely theirs.
    """
    if not website:
        return []

    # Normalise URL
    if not website.startswith("http"):
        website = "https://" + website
    website = website.rstrip("/")

    sess = requests.Session()
    sess.headers.update(HEADERS)
    sess.max_redirects = 4

    phones: list[str] = []

    # 1. Try homepage first (tel: links are often in the header/footer)
    try:
        r = sess.get(website, timeout=8, allow_redirects=True)
        if r.ok and len(r.text) > 200:
            found = extract_phones_from_html(r.text)
            if found:
                log.debug("  own_site homepage: %s → %s", website, found[:2])
                phones.extend(found)
    except Exception:
        pass

    # 2. Try contact/find-us pages (higher phone density)
    for path in CONTACT_PATHS:
        if len(phones) >= 3:
            break
        try:
            url = website + path
            r = sess.get(url, timeout=8, allow_redirects=True)
            if r.ok and len(r.text) > 200:
                found = extract_phones_from_html(r.text)
                if found:
                    log.debug("  own_site %s → %s", path, found[:2])
                    phones.extend(found)
        except Exception:
            continue

    # Dedup by fingerprint
    seen: dict[str, str] = {}
    for ph in phones:
        fp = fingerprint(ph)
        if fp and 9 <= len(fp) <= 13:
            seen.setdefault(fp, ph)
    return list(seen.values())

# ── Source 2: Hotfrog UK ─────────────────────────────────────────

def search_hotfrog(company_name: str, postcode: str = "") -> list[str]:
    """
    Hotfrog UK business directory — the one working directory.
    Uses company-name proximity matching to reduce noise from area results.
    """
    q = quote_plus(company_name)
    # Hotfrog URL: /search/uk/{location}/{query}
    if postcode:
        loc = postcode[:4].replace(" ", "").lower()
        url = f"https://www.hotfrog.co.uk/search/uk/{loc}/{q}"
    else:
        url = f"https://www.hotfrog.co.uk/search/uk/{q}"

    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if not r.ok:
            return []
        return extract_phones_near_name(r.text, company_name, window=2000)
    except Exception:
        return []

# ── Source 3: Bing search ─────────────────────────────────────────

def search_bing(company_name: str, postcode: str = "") -> list[str]:
    """
    Bing search for '[company name] [postcode] phone'.
    Bing's local knowledge cards sometimes embed the phone number directly
    as a tel: link in the HTML result, without JS rendering.
    """
    loc = postcode if postcode else "UK"
    q   = quote_plus(f'"{company_name}" {loc} phone number')
    url = f"https://www.bing.com/search?q={q}&mkt=en-GB&setlang=en-GB"

    try:
        r = requests.get(url, headers={**HEADERS, "Accept-Language": "en-GB"}, timeout=TIMEOUT)
        if not r.ok:
            return []
        # Focus on first 60 KB — knowledge card appears near the top
        html = r.text[:60_000]
        # tel: links first (knowledge card markup)
        phones = extract_phones_from_html(html)
        if phones:
            return phones
        # Fall back: proximity search near company name
        return extract_phones_near_name(html, company_name, window=1500)
    except Exception:
        return []

# ── Source 4: DuckDuckGo HTML ─────────────────────────────────────

def search_ddg(company_name: str, postcode: str = "") -> list[str]:
    """
    DuckDuckGo HTML interface. Slower but different result set from Bing.
    Sometimes includes phone in structured snippets.
    """
    loc = postcode if postcode else "UK"
    q   = quote_plus(f"{company_name} {loc} phone contact")
    url = f"https://html.duckduckgo.com/html/?q={q}&kl=uk-en"

    try:
        r = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code not in (200, 202):
            return []
        return extract_phones_near_name(r.text, company_name, window=1500)
    except Exception:
        return []

# ── Cross-reference engine ────────────────────────────────────────

SOURCES = {
    "own_website": ("Own website",   None),   # fn injected at lookup time (needs website URL)
    "hotfrog":     ("Hotfrog",       search_hotfrog),
    "bing":        ("Bing",          search_bing),
    "ddg":         ("DuckDuckGo",    search_ddg),
}

def lookup_phone_multi_source(
    company_name: str,
    website: str = "",
    postcode: str = "",
) -> dict:
    """
    Search all sources in parallel.
    Returns { phone, source_count, sources, all_phones, source_label }
    """
    results: dict[str, list[str]] = {}

    def _own() -> list[str]:
        return search_own_website(company_name, website, postcode) if website else []
    def _hotfrog() -> list[str]:
        return search_hotfrog(company_name, postcode)
    def _bing() -> list[str]:
        return search_bing(company_name, postcode)
    def _ddg() -> list[str]:
        return search_ddg(company_name, postcode)

    tasks = {
        "own_website": _own,
        "hotfrog":     _hotfrog,
        "bing":        _bing,
        "ddg":         _ddg,
    }

    with ThreadPoolExecutor(max_workers=4) as exe:
        futures = {exe.submit(fn): key for key, fn in tasks.items()}
        try:
            for fut in as_completed(futures, timeout=TIMEOUT + 8):
                key = futures[fut]
                try:
                    results[key] = fut.result(timeout=2) or []
                except Exception:
                    results[key] = []
        except TimeoutError:
            # One or more sources took too long — use what arrived, cancel the rest
            for fut, key in futures.items():
                if not fut.done():
                    fut.cancel()
                elif key not in results:
                    try:
                        results[key] = fut.result(timeout=0) or []
                    except Exception:
                        results[key] = []

    # Cross-reference: fingerprint → sources that reported it
    fp_sources: dict[str, list[str]] = {}
    fp_phone:   dict[str, str]       = {}

    for key, phones in results.items():
        disp = SOURCES[key][0]
        for ph in phones:
            fp = fingerprint(ph)
            if not fp or len(fp) < 9:
                continue
            fp_sources.setdefault(fp, []).append(disp)
            fp_phone[fp] = ph  # last one wins (same number, normalised)

    if not fp_phone:
        return {"phone": None, "source_count": 0, "sources": [], "all_phones": [], "source_label": "none"}

    # Rank by (source_count DESC, phone_score DESC)
    ranked = sorted(
        fp_phone.keys(),
        key=lambda fp: (len(fp_sources[fp]), phone_score(fp_phone[fp], postcode)),
        reverse=True,
    )
    best_fp = ranked[0]
    best    = fp_phone[best_fp]
    srcs    = fp_sources[best_fp]
    count   = len(srcs)

    # Derive source label
    if count >= 2:
        label = "multi_source"
    else:
        # single source — use key
        key_of_best = next(
            (k for k, phones in results.items() if any(fingerprint(p) == best_fp for p in phones)),
            "unknown",
        )
        label = key_of_best

    return {
        "phone":        best,
        "source_count": count,
        "sources":      srcs,
        "all_phones":   [fp_phone[fp] for fp in ranked],
        "source_label": label,
    }

# ── Main ─────────────────────────────────────────────────────────

def main():
    log.info("=== Multi-Source Phone Enrichment ===")
    log.info("Sources: own website  ·  Hotfrog  ·  Bing  ·  DuckDuckGo")

    with open(DATA_FILE) as f:
        data = json.load(f)

    is_dict = isinstance(data, dict)
    leads   = list(data.values()) if is_dict else data
    keys    = list(data.keys())   if is_dict else None

    # Target: leads with a website (we're serious about them) and no phone yet
    targets = [
        l for l in leads
        if isinstance(l, dict)
        and (FORCE or not l.get("contact_phone"))
        and l.get("company_name")
        and l.get("website")
    ]

    log.info("Leads to enrich: %d (of %d total)", len(targets), len(leads))

    found_new = 0
    confirmed = 0
    not_found = 0

    for i, lead in enumerate(targets):
        co      = lead.get("company_name", "?")[:40]
        addr    = lead.get("address", "") or ""
        pc      = lead.get("postcode") or extract_postcode(addr)
        site    = lead.get("website", "")

        log.info("[%d/%d] %s%s", i + 1, len(targets), co, f"  ({pc})" if pc else "")

        result = lookup_phone_multi_source(co, site, pc)

        if result["phone"]:
            existing    = lead.get("contact_phone") or ""
            new_ph      = result["phone"]
            existing_fp = fingerprint(existing)
            new_fp      = fingerprint(new_ph)

            if not existing:
                lead["contact_phone"] = new_ph
                lead["phone_source"]  = result["source_label"]
                found_new += 1
                log.info(
                    "  ✓ NEW    %s  [%d src: %s]",
                    new_ph, result["source_count"], " + ".join(result["sources"])
                )
            elif new_fp == existing_fp:
                confirmed += 1
                log.info(
                    "  ✓ CONFIRMED  %s  [%d src]",
                    new_ph, result["source_count"]
                )
            else:
                log.info(
                    "  ~ DIFFERENT  existing=%s  found=%s  (keeping existing)",
                    existing, new_ph
                )

            lead["phone_source_count"] = result["source_count"]
            lead["phone_sources"]      = result["sources"]
            lead["all_phones_found"]   = result["all_phones"]
        else:
            not_found += 1
            log.debug("  — no phone found in any source")

        # Polite delay between companies
        time.sleep(0.8)

    # Save
    out = {keys[i]: leads[i] for i in range(len(leads))} if is_dict else leads
    with open(DATA_FILE, "w") as f:
        json.dump(out, f, indent=2)

    for dst in [
        ROOT / "public" / "data" / "leads.json",
        ROOT / "apps" / "web" / "public" / "data" / "leads.json",
    ]:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DATA_FILE, dst)

    log.info(
        "Done — new_phones=%d  confirmed=%d  not_found=%d",
        found_new, confirmed, not_found,
    )

    # Coverage summary
    with_phone = sum(1 for l in leads if isinstance(l, dict) and l.get("contact_phone"))
    hot_warm   = [l for l in leads if isinstance(l, dict) and l.get("priority") in ("HOT", "WARM")]
    hw_phone   = sum(1 for l in hot_warm if l.get("contact_phone"))
    log.info(
        "Phone coverage: %d/%d total  ·  %d/%d HOT/WARM",
        with_phone, len(leads), hw_phone, len(hot_warm),
    )

    # Confidence breakdown
    multi_src = sum(1 for l in leads if isinstance(l, dict) and (l.get("phone_source_count") or 0) >= 2)
    own_site  = sum(1 for l in leads if isinstance(l, dict) and l.get("phone_source") == "own_website")
    log.info(
        "Confidence: %d multi-source (high)  ·  %d from own website",
        multi_src, own_site,
    )


if __name__ == "__main__":
    main()
