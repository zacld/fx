# FX Discovery Engine v1

**Total API cost: ~£0.002/day**

Market event → affected sectors → UK companies → FX score → lead cards

---

## Stack — zero paid APIs

| What | How | Cost |
|---|---|---|
| News ingestion | RSS feeds (FXStreet, BoE, BBC, Reuters, GOV.UK) | Free |
| AI analysis | Anthropic Claude API (your key) | ~£0.002/day |
| Company discovery | Companies House API (your key) | Free |
| Website scraping | Direct HTTP + BeautifulSoup | Free |
| Database | JSON files in this repo | Free |
| Scheduler | GitHub Actions cron | Free |
| Dashboard hosting | GitHub Pages | Free |

---

## Setup — do this once

### 1. Clone and install

```bash
git clone https://github.com/zacld/fx.git
cd fx
cp .env.example .env
# .env already has your Companies House key — just add your Anthropic key
```

### 2. Install Python deps

```bash
pip install -r requirements.txt
```

### 3. Add GitHub Secrets

Repo → Settings → Secrets and variables → Actions

| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `ANTHROPIC_MODEL` | `claude-3-5-sonnet-latest` |
| `COMPANIES_HOUSE_API_KEY` | `bf190544-f3dd-4dd3-b60b-d897c8ffebf8` |

### 4. Test locally

```bash
# Pull news + Claude analysis → data/events.json
python scripts/ingest.py

# Find companies + score → data/leads.json
python scripts/discover.py

# Run dashboard
npm install
npm run dev
```

---

## How it works

**ingest.py** pulls 5 RSS feeds every morning, filters for FX-relevant headlines (tariffs, rate changes, currency moves, trade policy etc.), sends each to Claude API, gets back structured JSON with affected sectors, urgency score, and Companies House search terms. Writes to `data/events.json`.

**discover.py** reads events with `status: ready`, searches Companies House for each generated term, fetches the full company profile and directors, scrapes the company website for import/export signals, scores each company 0-100, and writes lead cards to `data/leads.json`.

**GitHub Actions** runs both scripts at 6am Mon-Fri and commits the updated JSON files back to the repo. The dashboard reads these files directly.

---

## Scoring

| Signal | Points |
|---|---|
| High urgency event (7+/10) | 25 |
| Import/export website signals | Up to 25 |
| High-FX SIC code | 20 |
| Company name suggests FX sector | 20 |
| Website + address found | 15 |
| Active on Companies House | 15 |

**HOT** 80-100 · **WARM** 60-79 · **QUEUE** 40-59 · **SKIP** <40 (not saved)

---

## File structure

```
fx/
  scripts/
    ingest.py          # RSS → Claude → data/events.json
    discover.py        # Events → Companies House → data/leads.json
  src/
    App.jsx            # React dashboard
  data/
    events.json        # Auto-updated by GitHub Actions
    leads.json         # Auto-updated by GitHub Actions
  public/
    data/              # Copied here so dashboard can read them
  .github/workflows/
    discovery.yml      # Mon-Fri 6am cron
  requirements.txt
  .env.example
```

---

## Phase 2 (after discovery is proven)

- Hunter.io email discovery per director
- LinkedIn search URL generation
- Call opener generator (Claude API)
- Email draft per lead
- Pipeline status tracking
