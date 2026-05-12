import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDb, schema } from "@fx/core/db";
import type { Lead } from "@fx/core";
import { runScoreStage, scoreAndClassify, reclassifyOriginTokens } from "../src/stages/score.js";

function makeLead(p: Partial<Lead> & { id: string }): Lead {
  // minimal-but-valid; LeadSchema fills the rest when re-parsed inside the stage
  return { event_id: "", company_name: "X Ltd", priority: "QUEUE", score: 0, ...p } as Lead;
}

function setupDb(dir: string): string {
  const dbPath = join(dir, "fx.db");
  const { db, sqlite, close } = getDb(dbPath);
  // events
  sqlite.prepare(`INSERT INTO events (id, headline, status, event_type, event_breadth, urgency_score, commercial_relevance, data)
                  VALUES (?,?,?,?,?,?,?,?)`).run(
    "evtCcy", "GBP/EUR slides", "discovered", "Currency move", "broad_currency", 8, 8,
    JSON.stringify({ id: "evtCcy", headline: "GBP/EUR slides", event_breadth: "broad_currency", urgency_score: 8 }),
  );
  // leads
  const ins = sqlite.prepare(`INSERT INTO leads
    (id, event_id, company_number, company_name, company_status, website, website_domain, website_source, website_confidence,
     priority, score, exposure_level, exposure_confidence, lead_type, segment_name, is_large_org, data)
    VALUES (@id,@event_id,@company_number,@company_name,@company_status,@website,@website_domain,@website_source,@website_confidence,
     @priority,@score,@exposure_level,@exposure_confidence,@lead_type,@segment_name,@is_large_org,@data)`);
  const put = (l: Lead) => ins.run({
    id: l.id, event_id: l.event_id ?? "", company_number: l.company_number ?? null, company_name: l.company_name ?? "X",
    company_status: l.company_status ?? null, website: l.website ?? null, website_domain: l.website_domain ?? "",
    website_source: (l.website_source as string | null) ?? null, website_confidence: (l.website_confidence as string | null) ?? null,
    priority: l.priority ?? "QUEUE", score: l.score ?? 0, exposure_level: l.exposure_level ?? "",
    exposure_confidence: l.exposure_confidence ?? "none", lead_type: l.lead_type ?? "unknown",
    segment_name: l.segment_name ?? "", is_large_org: l.is_large_org ? 1 : 0, data: JSON.stringify(l),
  });

  // L1: legacy lead — nationality words in fx_payment_signals; strong active importer otherwise
  put(makeLead({
    id: "L1", event_id: "evtCcy", company_name: "Acme Wine Importers Ltd", company_status: "active",
    company_number: "00111111", website: "https://acmewine.co.uk", website_domain: "acmewine.co.uk",
    website_confidence: "high", website_source: "ddg_search", sic_codes: ["46342"], exposure_level: "Very High",
    exposure_type: "Import cost exposure", fx_payment_signals: ["italian", "french", "we import", "sourced from"],
    b2b_signals: ["wholesale", "trade customers"], secondary_signals: ["european"], pays_fx_confirmed: true,
    why_affected: "Imports wine from European producers, invoiced in EUR, revenue in GBP — GBP/EUR moves squeeze margin.",
    priority: "QUEUE",
  }));
  // L2: no website → SKIP
  put(makeLead({
    id: "L2", event_id: "evtCcy", company_name: "Some Importers Ltd", company_status: "active",
    company_number: "00222222", sic_codes: ["46342"], exposure_level: "Very High",
    fx_payment_signals: ["we import"], website: null, priority: "WARM",
  }));
  // L3: strong but PLC → capped at QUEUE
  put(makeLead({
    id: "L3", event_id: "evtCcy", company_name: "Massive Drinks Group PLC", company_status: "active",
    company_number: "00333333", website: "https://example.com", website_domain: "example.com",
    website_confidence: "high", sic_codes: ["46342"], exposure_level: "Very High",
    fx_payment_signals: ["we import", "sourced from"], b2b_signals: ["wholesale"], pays_fx_confirmed: true,
    why_affected: "x".repeat(60), is_large_org: true, priority: "HOT",
  }));
  // L4: dissolved → SKIP
  put(makeLead({
    id: "L4", event_id: "evtCcy", company_name: "Defunct Wine Importers Ltd", company_status: "dissolved",
    company_number: "00444444", website: "https://defunct.co.uk", website_domain: "defunct.co.uk",
    website_confidence: "high", sic_codes: ["46342"], exposure_level: "Very High",
    fx_payment_signals: ["we import", "sourced from"], b2b_signals: ["wholesale"], why_affected: "x".repeat(60),
    priority: "HOT",
  }));
  close();
  return dbPath;
}

