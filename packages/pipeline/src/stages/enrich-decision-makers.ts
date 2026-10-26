/**
 * stages/enrich-decision-makers.ts — TS port of the original Python enrich_decision_makers.py (removed).
 *
 * For every lead with a Companies-House number or a director name, this stage:
 *
 *   1. Pulls active officers + PSCs from CH (cached, budget-respecting).
 *      PSCs that aren't already an officer get added — often the *real* owner
 *      and the best person to call.
 *   2. Cleans the company name (strip page-title prefixes, slogans, legal
 *      suffixes) and builds Google→LinkedIn search URLs (Priority 12 — no
 *      direct LinkedIn scraping).
 *   3. Discovers the company's team / about / contact pages via
 *      sitemap.xml + robots.txt + slug probes (sources/sitemap.ts).
 *   4. Fetches each page via the shared cached fetcher (sources/fetch.ts) so
 *      enrich-website-intel can reuse the same HTML.
 *   5. Runs @fx/core extractPeople over each page — JSON-LD, HTML structure,
 *      <img alt>, body proximity, mailto: context. Merges with CH officers
 *      via namesMatch() (Jim Smith + James Smith → one person).
 *   6. Generates email guesses for each director (12 patterns) and (a) tries
 *      to match them to on-domain emails found on the page, (b) infers the
 *      domain's prevailing pattern from any named emails found, and (c) for
 *      domains that don't catch-all, optionally SMTP-verifies via the
 *      persistent cache (skipped in CI by default — see sources/smtp-verify).
 *   7. Computes route_grade A-F and contact_confidence 0-100.
 *   8. Detects tech-stack signals from the homepage (Shopify, multi-currency,
 *      stripe non-GBP, etc.) and stores them as `tech_signals[]` on the lead.
 *
 * Idempotent: re-runs skip leads that already have decision_makers + route_grade
 * unless --force is passed. Stores in SQLite + exports data/leads.json.
 *
 * CLI: tsx src/stages/enrich-decision-makers.ts [--db ...] [--out ...] [--max ...]
 *        [--limit N] [--force] [--no-smtp] [--no-tech]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";

import {
  LeadSchema, repoRoot,
  cleanCompanyName, linkedinCompanyName, parseChName, namesMatch, isPlausibleDmName,
  generateEmailGuesses, inferDomainEmailPattern, rankEmailGuessesByPattern,
  extractPeople, classifyRole, detectTechStack,
  type Lead, type DecisionMaker, type RouteGrade, type EmailGuess,
} from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";
import { ChClient, type ChOfficer, type ChPsc } from "../sources/companies-house.js";
import { createCachedFetcher, headOk as defaultHeadOk, type CachedFetcher } from "../sources/fetch.js";
import { stageDeadline, stoppable, type StopFlag } from "../sources/deadline.js";
import { discoverPages } from "../sources/sitemap.js";
import { createSmtpVerifier, type SmtpVerifier } from "../sources/smtp-verify.js";
import { buildNoWebsiteHints, linkedinSearchForTown } from "../sources/no-website-fallback.js";

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_OFFICERS = 8;
const MAX_PAGES = 6;            // homepage + 5 team/about/contact pages
// Leads are enriched in batches, persisting after each one, rather than in one
// giant Promise.all over the whole candidate pool. Two reasons: (1) peak
// memory stays bounded to one batch's worth of concurrently-held page HTML/
// cheerio trees instead of the entire run's, which is what was blowing the
// 4GB heap once the lead pool grew past ~1200; (2) a crash mid-run (OOM,
// runner timeout, a bad page) now only loses the in-flight batch instead of
// every lead this run touched — every prior batch already has dm_enriched_at
// set and persisted, so the next run picks up where this one left off rather
// than redoing the whole backlog from scratch.
const ENRICH_BATCH_SIZE = 50;
// Time limits, so the stages after this one (website intel, score, dedup,
// drafts, export) always get to run inside the workflow's 60-minute cap.
// The stage stops starting new leads after FX_DM_BUDGET_MIN minutes, saves,
// and the next run carries on from where it stopped (unenriched leads are
// still candidates). A lead taking longer than FX_DM_LEAD_TIMEOUT_S is left
// for 7 days, like any other enriched lead, so one slow site can't hold up
// its whole batch again.
const DEFAULT_BUDGET_MIN = Number(process.env.FX_DM_BUDGET_MIN ?? "35");
const DEFAULT_LEAD_TIMEOUT_S = Number(process.env.FX_DM_LEAD_TIMEOUT_S ?? "120");
const TEAM_SLUGS = [
  "team", "our-team", "meet-the-team", "people", "our-people",
  "management", "leadership", "directors", "staff", "key-people",
  "about", "about-us", "who-we-are", "company", "the-company",
  "careers", "jobs", "press", "news",        // surfaces named execs in quotes
  "founders", "leadership-team", "exec-team",
];

export interface EnrichDmOptions {
  dbPath?: string; outPath?: string; runsDir?: string;
  pageCachePath?: string; chCachePath?: string; smtpCachePath?: string;
  concurrency?: number;
  /**
   * Hard cap on leads to enrich per run (default 300 — was 1000; see
   * ENRICH_BATCH_SIZE above for why that was too high once checkpointed
   * persistence wasn't yet in place). With checkpointing, the main risk of a
   * high `max` is just run time, not lost work — raise it if the backlog
   * needs to clear faster and CI job time allows.
   */
  max?: number;
  force?: boolean;
  /** Disable SMTP verification entirely (default: env FX_SMTP_DISABLE / CI). */
  disableSmtp?: boolean;
  /** Disable tech-stack detection (rarely useful — kept for tests). */
  disableTech?: boolean;
  persist?: boolean;
  /** Stop starting new leads after this many minutes (default env FX_DM_BUDGET_MIN or 35). */
  budgetMinutes?: number;
  /** Give up on one lead after this many seconds (default env FX_DM_LEAD_TIMEOUT_S or 120). */
  leadTimeoutSeconds?: number;
}

