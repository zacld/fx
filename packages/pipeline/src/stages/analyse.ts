/**
 * stages/analyse.ts — the "analyse" pipeline stage (Brain 1 + Brain 2). v2
 * equivalent of scripts/ingest.py: RSS feeds → rule-based commercial-relevance
 * pre-filter → ONE LLM call per new event (triage + exposure map, prompt
 * verbatim in sources/ai.ts; provider = Groq by default) → write `events` rows. On a 429 / any AI failure
 * it falls back to a rule-based event (buildFallbackEvent) so discover can still
 * run. Records a `runs` row.
 *
 * CLI: tsx src/stages/analyse.ts [--db ...] [--runs ...] [--max-events N]
 *   env: DISCOVERY_MAX_EVENTS, DISCOVERY_MIN_RELEVANCE, AI_PROVIDER, GROQ_API_KEY/GROQ_MODEL (or GEMINI_API_KEY/GEMINI_MODEL)
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repoRoot } from "@fx/core";
import { getDb, schema } from "@fx/core/db";
import { RunRecorder } from "../run.js";
import { fetchHtml as defaultFetchHtml, type HtmlFetcher } from "../sources/fetch.js";
import { RSS_FEEDS, type RssFeed, parseFeed, scoreCommercialRelevance, ENTRY_KEYWORDS, dedupeId } from "../sources/rss.js";
import { analyseEvent, RateLimitError, resolveProviderModel, type AiProvider, type AnalyseFn } from "../sources/ai.js";

const nowIso = () => new Date().toISOString();

interface RawItem { id: string; source: string; source_url: string; headline: string; raw_summary: string; pre_relevance_score: number; pre_relevance_reason: string; }

// ── helpers ──────────────────────────────────────────────────────────────────
type Seg = Record<string, unknown> & { segment_name?: string; website_validation_signals?: string[]; segment_signals?: string[]; micro_categories?: Array<Record<string, unknown> & { search_queries?: string[]; companies_house_terms?: string[] }>; companies_house_terms?: string[]; high_intent_search_queries?: string[] };

function normaliseSegments(segments: Seg[]): Seg[] {
  for (const s of segments ?? []) {
    const sigs = s.website_validation_signals ?? s.segment_signals ?? [];
    s.website_validation_signals = sigs;
    s.segment_signals = sigs;
  }
  return segments ?? [];
}
function extractChTerms(segments: Seg[]): { chTerms: string[]; queries: string[] } {
  const chTerms: string[] = [], queries: string[] = [];
  for (const s of segments ?? []) {
    for (const mc of s.micro_categories ?? []) { chTerms.push(...(mc.companies_house_terms ?? [])); queries.push(...(mc.search_queries ?? [])); }
    chTerms.push(...(s.companies_house_terms ?? [])); queries.push(...(s.high_intent_search_queries ?? []));
  }
  return { chTerms: [...new Set(chTerms)].slice(0, 30), queries: [...new Set(queries)].slice(0, 50) };
}

const TYPE_TO_BREADTH: Record<string, string> = {
  "Currency move": "broad_currency", Tariff: "tariff", "Trade policy": "tariff",
  "Rate decision": "broad_macro", "Rate change": "broad_macro", "Macro data": "broad_macro",
  Commodity: "commodity", "Supply chain": "commodity", Geopolitical: "sector_specific",
};

type TriggerStrength = "strong" | "medium" | "weak" | "reject";
type DiscoveryMode = "full" | "limited" | "context_only" | "reject";

/** Normalise the AI's trigger_strength + trigger_score into (strength, mode, status, budget).
 *  Keeps the AI's stated mode if internally consistent, otherwise derives one from strength. */
