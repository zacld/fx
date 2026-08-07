# FX Discovery Engine

**Business exposure translator for UK B2B FX sales.**

Market event → commercial relevance filter → business impact translation → exposure-ranked target segments → company discovery → website validation → lead scoring → LinkedIn/outreach assist.

**Total API cost: ~£0/day (free tiers — one LLM call per market event, no per-company AI)**

---

## What it does

This is not a news summariser. It is a business exposure translator.

It turns:
> *"GBP/EUR fell after BoE comments"*

into:
> *"UK companies buying from European suppliers and selling in GBP face margin pressure. Target wine importers, European food distributors, furniture wholesalers, automotive parts distributors. Prioritise companies whose websites confirm import/export/European supplier activity."*

---

## Stack — zero paid APIs

| What | How | Cost |
|---|---|---|
| News ingestion | RSS feeds (BBC, Reuters, FXStreet, BoE, GOV.UK, Guardian, Sky) | Free |
| AI analysis | Groq (`llama-3.3-70b-versatile`) — one call per event, combined triage + exposure map; rule-based fallback on rate limit | Free tier |
| Company discovery | Companies House API | Free |
| Website discovery | Domain guessing + GET verification + DuckDuckGo / Bing fallback | Free |
| Website scraping | Direct HTTP (`fetch`) + cheerio | Free |
| Database | SQLite (`data/fx.db`, rebuilt each run from `data/*.json`) → JSON snapshot for the dashboard | Free |
| Scheduler | GitHub Actions cron | Free |
| Dashboard | React + Vite SPA (`apps/web`), GitHub Pages + Fly.io | Free |

Codebase: TypeScript npm-workspace monorepo — `packages/core` (schema, signals,
scoring, contacts, cache, DB), `packages/pipeline` (the CLI stages + sources),
`apps/web` (the dashboard). See `ARCHITECTURE_V2.md`.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/zacld/fx.git
cd fx
npm install                      # installs all workspaces
cp .env.example .env
# Edit .env — add your own GROQ_API_KEY and COMPANIES_HOUSE_API_KEY
```

Requires Node 20+. There is no Python.

### 2. Add GitHub Secrets

Repo → Settings → Secrets and variables → Actions

| Secret | Value |
|---|---|
| `GROQ_API_KEY` | Your Groq API key (from https://console.groq.com/keys) |
| `COMPANIES_HOUSE_API_KEY` | Your Companies House API key |
| `GROQ_MODEL` | *(optional)* defaults to `llama-3.3-70b-versatile` |
| `GOOGLE_SHEET_ID` | *(optional)* spreadsheet ID — turns on the Daily Call List export (see below) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | *(optional)* service-account JSON for that sheet |

### Optional: push the Daily Call List to Google Sheets

The `export-sheets` stage writes the top-25 HOT leads to a Google Sheet at the end of every pipeline run. Skipped silently when either secret is unset.

One-time setup:

1. **Create a Sheet.** New blank sheet → rename a tab to `Daily Call List` (or whatever you set `GOOGLE_SHEET_TAB` to). Copy the spreadsheet ID from the URL (the long string between `/d/` and `/edit`) — that's `GOOGLE_SHEET_ID`.
2. **Create a service account.** [Google Cloud Console](https://console.cloud.google.com/) → pick or create a project → enable the Google Sheets API → IAM & Admin → Service Accounts → Create. Then Keys → Add Key → JSON. Save that file.
3. **Share the sheet** with the service account's email (looks like `fx-bot@<project>.iam.gserviceaccount.com`) as **Editor**.
4. **Add the secrets.** Paste the spreadsheet ID into `GOOGLE_SHEET_ID`. Paste the entire JSON file contents into `GOOGLE_SERVICE_ACCOUNT_KEY` (raw or base64 — both work). Optional repo variable `GOOGLE_SHEET_TAB` overrides the default tab name.

Each run clears `A1:Z1000` of the tab and writes a header row plus up to 25 ranked call-ready leads (rank, ready score, company, website, segment, event, director, role, phone, email, route grade, FX signal count + samples, exposure thesis, LinkedIn search URLs, last-rescored timestamp).

> **Security:** Never put real API keys in this README, in any `.md` file, or in any committed file.  
> The `.env` file is in `.gitignore` and must never be committed.

### 3. Run locally

```bash
npm run pipeline                 # import → analyse → discover → enrich → score → dedup → export
npm run sync-web-data            # refresh the dashboard's data snapshot
npm run dev                      # run the dashboard locally
```

Or a single stage: `npm run analyse` · `npm run discover` · `npm run enrich-contacts` · `npm run score` · `npm run dedup`.
`npm test` / `npm run typecheck` cover `packages/core` + `packages/pipeline`.

---

## Pipeline

```
RSS feeds (7 sources)
  ↓