export interface EnrichDmResult {
  totalLeads: number; toProcess: number; enriched: number;
  /** Leads left for the next run because the time budget ran out. */
  leftForNextRun: number; timedOut: number;
  multiDmLeads: number; verifiedAny: number;
  routeGrades: Record<RouteGrade, number>;
  runId: string;
}

const TIER_LABEL = { 1: "Primary" as const, 2: "Secondary" as const, 3: "Fallback" as const };

// ── Helpers ──────────────────────────────────────────────────────────────────
function bareDomain(url: string | null | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase().replace(/^www\d*\./, ""); } catch { return ""; }
}

// LinkedIn native search URLs — works when logged in, doesn't depend on Google's index.
function liPersonSearch(name: string, coShort: string): string {
  const kw = [name, coShort].filter(Boolean).join(" ");
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(kw)}`;
}
function liPersonNameOnly(name: string): string {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}`;
}
function liCompanySearch(coClean: string): string {
  return `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(coClean)}`;
}
function googleEmailSearch(name: string, domain: string): string {
  return `https://www.google.com/search?q="${encodeURIComponent(name)}"+"%40${encodeURIComponent(domain)}"`;
}

// ── Route grade + confidence ─────────────────────────────────────────────────
interface RouteFields {
  contact_phone?: string | null;
  contact_email?: string | null;
  contact_page?: string | null;
  team_page?: string | null;
  about_page?: string | null;
  website?: string | null;
}

