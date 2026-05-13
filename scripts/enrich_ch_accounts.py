"""
enrich_ch_accounts.py — Mine Companies House accounts filings for financial intelligence.

For each lead with a CH company_number, fetches the latest filed accounts and extracts:
  accounts_type       : "micro-entity" | "small" | "medium" | "full" | "abridged" | "dormant"
  last_accounts_date  : period-end date (ISO)
  company_size_band   : "<£1m" | "£1m–£5m" | "£5m–£25m" | "£25m–£100m" | "£100m+" | "unknown"
  employee_count      : int — average employees during period (if disclosed)
  employee_band       : "1–4" | "5–9" | "10–24" | "25–49" | "50–99" | "100–249" | "250+"
  net_assets          : float — net assets / (equity) in £
  total_assets        : float — total assets less current liabilities in £
  turnover_amount     : float — if disclosed (full/small accounts only)
  accounts_source     : "ch_ixbrl" | "ch_filing_description" | "ch_type_inferred"

Size derivation when turnover unavailable (abridged/micro accounts):
  net_assets ≤ £316k  → likely micro / very small
  net_assets ≤ £5.1m  → small SME (≤ 50 employees)
  net_assets > £5.1m  → medium-large

Run: python3.11 scripts/enrich_ch_accounts.py [--force]
Idempotent — skips leads already enriched unless --force.
Requires: COMPANIES_HOUSE_API_KEY env var.
"""

import json, logging, os, re, shutil, sys, time
from pathlib import Path
from typing import Optional
import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

ROOT      = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "leads.json"
CH_KEY    = os.getenv("COMPANIES_HOUSE_API_KEY", "")
FORCE     = "--force" in sys.argv

CH_API  = "https://api.company-information.service.gov.uk"
DOC_API = "https://document-api.company-information.service.gov.uk"

SESS = requests.Session()
if CH_KEY:
    SESS.auth = (CH_KEY, "")
SESS.headers["User-Agent"] = "FX-Discovery-Accounts/1.0 (contact@fxdiscovery.io)"

# Rate limiting: CH allows 600 req/5min → ~0.5s between requests is safe
REQ_DELAY = 0.5

# ── Size bands ────────────────────────────────────────────────────
def size_band_from_turnover(t: Optional[float]) -> str:
    if t is None or t < 0: return "unknown"
    if t < 1_000_000:     return "<£1m"
    if t < 5_000_000:     return "£1m–£5m"
    if t < 25_000_000:    return "£5m–£25m"
    if t < 100_000_000:   return "£25m–£100m"
    return "£100m+"

def size_band_from_net_assets(na: Optional[float]) -> str:
    """Infer size when turnover unavailable (abridged/micro accounts)."""
    if na is None or na < 0: return "unknown"
    # UK micro threshold: balance sheet ≤ £316k
    if na < 316_000:    return "<£1m"         # micro / very small
    if na < 5_100_000:  return "£1m–£5m"      # small company range
    if na < 18_000_000: return "£5m–£25m"     # medium lower end
    return "£25m–£100m"

def employee_band(n: Optional[int]) -> str:
    if n is None: return "unknown"
    if n < 5:   return "1–4"
    if n < 10:  return "5–9"
    if n < 25:  return "10–24"
    if n < 50:  return "25–49"
    if n < 100: return "50–99"
    if n < 250: return "100–249"
    return "250+"

# ── Accounts type from CH description string ──────────────────────
def infer_accounts_type(filing: dict) -> str:
    desc = (filing.get("description") or "").lower()
    ftype = (filing.get("type") or "").upper()

    if ftype in ("AA01", "AA02") or "dormant" in desc:
        return "dormant"
    if "micro-entity" in desc or "micro entity" in desc or ftype in ("MCS", "MCSA"):
        return "micro-entity"
    if "abridged" in desc:
        return "abridged"
    if "small" in desc:
        return "small"
    if "medium" in desc:
        return "medium"
    if "group" in desc or "consolidated" in desc:
        return "group"
    if ftype in ("AA", "AAMD"):
        return "full"
    return "unknown"

