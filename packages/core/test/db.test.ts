import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";

import { getDb, schema } from "../src/db/index.js";
import { importJson } from "../src/db/import-json.js";
import type { Lead } from "../src/schema.js";

describe("db — schema + round-trip", () => {
  it("creates the tables and round-trips a lead (JSON column intact)", () => {
    const { db, close } = getDb(":memory:");
    try {
      const lead: Lead = {
        id: "abc123", event_id: "evt1", linked_event_ids: ["evt1"],
        company_name: "Acme Wine Importers Ltd", company_number: "00123456", company_status: "active",
        company_type: null, address: "1 High St, London", incorporated: "2008-04-01",
        sic_codes: ["46342"], director_name: "Jane Doe", director_role: "Finance Director", is_large_org: false,
        website: "https://acmewine.co.uk", website_domain: "acmewine.co.uk",
        website_confidence: "high", website_source: "ddg_search", source_query: '"wine importer" UK',
        source_segment: "European wine importers", website_snippet: "We import wine from French suppliers.",
        duplicate_sources: [],
        fx_payment_signals: ["we import", "french suppliers"], fx_origin_hints: ["french"],
        b2b_signals: ["wholesale", "trade customers"], secondary_signals: ["european", "distributor"],
        segment_signals: ["imported from"], pays_fx_confirmed: true, signal_count: 4,
        company_source: "web_search", segment_name: "European wine importers", segment_business_model: "",
        exposure_level: "Very High", exposure_type: "Import cost exposure",
        why_affected: "x".repeat(60), why_financially_exposed: "", margin_risk: "High",
        payment_timing_risk: "High", affected_payment_flow: "GBP revenue vs EUR supplier costs",
        trigger_headline: "GBP/EUR slides", event_type: "Currency move", business_impact_summary: "",
        fx_exposure: "GBP/EUR", fx_payment_logic: "", fx_reason: "", exposure_thesis: "",
        exposure_confidence: "high", score: 86, priority: "HOT", scoring_reasons: ["...", "→ HOT"],
        lead_type: "trigger_exposed", awareness_level: "high", saving_opportunity: "high",
        multi_event_trigger: false, multi_event_count: 1, sales_angle: "", suggested_next_step: "",
        guessed_emails: [], generic_emails: [], status: "new",
        call_opener: "", email_draft: "", linkedin_note: "",
      };

      db.insert(schema.leads).values({
        id: lead.id, event_id: lead.event_id, company_number: lead.company_number,
        company_name: lead.company_name, company_status: lead.company_status,
        website: lead.website, website_domain: lead.website_domain,
        website_source: lead.website_source ?? null, website_confidence: lead.website_confidence ?? null,
        priority: lead.priority, score: lead.score, exposure_level: lead.exposure_level || "",
        exposure_confidence: lead.exposure_confidence, lead_type: lead.lead_type,
        segment_name: lead.segment_name, is_large_org: lead.is_large_org, rescored_at: null, data: lead,
      }).run();

      const rows = db.select().from(schema.leads).where(eq(schema.leads.priority, "HOT")).all();
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.company_name).toBe("Acme Wine Importers Ltd");
      expect(row.score).toBe(86);
      expect(row.is_large_org).toBe(false);            // boolean mode
      expect(row.data.fx_payment_signals).toEqual(["we import", "french suppliers"]);  // JSON column
      expect(row.data.contact_phone === undefined || row.data.contact_phone === null).toBe(true);

      // a column we don't index but still want queryable
      const byCn = db.select().from(schema.leads).where(eq(schema.leads.company_number, "00123456")).all();
      expect(byCn.length).toBe(1);
    } finally {
      close();
    }
  });

  it("importJson loads JSON-keyed events/leads files into the DB (bad rows skipped)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxdb-"));
    mkdirSync(join(dir, "data"), { recursive: true });
    const eventsPath = join(dir, "events.json");
    const leadsPath = join(dir, "leads.json");
    const dbPath = join(dir, "fx.db");

    writeFileSync(eventsPath, JSON.stringify({
      evt1: { id: "evt1", headline: "GBP/EUR slides", status: "discovered", event_type: "Currency move", urgency_score: 8 },
      evtbad: { headline: "missing required things", urgency_score: "not a number" },  // id present (key) → still parses; urgency coerce fails? z.number from string → fail → skipped
    }));
    writeFileSync(leadsPath, JSON.stringify({
      lead1: { id: "lead1", event_id: "evt1", company_name: "Acme Ltd", priority: "WARM", score: 70 },
      leadbad: { event_id: "evt1", priority: "NOPE" },   // bad priority enum → skipped (and missing id, but key supplies it; priority enum fails)
      lead2: { id: "lead2", event_id: "evt1", company_name: "Bravo Ltd", priority: "QUEUE", score: 45 },
    }));

    const r = importJson({ dbPath, eventsPath, leadsPath });
    expect(r.eventsOk).toBeGreaterThanOrEqual(1);
    expect(r.leadsOk).toBe(2);
    expect(r.leadsBad).toBe(1);

    const { db, close } = getDb(dbPath);
    try {
      expect(db.select().from(schema.leads).all().length).toBe(2);
      expect(db.select().from(schema.events).all().length).toBe(r.eventsOk);
      const warm = db.select().from(schema.leads).where(eq(schema.leads.priority, "WARM")).all();
      expect(warm[0]!.company_name).toBe("Acme Ltd");
    } finally {
      close();
    }

    // re-import is idempotent (replace, not duplicate)
    importJson({ dbPath, eventsPath, leadsPath });
    const { db: db2, close: close2 } = getDb(dbPath);
    try {
      expect(db2.select().from(schema.leads).all().length).toBe(2);
    } finally {
      close2();
    }
  });
});