export function computeRouteGrade(lead: RouteFields, dms: ReadonlyArray<DecisionMaker>): RouteGrade {
  const tier1 = dms.some((d) => d.tier === 1);
  const anyPerson = dms.length > 0;
  const vEmail = dms.some((d) => d.email_verified && d.email);
  const gEmail = dms.some((d) => (d.email_guesses?.length ?? 0) > 0);
  const hasPhone = !!lead.contact_phone;
  const hasCPage = !!lead.contact_page;
  const hasCEmail = !!lead.contact_email;
  const hasWeb = !!lead.website;
  // A: Tier-1 person (MD/FD/PSC/owner) + verified contact route
  if (tier1 && (vEmail || hasPhone)) return "A";
  // B: Tier-1 person + guessable contact OR any named person + email route
  // Rationale: a named person with an email pattern beats a faceless company phone —
  // you can email them directly AND call and ask for them by name.
  if (tier1 && (gEmail || hasCPage || hasCEmail)) return "B";
  if (anyPerson && (vEmail || gEmail)) return "B";
  // C: Named person (any tier) + company contact route
  if (anyPerson && (hasPhone || hasCEmail || hasCPage)) return "C";
  if (hasPhone || hasCEmail) return "D";
  if (hasWeb || hasCPage) return "E";
  return "F";
}

export function computeContactConfidence(lead: RouteFields, dms: ReadonlyArray<DecisionMaker>): number {
  let score = 0;
  if (dms.length) {
    const bestTier = Math.min(...dms.map((d) => d.tier));
    score += bestTier === 1 ? 35 : bestTier === 2 ? 22 : 10;
  }
  if (dms.some((d) => d.email_verified && d.email)) score += 30;
  else if (dms.some((d) => (d.email_guesses?.length ?? 0) > 0)) score += 14;
  else if (lead.contact_email) score += 10;
  if (lead.contact_phone) score += 20;
  if (lead.contact_page) score += 6;
  if (lead.team_page || lead.about_page) score += 4;
  return Math.min(100, score);
}

// ── Build the decision_makers[] for one lead ─────────────────────────────────
interface LeadCtx {
  lead: Lead;
  domain: string;
  coClean: string;
  coShort: string;
  fetcher: CachedFetcher;
  smtp: SmtpVerifier | null;
  stop: StopFlag;
}

async function fetchPages(ctx: LeadCtx): Promise<string[]> {
  const website = ctx.lead.website;
  if (!website) return [];
  const pages = await discoverPages({
    homeUrl: website,
    relevant: (_url, path) => {
      if (path === "/" || path === "") return true;
      // Keep only paths that look like team / about / contact / careers / press / case-studies.
      return /\/(team|our-team|meet|people|management|leadership|directors|staff|about|who-we-are|story|history|company|founders|exec|press|news|careers|jobs|case-?stud|customers|clients|contact)/i.test(path);
    },
    fallbackSlugs: TEAM_SLUGS,
    prioritise: ["team", "leadership", "people", "about", "contact"],
    maxPages: MAX_PAGES,
    fetcher: stoppable(ctx.fetcher.fetch, ctx.stop),
    headOk: async (url, timeoutMs) => !ctx.stop.stopped && defaultHeadOk(url, timeoutMs),
  });
  return pages;
}

