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
  Then the confirmation step (`tools/confirm_contacts.py`, run in the
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
  4. The FX niches (`lead-sourcer/config/fx_niches.json`). Which sectors to add is measured, not guessed:
     `tools/sector_hits.py` (workflow "Sector hits", read-only) counts the FX filings scan's strong finds per SIC
     code against each sector's full / medium / group-accounts companies and lists the best-hitting sectors the
     niches don't cover.
- **Scores:** every score and estimate lists its evidence or basis. Weights
  and wallet bands get recalibrated against real outcomes, so log them.
- **Not public, not scraped:** credit-reference data (Creditsafe etc.) only
  via a licensed API if the bank has one.
- **Contact routes and email drafts:** in scope until Cognism arrives
  (mid-November 2026). Generic company emails only (Priority 12), and
  rule-based drafts (Priority 1: no per-lead AI calls).
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
  Companies House's streaming feeds (officers, charges, owners — secret `CH_STREAM_KEY`, a "Streaming API" key from the
  developer hub, not the REST key) read from the last timepoint for the Accounts + FX filings lists' companies: new
  director (confirmed as the new finance director when Google News names them with a finance title in the last 150
  days — `confirm_fd`; Companies House no longer shows occupations), director left, new charge (refinancing), charge
  paid off, new corporate owner (private-equity backed: hot), and a charge in favour of an FX provider or for trade
  finance / foreign exchange (`FX_PROVIDERS`, `FX_PURPOSE`; hot) — for any company: one not on the lists becomes a
  discovery (`discoveries`, filed FX score 60) that the finder checks first (`DISCOVERIES_FILE`, merged into
  `priority_from_filings`). Hot alerts go to Telegram as found and the last 24 hours as a morning summary, when
  `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set (Zac's own chat; nothing to prospects). Counts only in the log.
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
  of each run). The 2,000 slots a run (`DEFAULT_ENRICH`; 1,200 until 8 Nov 2026 — a run checked those in ~12 of its
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
