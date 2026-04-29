# Running the FX Discovery Pipeline Locally

## One-time setup

```bash
cd ~/Downloads
unzip fx-discovery-v2-final.zip   # or wherever the zip is
cd fx-discovery-v2

# Copy env file and add your keys
cp .env.example .env
```

Edit `.env`:
```
GEMINI_API_KEY=AIzaSyBzleXGK9JzNWVxGsy74HFpIC--fS_m7tw
GEMINI_MODEL=gemini-2.0-flash
COMPANIES_HOUSE_API_KEY=bf190544-f3dd-4dd3-b60b-d897c8ffebf8
DISCOVERY_MAX_EVENTS=12
DISCOVERY_MAX_COMPANIES_PER_TERM=20
```

```bash
python3 -m pip install -r requirements.txt
```

## Run the full pipeline

```bash
python3 scripts/run_pipeline.py
```

This runs in order:
1. `ingest.py` — pulls live RSS feeds, analyses with Gemini, maps financial exposures
2. `discover.py` — searches Companies House, scrapes websites, scores by FX exposure
3. `linkedin_assist.py` — generates LinkedIn search links
4. `outreach.py` — drafts event-led messages

Then copies `data/events.json` and `data/leads.json` to `public/data/` for the dashboard.

## View the dashboard

```bash
npm install
npm run dev
```
Open http://localhost:5173

## How many companies will it find?

With the correct search strategy:
- Each event generates 8-12 Companies House search terms
- Each term returns up to 20 companies
- After filtering: expect 15-40 real leads per event
- 5 events = 75-200 total leads in the dashboard

## Push to GitHub (updates the live dashboard)

```bash
git add data/ public/data/
git commit -m "data: manual pipeline run $(date)"
git push
```

The live dashboard at https://zacld.github.io/fx updates automatically.
