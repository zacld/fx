# FX Discovery Engine — Claude Instructions

This file governs how Claude should build, extend, and maintain this project.

---

## Implementation (v2 — TypeScript) — read this first

The project is a **TypeScript npm-workspace monorepo**: `packages/core` (schema,
signals, scoring, contacts, names, emails, people, tech-stack, website-intel, cache,
SQLite/Drizzle, `db:import`/`db:export`), `packages/pipeline` (the CLI stages —
`analyse · discover · enrich-contacts · enrich-decision-makers · enrich-website-intel
· score · dedup` — plus `sources/*` including `sitemap.ts`, `smtp-verify.ts`), and
`apps/web` (the React + Vite dashboard). The data lives in `data/fx.db` (SQLite,
gitignored), seeded each run from `data/events.json` (committed; market analysis
only) and `data/leads.json` (names, phones, emails: kept out of git, in the site's
private Blobs store, fetched and saved by the discovery workflows with
`apps/web/scripts/leads-store.mjs`; the dashboard reads it from `/api/leads` behind
the Accounts password) and exported back at the end. Run it with `npm run pipeline` (or one stage at a time);
the daily production run is `.github/workflows/discovery.yml`. See `ARCHITECTURE_V2.md`.

The original Python pipeline (`scripts/*.py`) was ported 1:1 — **same Brain 1/2
prompt, same scoring gates, same signal lists** (verified: `import → score → dedup`
reproduces `rescore.py`'s `(score, priority)` for every lead) — and then removed.
Throughout this document, references to `ingest.py`, `discover_web.py`, `discover.py`,
`rescore.py`, `enrich_websites.py`, `linkedin_assist.py`, `outreach.py` etc. name the
**behaviour** that now lives in the TS equivalents:

| CLAUDE.md says | now lives in |
|---|---|
| `ingest.py` (Brain 1 + Brain 2, one LLM call) | `packages/pipeline/src/stages/analyse.ts` + `sources/ai.ts` + `sources/rss.ts` |
| `exposure_mapper.py` | folded into `analyse.ts` |
| `discover_web.py` + `discover.py` (Brain 3) | `packages/pipeline/src/stages/discover.ts` + `sources/{search,website,source-page-miner,companies-house,blocklists,fetch}.ts` |
| `enrich_websites.py` (+ `website_finder.py`, `contacts.py`) | `packages/pipeline/src/stages/enrich-contacts.ts` + `@fx/core` `contacts.ts` (libphonenumber-based, Cloudflare/[at][dot] deobfuscation) |
| `enrich_decision_makers.py` (Python v2) | `packages/pipeline/src/stages/enrich-decision-makers.ts` + `@fx/core` `{names,emails,people,tech-stack}.ts` + `sources/{sitemap,smtp-verify}.ts`; CH officers + PSCs |
| `enrich_website_intelligence.py` | `packages/pipeline/src/stages/enrich-website-intel.ts` + `@fx/core` `website-intel.ts` |
| `rescore.py` (score + dedup + classify) | `packages/pipeline/src/stages/score.ts` + `dedup.ts`, scoring rules in `@fx/core` `scoring.ts` |
| `signals.py` | `@fx/core` `signals.ts` |
| `linkedin_assist.py`, `outreach.py` | LinkedIn search URLs are now generated per-director inside `enrich-decision-makers.ts` (Google `site:linkedin.com/in` queries — Priority 12 compliant). `outreach.py` not yet ported (lower priority — generated on demand, see P13/P15). |
| `run_pipeline.py` | `npm run pipeline` / `discovery.yml` |
| `enrich_ch_accounts.py`, `compute_call_readiness.py`, `audit_leads.py` | `stages/enrich-ch-accounts.ts`, `call-readiness.ts`, `audit.ts` (inside `npm run pipeline`; call readiness now recomputed every run) |
| AI provider: Gemini | **Groq** (`llama-3.3-70b-versatile`) by default; `AI_PROVIDER=gemini` still works. The "Gemini" mentions below mean "the one event-level LLM call". |

Everything below this section — the three-brain architecture, the gates, the
priorities — is still binding. Only the *file names* changed.

---

## Lead sourcer (`lead-sourcer/`) — who it finds

A separate, rule-based Python tool for the standing account list (not
event-driven). It is still bound by Priorities 1 and 12: no AI calls, no
LinkedIn/social scraping, no phone lookups, no outreach.
- **Company websites:** only the company's own site, only when the register
  and accounts name no finance person; the site must show the company's
  registration number or registered name; at most 4 pages (home + team /
  leadership / about / contact); robots.txt respected; keeps names with
  finance titles and generic company emails only.
- **Finance contact order:** CH occupation → finance title in the accounts
  → company website → gov.uk registry filing with a finance title (gender
  pay gap "responsible person", modern slavery statement approver; ≤3
  years) → finance appointment in the news (Google News RSS, headline must
  name the company, ≤4 years) → qualified accountant (ACA/FCA/ACCA/…) on
  the board → company secretary → director who signed the accounts.
  `finance_contact_source` records which, `finance_contact_evidence` lists
  every source naming that person, and `finance_contact_confidence` grades
  it Verified (finance title + 2 independent sources, one current) /
  Confirmed / Likely / Guess. A registry giving the pick a non-finance
  title, or a professional secretary (10+ unrelated appointments), drops
  it to Guess.
  Then the confirmation step (`tools/confirm_contacts.py`, run in the
  finder workflow): a web search per checked company through search APIs
  used within their free/paid allowances in turn — Search1API, Tavily, Exa,
  Serper (secrets `*_API_KEY`, monthly caps `*_MONTHLY`, ≤
  `SEARCH_MAX_PER_RUN` searches a run — 150 on weekday mornings while Serper's
  2,500 sign-up searches last — results cached 60 days (`SEARCH_CACHE_DAYS`), so steady-state re-checks fit Tavily's free 1,000 a month; accounts qualified Out
  are not searched) — reads result titles and snippets only — LinkedIn profile
  titles, company board pages, news, org charts — to confirm or replace the
  pick (when no finance director turns up, one more search under the
  company's trading name, from "trading as" in its accounts or the results) (2+ separate sites naming them = Verified; a pick shown as MD etc. is
  replaced; a current FD named by the search also replaces a controller /
  manager pick, whatever its grade; for a subsidiary with no FD found, one
  more search under its parent's name for the group FD). The picker takes the
  most senior finance title any source gives (a board "Finance Manager" no
  longer stops it finding the website's FD). `no_fd_likely`: no FD-level
  person anywhere after the search, under £50m, no parent — the MD is shown
  as decision-maker. linkedin.com is never fetched; no emails or phones are kept; no
  browser automation or bot-detection workarounds. Generated Google/LinkedIn
  search links remain for checking by hand.
- **Target:** UK companies with proven foreign-currency flows, sized for a
  bank FX desk (Zac now works at a bank). Core band £25m–£250m turnover;
  Above (£250m+) and Below are separate sections.
- **Per company:** likely currencies (customs goods × HMRC trade statistics
  by country), an FX wallet range (cost of sales/turnover × customs-banded
  shares), main bank and type (accounts "Bankers" line + charges register),
  own-bank flag (Investec by default in the workflow; `--own-bank` /
  `OWN_BANK`), triggers (new owner / private-equity backing, new or paid-off
  charges, facility renewal due, new directors), accounts extras (FX loss vs
  prior year, growth, overseas share, cash, borrowings, auditor), group
  roll-up, FD and lead director.
- **Call hooks + currency exposure** (`sourcer/hooks.py`, thresholds in
  `HOOK_RULES`): the two strongest facts, `fact_1`/`fact_2` (new FD ≤90 days → FX gain/loss
  ≥£50k → new charge ≤12 months → growth ≥20% → overseas parent/subsidiary →
  accounts filed ≤30 days), main currency + direction + evidence +
  confidence (geography note → currency named in accounts → overseas group →
  HMRC customs mix → niche default), and a one-sentence opener built only from the detail
  columns. Every detail names its fetched source; blank beats a guess; no
  extra API calls and no AI. On the Accounts page each fact links to that source on the public
  Companies House site: the accounts document (`accounts_url`; the FX line's page, `fx_gain_loss_url`,
  for PDF/OCR figures) and the charge (`incumbent_bank_url`).
- **Incumbent + qualify** (`sourcer/incumbent.py`, `sourcer/qualify.py`): incumbent
  bank (all-assets debenture holder) and every charge's type from the charges
  register already fetched; facility end dates and "how they do FX today"
  (forwards / options / no hedging / natural hedge / named FX provider) quoted
  from the accounts; bank facts lead the facts and opener (`HOOK_RULES
  ["order"]`), FX gain/loss as the cross-sell; `fx_estimate` labelled as an
  estimate; `qualified` Yes/Check/Out (`QUALIFY_RULES`; a filter, not a score)
  and `warm_route` (own-bank relationship, PE sponsor, `WARM_AUDITORS`).
- **When to call** (year-end planning window, customs season) is shown but
  never scored. Triggers lift ranking a little (10 each, max 20); an FX loss
  of £50k+ in accounts filed in the last 183 days (`recent_fx_loss`,
  `RECENT_FX_LOSS` in `main.py`) lifts it 15.
- **Accounts page order:** "Hottest" by default — finance contact Confirmed
  (Verified/Confirmed) first, then Guess (Likely/Guess), then No one named,
  each in the finder's rank; buttons filter by those groups. "Job role" sort
  and filter: CFO/FD → Head of Finance/Treasurer → Financial Controller →
  Finance Manager → Accountant → Other director → other / no one
  (`ROLES` in `apps/web/src/accounts/format.js`). Companies added
  by the latest upload are labelled New (`first_seen`, carried over by
  `upload-accounts.mjs`). The Contacted button moves a company to the
  Contacted tab (marks kept in the Blobs store under `contacted`, via POST
  `/api/accounts`; the finder never touches them). Follow-ups
  (`apps/web/src/accounts/followups.js`, shared by the page and the API):
  "Contacted" asks the channel (phone / email / LinkedIn / in person) and
  logs a touch; the next follow-up is due 2, 4, then 7 days after each touch,
  then nurture (90 days); a reply / meeting / not interested stops it; Zac
  can move the date. The Contacted tab groups Overdue / Due today / Replied
  / Upcoming / Nurture / Meeting booked / Not interested, with the suggested
  next action and a copy-ready line (event reminder → new angle → soft bump
  → break-up, from the company's own facts; no AI, nothing sent). Each card has a Notes box
  (Blobs key `notes`, same POST with `{company_number, notes}`; "" deletes;
  searched by the search box and included in the CSV export). Clicking a
  company's name opens its own page, `/accounts/<company number>`
  (`_redirects` serves accounts.html; same password): key figures, finance
  contact, notes, Contacted, why call, every detail grouped Banking / FX
  exposure / People / Company with each fact linked to its filing or charge,
  and a Source documents list (`detailSections`, `sourceDocuments` in
  `format.js`).
- **Evidence comes from raw records, in this order:**
  1. HMRC monthly importer/exporter lists, matched to Companies House.
  2. Filed accounts: tagged iXBRL figures (turnover, cost of sales, FX
     gain/loss, currency or region breakdowns, hedging, bankers), else the
     PDF's text (pdftotext, or Tesseract OCR of the first pages for scanned
     filings — system tools installed in the workflow, not Python packages).
     The FX gain/loss: a tag counts only when its row is an exchange/currency
     line in pounds (Wanis tagged "Stocks recognised as expenses"); otherwise
     the "Exchange differences / losses/(gains)" line in the notes text
     (`sourcer/fx_text.py`; scanned filings: OCR of the pages 60–90% through,
     `OCR_FX_BUDGET_SECONDS` a run). Over 20% of turnover, no gain/loss
     direction, or not in pounds → `fx_gain_loss_check`, never a fact.
     Real cases: `tests/test_fx_cases.py` (`tools/fx_case_study.py`).
  3. Companies House owners, charges and directors.
  4. The FX niches (`lead-sourcer/config/fx_niches.json`).
- **Scores:** every score and estimate lists its evidence or basis. Weights
  and wallet bands get recalibrated against real outcomes, so log them.
- **Not public, not scraped:** credit-reference data (Creditsafe etc.) only
  via a licensed API if the bank has one.
- **Contact routes and email drafts:** in scope until Cognism arrives
  (mid-November 2026). Generic company emails only (Priority 12), and
  rule-based drafts (Priority 1: no per-lead AI calls).
- **Running it:** the GitHub workflow `fx-company-finder.yml` fills the
  dashboard's password-protected Accounts page (no run attachments: the
  repo is public)
  (`/accounts`; the list sits in Netlify Blobs behind `/api/accounts`, never
  in the repo or the public build). A finance director outranks a financial
  controller when picking the contact. Each company's Companies House lookups
  are cached 7 days (`sourcer/register_cache.py`, `REGISTER_CACHE_DAYS`; sooner
  when newer accounts are filed) to keep within the GitHub Actions minutes.

## Market moves (`market-moves/`, `/moves`) — the day-to-day dashboard

Official ECB reference rates → the pound's moves against each currency
(1d/1w/1m/3m), material moves flagged (`MOVE_RULES`), "per 1m" impact
(arithmetic on official rates). The `/moves` page adds the event engine's
recent events for the pair ("why it moved", read-only from `events.json`)
and, behind the Accounts password, the accounts each move hits with a call
line. Workflow `fx-market-moves.yml`; data in Netlify Blobs behind
`/api/market`. No AI; doesn't touch the company finder or the event engine.

---

## What this system is

A **business exposure translator** for UK B2B FX sales.

Not a news summariser. Not a mass-outreach tool. Not a general lead database.

It turns a market event ("GBP/EUR fell 1.2% after BoE held rates") into a daily call list of specific UK businesses whose payment flows are financially exposed to that event — with real company websites, FX evidence, director names, and a clear reason to call today.

The benchmark for every build decision:
**Would Zac actually call this company today because of this event?**

---

## PRIORITY 1 — Cost control

AI cost must stay tiny, capped, and logged. Default dev mode should use one AI call per run. Daily mode should usually use 1–2 event-level calls max.

Rules that cannot be broken:
- ONE AI call per market event (combined triage + exposure map)
- NO AI calls per company, per website, per lead, or per outreach message
- Company discovery, website scoring, and lead classification are rule-based only
- AI is only used for event-level reasoning

Any feature that would require per-company or per-lead AI calls must be redesigned to be rule-based.

---

## PRIORITY 2 — Three-brain architecture

```
Market movement
→ Brain 1: FX Impact Brain
→ Brain 2: Business/Niche Mapping Brain
→ Brain 3: Scraping + Decision-Maker Brain
→ Dashboard
```

One-line summary: **Brain 1 works out the currency impact. Brain 2 works out which business niches are affected. Brain 3 finds the companies and decision-makers.**

Keep their responsibilities completely separate. Do not collapse them. Do not let Brain 3 decide which niches matter. Do not let Brain 2 touch individual companies. Do not let Brain 1 produce niche lists.

---

**Brain 1 — FX Impact Brain** (AI, event-level only)

Analyses the market movement and works out the financial impact.

Answers:
- What moved?
- Why did it move?
- Which currency is affected?
- Which currency pair matters?
- Is it already moving or likely to move?
- Who pays more?
- Who receives less?
- What payment flow is affected?
- What is the margin/timing risk?

Example output:
```
Movement: GBP/EUR weakens
Currency affected: GBP under pressure against EUR
Business effect: UK companies paying EUR suppliers now need more GBP to pay the same invoices.
Affected payment flow: GBP revenue / EUR supplier costs
Risk: Margin pressure on upcoming EUR invoices.
```

Technical outputs: `event_summary`, `event_type`, `currency_pair`, `affected_payment_flow`, `business_impact`, `what_changed_financially`, `who_pays_more`, `who_receives_less`, `margin_risk`, `payment_timing_risk`, `urgency`

Brain 1 then passes its output to Brain 2.

---

**Brain 2 — Business/Niche Mapping Brain** (AI, event-level only)

Takes the affected payment flow from Brain 1 and decides which types of companies are exposed.

Answers:
- What business models are affected?
- What niches are exposed?
- Which categories have recurring FX payments?
- Which are margin-sensitive?
- Which are likely SMEs?
- Which are easiest to validate from websites?
- Which are worth scraping first?

Example output:
```
Affected payment flow: GBP revenue / EUR supplier costs

Business types affected:
- UK importers from Europe
- UK distributors buying European stock
- UK wholesalers paying EUR suppliers
- UK manufacturers buying European components

Niches:
Italian food importers — 92
Wine and spirits importers — 90
Furniture/interiors importers — 85
Machinery/component distributors — 82
Automotive parts distributors — 78
```

Technical outputs per niche: `category_name`, `category_priority_score` (0–100), `score_breakdown`, `why_prioritised`, `likely_payment_flow`, `likely_currency_pair`, `exposure_type`, `micro_categories`, `validation_signals`, `avoid_segments`

Category scoring dimensions:
| Dimension | Max |
|---|---|
| Direct payment-flow exposure | 30 |
| Recurring FX payment likelihood | 20 |
| Margin sensitivity | 15 |
| UK SME suitability | 15 |
| Website evidence availability | 10 |
| Contactability | 10 |

Only niches scoring ≥ `CATEGORY_MIN_SCORE_TO_SCRAPE` and within `WEB_MAX_CATEGORIES_TO_SCRAPE` are passed to Brain 3.

Brain 2 then passes the selected niches to Brain 3.

---

**Brain 3 — Scraping + Decision-Maker Brain** (rule-based, no AI)

Takes the selected niches from Brain 2 and finds actual companies and contact routes.

Does:
- Searches micro-categories within each niche
- Finds real company websites
- Filters directories, blogs, news sites, aggregators
- Validates website FX evidence (imports, exports, overseas suppliers, currency signals)
- Validates with Companies House
- Extracts phone, email, contact page
- Finds director names (Companies House)
- Generates LinkedIn search routes
- Ranks company quality
- Creates contact route

Example:
```
Input niche: German machinery distributors

Searches:
"German machinery distributor" UK
"European machinery supplier" UK
"industrial machinery importer" UK

Finds: Alpine Machinery Supplies Ltd

Validates website:
European suppliers / machinery distribution / trade customers / imported components

Decision-maker route:
Call office first.
Target: Finance Director / Managing Director / Procurement Director
Companies House clue: James Smith, Director
LinkedIn: Company + Finance Director / Managing Director / Procurement
```

---

**Responsibility boundaries — enforced, not optional:**

Brain 1 works out the currency impact.
Brain 2 works out which business niches are affected.
Brain 3 finds the companies and decision-makers.

Brain 3 never decides which niches matter.
Brain 2 never touches individual companies.
Brain 1 never produces niche lists.

---

## PRIORITY 3 — Category Priority Engine

Brain 2 must rank and score categories before Brain 3 scrapes anything.

The scanner must not scrape every category that could theoretically be affected. Brain 2 ranks categories by commercial opportunity first — Brain 3 only receives the best ones.

**Full flow:**
```
Market movement
→ Brain 1: FX Impact Brain
→ affected payment flow (who pays more / who receives less)
→ Brain 2: Business/Niche Mapping Brain
→ ranked niches with priority scores
→ selected niches (above threshold, capped at max)
→ Brain 3: Scraping + Decision-Maker Brain
→ micro-categories within each niche
→ company discovery (web + Companies House)
→ website validation (FX evidence)
→ Companies House validation
→ lead scoring
→ contact route (phone / email / LinkedIn / director)
→ message ingredients
→ dashboard
```

**Env vars:**
```
WEB_MAX_CATEGORIES_TO_SCRAPE=6
CATEGORY_MIN_SCORE_TO_SCRAPE=65
```

Categories scoring ≥ 65 are scraped, up to 6 total. Categories below 65 are listed in the event but not scraped.

---

## PRIORITY 4 — AI at event-level only

AI provider: Gemini → static playbook fallback (Grok not in use)

AI (Brain 1 + Brain 2) is called ONLY in:
- `ingest.py` — FX impact analysis + category strategy (1 combined call per event)
- `exposure_mapper.py` — standalone exposure mapping (when called directly)

AI is NOT called in:
- `discover.py` — Companies House discovery (Brain 3, rule-based)
- `discover_web.py` — web discovery and validation (Brain 3, rule-based)
- `rescore.py` — lead scoring (Brain 3, rule-based)
- `enrich_websites.py` — website enrichment (Brain 3, rule-based)
- `linkedin_assist.py` — LinkedIn links (Brain 3, rule-based)

If Gemini quota is exhausted, the static playbook fallback is used.

Do not configure or enable Grok/xAI unless explicitly instructed — it is not funded and not in use.

---

## PRIORITY 5 — Micro-category architecture

Every event produces:
- 8–12 categories for broad_currency/broad_macro events (from Brain 2)
- A `category_priority_score` (0–100) on each category (from Brain 2)
- 3–5 micro-categories per category (from Brain 2)
- Each micro-category has: name, why, search_queries (2–3), companies_house_terms (2–3)

Categories are the "who is exposed and how important" answer (Brain 2).
Micro-categories are the specific sub-niches Brain 3 searches within each category.
Search queries live inside micro-categories only — not at category level.

Brain 3 only scrapes categories where `category_priority_score` ≥ `CATEGORY_MIN_SCORE_TO_SCRAPE`, up to `WEB_MAX_CATEGORIES_TO_SCRAPE` categories.

---

## PRIORITY 6 — Discovery pipeline order

```
ingest.py          → events.json (Brain 1: FX impact analysis)
                                 (Brain 2: category strategy + scoring)
discover_web.py    → leads.json (Brain 3: scrape top-N categories via DuckDuckGo)
discover.py        → leads.json (Brain 3: Companies House enrichment)
enrich_websites.py → leads.json (Brain 3: backfill missing websites)
rescore.py         → leads.json (Brain 3: score, classify, dedup)
linkedin_assist.py → leads.json (Brain 3: add LinkedIn search links)
```

Each script is idempotent — safe to re-run. Later scripts update existing leads rather than creating duplicates.

---

## PRIORITY 7 — Lead scoring gates

**HOT** ≥ 80 — call today
**WARM** 60–79 — call this week
**QUEUE** 40–59 — research needed
**SKIP** < 40 — reject

Gate rules (enforced in `rescore.py`):
- No website → cap at 39 (SKIP)
- No FX signals → cap at 39 (SKIP)
- Known bad domain → cap at 49 (QUEUE)
- HOT requires: score ≥ 80 AND verified website AND at least 1 FX signal

Known bad domains are maintained in `KNOWN_BAD_DOMAINS` in `rescore.py`. Add directories, news sites, aggregators, and marketplaces to this list as they appear.

**Daily Call List target: 10–25 high-confidence call targets.**

The dashboard should show the top 25 HOT leads by default, sorted by score descending. The rest of HOT and all of WARM go into Research Queue. Do not show Zac 89 HOT leads and expect him to work through them — surface the best 25, keep the rest accessible but not primary.

---

## PRIORITY 8 — FX signal extraction

FX payment signals are extracted from company websites in `discover_web.py`.

The signals that count as direct evidence:
- "import", "importer", "importing", "imported from"
- "export", "exporter", "exporting"
- "overseas supplier", "foreign supplier", "international supplier"
- "pay in euros", "pay in dollars", "EUR invoice", "USD invoice"
- "currency", "exchange rate", "FX", "hedging"
- "sourced from [country]", "direct from [country]"

FX signal count (fx_sigs) drives:
- `awareness_level`: high (3+), medium (1–2), low (0)
- Lead score weighting
- `lead_type` classification

---

## PRIORITY 9 — Lead classification

Every lead gets three classification fields (set in `rescore.py`):

**lead_type:**
- `trigger_exposed` — discovered via this specific market event
- `evergreen_saving` — importer/manufacturer SIC code + FX evidence
- `both` — qualifies for both (multi-event or import SIC + event triggered)
- `unknown` — cannot confidently classify

**awareness_level:** high / medium / low (based on FX signal count)

**saving_opportunity:** high / medium / low (based on score + FX evidence)

SIC code routes for evergreen:
- Import/wholesale SIC 46xx, 47xx + any FX evidence
- Manufacturing SIC 10–33 + pays_fx_confirmed
- Any SIC + fx_sigs ≥ 3

---

## PRIORITY 10 — Website validation

`discover_web.py` validates company websites by:
1. Fetching the homepage
2. Scraping up to 3 additional pages (/about, /about-us, /products, /services, /distribution, /what-we-do) — hard cap 4 pages total
3. Early stop if 3+ FX signals found
4. Extracting FX payment signals, segment-specific signals, international signals

A company without a verified real website should not be HOT or WARM.

Website confidence levels: high / medium / low / guessed — stored on the lead.

---

## PRIORITY 11 — Deduplication

Deduplication is by Companies House number (primary) and normalised company name (fallback).

When a company appears in multiple discovery runs:
- Keep the highest-scoring record
- Track `multi_event_trigger: true` if triggered by 2+ distinct events
- Multi-event leads get a score bonus

---

## PRIORITY 12 — No banned content

The pipeline must never:
- Scrape LinkedIn or social profiles (terms of service violation)
- Send automated messages of any kind
- Store personal emails scraped from LinkedIn or social sources
- Auto-contact prospects without Zac reviewing first

Generic company emails found on the company's own website (info@, sales@, accounts@, contact page emails) are allowed as contact routes.

LinkedIn links are generated as search URLs (linkedin.com/search/results...) — not scraped profiles.

---

## PRIORITY 13 — Outreach ingredients (copy-ready, not auto-sent)

`outreach.py` generates:
- A call opener (1–2 sentences, event + company-specific)
- A LinkedIn note (≤ 300 chars)
- An email subject + 3-sentence body

These are ingredients for Zac to use, not messages to send automatically.

They are generated per-lead on demand — not in bulk during pipeline runs.

---

## PRIORITY 14 — Dashboard workflow

The dashboard (`src/App.jsx`) shows:

**Events panel:** Each event card shows the 4-stat funnel:
`N segments mapped · N micro-cats · N companies found · N call targets`

**Lead views:**
- Daily Call List — top 25 HOT leads by score, verified website + FX signal
- Research Queue — remaining HOT, all WARM, and QUEUE leads
- All Leads — full pipeline

**Lead card:** Shows company name, website, segment, exposure thesis, FX signals, director name, LinkedIn link, outreach copy.

Dashboard is read-only — no actions are taken from the dashboard except Zac clicking LinkedIn links or copying outreach text.

---

## PRIORITY 15 — Follow-up workflow automation, not auto-outreach

We want follow-up automation, but only as workflow support.

Add a lightweight follow-up engine.

Each lead should support these fields:
- `last_contacted_at` — ISO timestamp of last contact
- `contact_channel` — linkedin / email / phone / in_person
- `touch_count` — number of times contacted
- `next_follow_up_at` — ISO timestamp of suggested next contact
- `follow_up_reason` — why follow up is due (e.g. "2-day follow-up after first LinkedIn message")
- `suggested_next_action` — see list below
- `suggested_follow_up_ingredients` — copy-ready text for the follow-up
- `status` — see status list below
- `notes` — free text, Zac adds manually
- `response_status` — no_response / replied / booked / not_interested

**Lead statuses:**
new · reviewed · saved · contacted · follow_up_due · followed_up · replied · meeting_booked · not_relevant · passed_to_closer · nurture · paused

**Follow-up timing:**
- After first contact: follow up in 2 days
- After second contact: follow up in 4 days
- After third contact: follow up in 7 days
- If no response after 3 touches: move to nurture/pause
- If a fresh market event affects the same company/payment flow: surface as new follow-up angle

**Suggested next actions:**
- LinkedIn follow-up
- email follow-up
- call office
- ask for person handling overseas supplier payments
- mark not relevant
- pass to closer
- book meeting
- move to nurture

**Suggested follow-up ingredient types:**
1. Event reminder: "GBP/EUR is still under pressure, so upcoming EUR supplier payments could still be worth reviewing."
2. New angle: "A lot of businesses paying overseas suppliers just use their bank and don't always realise the rate/spread difference."
3. Soft bump: "Not sure if you're the right person for this — would it normally sit with finance or the MD?"
4. Break-up: "No worries if it's not relevant — just thought it could be useful given the recent move."

**Dashboard should show:**
- Follow-ups due today
- Overdue follow-ups
- Leads with no next action
- Leads contacted but not followed up
- Follow-up count and last touch date
- Suggested next touch

**Important: No auto-send. No LinkedIn automation. No automatic email campaigns.**
Only reminders, sequencing, and copy-ready suggestions.

Goal: The scanner helps Zac stay on top of follow-ups without turning into a spam machine.

---

## Important clarification: automate the workflow, not the relationship

Do not chase full outreach automation.

We do want follow-up automation, but only as workflow support.

The scanner should NOT:
- auto-send LinkedIn messages
- auto-send emails
- auto-send connection requests
- run blind outbound campaigns
- contact prospects without Zac reviewing first

The scanner SHOULD:
- track who has been contacted
- track when they were contacted
- track which channel was used
- track touch count
- suggest the next follow-up date
- suggest the next action
- provide copy-ready follow-up ingredients
- remind Zac who needs follow-up
- help manage lead status

Zac manually reviews and sends everything.

Core rule: The scanner reminds, sequences, and suggests. Zac sends.

---

## Final benchmark

**The Daily Call List is for leads with enough evidence to justify a real outbound action today.**

A lead must pass all 5 gates to appear in the Daily Call List (HOT):

**Gate 1 — Real company**
- UK-based or UK-operating
- Active trading business
- Not a directory, blog, marketplace, news article, or social profile

**Gate 2 — Clear FX/payment exposure**
- Likely foreign supplier costs or foreign customer receipts
- Payment flow identifiable (e.g. GBP revenue / EUR supplier costs)
- Relevant currency pair identifiable (e.g. GBP/EUR or GBP/USD)

**Gate 3 — Website evidence**
- Website confidence: high or medium
- At least 1 strong signal: import, export, international, overseas suppliers, European suppliers, US suppliers, global sourcing, wholesale, distributor, manufacturer, trade customers, freight, shipping

**Gate 4 — Commercial fit**
- B2B, wholesale, distributor, manufacturer, importer/exporter, travel, logistics, trade-focused, or similar
- Not purely local consumer-only unless there is clear international supplier/payment evidence
- Likely enough size and recurring activity to justify a call

**Gate 5 — Contact route**
- At least one realistic contact route exists: company phone, contact page, generic company email, Companies House director, or LinkedIn MD/FD/CFO search route

**Gate logic:**
- HOT (Daily Call List) = all 5 gates pass
- WARM = strong exposure but weaker contact route or weaker evidence
- QUEUE = research needed before calling
- SKIP = bad or irrelevant lead

If any gate is missing, cap the lead below Daily Call List.

Human shorthand: "Would Zac actually call this company today because of this event?" — but the gates are the scoring rule, not the phrase.

---

Do not chase huge volume.
Do not chase blind outreach automation.

Build a cost-controlled, commercially useful discovery system that produces:
- a credible daily call list
- clear exposure theses
- contact routes
- message ingredients
- follow-up reminders and suggestions

The scanner should find, prioritise, remind, and suggest.
Zac should review, call, message, and sell.
