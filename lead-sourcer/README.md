# lead-sourcer

Finds UK companies that move real money in foreign currency, sized for a
bank FX desk. For each company it works out:
- which currencies it most likely pays and is paid in;
- roughly how much it converts a year;
- who it banks with;
- what's just happened that opens a door (new owner, refinancing, new director);
- when to call;
- its best finance contact (FD, CFO, financial controller, treasurer) and
  lead director.

Three sections by filed turnover:

- **Core (£25m–£250m):** the target band. Companies with medium, large or
  group accounts but no filed turnover also land here, and `size_basis`
  says so.
- **Above (£250m+):** big corporates, which usually have a treasury team.
- **Below (under £25m):** only appears if you lower the floor with
  `--min-turnover`.

Change the band with `--band-min` / `--band-max`.

## How it finds them

It starts from raw records, not from SIC-code guesses.

1. **HMRC customs records:** 12 months of HMRC's monthly importer and
   exporter lists. That's about 100,000 importers and 50,000 exporters a
   month, each with the 8-digit codes of the goods. Being on them is an
   official record of cross-border trade, and being on them month after
   month means a regular foreign-currency payment flow.
2. **Matching to Companies House:** each trader is linked to its company
   by name at the same postcode. An exact name is high confidence and a
   near-identical one is medium. Failing that, a name unique across the UK
   counts, because HMRC often holds the trading address while Companies
   House holds the registered office. Anything weaker is left unmatched.
3. **Candidates:**
   - every company with medium, large or group accounts that customs
     records show trading;
   - companies in the FX niches (`config/fx_niches.json`) with those
     accounts.

   Small-accounts companies, which are under £15m by definition, come in
   only when the floor is lowered under £15m. Proven traders are checked
   first.
4. **The filed accounts** give:
   - turnover (this year and last, so growth) and cost of sales;
   - foreign exchange gains/losses, this year and last;
   - the share of turnover from abroad, where it's split by region;
   - cash, bank borrowings and net assets;
   - the **"Auditors"** line (firm and tier: Big Four, mid-tier, independent);
   - figures broken down by currency or region;
   - hedging/derivatives disclosed;
   - the **"Bankers"** line on the company-information page.
5. **Companies House** gives:
   - owners (a person or a company, and where);
   - the charges register (who lends against the company, and when);
   - directors (nationality, residence, birth year).

### Currency mix

HMRC's trader files list a company's goods but not where they come from.
HMRC's trade statistics give, for every commodity code, how much the UK
imported from (or exported to) each country, in £. Combining the two:

> A company importing wine code 22042138 most likely buys where the UK
> buys it (France, Italy, Spain), so mostly in EUR.

- Each code is weighted by the months it appeared.
- A code missing from the statistics falls back to its 6/4/2-digit group.
- Each country is mapped to its usual invoicing currency:
  - euro area, Poland, Czechia, Hungary, Romania and Turkey: **EUR**;
  - US, Switzerland, Sweden, Norway, Denmark, Japan, Australia, New
    Zealand, Canada and South Africa: their own currency;
  - everywhere else, including China, India and the Gulf: **USD**.

This is the national pattern for those goods, not the company's own
invoices. Treat it as the opening hypothesis for the call.

### FX wallet (estimated annual foreign-currency flow)

The estimate is a range with its basis spelled out:

- **Imports:** purchases × an import share. Purchases are cost of sales
  when filed, otherwise 70% of turnover.
- **Exports:** turnover × an export share. When the accounts split
  turnover by region, the filed overseas share replaces the band.

Both shares are banded by how many of the last 12 months the company shows
in customs records:

| months in customs | import share of purchases | export share of turnover |
|---|---|---|
| 9–12 | 40–80% | 20–50% |
| 3–8 | 15–40% | 10–25% |
| 1–2 | 5–15% | 2–10% |

These are rules of thumb. Recalibrate them once real client volumes are
known.

### Bank intel

