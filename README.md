# FX Discovery Engine

**Business exposure translator for UK B2B FX sales.**

Market event → commercial relevance filter → business impact translation → exposure-ranked target segments → company discovery → website validation → lead scoring → LinkedIn/outreach assist.

**Total API cost: ~£0.002/day**

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
| AI analysis | Gemini 2.0 Flash (one call per event — combined triage + exposure map) | ~£0.002/day |
| Company discovery | Companies House API | Free |
| Website discovery | Domain guessing + GET verification + DuckDuckGo fallback | Free |
| Website scraping | Direct HTTP + BeautifulSoup | Free |
| Database | JSON files in this repo | Free |
| Scheduler | GitHub Actions cron | Free |
| Dashboard | React SPA, GitHub Pages | Free |

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/zacld/fx.git
cd fx
cp .env.example .env
# Edit .env — add your own Gemini and Companies House keys
```

### 2. Install Python deps

```bash
pip install -r requirements.txt
```

### 3. Add GitHub Secrets

Repo → Settings → Secrets and variables → Actions

| Secret | Value |
|---|---|
| `GEMINI_API_KEY` | Your Gemini API key (from Google AI Studio) |
| `GEMINI_MODEL` | `gemini-2.0-flash` |
| `COMPANIES_HOUSE_API_KEY` | Your Companies House API key |

> **Security:** Never put real API keys in this README, in any `.md` file, or in any committed file.  
> The `.env` file is in `.gitignore` and must never be committed.

### 4. Test locally

```bash
python3 scripts/ingest.py       # Pull news events + analyse with Gemini
python3 scripts/discover.py     # Find companies via Companies House
python3 scripts/enrich_websites.py  # Backfill websites for existing leads
python3 scripts/rescore.py      # Re-score + deduplicate leads
npm install && npm run dev       # Run dashboard locally
```

---

## Pipeline

```
RSS feeds (7 sources)
  ↓
Commercial relevance pre-filter (rule-based, free, no API)
  ↓
Gemini 2.0 Flash — ONE call per event
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
  scripts/
    ingest.py            # RSS → Gemini (1 call) → events.json
    exposure_mapper.py   # Standalone exposure mapper (also used as module)
    discover.py          # Events → Companies House + website → leads.json
    enrich_websites.py   # Backfill websites for leads without one
    rescore.py           # Re-score + dedup + multi-event detection
    website_finder.py    # Domain guessing + DuckDuckGo fallback
    linkedin_assist.py   # Generate LinkedIn search links (no scraping)
    outreach.py          # Copy-ready outreach drafts (Gemini)
    ch_search_strategy.py # Companies House search term strategy
    run_pipeline.py      # Run full pipeline in order
  src/
    App.jsx              # React dashboard
  data/
    events.json          # Updated by pipeline
    leads.json           # Updated by pipeline
  public/
    data/                # Copied here for GitHub Pages
  .github/workflows/
    discovery.yml        # Mon–Fri 6am cron + manual trigger
  .env.example           # Template — copy to .env and fill in your keys
  requirements.txt
```

---

## What this does NOT do

- No LinkedIn scraping or automation
- No auto-send of messages
- No paid enrichment APIs (Hunter, Apollo, Clearbit etc.)
- No automated email sending
- No CRM sync (status tracked in browser localStorage)

The system prepares research and copy-ready messages. The user manually opens LinkedIn, verifies the person, and sends.
