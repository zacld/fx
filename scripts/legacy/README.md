# Legacy Python enrichment scripts

These three scripts produced ~80% of the dashboard's "decision-maker / FX
evidence" data, but they were **never wired into `npm run pipeline`**. They were
run manually from a laptop with `python3.11 scripts/<name>.py [--force]`. Daily
CI runs alone never touched them — when a fresh data refresh landed, the
dashboard's `decision_makers[]` / `route_grade` / `fx_evidence_snippets`
fields went stale unless someone re-ran them locally.

As of **May 2026**, the behaviour of all three has been ported to TypeScript
stages that run inside `npm run pipeline` automatically:

| Legacy script | Now lives in |
|---|---|
| [`enrich_contacts.py`](enrich_contacts.py) | [`packages/pipeline/src/stages/enrich-contacts.ts`](../../packages/pipeline/src/stages/enrich-contacts.ts) + [`@fx/core` `contacts.ts`](../../packages/core/src/contacts.ts) (libphonenumber-based phones, Cloudflare / [at]/[dot] email deobfuscation) |
| [`enrich_decision_makers.py`](enrich_decision_makers.py) | [`packages/pipeline/src/stages/enrich-decision-makers.ts`](../../packages/pipeline/src/stages/enrich-decision-makers.ts) + [`@fx/core` `{names,emails,people,tech-stack}.ts`](../../packages/core/src) + [`sources/{sitemap,smtp-verify,no-website-fallback}.ts`](../../packages/pipeline/src/sources) |
| [`enrich_website_intelligence.py`](enrich_website_intelligence.py) | [`packages/pipeline/src/stages/enrich-website-intel.ts`](../../packages/pipeline/src/stages/enrich-website-intel.ts) + [`@fx/core` `website-intel.ts`](../../packages/core/src/website-intel.ts) |

The TS ports do everything the Python scripts did, plus:

- **Shared on-disk page cache** — `data/cache/pages.json`, 7 d TTL, every stage
  reuses what's been fetched. The Python scripts each re-fetched the homepage
  + /about + /contact independently.
- **Per-host rate limiting** — 600 ms default between requests to the same
  host (override with `FX_HOST_MIN_INTERVAL_MS`). No more six concurrent
  workers hammering one site.
- **sitemap.xml + robots.txt** — surfaces bespoke pages like
  `/our-vineyards` / `/where-our-beans-come-from` that no hardcoded slug
  list can predict. Falls back to slug-probing only when no sitemap.
- **Companies House — PSCs, filings, charges** — the new `ChClient` extends
  the v1 endpoints (officers, profile) with PSCs, recent filings, and a
  charges summary. PSCs are often the *real* owner; charges are a trade-
  finance signal.
- **Cloudflare + `[at]/[dot]` email deobfuscation** — emails written as
  `<a data-cfemail="...">` or `name [at] acme [dot] co [dot] uk` are now
  caught.
- **libphonenumber-js phone parsing** — UK / international, E.164 dedup,
  mobile / fixed-line / freephone classification.
- **Nickname-aware name matching** — Jim Smith and James Smith merge to
  one person across pages; distinct John Smiths stay apart.
- **HTML structure role extraction** — JSON-LD `schema.org/Person`, h-tag +
  sibling role, `<img alt="James Smith, Finance Director">`. The Python
  version did body-text proximity only.
- **Domain-pattern email inference** — if `joe.smith@acme.com` and
  `jane.brown@acme.com` are on the site, every guess for an acme director
  gets `first.last@` floated to position 0 with confidence = 2/2. This
  works even when SMTP can't verify (CI / catch-all domains).
- **Persistent SMTP cache** — `data/cache/smtp.json`, 30 d TTL. CI-safe
  by default (port 25 is blocked from GitHub Actions egress, so the
  verifier falls back to MX-only). HTTP verifier opt-in via
  `FX_EMAIL_VERIFIER_URL` (Hunter / Snov / NeverBounce / custom).
- **Tech-stack FX signals** — Shopify, WooCommerce, multi-currency
  switchers, non-GBP `priceCurrency`, hreflang language switchers, Stripe,
  Klarna. Folded into `fx_likelihood_score`.
- **Trustpilot review count + press search URLs** — extracted from
  embedded widgets, exposed as `trustpilot_reviews` /
  `trustpilot_search_url` / `press_search_url`.
- **No-website fallback** — domain guessing (HEAD-probed), UK switchboard
  area hint (postcode → 020 / 0161 / 0131 / etc.), town-qualified
  Google→LinkedIn searches. Recovers leads previously stuck on grade E/F.
- **Cache versioning** — bumping the schema version of `pages.json` /
  `smtp.json` / `companies_house.json` auto-invalidates entries from older
  shapes. No more manual `rm data/cache/*.json`.

These scripts are kept here as reference for:

1. Behavioural cross-checks during the cutover (run the .py against the
   same lead and diff against the TS output — useful for spotting any
   port regression).
2. Documentation of the Python-era pattern choices (the TS ports cite
   line numbers in their commit messages).

**Do not call them from CI or the documented pipeline.** They are not
linked from `package.json` or `.github/workflows/discovery.yml`. They write
directly to `data/leads.json` without going through the SQLite DB, so they
can silently drift from the schema. Plan to delete this directory entirely
once the TS ports have run a few production cycles unmodified.
