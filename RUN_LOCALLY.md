# Running the FX Discovery pipeline locally

## ⚠️ Key security note

Never commit real API keys to this repo. If you have previously seen keys in this
file (or pasted one into a chat), rotate it immediately:
- Groq: https://console.groq.com/keys
- Companies House: https://developer.company-information.service.gov.uk/

The `.env` file is in `.gitignore` and must never be committed. Keys also belong in
GitHub Actions secrets (`GROQ_API_KEY`, `COMPANIES_HOUSE_API_KEY`) — never in code.

---

## Setup (one-time)

```bash
git clone https://github.com/zacld/fx.git
cd fx
npm install        # installs all workspaces (Node 20+; no Python)
cp .env.example .env
```

Edit `.env` — the keys that matter:
```
AI_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=llama-3.3-70b-versatile
COMPANIES_HOUSE_API_KEY=your_companies_house_key_here
DISCOVERY_MAX_EVENTS=2
```

---

## Run the pipeline

```bash
npm run pipeline       # import → analyse → discover → enrich-contacts → score → dedup → export
npm run sync-web-data  # copy data/*.json → apps/web/public/data/ (what the dashboard serves)
```

Or one stage at a time (each is idempotent — safe to re-run; reads/writes `data/fx.db`):
```bash
npm run db:import         # data/{events,leads}.json → data/fx.db
npm run analyse           # RSS → relevance filter → 1 LLM call/event → events table
npm run discover          # events → DuckDuckGo/Bing + Companies House → website-validated leads
npm run enrich-contacts   # backfill phone/email/contact-page for leads with a website
npm run score             # gate-based lead scoring (= rescore.py's rescore())
npm run dedup             # CN/domain dedup + multi-event boost + drop SKIP
npm run db:export         # data/fx.db → data/{events,leads}.json
```

`npm test` and `npm run typecheck` cover `packages/core` + `packages/pipeline`.

---

## Hitting 429 rate limits?

`analyse` makes ONE LLM call per event. If the provider returns 429 it builds a
rule-based event from the headline instead of failing — `discover` still runs. To
slow down: lower `DISCOVERY_MAX_EVENTS` in `.env` and re-run.

Already-analysed events are skipped (the `events` table is the dedup key), so
re-running `analyse` is cheap. To check what's cached:
```bash
node --input-type=commonjs -e "const d=require('./data/events.json');for(const[k,v]of Object.entries(d))console.log(k.slice(0,16),v.status,v.urgency_score)"
```
If events show `status: ready`, run `npm run discover` directly — no LLM calls needed.

---

## Push updated data to the live dashboard

```bash
git add data/events.json data/leads.json apps/web/public/data/
git commit -m "data: pipeline run $(date +%Y-%m-%d)"
git push
```

The deploy workflows redeploy the dashboard automatically (GitHub Pages:
https://zacld.github.io/fx · Fly: https://fx-discovery-dashboard.fly.dev/).
In production the daily run happens in GitHub Actions — see `.github/workflows/discovery.yml`.

---

## Expected output

With correct setup, per full run:
- a handful of new events (≈ `DISCOVERY_MAX_EVENTS`)
- 15–40 candidate companies per scraped segment
- ~75–200 leads after dedup
- each lead: exposure thesis, website evidence, contact route, Companies-House director (if found)
