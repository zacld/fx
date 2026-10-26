/**
 * stages/enrich-website-intel.ts — TS port of the original Python enrich_website_intelligence.py (removed).
 *
 * For every lead with a website, crawls the product/supplier/about pages
 * (sitemap-aware) and extracts the FX evidence the dashboard surfaces as
 * "Why this company" copy ingredients: snippet sentences, country mentions,
 * supplier phrases, import/export language, size signals, and (new) tech-
 * stack signals from the storefront.
 *
 * Per CLAUDE.md Priority 8: this is pure rule-based extraction, no AI call.
 *
 * Output per lead:
 *   fx_evidence_snippets[], country_evidence[], supplier_evidence[],
 *   import_export_evidence[], inferred_currency_pairs[], currency_reason,
 *   size_signals[], tech_signals[], fx_likelihood_score (0-100),
 *   website_confidence_reason.
 *
 * Idempotent. Shares the page cache with enrich-decision-makers so pages
 * fetched there cost zero here.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";

import {
  LeadSchema, repoRoot,
  htmlToText, extractWebsiteIntel, computeFxLikelihood, generateWebsiteConfidenceReason,
  detectTechStack, techStackFxScore,
  extractTrustpilotReviewCount, pressMentionsSearchUrl, trustpilotSearchUrl,
  cleanCompanyName, classifyText,
  type Lead,
} from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";
import { createCachedFetcher, headOk } from "../sources/fetch.js";
import { stageDeadline, stoppable, type StopFlag } from "../sources/deadline.js";
import { discoverPages } from "../sources/sitemap.js";
import { shouldSkipUrl } from "../sources/blocklists.js";

const MAX_PAGES = 6;

const INTEL_SLUGS = [
  // Product / brand
  "products", "our-products", "product-range", "range", "brands", "our-brands",
  "catalogue", "catalog", "collections", "collection",
  // Supplier / sourcing
  "suppliers", "our-suppliers", "sourcing", "supply-chain",
  "partners", "our-partners", "producer", "producers",
  // Trade / wholesale
  "wholesale", "trade", "trade-account", "trade-accounts", "trade-customers",
  "distribution", "distributors", "stockists", "resellers",
  // Import/export explicit
  "imports", "exports", "import", "export", "international",
  // Company story
  "about", "about-us", "our-story", "story", "history", "who-we-are",
  // Case studies / customers — reveal client geography
  "case-studies", "case-study", "customers", "clients",
];

// Time limits, as in enrich-decision-makers: stop starting new leads after
// FX_INTEL_BUDGET_MIN minutes (the rest wait for the next run) and give up on
// one site after FX_INTEL_LEAD_TIMEOUT_S, so score / dedup / export always run
// inside the workflow's cap. A lead whose site was read is left for
// RECHECK_DAYS even when it scored 0 (it used to be re-crawled every run).
const DEFAULT_BUDGET_MIN = Number(process.env.FX_INTEL_BUDGET_MIN ?? "15");
const DEFAULT_LEAD_TIMEOUT_S = Number(process.env.FX_INTEL_LEAD_TIMEOUT_S ?? "90");
const RECHECK_DAYS = 14;

export interface EnrichIntelOptions {
  dbPath?: string; outPath?: string; runsDir?: string;
  pageCachePath?: string;
  concurrency?: number;
  max?: number;
  force?: boolean;
  persist?: boolean;
  budgetMinutes?: number;
  leadTimeoutSeconds?: number;
}

export interface EnrichIntelResult {
  totalLeads: number; toProcess: number; enriched: number;
  timedOut: number; leftForNextRun: number;
  withSnippets: number; withCountries: number;
  fxLikelihoodBuckets: { ge80: number; b60_79: number; b40_59: number; b20_39: number; lt20: number };
  runId: string;
}

export async function runEnrichWebsiteIntelStage(opts: EnrichIntelOptions = {}): Promise<EnrichIntelResult> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const outPath = opts.outPath ?? resolve(root, "data/leads.json");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const concurrency = opts.concurrency ?? 4;
  const max = opts.max ?? 1000;
  const force = !!opts.force;
  const persist = opts.persist ?? true;
  // ...or earlier, to leave CH accounts (FX_ACCOUNTS_BUDGET_MIN), score / dedup / export and a site still
  // finishing time before the pipeline's end.
  const deadline = stageDeadline(opts.budgetMinutes ?? DEFAULT_BUDGET_MIN,
    Number(process.env.FX_ACCOUNTS_BUDGET_MIN ?? "4") + 5);
  const leadTimeoutMs = (opts.leadTimeoutSeconds ?? DEFAULT_LEAD_TIMEOUT_S) * 1000;

  const { db, sqlite, close } = getDb(dbPath);
  const rec = new RunRecorder("enrich-website-intel", { dbPath, outPath, concurrency, max, force });
  const fetcher = createCachedFetcher({ cachePath: opts.pageCachePath });

  try {
    const leads: Record<string, Lead> = {};
    for (const row of db.select().from(schema.leads).all()) {
      const p = LeadSchema.safeParse(row.data);
      leads[row.id] = p.success ? p.data : (row.data as Lead);
    }

    const needs = (l: Lead): boolean => {
      if (!l.website) return false;
      if (shouldSkipUrl(l.website).skip) return false;
      if (force) return true;
      if (l.fx_likelihood_score) return false;
      const checkedAt = (l as Record<string, unknown>).intel_checked_at as string | undefined;
      return !checkedAt || (Date.now() - new Date(checkedAt).getTime()) / 86_400_000 >= RECHECK_DAYS;
    };
    const candidates = Object.values(leads).filter(needs).slice(0, max);

    let withSnippets = 0, withCountries = 0, enriched = 0, timedOut = 0, leftForNextRun = 0;
    const limit = pLimit(concurrency);
    await Promise.all(candidates.map((l) => limit(async () => {
      if (Date.now() >= deadline) { leftForNextRun++; return; }
      (l as Record<string, unknown>).intel_checked_at = new Date().toISOString();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), leadTimeoutMs); });
      const stop: StopFlag = { stopped: false };
      const outcome = await Promise.race([readSite(l, stop), timeout]);
      clearTimeout(timer);
      if (outcome === "timeout") {
        stop.stopped = true;   // its unfinished work stops at the next step instead of running on
        timedOut++;
        console.warn(`enrich-website-intel: gave up on ${l.company_name ?? l.id} after ${leadTimeoutMs / 1000}s`);
      } else enriched++;
    })));
    if (leftForNextRun) console.log(`enrich-website-intel: time budget used — ${leftForNextRun} leads left for the next run`);

    async function readSite(l: Lead, stop: StopFlag): Promise<void> {
      try {
        const pages = await discoverPages({
          homeUrl: l.website!,
          relevant: (_url, path) => {
            if (path === "/" || path === "") return true;
            return /\/(products?|brands|catalog|collection|suppliers?|sourcing|supply-chain|partners?|producers?|wholesale|trade|distribution|stockists|imports?|exports?|international|about|story|history|who-we-are|case-stud|customers|clients)/i.test(path);
          },
          fallbackSlugs: INTEL_SLUGS,
          prioritise: ["suppliers", "products", "about"],
          maxPages: MAX_PAGES,
          fetcher: stoppable(fetcher.fetch, stop),
          headOk: async (url, timeoutMs) => !stop.stopped && headOk(url, timeoutMs),
        });

        let combinedText = "";
        let homepageHtml = "";
        for (const url of pages) {
          if (stop.stopped) return;
          const got = await fetcher.fetch(url);
          if (!got) continue;
          if (url === l.website && !homepageHtml) homepageHtml = got.html;
          combinedText += " " + htmlToText(got.html);
        }
        combinedText = combinedText.replace(/\s+/g, " ").trim();

        if (stop.stopped) return;   // given up on (timed out): leave the lead as it was
        const evidence = extractWebsiteIntel(combinedText);
        const techSigs = homepageHtml ? detectTechStack(homepageHtml) : [];
        const techScore = techStackFxScore(techSigs);

        // ── Feed deep-page FX signals back into fx_payment_signals ─────────────
        // The homepage-only scrape (discover stage) misses signals buried on
        // /products, /suppliers, /about etc. Run classifyText on the combined
        // multi-page text and merge any new signals in so they count for scoring.
        const deepCls = classifyText(combinedText);
        const existingFxSet = new Set(l.fx_payment_signals ?? []);
        const newFxSigs = deepCls.fxPaymentSignals.filter((s) => !existingFxSet.has(s));
        if (newFxSigs.length > 0) {
          l.fx_payment_signals = [...(l.fx_payment_signals ?? []), ...newFxSigs];
        }
        // Also merge new secondary signals (used for pays_fx_confirmed + Gate G)
        const existingSecSet = new Set(l.secondary_signals ?? []);
        const newSecSigs = deepCls.secondarySignals.filter((s) => !existingSecSet.has(s));
        if (newSecSigs.length > 0) {
          l.secondary_signals = [...(l.secondary_signals ?? []), ...newSecSigs];
        }

        const fxScore = computeFxLikelihood(
          (l.fx_payment_signals ?? []).length,
          evidence,
          techScore,
        );

        const trustpilot = homepageHtml ? extractTrustpilotReviewCount(homepageHtml) : null;
        const coClean = cleanCompanyName(l.company_name);

        const leadAny = l as Record<string, unknown>;
        leadAny.fx_evidence_snippets = evidence.fx_evidence_snippets;
        leadAny.country_evidence = evidence.country_evidence;
        leadAny.supplier_evidence = evidence.supplier_evidence;
        leadAny.import_export_evidence = evidence.import_export_evidence;
        leadAny.inferred_currency_pairs = evidence.inferred_currency_pairs;
        leadAny.currency_reason = evidence.currency_reason;
        leadAny.size_signals = evidence.size_signals;
        leadAny.tech_signals = techSigs.map((s) => s.label);
        leadAny.fx_likelihood_score = fxScore;
        leadAny.website_confidence_reason = generateWebsiteConfidenceReason(l);
        leadAny.trustpilot_reviews = trustpilot?.reviews ?? null;
        leadAny.trustpilot_score = trustpilot?.score ?? null;
        leadAny.trustpilot_search_url = coClean ? trustpilotSearchUrl(coClean) : null;
        leadAny.press_search_url = coClean ? pressMentionsSearchUrl(coClean) : null;

        // Fold inferred pairs into the existing fx_exposure string.
        const existing = (l.fx_exposure || "").trim();
        for (const p of evidence.inferred_currency_pairs) {
          if (!existing.includes(p)) leadAny.fx_exposure = (existing ? `${existing}, ${p}` : p).trim();
        }

        if (evidence.fx_evidence_snippets.length) withSnippets++;
        if (evidence.country_evidence.length) withCountries++;
      } catch (e) {
        rec.warn(`intel failed for ${l.id}: ${String(e)}`);
      }
    }

    // Also generate a confidence reason for leads that don't get crawled (no
    // website / bad domain), so the dashboard renders something.
    for (const l of Object.values(leads)) {
      if (!l.website_confidence_reason) {
        (l as Record<string, unknown>).website_confidence_reason = generateWebsiteConfidenceReason(l);
      }
    }

    const buckets = { ge80: 0, b60_79: 0, b40_59: 0, b20_39: 0, lt20: 0 };
    for (const l of Object.values(leads)) {
      const s = l.fx_likelihood_score ?? 0;
      if (s >= 80) buckets.ge80++;
      else if (s >= 60) buckets.b60_79++;
      else if (s >= 40) buckets.b40_59++;
      else if (s >= 20) buckets.b20_39++;
      else buckets.lt20++;
    }

    if (persist) {
      const upd = sqlite.prepare(`UPDATE leads SET data=@data WHERE id=@id`);
      const tx = sqlite.transaction(() => { for (const l of Object.values(leads)) upd.run({ id: l.id, data: JSON.stringify(l) }); });
      tx();
      fetcher.flush();
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(leads, null, 2));
    }
    rec.section("contact_coverage", {
      total_leads: Object.keys(leads).length, to_process: candidates.length,
      enriched, timed_out: timedOut, left_for_next_run: leftForNextRun,
      with_snippets: withSnippets, with_countries: withCountries,
      fx_likelihood_ge_80: buckets.ge80,
      fetcher_stats: fetcher.stats(),
    });
    if (persist) rec.finish(sqlite, runsDir);

    return {
      totalLeads: Object.keys(leads).length, toProcess: candidates.length,
      enriched, timedOut, leftForNextRun, withSnippets, withCountries,
      fxLikelihoodBuckets: buckets, runId: rec.run.run_id,
    };
  } finally {
    close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): EnrichIntelOptions {
  const o: EnrichIntelOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--out") o.outPath = argv[++i];
    else if (a === "--runs") o.runsDir = argv[++i];
    else if (a === "--page-cache") o.pageCachePath = argv[++i];
    else if (a === "--limit") o.concurrency = Number(argv[++i]);
    else if (a === "--budget-min") o.budgetMinutes = Number(argv[++i]);
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--force") o.force = true;
  }
  return o;
}
const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  runEnrichWebsiteIntelStage(parseArgs(process.argv.slice(2))).then((r) => {
    console.log(`enrich-website-intel: ${r.totalLeads} leads | due ${r.toProcess} | read ${r.enriched} | gave up ${r.timedOut} | left for next run ${r.leftForNextRun} | snippets ${r.withSnippets} | countries ${r.withCountries}`);
    console.log(`  fx_likelihood: 80+ ${r.fxLikelihoodBuckets.ge80} | 60-79 ${r.fxLikelihoodBuckets.b60_79} | 40-59 ${r.fxLikelihoodBuckets.b40_59} | 20-39 ${r.fxLikelihoodBuckets.b20_39} | <20 ${r.fxLikelihoodBuckets.lt20}`);
    console.log(`  run_id ${r.runId}`);
    process.exit(0);   // saved; a site we gave up on can't hold the step open
  }).catch((e) => { console.error("enrich-website-intel failed:", e); process.exit(1); });
}
