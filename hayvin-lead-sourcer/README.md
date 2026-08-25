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
as the contact-of-record fallback. No domain/email source for this tier —
Tier 1's named chains are the real target, so Tier 2/3 rows ship with
company name, Companies House number, director name/role, and a LinkedIn
search URL only; domain and email are always blank, flagged for manual
research.

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

## Running as a live URL (server.py)

`main.py` is the CLI; `server.py` is a thin stdlib-only HTTP wrapper around
the same pipeline, for deploying as a live URL (e.g. Fly.io — `fly.toml` and
`Dockerfile` are set up for that, matching the pattern of the rest of this
repo). It does **not** run the pipeline on a schedule — the pipeline makes
real, quota-limited third-party API calls, so runs are only triggered on
demand.

```bash
python3 server.py                 # local: listens on :8080 (or $PORT)
```

Endpoints:
| | |
|---|---|
| `GET /health` | `{"status": "ok"}` |
| `POST /run` | Kicks off a run in the background. Optional JSON body: `{"tier1_only": bool, "tier2_only": bool, "max_per_sic": int}`. Returns `202` immediately, `409` if a run is already in progress. |
| `GET /status` | `{"status": "idle\|running\|done\|error", "started_at", "finished_at", "row_count", "error"}` |
| `GET /leads.csv` | The most recently completed run's CSV. `404` until a run has finished. |

```bash
curl -X POST -H "X-Trigger-Token: $TRIGGER_TOKEN" https://your-app.fly.dev/run
curl https://your-app.fly.dev/status
curl -O https://your-app.fly.dev/leads.csv
```

Set `TRIGGER_TOKEN` to require a matching `X-Trigger-Token` header on
`POST /run` — recommended once this is live at a public URL, since an
untriggered `/run` can burn your Hunter.io quota. Without it, `/run`
is open to anyone who can reach the URL.

Deploy:
```bash
cd hayvin-lead-sourcer
flyctl launch --no-deploy
flyctl secrets set COMPANIES_HOUSE_API_KEY=... HUNTER_API_KEY=... TRIGGER_TOKEN=...
flyctl deploy
```
(Fly's free trial requires a payment method on file before it will assign a
region — if you'd rather not add one, use the Vercel deployment below
instead.)

## Running on Vercel instead (api/run.py)

`api/run.py` and `api/health.py` are Vercel Python functions covering the
same pipeline, for a deploy target that doesn't need a Fly.io payment method.

**This is a different shape than `server.py`, not just a different host.**
Vercel Python functions are stateless request/response — no persistent
background thread, no in-memory state across invocations, and each
invocation has a hard execution-time cap (`vercel.json` sets
`maxDuration: 60` for `api/run.py`; your plan may allow more or cap you
lower). So there's no `/status` polling here:

| | |
|---|---|
| `GET /api/health` | `{"status": "ok"}` |
| `GET /api/run` | Usage info |
| `POST /api/run` | Runs the pipeline **synchronously in the request** and returns the CSV directly. Same optional JSON body as the Fly version: `{"tier1_only": bool, "tier2_only": bool, "max_per_sic": int}`. |

Keep runs small enough to finish inside the timeout — `tier1_only: true`,
or a low `max_per_sic` for Tier 2/3 — otherwise the function is killed
mid-run with nothing returned.

```bash
curl -X POST \
  -H "X-Trigger-Token: $TRIGGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tier1_only": true}' \
  https://your-project.vercel.app/api/run \
  -o hayvin_leads.csv
```

Deploy:
```bash
npm install -g vercel
cd hayvin-lead-sourcer
vercel login
vercel link
vercel env add COMPANIES_HOUSE_API_KEY
vercel env add HUNTER_API_KEY
vercel env add TRIGGER_TOKEN
vercel deploy --prod
```
`vercel env add` prompts you to paste the value and pick which
environments (Production/Preview/Development) it applies to — every key is
optional except Companies House, same as everywhere else in this tool.

## Structure

```
config/tier1_targets.yaml   — editable company + title list
config/sic_codes.yaml       — editable SIC code list for Tier 2/3
sourcer/companies_house.py  — CH Advanced Search + officers API
sourcer/hunter.py           — Hunter.io domain search + email finder
sourcer/report_scraper.py   — sustainability-report (PDF) + press-page (HTML) contact extraction
sourcer/email_guesser.py    — fallback UK corporate email-pattern generation
main.py                     — orchestrates both tiers, writes the CSV (CLI)
server.py                   — stdlib HTTP wrapper around main.py, for a live URL (Fly.io)
Dockerfile, fly.toml        — deploy server.py to Fly.io
api/run.py, api/health.py   — Vercel Python functions covering the same pipeline
vercel.json                 — Vercel deploy config (function timeouts)
```

## What this tool deliberately does not do

- No LinkedIn scraping — only generates search URLs for manual lookup.
- No phone number lookup of any kind, from any source.
- No automated outreach — this is a discovery/research tool only.
- No name fabrication — a row with no found contact ships with blank
  contact fields, not a guess.
