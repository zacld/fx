# Running the FX Discovery Pipeline

## Setup (one-time)

```bash
cd ~/Downloads/fx-discovery-v2
cp .env.example .env
```

Edit `.env` — add your keys:
```
GEMINI_API_KEY=AIzaSyBzleXGK9JzNWVxGsy74HFpIC--fS_m7tw
GEMINI_MODEL=gemini-2.0-flash
COMPANIES_HOUSE_API_KEY=bf190544-f3dd-4dd3-b60b-d897c8ffebf8
DISCOVERY_MAX_EVENTS=2
DISCOVERY_MAX_COMPANIES_PER_TERM=20
```

```bash
python3 -m pip install -r requirements.txt
```

---

## Run the pipeline

```bash
python3 scripts/run_pipeline.py
```

Or step by step:
```bash
python3 scripts/ingest.py       # pulls events, analyses with Gemini
python3 scripts/discover.py     # finds companies via Companies House
```

---

## Hitting 429 rate limits?

**This is a Gemini free-tier issue. Fix:**

**Option 1 — Run less at once (recommended):**
```bash
# In .env:
DISCOVERY_MAX_EVENTS=1
```
Then wait 60 seconds between runs.

**Option 2 — The pipeline now has a fallback:**
If Gemini returns 429, the system automatically creates a basic event
from the headline using keyword rules instead of failing.
So even with a rate limit, companies will still be discovered.

**Option 3 — Check what's already cached:**
```bash
python3 -c "import json; d=json.load(open('data/events.json')); [print(k[:20], v.get('status'), v.get('urgency_score')) for k,v in d.items()]"
```
If events show `status: ready`, run discover.py directly — no Gemini needed:
```bash
python3 scripts/discover.py
```

---

## Push updated data to live dashboard

```bash
git add data/ public/data/
git commit -m "data: pipeline run $(date +%Y-%m-%d)"
git push
```

Live dashboard updates at: https://zacld.github.io/fx

---

## Expected output

With correct setup:
- 2-5 events per run
- 15-40 companies per event  
- 75-200 total leads after a full run
- Each lead has: exposure thesis, LinkedIn links, outreach drafts