describe("score stage", () => {
  it("reclassifyOriginTokens moves bare nationality adjectives out of fx_payment_signals", () => {
    const l = makeLead({ id: "x", fx_payment_signals: ["italian", "we import", "french", "sourced from"], secondary_signals: ["european"], fx_origin_hints: [] });
    expect(reclassifyOriginTokens(l)).toBe(true);
    expect(l.fx_payment_signals).toEqual(["we import", "sourced from"]);
    expect(l.secondary_signals).toEqual(expect.arrayContaining(["european", "italian", "french"]));
    expect(l.fx_origin_hints).toEqual(expect.arrayContaining(["italian", "french"]));
    expect(reclassifyOriginTokens(l)).toBe(false);  // idempotent
  });

  it("classifyLead marks broad-currency-triggered importers as 'both'", () => {
    const l = makeLead({ id: "y", event_id: "e", sic_codes: ["46342"], fx_payment_signals: ["we import"], pays_fx_confirmed: true, score: 90 });
    scoreAndClassify(l, { breadth: "broad_currency", urgency: 8 });
    expect(["both", "trigger_exposed"]).toContain(l.lead_type);   // trigger + (import SIC + fx) ⇒ both
    expect(l.lead_type).toBe("both");
    expect(l.awareness_level).toBe("high");
  });

  it("runs end to end: scores leads, persists to DB, exports JSON, writes a runs row", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxscore-"));
    const dbPath = setupDb(dir);
    const outPath = join(dir, "leads.out.json");
    const runsDir = join(dir, "runs");

    const r = runScoreStage({ dbPath, outPath, runsDir });
    expect(r.total).toBe(4);
    expect(r.reclassified).toBe(1);                 // only L1 had nationality words
    expect(r.runId).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);

    // exported JSON map
    expect(existsSync(outPath)).toBe(true);
    const out = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, Lead>;
    expect(Object.keys(out).length).toBe(4);
    expect(out.L1!.fx_payment_signals).toEqual(["we import", "sourced from"]);   // reclassified
    expect(out.L1!.priority).toBe("HOT");
    expect(out.L2!.priority).toBe("SKIP");                                        // no website
    expect(out.L3!.score).toBeLessThanOrEqual(49);                               // large org cap
    expect(out.L4!.priority).toBe("SKIP");                                        // dissolved

    // persisted to DB
    const { db, sqlite, close } = getDb(dbPath);
    try {
      const l1 = db.select().from(schema.leads).all().find((x) => x.id === "L1")!;
      expect(l1.priority).toBe("HOT");
      expect(l1.data.fx_payment_signals).toEqual(["we import", "sourced from"]);
      const runs = sqlite.prepare("SELECT * FROM runs").all() as Array<{ mode: string }>;
      expect(runs.length).toBe(1);
      expect(runs[0]!.mode).toBe("score");
    } finally { close(); }

    // re-run is idempotent (reclassify already done → reclassified 0; counts stable)
    const r2 = runScoreStage({ dbPath, outPath, runsDir });
    expect(r2.reclassified).toBe(0);
    expect(r2.after).toEqual(r.after);
  });
});
