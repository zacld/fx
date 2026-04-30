"""
FX Discovery — linkedin_assist.py
Generates LinkedIn search links and outreach drafts for each lead.
Does NOT automate LinkedIn — generates links you open manually.
"""

import json, logging, re
from pathlib import Path
from urllib.parse import quote

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s")
log = logging.getLogger(__name__)

DATA_DIR   = Path(__file__).parent.parent / "data"
LEADS_FILE = DATA_DIR / "leads.json"

DECISION_MAKER_ROLES = [
    "Finance Director",
    "Managing Director",
    "CFO",
    "Chief Financial Officer",
    "Commercial Director",
    "Founder",
    "CEO",
    "Financial Controller",
]

# Patterns to strip from Companies House legal names before searching LinkedIn
_STRIP_SUFFIXES = re.compile(
    r"""
    \s*
    (
      \bltd\.?$          |   # Ltd, Ltd.
      \blimited\.?$      |   # Limited
      \bplc\.?$          |   # PLC
      \bllp\.?$          |   # LLP
      \blp\.?$           |   # LP
      \binc\.?$          |   # Inc
      \bcorporation\.?$  |   # Corporation
      \bcorp\.?$         |   # Corp
      \b&\s+co\.?$       |   # & Co
      \bco\.?$           |   # Co.
      \bholdings?\.?$        # Holdings / Holding
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)

_STRIP_QUALIFIERS = re.compile(
    r"""
    \s*
    (
      \buk\s*&\s*ireland\b  |   # UK & Ireland
      \b&\s*ireland\b       |   # & Ireland
      \buk\s*limited\b      |   # UK Limited
      \buk\s*ltd\b          |   # UK Ltd
      \(uk\)                |   # (UK)
      \(holdings?\)         |   # (Holdings)
      \(wholesale\)         |   # (Wholesale)
      \(trading\)           |   # (Trading)
      \(manufacturing\)         # (Manufacturing)
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)

def clean_name(company_name):
    """Strip legal suffixes and UK qualifiers so LinkedIn can find it."""
    name = company_name.strip()
    # Remove parenthetical suffixes first (e.g. "(UK) Ltd")
    name = _STRIP_QUALIFIERS.sub("", name)
    # Remove trailing legal type repeatedly (handles "& Co Ltd")
    for _ in range(3):
        stripped = _STRIP_SUFFIXES.sub("", name).strip().rstrip(".,")
        if stripped == name:
            break
        name = stripped
    # Remove trailing & or - or ,
    name = re.sub(r"[\s&,\-]+$", "", name).strip()
    return name or company_name


def linkedin_company_search(clean):
    return f"https://www.linkedin.com/search/results/companies/?keywords={quote(clean)}"

def linkedin_person_search(director_name, clean_company):
    """Direct search by director name — far more reliable than role-based."""
    return f"https://www.linkedin.com/search/results/people/?keywords={quote(director_name)}"

def linkedin_role_searches(clean_company):
    results = []
    for role in DECISION_MAKER_ROLES[:5]:
        results.append({
            "role": role,
            "url": f"https://www.linkedin.com/search/results/people/?keywords={quote(clean_company + ' ' + role)}"
        })
    return results

def google_fallbacks(company_name, clean, director_name):
    results = []
    # Director name search is the most reliable starting point
    if director_name:
        results.append({
            "role": f"Find {director_name.split()[0]} on LinkedIn",
            "url": f"https://www.google.com/search?q=site:linkedin.com/in+{quote(director_name)}"
        })
    # Company page search using cleaned name
    results.append({
        "role": "Company page",
        "url": f"https://www.google.com/search?q=site:linkedin.com/company+{quote(clean)}"
    })
    # Role searches as backup
    for role in ["Finance Director", "Managing Director"]:
        results.append({
            "role": role,
            "url": f"https://www.google.com/search?q=site:linkedin.com/in+{quote(clean)}+{quote(role)}"
        })
    return results

def generate_linkedin_assist(lead):
    name     = lead.get("company_name", "")
    director = lead.get("director_name", "")
    clean    = clean_name(name)

    assist = {
        "search_name":    clean,          # the cleaned name used in searches
        "company_search": linkedin_company_search(clean),
        "people_searches": [],
        "google_fallbacks": google_fallbacks(name, clean, director),
    }

    # Lead with director: direct name search first, then role searches
    if director:
        assist["people_searches"].append({
            "role": f"{director} (direct search)",
            "url":  linkedin_person_search(director, clean),
        })

    assist["people_searches"].extend(linkedin_role_searches(clean))
    return assist


def main():
    log.info("=== LinkedIn Assist — generating search links ===")
    if not LEADS_FILE.exists():
        log.warning("No leads.json found — run discover.py first")
        return

    leads = json.loads(LEADS_FILE.read_text())
    updated = 0

    for lid, lead in leads.items():
        lead["linkedin_assist"] = generate_linkedin_assist(lead)
        updated += 1

    LEADS_FILE.write_text(json.dumps(leads, indent=2))

    # Sync to public/data/
    public = Path(__file__).parent.parent / "public" / "data"
    public.mkdir(parents=True, exist_ok=True)
    (public / "leads.json").write_text(LEADS_FILE.read_text())

    log.info("=== Done: %d leads updated with LinkedIn links ===", updated)


if __name__ == "__main__":
    main()