The main bank is the bank named as **Bankers** in the accounts or, failing
that, the bank holding the newest charge. Each banking group is
classified:

- **high-street:** HSBC, Barclays, Lloyds, NatWest, Santander;
- **challenger:** Virgin Money, Handelsbanken, Close Brothers, OakNorth and
  others;
- **international bank;**
- **specialist lender:** asset or invoice finance.

New and paid-off charges are reported as triggers (below).
- `own_bank_client`: that bank's existing clients are flagged as
  cross-sell rather than new business. The GitHub workflow defaults to
  Investec. Locally, use `--own-bank Investec` (or env `OWN_BANK`).

### Triggers

Each trigger is a dated line, from Companies House:

- **New owner** in the last 18 months, flagged "looks private-equity
  backed" when the owner is a deal vehicle ("Bidco", "Topco", "Midco") or
  a fund. New owners usually rebuild the banking. `pe_backed` names the
  investor owner even when the deal is older.
- **Owner stepped back** in the last 18 months.
- **New charge** in the last 12 months: new borrowing or a new bank.
- **Paid-off charge** in the last 12 months: refinanced or left that
  lender.
- **Facility renewal near:** the newest bank charge is 3–5 years old, the
  usual facility term.
- **New director** in the last 12 months: new people review providers.

Triggers lift a company's ranking a little: 10 points each, up to 20.

### Call hooks and currency exposure

Nine columns give each checked company specific, document-backed talking
points for a Finance Director call (`sourcer/hooks.py`):

- **Fact 1, Fact 2:** the two strongest sourced facts to open on, in this
  order:
  1. a new finance director/CFO (Companies House occupation, or a news
     headline) in the last 90 days;
  2. an FX gain or loss of £50k+ on the latest accounts (tagged figure);
  3. a charge registered in the last 12 months (lender named);
  4. turnover growth of 20%+ (both figures);
  5. an overseas parent (PSC register) or parent/subsidiary incorporated
     abroad (accounts wording);
  6. accounts filed in the last 30 days.
- **Main currency, Direction** (Buys / Sells / Both / Unknown), **Currency
  evidence, Currency confidence:** from the first rule that gives an answer:
  1. turnover by geography in the accounts (High, sells abroad);
  2. currency names and codes in the accounts text, the most-mentioned
     winning, with direction from the sentence (purchases = buys, sales =
     sells) (High/Medium);
  3. an overseas group company (Medium);
  3b. the company's HMRC customs records: the bigger flow's top currency,
     estimated from HMRC trade statistics for the countries involved (Medium);
  4. the niche's default (Low; never used in the opener).
- **Opener:** one sentence for the call, built only from the detail
  columns. Importers hear about the pound falling, exporters about it
  rising.

Every figure, date and name in a detail column comes from a record already
fetched (no extra API calls) and names its source in brackets. Money is
exact, or rounded down in the opener ("£312k"). Blank means nothing
qualified. Thresholds are in `HOOK_RULES`. Small and abridged accounts
usually have no notes, so expect currency rules 3–4 for those. FX
gain/loss needs tagged (iXBRL) accounts. Test on real companies with *FX
hooks test* (`tools/hooks_test.py`).

### Incumbent, FX today, bank-led opener, qualify out

For a bank's FX desk the way in is usually the banking (refinancing, a
facility coming up), with FX as the cross-sell. Each checked company also gets:

- **Incumbent bank** (`incumbent_bank`): the bank holding an all-assets
  debenture, i.e. the main banking relationship, and since when. **Lenders**
  (`lenders`): every outstanding charge with what it covers (all-assets
  debenture, property, asset finance, invoice finance, deposit), from the
  charges register already fetched.
- **Facility ends** (`facility_ends`, `facility_ends_evidence`): the date the
  accounts give for a facility ending ("the RCF expires on 31 March 2027"),
  with the sentence.
