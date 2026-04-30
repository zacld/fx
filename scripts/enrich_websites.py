"""
enrich_websites.py — Backfill website discovery for leads that have no website.

Runs find_website_guess() on every lead missing a website, scrapes for FX
signals, and writes the results back to leads.json so rescore.py can use them.

Safe to re-run: only processes leads where website is None or website_confidence
is "low" (worth retrying).
"""

import json, logging, re, time
from pathlib import Path

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

from website_finder import find_website_guess, HEADERS

DATA_DIR   = Path(__file__).parent.parent / "data"
LEADS_FILE = DATA_DIR / "leads.json"

FX_PAYMENT_SIGNALS = [
    "we import","we source","sourced from","imported from","direct from",
    "importing from","we buy from","purchased from","procured from",
    "overseas supplier","european supplier","international supplier","foreign supplier",
    "global supplier","worldwide supplier",
    "from italy","from france","from spain","from germany","from china","from usa",
    "from america","from japan","from india","from norway","from australia",
    "from new zealand","from south africa","from denmark","from netherlands",
    "italian","french","spanish","german","chinese","american","japanese",
    "foreign currency","currency risk","exchange rate","fx exposure",
    "international payments","overseas payments","currency hedging","fx risk",
    "importer","import company","import business","exclusive importer",
    "uk importer","sole importer","we distribute","import and distribute",
    "export","exports","exporting","we export","overseas customers","global customers",
    "international customers","us customers","american customers","european customers",
]

SECONDARY_SIGNALS = [
    "international","global","worldwide","overseas","distribution","distributor",
    "wholesale","wholesaler","logistics","freight","shipping","customs",
    "europe","european","asia","asian","north america","south america",
    "supply chain","supplier","sourcing","procurement",
]


def scrape_fx_signals(url: str) -> dict:
    """Minimal scrape — returns fx_signals, secondary_signals, snippet, pays_fx."""
    empty = {"fx_signals":[],"secondary_signals":[],"snippet":"","pays_fx":False}
    if not url:
        return empty
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10, allow_redirects=True)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script","style","nav","footer","header","meta"]):
            tag.decompose()
        text = soup.get_text(" ", strip=True)
        tlow = text.lower()
        snippet  = re.sub(r"\s+", " ", text)[:800]
        fx_sigs  = sorted({s for s in FX_PAYMENT_SIGNALS if s in tlow})
        sec_sigs = sorted({s for s in SECONDARY_SIGNALS   if s in tlow})
        pays_fx  = len(fx_sigs) >= 1 or len(sec_sigs) >= 3
        return {"fx_signals": fx_sigs, "secondary_signals": sec_sigs,
                "snippet": snippet, "pays_fx": pays_fx}
    except Exception as exc:
        log.debug("Scrape failed %s: %s", url, exc)
        return empty


def should_try(lead: dict) -> bool:
    """Try if no website, or previous attempt gave low confidence."""
    if not lead.get("website"):
        return True
    if lead.get("website_confidence") == "low":
        return True
    return False


def main():
    log.info("=== Website Enrichment — domain guessing for %s ===", LEADS_FILE.name)
    leads = json.loads(LEADS_FILE.read_text())

    candidates = {lid: v for lid, v in leads.items() if should_try(v)}
    log.info("Leads to enrich: %d / %d", len(candidates), len(leads))

    found = updated = 0

    for i, (lid, lead) in enumerate(candidates.items(), 1):
        name = lead.get("company_name", "")
        cn   = lead.get("company_number", "")
        log.info("[%d/%d] %s", i, len(candidates), name[:50])

        url, confidence, source = find_website_guess(name, cn)

        if url:
            found += 1
            log.info("  ✓ %s  (%s via %s)", url, confidence, source)

            web = scrape_fx_signals(url)

            lead["website"]            = url
            lead["website_confidence"] = confidence
            lead["website_source"]     = source
            lead["fx_payment_signals"] = web["fx_signals"]
            lead["secondary_signals"]  = web["secondary_signals"]
            lead["pays_fx_confirmed"]  = web["pays_fx"]
            if web["snippet"] and not lead.get("website_snippet"):
                lead["website_snippet"] = web["snippet"]
            updated += 1

            if web["fx_signals"]:
                log.info("  FX signals: %s", ", ".join(web["fx_signals"][:3]))
        else:
            log.info("  — not found")

        leads[lid] = lead
        time.sleep(0.5)

        # Save incrementally every 25 leads so progress isn't lost
        if i % 25 == 0:
            LEADS_FILE.write_text(json.dumps(leads, indent=2, default=str))
            log.info("  … checkpoint saved (%d/%d)", i, len(candidates))

    LEADS_FILE.write_text(json.dumps(leads, indent=2, default=str))

    public = Path(__file__).parent.parent / "public" / "data"
    public.mkdir(parents=True, exist_ok=True)
    (public / "leads.json").write_text(LEADS_FILE.read_text())

    log.info("=== Done: %d/%d websites found, %d leads updated ===",
             found, len(candidates), updated)


if __name__ == "__main__":
    main()