export function deriveTriggerDecision(raw: {
  trigger_strength?: unknown; trigger_score?: unknown; discovery_mode?: unknown;
  recommended_query_budget?: unknown; is_fx_relevant?: unknown; commercial_relevance?: unknown;
}): { strength: TriggerStrength; mode: DiscoveryMode; status: "ready" | "context_only" | "low_relevance"; budget: number } {
  const rawStrength = String(raw.trigger_strength ?? "").toLowerCase();
  const rawMode = String(raw.discovery_mode ?? "").toLowerCase();
  const score = Number(raw.trigger_score ?? NaN);
  const rel = Number(raw.commercial_relevance ?? 0);

  let strength: TriggerStrength;
  if (rawStrength === "strong" || rawStrength === "medium" || rawStrength === "weak" || rawStrength === "reject") {
    strength = rawStrength;
  } else if (Number.isFinite(score)) {
    strength = score >= 75 ? "strong" : score >= 45 ? "medium" : score >= 20 ? "weak" : "reject";
  } else if (raw.is_fx_relevant === false || rel <= 2) {
    strength = "reject";
  } else {
    strength = rel >= 7 ? "strong" : rel >= 5 ? "medium" : "weak";
  }

  // Default mode per strength; the AI may downgrade (but not upgrade) it.
  const defaultMode: Record<TriggerStrength, DiscoveryMode> = {
    strong: "full", medium: "limited", weak: "context_only", reject: "reject",
  };
  const rank: Record<DiscoveryMode, number> = { full: 3, limited: 2, context_only: 1, reject: 0 };
  let mode = defaultMode[strength];
  if (rawMode === "full" || rawMode === "limited" || rawMode === "context_only" || rawMode === "reject") {
    if (rank[rawMode as DiscoveryMode] <= rank[mode]) mode = rawMode as DiscoveryMode;
  }

  const status: "ready" | "context_only" | "low_relevance" =
    mode === "reject" ? "low_relevance" : mode === "context_only" ? "context_only" : "ready";

  const budgetDefault: Record<DiscoveryMode, number> = { full: 30, limited: 12, context_only: 0, reject: 0 };
  const claimed = Number(raw.recommended_query_budget ?? NaN);
  const budget = Number.isFinite(claimed) && claimed >= 0 ? Math.min(claimed, budgetDefault[mode] * 2) : budgetDefault[mode];

  return { strength, mode, status, budget };
}

/** Rule-based fallback event when the AI is unavailable. Port of ingest.py
 *  build_fallback_event. Always conservative: confidence_level=low,
 *  discovery_mode=limited, trigger_strength=medium (or weak when the rule-based
 *  pre_relevance_score is low). `failureReason` is folded into confidence_reason
 *  so the audit can see exactly why fallback fired (rate-limit, 404, parse err…). */