- **FX today** (`fx_today`, `fx_today_evidence`): how they handle FX, in the
  FD's own words: uses forward contracts / uses currency options / doesn't
  hedge / natural hedge / uses an FX provider (named in the accounts, or the
  provider holds a charge).
- **Bank-led facts and opener:** facility ending within 18 months, a new
  charge, or a main-bank debenture 3+ years old now come first (`HOOK_RULES
  ["order"]`), paired with the FX gain/loss figure when there is one: "Saw in
  your accounts the facility runs to 31 March 2027, and they show a £312k FX
  loss for the year to December 2025 — worth looking at the FX alongside the
  banking."
- **FX estimate** (`fx_estimate`): the FX wallet as a clearly labelled
  estimate, never in the facts or the opener.
- **Qualified** (`qualified`: Yes / Check / Out, `qualify_reason`): Out when
  owned by a company registered abroad (FX likely run by group treasury) or
  when there's no FX evidence beyond the niche; Check when hedging with
  forwards under a Big Four auditor, or net liabilities. Rules in
  `QUALIFY_RULES` (`sourcer/qualify.py`). It filters (the Accounts page hides
  Out by default); it doesn't change the ranking.
- **Warm route** (`warm_route`): an existing relationship with your bank, a
  private-equity sponsor, or an auditor on your introducer list (repository
  variable `WARM_AUDITORS`, comma-separated).

### When to call

Shown, never scored:
- **Year-end:** budgets and hedging get planned in the quarter before it.
  `planning_window_now` is "yes" when today is inside that quarter.
- **Customs season:** the months the company shows up in customs records,
  e.g. "imports Mar–Jun, Sep (next: Mar)". Call ahead of the season.

### Groups

Companies sharing a UK parent are linked:
- `group_parent` names the parent;
- `group_companies_in_list` says how many of the group's companies are in
  the list, the parent included;
- `group_fx_wallet_high_gbp` adds up their wallets.

Pitch the group, not each company.

### Scores

Each score lists the evidence behind it:
- **FX evidence:** customs months, FX gain/loss, currency breakdown,
  foreign parent, directors abroad, niche.
- **Family-run:** directors and owners sharing a surname, or two
  generations.
- **Untapped:** owned by people not a group, family-run, no hedging,
  established 15+ years. A foreign parent counts against it (group
  treasury).

The weights are a starting point, to be recalibrated against real call
outcomes.

**Limits:**
- HMRC publishes who trades and what, not how much. The wallet is an
  estimate from filed figures.
- The currency mix is inferred from the goods, not seen on invoices.
- Companies House gives no director job titles, and finance heads below
  board level aren't on the register, so the finance contact comes from
  the accounts or website where it can (see below).
- Credit-reference data (Creditsafe and similar) is licensed, not public.
  If the bank has an API licence it could be added as a source, but this
  tool doesn't scrape it.

### Finance contact

One best finance contact per company, from the strongest source that
names one:

1. A director's filed occupation on Companies House (rare).
2. A person listed with a finance title in the filed accounts, e.g. "A
   Jones (Finance Director)" or "Chief Financial Officer: Jane Smith".
3. The company's own website. It's read only when 1 and 2 found nobody:
   - The site is found from a web address printed in the accounts, or
     failing that by guessing domains from the company name.
   - A site is accepted only if it shows the company's registration
     number or full registered name.
   - It reads the homepage plus up to 3 team, leadership, about or
     contact pages, and respects robots.txt.
   - It keeps names next to a finance title (Finance Director, CFO,
     Financial Controller, Treasurer and similar), plus generic company
     emails (info@, accounts@, finance@ ...).
4. gov.uk registry filings that name a person with a job title and a
   date: the "responsible person" on gender pay gap reports (employers
   with 250+ staff) and the person who approved the modern slavery
   statement (turnover £36m+). Both are free yearly CSV downloads, matched
   by company number; filings older than 3 years are ignored. Only finance
   titles are picked here; any title helps verify (see below).
