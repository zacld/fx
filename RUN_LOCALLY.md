# Running the FX Discovery Pipeline

## ⚠️ Key security note

Never commit real API keys to this repo.
If you have previously seen keys in this file, rotate them immediately:
- Gemini: https://aistudio.google.com/app/apikey
- Companies House: https://developer.company-information.service.gov.uk/

The `.env` file is in `.gitignore` and must never be committed.

---

## Setup (one-time)

```bash
git clone https://github.com/zacld/fx.git
cd fx
cp .env.example .env
```

Edit `.env` — add your keys:
```
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.0-flash
COMPANIES_HOUSE_API_KEY=your_companies_house_key_here
DISCOVERY_MAX_EVENTS=2
DISCOVERY_MAX_COMPANIES_PER_TERM=20
```

```bash
pip install -r requirements.txt
```

---

## Run the pipeline

```bash
python3 scripts/run_pipeline.py
```

Or step by step:
```bash
python3 scripts/ingest.py       # RSS → commercial relevance filter → Gemini analysis → events.json
python3 scripts/discover.py     # events.json → Companies House → leads.json
python3 scripts/enrich_websites.py  # backfill websites for leads without one
python3 scripts/rescore.py      # re-score all leads, dedup, compute confidence
python3 scripts/linkedin_assist.py  # generate LinkedIn search links
python3 scripts/outreach.py     # generate copy-ready outreach drafts (optional, uses Gemini)
```

---

## Hitting 429 rate limits?

ingest.py now uses ONE Gemini call per event (combined triage + exposure map).
This halves API usage vs previous versions.

**Option 1 — Run fewer events at once (recommended):**
```bash
# In .env:
DISCOVERY_MAX_EVENTS=1
```
Then wait 60 seconds between runs.

**Option 2 — The pipeline has automatic fallback:**
If Gemini returns 429, the system creates a basic event from the headline
using rule-based keyword matching instead of failing. So even on rate limits,
companies will still be discovered.

**Option 3 — Check what's already cached:**
```bash
python3 -c "import json; d=json.load(open('data/events.json')); [print(k[:20], v.get('status'), v.get('urgency_score')) for k,v in d.items()]"
```
If events show `status: ready`, run `discover.py` directly — no Gemini calls needed.

---

## Push updated data to live dashboard

```bash
git add data/ public/data/
git commit -m "data: pipeline run $(date +%Y-%m-%d)"
git push
```

Live dashboard: https://zacld.github.io/fx

---

## Expected output

With correct setup:
- 2-5 events per run (depending on DISCOVERY_MAX_EVENTS)
- 15-40 companies per event
- 75-200 total leads after a full run
- Each lead has: exposure thesis, website evidence, LinkedIn links, outreach drafts