# ── iXBRL parser ─────────────────────────────────────────────────
# Matches: <ix:nonFraction ... name="ns5:SomeConcept" scale="0" ...>VALUE</ix:nonFraction>
IXBRL_RE = re.compile(
    r'<ix:nonFraction\b([^>]+)>([\-0-9,\. –]+)</ix:nonFraction>',
    re.I | re.DOTALL,
)
ATTR_NAME     = re.compile(r'\bname="([^"]+)"', re.I)
ATTR_SCALE    = re.compile(r'\bscale="(-?\d+)"', re.I)
ATTR_DECIMALS = re.compile(r'\bdecimals="(-?\d+|INF)"', re.I)
ATTR_UNITREF  = re.compile(r'\bunitRef="([^"]+)"', re.I)
ATTR_CTXREF   = re.compile(r'\bcontextRef="([^"]+)"', re.I)

# Concept → canonical name
TURNOVER_CONCEPTS = {"TurnoverRevenue", "Revenue", "Turnover", "TurnoverGrossProceeds"}
NETASSETS_CONCEPTS = {"NetAssetsLiabilities", "NetAssets"}
TOTALASSETS_CONCEPTS = {"TotalAssetsLessCurrentLiabilities", "Assets", "GrossAssets"}
EMPLOYEE_CONCEPTS = {"AverageNumberEmployeesDuringPeriod", "NumberEmployees", "AverageNumberPersonsEmployedDuringPeriod"}
# Date concepts to find the period end in context
DATE_CONCEPTS = {"EndDateForPeriodCoveredByReport", "BalanceSheetDate"}

def _local_name(name: str) -> str:
    """Strip namespace prefix: 'ns5:TurnoverRevenue' → 'TurnoverRevenue'"""
    return name.split(":")[-1] if ":" in name else name

def _is_current_period(ctx_ref: str) -> bool:
    """Heuristic: 'current', 'cfwd', 'FY_' contexts are current-year figures."""
    r = ctx_ref.lower()
    return any(k in r for k in ("current", "cfwd", "fy_", "cy", "2024", "2025", "2023"))

def parse_ixbrl(text: str) -> dict:
    """
    Parse iXBRL document. Returns dict with extracted financials.
    Handles scale attribute (value * 10^scale = actual £ amount).
    """
    result: dict = {
        "turnover": None,
        "net_assets": None,
        "total_assets": None,
        "employees": None,
    }

    for m in IXBRL_RE.finditer(text):
        attrs    = m.group(1)
        raw_val  = m.group(2).strip().replace(",", "").replace("–", "-").replace(" ", "")
        if not raw_val or raw_val in ("-", "–"): continue

        name_m   = ATTR_NAME.search(attrs)
        if not name_m: continue
        concept  = _local_name(name_m.group(1))

        scale_m  = ATTR_SCALE.search(attrs)
        scale    = int(scale_m.group(1)) if scale_m else 0
        unit_m   = ATTR_UNITREF.search(attrs)
        unit     = (unit_m.group(1) or "").upper() if unit_m else ""
        ctx_m    = ATTR_CTXREF.search(attrs)
        ctx      = ctx_m.group(1) if ctx_m else ""

        is_gbp   = "GBP" in unit or "POUND" in unit or unit == "GBP"
        is_pure  = "PURE" in unit or unit == "" or unit.startswith("PURE")
        is_curr  = _is_current_period(ctx)

        try:
            val = float(raw_val) * (10 ** scale)
        except ValueError:
            continue

        # Map to result fields
        if concept in TURNOVER_CONCEPTS and is_gbp and result["turnover"] is None:
            result["turnover"] = val
        elif concept in NETASSETS_CONCEPTS and is_gbp and is_curr and result["net_assets"] is None:
            result["net_assets"] = val
        elif concept in TOTALASSETS_CONCEPTS and is_gbp and is_curr and result["total_assets"] is None:
            result["total_assets"] = val
        elif concept in EMPLOYEE_CONCEPTS and is_pure and is_curr and result["employees"] is None:
            try:
                emp = int(val)
                if 0 < emp < 100_000:
                    result["employees"] = emp
            except (ValueError, OverflowError):
                pass

    return result