5. Finance appointments in the news, e.g. "Acme Wines appoints Jane Smith
   as Finance Director". These come from Google News search feeds. A
   headline only counts if it names the company, and anything older than
   4 years is ignored. This is checked only when nothing above confirmed
   anyone. An appointment in the last 12 months is also listed as a
   trigger.
6. A director or company secretary written with accountancy letters (ACA,
   FCA, ACCA, FCCA, ACMA, FCMA, CGMA, CPA, CTA, CA) in the accounts or on
   the website.
7. The company secretary. In mid-market private companies this is often
   the finance director.
8. The director who signed the accounts, unless they're the MD/CEO or the
   only director.

`finance_contact_source` says which source it came from.

`finance_contact_confidence` grades the pick:
- **Verified:** a finance title from at least one source, the same person
  (first initial and surname) named by at least two independent sources
  (register, accounts, website, news, gender pay gap report, modern
  slavery statement), and one of them current: an active Companies House
  appointment, the website, or a filing or news item from the last 18
  months.
- **Confirmed:** a finance job title says so, from sources 1–4, or news
  from the last 2 years.
- **Likely:** a qualified accountant on the board or as secretary, a
  secretary who also signed the accounts, or news older than 2 years.
- **Guess:** the secretary alone, or the director who signed the accounts.
  Also any pick a registry filing gives a non-finance title (e.g. HR
  Director), or a secretary or signatory who is an officer of 10+ mostly
  unrelated companies (a professional company secretary). For a Likely or
  Guess officer, the tool looks up their other appointments: several
  within the same group count as evidence.

`finance_contact_evidence` lists every source naming the pick, with
titles and dates, e.g. "Companies House: director since 2020; gender pay
gap report: Finance Director (2026-03)".