function buildDecisionMakers(
  officers: ChOfficer[],
  pscs: ChPsc[],
  websitePeople: ReturnType<typeof extractPeople>,
  ctx: LeadCtx,
): DecisionMaker[] {
  const dms: DecisionMaker[] = [];

  // 1) CH officers — sorted by tier (Tier 1 finance/MD first).
  const sortedOfficers = [...officers]
    .filter((o) => !o.resigned_on)
    .sort((a, b) => (classifyRole(a.officer_role ?? "")?.tier ?? 3) - (classifyRole(b.officer_role ?? "")?.tier ?? 3))
    .slice(0, MAX_OFFICERS);

  for (const o of sortedOfficers) {
    const parsed = parseChName(o.name ?? "");
    if (!parsed.full_name) continue;
    const cls = classifyRole(o.officer_role ?? "");
    dms.push({
      name: parsed.full_name,
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      role: o.officer_role ?? "",
      tier: cls?.tier ?? 3,
      tier_label: TIER_LABEL[cls?.tier ?? 3],
      appointed_on: o.appointed_on ?? null,
      email: null, email_source: null, email_verified: null, email_guesses: [],
      email_candidate: null, email_confidence: null,
      phone: null,
      linkedin_search: parsed.full_name ? liPersonSearch(parsed.full_name, ctx.coShort) : null,
      linkedin_name_only: parsed.full_name ? liPersonNameOnly(parsed.full_name) : null,
      google_email_search: ctx.domain && parsed.full_name ? googleEmailSearch(parsed.full_name, ctx.domain) : null,
      source: "companies_house",
    });
  }

  // 2) PSCs that aren't already in the list — owners often *are* the right call.
  for (const psc of pscs) {
    if (psc.ceased_on) continue;
    const name = (psc.name ?? "").trim();
    if (!name) continue;
    if (dms.some((d) => namesMatch(d.name, name))) continue;
    const parsed = parseChName(name);
    dms.push({
      name: parsed.full_name,
      first_name: parsed.first_name,
      last_name: parsed.last_name,
      role: "Person with Significant Control",
      tier: 1, tier_label: "Primary",
      appointed_on: psc.notified_on ?? null,
      email: null, email_source: null, email_verified: null, email_guesses: [],
      email_candidate: null, email_confidence: null,
      phone: null,
      linkedin_search: parsed.full_name ? liPersonSearch(parsed.full_name, ctx.coShort) : null,
      linkedin_name_only: parsed.full_name ? liPersonNameOnly(parsed.full_name) : null,
      google_email_search: ctx.domain && parsed.full_name ? googleEmailSearch(parsed.full_name, ctx.domain) : null,
      source: "companies_house",
    });
  }

  // 3) People discovered on the website. Merge into existing DMs where the name
  //    matches (Jim Smith on team page = James Smith from CH), otherwise add
  //    as Tier ≤ 2 (Tier 3 from a website is rarely worth surfacing).
  for (const p of websitePeople) {
    const existing = dms.find((d) => namesMatch(d.name, p.name));
    if (existing) {
      // Take the website's email if we don't have one.
      if (!existing.email && p.email) {
        existing.email = p.email;
        existing.email_source = "website_page";
        existing.email_verified = true;
      }
      // Take a stronger tier classification if the website's is more specific.
      if (p.tier < existing.tier) {
        existing.tier = p.tier;
        existing.tier_label = TIER_LABEL[p.tier];
        existing.role = p.role || existing.role;
      }
      existing.source = "ch+website";
      continue;
    }
    if (p.tier > 2) continue;        // skip generic "Director" with no CH backing
    if (!isPlausibleDmName(p.name)) continue;  // skip garbled scrape (e.g. "Sourcing Bettina")
    dms.push({
      name: p.name,
      first_name: p.first_name,
      last_name: p.last_name,
      role: p.role,
      tier: p.tier, tier_label: TIER_LABEL[p.tier],
      appointed_on: null,
      email: p.email,
      email_source: p.email ? "website_page" : null,
      email_verified: !!p.email,
      email_guesses: [],
      email_candidate: p.email || null,
      email_confidence: p.email ? "verified" : null,
      phone: null,
      linkedin_search: liPersonSearch(p.name, ctx.coShort),
      linkedin_name_only: liPersonNameOnly(p.name),
      google_email_search: ctx.domain ? googleEmailSearch(p.name, ctx.domain) : null,
      source: "website_only",
    });
  }

  dms.sort((a, b) => a.tier - b.tier);

  // Annotate each DM with dm_valid and dm_confidence so the dashboard and
  // generate-drafts stage can surface reliable names vs garbled scrapes.
  for (const dm of dms) {
    const src = dm.source as string;
    const isCh = src === "companies_house" || src === "ch+website";
    // CH-backed DMs are always valid (from the official register)
    const valid = isCh || isPlausibleDmName(dm.name);
    (dm as Record<string, unknown>).dm_valid = valid;
    (dm as Record<string, unknown>).dm_confidence = isCh ? "high" : (valid ? "medium" : "low");
  }

  return dms;
}