export function buildFallbackEvent(item: RawItem, failureReason?: string): Record<string, unknown> {
  const text = `${item.headline} ${item.raw_summary}`.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => text.includes(w));
  let eventType: string, pairs: string[], fxLogic: string, impact: string, segments: Seg[], chTerms: string[];

  const seg = (o: Partial<Seg> & { segment_name: string }): Seg => ({
    business_model: "", exposure_level: "High", exposure_type: "", likely_currency_pairs: pairsRef,
    fx_payment_logic: "", margin_risk: "Medium", payment_timing_risk: "Medium", affected_payment_flow: "",
    website_validation_signals: ["we import", "imported from", "overseas supplier", "international supplier"],
    high_intent_search_queries: [], sales_angle: "", exposure_thesis_template: "",
    micro_categories: [], companies_house_terms: [], ...o,
  });
  // (pairsRef set per-branch below; declared here so `seg` closes over the right value)
  let pairsRef: string[] = ["GBP/USD", "GBP/EUR"];

  if (has("tariff", "tariffs", "trade war", "customs duty")) {
    eventType = "Tariff"; pairs = pairsRef = ["GBP/USD", "GBP/EUR"];
    fxLogic = "New or increased tariffs raise the cost of imported goods. UK businesses buying stock from overseas suppliers face higher landed costs and margin pressure immediately.";
    impact = "UK importers with US or EU suppliers now face higher input costs. Businesses that priced stock before the tariff announcement will see margin compression on committed orders.";
    segments = [
      seg({ segment_name: "UK importers of US/EU goods", exposure_level: "Very High", exposure_type: "Tariff cost exposure",
        business_model: "UK distributor or retailer sourcing stock from US or European suppliers, selling domestically in GBP",
        fx_payment_logic: "Tariff added to import invoice → higher total cost in foreign currency → more GBP needed to pay → margin compressed",
        margin_risk: "High — tariff applies directly to cost of goods", payment_timing_risk: "High — goods already ordered now cost more",
        affected_payment_flow: "USD/EUR payments to overseas suppliers, monthly or per-shipment",
        high_intent_search_queries: ["\"food importer\" UK", "\"product distributor\" UK wholesale", "\"import trading\" UK"],
        companies_house_terms: ["import trading", "distribution international", "foods wholesale"],
        sales_angle: "With tariffs increasing import costs, businesses may want to review upcoming USD/EUR supplier payments.",
        exposure_thesis_template: "This company appears to import goods from overseas and sell in GBP — tariffs increase the GBP cost of upcoming orders." }),
      seg({ segment_name: "UK manufacturers importing raw materials", exposure_type: "Input cost exposure",
        business_model: "UK manufacturer sourcing raw materials or components from US/EU, selling finished goods in GBP",
        fx_payment_logic: "Tariff on imported components/materials → higher cost per unit → margin compressed on GBP-priced finished goods",
        high_intent_search_queries: ["\"manufacturer\" UK international supply", "\"components distributor\" UK"],
        companies_house_terms: ["manufacturing international", "components wholesale", "industrial trading"],
        sales_angle: "Tariffs on imported components are increasing production costs for UK manufacturers with overseas supply chains.",
        exposure_thesis_template: "This company appears to manufacture using imported materials/components — tariffs raise hard-to-pass-on input costs." }),
    ];
    chTerms = ["import trading", "food international", "wines wholesale", "manufacturing international", "distribution international"];
  } else if (has("oil", "crude", "opec", "petroleum", "fuel", "energy")) {
    eventType = "Commodity"; pairs = pairsRef = ["GBP/USD"];
    fxLogic = "Energy and commodity prices are denominated in USD. UK businesses buying commodities or fuel face higher GBP costs when prices rise or GBP weakens against USD.";
    impact = "UK importers of petroleum, chemicals, and commodity-dependent manufacturers face higher input costs.";
    segments = [
      seg({ segment_name: "UK petroleum and fuel importers", exposure_level: "Very High", exposure_type: "USD commodity pricing exposure",
        business_model: "UK distributor buying petroleum products priced in USD, selling to UK trade in GBP",
        fx_payment_logic: "Crude/fuel priced in USD → UK importer pays USD → GBP/USD move changes GBP cost of every delivery",
        high_intent_search_queries: ["\"fuel importer\" UK", "\"petroleum distributor\" UK", "\"chemical wholesaler\" UK"],
        companies_house_terms: ["petroleum wholesale", "fuel trading", "chemical supplies"],
        sales_angle: "With oil prices moving in USD, any UK business buying petroleum or chemicals faces GBP cost uncertainty.",
        exposure_thesis_template: "This company appears to import petroleum/chemicals priced in USD — USD price moves directly affect GBP costs." }),
      seg({ segment_name: "UK chemical and industrial-input importers", exposure_type: "USD commodity input exposure",
        business_model: "UK importer/distributor of industrial chemicals, plastics or raw materials priced in USD",
        fx_payment_logic: "Commodity inputs priced in USD → USD payment to overseas supplier → GBP cost moves with USD rate",
        high_intent_search_queries: ["\"chemical distributor\" UK", "\"industrial chemical\" wholesale UK"],
        companies_house_terms: ["chemicals wholesale", "industrial supplies", "plastics wholesale"],
        sales_angle: "Oil price moves affect the USD cost of chemical inputs — worth reviewing overseas supplier FX exposure.",
        exposure_thesis_template: "This company appears to import chemicals/industrial inputs priced in USD — oil moves affect those costs." }),
    ];
    chTerms = ["chemicals wholesale", "petroleum wholesale", "fuel trading", "chemical supplies", "manufacturing international"];
  } else if (has("shipping", "freight", "supply chain", "container", "red sea", "suez")) {
    eventType = "Supply chain"; pairs = pairsRef = ["GBP/USD"];
    fxLogic = "Shipping and freight costs are denominated in USD. UK importers face both higher freight bills and possible stock delays, compressing landed-cost margins.";
    impact = "UK importers dependent on sea freight face higher logistics costs in USD; manufacturers with overseas suppliers face higher freight + supply uncertainty.";
    segments = [
      seg({ segment_name: "UK importers dependent on sea freight", exposure_level: "Very High", exposure_type: "Freight cost exposure in USD",
        business_model: "UK importer shipping stock from Asia/US by container, paying freight in USD",
        fx_payment_logic: "Freight booked in USD → UK importer pays USD freight → GBP/USD move affects total landed cost",
        high_intent_search_queries: ["\"importer\" UK wholesale", "\"import trading\" UK"],
        companies_house_terms: ["import trading", "food wholesale", "wholesale international"],
        sales_angle: "With shipping costs rising in USD, UK importers face higher landed costs on every container.",
        exposure_thesis_template: "This company appears to import goods by sea — rising USD freight + disruption increase landed costs." }),
    ];
    chTerms = ["import trading", "food wholesale", "wholesale international", "chemicals wholesale", "manufacturing international"];
  } else if (has("rate", "boe", "fed", "ecb", "interest", "monetary")) {
    eventType = "Rate decision"; pairs = pairsRef = ["GBP/USD", "GBP/EUR"];
    fxLogic = "Interest rate decisions shift currency values. UK businesses with overseas supplier payments or overseas customer revenue face changed FX costs/receipts.";
    impact = "Rate decisions move exchange rates — importers face changed costs, exporters face changed GBP revenue.";
    segments = [
      seg({ segment_name: "UK importers with upcoming supplier payments", exposure_type: "Interest-rate / currency-move exposure",
        business_model: "UK distributor or wholesaler with regular EUR or USD supplier invoices due for payment",
        fx_payment_logic: "Rate decision moves GBP → pending supplier invoice now costs more/less GBP → margin impact on goods already ordered",
        margin_risk: "High for businesses with near-term invoices due", payment_timing_risk: "High — invoices due in 30-60 days are immediately exposed",
        high_intent_search_queries: ["\"food importer\" UK", "\"wine importer\" UK", "\"wholesale importer\" UK"],
        companies_house_terms: ["food international", "wines wholesale", "seafood wholesale"],
        sales_angle: "Rate-driven currency moves mean upcoming overseas supplier invoices now cost more in GBP than when orders were placed.",
        exposure_thesis_template: "This company appears to import goods invoiced in EUR/USD — rate-driven currency moves affect the GBP cost of upcoming payments." }),
      seg({ segment_name: "UK exporters receiving overseas revenue", exposure_type: "Export revenue FX exposure",
        business_model: "UK business exporting goods/services, receiving payment in EUR or USD",
        fx_payment_logic: "Overseas customer pays EUR/USD → UK exporter converts to GBP → rate move changes GBP value of that receipt",
        margin_risk: "Medium — revenue in GBP terms changes without cost-structure change",
        high_intent_search_queries: ["\"uk exporter\" international customers", "\"manufacturer\" UK export"],
        companies_house_terms: ["exports international", "trading international", "manufacturing exports"],
        sales_angle: "Currency moves from rate decisions affect the GBP value of any outstanding overseas customer invoices.",
        exposure_thesis_template: "This company appears to export with revenue in EUR/USD — rate-driven moves affect how much GBP they receive." }),
    ];
    chTerms = ["food international", "wines wholesale", "trading international", "exports international", "international trading"];
  } else if (has("pound", "sterling", "gbp", "euro", "eur", "dollar", "usd", "currency", "exchange")) {
    eventType = "Currency move";
    const isGbp = has("pound", "sterling", "gbp"), isEur = has("euro", "eur", "european");
    pairs = pairsRef = isGbp ? (isEur ? ["GBP/USD", "GBP/EUR"] : ["GBP/USD"]) : isEur ? ["GBP/EUR"] : ["GBP/USD", "GBP/EUR"];
    fxLogic = "A currency move directly affects the GBP cost of any overseas supplier invoice or the GBP value of any overseas customer receipt. UK businesses with recurring international payments are immediately exposed.";
    impact = "UK businesses with overseas supplier invoices or overseas customer revenue are directly affected — importers face changed input costs, exporters face changed GBP revenue.";
    segments = [
      seg({ segment_name: "UK food and drink importers", exposure_level: "Very High", exposure_type: "Import cost exposure — EUR/USD supplier payments vs GBP revenue",
        business_model: "UK importer/distributor buying food/drink from European or international suppliers, selling in GBP",
        fx_payment_logic: "Supplier invoice in EUR/USD → convert GBP to pay → currency move changes GBP cost vs when the order was placed",
        margin_risk: "High — thin food-distribution margins amplify FX impact", payment_timing_risk: "High — invoices due monthly, often 30-60 day terms",
        high_intent_search_queries: ["\"food importer\" UK", "\"wine importer\" UK", "\"seafood importer\" UK"],
        companies_house_terms: ["food international", "wines wholesale", "seafood wholesale", "foods import"],
        sales_angle: "Currency move means upcoming overseas food supplier payments now cost more in GBP than when orders were placed.",
        exposure_thesis_template: "This company appears to import food/drink from overseas — currency moves affect the GBP cost of upcoming supplier payments." }),
      seg({ segment_name: "UK furniture and homeware importers", exposure_level: "Very High", exposure_type: "Import cost exposure — EUR/USD vs GBP",
        business_model: "UK wholesaler/distributor importing furniture, homeware or consumer goods from Europe/Asia, selling to UK trade in GBP",
        fx_payment_logic: "Furniture/homeware invoice from European/Asian supplier in EUR/USD → GBP conversion at payment → adverse move compresses margin on stock already ordered",
        margin_risk: "High — furniture margins 25-40% but currency moves can take 10-20% of that", payment_timing_risk: "High — 60-120 day lead times create a long FX window",
        high_intent_search_queries: ["\"furniture importer\" UK", "\"homeware wholesaler\" UK", "\"furniture distributor\" UK"],
        companies_house_terms: ["furniture wholesale", "furniture import", "homeware wholesale"],
        sales_angle: "Currency moves affect the GBP cost of furniture/homeware importers' overseas stock orders.",
        exposure_thesis_template: "This company appears to import furniture/homeware — currency moves affect the GBP cost of upcoming stock orders, especially with long lead times." }),
    ];
    chTerms = ["wines wholesale", "food international", "foods wholesale", "furniture import", "homeware wholesale", "seafood wholesale"];
  } else {
    eventType = "Macro data"; pairs = pairsRef = ["GBP/USD", "GBP/EUR"];
    fxLogic = "Macro events can shift currency values and affect UK businesses with overseas payment obligations or overseas revenue.";
    impact = "Macro data may move GBP — UK businesses with overseas supplier payments or overseas customer revenue could be affected.";
    segments = [
      seg({ segment_name: "UK businesses with regular overseas payments", exposure_type: "Currency exposure — GBP vs overseas currencies",
        business_model: "UK importer or exporter with recurring FX payments or receipts",
        fx_payment_logic: "Macro data shifts GBP expectations → currency moves → GBP cost of overseas payments or GBP value of overseas receipts changes",
        high_intent_search_queries: ["\"importer\" UK", "\"exporter\" UK international"],
        companies_house_terms: ["food international", "import trading", "international trading"],
        sales_angle: "Macro uncertainty affecting GBP is a good time to review FX exposure on upcoming international payments.",
        exposure_thesis_template: "This company appears to have overseas payment obligations or international revenue — macro-driven GBP moves affect those FX transactions." }),
    ];
    chTerms = ["food international", "import trading", "international trading", "exports international"];
  }

  normaliseSegments(segments);
  const { chTerms: ct, queries } = extractChTerms(segments);
  // Conservative tier when AI is down. Weak vs medium hinges on the rule-based
  // pre-relevance: a borderline pre_relevance still gets medium so it isn't
  // dropped, but anything that didn't strongly trigger the keyword pre-filter
  // downgrades to weak (context_only — Brain 3 won't burn budget on it).
  const pre = Number(item.pre_relevance_score ?? 0);
  const triggerStrength = pre >= 5 ? "medium" : "weak";
  const discoveryMode = triggerStrength === "medium" ? "limited" : "context_only";
  const budget = triggerStrength === "medium" ? 12 : 0;
  const triggerScore = triggerStrength === "medium" ? 55 : 30;
  const confidenceReason = failureReason
    ? `AI fallback used — ${failureReason}. Rule-based segments inferred from headline keywords.`
    : "AI unavailable — rule-based fallback based on keyword routing.";
  return {
    ...item, id: item.id, detected_at: nowIso(), event_type: eventType,
    event_breadth: TYPE_TO_BREADTH[eventType] ?? "sector_specific",
    summary: item.raw_summary || item.headline, currency_pairs: pairs,
    urgency_score: 6, commercial_relevance: pre || 5,
    commercial_relevance_reason: failureReason ? `Fallback event — ${failureReason}` : "Fallback event — AI unavailable",
    trigger_strength: triggerStrength, trigger_score: triggerScore, discovery_mode: discoveryMode, recommended_query_budget: budget,
    likely_affected_businesses: segments.map((s) => s.segment_name).filter(Boolean) as string[],
    why_now: `Recent ${eventType.toLowerCase()} may affect upcoming overseas payments for UK businesses`,
    discovery_recommendation: triggerStrength === "medium"
      ? "Limited run — AI fallback, using rule-based segment hypothesis"
      : "Context only — pre-relevance was weak and AI was unavailable",
    confidence_level: "low", confidence_reason: confidenceReason,
    what_happened: item.headline, what_changed_financially: `Market ${eventType.toLowerCase()} with direct FX implications for UK businesses`,
    who_pays_more: "UK importers with overseas supplier invoices", who_receives_less: "UK exporters with overseas customer revenue (if GBP strengthened)",
    margin_risk: "Medium", payment_timing_risk: "Medium",
    affected_payment_flow: pairs.length ? `GBP revenue vs ${pairs.join("/")} supplier costs` : "overseas payments",
    fx_payment_logic: fxLogic, business_impact_summary: impact,
    sales_angle: `Recent ${eventType.toLowerCase()} may affect UK businesses with overseas payments. Worth reviewing FX exposure.`,
    overall_sales_angle: `Recent ${eventType.toLowerCase()} creates FX exposure for UK businesses with international payment flows.`,
    exposure_types: [`${eventType} exposure`], status: "ready", fallback_mode: true,
    target_segments: segments, companies_house_terms: ct.length ? ct : chTerms.slice(0, 10), all_search_queries: queries.slice(0, 20),
  };
}

