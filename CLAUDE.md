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
private store, fetched and saved by the discovery workflows with
`apps/web/scripts/leads-store.mjs`; the dashboard reads it from `/api/leads` behind
the Accounts password) and exported back at the end. **Hosting:** Cloudflare Pages
(moved from Netlify, Nov 2026 — its free plan ran out of deploy credits): the build plus
the Pages Functions in `apps/web/functions` (thin wrappers over the platform-free
handlers in `apps/web/api/*.mjs`), the private data in one Workers KV namespace
(`fx-dashboard-store`, keys `<store>/<key>`, binding `FX_STORE`; workflows write it
through Cloudflare's API with `apps/web/scripts/store.mjs`). Deployed by
`deploy-pages.yml` with secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`ACCOUNTS_PASSWORD`; it creates the KV store and project the first time and copies
the private data over from Netlify once (never overwriting what's newer). Run it with `npm run pipeline` (or one stage at a time);
the production run is `.github/workflows/discovery.yml` — **paused Nov 2026** (the Accounts list below
now finds the companies a bank FX desk calls): the weekday schedule only refreshes the market events
(import → analyse → export, the one AI call) for the `/moves` page's "why it moved"; the full pipeline
runs by hand (Run workflow, "full" ticked), and `evergreen.yml` by hand only. See `ARCHITECTURE_V2.md`.

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

**Steer (10 Nov 2026): discovery, not finances.** Zac: "forget currency pairs etc — we don't need to focus on getting
their finances any more at all; we have a good level and I will see the rest on my other tools" (Zint, Cognism). Keep
what's built working, but build nothing more for reading companies' accounts, currency pairs, wallet sizes or charts.
New work goes into **finding the right companies and the moment to call them**: new sources of FX-heavy companies
(uncontacted niches), triggers (new FD, refinancing, expansion abroad, hiring), and getting those to Zac fast.

A separate, rule-based Python tool for the standing account list (not
event-driven). It is still bound by Priorities 1 and 12: no AI calls, no
LinkedIn/social scraping, no phone lookups, no outreach.
- **Company websites:** only the company's own site, only when the register
  and accounts name no finance director (a controller or manager there may
  report to one the team page names); the site must show the company's
  registration number or registered name; at most 4 pages (home + team /
  leadership / about / contact — when the homepage links no team page, the
  sitemap robots.txt names, or /sitemap.xml, is read to find one: XML only,
  at most two files); robots.txt respected; keeps names with
  finance titles and generic company emails only. Addresses tried first:
  those printed in the accounts, then a site in the company's earlier
  (cached) search results whose host name holds the company's name
  (`profiles.own_sites_in_cache`; never a directory, registry, social or
  stockist site, no search made); a cached "no website" is looked up again
  when such an address is new.
- **Companies House no longer publishes occupations (Nov 2026):** the
  officers and appointments API calls stopped returning `occupation` (they
  now carry identity-verification fields instead), so every director reads
  "Director" — checked on the Accounts list's 3,507 directors and with
  `tools/turnover_sample.py` (SAMPLE_OFFICERS). The register-occupation
  source and the former-FD trigger below find nothing until it returns; the
  code is kept and works again if it does. Finance contacts come from the
  other sources.
- **Former finance directors:** from the same Companies House officers call
  (no extra calls), directors who resigned with a finance occupation
  (`former_finance_director`); one who left within `FORMER_FD_TRIGGER_DAYS`
  (365) is a trigger, and any stops `no_fd_likely`.
- **Finance contact order:** CH occupation (as filed: "Chief Finance
  Officer", "Director Of Finance", "Director (Finance)", "Finance &
  Operations Director", "Group Financial Controller" — `sourcer/roles.py`) → finance title in the accounts
  → company website → gov.uk registry filing with a finance title (gender
  pay gap "responsible person", modern slavery statement approver; ≤3
  years) → finance appointment in the news (Google News RSS, headline must
  name the company, ≤4 years) → qualified accountant (ACA/FCA/ACCA/…, or a
  director filed only as "Accountant": Likely) on
  the board. A company secretary or the director who signed the accounts is
  never a finance contact on that alone (even both together): they're research
  clues (`finance_contact_clues`), and the page says "Ask for the Finance
  Director" (the MD when `no_fd_likely`).
  `finance_contact_source` records which, `finance_contact_evidence` lists
  every source naming that person, and `finance_contact_confidence` grades
  it Verified (finance title + 2 independent sources, one current) /
  Confirmed / Likely. A registry giving the pick a non-finance title, a
  professional secretary (10+ unrelated appointments) or a search showing
  them in a former / non-finance role makes it a Guess, and a Guess is moved
  to the clues with why (`people.weak_contact_to_clue`): no one is presented
  as the finance contact on weak evidence.
  **Switched off 14 Nov 2026** (Zac: "we don't need to build lead enrichment, we have Cognism"): the nightly finder
  runs `--no-contacts` — no website team pages, news, registry or officer-appointment lookups and no confirmation
  searches; only what the register and accounts already name. The code below is kept, not run.
  Then the confirmation step (`tools/confirm_contacts.py`, formerly run in the
  finder workflow): a web search per checked company through search APIs
  used within their free/paid allowances in turn — Search1API, Tavily, Exa,
  Serper (secrets `*_API_KEY`, monthly caps `*_MONTHLY`, ≤
  `SEARCH_MAX_PER_RUN` searches a run — companies whose filed turnover passes
  the size test (≥ £20m, `SEARCH_MIN_TURNOVER`) first: size established, then
  the contact confirmed — and within that neediest first (nobody →
  Likely → a Confirmed controller or manager); a finance director already
  Confirmed by a finance title isn't searched — 150 on weekday mornings while Serper's
  2,500 sign-up searches last — results cached 60 days (`SEARCH_CACHE_DAYS`), so steady-state re-checks fit Tavily's free 1,000 a month; accounts qualified Out
  are not searched) — reads result titles and snippets only — LinkedIn profile
  titles, company board pages, news, org charts — to confirm or replace the
  pick (when no finance director turns up, one more search under the
  company's trading name, from "trading as" in its accounts or the results) (2+ separate sites naming them = Verified; a pick shown as MD etc. is
  replaced; once every company has had its own searches, the budget left
  buys one more wording — financial controller / finance manager / chief
  accountant / head of accounts — for each company where nobody in finance
  turned up; a current FD named by the search also replaces a controller /
  manager pick, whatever its grade; for a subsidiary with no FD found, one
  more search under its parent's name for the group FD). The picker takes the
  most senior finance title any source gives (a board "Finance Manager" no
  longer stops it finding the website's FD). `no_fd_likely`: no FD-level
  person anywhere after the search, under £50m, no parent — the MD is shown
  as decision-maker. linkedin.com is never fetched; no emails or phones are kept; no
  browser automation or bot-detection workarounds. Generated Google/LinkedIn
  search links remain for checking by hand.
- **Target:** UK companies with proven foreign-currency flows, sized for a
  bank FX desk (Zac now works at Investec). Core band £20m–£300m turnover (the desk's
  sweet spot, Nov 2026); Above (£300m+) and Below are separate sections. Overseas-owned
  companies are in scope — pitch the UK team (see Owned from abroad).
- **Per company:** likely currencies (customs goods × HMRC trade statistics
  by country; dollar-priced goods — oil, metals, coffee, cocoa, soya, chips,
  aircraft: `currency.DOLLAR_PRICED` — count as USD whatever the country), an FX wallet range (cost of sales/turnover × customs-banded
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
  confidence (forward contracts in a foreign currency → geography note → currency named in
  accounts → overseas group → HMRC customs mix → niche default; `currency_source` says
  which), and a one-sentence opener built only from the detail
  columns. Every detail names its fetched source; blank beats a guess; no
  extra API calls and no AI. On the Accounts page each fact links to that source on the public
  Companies House site: the accounts document (`accounts_url`; the FX line's page, `fx_gain_loss_url`,
  for PDF/OCR figures) and the charge (`incumbent_bank_url`).
- **Incumbent + qualify** (`sourcer/incumbent.py`, `sourcer/qualify.py`): incumbent
  bank (all-assets debenture holder) and every charge's type from the charges
  register already fetched; facility end dates and "how they do FX today"
  (forwards / options / no hedging / natural hedge / named FX provider, or
  the bank named for their forwards: "a Barclays Forward Exchange Contract") quoted
  from the accounts; bank facts lead the facts and opener (`HOOK_RULES
  ["order"]`), FX gain/loss as the cross-sell; `fx_estimate` labelled as an
  estimate; `qualified` Yes/Check/Out (`QUALIFY_RULES`; a filter, not a score)
  and `warm_route` (own-bank relationship, PE sponsor, `WARM_AUDITORS`).
- **When to call** (year-end planning window, customs season) is shown but
  never scored. Triggers lift ranking a little (10 each, max 20); an FX loss
  of £50k+ in accounts filed in the last 183 days (`recent_fx_loss`,
  `RECENT_FX_LOSS` in `main.py`) lifts it 15.
- **Currency notes** (`sourcer/fx_notes.py`, read from the accounts already
  downloaded — tagged, text, and the pages of scanned filings OCR'd anyway):
  forward contracts with their size (`fx_forwards`: "to purchase US$5.2m
  (2023: US$3.1m)", fair value, a table row in the notes — "Derivative
  forward contracts 43,393" — or the hedging reserve when they hedge currency
  only, no interest rate swaps; dates and rates in a sentence aren't amounts),
  currencies the accounts tie to the business (`currencies_in_accounts`:
  "principal exposures are to the US dollar"), foreign-currency balances
  (`fx_balances`, sentences and currency-profile tables), sensitivity
  (`fx_sensitivity`: "a 10% weakening of sterling ... £450,000"), and turnover
  by region from the note's table (`turnover_regions`, also for tagged filings
  without tagged regions; overseas share when the rows add up to turnover).
  Each keeps its sentence and page (`fx_notes_url`, `turnover_regions_url`);
  amounts stay in the accounts' own currency, never converted. Not: gains or
  losses on the contracts, accounting-policy definitions, freight/commodity
  forwards, the translation policy. **Discovery signals** (Nov 2026, `fx_notes.read`, every format): accounts kept
  in another currency — tagged figures mostly in USD/EUR (`accounts.reporting_currency`) or "functional / presentation
  currency is the US dollar" (`reporting_currency`: UK wages, rent and tax paid in pounds out of foreign income; its
  filed turnover kept as filed, `turnover_foreign`, and sized at a rough rate, `APPROX_GBP_PER` →
  `turnover_foreign_gbp`, a ±10% band in the filings scan, `filings.foreign_band`, and counted by `inCoreBand`);
  subsidiaries incorporated abroad from the subsidiaries note's rows and sentences, never the parent's country
  (`subsidiaries_abroad`); borrowings in another currency (`fx_borrowings`). Points in `FILED_FX_POINTS`: own
  currency 35, subsidiaries abroad 20, FX borrowings 20. `FACTS_VERSION` 2026-11-10a: cached accounts are read again
  gradually (`FINDER_REREAD_MAX`).
  **Filed FX proof** (`filed_fx_score`,
  `filed_fx`; weights in `FILED_FX_POINTS`): what the company's own filings
  prove — forwards with a size 40, FX provider 30, sensitivity 25, FX
  gain/loss £50k+ 25 (smaller 10), how they handle FX 20, regions 20,
  currencies 15, balances 15 — added to the finder's ranking. The run summary
  counts each FX fact and where the main currency came from
  (`main.fx_summary`). Real-accounts check: `tools/fx_notes_sample.py`
  (workflow "FX notes sample"). Scanned filings get their own OCR pass for
  the currency notes (`pdf.notes_pages_order`: 62–97% through, then the
  strategic report 12–40%; ≤ `OCR_NOTES_MAX_PAGES` (8) a filing, stopping
  at a forward contract's size or a sensitivity; `OCR_NOTES_BUDGET_SECONDS`
  (1500) a run; not for filed turnover under `OCR_NOTES_MIN_TURNOVER`, £20m);
  pages OCR'd for turnover or the FX line are reused, never read twice.
- **Owned from abroad** (`hooks.run_from_abroad`, `ABROAD_RULES`): a company whose
  current corporate owner is registered outside the UK (Jersey / Guernsey / Isle of
  Man count as UK owners' holding companies) and whose own records show no FX or
  banking run locally (its own forward contracts, a named FX provider or policy —
  `fx_today` "Uses …", a bank holding its own all-assets debenture) gets
  `run_from_abroad` ("Owned from Sweden (CLOETTA AB) — pitch the UK team; ask whether FX
  is run in the UK or by the parent") and ranks 10 points lower (the desk's steer, Nov 2026:
  "they don't need to be UK-owned, but we should be pitching the UK team — lots of overseas-owned
  companies have FX in the UK, some deal with it overseas"): in the
  finder's order, in "Hottest" (within its FX-proof group; `ABROAD_POINTS` in
  `format.js`), in the filings list's `rank_score` (`filings.mark_abroad`, every
  scan, from the mini research's owner line) and so in the finder's priority
  queue. Shown on the card ("Owned abroad: pitch the UK team"), never hidden. `qualify` makes such a
  company a Check (not Out) unless its accounts show FX handled locally — then Yes.
  The filings tab can sort "Strongest FX proof first" by `rank_score`. Both the filings and FX losses tabs have a £20m–£300m button (`inCoreBand`: filed or group turnover in the core band).
- **Group accounts** (`sourcer/group.py`): for a company whose PSC register
  names a current UK corporate owner (a Companies House number), the parent's
  latest accounts are read like the company's own — one level further up when
  the parent files no turnover (`MAX_HOPS` 2) — cached per parent (lookup
  "group", `FACTS_DAYS`), at most `GROUP_READS_MAX` (200) new parents a run.
  An audit-exempt subsidiary with no turnover or customs record of its own is
  kept when its group's turnover is in the band, its size shown as the
  group's (`turnover_basis` group, the source naming the parent). Every
  subsidiary row shows `group_parent_accounts` and `group_fx` (the group's
  forwards, currencies, how it handles FX, FX gain/loss, regions;
  `group_fx_url`), and half the group's filed-FX proof counts towards its own
  `filed_fx_score`.
- **Recent FX filings** (`sourcer/filings.py`, `tools/fx_filings.py`, workflow
  "FX filings"; the Accounts page's tab of that name, GET `/api/accounts?view=filings`,
  store key `filings`): Companies House's free bulk accounts files (every set
  of accounts filed online: a zip each morning, monthly archives of the past)
  scanned for companies of `FILINGS_MIN_TURNOVER` (£20m)+ whose filing shows FX (the year was read
  again at £20m from 7 Nov 2026 — `rescan` in `tools/fx_filings_backfill.txt`: day files after the newest archive,
  then each archive newest first, chained; a company read again keeps its research, `fx_filings.LOOKED_UP`; each
  round tracks its files under its own field, `fx_filings.RESCAN_FIELD` — round 2, 8 Nov: group checks and 24 months
  of HMRC records; round 3, 10 Nov: the discovery signals below).
  A cheap screen on each filing's raw text (tagged turnover over the floor, or
  — none tagged — full-accounts-sized and mentioning foreign exchange), then
  the survivors read like the finder's accounts (`accounts.extract_facts`) and
  kept when their filed FX proof scores. Daily Tue–Sat (the day files not yet
  done); a monthly archive by hand (`next` = newest not done: the year's
  backfill). The newest filing per company, filed within 400 days. Paper
  filings aren't in the files (the main list's OCR covers them). No API calls.
  Filleted accounts (no profit and loss account: legal for "small" companies,
  two of turnover ≤ £15m / balance sheet ≤ £7.5m / ≤ 50 staff, so some £25m
  companies file no turnover) get a size estimate from trade debtors (×4–8)
  and staff (£100k–£300k a head; `filings.SIZE_RULES`), shown as "Size likely
  £16m–£26m — estimate" with its basis, never as turnover; kept when the low
  end is £10m+ and the high end reaches the floor. One too small on its own figures (or with nothing to size it)
  whose filing shows FX waits for a group check (`group_check` "pending", `filings.group_check`, run with the mini
  research: its nearest UK parent's latest accounts, `group.parent_accounts`): the group in the band → listed, sized
  as the group (`turnover_basis` group, `group_parent`, "Files no turnover — sized by its group"); no UK parent or a
  group under the floor → dropped; parent reads used up → tried next run. A big filing with no FX in it
  is kept only when HMRC's importer/exporter lists (24 months from 8 Nov 2026, `filings.CUSTOMS_MONTHS` — the main
  finder keeps 12, its wallet bands count months out of 12; matched on the
  registered name) show trade abroad (`hmrc_trade`, +20 to the score). Cards
  without filed turnover carry a "Search turnover" Google link to check by hand.
  Group companies filing the same figures are one row ("Also filed by"), and
  group filings carry a Group badge. A filing with no turnover that says it's
  prepared under the small companies regime (`filings.accounts_regime`: small
  / medium) is left out — small means turnover under £15m; medium (up to £54m)
  stays, labelled. The company name opens its Companies House page by number
  (a name search can land on a dissolved namesake). Backfill months are started
  by pushing a change to `tools/fx_filings_backfill.txt` (the coding agent can't run the
  workflow by hand): the push run starts it as a by-hand run and stops; "next 11" chains:
  each month saved starts the next (`workflow_dispatch`, `chain` input) until none is
  left. Any other push of the scanner is a test (20 companies, printed, never saved) in
  its own concurrency group, so it never cancels a daily or backfill scan; scans queue. A year runs to
  ~15,000 companies, past a store item's 25MB, so the rows are kept one month
  per item (`filings/2026-09`, by month filed) under the `filings` index
  (`apps/web/scripts/filings-store.mjs`); the tab picks a month
  (`?view=filings&month=2026-09`).
  Sanity rules (Nov 2026, from the first year's cross-check — `tools/filings_crosscheck.py`, workflow "FX
  filings cross-check", read-only: figures to doubt, group repeats, each company against the main list's own
  reading, a few doubtful figures re-read from Companies House): an FX gain/loss under £1,000 at a £10m+ company
  (`accounts.FX_MIN_PLAUSIBLE`: a £'000 figure read or tagged as pounds — 276 of the year's rows) and a turnover
  over £5bn read from text or without 1,000 staff (`MAX_PLAUSIBLE_TURNOVER`) go to a check, never a fact; an FX
  line read from the text of accounts whose tagged figures are in £'000 takes that scale when no heading is near
  it; a forward-contract row with more columns than this year and last, a gains/losses row, or a gain/loss on the
  contracts isn't a size. `filings.tidy` applies these to the rows already listed on every scan, and
  `tools/to_accounts_json.py` (`sanity`) applies them to the main Accounts list as the last step before upload
  (whatever reader or cached reading produced a row; a growth fact over 500%, a sensitivity over half of turnover
  and regions adding to more than turnover (+5%: two tables mixed) go too). Headcounts are read as
  shown, never scaled (filers tag them with scale -2 or 3); one over £20m of turnover a head is a holding
  company's own. `tools/reader_audit.py` (in the cross-check workflow) re-reads ~400 real filings with the
  current readers and holds them to hard rules — the bar for a reader change is a clean run.
  Each row also keeps: "Moved up from small accounts" (`filings.moved_up`, from
  the company's Companies House filing history — one call per listed company,
  once, `--history-max` a run), bank borrowing (`bank_debt`: the tagged figure,
  else the facilities named), and up to `FX_MENTIONS_MAX` (4) sentences
  mentioning foreign / dollar / euro / currency / hedging / overseas / export /
  import (`fx_mentions`, the business's own words before policy boilerplate,
  with the total count) — shown on the card. Mini research (`filings.research`,
  three Companies House calls per listed company, once, `--research-max` a
  run): directors, the incumbent bank (all-assets debenture holder, linked to
  the charge) and other lenders, the owner (UK / overseas parent, PE-backed —
  `owner_line`) and the main list's triggers (`triggers.find`), plus a "Google
  the FD" link; the finance-contact hunt stays in the main finder. The two
  engines join there: the finder workflow fetches this list and its strongest
  finds (filed FX proof 50+, or moved up from small accounts —
  `main.priority_from_filings`, `--priority-file`) are candidates whatever their
  SIC code — and any with an FX loss of `FX_LOSS_PRIORITY` (£100k)+, 20 points higher — and are checked first, up to `FILINGS_PRIORITY_SHARE` (70%) of the
  run's slots, strongest first (niche "FX in their filed accounts" when no niche
  or customs record brings them in) — full research and contact hunt, then the
  main Accounts list.
- **Accounts page order:** "Hottest" by default — the strongest filed FX
  proof first (headed Strong FX proof (50+) / Some FX proof / No FX in the
  filings yet), each in the finder's rank: the FD is a quick Google, the FX
  facts aren't. Each card leads with an FX strip — currencies, how they do FX
  (forwards with their size), FX gain/loss, sales by region, sensitivity,
  balances — each linked to its page, the quote on hover (in full on the
  company page). "Confirmed contact first" sort: finance contact Confirmed
  (Verified/Confirmed) first, then Likely, then "Ask for the FD" (no one
  confirmed; research clues shown); buttons filter by those groups. "Job role" sort
  and filter: CFO/FD → Head of Finance/Treasurer → Financial Controller →
  Finance Manager → Accountant → Other director → other / no one
  (`ROLES` in `apps/web/src/accounts/format.js`). Companies added
  by the latest upload are labelled New (`first_seen`, carried over by
  `upload-accounts.mjs`). The Contacted button moves a company to the
  Contacted tab (marks kept in the private store under `contacted`, via POST
  `/api/accounts`; the finder never touches them). Follow-ups
  (`apps/web/src/accounts/followups.js`, shared by the page and the API):
  "Contacted" asks the channel (phone / email / LinkedIn / in person) and
  logs a touch; the next follow-up is due 2, 4, then 7 days after each touch,
  then nurture (90 days); a reply / meeting / not interested stops it; Zac
  can move the date. The Contacted tab groups Overdue / Due today / Replied
  / Upcoming / Nurture / Meeting booked / Not interested, with the suggested
  next action and a copy-ready line (event reminder → new angle → soft bump
  → break-up, from the company's own facts; no AI, nothing sent). Each card has a Notes box
  (store key `notes`, same POST with `{company_number, notes}`; "" deletes;
  searched by the search box and included in the CSV export). Clicking a
  company's name opens its own page, `/accounts/<company number>`
  (`functions/accounts/[[path]].js` serves accounts.html; same password): key figures, finance
  contact, notes, Contacted, why call, every detail grouped Banking / FX
  exposure / People / Company with each fact linked to its filing or charge,
  and a Source documents list (`detailSections`, `sourceDocuments` in
  `format.js`).
- **Evidence comes from raw records, in this order:**
  1. HMRC monthly importer/exporter lists, matched to Companies House.
  2. Filed accounts: tagged iXBRL figures (turnover, cost of sales, FX
     gain/loss, currency or region breakdowns, hedging, bankers, and the
     currency notes above), else the
     PDF's text (pdftotext, or Tesseract OCR of the first pages for scanned
     filings, more pages for turnover and the FX line — system tools
     installed in the workflow, not Python packages).
     The FX gain/loss: a tag counts only when its row is an exchange/currency
     line in pounds (Wanis tagged "Stocks recognised as expenses"); otherwise
     the "Exchange differences / losses/(gains)" line in the notes text
     (`sourcer/fx_text.py`; scanned filings: OCR of the pages 60–90% through,
     `OCR_FX_BUDGET_SECONDS` a run). Over 20% of turnover, no gain/loss
     direction, or not in pounds → `fx_gain_loss_check`, never a fact.
     Real cases: `tests/test_fx_cases.py` (`tools/fx_case_study.py`).
     Turnover and cost of sales (`sourcer/turnover_text.py`): a tagged total
     (a consolidated — `GroupCompanyDataDimension` — figure is the group's,
     before the parent's own), else the profit and loss account's row (the
     table row in a tagged filing; scanned filings: OCR of the pages 15–55%
     through, `OCR_PL_BUDGET_SECONDS` a run), saying group or company, this
     year v last (column years), £ / £'000 / £m (the table heading), the page
     (`turnover_source`, `turnover_basis`, `turnover_url`). Turnover must equal
     cost of sales + gross profit: a misread or missing turnover cell is worked
     out from them, and says so. A strategic report sentence ("turnover for the
     year was £95.3m") only when no statement can be read. Never an estimate:
     $/€ accounts, a statement starting at gross profit (abridged) or no profit
     and loss account → `turnover_check` ("turnover not disclosed: …").
     Real cases: `tests/test_turnover_cases.py` (`tools/turnover_sample.py`,
     workflow "Turnover sample"). Cached accounts without turnover are read
     again, `FINDER_REREAD_MAX` (300) a run.
  3. Companies House owners, charges and directors.
  4. The FX niches (`lead-sourcer/config/fx_niches.json`) — **sector niches** (SIC codes, self-chosen) and, from 10 Nov
     2026, **goods niches** (`hmrc_codes`: customs headings a company's HMRC importer/exporter records show it trading —
     cut flowers, bloodstock, seafood, nuts, timber, stone, fasteners, bikes, rugs, hair… `flow` import / both; a goods
     niche wins over a sector niche, `sourcer/niches.py` `goods_niche`: 3+ code-months and 10%+ of its declared codes).
     Every niche is **measured weekly** (`tools/niche_hits.py`, workflow "Niche hits", store key `niches/stats`): of its
     full / medium / group-accounts companies, the share with strong FX proof in their filings (hit rate) and, of those,
     the share naming no forwards or FX provider (open); score = hit rate × (0.5 + 0.5 × open share). The finder
     (`NICHE_STATS_FILE`) checks niches in score tiers (3 best … 0; unmeasured 1) and skips niches measured as poor
     (verdict "drop": 40+ companies, under 1% hit rate). The run also lists every customs heading by score, flagging
     ones no goods niche covers yet — where new niches come from. **Catch-all codes name no niche** (11 Nov 2026: a
     toothbrush wholesaler was labelled a musical instrument distributor through 46499): a SIC code 4+ specific niches
     share (`niches.catch_all_codes`: 46390, 46900, 46690, 46460, 46750, 74900, 46499) is left out of sector-niche
     matching and measuring; a company with only such codes is still a candidate, as "Broad wholesale / trade sector"
     (`main.BROAD_SECTOR_NICHE`), after its customs record's trader niche. Which sectors to add is measured, not guessed:
     `tools/sector_hits.py` (workflow "Sector hits", read-only) counts the FX filings scan's strong finds per SIC
     code against each sector's full / medium / group-accounts companies and lists the best-hitting sectors the
     niches don't cover.
     **Emerging niches** (Zac's origination ideas, 21 Nov 2026, his priority: "continuously investigate emerging
     industries … discover pockets of demand before they become saturated"): the weekly measuring run also counts every
     sized active company's sector codes across the whole register (`bulk.scan(sectors=…)`) and turns uncovered customs
     headings and uncovered, non-catch-all sector codes whose companies prove FX as often as a good niche (score
     `EMERGING_MIN_SCORE` 4.0, 5+ strong finds, `EMERGING_MAX` 15 of each) into **trial niches**
     (`niches.emerging_niches`; headings named from uktradeinfo's Commodity table, `hmrc.heading_names`), saved in
     `niches/stats` as `emerging` with their numbers under `niches` (kind "emerging goods" / "emerging sector"). The
     finder adds them to its niches (`niches.load_emerging`, NICHE_STATS_FILE) and searches them like any other, in their
     measured tier; re-derived weekly, so one that stops hitting drops out (a lasting one belongs in fx_niches.json). The
     Niches tab marks them and has an "Emerging only" filter; the run prints them. **Emerging leads tab** (Zac, 21 Nov 2026: "sort all of
     these new leads into a column — I'll check them all today"): every full / medium / group-accounts company in an
     emerging niche (`niche_hits --emerging-out` → `emerging_companies`: goods niches by the measured customs rule, sector
     niches by a bulk-file pass for their codes; store key `emerging/companies`, GET `?view=emerging`), strong FX proof
     first, with the Simplified dash's Open lead / Added to mine / Owned abroad buttons (To check and a list per button),
     a niche filter, Strong FX proof only, search and Excel export.
- **Scores:** every score and estimate lists its evidence or basis. Weights
  and wallet bands get recalibrated against real outcomes, so log them.
- **Not public, not scraped:** credit-reference data (Creditsafe etc.) only
  via a licensed API if the bank has one.
- **Contact routes and email drafts:** in scope until Cognism arrives
  (mid-November 2026). Generic company emails only (Priority 12), and
  rule-based drafts (Priority 1: no per-lead AI calls).
- **Lead score** (Zac's steer, 10 Nov 2026: "recent, FX loss, nice industry, new FD, has subsidiaries — extra points";
  `leadScore` / `LEAD_POINTS` / `leadLine` / `withLeadScores` in `format.js`): points, each with its reason — strong
  filed FX proof 20 (some 8), FX loss £50k+ 20 (£250k+ 30) and +10 when those accounts were filed in the last 6 months,
  accounts filed in the last 90 days 10, new on the list 5, the company's niche by its measured tier (15 / 8 / 3,
  `nicheTiers` from `niches/stats`), a new finance director 20 (an Alerts `new_fd` / `news_fd` in the last 120 days or
  a trigger naming one), another change 10 (owner, charges), expanding abroad in the news 8, hiring for treasury / FX 5,
  subsidiaries abroad 10, £20m–£300m 10, no hedging named 5, owned abroad −10, a name ending in UK / (UK) / U.K. /
  (GB) −10 (Zac, 13 Nov 2026: "obviously got an overseas owner" — `ukArmName`; not on top of owned abroad, and not when
  the register shows only people as owners). GET `/api/accounts?view=signals` gives
  the page the niche tiers and each company's recent alerts. The Accounts list sorts by it by default ("Lead score"),
  the Sheet has a Score column, cards and Call today show the breakdown, the company page a "Why it ranks" panel, and
  the exports carry `lead_score` / `lead_reasons`. Call today orders its picks by it. **Fit and Timing** (Zac, 15 Nov 2026: "do the fit and timing split"):
  each reason counts in **Fit** (the right company — FX proof, the FX loss's size, niche, £20m–£300m, subsidiaries abroad,
  no hedging named, PE-backed, owned abroad / UK-arm name −; 0–100, `lead_fit`) or **Timing** (why now — the loss filed
  lately, just filed, new on the list, new FD, deals, funding, owner, moments, currency moved, triggers, news, hiring, the
  hit-list combo; 0–100, `lead_timing`); an insolvency hold-off stays a stop. `lead_score` = 20 + 0.3 × Fit + 0.3 × Timing
  (0.5 × Timing until 22 Nov 2026 — the second recalibration below) when Fit ≥ `FIT.min` (30), else Fit ÷ 2 — so good fits rank on timing and news never lifts a poor fit above them.
  Tabs **Best fit** (Fit 30+, by Fit) and **Call now** (Fit 30+ with Timing > 0, by Timing), each with its half's
  reasons, an industry filter and Excel export; Sheet columns Fit / Now; exports `lead_fit` / `lead_timing`. The Niches
  tab's "Fit 60+" counts leads by Fit. The weights are logged here to be
  recalibrated against what Sales takes. **First recalibration — Zac's review of ranks 35–77 (16 Nov 2026)**: his best
  lead, Global Charter, ranked 77th (growing 54%, a USD loss of £96k, no hedging named, a new equipment-finance lender),
  so Fit adds growth 20%+ 10 / 40%+ 15 (`growth`, `fastGrowth`) and an FX loss with no hedging named 10 (`lossNoHedge`),
  and a new charge (new borrowing / a new lender) counts 15 in Timing (`newLender`, a plain change stays 10); a **"Like
  Global Charter"** filter (`lookalike`: UK-owned, £20m–£100m, FX loss £50k+, no hedging named, still growing). The same
  review: 22 of 43 were already with the bank (the CRM check — not detectable from public records, and never stored
  here), 7 were owned abroad though marked UK-owned (what the owner search fixes), and holding companies (Topco, Holdings)
  were labelled "Finance & insurance" from their holding-company sector code. **Second recalibration — Zac's review of
  22 Nov 2026** (the leads he took into his book, against the top 300 by lead score; aggregates only — which companies
  the bank already knows is never kept here): he took 9 of the top 300 (the rest already known to the bank) and 21 in
  all. Same Fit (median 91 both) but a lower Now (median 20 v 30 — a freshly filed FX loss draws every bank), sector
  codes that hide them 38% v 23% (other business support 19% v 6%), emerging / customs-trader niches 20% v 7%, from the
  FX filings scan 0% v 11%. So: `FIT.timingWeight` 0.5 → 0.3 (simulated on the day's ranking: his picks' median rank
  383 → 275), `LEAD_POINTS.hidden` 8 → 10, and `quietNiche` +6 Fit for an emerging or customs-trader niche ("A niche
  few bankers search"). The CRM status itself can't be scored from public records, so the lever is his marks:
  **Mark leads in bulk** on the Scoreboard tab (`matchCompanies` in `format.js`: paste names — a unique prefix or
  a name cut short with "…" will do — or company numbers; heading lines set the mark for the names under them,
  `markSections`: "Added to mine:" (the default), "Open lead:", "Owned abroad:", "Good lead:", "Not a fit (No real FX):"
  — the reason mapped to `VERDICT_REASONS`, else Other; `markMany` sets each mark, never toggles one off, in **one bulk
  save**, POST `{marks: [{company_number, review} | {company_number, verdict, reason?}]}` (≤ `MARKS_MAX` 500: one read and
  one write of `checks` / `verdicts` — the first paste, saved one company at a time, kept 11 of 54 marks); only the mark
  and its date kept) feeds the profile lookalikes and the feedback loop.
- **Every lead ranked** (Zac, 11 Nov 2026: "scan all the leads, rank them in our scoring system, add them to the
  Accounts page, learn which niches are better — you'll come across some absurd ones"): the "Niche hits" workflow
  (daily 04:23 UTC) also tags every company on the Accounts and FX filings lists (`alerts-store.mjs tracked`) with its
  niche (`niches.company_niche`: customs goods first, else its sector), its SIC codes (`bulk.scan(registry=…)`) and an
  **absurd check** (`sourcer/absurd.py`: dissolved / in liquidation, an FX provider itself, banks, building societies,
  funds and trusts, insurers, pension schemes, brokers, fund managers, public bodies, trade bodies, not-for-profits —
  by sector only when all its codes are such, else by type or registered name), then `scripts/rank-leads.mjs` scores
  every lead with the page's own lead score (`src/accounts/ranking.js` `rankLeads`) and saves `leads/ranked` (GET
  `?view=ranked`: the filings companies not on the list, slim — `RANKED_FIELDS` — with their niche; `ruled_out` for
  both lists; `niches`, the per-niche learnings: leads, average score, 60+, in the band, FX loss, ruled out). The page
  adds those companies to the Accounts list (section "From FX filings", their own company page) and qualifies the
  absurd ones Out with the reason (seen under "Show qualified out"). The run prints the top 30, the niches by average
  lead score and the absurd ones by reason. **Niches tab**: each niche's measured hit rate, open share, score and
  verdict beside its leads' numbers, sortable; clicking a niche searches the list for it; uncovered customs headings
  listed under it.
- **Deals: the Hit list and New money** (Zac, 12 Nov 2026: "forget the contact etc — go hard on companies who filed
  recently with an FX loss and a new FD, or are purchasing subsidiaries; and companies just funded which will have FX,
  or just bought by a PE"). Three sources: (1) the filing's own text (`sourcer/deals.py`, in every FX filings row —
  rescan round 4, `files_rescanned_r4`): companies bought in the year (`acquisitions`, `acquired_abroad`, the sentence
  in `acquisitions_evidence`; policy text skipped; every word of a bought company's name capitalised — "the acquisition of
  the Company by X Limited" is the filer being bought, not buying; `deals.tidy_row` in `filings.tidy` clears older reads) and a finance director / CFO the directors' list says was appointed
  (`new_fd_in_accounts`); (2) Companies House's free daily ownership snapshot (`sourcer/owners.py`,
  `tools/psc_deals.py`, in the daily "Niche hits" workflow; ~2.6GB, corporate owners only): every company with a new
  corporate owner in the last 120 days — `pe_buyout` (a Bidco / Topco / Midco … vehicle, a named UK PE house, a fund),
  `eot`, `overseas_buyer`, and `acquired` (a UK trading company bought it: the buyer is the lead); a group reshuffle
  (owner sharing the target's name, one vehicle replacing another, a buyer taking 4+ companies in a day), a company the
  buyer just set up, and a dormant / estate-management / nominee company bought skipped; kept when active, filing full / medium /
  group accounts (or on the lists) and with an FX sign (on the lists, HMRC trader `traders.json` from niche_hits, an FX
  niche, a buyer abroad); store key `deals`, also the finder's discoveries (`DEALS_FILE`, 60 for PE / buying, 50
  others); (3) the news (`tools/ch_alerts.py --signals`: `news_pe` — buyouts, "backed by" / "acquired by" a PE house
  — and `news_funding` — "raises £25m Series B"). Lead score (`LEAD_POINTS`): buying companies 15, a PE deal 15, just
  funded 10, a new overseas owner / EOT 10, a new FD named in accounts filed within 365 days 20, and the **hit-list
  combo** 15 when an FX loss of £50k+ in accounts filed in the last 6 months comes with a new FD, a purchase or a PE
  deal (`lead_flags.hit`). **Hit list tab**: those companies, highest score first ("Also without an FX loss" widens
  it), Excel export. **New money tab** (GET `?view=deals`): the ownership register's deals and the news of PE deals and
  funding, newest first, filters, each with its FX sign. Contact-finding is no longer being extended.
- **Private equity and new finance directors** (Zac, 15 Nov 2026: "improve the FD, PE-backed and private equity
  companies"). **PE-backed** (`sourcer/pe.py`; one house list, `pe.HOUSES`, shared with `owners.py`): a PE house, fund
  (LP) or buyout vehicle (Topco / Bidco / Midco — not Holdco alone) as an owner **anywhere up the chain** (the daily
  ownership pass: `owners.pe_owner`, saved as `group_of[number].pe` by `psc_deals.py --groups-out`), a PE house or fund
  the accounts name as **ultimate controlling party** / "funds managed by" (`pe.text_evidence` → `pe_sponsor`, every
  accounts reading, `FACTS_VERSION` 2026-11-15a, and the FX filings scan), or an outstanding charge to a **private-credit
  lender or loan agency** (Ares, Pemberton, GLAS, Lucid … — `pe.lender_kind`; a bank "as security agent" alone isn't
  counted). Main list and filings research: `pe_backed` + `pe_backed_evidence` (`pe.backed`; the evidence stays on the
  list — `LIST_EVIDENCE` — for the chip's hover). Page: `peBackedOf` (all of these), +10 lead points (`peBacked`; a fresh
  PE deal's 15 instead), a "PE-backed: …" chip and a PE-backed filter. Alerts: a new charge to such a lender is
  `pe_debt` (hot, any company: a discovery at 55 when not on the lists; counted as a PE deal; in New money as
  "Buyout-style debt"); the Alerts tab has a Private equity filter. **New FD**: finance director / CFO / head of finance
  job adverts (Adzuna, `FD_JOB_QUERIES`, two pages each; interim / assistant / deputy left out) are `hiring_fd` — hot, a
  new FD for the lead score (20) with its own reason and timely line (`fdWhy`), and a discovery by exact registered name
  for a company not on the lists; `news_fd` headlines now discover too (`DISCOVER_FROM_NEWS`). The accounts' directors
  list read on the main list as well (`deals.fd_columns` in every accounts reading: `new_fd_in_accounts`), and a director
  shown as appointed with no title counts when the accounts name them with a finance title elsewhere (the signature
  block, "Jane Smith, Chief Financial Officer"). A "New FD" filter and chip on the Accounts list.
- **Industry** (Zac, 15 Nov 2026: "a type of company section, ie what industry"): `industryOf` in `format.js` from the
  company's first sector code (`sic_codes` on list rows, `sic` on filings rows) — the register's divisions in ~25 plain
  groups, wholesale split by what it sells (food & drink, machinery, fuel & metals …) — an "Any industry" filter with
  counts on the Accounts list and the New money tab (deals carry their own sector codes from the ownership pass; news
  items take the list row's), an Industry column in the Sheet and New money, a chip on cards, and an `industry` export
  column.
- **Groups: one lead per group** (Zac, 14 Nov 2026: Cognism files people under the group or brand, not the subsidiary
  we list, and one group showed up as several leads): the daily "Niche hits" run's ownership-snapshot pass
  (`tools/psc_deals.py --groups-out groups.json`, same single read of the file: `owners.tee_parents`) walks every
  tracked company up its current UK corporate owners with a Companies House number to its top UK parent
  (`owners.group_of`: `{top, top_name, hops, abroad}` — a joint venture's lowest-numbered UK owner, loops stopped,
  the owner registered abroad above the top noted), names from the register file; `rank-leads.mjs` saves it in
  `leads/ranked` as `group_of` and prints the groups with 2+ leads; `find_domains.py --groups` looks up each lead's
  top parent's website straight after the lead's own. The page (`setKnownGroups`, `groupKey`, `collapseGroups` in
  `format.js`): the Accounts list shows **one row per group** by default ("One per group" toggle) — the group's best
  lead by lead score, the others folded in (`group_members`, "+N group companies"), a "Group: …" chip on cards and
  the company page; the **Cognism company list** is one row per group, named as the group (top parent) with the
  group's website when known, else the company's own, plus "Registered Company (lead)" and "Group Companies on the
  List" columns.
- **Modern slavery statement registry as a source** (14 Nov 2026, discovery review): every organisation with £36m+
  turnover publishes a statement; the registry's yearly CSV (`registries.MSS_URL`, ~12,000 statements; columns
  checked with `tools/mss_probe.py`, workflow "Modern slavery registry probe", no names printed) gives company number,
  turnover band, sectors, parent and the countries of named supply-chain risks (Risk1-3Location). `sourcer/mss.py`
  keeps private companies in the £36m–£60m / £60m–£100m / £100m–£500m bands whose supply chain runs abroad (60) or
  whose sector is goods trade (50) — not finance / property, charities, public bodies or education only — and the
  finder (`MSS_DISCOVERY=1` in its workflow) checks them with the FX filings scan's finds (`priority_from_filings`),
  niche "Supply chain abroad (modern slavery statement)" when nothing else names one. Size-qualified by law, and it
  reaches companies whose accounts aren't in the online files.
- **Moments: the time to call** (Zac, 14 Nov 2026: "a company which just got funded, a new FD, large FX losses — let's
  think of more … add all of these"). Each a signal (kind, at, title, detail) the lead score reads, **fading with age**
  (`fade`: full points for 30 days, half by 90, half until 120, then none; `LEAD_POINTS` fullDays / halfDays /
  momentDays), one per group (a funding round beats its parts; a new trader beats trade growing):
  (1) **Companies House streams** (`tools/ch_alerts.py`, the filings and insolvency-cases feeds added to officers /
  charges / owners): new shares issued (SH01, `shares_allotted` 8), new articles / share classes (MA, SH08, SH10, SH02,
  resolutions adopting articles — `articles_changed` 5), both within 60 days = `funding_round` (15, hot), a new
  auditor (`auditor_changed` 8), the year-end moved (AA01, `year_end_changed` 8), a new director resident abroad
  (`director_abroad` 5; the register still gives the country of residence), and a **bank switch** — a new or paid-off
  charge reads that company's charges register once (`SWITCH_CHECKS_MAX` 60 a run) and an all-assets charge to one bank
  paid off with a new one to another within 180 days is `bank_switch` (15, hot; its charge isn't counted again as a
  "Change"). (2) **HMRC customs** (`hmrc.moment`, in the daily "Niche hits" run, 24 months of trader files read and
  cached as `hmrc-24m-*`; niches still measured on the latest 12, `codes_since`): first customs records in 24 months
  within the latest 3 months of the files = `new_trader` (20), imports or exports started when it traded the other way
  before = `new_import` / `new_export` (15), 4+ more months active than the year before or twice the kinds of goods =
  `trade_up` (10); dated two months after the month (the files' lag). When uktradeinfo is down (502s, 14 Nov 2026) `hmrc.download` carries on with the files already downloaded (`cached_files`) instead of stopping the run; when only its archive page fails (15 Nov 2026 — the run read ~3 months as 24, 17,000 companies became "new traders" and the lead scores and database churned), the months it didn't list come from the cached files too, and `niche_hits.write_moments` writes nothing when the files cover under `MOMENT_MIN_MONTHS` (15) months, so the store keeps the last good moments. Months the files still leave out are filled from **uktradeinfo's own data API** (18 Nov 2026, found by recording the site's traffic — the reverse-api-engineer method; `api.uktradeinfo.com`, OData, free, no key: Trader / Import / Export with 8-digit codes): `hmrc.gaps` → `fill_from_api`, newest first, `HMRC_API_MONTHS` (6) a run, each saved as an ordinary monthly file (`imports-M2607.zip`, the bulk layout) so it's cached and read unchanged; checked against September's real exporters file (99.96% of traders, 99% identical codes). No gaps, no calls. Store key `moments`; the lists' companies are
  signals and show in the Alerts tab ("Customs"); companies not on them filing full / medium / group accounts with a
  new flow are the finder's discoveries (`MOMENTS_FILE`, 55 new trader / 50 a flow started). (3) **The accounts
  already read** (`accountsMoments` in `format.js`): overseas share up 5+ points on last year (10; last year's share
  from tagged filings only — `accounts.overseas_share_prior`, `overseas_turnover_share_prior`, `FACTS_VERSION`
  2026-11-14a), an FX gain last year turned into a £25k+ loss (`fxSwing` 10), forward contracts the accounts say mature
  within a year (5: renewal coming). A rise in the sensitivity figure isn't read (last year's isn't kept). (4) **Its
  currency moved**: the company's own main currency (not a niche default, `ownCurrency`) moved 3%+ against the pound in
  a week or 5%+ in a month on the market moves page's ECB rates (`currencyMoved` 10; the page reads `/api/market`,
  `rank-leads.mjs` the `fx-market/latest` store item). (5) **Hold off**: an insolvency filing or case, or a winding-up
  petition in the Gazette (`gazette_petitions`, notice code 2450, daily with the news; matched by company number, else
  name) — −60 and a serious reason not to progress, so it's never on Call today. Call today takes the strongest moment
  as its trigger. The Alerts tab filters Money in / Banks & charges / Owners & deals / Customs / Hold off. **Growth
  lists** (the Sunday Times International Track 200, King's Award winners): `tools/growth_lists_probe.py` (workflow
  "Growth lists probe", read-only) checks the publisher's terms, robots.txt and format first — no importer until they
  allow it.
- **Outreach tab** (Zac, 14 Nov 2026: "the best leads ranked top 40, which we send our outreach letter to … then rank
  the rest by either email sequence or cold call"; the Accounts page's first tab, `outreachPlan` / `outreachWhy` in
  `format.js`): every lead not contacted, not qualified out (verdicts included) and with no serious reason not to
  progress, one per group (a group with any company contacted is left out), by lead score. The top `OUTREACH.letters`
  (40) get the Investec letter — addressee (the presented finance contact, else "The Finance Director" / "The Managing
  Director") and the registered office (list rows' own; the FX filings rows' from the bulk file via `niche_hits`
  enrich → `rankLeads`). The rest: **cold call** when there's something timely to say (`timelyReason`: the strongest
  moment, a recently filed FX loss, a new FD, buying companies, a PE deal, funding, a trigger), else the **email
  sequence**. Each card and export row carries its justification (`outreach_why`: why this list, the place in the
  ranking, what scores it, what counts against it, the group it stands for). Contacted → Letter (a channel in
  `followups.js`) moves it out and the next one up; the follow-up after a letter is a call. Excel export per list
  (the letter's with addresses), and a Cognism company list for the call and email lists.
- **The database move** (Zac, 14 Nov 2026: "go ahead with the database move", after the architecture review scored
  the key-value storage 4/10 — 25 MB items forced month splits, detail shards and trimming, and the browser loads and
  scores everything): Cloudflare **D1** (SQLite, free plan), `apps/web/api/db.mjs` (schema `SCHEMA`: `companies` — one
  row per company on either list, `row` / `details` JSON plus lead_score, group_key, source, niche, ruled_out columns;
  `signals` — alerts, deals, customs moments; `marks` — contacted, notes, verdict, check, email; `meta`), shared by the
  Functions (binding `FX_DB`, `d1Query`) and the workflows (`scripts/d1.mjs`, Cloudflare's HTTP API; needs **Account →
  D1: Edit** on `CLOUDFLARE_API_TOKEN` — without it everything skips with a note and the site runs from the store).
  `cloudflare-setup.mjs` creates the database `fx-dashboard-db` and the binding on deploy (never writes to it; the syncs
  make the tables). **Free plan's daily limits** (14 Nov 2026: the first day's syncs hit 100,000 rows written — every
  index entry counts as a row, and every company was rewritten): `SCHEMA_VERSION` 2 — tables `WITHOUT ROWID`, no
  secondary indexes (one row written per record; a version change drops and remakes them, refilled by the next sync);
  the hash ignores figures in the lead score's reasons (a currency's % move, a fading moment) so a company is rewritten
  only when something real changes; each sync keeps to `DAILY_WRITES` (40,000 a day — 60,000 until 15 Nov 2026, when the rebuild's table drops cost writes D1 counted but didn't report back and the limit was met at 45,000 by our count, counted from D1's own
  `rows_written`, meta `writes`), marks and signals first, then companies best lead score first, the rest `deferred` to
  the next sync; a sync that meets Cloudflare's limit says so and stops cleanly; only runs on main copy (a branch push runs Niche hits in
  full — 15 Nov 2026 its copy spent 19,600 writes); deletes look each key up by the primary key, `DELETE_BATCH` (1,000) at a time (16 Nov 2026: one DELETE over json_each scanned the
  whole table per key and ~17,000 stale signals ran over D1's CPU time limit, error 7429 — logged as that, not as the write limit);
  each sync logs which fields differ on a sample of the records it
  rewrites (`changedFields`, names and counts only), to find what makes records churn. The Outreach view takes Contacted and Not
  a fit from the store (right even when the database can't be written; contacted groups by key lookups, group members
  in one GROUP BY, so rows read stay low) and isn't served until a full copy exists (`complete`): the page ranks in the
  browser meanwhile. **Stage 1
  (now): a mirror** — `scripts/db-sync.mjs` (step "Database" after the finder upload, the Niche hits ranking and each
  Alerts save; `continue-on-error`) builds every record from the store (`buildRecords`: the page's own `leadScore`,
  `groupKey`, niche corrections, ruled-out reasons) and writes only rows whose hash changed (`syncTable`: batched
  `INSERT … SELECT FROM json_each(?)`, one parameter a batch; deletes what's gone), then checks the database's counts
  against the store's ("match" / "MISMATCH" fails the step). GET `?view=db` says whether the site sees it, when it
  was last copied and how many rows. Tested on Node's own SQLite (`src/db.test.js`). **Stage 2 (started)**: the sync
  also stores each company's outreach inputs (columns `held` — a serious reason
  not to progress — `timely`, `hit`, `shy`, `lead` — the score's parts); GET `?view=outreach&list=letter|call|email&offset
  &limit` ranks the **Outreach tab** in SQL (`outreachPage`: one per group by window function, contacted groups and Not
  a fit left out, the top 40 the letter, then cold call / email by the timely reason — the same lists as `outreachPlan`,
  tested side by side) and the tab uses it when the site has the database ("Ranked in the database (copied …)"), else
  works it out in the browser as before; exports page through the whole list. Every save on the page (contacted,
  notes, verdict, CRM tick, email) is also written to the database at once (`setMark`), never failing the save. Next:
  the other tabs and the main list served the same way. **Stage 3**: the writers
  go straight to the database and the store's list, detail shards and month items retire.
- **My lists, score bullets, What we can pitch them** (Zac, 15 Nov 2026): every card and company page has **+ Call list
  / + Chocolate / mailing list / + Email list** (`ListButtons`, beside the verdicts; one list a company, store key `lists`,
  POST `{company_number, list: "call" | "post" | "email" | null}`, mirrored to the database as mark `list`); the **My lists**
  tab became three tabs, **Call list / Email list / Mail list** (`list-call` / `list-email` / `list-post`), each with **Ready** and **Can't find info** sections (`missing: true` on the mark, POST `{…, missing: true}`; the card's "Can't find info" / "Found it" button moves it) and an Excel export laid out like Zac's follow-up grid (Account Name, Companies House Number, Name, Job Title, CRM,
  blank LinkedIn / Email Address / Mobile Number for him to fill bank-side — never stored here — Send Out or Cold, Gift
  Send Out Date, address, then Step 1 … Step 18 with each date done ✓ or due). **Outreach sequence** (`src/accounts/
  sequence.js`, Zac's grid, 15 Nov 2026): 18 steps over 20 working days from Day 0 (the cold email, or the gift — Mail
  list): calls 1–6 + final call, emails 1–8 (follow-up, intro, treasury, case study, market insight, money, Investec,
  break-up), two LinkedIn touches (`SEQUENCE`; days counted Mon–Fri, `addWorkingDays`); started per card ("Start
  sequence today" or a Day 0 date), each step ticked off, the next due shown first (overdue / today), list cards sorted
  by it, "N due" on the Ready button. Saved on the list mark as `seq: {start, gift?, done: {step: date}}` (POST
  `{company_number, sequence}`, `validSequence`; kept when the company changes list). Each email step has an
  "email" link opening its draft (`StepEmail`; `src/accounts/templates.js`): the desk's emails that worked (Zac, 15 Nov
  2026) — Chocolates 1 (they've landed), Chocolates 2 (why I reached out), Generic first email (what we do: treasury /
  lending / corporate finance), Proactive FX risk management (dedicated dealer, FTSE 100 balance sheet), Personalised
  FX (from their accounts: turnover growth, their own currency's move on the ECB rates, working capital and money market
  accounts). Mail list steps 1/3/5/8/12 start with choc1 / choc2 / generic / fxdesk / personal, the cold route's 1/3/8
  with generic / personal / fxdesk (`STEP_TEMPLATES`); case study, money, Investec and break-up have none yet (any
  template can be picked). Filled from the records only (first name of a presented contact, the company's name, growth,
  own currency's 3-month move), with where each part came from; gaps stay [placeholders]; the originals' prospect and
  colleague names aren't kept; signed Zac. Editable, Copy; nothing is sent. **Email the finance team, call the next
  day** (Zac's rule of thumb, 15 Nov 2026): Step 1 on the cold route ticks who got the email — Finance Director /
  Financial Controller / Finance Manager (`ROLES`, saved as `seq.roles`) — and Call 1 ("did you see my email?") shows
  who to ask for (the most senior emailed) and the opening line (`callScript`: "…I sent you and the finance team an
  email yesterday introducing our FX risk desk; did you get a chance to see it?"; a Monday call after a Friday email
  still says yesterday). **Today tab** (`todayQueue`): every list's steps due today or overdue — calls first (with the
  line), then emails (draft one click away), then LinkedIn — overdue and best leads first, each with Done / Sent; then
  "Start today", up to `START_PER_DAY` (5): companies on a list not started, then the best-scoring leads on no list (Fit
  30+, not out, no "UK" name) — "Email today, call tomorrow" puts it on the Email list and starts Day 0. The lead score's
  reasons are bullets grouped Fits because / Why now / Counts against (`ScoreBreakdown`; folded under "Why this score" on
  cards, open on the company page). **What we can pitch them** (`src/accounts/pitch.js`, `PRODUCTS` / `pitchFor` /
  `pitchLine`): Investec UK's public corporate products (investec.com/en_gb, read 15 Nov 2026 — corporate deposits:
  notice 32/65/95-day, fixed-term, instant access in GBP/USD/EUR for £5m+; FX spot/forwards/options; interest-rate and
  commodity hedging; invoice finance, ABL, RCF, term loans, growth, acquisition/leveraged and asset finance) matched by
  rule to the company's filed facts (cash £5m+ → deposits, £2m+ asks; foreign balances → currency deposits; a currency
  with no hedging → forwards, already hedging → a competing quote; an FX loss £100k+ or a sensitivity → options; bank
  debt £5m+ → rate hedging; commodity niches; buying companies / PE-backed → acquisition finance; facility ending or
  lending changing → refinance; growth 20%+ → working capital (+ growth finance abroad); plant-heavy industries → asset
  finance), each with the fact that triggers it and the product page. No rates quoted, nothing from the bank's records,
  no AI. Company page panel, a Pitch line on My lists cards, export column `what_to_pitch`. FX filings rows now keep
  `cash_gbp` / `bank_borrowings_gbp` (new and re-read filings).
- **UK in name** (Zac, 15 Nov 2026: "move every company that has UK in the name to its own section, remove it from the
  others"): `ukNamed` / `UK_NAME` in `format.js` — "UK", "U.K." or "(UK)" as a word anywhere in the registered name (not
  UKAY, PUK). Those companies are only in the **UK in name** tab (highest lead score first, industry filter, Excel
  export); the Accounts list, Best fit / Call now, Hit list, Hard to broker, FX filings, FX losses and New money leave
  them out, and `reasonsNotToProgress` gives them a serious reason, so Outreach (browser and database), Call today and
  the database's `held` column drop them too. Contacted ones stay in Contacted; lists and company pages still find them.
- **Where finance decisions sit** (Zac, 16 Nov 2026: "come up with indicators that can qualify or disqualify … whether
  the decisions in terms of finances happen in the UK"): `src/accounts/control.js` `financeSeat` weighs, each with its
  points and reason — owned from abroad (the owners list / run-from-abroad line / the filings research's owner, −15),
  the lender (a UK clearing or mid-market bank holding its own facility +20; a US / European / Asian bank −15 — "Goldman
  Sachs: probably US-run"), its own forward contracts (+25) or FX handled itself (+20), borrowing in its own name in
  another currency (+10), the board (`board_line`, current directors' country of residence from the officers already
  read: mostly UK +15 when owned abroad, mostly abroad −15), and the accounts' own words (`lead-sourcer/sourcer/
  control.py` `text_clues` → `control_clues`, `FACTS_VERSION` 2026-11-16a and the FX filings scan): treasury run
  centrally by the group −30, FX managed by the group / parent −35, a group cash pool −20, the parent's letter of
  support −20, funded through the group's facilities −20, amounts owed to the parent −10, its own revolving credit
  facility +20, a UK-based treasury team +30 (policy boilerplate skipped). Lean: UK-owned (no foreign owner, nothing
  saying the group runs it), "Owned abroad, but decides in the UK" (owned abroad, net +5), "Likely run from abroad"
  (net −20 or less), else "Unclear — ask where FX is decided". Lead score (Fit): run from abroad −20, owned abroad but
  decides in the UK +5, owned abroad unclear −10 (`LEAD_POINTS` runAbroad / decidesHere / ownedAbroad). Company page panel
  (signs for / against, the questions to ask — "Is FX decided here, or by group treasury in Germany?", own facilities,
  who signs off a hedge, who sets the policy), a chip on cards, Sheet column "Decided", export `finance_decided`. A
  lean, never a fact: checked on the call and against the CRM.
- **Who owns it** (Zac, 16 Nov 2026: "who owns XYZ company … figure out if they are based in the UK — our primary
  targets"): `ownershipOf` in `src/accounts/control.js` (page: `ownership(r)` with `groupOf`) — best first: the accounts'
  own "ultimate parent … incorporated in X" sentence (`lead-sourcer/sourcer/control.py` `ultimate_parent` →
  `ultimate_parent` / `_country` / `_evidence`, `FACTS_VERSION` 2026-11-16b and the FX filings scan; an immediate parent
  only when no ultimate one is named), else the daily ownership pass's walk up the register (`group_of`: top UK parent,
  and the owner registered abroad above it), else the owners list. Status UK-owned / Foreign-owned (with country) /
  Owner not known (Jersey, Guernsey, Isle of Man count as UK), the chain ("ACME LIMITED → ACME UK HOLDINGS (UK) → Acme
  GmbH (Germany)"), its source, and Google links to check it by hand ("Who owns X?", "Where is <parent> based?", "X
  parent company" — links only, never fetched). Accounts list "Any owner" filter with counts, Sheet column Owner, the
  card's Owner key point with "Who owns it? ↗", a company page Ownership panel, exports `ownership` / `ultimate_owner` /
  `owner_country`; `foreignOwner` (and so `financeSeat`) reads the accounts' ultimate parent too. **The Global LEI register**
  (Zac: "automated, ideally without API usage"): `lead-sourcer/sourcer/gleif.py` + `tools/gleif_owners.py` read GLEIF's
  free daily golden-copy files (lei2 / rr / repex, zipped CSV, no key, standard library only) in the daily "Niche hits"
  run — every tracked company holding an LEI (matched by Companies House number, registration authority RA000585) with
  its direct and ultimate accounting parent and their countries, or why none ("owned by individuals" …); a company that
  trades FX forwards must hold an LEI. `rank-leads.mjs` saves it in `leads/ranked` as `gleif_of`; `ownershipOf(r, group,
  lei)` weighs the accounts, the LEI register and Companies House (a foreign owner any of them names wins — the register
  can stop at a UK holding company), lists what each says and whether they agree. **Web search for the real owner** (Zac, 16 Nov 2026, after checking the
  sample by hand: "CH is not reliable enough, we NEED a search" — the register stopped at Txo Delta Topco, NLC Group,
  Investindustrial Advisors; the owners were TowerBrook, Paul Rosen, Investindustrial): `lead-sourcer/sourcer/
  owner_search.py` + `tools/owner_search.py`, in the daily "Niche hits" run after Websites — one search a company
  (`QUERY` "who owns <name>" — what a person types; Google's answer box and knowledge panel read too — and, Zac's
  method, "who owns <that company>" again for each owner that is a company, up to `MAX_HOPS` 4, stopping at a person, a
  PE firm or a loop: `chain`) through the finder's search APIs within their allowances (`profiles.fetch_any`; secrets
  `SEARCH1API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `BRAVE_API_KEY` — Brave's free plan, added 16 Nov 2026 when Zac chose
  free allowances over paid credit ("$50 is a waste for a simple Google search"), `BRAVE_MONTHLY` 1,000 — `SERPER_API_KEY`, the month's usage carried in the store item so the
  caps hold), best leads first, `--max` 100 companies a day (Zac, 16 Nov 2026: "we want 100 per day"; first route Gemini + Google Search, `gemini_read` — more than
  the free search allowances cover, so a provider with paid credit takes the rest; a run that runs out stops cleanly);
  an owner found before is kept when a later search finds nothing;
  the results read by one checked AI call (Groq — the Priority 1 exception; `ai_read`, the owner and quote must be in
  the result it names) or, with no key or a failed call, by rules ("owned by X", "subsidiary of X", "acquired by X", "part of the X
  group", "portfolio company of X", "X acquires …", Serper's knowledge panel "Parent organization: X" counting double),
  one owner under several spellings merged, a person / PE house / company, the country only when stated. Store key
  `owners` (found kept 180 days, nothing found retried after 60); `?view=signals` gives `owners_search`; `ownershipOf`
  takes it as a fourth source and shows its owner (the name a person would give) with the quote and link — but a
  register (accounts, LEI, Companies House) naming a foreign parent outranks a search naming another country (the
  search gave Motorola UK an Israeli sister company). **Owners from the accounts first** (Zac, 17 Nov 2026: "who owns it" is 80% of his checking time and paid Google
  search isn't available): `tools/parents_from_accounts.py`, in the daily "Niche hits" run before the owner search —
  the top leads' latest accounts read best first (Companies House's free API, `accounts.facts_from_latest_accounts`,
  `--max` 400 a day) for the "ultimate parent … incorporated in X" sentence (`control.ultimate_parent`); store key
  `parents` (found kept a year, none re-read after 120 days); `?view=signals` gives `parents_of`, `ownership(r)` uses it
  when the row has no parent of its own, and the owner search skips every company these answer (`--parents`). **Foreign-owned tab** (Zac, 16 Nov 2026: "if it's owned by an
  American company or something like that put it in a different section"): `foreignOwned` / `elsewhere` in
  `format.js` — every company any source says is owned from abroad lives only in that tab (like UK in name: out of the
  Accounts list, Best fit / Call now, FX filings, FX losses, Today; a serious reason not to progress, so Outreach and
  Call today drop it too), highest lead score first, industry filter, Excel export. The
  Ownership sample workflow searches its 30 too; logs print "a person" for a person. **Ownership sample** workflow
  (`scripts/ownership-sample.mjs`, read-only, on a push of its files or by hand): the best 30 leads with each source's
  answer side by side, for checking by hand.
- **New leads tab** (Zac, 18 Nov 2026: "make a section which is new leads"; `newLead` / `addedOn` / `NEW_LEAD_DAYS` in
  `format.js`): every company that joined the lists in the last 3 / 7 / 14 / 30 days (7 by default) — the finder's upload
  stamps `first_seen`; an FX filings row counts from its filing date — not contacted, not out, UK-in-name and foreign-owned
  left in their own tabs; highest lead score first, industry filter, Excel export with `added_on`.
- **Simplified dash tab** (Zac, 20 Nov 2026: "company name, CH number, type of company, P&L sheet style … change nothing
  in how it works, just how it looks"; `SIMPLE_COLUMNS` in `format.js`, `SimpleDash` in `AccountsApp.jsx`, the Sheet's
  own `SheetView` with other columns): the Accounts list's leads (not contacted, not out — nothing re-scored), best lead
  score first, as a P&L-style grid — Company, CH number, Type of company (`industryOf`), Turnover, Prior year, Growth,
  Cost of sales, Gross profit (turnover − cost of sales, only when both filed), Gross margin, FX gain/loss, Cash, Bank
  borrowing, Net assets, Staff, Score; blanks where the accounts don't say; search, type-of-company filter, sortable
  headers, Excel export of what's shown. **Status buttons** on each row (Zac, 20 Nov 2026: "add a button, open lead, added
  to mine and owned abroad"; `REVIEW_BUTTONS`, POST `{company_number, review: "open" | "mine" | "abroad" | null}`, kept
  in the `checks` store item beside the CRM tick as `review` + `review_at` — his own read, no reason and nothing from
  the CRM): one at a time, beside the CH number (Zac, 20 Nov 2026: "put the buttons next to the ch number and when i click
  the button take it off the main sheet and put it on its own list"; `SheetView`'s `actions.after`). The dash opens on **To
  check** (nothing marked); a button moves the company to its own list — **Open lead / Added to mine / Owned abroad** tabs
  with counts, each exported on its own; clicking the lit button sends it back to To check. **Owned abroad** also puts the
  company in the Foreign-owned tab and out of the Accounts list.
- **Teams abroad** (Zac's origination ideas, 21 Nov 2026, idea 2: "UK software companies paying developers in Poland,
  call centres in South Africa, outsourcing to the Philippines or Eastern Europe"; `overseasOps` / `OFFSHORE_HUBS` in
  `format.js`): subsidiaries the accounts place in an offshore delivery hub (Eastern Europe, India, the Philippines,
  South Africa, Latin America … — from `subsidiaries_abroad`, on both lists), or a job advert naming a team or payroll
  there (`found_via`); +8 Fit (`overseasOps`), a "Teams abroad" chip and filter on the Accounts list. The job-advert
  scan searches for it too (`FX_JOB_QUERIES` international / overseas / global payroll, offshore team; `FX_WORDING`
  offshore / nearshore / payroll abroad / "developers in India"). **Foreign-owned, decided here** (idea 3): the
  Foreign-owned tab's "Wherever finance is decided" filter by `financeSeat`'s lean (Decides in the UK / Unclear / Likely
  run from abroad, with counts) and a chip on each card — foreign-owned companies whose own records show finance run in
  the UK are back in play without leaving their tab.
- **Finding niche companies** (Zac, 21 Nov 2026: "we want to focus on finding niche companies — I have paid services to
  find contacts and exact financials"; `sourcer/discover.py`, no paid calls, no AI). **Niche search** (Accounts page tab;
  POST `{niche_search: "marble, saffron"}` / `{niche_search_again: id}` / `{niche_search_remove: id}` to store key
  `searches`, page-only; GET `?view=search`): the words become customs codes — uktradeinfo's Commodity table, the 8-digit
  descriptions first (what they exclude, "(excl. unmanned …)", not counted), then the 6- / 4-digit headings'; everyday
  words customs puts another way tried as `CUSTOMS_WORDS` (drone → unmanned aircraft); digits are codes — and
  `tools/niche_search.py` (workflow "Niche search", hourly: a quick look at the store, the caches restored only when a
  search waits) lists every company whose HMRC records carry them in 2+ months (`search`: sized first, months, share of
  its declared trade, the codes, on the lists, FX proof), store key `search_results` (written only there). **Lookalikes**
  (daily "Niche hits", `discover.lookalikes`, store key `lookalikes`): the leads Zac marked good (`good_leads`: Open lead /
  Added to mine, Good lead; not since Owned abroad / Not a fit) give their goods at the 6-digit heading, weighted by
  rarity among sized traders (a heading `LOOKALIKE_COMMON_DF`+ carry isn't searched); sized companies covering
  `LOOKALIKE_MIN_SCORE` (0.4) of that with 2+ goods in common (+0.1 same sector) are listed, 15 a lead. Both feed the
  finder (`NICHE_SEARCH_FILE`, `LOOKALIKES_FILE`: sized, not on the lists, 55, niche "Niche search: …" / "Like …" when no
  measured niche names them; `found_via` → the New leads tab's sources "Your niche search" / "Like your good leads").
  **Narrower niches**: `niche_hits.measure_all` also measures every 8-digit customs code (both flows, 5%+ of a company's
  declared code-months, `CODE_MIN_SHARE`; top `CODES_MAX` 200 in `niches/stats.codes`, the Niches tab's "Narrower" line);
  an uncovered code scoring `EMERGING_MIN_SCORE`+ and `CODE_BEATS` (1.25) × its heading becomes an emerging niche
  (`emerging-code-…`, named from the Commodity table, `hmrc.code_names`). **Less time on exact figures**: the finder's
  FX-line OCR 1,800s → 900s a run and re-reads 300 → 100 (`OCR_FX_BUDGET_SECONDS`, `FINDER_REREAD_MAX` in its workflow);
  turnover (the size test) and the currency notes (the FX proof) keep theirs, so the time budget checks more new companies.
- **Job finder v2** (Zac, 22 Nov 2026: "make our job finder new"; `sourcer/jobs.py`, run by `tools/ch_alerts.py
  --signals` each morning): Adzuna + Reed (free keys) searched for five kinds of role (`jobs.QUERIES`, ~65 Adzuna calls a
  run paced under 25 a minute, `ADZUNA_CALLS_MAX` 80): currency work (accounts / payments roles naming it), treasury / FX,
  import / export / shipping / customs / sourcing (Reed: direct employers only), finance director, teams / payroll abroad.
  Agencies' adverts are left out (the name, or "our client …" in the text: the employer would be the agency). Reed's
  snippet is read in full for the promising ones (`REED_DETAILS_MAX` 150). Each advert read (`read_advert`): the sentences
  naming currency work, currencies named, countries named beside trade words (suppliers, customers, offices, payments),
  trade terms (letters of credit, Incoterms, customs declarations …), an advert score (`ADVERT_POINTS`: wording 30, each
  currency 8, country 4, term 6, FD role 20, treasury 15, trade role 8). One record per employer (`employers`; more adverts
  naming FX +5 each). Matching: a company on the lists by name, else a Companies House name search — the registered name
  exactly, else the only active company with the same core name (Group / Holdings / UK aside: `pick_company`, flagged
  "Name matched loosely") — cached between runs in the `jobs` item (`lookups`; not found tried again after 30 days), best
  employers first, `JOB_LOOKUPS_MAX` 250 new searches a run, those scoring `LOOKUP_MIN` (30)+ or naming FX or an FD.
  Left out (`jobs.excluded`, status "excluded" with the reason; the first live run's "new leads" were mostly recruiters,
  plus a job board, an FX payments firm and an actuarial consultancy): recruitment agencies, job boards, accountancy
  practices and consultancies by their sector codes (78… / 6312 / 692… / 7022…, from the matched company's profile —
  `JOB_PROFILES_MAX` 300 a run, cached with the lookup), payments / FX firms (64… / 66… and a payments word in the name),
  agency names, whatever `absurd.reason` rules out, and an employer advertising `AGENCY_SPREAD` (4 kinds / 8 roles) at once.
  The second live run showed brand names matching namesakes (an advert by "Citi" → CITIGROUP LIMITED, a builder; "Wells
  Fargo" → a food company): the matched company's last accounts (profile, cached) — dormant / micro → left out as a
  namesake (`NAMESAKE_ACCOUNTS`), small / total exemption / unaudited abridged → "Matched" with a note to check, not sent
  to the finder (`SMALL_ACCOUNTS`); also left out: dormant / non-trading codes, any 78… code, schools, LLPs, payments / FX
  names (`FX_FIRM_NAME`), banks and financial groups (`BIG_FINANCE`), property (68…), lenders and financial services
  (6491 / 6492 / 6499 / 66… — a holding company's 6420x stays), public bodies, housing associations and colleges by name.
  Third live run: 2,437 adverts → 808 employers → 12 new leads (Raytec, Mercia Garden Products, Destination Sport …),
  13 to check by hand, 92 left out (agencies 49, payments / FX firms 6, banks 6, consultancies 5 …).
  New lead (a discovery, filed FX score 50–60): an FD advert, `LEAD_MIN` (40)+, or currency wording beside a currency /
  treasury / trade role (payroll-abroad wording alone is mostly payroll bureaux). Store key `jobs`
  (GET `?view=jobs`, the cache left out): every employer of the last `KEEP_DAYS` (60) with its status (New lead / On our
  lists / Matched / Not matched / Not looked up yet / Left out), score, currencies, countries, terms, quotes and adverts, plus each
  search's yield (`queries`: adverts, kept, naming FX, leads). **Job adverts tab**: status buttons, kind / currency filters,
  "Names currency work", the advert's words, Zac's review buttons, Excel export, "Which searches pay".
- **Holding companies labelled by their group** (Zac's five good finds, 20 Nov 2026: three were holdcos filed as head
  office / holding company / financial services, so a freight group read "Finance & insurance" with no niche): the daily
  ownership pass (`psc_deals.py --groups-out`) reads down the register from every tracked company (`owners.children_index`,
  `descendants`: 4 levels, 80 companies) and, for one whose own codes are all non-trading (`owners.non_trading`: 64… /
  66… / 701… / head office / other business support / dormant / property letting), its active trading subsidiaries' codes
  (a full / medium / group filer counts 3×) give `group_of[number].activity` = {sic, subs, names, numbers, niche}
  (`owners.group_activity`). The page (`groupActivity`, `industryOf`) labels the industry from it, a "Group trades as …"
  chip, the Hidden-from-filters reason says so, and `rankLeads` gives a generic niche (FX in their filed accounts, Broad
  wholesale) the group's niche (`GENERIC_NICHES`). `rank-leads.mjs` now sets the known groups before scoring, so PE up the
  chain counts in the daily ranking as on the page.
- **Lookalikes by profile, the Scoreboard, Fit first** (Zac, 22 Nov 2026): `leadProfile` / `profileMatch` /
  `likeGoodLeads` in `format.js` — each good lead's profile (industry with the group's for a holdco, niche, size band,
  FX proof, holding company, PE-backed, FX loss, growth 20%+, subsidiaries abroad, source; `PROFILE_WEIGHTS`) against every
  unmarked lead; one sharing `LIKE.min` (70%) of it, industry or niche among it, gets `LEAD_POINTS.likeGood` +8 Fit ("Like
  your good lead X (…)"). Page and daily ranking both (`leads/ranked.likes`; the database sync uses it and `reviews` too).
  **Scoreboard tab** (`scoreboard`): by source / niche / industry — leads, Fit 60+, checked, good, good %, Fit 60+ still
  waiting — and each good lead with its profile and its lookalikes. "Emerging niche" is now a lead source. **Fit first,
  then Now** (`SORTS.fitFirst`): the default order on New leads and Hidden from filters (a choice on those, Foreign-owned
  and UK in name), and an Accounts list sort. The daily website / parents / owner lookups work through Fit 90+ leads first
  (`lead_order.json`), so the best fits get a website for Cognism soonest.
- **Hidden from the usual filters** (Zac, 21 Nov 2026: "everyone uses Market IQ or Zint — we want companies that aren't
  on there"): those tools are built on the same register, so nobody is missing from them, but a standard search (turnover
  £20m+, a manufacturing / wholesale sector code, an importer flag) can't see some companies. `hiddenFromFilters` /
  `HIDDEN_KINDS` in `format.js` say which filter drops each lead: no turnover in the filing (filleted / no profit and loss
  account — not ours still to read), sized by its group, accounts in another currency, a scanned filing, only hiding
  sector codes (`HIDING_SIC`: head office, holding company, other business support, dormant, property), too new (moved up
  from small accounts, incorporated within 3 years), or found by its goods / a job advert / a good lead's goods. +8 Fit
  (`LEAD_POINTS.hidden`: fewer people calling them); the **Hidden from filters** tab (FitTiming mode "hidden": a reason
  filter with counts, each card's reasons, Excel with `hidden_because`) and the Accounts export's `hidden_from_filters`.
  A Zint export as a suppression list would be the direct test — only once Zint's licence and the bank's policy allow it.
- **Power Automate feed** (Zac, 21 Nov 2026: "take all of the accounts in our site and we'll check them all" — his CRM
  check runs in Investec's Power Automate): GET `/api/feed?key=…` (`api/feed.mjs`, `functions/api/feed.js`) — every lead on
  the site, flat, best lead score first: the daily ranking's `feed/all` (`ranking.js` `feedRows`, saved by
  `rank-leads.mjs`: Accounts list + FX filings companies, lead score / fit / now, niche, industry, SIC, turnover, postcode,
  website) then the Emerging leads companies not in it, each with its status from the page's own marks (`statusOf`:
  Contacted / Open lead / Added to mine / Owned abroad / Good lead / Not a fit / To check); ruled-out leads left out unless
  `include_out=1`; `status=To check` (or `to-check`) keeps one status, so a flow loops over `body('HTTP')?['rows']` with no Parse JSON / Filter array; `offset` / `limit` (≤ 20,000, `next_offset`), `format=csv`. **Its own read-only key**, never the
  Accounts password: `feedKey` = HMAC of the password and the store's `feed/salt`; the page's **Power Automate feed**
  button (`FeedButton`, GET `?view=feedkey`) shows the URL to paste into the flow's HTTP step, and **New key** (POST
  `{feed_key}`) retires the old one. Data only goes out: nothing from the CRM comes back through it.
- **Key points** (Zac, 16 Nov 2026: "the key points on the cards need to be summarised — looks like a lot of info"):
  `keyPoints` in `format.js` / `KeyPoints` — at most four one-line points on every Accounts and FX filings card and at
  the top of the company page: Why now (`timelyReason`, else "a good fit to work in the sequence"), FX (loss, own
  currency, forwards / no hedging named, share of sales abroad — else the customs record), Decides (`financeSeat`;
  "UK-owned", PE sponsor), Pitch (the first two of `pitchLine`), plus Score / Fit / Now. The FX strip, score breakdown,
  chips, call prep and notes editor sit behind "More detail" (a saved note stays shown).
- **Your verdicts** (14 Nov 2026, from the discovery review: the lead score's weights had never been tested against
  real outcomes): "Good lead" / "Not a fit" (+ reason: Too small, Too big, No real FX, Wrong sector, FX run abroad,
  Other — `VERDICT_REASONS`; never "client" or anything from the bank's records) on every card, the company page,
  the Hit list and Hard to broker (`VerdictButtons`); store key `verdicts` (POST `{company_number, verdict, reason}`,
  `null` clears). Not a fit qualifies the lead Out everywhere. The daily ranking (`ranking.js` `verdictLearnings`,
  `leads/ranked.verdicts`) splits them by source (finder / FX filings scan), lead-score band, niche and hard-to-broker
  sector, printed in the run and shown at the top of the Niches tab — the evidence for re-weighting `LEAD_POINTS` and
  the niches. **The feedback loop** (Zac's origination ideas, 21 Nov 2026: "use previously identified successful
  prospects to teach the scanner which company profiles produce genuinely new opportunities"; `reviewLearnings` in
  `format.js`): his own marks — Open lead / Added to mine (Simplified dash) or Good lead count good, Owned abroad or
  Not a fit count not — give each source (`leadSource`), niche and industry a good-lead rate; with `reviewMin` (5)+
  marked, a niche (else the lead's source) at `reviewGoodShare` 60%+ lifts its leads `reviewGood` +8 and one at 25% or
  under lowers them −8 (Fit; the reason "Your checks: 83% of Cut flowers leads were good (6 checked)"). The page and the
  daily ranking (`rank-leads.mjs` reads `checks` + `verdicts`; `leads/ranked.reviews`, printed) both apply it; the
  Simplified dash shows "What your checks are teaching the score". Only his clicks — nothing from the CRM.
- **Hard to broker** (Zac, 13 Nov 2026: "a separate section where we go after sectors brokers can't — mining,
  recyclables etc — no firearms, no gambling"): niches carrying `broker_shy` (the reason payment firms — non-bank FX
  brokers — often decline or restrict them) in `fx_niches.json`: scrap metal, bullion, jewellery, watches, art &
  antiques, vapes, shipping, bloodstock, ferro-alloys, and new ones (`shy-*`) — mining / quarrying / ores, metal & ore
  wholesalers, waste & recycling exporters, fuel & oil traders, used-car exporters (customs exports only, `goods_only`), phone &
  electronics wholesalers (MTIC), tobacco, diamonds & gemstones, grain / sugar / oilseed traders. The finder searches
  them like any niche; every tracked lead is tagged in the daily "Niche hits" run (`niches.broker_shy`: customs goods
  first, else the sector; `enrich.json` `shy` → `rankLeads` `shy_of` → `leads/ranked`; `needs_sic` on phones,
  vehicles, waste and fuel: their goods are too common — an agency importing laptops or a haulier importing lorries —
  so the company's own sector code must match too). Never: weapons and firearms,
  military vehicles, gambling, security dealing (SIC `SHY_NEVER_SIC`), or a name saying firearms / betting / casino /
  crypto / cannabis / adult… (`SHY_NEVER_NAME`). **Hard to broker tab**: those leads by sector, highest lead score
  first, with why brokers shy away, Excel export and a Cognism company list; it reminds Zac to check Investec's own
  sector appetite before calling. No lead-score change.
- **Every lead's website** (Zac, 12 Nov 2026: 7,000 companies uploaded to Cognism, ~100 enriched — the FX filings
  list's companies carried no website and most rows no named person, so Cognism had nothing to match on):
  `tools/find_domains.py` in the daily "Niche hits" run, after the ranking (`rank-leads.mjs … lead_order.json`: best lead
  first), ~40 minutes a day (`--budget`) until every tracked company is tried. Addresses guessed from the registered name
  (`website.domain_guesses`: with / without "and", "UK", "Products", "Europe"; .co.uk / .com / .uk; a "group" / "uk"
  ending; the first word when distinctive) and kept only when the site shows the company's number (high) or full
  registered name (medium) — the homepage or at most two of its privacy / terms / contact / about pages, robots.txt
  respected (`website.find_site`). Store key `domains` (`{sites: {number: {website, confidence, found}}, none: {number:
  date}}`; a "none" tried again after 30 days); `?view=signals` gives the page `websites`, used wherever a row has no
  website of its own (`siteOf`, `setKnownSites` in `format.js`): cards, the company page and the Cognism exports.
  **Cognism company list** (Accounts, Call today, FX losses; `cognismCompanyRows` / `COGNISM_COMPANY_COLUMNS`): only
  companies with a website, one row each — Company Name, Website, Country, Job Titles to Find, Company Number, Lead
  Score, Why FX — to upload as a company list and search people by job title, rather than contact enrichment (which
  needs a person's name, email or LinkedIn URL on each row).
- **Call today tab** (Accounts page, first tab; `callToday` / `CALL_RULES` in `format.js`): the day's 25 across the
  Accounts list and the Recent FX filings list (its candidates precomputed at save as `filings/calls`, `filingsCalls`
  in `api/accounts.mjs`, GET `/api/accounts?view=calls`): turnover £20m–£300m (filed or group), filed FX proof 50+, not
  qualified Out, and an FX loss of £50k+ in accounts filed in the last 6 months or a trigger; confirmed finance
  contacts first, then likely, then "ask for the FD", each by FX proof (owned abroad lower) + 30 for the loss + 15 for
  a trigger. Every pick lists why; Contacted drops it and the next moves up; CSV export. Every CSV export (Accounts,
  FX losses, Call today) starts with `company_and_fd` (`companyAndFd`): "ACME LIMITED – Jane Smith, Finance
  Director", or "ACME LIMITED – ask for the Finance Director" — one cell to copy. "Export for Cognism" (Accounts, Call today, FX
  losses; `cognismRow` / `COGNISM_FIELDS` in `format.js`): company, domain, company number, postcode, the presented
  finance contact split into first / last name with job title and a linkedin.com/in URL found by the searches, else
  the role to find — the columns Cognism's upload matches on, with plain headers ("First Name", "Website") and blank
  Email / Direct Phone / Mobile / Notes columns to fill in. Every export is an Excel file (`apps/web/src/accounts/xlsx.js`,
  no library: one sheet, bold frozen header with a filter, text as text — nothing runs as a formula, company numbers
  keep their leading zero — figures as numbers), Nov 2026: a CSV opened in one column and garbled £ / – / ✓. Zac enriches it in Cognism on the bank's licence; what
  Cognism returns stays there and is never loaded back into this system.
- **Lead checklist + reasons not to progress** (the team's onboarding steer, Nov 2026: quality before volume, protect
  the reputation with Sales, "look at every reason this would not be an opportunity"; `leadChecklist` /
  `reasonsNotToProgress` / `checklistLine` in `format.js`, shown on Call today cards and the company page, columns
  `lead_checklist` and `reasons_not_to_progress` in the exports): ownership, turnover £20m–£300m, international
  activity, business change / trigger, likely FX need, reason to contact — ✓ / ✗ / ? / ! from the records — and "CRM
  checked", Zac's own tick (store key `checks`, POST `{company_number, crm_checked}`; a date only — nothing from the
  bank's CRM is kept here). Reasons not to progress: qualified Out, outside the band, no FX in the filings (serious:
  held off Call today); no turnover filed / sized by its group, owned abroad, already banks with Investec, a named FX
  provider, a figure sent to check, accounts filed 400+ days ago, other group companies on the list (shown).
- **FX losses tab** (Accounts page; the "Recent FX loss" figure at the top opens it; Contacted button and CSV export
  with each company's email draft; `lossRows` / `filterLosses` / `sortLosses` in `format.js`): every company whose
  latest accounts show an FX loss — the main list's (finance contact, company page) and the Recent FX filings list's
  not on it yet (`filings/losses`, written by `filings-store.mjs put` with `filingsLosses`, GET
  `/api/accounts?view=losses`) — biggest first; filters for size (£50k+ by default), a £20m–£300m button (filed or group turnover in the core band; a size estimate alone doesn't count — `inCoreBand`), filed in the last 6 months, no
  hedging named in the accounts, worse than last year; sorts by loss, share of turnover, newest, growth. Each loss links
  to its accounts; figures the sense checks cleared never appear; contacted companies stay in the Contacted tab.
- **Email generator** (`apps/web/src/accounts/email.js`; the Accounts page's "Email generator"
  tab: the cards stay as they are, and "Email generator →" at the foot of each card — accounts,
  filings and the company page — takes the company there, newest first, its draft in an editable
  box with Copy / Reset / Remove, kept in that browser; also the `email_draft` CSV column): Investec's master
  cold email, filled from the company's filings. Only the first two paragraphs change —
  first name (a presented finance contact, never a Guess or an initial), the company's
  name shortened naturally, regions abroad from the turnover note (else places from the
  currencies in the accounts), the currency pair (main currency unless only the niche's
  default, forwards, currencies in the accounts, regions), and the opening of the second
  paragraph (paying overseas suppliers / sales from overseas / trading activity). The
  Investec paragraph, the Tuesday-or-Thursday ask and the sign-off never change. Golden
  rule: researched, not invasive — forwards, lenders, borrowings and FX gains guide the
  hook but are never quoted back; what the filings can't support stays a [placeholder]
  ("Fill in: …"), and the draft says where each filled part came from. Nothing is sent. The tab's companies and
  edits are kept on the site (store key `emails`, POST `{company_number, email: {row} | {text} | null}`, at most
  `EMAILS_MAX`), so they follow Zac across devices; drafts from before (this browser's storage) moved over once.
- **Alerts** (`tools/ch_alerts.py`, workflow "Alerts" every 3 hours + a morning digest; the Accounts page's Alerts tab,
  GET `/api/accounts?view=alerts`, store keys `alerts`, `discoveries`, `ch/stream`; `apps/web/scripts/alerts-store.mjs`):
  Companies House's streaming feeds (officers, charges, owners, filings, insolvency cases — secret `CH_STREAM_KEY`, a "Streaming API" key from the
  developer hub, not the REST key) read from the last timepoint for the Accounts + FX filings lists' companies: new
  director (confirmed as the new finance director when Google News names them with a finance title in the last 150
  days — `confirm_fd`; Companies House no longer shows occupations), director left, new charge (refinancing), charge
  paid off, new corporate owner (private-equity backed: hot), and a charge in favour of an FX provider or for trade
  finance / foreign exchange (`FX_PROVIDERS`, `FX_PURPOSE`; hot) — for any company: one not on the lists becomes a
  discovery (`discoveries`, filed FX score 60) that the finder checks first (`DISCOVERIES_FILE`, merged into
  `priority_from_filings`). Hot alerts live **on the dashboard** (Zac, 14 Nov 2026: "forget the email, just have the alert on the dash"): the
  Accounts page's banner (hot alerts in the last 7 days, new since the Alerts tab was last opened — `alerts_summary` in
  `?view=signals`) and the Alerts tab. Telegram (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`) only if ever set; nothing to
  prospects. Counts only in the log.
  **News and job adverts** (same tool, `--signals`, daily before the digest): Google News RSS headlines (last
  `NEWS_DAYS` 10) classified by what they say (`headline_kind`) — a finance director / CFO appointed (`news_fd`), or
  buying / opening / selling abroad, a King's Award for International Trade, UK Export Finance backing (`news_abroad`)
  — and job adverts for treasury / FX / export roles from Adzuna and Reed's free APIs (`hiring`; secrets
  `ADZUNA_APP_ID` + `ADZUNA_APP_KEY`, `REED_API_KEY`, skipped when unset; recruiters left out). A company on the
  lists is matched by name. Since 14 Nov 2026 (discovery review: the noisiest source) headlines and adverts are
  triggers on listed companies only; just a private-equity deal or funding round about a company not on them
  (`DISCOVER_FROM_NEWS`) is looked up on Companies House by its exact registered name (active, `LOOKUPS_MAX` 40 a
  run) and becomes a discovery (filed FX score 50–55) — a new FD, expansion abroad or job advert elsewhere isn't. King's Award and UKEF lists come in
  through the headlines (their gov.uk lists' formats weren't verifiable from here).
  **Job adverts that name currency work** (Zac's brief, 19 Nov 2026: "the bottleneck is companies not already
  prospected" — a mid-sized company advertising a role "paying suppliers in EUR and USD" shows real FX flows decided in
  the UK and is rarely on anyone's list): `FX_JOB_QUERIES` (multi-currency / foreign-currency / overseas-supplier
  payments, hedging, forward contracts, letters of credit … two pages each on Adzuna, Reed's keyword search) and
  `fx_wording` (the advert's title and text, `FX_WORDING`; recruiter pitches and gardening "hedge" skipped) — an
  employer not on the lists, found by exact registered name (`JOB_LOOKUPS_MAX` 150 a run — 60 until 21 Nov 2026, when the first run used them all and Reed was added, currency-worded and FD adverts
  first), becomes a discovery with the quote (`discovered_by`, `source` job_advert, `source_url`, filed FX score 55; since 22 Nov 2026 the Job finder v2 rules below);
  the finder checks it (niche "FX work in a job advert", `main.JOBS_NICHE`) and every discovery's row carries
  `found_via` / `found_via_url` (`main.FOUND_VIA`). The New leads tab shows each lead's source (`leadSource` /
  `LEAD_SOURCES` in `format.js`: Job advert, News, Charge / owner alert, FX filings, Modern slavery register, Customs
  records, Niche search), a source filter and a `found_via` export column; the company page lists "Found via" with
  the advert's link.
- **Look** (Nov 2026: "clean dark theme, Google-Sheet professional vibe, finances Zint-style"): neutral dark greys,
  gridlines, flat panels, tabular figures (the theme block at the end of `CSS` in `AccountsApp.jsx`). The Accounts list
  defaults to a **Sheet** — a dense sortable grid (`SHEET_COLUMNS` in `format.js`: company, turnover, growth, FX proof,
  FX gain/loss, currencies, how they do FX, finance contact, grade, bank, trigger; sticky header and company column,
  row numbers) — with a Cards toggle (remembered in the browser). The company page leads with **finance charts**
  (`FinanceCharts`: size on a £1m–£1bn log scale with the £20m–£300m band shaded, turnover this year v last, sales by
  region, FX gain/loss this year v last on the diverging blue/red pair, balance sheet) — plain SVG, every bar labelled
  and titled; colours validated for the dark surface (dataviz skill).
- **Freshness strip** (top of the Accounts page; `statusLines` / `searchAllowance` in `format.js`): each data
  workflow's last outcome — Accounts list (finder), FX filings, Market moves, Accuracy audit — ok, stale (older than
  its cadence: 30h / 80h / 80h / 8 days) or failed with a link to the run, and the contact searches left this month.
  Each workflow's last step records it (`apps/web/scripts/status.mjs`, store key `status`, `recordStatus`); a run
  that dies part-way shows red here instead of passing unnoticed. When the finder's contact searches are blocked — every search
  provider with a key rejected (401/403), out of credits or its month's allowance used — while sized companies still
  wait, the finder line turns amber and says why ("contact searches blocked (1,296 waiting): Search1api key rejected ·
  Serper out of credits"; `profiles.search_problems` → `search_allowance.json` → `searchBlocked` in `format.js`). The accuracy audit runs weekly on its own (Sunday,
  "FX filings cross-check": a fresh 200-filing draw, `reader_audit.py --strict` fails the run on any broken rule).
  A chained backfill or rescan keeps `chain_left` in the filings list, so a link dropped from GitHub's queue (a newer
  waiting run replaces an older one) is restarted by the next daily scan.
- **Running it:** the GitHub workflow `fx-company-finder.yml` fills the
  dashboard's password-protected Accounts page (no run attachments: the
  repo is public)
  (`/accounts`; the list sits in the private KV store behind `/api/accounts`, never
  in the repo or the public build). A finance director outranks a financial
  controller when picking the contact. Each company's Companies House lookups
  are cached 7 days (`sourcer/register_cache.py`, `REGISTER_CACHE_DAYS`; sooner
  when newer accounts are filed) to keep within the GitHub Actions minutes; its
  website and news lookups likewise (`LOOKUP_CACHE_DAYS`, 7 — they took ~20 min
  of each run). The 5,000 slots a run (`DEFAULT_ENRICH`; 3,500 → 5,000 the same day, when the first run without the contact hunt checked 3,750 in 104 of its 180 minutes and added 1,433 new companies, and the list was slimmed: the long text — every `*_evidence` quote and `DETAIL_FIELDS` in `api/accounts.mjs` — lives in 16 detail items, `details/0..15`, that the company page loads for itself, GET `?view=details&company=…`; the upload prints the biggest fields and, still over the item limit, leaves out the lowest-ranked companies rather than not uploading; forwards maturing within a year is precomputed as `fx_forwards_due`; 14 Nov 2026: a run checked its 2,000 in 13 of its 140 minutes, nearly all
  from the cache — ~30 new companies a night while ~39,000 candidates waited; now the time budget, `FINDER_BUDGET_MIN`
  180, sets the pace, and a night that runs out uploads what it reached with `upload-accounts.mjs --carry`, keeping the
  last list's other companies, so the list never shrinks; the upload prints the list's size and refuses one over 24 MB;
  before that 2,000, and 1,200 until 8 Nov 2026 — a run checked those in ~12 of its
  140 minutes, so scanned paper accounts and the filings backlog were waiting on slots, not OCR time) go to companies still in
  the running: ones the cache already shows are out (filed turnover under the
  floor, an unconfirmed subsidiary) don't take one, so the next candidates in line
  get checked. Scheduled every evening, 19:43 UTC (GitHub starts free scheduled runs
  hours late), so the list is ready by the morning (nightly from 8 Nov 2026). `tests/test_lead_sourcer.py`
  `TestEndToEnd` runs the workflow's whole chain (list → CSV → contact search →
  Accounts page file) on every PR.

## Market moves (`market-moves/`, `/moves`) — the day-to-day dashboard

Official ECB reference rates → the pound's moves against each currency
(1d/1w/1m/3m), material moves flagged (`MOVE_RULES`), "per 1m" impact
(arithmetic on official rates). The `/moves` page adds the event engine's
recent events for the pair ("why it moved", read-only from `events.json`)
and, behind the Accounts password, the accounts each move hits with a call
line. Workflow `fx-market-moves.yml`; data in the private KV store behind
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

**One exception, agreed by Zac on 16 Nov 2026** ("yes fine" — after the rule-based reading of ownership searches named
"Who", a company Bakels had bought, and a person for NCR): the **ownership check** (`lead-sourcer/sourcer/owner_search.py`
`ai_read`) makes one AI call per company to read that company's search results — Groq's free tier
(`llama-3.3-70b-versatile`, `GROQ_API_KEY`), capped by the run's `--max` (50 companies a day), every call and its
tokens logged. The answer must name the result it read and quote it; an owner or country the results don't contain is
dropped. **Gemini with Grounding with Google Search** (Zac, 16 Nov 2026: "the most reliable way is through Google";
`GEMINI_API_KEY`, AI Studio's free tier) is now the first route: one call a company runs the Google searches itself —
"who owns X", then who owns that owner — and counts only when Google's grounding backs the owner's name; `--max` 100 a
day; Groq + the search APIs only when Gemini's daily allowance is used. No other per-company AI.

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
- Website confidence low or guessed (a name-guessed domain) → cap at 59 (QUEUE)

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