**Confirmation by Google search.** After the list is written, the finder
workflow runs `tools/confirm_contacts.py`: a Google search per checked
company through search APIs, each kept within its monthly allowance and
used in turn: Search1API (`SEARCH1API_KEY`, 200 free), Tavily
(`TAVILY_API_KEY`, 1,000 free), Exa (`EXA_API_KEY`), Serper
(`SERPER_API_KEY`, ~$1 per 1,000). Set the keys as secrets and, if needed,
the allowances as variables (`SEARCH1API_MONTHLY`, `TAVILY_MONTHLY`,
`EXA_MONTHLY`, `SERPER_MONTHLY`; 0 = no cap). At most `SEARCH_MAX_PER_RUN`
searches a run (default 150 while Serper's 2,500 sign-up searches last, run every weekday morning; accounts qualified Out are skipped); results are cached for 30 days, so a company
is never paid for twice in a month. It reads only the search results' titles and snippets —
LinkedIn profile titles ("Alan Metcalfe - Finance Director at LJ Fairburn &
Son"), company board pages, news and org charts:
- the search names our pick with a finance title → **Verified**;
- it shows our pick in another role (e.g. MD) or a former one → Guess, and
  a finance person it found replaces them;
- it names a finance person where we only had a guess → they replace it
  (**Verified** when 2+ separate websites name them, else Confirmed). A
  finance director (CFO, FD, head of finance) always beats a financial
  controller or finance manager; among equals, the one most sites name, then
  the most senior. If the first search finds only a controller, a second
  search looks for the FD; if there's still none, the controller is used and
  `search_check` says "no finance director named".

A result counts only when it names the company as a phrase ("Forrest Fresh
Foods", not just "Forrest"), near the person unless it's the company's own
site; LinkedIn profiles on another country's LinkedIn site are skipped
(namesakes abroad), and headline words aren't taken for names ("Vice
President", "Business Partner", "Ron Wall, MBA" → Ron Wall).

`search_check` says what the search found; `finance_contact_linkedin` is
the person's public profile link. Run it by hand on any list (e.g. the
Google Sheet saved as CSV) with `--top 25 --show`, and `--debug` to see
the raw results.

For checking by hand:
- `verify_finance_contact_url` is a Google search of LinkedIn profiles for
  that name at that company, or for the company's finance roles when
  nobody is named.
- `linkedin_search_url` is a LinkedIn people search.

These are links only. The tool never reads LinkedIn. For a subsidiary
whose parent is also listed, `parent_finance_contact` names the parent's
finance contact, because group treasury usually sits there.

Treasury team members below board level, and their direct lines, come from
Cognism (mid-November) or Sales Navigator used by hand.

### Reading the accounts: tagged or PDF

About a third of accounts are filed in the tagged iXBRL format, where every
figure is labelled. The rest are PDFs only. Those are read as text:

- **Digital PDFs** go through `pdftotext -layout`, which keeps table rows
  together ("Turnover 3 45,123 41,000").
- **Scanned paper filings** have no text layer. Their first 6 pages are
  read with Tesseract OCR (set `OCR_MAX_PAGES` to change that). Those
  pages usually include the company-information page and often the
  strategic report.

From text it reads:
- turnover and last year's, cost of sales, cash and net assets: the first
  table row with that label, with the page's "£'000" or "£m" heading
  applied;
- bankers, auditors, finance people and the signatory;
- hedging and foreign-exchange-risk wording.

FX gains/losses and regional splits only come from tagged accounts.
`accounts_format` says which format each company's figures came from.

The GitHub workflow installs both tools. Locally they're optional
(`apt install poppler-utils tesseract-ocr`, or `brew install poppler
tesseract`). Without them, PDF-only accounts are skipped as before.

## Getting the list

**GitHub Actions (nothing to install):** the *FX company finder* workflow
runs:
- every weekday morning (05:17 UTC), so the day's list is ready before 7am
  (scheduled runs only happen from the default branch, `main`);
- when the workflow file changes (not on every code change: each run
  spends searches);
- on demand: Actions tab → *FX company finder* → *Run workflow*. You can
  name niches there and give your bank's name (or set a repository
  variable `OWN_BANK`).

The list goes to the dashboard's password-protected Accounts page
(`/accounts`, with a CSV export). Runs attach no files: the repository is
public, and run attachments would be downloadable by anyone. Run locally,
`tools/confirm_contacts.py` (or `tools/to_excel.py`) writes
`fx_companies.xlsx`, an Excel workbook that also opens in Google Sheets.
Its tabs are:

- **Checked**: the fully checked companies with the key columns first.
  Start your spot check here.
- **One tab per section**: Core, Above and Below, with every column.
- **About**: when the list was made and how to read it.

Money columns are numbers in £, links are clickable, and the header row is
frozen and filterable. Pass `--output something.csv` for a CSV instead.

**Dashboard: the Accounts page.** Each run also puts the checked companies
on the dashboard's password-protected Accounts page (`/accounts`, linked
from the dashboard's top bar). It has search, filters (FD named, confidence,
currency pair, triggers), the call angle to copy, and a CSV export. The list
goes to the site's private Netlify Blobs store (`tools/to_accounts_json.py`,
then `apps/web/scripts/upload-accounts.mjs`). The page fetches it from
`/api/accounts` (`apps/web/netlify/functions/accounts.mjs`), which checks
the password first, so the list is never committed or in the public build.
To set it up:
- in Netlify (Site configuration → Environment variables), set
  `ACCOUNTS_PASSWORD` to a long password, then redeploy;
- the finder uses the dashboard deploy's `NETLIFY_SITE_ID` and
  `NETLIFY_AUTH_TOKEN` secrets.

To turn an earlier run's CSV into a workbook, run *FX list to Excel*
(`tools/to_excel.py`). The workflow uses the repo's
`COMPANIES_HOUSE_API_KEY` secret.

**Locally** (Python 3.9+, standard library only, nothing to `pip install`):