# ── CH API helpers ────────────────────────────────────────────────
def ch_get(path: str, params: dict = None) -> Optional[requests.Response]:
    url = f"{CH_API}{path}"
    try:
        r = SESS.get(url, params=params, timeout=12)
        time.sleep(REQ_DELAY)
        if r.status_code == 429:
            log.warning("Rate limited — sleeping 10s")
            time.sleep(10)
            r = SESS.get(url, params=params, timeout=12)
        return r if r.ok else None
    except Exception as e:
        log.debug("CH GET %s error: %s", path, e)
        return None

def get_latest_accounts_filing(company_number: str) -> Optional[dict]:
    r = ch_get(f"/company/{company_number}/filing-history",
               params={"category": "accounts", "items_per_page": 10})
    if not r:
        return None
    items = r.json().get("items", [])
    # Prefer the most recent non-dormant accounts with a document link
    for item in items:
        ftype = (item.get("type") or "").upper()
        if ftype in ("AA", "AAMD", "MCS", "MCSA", "AA01", "AA02"):
            return item
    return items[0] if items else None

def fetch_ixbrl_doc(filing: dict) -> Optional[str]:
    """Fetch iXBRL document content from CH document API."""
    doc_meta_url = filing.get("links", {}).get("document_metadata")
    if not doc_meta_url:
        return None

    try:
        mr = SESS.get(doc_meta_url, timeout=12)
        time.sleep(REQ_DELAY)
        if not mr.ok:
            return None
        meta = mr.json()
    except Exception:
        return None

    # Get the content URL from links.document
    content_url = meta.get("links", {}).get("document")
    if not content_url:
        content_url = meta.get("links", {}).get("self")
    if not content_url:
        return None

    # Only fetch if xhtml is available (saves bandwidth vs PDF)
    resources = meta.get("resources", {})
    if "application/xhtml+xml" not in resources:
        return None

    try:
        cr = SESS.get(content_url, timeout=20,
                      headers={"Accept": "application/xhtml+xml, application/xml;q=0.9"})
        time.sleep(REQ_DELAY)
        if cr.ok and len(cr.text) > 200:
            return cr.text
    except Exception:
        pass
    return None

# ── Lead enrichment ───────────────────────────────────────────────
def enrich_lead(lead: dict) -> bool:
    cn = (lead.get("company_number") or "").strip().upper().zfill(8)
    if not cn or cn == "00000000":
        return False

    filing = get_latest_accounts_filing(cn)
    if not filing:
        log.debug("%s: no accounts filing found", cn)
        return False

    acc_type   = infer_accounts_type(filing)
    desc_vals  = filing.get("description_values") or {}
    period_end = (desc_vals.get("made_up_date") or filing.get("date") or "")[:10]

    lead["accounts_type"]      = acc_type
    lead["last_accounts_date"] = period_end
    lead["accounts_source"]    = "ch_filing_description"

    # Dormant → mark and stop
    if acc_type == "dormant":
        lead["company_size_band"] = "dormant"
        log.debug("%s: dormant company", cn)
        return True

    # Try to fetch iXBRL for actual numbers
    financials = {}
    if acc_type != "micro-entity":
        # micro-entity accounts rarely disclose turnover; skip heavy fetch
        doc = fetch_ixbrl_doc(filing)
        if doc:
            financials = parse_ixbrl(doc)
            lead["accounts_source"] = "ch_ixbrl"

    # For micro-entity, still try to get the doc (employee count usually there)
    if acc_type == "micro-entity" and not financials:
        doc = fetch_ixbrl_doc(filing)
        if doc:
            financials = parse_ixbrl(doc)
            lead["accounts_source"] = "ch_ixbrl"

    turnover   = financials.get("turnover")
    net_assets = financials.get("net_assets")
    tot_assets = financials.get("total_assets")
    employees  = financials.get("employees")

    # Determine size band
    if turnover is not None:
        lead["turnover_amount"]   = round(turnover, 0)
        lead["company_size_band"] = size_band_from_turnover(turnover)
    elif acc_type == "micro-entity":
        lead["company_size_band"] = "<£1m"
    elif net_assets is not None:
        lead["company_size_band"] = size_band_from_net_assets(net_assets)
        lead["accounts_source"]   = "ch_ixbrl"
    else:
        lead["company_size_band"] = "unknown"

    if net_assets is not None:
        lead["net_assets"]        = round(net_assets, 0)
    if tot_assets is not None:
        lead["total_assets"]      = round(tot_assets, 0)
    if employees is not None:
        lead["employee_count"]    = employees
        lead["employee_band"]     = employee_band(employees)

    return True

