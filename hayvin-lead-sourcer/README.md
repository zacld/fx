# hayvin_lead_sourcer

B2B lead sourcing for Hayvin (vape/battery recycling collection, pitching UK
retailers). Finds **company, contact name, role/title, email** — never phone
numbers, that's handled by a separate tool.

## Two tiers, two methods

**Tier 1 — major chains** (`config/tier1_targets.yaml`): a small, hand-curated
list of supermarkets, high-street chains and forecourt groups, crossed with a
list of target job titles. For each company:
1. A LinkedIn people-search URL is generated for manual lookup (output as a
   column — LinkedIn is never scraped, per its ToS).
2. The company's published sustainability/ESG report (PDF) and press/newsroom
   page (HTML) are fetched and scanned for named person + title pairs near
   one of the target titles. Rows are flagged `source: public_report` when a
   name was found this way, or `source: manual_linkedin_lookup_required`
   when it wasn't — never fabricated.

**Tier 2/3 — regional chains, forecourt groups, independents**
(`config/sic_codes.yaml`): a Companies House SIC-code sweep (same pattern as
`call-list-generator/generate_call_list.py`), with the officer/director list
as the contact-of-record fallback, cross-referenced against Google Places to
confirm the business is still trading and to pull its website domain (never
its phone field).

## Email resolution

For any (contact name, domain) pair:
1. Hunter.io (`HUNTER_API_KEY`) — verified person email, or the domain's
   confirmed pattern applied to the name. Confidence score recorded.
2. Fallback: common UK corporate patterns (`first.last@`, `flast@`,
   `first@`) generated locally, marked `email_source: unverified_guess`.

If no contact name was found, contact/email fields are left blank rather
than guessed — the row still ships so it's visible as "manual research
needed".

## Setup

```bash
pip install -r requirements.txt

export COMPANIES_HOUSE_API_KEY=...   # required for Tier 2/3 (free)
export GOOGLE_PLACES_API_KEY=...     # optional — domain/trading confirmation
export HUNTER_API_KEY=...            # optional — free tier: 25 searches + 1000 verifications/month
```

Every key is optional except `COMPANIES_HOUSE_API_KEY` (needed only for
Tier 2/3) — a missing key degrades that one enrichment step rather than
crashing the run.

## Usage

```bash
python3 main.py                                # both tiers -> hayvin_leads.csv
python3 main.py --tier1-only
python3 main.py --tier2-only --max-per-sic 50
python3 main.py --output leads.csv
```

## Output

A single CSV (`hayvin_leads.csv` by default), same shape/spirit as the
existing Cognism CSV pipeline so it can slot into the same downstream
workflow:

```
tier, company_name, companies_house_number, domain, contact_name, role_title,
email, email_source, email_confidence, linkedin_search_url, source_notes, phone
```

`phone` is always blank — filled in manually later via free-credit lookups,
by design.

## Structure

```
config/tier1_targets.yaml   — editable company + title list
config/sic_codes.yaml       — editable SIC code list for Tier 2/3
sourcer/companies_house.py  — CH Advanced Search + officers API
sourcer/google_places.py    — trading-status + domain confirmation (Places API, new)
sourcer/hunter.py           — Hunter.io domain search + email finder
sourcer/report_scraper.py   — sustainability-report (PDF) + press-page (HTML) contact extraction
sourcer/email_guesser.py    — fallback UK corporate email-pattern generation
main.py                     — orchestrates both tiers, writes the CSV
```

## What this tool deliberately does not do

- No LinkedIn scraping — only generates search URLs for manual lookup.
- No phone number lookup of any kind, from any source.
- No automated outreach — this is a discovery/research tool only.
- No name fabrication — a row with no found contact ships with blank
  contact fields, not a guess.
