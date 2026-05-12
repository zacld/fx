import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDb, schema } from "@fx/core/db";
import { parseFeed, scoreCommercialRelevance, dedupeId, ENTRY_KEYWORDS } from "../src/sources/rss.js";
import { extractJson, formatPrompt, RateLimitError, COMBINED_ANALYSIS_PROMPT } from "../src/sources/ai.js";
import { runAnalyseStage, buildFallbackEvent } from "../src/stages/analyse.js";
import type { HtmlFetcher } from "../src/sources/fetch.js";

const RSS_XML = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title>
  <item><title>Pound slides against the euro after the Bank of England holds rates</title>
        <link>https://news.example/gbp-eur</link>
        <description>&lt;p&gt;Sterling fell against the euro after the BoE&apos;s rate decision.&lt;/p&gt;</description></item>
  <item><title>UK firms warn of higher import costs after new US tariff hike</title>
        <link>https://news.example/tariffs</link>
        <description>Distributors say imported stock priced before the tariff will see margin pressure.</description></item>
  <item><title>Bitcoin rallies past $70k as crypto traders pile in</title>
        <link>https://news.example/btc</link><description>Digital asset markets surge.</description></item>
  <item><title>Local council announces new park opening hours</title>
        <link>https://news.example/park</link><description>Community news.</description></item>
</channel></rss>`;

const ATOM_XML = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>
  <entry><title>GBP/USD falls as the Fed signals higher interest rates for longer</title>
         <link href="https://gov.example/fx"/>
         <summary>Currency move with implications for UK importers paying USD invoices.</summary></entry>
</feed>`;

describe("rss parsing + pre-filter", () => {
  it("parseFeed handles RSS and Atom", () => {
    const rss = parseFeed(RSS_XML);
    expect(rss.length).toBe(4);
    expect(rss[0]!.title).toContain("Pound slides against the euro");
    expect(rss[0]!.link).toBe("https://news.example/gbp-eur");
    expect(rss[0]!.summary).toBe("Sterling fell against the euro after the BoE's rate decision.");   // tags + entities stripped
    const atom = parseFeed(ATOM_XML);
    expect(atom.length).toBe(1);
    expect(atom[0]!.link).toBe("https://gov.example/fx");
  });
  it("scoreCommercialRelevance: FX/tariff news scores ≥4, crypto/local news ~0", () => {
    expect(scoreCommercialRelevance("Pound slides against the euro after the Bank of England holds rates").score).toBeGreaterThanOrEqual(4);
    expect(scoreCommercialRelevance("UK importers warn of higher costs after new US tariffs on goods").score).toBeGreaterThanOrEqual(4);
    expect(scoreCommercialRelevance("Bitcoin rallies past $70k as crypto traders pile in").score).toBe(0);
    expect(scoreCommercialRelevance("Local council announces new park opening hours").score).toBe(0);
  });
  it("ENTRY_KEYWORDS gate lets FX news through, blocks the rest", () => {
    expect(ENTRY_KEYWORDS.test("Pound slides against the euro")).toBe(true);
    expect(ENTRY_KEYWORDS.test("UK firms warn of higher import costs after new US tariff hike")).toBe(true);
    expect(ENTRY_KEYWORDS.test("Bitcoin rallies past 70k")).toBe(false);
    expect(ENTRY_KEYWORDS.test("Local council park opening hours")).toBe(false);
  });
  it("dedupeId is stable & whitespace-normalising", () => {
    expect(dedupeId("BBC", "Hello   World")).toBe(dedupeId("BBC", " Hello World "));
    expect(dedupeId("BBC", "x")).not.toBe(dedupeId("Reuters", "x"));
  });
});

