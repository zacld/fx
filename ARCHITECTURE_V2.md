# FX Discovery — v2 architecture (TypeScript rewrite)

Status: **in progress** (incremental). The Python pipeline in `scripts/` keeps running
in production until each v2 stage is ported and proven. Nothing here changes Brain 1/2
prompt logic, the scoring gates, or anything `CLAUDE.md` governs — `CLAUDE.md` still
governs the *behaviour*; this file governs the *structure* of the rewrite.

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
    core/                 # ← starts here (this increment)
      src/
        schema.ts         # zod schemas + inferred types — THE data model
        signals.ts        # FX / origin-hint / B2B / negative signals + classifyText()
        scoring.ts        # scoreLead() — the ONE gate-based scorer (faithful port of rescore.py)
        db/
          schema.ts       # Drizzle SQLite table definitions (next increment)
          index.ts        # getDb() (next increment)
        cache.ts          # generic TTL file cache (CH etc.) (next increment)
        index.ts
      test/
    pipeline/             # Node CLI stages (later increments)
      src/
        stages/
          ingest.ts       # RSS → events
          analyse.ts      # 1 LLM call/event: FX impact + niche map (Brain 1+2 — prompt UNCHANGED)
          discover.ts     # search → source-page mining → website validate → CH validate
          score.ts        # apply core/scoring over the leads table
          enrich-contacts.ts
          export.ts       # write public/data/leads.json from the DB (keeps the dashboard static)
        sources/          # ddg.ts, bing.ts, companies-house.ts, source-page-miner.ts, website.ts
        ai/               # gemini.ts, playbook.ts (provider abstraction)
        run.ts            # writes a `runs` row; CLI: `pnpm run ingest`, `pnpm run discover`, ...
  apps/
    web/                  # the React dashboard (moved from ./src — LATER increment, to avoid
                          # breaking Dockerfile + the GitHub Pages workflow until then)
  scripts/                # the existing Python pipeline — runs in prod until v2 stages replace it
  data/
    fx.db                 # SQLite (or data/cache/*.json + data/runs/*.json in the interim)
    leads.json events.json # still exported for the dashboard during the transition
```

Tooling: npm workspaces (the repo already uses npm), `tsx` to run TS directly, `vitest` for
tests, `drizzle-orm` + `better-sqlite3` for the DB, `zod` for schema, `cheerio` for HTML
parsing (≈ BeautifulSoup), `undici`/`got` for fetching, `p-limit` for concurrency, the
official Gemini JS SDK.

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

`ingest → analyse → discover → score → enrich-contacts → export`. Each reads from / writes
to the DB. `analyse` is the only LLM call (one per event — Brain 1 + Brain 2 combined,
prompt copied verbatim from `scripts/ingest.py`, not changed). `discover` uses controlled
concurrency (`pLimit(8)`) over CH / search / website fetches — this is the speedup.

## Migration sequence

1. **`packages/core`: schema + signals + scoring + tests** ← this increment. Pure
   functions, no I/O, faithful ports — easy to verify, zero prod risk.
2. **`packages/core/db`**: Drizzle tables + `getDb()` + a one-shot importer that loads the
   current `data/leads.json` / `events.json` into SQLite. Add `cache.ts`.
3. **`pipeline/stages/score.ts`**: reads leads from the DB, applies `core/scoring`, writes
   back, writes a `runs` row, exports `leads.json`. Run it alongside the Python `rescore.py`
   and diff the outputs until they match — then it's the source of truth for scoring.
4. **`pipeline/stages/discover.ts`** + `sources/*`: port the search / source-page-mining /
   website-validation / CH-validation logic with concurrency. Keep Python `discover.py` as a
   fallback until parity.
5. **`pipeline/stages/analyse.ts`** + `ai/*`: port `ingest.py`'s combined Gemini call
   (prompt verbatim) + RSS ingest. Brain 1/2 *logic* unchanged.
6. **`pipeline/stages/enrich-contacts.ts`** + `export.ts`. Wire the GitHub Actions cron to
   run the TS pipeline; retire the Python scripts.
7. **`apps/web`**: move the React app into the monorepo; point it at the exported
   `leads.json` (unchanged) or a small read API; build the CRM/follow-up UI on the
   `crm_status` table.

Deploy: `apps/web` static build → Fly (existing `deploy-fly.yml`) + GitHub Pages,
unchanged. Pipeline runs in GitHub Actions cron (or a Fly machine / scheduled task).

## Hard constraints (unchanged from CLAUDE.md)

- 1 AI call per event; no per-company / per-lead AI.
- Don't change the scoring gates or Brain 1/2 prompts without explicit sign-off.
- No LinkedIn scraping; no auto-send / automated outreach; no paid APIs without sign-off.
- Work in branches; `main` auto-deploys to Fly.
- The Python pipeline stays the production path until each v2 stage is proven at parity.