// ── stage ────────────────────────────────────────────────────────────────────
export interface AnalyseOptions {
  dbPath?: string; runsDir?: string; maxEvents?: number; minRelevance?: number;
  feeds?: ReadonlyArray<RssFeed>; fetchHtml?: HtmlFetcher; analyse?: AnalyseFn; persist?: boolean;
}
export interface AnalyseResult {
  feedsFetched: number; itemsPreFiltered: number; newItems: number;
  saved: number; aiOk: number; fallbackUsed: number; lowRelevance: number; failed: number; runId: string;
}

const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : d; };

export async function runAnalyseStage(opts: AnalyseOptions = {}): Promise<AnalyseResult> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const maxEvents = opts.maxEvents ?? n(process.env.DISCOVERY_MAX_EVENTS, 3);
  const minRelevance = opts.minRelevance ?? n(process.env.DISCOVERY_MIN_RELEVANCE, 4);
  const feeds = opts.feeds ?? RSS_FEEDS;
  const fetcher = opts.fetchHtml ?? defaultFetchHtml;
  const analyseFn = opts.analyse ?? ((h: string, s: string) => analyseEvent(h, s));
  const persist = opts.persist ?? true;

  const { db, sqlite, close } = getDb(dbPath);
  const rec = new RunRecorder("analyse", { dbPath, maxEvents, minRelevance });
  const st: AnalyseResult = { feedsFetched: 0, itemsPreFiltered: 0, newItems: 0, saved: 0, aiOk: 0, fallbackUsed: 0, lowRelevance: 0, failed: 0, runId: rec.run.run_id };

  try {
    // ── Stale-event cleanup ────────────────────────────────────────────────
    // Delete rows older than 14 days that never made it through a successful
    // AI call AND aren't a recorded rule-based fallback. These are stragglers
    // from earlier schema versions (no ai_provider, no trigger_score, no
    // target_segments) that INSERT OR REPLACE will never refresh on its own,
    // and they poison the medium-event audit. RSS re-surfaces anything still
    // newsworthy on the next pull.
    if (persist) {
      const cutoffIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const before = db.select().from(schema.events).all();
      const stale = before.filter((e) => {
        const d = (e.data ?? {}) as Record<string, unknown>;
        const aiProvider = String(d.ai_provider ?? "");
        const fallback = d.fallback_mode === true;
        const detectedAt = String(d.detected_at ?? e.detected_at ?? "");
        return !aiProvider && !fallback && detectedAt && detectedAt < cutoffIso;
      });
      if (stale.length) {
        const del = sqlite.prepare(`DELETE FROM events WHERE id=@id`);
        const tx = sqlite.transaction(() => { for (const e of stale) del.run({ id: e.id }); });
        tx();
        console.log(`analyse: purged ${stale.length} stale events (pre-schema, > 14d old, no AI/fallback record)`);
      }
    }

    const existingIds = new Set(db.select().from(schema.events).all().map((e) => e.id));

    // ── fetch + pre-filter feeds ────────────────────────────────────────────
    const seen = new Map<string, RawItem>();
    for (const feed of feeds) {
      const got = await fetcher(feed.url);
      if (!got) continue;
      st.feedsFetched++;
      for (const entry of parseFeed(got.html, 25)) {
        if (!ENTRY_KEYWORDS.test(`${entry.title} ${entry.summary}`)) continue;
        const { score, reason } = scoreCommercialRelevance(entry.title, entry.summary);
        if (score < minRelevance) continue;
        const id = dedupeId(feed.source, entry.title);
        if (!seen.has(id)) seen.set(id, { id, source: feed.source, source_url: entry.link, headline: entry.title, raw_summary: entry.summary.slice(0, 600), pre_relevance_score: score, pre_relevance_reason: reason });
      }
    }
    const preFiltered = [...seen.values()].sort((a, b) => b.pre_relevance_score - a.pre_relevance_score);
    st.itemsPreFiltered = preFiltered.length;
    const newItems = preFiltered.filter((i) => !existingIds.has(i.id)).slice(0, maxEvents);
    st.newItems = newItems.length;

    const upsertEvent = sqlite.prepare(`INSERT OR REPLACE INTO events (id, headline, status, event_type, event_breadth, urgency_score, commercial_relevance, detected_at, data)
      VALUES (@id,@headline,@status,@event_type,@event_breadth,@urgency_score,@commercial_relevance,@detected_at,@data)`);
    const putEvent = (ev: Record<string, unknown>) => { if (persist) upsertEvent.run({
      id: String(ev.id), headline: String(ev.headline ?? ""), status: String(ev.status ?? "ready"),
      event_type: String(ev.event_type ?? ""), event_breadth: String(ev.event_breadth ?? "sector_specific"),
      urgency_score: Number(ev.urgency_score ?? 0), commercial_relevance: Number(ev.commercial_relevance ?? 0),
      detected_at: String(ev.detected_at ?? nowIso()), data: JSON.stringify(ev),
    }); };

    // Log the AI config once per run so CI logs make it obvious which model was
    // actually contacted (the "GROQ_MODEL=' '" trap that broke the last audit).
    const provider: AiProvider = (process.env.AI_PROVIDER as AiProvider) || "groq";
    const model = resolveProviderModel(provider);
    if (newItems.length) console.log(`analyse: AI provider=${provider} model=${model} new_items=${newItems.length}`);

    let stickyFallback = false;          // once tripped, all remaining events use fallback (saves repeat-calls on deterministic errors)
    let stickyReason = "";               // reason persisted into the fallback's confidence_reason
    for (const item of newItems) {
      if (stickyFallback) {
        putEvent(buildFallbackEvent(item, stickyReason));
        st.fallbackUsed++; st.saved++;
        console.warn(`analyse[fallback]: "${item.headline.slice(0, 80)}" — sticky AI failure (${stickyReason})`);
        continue;
      }
      try {
        const a = await analyseFn(item.headline, item.raw_summary);
        const decision = deriveTriggerDecision(a);
        const urgency = Number(a.urgency_score ?? 0), rel = Number(a.commercial_relevance ?? 0);

        if (decision.mode === "reject") {
          st.lowRelevance++;
          putEvent({
            ...item, detected_at: nowIso(), status: "low_relevance",
            trigger_strength: decision.strength, trigger_score: Number(a.trigger_score ?? 0),
            discovery_mode: decision.mode, recommended_query_budget: 0,
            urgency_score: urgency, commercial_relevance: rel,
            commercial_relevance_reason: String(a.commercial_relevance_reason ?? ""),
            confidence_level: String(a.confidence_level ?? "low"), confidence_reason: String(a.confidence_reason ?? ""),
            ai_provider: provider, ai_model: model,
          });
          continue;
        }

        // For context_only we keep the event for messaging colour but skip discovery —
        // target_segments stays empty so Brain 3 cannot mine it.
        const segments = decision.mode === "context_only" ? [] : normaliseSegments((a.target_segments as Seg[]) ?? []);
        const { chTerms, queries } = extractChTerms(segments);
        putEvent({
          ...item, detected_at: nowIso(),
          event_type: a.event_type, event_breadth: a.event_breadth ?? "sector_specific",
          summary: a.summary ?? item.raw_summary, currency_pairs: a.currency_pairs ?? [],
          urgency_score: urgency, commercial_relevance: rel, commercial_relevance_reason: a.commercial_relevance_reason ?? "",
          trigger_strength: decision.strength, trigger_score: Number(a.trigger_score ?? 0),
          discovery_mode: decision.mode, recommended_query_budget: decision.budget,
          likely_affected_businesses: Array.isArray(a.likely_affected_businesses) ? a.likely_affected_businesses : [],
          why_now: a.why_now ?? "", discovery_recommendation: a.discovery_recommendation ?? "",
          confidence_level: a.confidence_level ?? "low", confidence_reason: a.confidence_reason ?? "",
          what_happened: a.what_happened ?? "", what_changed_financially: a.what_changed_financially ?? "",
          who_pays_more: a.who_pays_more ?? "", who_receives_less: a.who_receives_less ?? "",
          margin_risk: a.margin_risk ?? "", payment_timing_risk: a.payment_timing_risk ?? "",
          affected_payment_flow: a.affected_payment_flow ?? "", fx_payment_logic: a.fx_payment_logic ?? "",
          sales_angle: a.sales_angle ?? "", business_impact_summary: a.business_impact_summary ?? "",
          exposure_types: a.exposure_types ?? [], overall_sales_angle: a.overall_sales_angle ?? "",
          target_segments: segments, companies_house_terms: chTerms, all_search_queries: queries,
          status: decision.status, ai_provider: provider, ai_model: model,
        });
        st.aiOk++; st.saved++;
      } catch (e) {
        // Any AI error (rate-limit, 4xx, 5xx, timeout, parse error) → conservative
        // fallback so we don't silently drop events on a provider/config glitch.
        // The first failure flips the sticky flag — subsequent events skip the AI
        // call entirely because the same config error will keep firing.
        const msg = e instanceof Error ? e.message : String(e);
        const kind = e instanceof RateLimitError ? "rate-limit" : "ai-error";
        stickyFallback = true;
        stickyReason = `${kind}: ${msg.slice(0, 200)}`;
        st.fallbackUsed++; st.saved++;
        putEvent(buildFallbackEvent(item, stickyReason));
        console.warn(`analyse[fallback]: "${item.headline.slice(0, 80)}" — ${kind} (provider=${provider}, model=${model}): ${msg.slice(0, 200)}`);
      }
    }
  } finally {
    rec.section("source_stats", st as unknown as Record<string, unknown>);
    if (persist) rec.finish(sqlite, runsDir);
    close();
  }
  return st;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): AnalyseOptions {
  const o: AnalyseOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--runs") o.runsDir = argv[++i];
    else if (a === "--max-events") o.maxEvents = Number(argv[++i]);
  }
  return o;
}
const isMain = (() => { try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  runAnalyseStage(parseArgs(process.argv.slice(2))).then((r) => {
    console.log(`analyse: ${r.feedsFetched} feeds → ${r.itemsPreFiltered} pre-filtered → ${r.newItems} new | saved ${r.saved} (ai ${r.aiOk}, fallback ${r.fallbackUsed}, low-relevance ${r.lowRelevance}, failed ${r.failed}) | run_id ${r.runId}`);
  }).catch((e) => { console.error("analyse failed:", e); process.exitCode = 1; });
}
