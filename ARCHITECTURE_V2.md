# FX Discovery — v2 architecture (TypeScript rewrite)

Status: **complete**. The TypeScript npm-workspace monorepo is the implementation;
the original Python pipeline (`scripts/*.py`) has been ported 1:1 — same Brain 1/2
prompt, same scoring gates, verified at parity (`import → score → dedup` reproduces
`rescore.py`'s `(score, priority)` for every lead) — and removed. The daily run is
`.github/workflows/discovery.yml` (→ `npm run pipeline`). Nothing here changes
Brain 1/2 prompt logic or the scoring gates — `CLAUDE.md` still governs the
*behaviour*; this file describes the *structure*. The `scripts/X.py` names that
appear in source comments below are historical provenance (see git history).

## Why

- `leads.json`-in-git is the de-facto database → merge churn, conflicts, no querying, the
  "read the whole blob / rewrite the whole blob" pattern in `rescore.py`.
- No schema → fields drift; three scorers historically; signal lists copy-pasted into 3
  files.
- Monolithic scripts (`discover_web.py` ≈ 2,200 lines) → big merge surface.
- Sync `requests` + `time.sleep` pacing → slow; the work is I/O-bound.
- Frontend is already React → unifying on TypeScript means one language, one toolchain,
  shared types between pipeline and dashboard, compile-time field-drift detection, and
  ergonomic controlled concurrency.

## Target layout (monorepo)

```
fx/
  packages/
    core/                 # @fx/core — no I/O beyond the DB; the shared domain
      src/
        schema.ts         # zod schemas + inferred types — THE data model
        signals.ts        # FX / origin-hint / B2B / negative signals + classifyText()
        scoring.ts        # scoreLead() — the ONE gate-based scorer (faithful port of rescore.py)
        contacts.ts       # extractContactInfo() + best_contact_route (port of contacts.py)
        cache.ts          # generic TTL file cache (CH / website HTML)
        paths.ts          # repoRoot() — resolve data/… relative to the monorepo root
        db/
          schema.ts       # Drizzle SQLite table definitions (events, leads, lead_evidence, runs, crm)
          index.ts        # getDb() / ensureSchema()
          import-json.ts  # data/{events,leads}.json → SQLite   (`npm run db:import`)
          export-json.ts  # SQLite → data/{events,leads}.json   (`npm run db:export`)
        index.ts
      test/
    pipeline/             # @fx/pipeline — the CLI stages + sources (depends on @fx/core)
      src/
        stages/
          analyse.ts      # RSS → relevance filter → 1 LLM call/event: FX impact + niche map (Brain 1+2, prompt UNCHANGED)
          discover.ts     # search (DDG→Bing→CH) → source-page mining → website validate → CH validate
          enrich-contacts.ts  # backfill phone/email/contact-page for leads with a website
          score.ts        # apply core/scoring over the leads table; export data/leads.json
          dedup.ts        # CN/domain dedup + multi-event boost + drop SKIP; re-export data/leads.json
        sources/          # rss.ts, ai.ts (Groq/Gemini), search.ts (DDG/Bing), website.ts,
                          #   source-page-miner.ts, companies-house.ts, fetch.ts, blocklists.ts
        run.ts            # RunRecorder — writes a `runs` row + data/runs/<id>.json
        dev/compare-scores.ts   # informational scoring-parity check vs the committed leads.json
  apps/
    web/                  # @fx/web — the React + Vite dashboard (moved from ./src)
      src/App.jsx index.html vite.config.js public/data/
  data/
    events.json leads.json  # canonical pipeline output (committed; rebuilt into fx.db each run)
    fx.db                   # SQLite working db (gitignored)
    runs/ cache/            # run logs + HTTP/CH caches (gitignored)
  .github/workflows/        # discovery.yml (TS pipeline cron), deploy.yml (Pages), deploy-fly.yml (Fly)
  Dockerfile deploy/nginx.conf fly.toml   # Fly deployment of the dashboard
```

Tooling: npm workspaces, `tsx` to run TS directly, `vitest` for tests, `drizzle-orm` +
`better-sqlite3` for the DB, `zod` for schema, `cheerio` for HTML/XML parsing (≈
BeautifulSoup), Node's global `fetch` + `AbortSignal.timeout` for HTTP, `p-limit` for
controlled concurrency, Groq's OpenAI-compatible chat-completions API for the analyse call
(Gemini still selectable via `AI_PROVIDER=gemini`).

## Data model (DB tables → zod schemas in `packages/core/src/schema.ts`)

- **events** — one row per market event (Brain 1 output): headline, type, breadth,
  currency pairs, affected payment flow, business impact summary, relevance/urgency, AI
  provider, fallback flag.
- **segments** — Brain 2 output, FK → event: name, business model, exposure level/type,
  why-affected, fx-payment-logic, margin/timing risk, `category_priority_score`,
  `micro_categories` (JSON), CH terms, validation signals, sales angle, thesis template.
- **companies** — one row per real company (dedup key: CH number > normalised name >
  normalised domain): name, CH number, status, SIC codes, incorporated, registered
  address, directors, website, website confidence/source, contact_phone/email/page,
  website snippet, signal arrays, `is_large_org`.
- **lead_evidence** — one row per (company, source-path, event): website_source,
  discovery_path, source_query, source_segment, source_micro_category, source_page_url.
  → Dedup/merge (Priority 4) becomes `GROUP BY company`, not blob-merging.
- **leads** — a (company × event) target with scoring: score, priority, scoring_reasons,
  exposure_thesis, fx_reason, exposure_confidence, lead_type, awareness_level,
  saving_opportunity, multi_event_trigger, sales_angle, suggested_next_step. (Derived from
  companies + segments + lead_evidence; could be a view, but a table makes the dashboard
  export trivial.)
- **runs** — one row per pipeline run: run_id, start/end, runtime, mode, git commit,
  config, per-stage stats (event/segment/source/lead/gate/contact-coverage), warnings,
  errors, top-leads snapshot. (= Priority 3, but DB-backed.)
- **crm_status** — follow-up state per lead: status, last_contacted_at, contact_channel,
  touch_count, next_follow_up_at, follow_up_reason, suggested_next_action, notes,
  response_status. (= the `CLAUDE.md` Priority-15 follow-up workflow, finally with a home.)

## Pipeline stages (each a CLI command, idempotent, writes a `runs` row)

`db:import → analyse → discover → enrich-contacts → score → dedup → db:export`
(= `npm run pipeline`). Each stage reads from / writes to `data/fx.db`; `db:import`
seeds it from the committed `data/{events,leads}.json` and `db:export` writes them
back at the end. `analyse` is the only LLM call (one per event — Brain 1 + Brain 2
combined, prompt copied verbatim from the original `ingest.py`, unchanged; provider =
Groq by default, with a rule-based fallback on a 429). `discover` uses controlled
concurrency (`p-limit`) over search / website / Companies-House fetches. `score` +
`dedup` together reproduce `rescore.py`'s scoring + dedup passes bit-for-bit.

## How it was built (migration sequence — done)

1. **`packages/core`** — schema (zod) + signals + scoring + tests. Pure functions,
   faithful ports of `signals.py` / `rescore.py`.
2. **`packages/core/db`** — Drizzle tables + `getDb()` + `import-json.ts` (loads the
   committed JSON into SQLite). Added `cache.ts`, `contacts.ts`.
3. **`pipeline/stages/score.ts` + `dedup.ts`** — re-scored the real data and diffed
   against Python `rescore.py` until `(score, priority)` matched for every lead.
4. **`pipeline/stages/discover.ts` + `sources/*`** — search / source-page-mining /
   website-validation / CH-validation with concurrency.
5. **`pipeline/stages/analyse.ts` + `sources/ai.ts`** — the combined LLM call (prompt
   verbatim) + RSS ingest; provider switched Gemini → Groq.
6. **`pipeline/stages/enrich-contacts.ts` + `db/export-json.ts`** — contact backfill +
   DB→JSON export. Wired the GitHub Actions cron at the TS pipeline; removed `scripts/`.
7. **`apps/web`** — moved the React dashboard into the monorepo; npm workspaces.
   (Still TODO: build the CRM / follow-up UI on the `crm` table — see CLAUDE.md P15.)

Deploy: `apps/web` static build → Fly (`deploy-fly.yml`) + GitHub Pages (`deploy.yml`),
both triggered on push to `main` and after a `discovery.yml` run. The pipeline itself
runs in the `discovery.yml` GitHub Actions cron (Mon–Fri 06:00 UTC).

## Hard constraints (from CLAUDE.md — still in force)

- 1 AI call per event; no per-company / per-lead AI.
- Don't change the scoring gates or Brain 1/2 prompts without explicit sign-off.
- No LinkedIn scraping; no auto-send / automated outreach; no paid APIs without sign-off.
- Work in branches; `main` auto-deploys to Fly (and Pages).