async function attachEmails(
  dms: DecisionMaker[],
  websitePeople: ReturnType<typeof extractPeople>,
  ctx: LeadCtx,
): Promise<void> {
  if (!ctx.domain) return;

  // Step 1: domain pattern inference — uses any named-person email we found.
  const knownEvidence = websitePeople
    .filter((p) => p.email)
    .map((p) => ({ email: p.email!, first: p.first_name, last: p.last_name }));
  const inferred = inferDomainEmailPattern(knownEvidence, ctx.domain);

  // Step 2: per-director — generate guesses, rank by domain pattern, try SMTP.
  for (const dm of dms) {
    if (!dm.first_name && !dm.last_name) continue;
    if (dm.email && dm.email_verified) continue;       // website-found email beats anything we generate

    const raw = generateEmailGuesses(dm.first_name, dm.last_name, ctx.domain);
    const ranked = rankEmailGuessesByPattern(raw, inferred);

    // Verify up to 3 patterns (most-likely first). Catch-all detection inside
    // the verifier prevents false positives.
    const verifiedGuesses: EmailGuess[] = [];
    let bestVerified: EmailGuess | null = null;
    for (const g of ranked.slice(0, 3)) {
      const result = ctx.smtp ? await ctx.smtp.verifyEmail(g.email) : { smtp_verified: null, catch_all: false } as { smtp_verified: boolean | null; catch_all: boolean };
      const eg: EmailGuess = {
        email: g.email, pattern: g.pattern,
        smtp_verified: result.smtp_verified,
        catch_all: result.catch_all,
        pattern_confidence: g.pattern_confidence,
      };
      verifiedGuesses.push(eg);
      if (eg.smtp_verified === true && !eg.catch_all && !bestVerified) bestVerified = eg;
    }
    // Pad with the remaining ranked guesses (no SMTP).
    for (const g of ranked.slice(3)) {
      verifiedGuesses.push({ email: g.email, pattern: g.pattern, smtp_verified: null, catch_all: false, pattern_confidence: g.pattern_confidence });
    }
    dm.email_guesses = verifiedGuesses;

    if (bestVerified) {
      dm.email = bestVerified.email;
      dm.email_source = "smtp_verified";
      dm.email_verified = true;
      // email_candidate mirrors the verified email
      (dm as Record<string, unknown>).email_candidate = bestVerified.email;
      (dm as Record<string, unknown>).email_confidence = "verified";
    } else if (!dm.email && inferred.pattern && verifiedGuesses[0]?.pattern === inferred.pattern && inferred.confidence >= 0.5) {
      // No SMTP confirmation, but the domain's prevailing pattern is strong —
      // surface the top-ranked guess on the DM record without claiming verified=true.
      dm.email = verifiedGuesses[0]!.email;
      dm.email_source = "pattern_inferred";
      dm.email_verified = false;
      (dm as Record<string, unknown>).email_candidate = verifiedGuesses[0]!.email;
      (dm as Record<string, unknown>).email_confidence = "pattern_based";
    } else if (verifiedGuesses[0]) {
      // Always surface the best guess as email_candidate even without confidence.
      // The dashboard labels this clearly as unverified. The user decides whether to use it.
      (dm as Record<string, unknown>).email_candidate = verifiedGuesses[0].email;
      (dm as Record<string, unknown>).email_confidence = "guessed";
    }
  }
}

