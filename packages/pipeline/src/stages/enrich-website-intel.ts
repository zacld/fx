/**
 * stages/enrich-website-intel.ts — TS port of scripts/legacy/enrich_website_intelligence.py.
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
  cleanCompanyName,
  type Lead,
} from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";
import { createCachedFetcher } from "../sources/fetch.js";
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

export interface EnrichIntelOptions {
  dbPath?: string; outPath?: string; runsDir?: string;
  pageCachePath?: string;
  concurrency?: number;
  max?: number;
  force?: boolean;
  persist?: boolean;
}

export interface EnrichIntelResult {
  totalLeads: number; toProcess: number; enriched: number;
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
      return !l.fx_likelihood_score;
    };
    const candidates = Object.values(leads).filter(needs).slice(0, max);

    let withSnippets = 0, withCountries = 0;
    const limit = pLimit(concurrency);
    await Promise.all(candidates.map((l) => limit(async () => {
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
          fetcher: fetcher.fetch,
        });

        let combinedText = "";
        let homepageHtml = "";
        for (const url of pages) {
          const got = await fetcher.fetch(url);
          if (!got) continue;
          if (url === l.website && !homepageHtml) homepageHtml = got.html;
          combinedText += " " + htmlToText(got.html);
        }
        combinedText = combinedText.replace(/\s+/g, " ").trim();

        const evidence = extractWebsiteIntel(combinedText);
        const techSigs = homepageHtml ? detectTechStack(homepageHtml) : [];
        const techScore = techStackFxScore(techSigs);
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
    })));

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
      with_snippets: withSnippets, with_countries: withCountries,
      fx_likelihood_ge_80: buckets.ge80,
      fetcher_stats: fetcher.stats(),
    });
    if (persist) rec.finish(sqlite, runsDir);

    return {
      totalLeads: Object.keys(leads).length, toProcess: candidates.length,
      enriched: candidates.length, withSnippets, withCountries,
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
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--force") o.force = true;
  }
  return o;
}
const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  runEnrichWebsiteIntelStage(parseArgs(process.argv.slice(2))).then((r) => {
    console.log(`enrich-website-intel: ${r.totalLeads} leads | processed ${r.toProcess} | snippets ${r.withSnippets} | countries ${r.withCountries}`);
    console.log(`  fx_likelihood: 80+ ${r.fxLikelihoodBuckets.ge80} | 60-79 ${r.fxLikelihoodBuckets.b60_79} | 40-59 ${r.fxLikelihoodBuckets.b40_59} | 20-39 ${r.fxLikelihoodBuckets.b20_39} | <20 ${r.fxLikelihoodBuckets.lt20}`);
    console.log(`  run_id ${r.runId}`);
  }).catch((e) => { console.error("enrich-website-intel failed:", e); process.exitCode = 1; });
}
