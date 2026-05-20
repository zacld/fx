/**
 * stages/discover.ts — the "discover" pipeline stage (Brain 3). v2 equivalent of
 * scripts/discover_web.py + discover.py (the search/validate/create-lead parts —
 * NOT scoring, which stays in the `score` stage).
 *
 * For each ready event → each target segment (filtered by category_priority_score
 * if present) → each micro-category → each search query:
 *   DuckDuckGo  → (empty/blocked) Bing  → (still nothing) Companies-House keyword
 *   for each result: domain↔name coherence check; mine source/directory pages for
 *     outbound company links (gated); fetch + validate each candidate website
 *     (p-limit concurrency); Companies-House validate; build a `leads` row + a
 *     `lead_evidence` row (provisional score — the `score` stage re-scores).
 * Then records a `runs` row. Writes only to the DB — the `score` and `dedup`
 * stages re-score the new leads and export data/leads.json afterwards.
 *
 * Live HTTP — not a broad crawl by default: capped via WEB_MAX_EVENTS /
 * WEB_MAX_SEGMENTS_PER_EVENT / WEB_MAX_MICRO_CATEGORIES_PER_SEGMENT /
 * WEB_MAX_QUERIES_PER_MICRO_CATEGORY / WEB_MAX_RESULTS_PER_QUERY and the CH call
 * budget. WEB_DISCOVERY_ENABLED=false skips it entirely.
 *
 * CLI: tsx src/stages/discover.ts [--db ...] [--runs ...] [--limit N] [--max-events N]
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";

import { LeadSchema, scoreLead, repoRoot, type Lead, type Segment } from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";
import { ddgSearch, bingSearch } from "../sources/search.js";
import { validateWebsite } from "../sources/website.js";
import { mineSourcePage } from "../sources/source-page-miner.js";
import { domainFromUrl, domainCoherentWithName, nameTokens } from "../sources/blocklists.js";
import { ChClient, coreKeyword, extractDirector } from "../sources/companies-house.js";
import { fetchHtml as defaultFetchHtml, type HtmlFetcher } from "../sources/fetch.js";

const SOURCE_PAGE_PATH = /(^|[/\-_])(members?|member-directory|directory|suppliers?|supplier-list|find-a-supplier|find-a-member|our-members|membership|business-directory|trade-directory|exporters?|importers?|manufacturers?)([/\-_]|$)/i;

const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };
const flag = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

export interface DiscoverOptions {
  dbPath?: string; runsDir?: string;
  maxEvents?: number; maxSegments?: number; maxMicroCats?: number;
  maxQueriesPerMicroCat?: number; maxQueriesPerSegment?: number; maxResultsPerQuery?: number;
  minScoreToScrape?: number; sourcePageMining?: boolean; concurrency?: number;
  enabled?: boolean;
  fetchHtml?: HtmlFetcher; chClient?: ChClient;
  persist?: boolean;
}

export interface DiscoverResult {
  events: number; queriesRun: number;
  ddgOk: number; ddgEmpty: number; bingOk: number; bingEmpty: number; chFallbackUsed: number;
  sourcePagesMined: number; sourcePageLinks: number;
  candidates: number; rejectedIncoherent: number; rejectedValidation: number; rejectedNoSignals: number; rejectedNegatives: number; rejectedDuplicate: number;
  leadsAdded: number; byPriority: Record<string, number>; runId: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function buildLead(args: {
  url: string | null; domain: string; title: string;
  validation: ReturnType<typeof validateWebsite> | null;
  chData: Awaited<ReturnType<ChClient["validate"]>> | { company_number: string; company_status: string; sic_codes: string[]; incorporated: string; registered_address: string; director_name: string | null; director_role: string | null } | null;
  segment: Segment; eventId: string; event: { headline?: string; urgency_score?: number; event_breadth?: string; business_impact_summary?: string };
  websiteSource: string; discoveryPath: string; sourceQuery: string; microCategory: string; sourcePageUrl?: string;
}): Lead {
  const { url, domain, title, validation, chData, segment, eventId, event } = args;
  const companyName = chData?.company_number ? (("company_name" in chData ? (chData as { company_name?: string }).company_name : undefined) ?? title) : (title || domain);
  const id = sha(`${domain || (chData?.company_number ?? title)}:${eventId}`);
  const v = validation;
  const raw: Record<string, unknown> = {
    id, event_id: eventId, created_at: new Date().toISOString(),
    company_name: companyName, company_number: chData?.company_number ?? null,
    company_status: chData?.company_status ?? "unknown",
    sic_codes: chData?.sic_codes ?? [], incorporated: chData?.incorporated ?? null,
    address: chData?.registered_address ?? "", director_name: chData?.director_name ?? null, director_role: chData?.director_role ?? null,
    website: url, website_domain: domain, website_confidence: v?.website_confidence ?? null,
    website_source: args.websiteSource, discovery_path: args.discoveryPath,
    source_query: args.sourceQuery, source_segment: segment.segment_name, source_micro_category: args.microCategory,
    ...(args.sourcePageUrl ? { source_page_url: args.sourcePageUrl } : {}),
    website_snippet: v?.snippet ?? "",
    fx_payment_signals: v?.fx_payment_signals ?? [], fx_origin_hints: v?.fx_origin_hints ?? [],
    b2b_signals: v?.b2b_signals ?? [], secondary_signals: v?.secondary_signals ?? [], negative_signals: v?.negative_signals ?? [],
    segment_signals: v?.segment_signals ?? [], pays_fx_confirmed: v?.pays_fx ?? false,
    contact_phone: v?.contact_phone ?? null, contact_phones: v?.contact_phones ?? [], contact_email: v?.contact_email ?? null,
    contact_emails_found: v?.contact_emails_found ?? [], contact_page: v?.contact_page ?? null, about_page: v?.about_page ?? null, team_page: v?.team_page ?? null,
    company_source: args.discoveryPath === "ch_fallback" || args.discoveryPath === "ch_keyword" ? "companies_house" : "web_search",
    segment_name: segment.segment_name, segment_business_model: segment.business_model ?? "",
    exposure_level: segment.exposure_level || "", exposure_type: segment.exposure_type ?? "",
    why_affected: segment.why_affected ?? "", why_financially_exposed: segment.why_financially_exposed ?? "",
    margin_risk: segment.margin_risk ?? "", payment_timing_risk: segment.payment_timing_risk ?? "",
    affected_payment_flow: segment.affected_payment_flow ?? "",
    fx_payment_logic: segment.fx_payment_logic ?? "", sales_angle: segment.sales_angle ?? "",
    exposure_thesis: (segment.exposure_thesis_template || "").replace(/This (company|business)/i, companyName),
    why_affected_from_segment: segment.why_affected ?? "",
    trigger_headline: event.headline ?? "", event_type: "", business_impact_summary: event.business_impact_summary ?? "",
    fx_exposure: (segment.likely_currency_pairs ?? []).join(", "),
    linked_event_ids: [eventId], multi_event_trigger: false, multi_event_count: 1,
    score: 0, priority: "QUEUE", scoring_reasons: [], status: "new",
  };
  // make why_affected non-thin where possible (the scoring Gate H wants ≥40 chars on why_affected OR exposure_thesis)
  if (((raw.why_affected as string) || "").length < 40) raw.why_affected = segment.why_financially_exposed || segment.why_affected || (raw.exposure_thesis as string) || "";
  const parsed = LeadSchema.safeParse(raw);
  return parsed.success ? parsed.data : (raw as unknown as Lead);
}

export async function runDiscoverStage(opts: DiscoverOptions = {}): Promise<DiscoverResult> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const enabled = opts.enabled ?? flag(process.env.WEB_DISCOVERY_ENABLED, true);
  const maxEvents = opts.maxEvents ?? n(process.env.WEB_MAX_EVENTS, 5);
  const maxSegments = opts.maxSegments ?? n(process.env.WEB_MAX_SEGMENTS_PER_EVENT, 10);
  const maxMicroCats = opts.maxMicroCats ?? n(process.env.WEB_MAX_MICRO_CATEGORIES_PER_SEGMENT, 3);
  const maxQPerMc = opts.maxQueriesPerMicroCat ?? n(process.env.WEB_MAX_QUERIES_PER_MICRO_CATEGORY, 2);
  const maxQPerSeg = opts.maxQueriesPerSegment ?? n(process.env.WEB_MAX_QUERIES_PER_SEGMENT, 5);
  const maxResults = opts.maxResultsPerQuery ?? n(process.env.WEB_MAX_RESULTS_PER_QUERY, 5);
  const minScore = opts.minScoreToScrape ?? n(process.env.CATEGORY_MIN_SCORE_TO_SCRAPE, 0);
  const sourcePageMining = opts.sourcePageMining ?? flag(process.env.SOURCE_PAGE_MINING_ENABLED, true);
  const concurrency = opts.concurrency ?? n(process.env.WEB_DISCOVER_CONCURRENCY, 6);
  const persist = opts.persist ?? true;
  const fetcher = opts.fetchHtml ?? defaultFetchHtml;
  const ch = opts.chClient ?? new ChClient();

  const { db, sqlite, close } = getDb(dbPath);
  const rec = new RunRecorder("discover", { dbPath, maxEvents, maxSegments, sourcePageMining });
  const st: DiscoverResult = {
    events: 0, queriesRun: 0, ddgOk: 0, ddgEmpty: 0, bingOk: 0, bingEmpty: 0, chFallbackUsed: 0,
    sourcePagesMined: 0, sourcePageLinks: 0, candidates: 0, rejectedIncoherent: 0, rejectedValidation: 0,
    rejectedNoSignals: 0, rejectedNegatives: 0, rejectedDuplicate: 0, leadsAdded: 0,
    byPriority: { HOT: 0, WARM: 0, QUEUE: 0, SKIP: 0 }, runId: rec.run.run_id,
  };

  if (!enabled) { console.warn("Web discovery disabled (WEB_DISCOVERY_ENABLED=false) — skipping."); if (persist) rec.finish(sqlite, runsDir); close(); return st; }

  const upsertLead = sqlite.prepare(`INSERT OR REPLACE INTO leads
    (id, event_id, company_number, company_name, company_status, website, website_domain, website_source, website_confidence,
     priority, score, exposure_level, exposure_confidence, lead_type, segment_name, is_large_org, rescored_at, data)
    VALUES (@id,@event_id,@company_number,@company_name,@company_status,@website,@website_domain,@website_source,@website_confidence,
     @priority,@score,@exposure_level,@exposure_confidence,@lead_type,@segment_name,@is_large_org,@rescored_at,@data)`);
  const upsertEvidence = sqlite.prepare(`INSERT OR REPLACE INTO lead_evidence
    (id, lead_id, company_number, event_id, website_source, discovery_path, source_query, source_segment, source_micro_category, source_page_url)
    VALUES (@id,@lead_id,@company_number,@event_id,@website_source,@discovery_path,@source_query,@source_segment,@source_micro_category,@source_page_url)`);
  const updEvent = sqlite.prepare(`UPDATE events SET status=@status, data=@data WHERE id=@id`);

  const seenDomains = new Set<string>();
  function persistLead(lead: Lead, ev: { urgency_score?: number }, evidence: { website_source: string; discovery_path: string; source_query: string; source_segment: string; source_micro_category: string; source_page_url?: string }): void {
    const { score, priority, reasons } = scoreLead(lead, ev.urgency_score ?? 0);
    lead.score = score; lead.priority = priority; lead.scoring_reasons = reasons; lead.rescored_at = new Date().toISOString();
    if (persist) {
      upsertLead.run({
        id: lead.id, event_id: lead.event_id, company_number: lead.company_number ?? null, company_name: lead.company_name,
        company_status: lead.company_status ?? null, website: lead.website ?? null, website_domain: lead.website_domain ?? "",
        website_source: (lead.website_source as string | null) ?? null, website_confidence: (lead.website_confidence as string | null) ?? null,
        priority: lead.priority, score: lead.score, exposure_level: lead.exposure_level || "", exposure_confidence: lead.exposure_confidence ?? "none",
        lead_type: lead.lead_type ?? "unknown", segment_name: lead.segment_name ?? "", is_large_org: lead.is_large_org ? 1 : 0,
        rescored_at: lead.rescored_at ?? null, data: JSON.stringify(lead),
      });
      upsertEvidence.run({
        id: sha(`${lead.id}|${evidence.website_source}|${evidence.source_query}|${lead.event_id}`),
        lead_id: lead.id, company_number: lead.company_number ?? null, event_id: lead.event_id,
        website_source: evidence.website_source, discovery_path: evidence.discovery_path, source_query: evidence.source_query,
        source_segment: evidence.source_segment, source_micro_category: evidence.source_micro_category, source_page_url: evidence.source_page_url ?? null,
      });
    }
    st.leadsAdded++; st.byPriority[priority] = (st.byPriority[priority] ?? 0) + 1;
  }

  try {
    const allEvents = db.select().from(schema.events).all();
    const ready = allEvents.filter((e) => (e.status === "ready") && !(e.data && (e.data as { web_discovery_done?: boolean }).web_discovery_done)).slice(0, maxEvents);
    st.events = ready.length;

    for (const row of ready) {
      const event = row.data;
      // Brain 1 tiered trigger: "limited" mode scales segments / queries / results
      // down so weaker triggers burn less budget; "context_only" / "reject" skip
      // discovery entirely (analyse.ts already routes those to non-ready status,
      // but we belt-and-brace here in case persisted JSON disagrees).
      const mode = (event as { discovery_mode?: string }).discovery_mode || "full";
      if (mode === "reject") {
        const ed = { ...event, web_discovery_done: true, web_discovery_at: new Date().toISOString(), web_discovery_skipped: mode };
        if (persist) updEvent.run({ id: row.id, status: "low_relevance", data: JSON.stringify(ed) });
        continue;
      }
      // context_only (weak trigger) → minimal scrape: 1 segment, 1 micro-cat, 2 queries, 4 results
      // This ensures every event surfaces at least some fresh candidates rather than returning nothing.
      const scale = mode === "limited" ? 0.5 : mode === "context_only" ? 0.25 : 1;
      const effMaxSegments = mode === "context_only" ? 1 : Math.max(1, Math.round(maxSegments * scale));
      const effMaxQPerMc   = mode === "context_only" ? 1 : Math.max(1, Math.round(maxQPerMc * scale));
      const effMaxQPerSeg  = mode === "context_only" ? 2 : Math.max(1, Math.round(maxQPerSeg * scale));
      const effMaxResults  = mode === "context_only" ? 4 : Math.max(2, Math.round(maxResults * (mode === "limited" ? 0.6 : 1)));
      const budgetCap = Number((event as { recommended_query_budget?: number }).recommended_query_budget ?? 0);

      const segments = (event.target_segments ?? [])
        .filter((s) => (s.category_priority_score == null) || (s.category_priority_score >= minScore))
        .slice(0, effMaxSegments);

      let queriesUsed = 0;
      const budgetExceeded = () => budgetCap > 0 && queriesUsed >= budgetCap;

      for (const seg of segments) {
        if (budgetExceeded()) break;
        const segSignals = (seg.website_validation_signals?.length ? seg.website_validation_signals : seg.segment_signals) ?? [];
        // build (microCategory, query) pairs
        const pairs: Array<{ mc: string; q: string }> = [];
        const mcs = (seg.micro_categories ?? []).slice(0, maxMicroCats);
        if (mcs.length) {
          for (const mc of mcs) for (const q of (mc.search_queries ?? []).slice(0, effMaxQPerMc)) pairs.push({ mc: mc.name ?? "", q });
        } else {
          for (const q of (seg.high_intent_search_queries ?? []).slice(0, effMaxQPerSeg)) pairs.push({ mc: "", q });
        }

        for (const { mc, q } of pairs) {
          if (!q) continue;
          if (budgetExceeded()) break;
          st.queriesRun++; queriesUsed++;
          // ── search: DDG → Bing → CH keyword ──────────────────────────────
          let results: Array<{ url: string; title: string }>; let path: "ddg" | "bing" | "ch_keyword";
          const ddg = await ddgSearch(q, effMaxResults, fetcher);
          if (ddg.results.length) { results = ddg.results; path = "ddg"; st.ddgOk++; }
          else {
            if (ddg.stats.status !== "ok") { /* blocked/empty */ } else st.ddgEmpty++;
            const bing = await bingSearch(q, effMaxResults, fetcher);
            if (bing.results.length) { results = bing.results; path = "bing"; st.bingOk++; }
            else {
              st.bingEmpty++;
              const chItems = ch.enabled ? await ch.search(coreKeyword(q), effMaxResults) : [];
              if (chItems.length) { st.chFallbackUsed++; }
              results = []; path = "ch_keyword";
              // CH-fallback items: no URL — create CN-only leads (the score stage will mostly SKIP them)
              await Promise.all(chItems.slice(0, effMaxResults).map((it) => limitFor(concurrency)(async () => {
                if (!it.company_number || (it.company_status && it.company_status.toLowerCase() !== "active")) return;
                const profile = await ch.profile(it.company_number);
                const officers = await ch.officers(it.company_number);
                const dir = extractDirector(officers);
                st.candidates++;
                const lead = buildLead({
                  url: null, domain: "", title: it.title || "", validation: null,
                  chData: { company_number: it.company_number, company_status: (profile?.company_status || "").toLowerCase(), sic_codes: (profile?.sic_codes ?? []).map(String), incorporated: profile?.date_of_creation || "", registered_address: [profile?.registered_office_address?.["address_line_1"], profile?.registered_office_address?.["locality"], profile?.registered_office_address?.["postal_code"]].filter(Boolean).join(", "), director_name: dir?.name ?? null, director_role: dir?.role ?? null },
                  segment: seg, eventId: row.id, event, websiteSource: "ch_keyword", discoveryPath: "ch_fallback", sourceQuery: q, microCategory: mc,
                });
                persistLead(lead, event, { website_source: "ch_keyword", discovery_path: "ch_fallback", source_query: q, source_segment: seg.segment_name, source_micro_category: mc });
              })));
              continue;   // done with this query (CH fallback handled)
            }
          }

          // ── split into direct candidates + mineable source pages ─────────
          const direct: Array<{ url: string; title: string }> = [];
          const minePages: Array<{ url: string }> = [];
          for (const r of results) {
            if (sourcePageMining && SOURCE_PAGE_PATH.test((() => { try { return new URL(r.url).pathname; } catch { return r.url; } })())) minePages.push({ url: r.url });
            else direct.push({ url: r.url, title: r.title });
          }
          // mine source pages (only if we're short on direct candidates)
          const candidates: Array<{ url: string; title: string; websiteSource: string; discoveryPath: string; sourcePageUrl?: string }> =
            direct.map((d) => ({ ...d, websiteSource: path, discoveryPath: path }));
          if (direct.length < 3) {
            for (const mp of minePages.slice(0, n(process.env.SOURCE_PAGE_MAX_PAGES_PER_QUERY, 2))) {
              const got = await fetcher(mp.url);
              if (!got) continue;
              st.sourcePagesMined++;
              const mined = mineSourcePage(got.html, got.finalUrl, { query: q, segment: seg.segment_name, microCategory: mc, maxLinks: n(process.env.SOURCE_PAGE_MAX_LINKS_PER_PAGE, 15) });
              st.sourcePageLinks += mined.length;
              for (const m of mined) candidates.push({ url: m.candidate_url, title: m.candidate_name || domainFromUrl(m.candidate_url) || "", websiteSource: "source_page", discoveryPath: "source_page_mined", sourcePageUrl: m.source_page_url });
            }
          }

          // ── validate each candidate (concurrent) ────────────────────────
          await Promise.all(candidates.map((c) => limitFor(concurrency)(async () => {
            const dom = domainFromUrl(c.url);
            if (!dom) return;
            if (seenDomains.has(dom)) { st.rejectedDuplicate++; return; }
            seenDomains.add(dom);
            if (!domainCoherentWithName(dom, c.title)) { st.rejectedIncoherent++; return; }
            st.candidates++;
            const got = await fetcher(c.url);
            const validation = got ? validateWebsite(got.html, got.finalUrl, nameTokens(c.title), segSignals) : null;
            if (!validation || validation.reject_reason) { st.rejectedValidation++; return; }
            const neg = validation.negative_signals.length, fx = validation.fx_payment_signals.length, b2b = validation.b2b_signals.length;
            if (neg > Math.max(fx, b2b)) { st.rejectedNegatives++; return; }
            if (fx === 0 && b2b === 0 && validation.secondary_signals.length < 2) { st.rejectedNoSignals++; return; }
            const chData = (validation.website_confidence === "high" || validation.website_confidence === "medium") && ch.enabled ? await ch.validate(c.title) : null;
            const lead = buildLead({ url: got!.finalUrl, domain: dom, title: c.title, validation, chData, segment: seg, eventId: row.id, event, websiteSource: c.websiteSource, discoveryPath: c.discoveryPath, sourceQuery: q, microCategory: mc, sourcePageUrl: c.sourcePageUrl });
            persistLead(lead, event, { website_source: c.websiteSource, discovery_path: c.discoveryPath, source_query: q, source_segment: seg.segment_name, source_micro_category: mc, source_page_url: c.sourcePageUrl });
          })));
        }
      }

      // mark event done
      const ed = { ...event, web_discovery_done: true, web_discovery_at: new Date().toISOString() };
      if (persist) updEvent.run({ id: row.id, status: "discovered", data: JSON.stringify(ed) });
    }
  } finally {
    ch.flush();
    rec.section("source_stats", st as unknown as Record<string, unknown>);
    if (persist) rec.finish(sqlite, runsDir);
    close();
  }
  return st;
}