/** Per-lead enrichment. */
async function enrichLead(
  lead: Lead,
  ch: ChClient,
  fetcher: CachedFetcher,
  smtp: SmtpVerifier | null,
  disableTech: boolean,
  stop: StopFlag = { stopped: false },
): Promise<void> {
  const ctx: LeadCtx = {
    lead,
    domain: bareDomain(lead.website),
    coClean: cleanCompanyName(lead.company_name),
    coShort: linkedinCompanyName(lead.company_name),
    fetcher,
    smtp,
    stop,
  };

  // Drop a legacy junk director_name (e.g. "Mobile Portrait", "Address Line",
  // "Tamil Nadu") from older pipeline runs before it gets re-used or back-filled.
  // CH-backed names are trusted by definition; only non-CH director_names need
  // re-validation against the current NOT_A_NAME_WORD list.
  if (!lead.company_number && lead.director_name && !isPlausibleDmName(lead.director_name)) {
    (lead as Record<string, unknown>).director_name = null;
    (lead as Record<string, unknown>).director_role = null;
  }

  // 1) CH officers + PSCs. If the lead has no CH number but does have a
  //    legacy director_name (from older pipeline runs / v1 data), synthesize a
  //    single officer record so the rest of the stage still has someone to
  //    enrich. This keeps the v2 shape consistent across old + new leads.
  let officers: ChOfficer[] = [];
  if (lead.company_number) {
    officers = await ch.officers(lead.company_number);
  } else if (lead.director_name) {
    officers = [{ name: lead.director_name, officer_role: lead.director_role || "director" }];
  }
  const pscs = lead.company_number && !stop.stopped ? await ch.psc(lead.company_number) : [];
  if (stop.stopped) return;   // given up on (timed out): leave the lead as it was

  // 1.5) No-website fallback. If we have no website but a clean company name +
  //      address, try to find a real domain by HEAD-probing common patterns,
  //      and surface a switchboard area + town for the LinkedIn route.
  let noWebsite: ReturnType<typeof buildNoWebsiteHints> | null = null;
  if (!lead.website && ctx.coClean) {
    noWebsite = buildNoWebsiteHints({ companyNameClean: ctx.coClean, address: lead.address ?? "" });
    for (const url of noWebsite.candidate_domains) {
      if (stop.stopped) return;
      if (await defaultHeadOk(url)) { (lead as Record<string, unknown>).website = url; ctx.domain = bareDomain(url); break; }
    }
  }

  // 2) Pages to crawl
  const pages = await fetchPages(ctx);
  const websitePeople: ReturnType<typeof extractPeople> = [];
  const techSignals = new Map<string, string>();
  let homepageHtml = "";

  for (const url of pages) {
    if (stop.stopped) return;
    const got = await fetcher.fetch(url);
    if (!got) continue;
    if (!homepageHtml && url === lead.website) homepageHtml = got.html;
    for (const p of extractPeople(got.html, ctx.domain)) {
      if (!websitePeople.some((x) => namesMatch(x.name, p.name))) websitePeople.push(p);
      else {
        // Merge new email into existing entry.
        const existing = websitePeople.find((x) => namesMatch(x.name, p.name))!;
        if (!existing.email && p.email) existing.email = p.email;
      }
    }
  }

  if (stop.stopped) return;
  // 3) Build DMs
  const dms = buildDecisionMakers(officers, pscs, websitePeople, ctx);

  // 4) Attach emails (guess → rank → SMTP)
  await attachEmails(dms, websitePeople, ctx);
  if (stop.stopped) return;

  // 5) Tech-stack signals from homepage HTML (cheap; only over what we already fetched).
  if (!disableTech && homepageHtml) {
    for (const s of detectTechStack(homepageHtml)) techSignals.set(s.label, s.evidence);
  }

  // 5.5) If still no website found, swap each DM's LinkedIn search for a
  //      town-qualified version (better signal for common-name people).
  if (noWebsite && !lead.website && noWebsite.town) {
    for (const dm of dms) {
      if (dm.name) (dm as Record<string, unknown>).linkedin_search = linkedinSearchForTown(dm.name, noWebsite.town);
    }
  }

  // 6) Write back onto the lead.
  const leadAny = lead as Record<string, unknown>;
  leadAny.decision_makers = dms;
  leadAny.company_name_clean = ctx.coClean;
  leadAny.company_linkedin = ctx.coClean ? liCompanySearch(ctx.coClean) : null;
  leadAny.route_grade = computeRouteGrade(lead, dms);
  leadAny.contact_confidence = computeContactConfidence(lead, dms);
  leadAny.dm_enriched_at = new Date().toISOString(); // tracks last enrichment; used to skip re-runs within 7 days
  if (techSignals.size) leadAny.tech_signals = Array.from(techSignals.keys());
  if (noWebsite?.switchboard_prefix && !lead.contact_phone) {
    leadAny.switchboard_hint = `Likely UK switchboard prefix: ${noWebsite.switchboard_prefix} (from ${lead.address ?? "registered address"})`;
  }

  // Back-fill top-level director_name / contact_email from best DM.
  const best = dms[0];
  if (best) {
    if (!lead.director_name) { leadAny.director_name = best.name; leadAny.director_role = best.role; }
    if (best.email && !lead.contact_email) leadAny.contact_email = best.email;
  }
}