```bash
export COMPANIES_HOUSE_API_KEY=...         # free; needed for accounts, owners, charges and directors
python3 main.py --list-niches              # niche ids, currency pairs, names
python3 main.py                            # every niche + customs traders (long: see timing)
python3 main.py --own-bank Barclays        # flag Barclays' existing clients
python3 main.py --band-min 10000000 --band-max 100000000   # a different core band
python3 main.py --min-turnover 2000000     # keep companies under the band too (Below section)
python3 main.py --max-enrich 300           # check 300 companies; the rest ship unchecked
python3 main.py --hmrc-months 0            # skip customs records (and currency mix)
python3 main.py --bulk-file BasicCompanyDataAsOneFile-2026-10-01.zip
python3 main.py --source api --niches european-wine-importers   # no bulk download; samples the search API
```

- **Downloads:** the bulk file (about 470MB) is downloaded once a month
  into `~/.cache/fx-lead-sourcer`. HMRC files go under
  `~/.cache/fx-lead-sourcer/hmrc`.
- **Timing:** each company checked costs five Companies House calls (filing
  history, accounts document, officers, owners, charges). That's about four
  seconds per company at a 0.8s spacing.
- **Shared key:** Companies House allows 600 calls per 5 minutes per key.
  Set `CH_RATE_LIMIT_SECONDS` higher (e.g. `0.8`) to leave room for other
  jobs on the same key.
- **Without a key:** it still lists the candidates from the bulk file, just
  without the accounts, bank or directors.

## Output

One row per company in `fx_companies.xlsx` (the section tabs carry every column below). Rows are ordered by section,
then by FX evidence + untapped score + triggers, then by wallet size.