Commercial relevance pre-filter (rule-based, free, no API)
  ↓
Groq (llama-3.3-70b) — ONE call per event   [rule-based fallback on rate limit]
  · Commercial relevance score (1-10)
  · Business impact translation (what changed, who pays more)
  · Exposure-ranked target segments (4-6 specific business models)
  ↓
Companies House search + profile + director data
  ↓
Website discovery (domain guessing → GET verify → DuckDuckGo fallback)
  ↓
Website scraping — FX payment signals
  ↓
Lead scoring (exposure level + website confidence + FX signals + SIC code)
  ↓
Deduplication + multi-event trigger detection
  ↓
LinkedIn search link generation (manual — nothing auto-sent)
  ↓
Copy-ready outreach drafts (call opener, LinkedIn note, email)
```

---

## Lead scoring

| Signal | Points |
|---|---|
| Direct FX payment signals on website | 8–30 |
| Segment-specific website signals | up to 15 |
| Secondary international signals | up to 10 |
| Segment exposure level: Very High | +20 |
| Segment exposure level: High | +12 |
| Core trade/wholesale SIC code | +15 |
| Manufacturing/logistics SIC code | +10 |
| Website verified — high confidence | +25 |
| Website verified — medium/confirmed | +15 |
| Website guessed — low confidence | +8 |
| No website found | −20 |
| High urgency market event | +10 |
| Director identified | +5 |
| Active on Companies House | +5 |
| Company age: 10+ years | +5–8 |
| No FX evidence (gate) | cap at 39 |
| Multi-event trigger (same company flagged by 2+ events) | +4–8 |

**HOT** ≥ 80 · **WARM** 60–79 · **QUEUE** 40–59 · **SKIP** < 40

---

## Dashboard views

**Daily Call List** — HOT/WARM + verified website + at least 1 FX signal  
**Research Queue** — Lower confidence leads needing manual review  
**All Leads** — Full pipeline

---

## File structure

```
fx/
  packages/
    core/                  # @fx/core — schema (zod), signals, scoring (gates A–I),
      src/                 #   contacts, cache, SQLite/Drizzle (db/), repoRoot, db:import/export
    pipeline/              # @fx/pipeline — the CLI stages + sources
      src/
        stages/            #   analyse · discover · enrich-contacts · score · dedup
        sources/           #   rss · ai (Groq/Gemini) · search (DDG/Bing) · website ·
                           #   source-page-miner · companies-house · fetch · blocklists
        run.ts             #   per-run logging → runs table + data/runs/<id>.json
  apps/
    web/                   # @fx/web — React + Vite dashboard
      src/App.jsx          #   reads ${BASE_URL}data/{events,leads}.json
      public/data/         #   committed dashboard snapshot (refreshed by `npm run sync-web-data`)
  data/
    events.json leads.json # canonical pipeline output (committed; rebuilt into data/fx.db each run)
    fx.db                  # SQLite working db (gitignored)
    runs/  cache/          # run logs + HTTP/CH caches (gitignored)
  .github/workflows/
    discovery.yml          # Mon–Fri 6am cron — runs the TS pipeline, commits data/
    deploy.yml             # GitHub Pages   (build apps/web after a discovery run / push to main)
    deploy-fly.yml         # Fly.io         (same trigger)
  Dockerfile deploy/nginx.conf fly.toml   # Fly deployment of the dashboard
  .env.example             # template — copy to .env and fill in your keys
  ARCHITECTURE_V2.md       # monorepo layout + data model
```

---

## What this does NOT do

- No LinkedIn scraping or automation
- No auto-send of messages
- No paid enrichment APIs (Hunter, Apollo, Clearbit etc.)
- No automated email sending
- No CRM sync (status tracked in browser localStorage)

The system prepares research and copy-ready messages. The user manually opens LinkedIn, verifies the person, and sends.