// a per-call p-limit factory cache (one limiter shared per concurrency value)
const _limiters = new Map<number, ReturnType<typeof pLimit>>();
function limitFor(c: number): ReturnType<typeof pLimit> {
  let l = _limiters.get(c);
  if (!l) { l = pLimit(c); _limiters.set(c, l); }
  return l;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): DiscoverOptions {
  const o: DiscoverOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--runs") o.runsDir = argv[++i];
    else if (a === "--limit") o.concurrency = Number(argv[++i]);
    else if (a === "--max-events") o.maxEvents = Number(argv[++i]);
    else if (a === "--no-source-pages") o.sourcePageMining = false;
  }
  return o;
}
const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  runDiscoverStage(parseArgs(process.argv.slice(2))).then((r) => {
    console.log(`discover: ${r.events} events | ${r.queriesRun} queries (ddg ok ${r.ddgOk}, bing ok ${r.bingOk}, ch-fallback ${r.chFallbackUsed}) | source pages mined ${r.sourcePagesMined} (+${r.sourcePageLinks} links) | candidates ${r.candidates} | leads added ${r.leadsAdded} ${JSON.stringify(r.byPriority)}`);
    console.log(`  rejected — incoherent ${r.rejectedIncoherent}, validation ${r.rejectedValidation}, no-signals ${r.rejectedNoSignals}, negatives ${r.rejectedNegatives}, duplicate ${r.rejectedDuplicate}`);
    console.log(`  run_id ${r.runId}`);
  }).catch((e) => { console.error("discover failed:", e); process.exitCode = 1; });
}