describe("ai helpers", () => {
  it("formatPrompt substitutes headline/summary into the verbatim prompt", () => {
    const p = formatPrompt("GBP/EUR slides", "Sterling fell ~1%.");
    expect(p).toContain("Headline: GBP/EUR slides");
    expect(p).toContain("Summary: Sterling fell ~1%.");
    expect(p).toContain("PART 1 — EVENT TRIAGE");
    expect(p).toContain("category_priority_score");
    expect(COMBINED_ANALYSIS_PROMPT).not.toContain("__HEADLINE__".slice(0, 0) + "{headline}");   // not Python .format style
  });
  it("extractJson strips code fences and parses the {...} block", () => {
    expect(extractJson('```json\n{"a":1,"b":[2,3]}\n```')).toEqual({ a: 1, b: [2, 3] });
    expect(extractJson('here you go: {"x":"y"} thanks')).toEqual({ x: "y" });
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("buildFallbackEvent", () => {
  it("routes by keyword and produces a usable event with normalised segments", () => {
    const tar = buildFallbackEvent({ id: "t1", source: "X", source_url: "", headline: "New US tariffs hit UK importers", raw_summary: "", pre_relevance_score: 7, pre_relevance_reason: "" });
    expect(tar.event_type).toBe("Tariff");
    expect(tar.event_breadth).toBe("tariff");
    expect((tar.target_segments as Array<{ segment_signals?: string[]; website_validation_signals?: string[] }>).every((s) => Array.isArray(s.segment_signals) && s.segment_signals === s.website_validation_signals)).toBe(true);
    expect((tar.companies_house_terms as string[]).length).toBeGreaterThan(0);

    const oil = buildFallbackEvent({ id: "t2", source: "X", source_url: "", headline: "OPEC+ output cut sends crude oil prices higher", raw_summary: "", pre_relevance_score: 6, pre_relevance_reason: "" });
    expect(oil.event_type).toBe("Commodity");
    expect(oil.event_breadth).toBe("commodity");

    const ccy = buildFallbackEvent({ id: "t3", source: "X", source_url: "", headline: "Pound weakens sharply against the euro", raw_summary: "", pre_relevance_score: 5, pre_relevance_reason: "" });
    expect(ccy.event_type).toBe("Currency move");
    expect(ccy.event_breadth).toBe("broad_currency");
    expect(ccy.status).toBe("ready");
    expect(ccy.fallback_mode).toBe(true);

    const rate = buildFallbackEvent({ id: "t4", source: "X", source_url: "", headline: "Bank of England raises interest rates", raw_summary: "", pre_relevance_score: 6, pre_relevance_reason: "" });
    expect(rate.event_type).toBe("Rate decision");
    expect(rate.event_breadth).toBe("broad_macro");
  });
});

describe("analyse stage (mocked feeds + AI)", () => {
  const feedFetch: HtmlFetcher = async (url) => {
    if (url === "https://test.feed/rss") return { html: RSS_XML, finalUrl: url };
    return null;
  };
  const cannedAnalysis = {
    is_fx_relevant: true, commercial_relevance: 8, commercial_relevance_reason: "Direct GBP/EUR move",
    event_type: "Currency move", event_breadth: "broad_currency", urgency_score: 8,
    what_happened: "Sterling fell against the euro", what_changed_financially: "GBP/EUR rate moved",
    who_pays_more: "UK importers", who_receives_less: "none", margin_risk: "High", payment_timing_risk: "High",
    affected_payment_flow: "GBP revenue vs EUR supplier costs", summary: "GBP/EUR moved lower.",
    currency_pairs: ["GBP/EUR"], fx_payment_logic: "Importers pay EUR; weaker GBP → more GBP per invoice.",
    sales_angle: "Worth a chat about upcoming EUR payments.", business_impact_summary: "UK food/wine importers face higher GBP cost on EUR invoices.",
    exposure_types: ["EUR supplier payment exposure"], overall_sales_angle: "Call UK importers today about EUR exposure.",
    target_segments: [{
      segment_name: "European wine and spirits importers", category_priority_score: 88,
      business_model: "UK importer buying from European producers, selling in GBP.", exposure_level: "Very High",
      exposure_type: "Import cost exposure", likely_currency_pairs: ["GBP/EUR"],
      fx_payment_logic: "EUR invoice → GBP conversion → weaker GBP → higher cost.",
      margin_risk: "High", payment_timing_risk: "High", affected_payment_flow: "EUR payments quarterly",
      website_validation_signals: ["imported from", "sourced from", "European vineyards"],
      avoid_segments: ["supermarkets"], sales_angle: "Upcoming EUR payments cost more in GBP now.",
      exposure_thesis_template: "This company imports from European producers.",
      micro_categories: [{ name: "French wine importers UK", why: "Pay EUR to French producers", search_queries: ['"french wine importer" UK'], companies_house_terms: ["french wine"] }],
    }],
  };

  it("fetches feeds, pre-filters, runs AI, writes ready events with normalised segments + flattened CH terms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxanalyse-"));
    const dbPath = join(dir, "fx.db");
    let aiCalls = 0;
    const r = await runAnalyseStage({
      dbPath, runsDir: join(dir, "runs"), feeds: [{ source: "Test", url: "https://test.feed/rss" }],
      fetchHtml: feedFetch, maxEvents: 5,
      analyse: async (headline) => { aiCalls++; return headline.toLowerCase().includes("park") ? { ...cannedAnalysis, is_fx_relevant: false, urgency_score: 1, commercial_relevance: 2 } : { ...cannedAnalysis }; },
    });
    expect(r.feedsFetched).toBe(1);
    // 2 items pass the entry-keyword + relevance gates (the gbp/eur one and the tariffs one); bitcoin & council are filtered before AI
    expect(r.itemsPreFiltered).toBe(2);
    expect(r.newItems).toBe(2);
    expect(aiCalls).toBe(2);
    expect(r.saved).toBe(2);
    expect(r.aiOk).toBe(2);

    const { db, sqlite, close } = getDb(dbPath);
    try {
      const events = db.select().from(schema.events).all();
      expect(events.length).toBe(2);
      const ev = events[0]!;
      expect(ev.status).toBe("ready");
      expect(ev.event_breadth).toBe("broad_currency");
      const data = ev.data as Record<string, unknown>;
      const seg = (data.target_segments as Array<{ segment_signals?: string[]; website_validation_signals?: string[] }>)[0]!;
      expect(seg.segment_signals).toEqual(seg.website_validation_signals);            // alias kept in sync
      expect((data.companies_house_terms as string[])).toContain("french wine");      // flattened from micro_categories
      expect((data.all_search_queries as string[])).toContain('"french wine importer" UK');
      expect((sqlite.prepare("SELECT COUNT(*) c FROM runs").get() as { c: number }).c).toBe(1);
    } finally { close(); }

    // re-run: same items already in events → 0 new
    const r2 = await runAnalyseStage({ dbPath, runsDir: join(dir, "runs"), feeds: [{ source: "Test", url: "https://test.feed/rss" }], fetchHtml: feedFetch, analyse: async () => cannedAnalysis });
    expect(r2.newItems).toBe(0);
    expect(r2.saved).toBe(0);
  });

  it("on a 429 from the AI it falls back to a rule-based event for the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxanalyse2-"));
    const dbPath = join(dir, "fx.db");
    const r = await runAnalyseStage({
      dbPath, runsDir: join(dir, "runs"), feeds: [{ source: "Test", url: "https://test.feed/rss" }],
      fetchHtml: feedFetch, maxEvents: 5, analyse: async () => { throw new RateLimitError("429"); },
    });
    expect(r.fallbackUsed).toBe(2);
    expect(r.saved).toBe(2);
    const { db, close } = getDb(dbPath);
    try {
      const events = db.select().from(schema.events).all();
      expect(events.length).toBe(2);
      expect(events.every((e) => (e.data as { fallback_mode?: boolean }).fallback_mode === true)).toBe(true);
      expect(events.every((e) => Array.isArray((e.data as { target_segments?: unknown[] }).target_segments) && ((e.data as { target_segments?: unknown[] }).target_segments?.length ?? 0) > 0)).toBe(true);
      expect(events.every((e) => e.status === "ready")).toBe(true);
    } finally { close(); }
  });
});