# ── Main ─────────────────────────────────────────────────────────
def main():
    if not CH_KEY:
        log.error("COMPANIES_HOUSE_API_KEY not set — cannot fetch accounts")
        sys.exit(1)

    log.info("=== CH Accounts Enrichment ===")

    with open(DATA_FILE) as f:
        data = json.load(f)

    is_dict = isinstance(data, dict)
    leads   = list(data.values()) if is_dict else data
    keys    = list(data.keys())   if is_dict else None

    enriched = skipped = failed = 0

    for i, lead in enumerate(leads):
        if not isinstance(lead, dict):
            continue
        if not FORCE and lead.get("accounts_type"):
            skipped += 1
            continue
        if not lead.get("company_number"):
            skipped += 1
            continue

        co = lead.get("company_name", "?")[:40]
        try:
            ok = enrich_lead(lead)
            if ok:
                enriched += 1
                log.info(
                    "[%d/%d] %-40s  type=%-12s  size=%-12s  emp=%s",
                    i + 1, len(leads), co,
                    lead.get("accounts_type", "?"),
                    lead.get("company_size_band", "?"),
                    lead.get("employee_count", "—"),
                )
            else:
                failed += 1
        except Exception as e:
            log.warning("Error enriching %s: %s", co, e)
            failed += 1

    # Save
    out = {keys[i]: leads[i] for i in range(len(leads))} if is_dict else leads
    with open(DATA_FILE, "w") as f:
        json.dump(out, f, indent=2)

    # Copy to public dirs
    for dst in [
        ROOT / "public" / "data" / "leads.json",
        ROOT / "apps" / "web" / "public" / "data" / "leads.json",
    ]:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(DATA_FILE, dst)

    log.info("Done — enriched=%d  skipped=%d  failed=%d", enriched, skipped, failed)

    # Summary of size distribution
    bands = {}
    for lead in leads:
        if isinstance(lead, dict):
            b = lead.get("company_size_band", "unknown")
            bands[b] = bands.get(b, 0) + 1
    log.info("Size distribution: %s", "  ".join(f"{k}:{v}" for k, v in sorted(bands.items())))

    # Flag micro-entities for awareness
    micro = [l for l in leads if isinstance(l, dict) and l.get("accounts_type") == "micro-entity"]
    hot_micro = [l for l in micro if l.get("priority") in ("HOT", "WARM")]
    if hot_micro:
        log.info("%d HOT/WARM leads are micro-entities (very small — may be too small for FX):", len(hot_micro))
        for l in hot_micro[:5]:
            log.info("  %-40s  score=%s", l.get("company_name", "?")[:40], l.get("score", "?"))


if __name__ == "__main__":
    main()