// ── Stage entry ──────────────────────────────────────────────────────────────
export async function runEnrichDecisionMakersStage(opts: EnrichDmOptions = {}): Promise<EnrichDmResult> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const outPath = opts.outPath ?? resolve(root, "data/leads.json");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const concurrency = opts.concurrency ?? 4;
  const max = opts.max ?? 300;
  const force = !!opts.force;
  const disableTech = !!opts.disableTech;
  const persist = opts.persist ?? true;
  // Leaves time before the pipeline's end (FX_PIPELINE_DEADLINE) for website intel, CH accounts, the lead it
  // may still be finishing, and score / dedup / export.
  const intelBudgetMin = Number(process.env.FX_INTEL_BUDGET_MIN ?? "15");
  const accountsBudgetMin = Number(process.env.FX_ACCOUNTS_BUDGET_MIN ?? "4");
  const deadline = stageDeadline(opts.budgetMinutes ?? DEFAULT_BUDGET_MIN, intelBudgetMin + accountsBudgetMin + 6);
  const leadTimeoutMs = (opts.leadTimeoutSeconds ?? DEFAULT_LEAD_TIMEOUT_S) * 1000;

  const { db, sqlite, close } = getDb(dbPath);
  const rec = new RunRecorder("enrich-decision-makers", { dbPath, outPath, concurrency, max, force });
  const ch = new ChClient({ cachePath: opts.chCachePath });
  const fetcher = createCachedFetcher({ cachePath: opts.pageCachePath });
  const smtp = createSmtpVerifier({
    cachePath: opts.smtpCachePath,
    disableSmtp: opts.disableSmtp,
  });

  try {
    const leads: Record<string, Lead> = {};
    for (const row of db.select().from(schema.leads).all()) {
      const p = LeadSchema.safeParse(row.data);
      leads[row.id] = p.success ? p.data : (row.data as Lead);
    }

    const needsEnrichment = (l: Lead): boolean => {
      if (force) return true;
      // Skip leads already enriched with a usable contact route (A–E)
      if ((l.decision_makers?.length ?? 0) > 0 && l.route_grade && l.route_grade !== "F") return false;
      // Skip leads enriched within the last 7 days even if route_grade=F —
      // re-running won't find new contacts and just wastes time on the growing pool.
      const enrichedAt = (l as Record<string, unknown>).dm_enriched_at as string | undefined;
      if (enrichedAt) {
        const ageDays = (Date.now() - new Date(enrichedAt).getTime()) / 86_400_000;
        if (ageDays < 7) return false;
      }
      return !!(l.company_number || l.director_name || l.website);
    };
    const candidates = Object.values(leads).filter(needsEnrichment).slice(0, max);

    const persistAll = (): void => {
      if (!persist) return;
      const upd = sqlite.prepare(`UPDATE leads SET data=@data WHERE id=@id`);
      const tx = sqlite.transaction(() => { for (const l of Object.values(leads)) upd.run({ id: l.id, data: JSON.stringify(l) }); });
      tx();
      ch.flush();
      fetcher.flush();
      smtp.flush();
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(leads, null, 2));
    };

    const limit = pLimit(concurrency);
    let enriched = 0, timedOut = 0, leftForNextRun = 0;
    for (let i = 0; i < candidates.length; i += ENRICH_BATCH_SIZE) {
      const batch = candidates.slice(i, i + ENRICH_BATCH_SIZE);
      await Promise.all(batch.map((l) => limit(async () => {
        if (Date.now() >= deadline) { leftForNextRun++; return; }
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), leadTimeoutMs); });
        try {
          const stop: StopFlag = { stopped: false };
          const outcome = await Promise.race([enrichLead(l, ch, fetcher, smtp, disableTech, stop), timeout]);
          if (outcome === "timeout") {
            stop.stopped = true;   // its unfinished work stops at the next step instead of running on
            timedOut++;
            (l as Record<string, unknown>).dm_enriched_at = new Date().toISOString();
            console.warn(`enrich-dm: gave up on ${l.company_name ?? l.id} after ${leadTimeoutMs / 1000}s (${bareDomain(l.website) || "no website"})`);
          } else enriched++;
        }
        catch (e) { rec.warn(`enrich-dm failed for ${l.id}: ${String(e)}`); }
        finally { clearTimeout(timer); }
      })));
      // Checkpoint after every batch — see ENRICH_BATCH_SIZE's comment above
      // for why this (not just the final write) is the point of batching.
      persistAll();
      console.log(`enrich-dm: checkpointed ${Math.min(i + ENRICH_BATCH_SIZE, candidates.length)}/${candidates.length}`);
      if (Date.now() >= deadline) {
        leftForNextRun += candidates.length - Math.min(i + ENRICH_BATCH_SIZE, candidates.length);
        console.log(`enrich-dm: time budget used — ${leftForNextRun} leads left for the next run`);
        break;
      }
    }

    const grades: Record<RouteGrade, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
    let multiDm = 0, verifiedAny = 0;
    for (const l of Object.values(leads)) {
      const g = (l.route_grade as RouteGrade | undefined) ?? "F";
      grades[g] = (grades[g] ?? 0) + 1;
      if ((l.decision_makers?.length ?? 0) > 1) multiDm++;
      if (l.decision_makers?.some((d) => d.email_verified && d.email)) verifiedAny++;
    }

    rec.section("contact_coverage", {
      total_leads: Object.keys(leads).length, to_process: candidates.length,
      enriched, timed_out: timedOut, left_for_next_run: leftForNextRun,
      multi_dm_leads: multiDm, verified_any: verifiedAny,
      grade_a: grades.A, grade_b: grades.B, grade_c: grades.C,
      grade_d: grades.D, grade_e: grades.E, grade_f: grades.F,
      smtp_stats: smtp.stats(),
      fetcher_stats: fetcher.stats(),
    });
    if (persist) rec.finish(sqlite, runsDir);

    return {
      totalLeads: Object.keys(leads).length, toProcess: candidates.length,
      enriched, leftForNextRun, timedOut, multiDmLeads: multiDm, verifiedAny,
      routeGrades: grades, runId: rec.run.run_id,
    };
  } finally {
    close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): EnrichDmOptions {
  const o: EnrichDmOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--out") o.outPath = argv[++i];
    else if (a === "--runs") o.runsDir = argv[++i];
    else if (a === "--page-cache") o.pageCachePath = argv[++i];
    else if (a === "--ch-cache") o.chCachePath = argv[++i];
    else if (a === "--smtp-cache") o.smtpCachePath = argv[++i];
    else if (a === "--limit") o.concurrency = Number(argv[++i]);
    else if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--budget-min") o.budgetMinutes = Number(argv[++i]);
    else if (a === "--force") o.force = true;
    else if (a === "--no-smtp") o.disableSmtp = true;
    else if (a === "--no-tech") o.disableTech = true;
  }
  return o;
}
const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  runEnrichDecisionMakersStage(parseArgs(process.argv.slice(2))).then((r) => {
    console.log(`enrich-decision-makers: ${r.totalLeads} leads | due ${r.toProcess} | enriched ${r.enriched} | gave up ${r.timedOut} | left for next run ${r.leftForNextRun} | multi-DM ${r.multiDmLeads} | verified-email ${r.verifiedAny}`);
    console.log(`  grades: A=${r.routeGrades.A} B=${r.routeGrades.B} C=${r.routeGrades.C} D=${r.routeGrades.D} E=${r.routeGrades.E} F=${r.routeGrades.F}`);
    console.log(`  run_id ${r.runId}`);
    // Everything is saved by now; exit even if a lead we gave up on still has a
    // request open, so it can't hold the pipeline step past its cap.
    process.exit(0);
  }).catch((e) => { console.error("enrich-decision-makers failed:", e); process.exit(1); });
}
