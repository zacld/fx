# Niche Finder Engine

Finds and ranks £10m+ UK business categories with hidden FX exposure that other brokers aren't already heavily targeting.

## Quick start

```bash
cd niche-finder
pip install -r requirements.txt

# Structural niches only — no API key needed
python main.py

# + competition check (requires ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY=sk-ant-...
python main.py --check-competition

# + score new contingent candidates
python main.py --contingent data/example_contingent.csv

# Recheck stale competition data (older than 30 days by default)
python main.py --recheck-competition
python main.py --recheck-competition --older-than-days 14

# Preview the dashboard locally
cd dashboard && python -m http.server 8080
# open http://localhost:8080
```

Output files written to the current directory:
- `niche_finder_niches.json` — dashboard source
- `niche_finder_niches.csv` — spreadsheet-friendly view
- `dashboard/data/niches.json` — dashboard copy (auto-updated)

## Why structural vs contingent?

**Structural niches** are business models that *cannot operate without crossing a currency boundary*. The model itself is the proof — no API call is needed. A UK CNC machine shop buys German/Japanese machine tools. Full stop. The FX exposure is structural and permanent.

There are exactly **6 structural mechanisms**:
1. Overseas capital equipment purchasing
2. Offshore labour outsourcing
3. Direct international freight payment
4. US-domiciled platform spend (AWS / Azure / GCP / Salesforce)
5. Globally-priced commodity trading
6. Cross-border risk writing and financing

Each expands to 2–3 concrete UK niches. Adding a 7th mechanism should be rare — a tempting addition is almost certainly a contingent niche in disguise.

**Contingent niches** are business models that *might* have FX exposure depending on a specific client or vendor relationship. Example: a UK audiobook studio listing US publishers as clients — probably USD, but could be GBP via a UK intermediary. The API call searches for public evidence (trade press, company filings, association data) confirming the relationship involves a foreign currency.

## Why competition gets rechecked but mechanism strength doesn't

Mechanism strength is a structural fact about how the business model works. A CNC machine shop has always bought German machine tools and always will — that doesn't change. Mechanism strength is set once (by the structural table for structural niches, or by the API's contingent scoring call) and never needs re-verifying.

Competition is market state — it reflects how many FX brokers are already actively publishing targeted content for a given niche. A niche that's `very_low` today can become `moderate` in six months once another broker writes a blog post about it. The `competition_checked_at` timestamp tracks when competition was last verified, and `--recheck-competition` re-runs the search for niches past the staleness threshold (default 30 days).

This is the distinction most likely to get lost six months from now, so it's worth repeating:
- **Mechanism strength** = stable structural fact. Re-verify only if the industry fundamentally changes.
- **Competition** = market state. Recheck every 30 days.

## Adding new contingent candidates

Create a CSV with these columns:

```csv
niche,mechanism_hypothesis,payer_profile_hint
UK audiobook studios,US publishers pay UK studios directly in USD,Hollywood / OTT Studios
UK medical device distributors,European manufacturers invoice UK distributors in EUR,
```

Then run:
```bash
python main.py --contingent my_candidates.csv --check-competition
```

Rejected niches (no public evidence found) are logged but excluded from output. They're one-time gates — running again won't change a reject unless you can point to new evidence.

## Payer profile table

`data/payer_profiles.json` is a lookup of counterparties whose payment currency is already established. Any contingent niche whose client or vendor matches an entry inherits that confidence for free — no search needed to confirm the currency.

Seed entries: AWS/Azure/GCP (USD), Salesforce/Oracle/SAP (USD), Hollywood/OTT studios (USD), LME commodity benchmarks (USD), IATA airfreight (USD), GAFTA soft commodity contracts (USD).

To add a new payer, append to the `profiles` array in `data/payer_profiles.json`.

## Ranking

Niches are ranked by three separate axes (not blended into a composite score):

1. **Competition** (primary) — lowest first (`very_low` → `very_high`)
2. **Mechanism strength** (secondary) — highest first (`confirmed` → `weak_inferred`)
3. **Volume bucket** (tertiary) — `small` ranks below the other three tiers, which are treated as roughly equivalent

The dashboard lets you sort by any column and filter by any axis.

## GitHub Pages deployment

The GitHub Actions workflow (`.github/workflows/niche-finder-pages.yml`) deploys the dashboard to GitHub Pages on every push to `main` that touches `niche-finder/`.

To enable:
1. Repo → Settings → Pages → Source: **GitHub Actions**
2. Add `ANTHROPIC_API_KEY` to repo secrets (optional — needed for competition checks in CI)

The workflow runs structural generation by default (no key needed). If `ANTHROPIC_API_KEY` is set, it also rechecks stale competition data. Trigger a manual competition run via Actions → "Run workflow" → check "Run competition check".
