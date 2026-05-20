/**
 * stages/evergreen.ts — weekly evergreen prospect discovery.
 *
 * Inserts synthetic "evergreen" events (one per category group) into the DB and
 * then runs the discover stage on them. Designed for the weekly Sunday 2am run so
 * the candidate pool grows independently of daily news flow.
 *
 * Every lead produced gets lead_type = "evergreen_saving". The discover, score,
 * dedup, and generate-drafts stages all handle these identically to event-triggered
 * leads — they flow into HOT/WARM/QUEUE by the same gates.
 *
 * Idempotent: uses ISO year-week identifier as the event id suffix, so re-running
 * in the same week skips already-inserted events.
 *
 * CLI: tsx src/stages/evergreen.ts [--db path] [--force]
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getDb } from "@fx/core/db";
import { repoRoot } from "@fx/core";
import type { Segment, FxEvent } from "@fx/core";
import { runDiscoverStage } from "./discover.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── ISO week helper ───────────────────────────────────────────────────────────
function isoWeek(): string {
  const now = new Date();
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const diff = now.getTime() - startOfWeek1.getTime();
  const week = Math.floor(diff / (7 * 86_400_000)) + 1;
  return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

// ── Evergreen playbook ────────────────────────────────────────────────────────
// Each entry becomes a synthetic "ready" event. Segments mirror the Brain 2 schema.
// Keep category_priority_score ≥ 75 — these are pre-validated high-fit niches.

interface PlaybookEntry {
  headline: string;
  segments: Partial<Segment>[];
}

const PLAYBOOK: PlaybookEntry[] = [
  // ── FOOD & DRINK ─────────────────────────────────────────────────────────
  {
    headline: "Evergreen: UK wine, spirits & drinks importers",
    segments: [
      {
        segment_name: "Wine & Spirits Importers",
        exposure_level: "Very High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR supplier costs",
        why_affected: "Pay EUR invoices to European producers. GBP/EUR moves directly compress margin on every shipment.",
        category_priority_score: 95,
        sales_angle: "EUR invoice costs. Rate review on upcoming payments.",
        micro_categories: [
          { name: "Italian wine importers UK", why: "", search_queries: ["Italian wine importer UK wholesale", "wine importer Italy UK trade"], companies_house_terms: ["wine importer", "wine distributor"] },
          { name: "French wine & champagne importers UK", why: "", search_queries: ["French wine importer UK wholesale", "champagne importer UK trade"], companies_house_terms: ["wine importer", "champagne importer"] },
          { name: "Spirits & whisky importers UK", why: "", search_queries: ["spirits importer UK wholesale", "European spirits distributor UK"], companies_house_terms: ["spirits importer", "spirits distributor"] },
          { name: "Natural & independent wine importers UK", why: "", search_queries: ["natural wine importer UK", "independent wine merchant importer UK"], companies_house_terms: ["wine merchant", "wine importer"] },
        ],
      },
      {
        segment_name: "Specialty Beer & Craft Drinks Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR supplier costs",
        why_affected: "Import craft beer and drinks from European breweries in EUR.",
        category_priority_score: 78,
        micro_categories: [
          { name: "Craft beer importers UK", why: "", search_queries: ["craft beer importer UK wholesale", "European beer importer UK"], companies_house_terms: ["beer importer", "beer distributor"] },
          { name: "Soft drinks & mixer importers UK", why: "", search_queries: ["soft drink importer UK wholesale", "premium mixer importer UK"], companies_house_terms: ["drinks importer", "beverage importer"] },
        ],
      },
    ],
  },
  {
    headline: "Evergreen: UK food importers & continental food distributors",
    segments: [
      {
        segment_name: "Italian & Continental Food Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR supplier costs",
        why_affected: "Buy produce, deli goods, and specialty foods from Italian, French, Spanish producers in EUR.",
        category_priority_score: 90,
        micro_categories: [
          { name: "Italian food importers UK", why: "", search_queries: ["Italian food importer UK wholesale", "Italian deli food distributor UK"], companies_house_terms: ["food importer", "Italian food"] },
          { name: "European specialty food importers", why: "", search_queries: ["European food importer UK wholesale", "continental food importer UK"], companies_house_terms: ["specialty food importer", "food distributor"] },
          { name: "Charcuterie & cheese importers UK", why: "", search_queries: ["cheese importer UK wholesale", "charcuterie importer UK"], companies_house_terms: ["cheese importer", "charcuterie importer"] },
        ],
      },
      {
        segment_name: "Seafood & Fresh Produce Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/NOK"],
        affected_payment_flow: "GBP revenue / EUR and NOK supplier costs",
        why_affected: "Import seafood and fresh produce from European and Norwegian sources in EUR/NOK.",
        category_priority_score: 82,
        micro_categories: [
          { name: "Seafood importers UK", why: "", search_queries: ["seafood importer UK wholesale", "fish importer UK trade"], companies_house_terms: ["seafood importer", "fish importer"] },
          { name: "Fresh produce importers UK", why: "", search_queries: ["fresh produce importer UK wholesale", "fruit vegetable importer UK"], companies_house_terms: ["produce importer", "fresh food importer"] },
        ],
      },
    ],
  },
  // ── MANUFACTURING & INDUSTRIAL ────────────────────────────────────────────
  {
    headline: "Evergreen: UK machinery, components & industrial importers",
    segments: [
      {
        segment_name: "Machinery & Industrial Components Distributors",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / EUR-USD supplier costs",
        why_affected: "Source machinery and industrial components from European manufacturers in EUR. USD for US/Asian sources.",
        category_priority_score: 85,
        micro_categories: [
          { name: "Industrial machinery importers UK", why: "", search_queries: ["industrial machinery importer UK", "machinery distributor UK European"], companies_house_terms: ["machinery importer", "machinery distributor"] },
          { name: "Pneumatic & hydraulic components UK", why: "", search_queries: ["pneumatic components distributor UK", "hydraulic parts importer UK"], companies_house_terms: ["components distributor", "hydraulic importer"] },
          { name: "CNC & engineering components UK", why: "", search_queries: ["engineering components importer UK", "CNC tooling distributor UK"], companies_house_terms: ["engineering components", "tooling distributor"] },
          { name: "Pumps & valves importers UK", why: "", search_queries: ["pump importer UK distributor", "valve importer UK industrial"], companies_house_terms: ["pump distributor", "valve importer"] },
        ],
      },
      {
        segment_name: "Chemicals & Raw Materials Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / EUR-USD raw material costs",
        why_affected: "Buy chemicals and raw materials priced in EUR or USD from European and US producers.",
        category_priority_score: 80,
        micro_categories: [
          { name: "Specialty chemicals importers UK", why: "", search_queries: ["specialty chemical importer UK", "chemical distributor UK European"], companies_house_terms: ["chemical importer", "chemical distributor"] },
          { name: "Food ingredient importers UK", why: "", search_queries: ["food ingredient importer UK wholesale", "food additive importer UK"], companies_house_terms: ["food ingredient importer", "ingredient distributor"] },
          { name: "Plastics & polymer importers UK", why: "", search_queries: ["plastic raw material importer UK", "polymer distributor UK"], companies_house_terms: ["plastics importer", "polymer distributor"] },
        ],
      },
      {
        segment_name: "Packaging & Materials Importers",
        exposure_level: "Medium",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR packaging costs",
        why_affected: "Source packaging materials from European suppliers in EUR.",
        category_priority_score: 75,
        micro_categories: [
          { name: "Packaging materials importers UK", why: "", search_queries: ["packaging importer UK wholesale", "packaging materials distributor UK European"], companies_house_terms: ["packaging importer", "packaging distributor"] },
          { name: "Glass & bottle importers UK", why: "", search_queries: ["glass bottle importer UK", "wine bottle supplier UK European"], companies_house_terms: ["bottle importer", "glass importer"] },
        ],
      },
    ],
  },
  // ── CONSUMER GOODS / RETAIL TRADE ────────────────────────────────────────
  {
    headline: "Evergreen: UK furniture, textiles & consumer goods importers",
    segments: [
      {
        segment_name: "Furniture & Interiors Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / EUR-USD sourcing costs",
        why_affected: "Source furniture and interiors from European or Asian manufacturers. Prices in EUR or USD.",
        category_priority_score: 80,
        micro_categories: [
          { name: "Contract furniture importers UK", why: "", search_queries: ["furniture importer UK wholesale trade", "contract furniture distributor UK European"], companies_house_terms: ["furniture importer", "furniture distributor"] },
          { name: "Lighting & home interiors importers UK", why: "", search_queries: ["lighting importer UK wholesale", "interiors importer UK trade"], companies_house_terms: ["lighting importer", "interiors importer"] },
        ],
      },
      {
        segment_name: "Textile & Clothing Importers",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / EUR-USD sourcing costs",
        why_affected: "Source garments and fabrics from European or Asian manufacturers. EUR for EU mills, USD for Asia.",
        category_priority_score: 76,
        micro_categories: [
          { name: "Wholesale clothing importers UK", why: "", search_queries: ["clothing importer UK wholesale", "garment importer UK trade"], companies_house_terms: ["clothing importer", "garment importer"] },
          { name: "Fabric & textile importers UK", why: "", search_queries: ["fabric importer UK wholesale", "textile importer UK European"], companies_house_terms: ["textile importer", "fabric importer"] },
          { name: "Fashion & apparel distributors UK", why: "", search_queries: ["fashion importer UK wholesale trade", "apparel distributor UK European"], companies_house_terms: ["fashion importer", "apparel importer"] },
        ],
      },
    ],
  },
  // ── AUTOMOTIVE & ELECTRONICS ──────────────────────────────────────────────
  {
    headline: "Evergreen: UK automotive parts & electronics distributors",
    segments: [
      {
        segment_name: "Automotive Parts Distributors",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/EUR"],
        affected_payment_flow: "GBP revenue / EUR parts costs",
        why_affected: "Source automotive parts from European manufacturers in EUR.",
        category_priority_score: 78,
        micro_categories: [
          { name: "Automotive parts importers UK", why: "", search_queries: ["automotive parts importer UK wholesale", "car parts distributor UK European"], companies_house_terms: ["automotive parts importer", "parts distributor"] },
          { name: "Commercial vehicle parts UK", why: "", search_queries: ["truck parts importer UK", "commercial vehicle parts distributor UK"], companies_house_terms: ["vehicle parts importer", "parts distributor"] },
        ],
      },
      {
        segment_name: "Electronics & Technology Distributors",
        exposure_level: "High",
        exposure_type: "import_costs",
        likely_currency_pairs: ["GBP/USD"],
        affected_payment_flow: "GBP revenue / USD component costs",
        why_affected: "Source electronics and components priced in USD from US or Asian suppliers.",
        category_priority_score: 76,
        micro_categories: [
          { name: "Electronic components distributors UK", why: "", search_queries: ["electronic components distributor UK", "electronics importer UK wholesale"], companies_house_terms: ["electronic components", "electronics distributor"] },
          { name: "AV & technology equipment importers UK", why: "", search_queries: ["AV equipment importer UK", "technology equipment distributor UK"], companies_house_terms: ["technology importer", "AV distributor"] },
        ],
      },
    ],
  },
  // ── LOGISTICS & FREIGHT ───────────────────────────────────────────────────
  {
    headline: "Evergreen: UK freight forwarders & logistics companies with FX exposure",
    segments: [
      {
        segment_name: "Freight Forwarders & Logistics",
        exposure_level: "Medium",
        exposure_type: "multi_currency",
        likely_currency_pairs: ["GBP/EUR", "GBP/USD"],
        affected_payment_flow: "GBP revenue / multi-currency freight and port costs",
        why_affected: "Pay overseas port charges, agents, and carriers in EUR and USD. Also invoice clients in GBP for overseas shipments.",
        category_priority_score: 75,
        micro_categories: [
          { name: "UK freight forwarders", why: "", search_queries: ["freight forwarder UK import export", "customs broker UK trade"], companies_house_terms: ["freight forwarder", "customs broker"] },
          { name: "Shipping & logistics UK", why: "", search_queries: ["shipping agent UK import export", "logistics company UK overseas freight"], companies_house_terms: ["shipping agent", "logistics company"] },
        ],
      },
    ],
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

export interface EvergreenOptions {
  dbPath?: string;
  runsDir?: string;
  force?: boolean;
}

export interface EvergreenResult {
  week: string;
  eventsInserted: number;
  eventsAlreadyPresent: number;
  discoverResult: Awaited<ReturnType<typeof runDiscoverStage>>;
}

export async function runEvergreenStage(opts: EvergreenOptions = {}): Promise<EvergreenResult> {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const runsDir = opts.runsDir ?? resolve(root, "data/runs");
  const force = !!opts.force;
  const week = isoWeek();

  const { sqlite, close } = getDb(dbPath);

  const insertEvent = sqlite.prepare(`
    INSERT OR IGNORE INTO events (id, status, data)
    VALUES (@id, @status, @data)
  `);

  let inserted = 0;
  let alreadyPresent = 0;

  sqlite.transaction(() => {
    for (let i = 0; i < PLAYBOOK.length; i++) {
      const entry = PLAYBOOK[i]!;
      const id = `evergreen-${week}-${i}`;

      if (!force) {
        const existing = sqlite.prepare("SELECT id FROM events WHERE id = ?").get(id) as { id: string } | undefined;
        if (existing) { alreadyPresent++; continue; }
      }

      const event: Partial<FxEvent> = {
        id,
        headline: entry.headline,
        source: "evergreen_playbook",
        source_url: "",
        detected_at: new Date().toISOString(),
        status: "ready",
        event_type: "evergreen",
        event_breadth: "broad_macro",
        trigger_strength: "strong",
        discovery_mode: "full",
        trigger_score: 80,
        recommended_query_budget: 20,
        urgency_score: 5,
        commercial_relevance: 8,
        commercial_relevance_reason: "evergreen_playbook",
        target_segments: entry.segments as Segment[],
        summary: entry.headline,
        business_impact_summary: "Recurring FX payment exposure — evergreen prospect discovery.",
        sales_angle: "Rate review on recurring foreign currency payments.",
        fallback_mode: false,
      };

      const row = sqlite.prepare("SELECT id FROM events WHERE id = ?").get(id) as { id: string } | undefined;
      if (row && force) {
        sqlite.prepare("UPDATE events SET status = @status, data = @data WHERE id = @id")
          .run({ id, status: "ready", data: JSON.stringify(event) });
        inserted++;
      } else if (!row) {
        insertEvent.run({ id, status: "ready", data: JSON.stringify(event) });
        inserted++;
      } else {
        alreadyPresent++;
      }
    }
  })();

  close();

  console.log(`evergreen: week=${week} | inserted=${inserted} | already_present=${alreadyPresent}`);

  // Run discover on the newly inserted evergreen events
  const discoverResult = await runDiscoverStage({
    dbPath,
    runsDir,
    // Use higher limits for evergreen — these are pre-validated high-fit categories
    maxSegments: 20,
    maxMicroCats: 4,
    maxQueriesPerMicroCat: 2,
    maxResultsPerQuery: 10,
    minScoreToScrape: 0, // all evergreen segments are pre-scored high
  });

  return { week, eventsInserted: inserted, eventsAlreadyPresent: alreadyPresent, discoverResult };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes("--force");
  runEvergreenStage({ force })
    .then((r) => {
      console.log(`evergreen done: ${r.discoverResult.leadsAdded} leads added`);
      process.exit(0);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
