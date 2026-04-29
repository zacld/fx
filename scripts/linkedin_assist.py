"""
FX Discovery — linkedin_assist.py
Generates LinkedIn search links and outreach drafts for each lead.
Does NOT automate LinkedIn — generates links you open manually.
"""

import json, logging
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
    "Procurement Director",
    "Operations Director",
    "Founder",
    "CEO",
    "Financial Controller",
]

def linkedin_company_search(company_name):
    q = quote(company_name)
    return f"https://www.linkedin.com/search/results/companies/?keywords={q}"

def linkedin_people_searches(company_name):
    results = []
    for role in DECISION_MAKER_ROLES[:6]:  # top 6 roles
        q = quote(f"{company_name} {role}")
        results.append({
            "role": role,
            "url": f"https://www.linkedin.com/search/results/people/?keywords={q}"
        })
    return results

def google_fallback_searches(company_name):
    name_q = quote(f'"{company_name}"')
    results = []
    for role in ["Finance Director", "Managing Director", "CFO"]:
        role_q = quote(f'"{role}"')
        results.append({
            "role": role,
            "url": f"https://www.google.com/search?q=site:linkedin.com/in+{name_q}+{role_q}"
        })
    results.append({
        "role": "Company page",
        "url": f"https://www.google.com/search?q=site:linkedin.com/company+{name_q}"
    })
    return results

def generate_linkedin_assist(lead):
    name = lead.get("company_name", "the company")
    return {
        "company_search":    linkedin_company_search(name),
        "people_searches":   linkedin_people_searches(name),
        "google_fallbacks":  google_fallback_searches(name),
    }

def main():
    log.info("=== LinkedIn Assist — generating search links ===")
    if not LEADS_FILE.exists():
        log.warning("No leads.json found — run discover.py first")
        return

    leads = json.loads(LEADS_FILE.read_text())
    updated = 0

    for lid, lead in leads.items():
        if "linkedin_assist" not in lead:
            lead["linkedin_assist"] = generate_linkedin_assist(lead)
            updated += 1

    LEADS_FILE.write_text(json.dumps(leads, indent=2))
    log.info("=== Done: %d leads updated with LinkedIn links ===", updated)

if __name__ == "__main__":
    main()