| column | |
|---|---|
| `section` | Core (£25m–£250m), Above (£250m+), Below (under £25m) |
| `triggers` | Dated events, e.g. "new owner Acme Bidco Limited (2026-03) — looks private-equity backed" |
| `when_to_call`, `planning_window_now` | e.g. "year-end 31 Dec: planning Sep–Nov \| imports Mar–Jun (next: Mar)"; "yes" when in the window now |
| `turnover_gbp`, `turnover_period_end` | From the filed accounts |
| `fx_wallet_low_gbp`, `fx_wallet_high_gbp`, `fx_wallet_basis` | Estimated annual foreign-currency flow, and how it was worked out |
| `import_currencies`, `export_currencies` | e.g. "EUR 62%, USD 38%" |
| `currency_pairs` | Pairs to pitch, e.g. "GBP/EUR\|GBP/USD" (the niche's pairs when there are no customs records) |
| `trade_countries` | e.g. "from IT 50%, IN 38%, ES 12%; to US 100%" |
| `main_bank`, `bank_type`, `banking_relationships` | e.g. "Barclays", "high-street", "Barclays (named as bankers, charge 2021-03)" |
| `own_bank_client`, `pe_backed` | "yes" if it already banks with you; the investor owner if there is one |
| `group_parent`, `group_companies_in_list`, `group_fx_wallet_high_gbp` | UK parent, how many of its companies are listed, their combined wallet |
| `fx_evidence_score/level`, `fx_evidence` | 0–100, High/Medium/Low, and the evidence lines |
| `untapped_score/level`, `untapped_reasons`, `family_run` | 0–100, High/Medium/Low, and why |
| `fx_niche`, `fx_exposure`, `call_angle` | From the niche list, or "Proven trader: <goods>" |
| `hmrc_import_months`, `hmrc_export_months`, `hmrc_goods`, `hmrc_match` | Customs record months out of 12, top goods chapters, match confidence |
| `fx_gain_loss_gbp`, `fx_gain_loss_prior_gbp`, `turnover_growth`, `overseas_turnover_share` | From the filed accounts: this year's and last year's FX gain (+) / loss (−), growth, share of sales abroad |
| `cost_of_sales_gbp`, `cash_gbp`, `bank_borrowings_gbp`, `net_assets_gbp`, `auditor`, `auditor_tier` | From the filed accounts |
| `size_basis`, `accounts_category`, `accounts_format` | How the size was judged; accounts read as ixbrl, pdf or scanned pdf |
| `finance_contact`, `finance_contact_role`, `finance_contact_source`, `finance_contact_confidence`, `finance_contact_evidence` | Best finance contact, where it came from, Verified / Confirmed / Likely / Guess, and every source naming them (see above) |
| `verify_finance_contact_url`, `linkedin_search_url` | One-click searches to confirm the finance contact by hand |
| `lead_director` (+ occupation), `all_directors`, `company_secretary`, `accounts_signed_by`, `owners` | From Companies House and the accounts |
| `website`, `generic_emails` | The company's confirmed website and generic addresses on it, when it was read |
| `parent_finance_contact` | The listed parent's finance contact, for a subsidiary |
| `company_name`, `company_number`, `sic_codes`, `incorporated_on`, `postcode`, `registered_address`, `companies_house_url` | For matching and checking |

## Running as a live URL (server.py, api/run.py)

`server.py` is a stdlib HTTP wrapper around the same pipeline, for Fly.io
(`fly.toml`, `Dockerfile`).
- `GET /health`, `GET /niches`
- `POST /run` with body `{"niches": [...], "min_turnover", "turnover_check", "max_enrich", "max_per_sic", "own_bank"}`; returns 202
- `GET /status`
- `GET /leads.csv`

Set `TRIGGER_TOKEN` to require an `X-Trigger-Token` header on `POST /run`. It
uses the bulk file at `CH_BULK_FILE` if set (put it on a volume), otherwise
the search API.

`api/run.py` is the same as a Vercel function. Serverless can't hold the
bulk file, so it:
- uses the search API;
- needs `niches`;
- samples 10 companies per SIC code by default.

The GitHub workflow is the better way to get the full list.

## Structure

```
config/fx_niches.json       — the FX niches (copy of call-list-generator/niches.json)
sourcer/hmrc.py             — HMRC trader files + trade statistics: download, parse, per-trader history
sourcer/matching.py         — link HMRC traders to Companies House companies
sourcer/currency.py         — currency mix from goods x national trade by country; FX wallet range
sourcer/banks.py            — banking group/type from charges and the accounts "Bankers" line
sourcer/triggers.py         — new owners / PE backing, new or paid-off charges, facility renewal, new directors
sourcer/timing.py           — when to call: year-end planning window, customs season
sourcer/bulk.py             — Companies House bulk file: niche candidates + matching indexes
sourcer/accounts.py         — turnover, cost of sales, FX gain/loss, overseas share, balance sheet, bankers, auditor from iXBRL
sourcer/companies_house.py  — CH API: search, profile, officers, owners, charges
sourcer/signals.py          — FX evidence, family-run and untapped scores
sourcer/roles.py            — finance / lead director by filed occupation
sourcer/people.py           — finance people from accounts/web text; best finance contact
sourcer/pdf.py              — PDF accounts to text: pdftotext, or OCR for scanned filings
sourcer/news.py             — finance appointments in Google News feeds; verification search links
sourcer/website.py          — company's own website (only when needed): confirm, team pages, generic emails
main.py                     — the pipeline + CLI
server.py, Dockerfile, fly.toml        — live URL on Fly.io
api/run.py, api/health.py, vercel.json — Vercel functions (search-API source, no HMRC)
tools/probe_sources.py      — one-off check of what each public source contains
tests/                      — offline tests (stdlib unittest, no network)
```

`config/fx_niches.json` is a copy so this folder deploys on its own. If
you edit the niche list, copy it across. `tests/` fails if the two drift.

```bash
python3 -m unittest discover -s tests
```

## What this tool deliberately does not do

- No personal emails, no phone lookups, nothing from LinkedIn or social
  sites.
- No AI calls. The data is public HMRC and Companies House records, plus
  up to 4 pages of a company's own website, read only when nothing else
  names a finance person. `--no-websites` turns that off.
- No outreach. It builds a list for people to work.
