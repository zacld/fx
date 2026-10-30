import { describe, it, expect } from "vitest";
import type { Lead } from "@fx/core";
import { confidence3, eventBreadth, exposureLevel, intIn } from "../src/stages/analyse.js";
import { callReadiness } from "../src/stages/call-readiness.js";
import { dedupLeads } from "../src/stages/dedup.js";

describe("AI output is made to fit the event schema before saving", () => {
  it("rounds and clamps numbers, maps labels", () => {
    expect([intIn(7.5, 0, 10), intIn("92.5", 0, 100), intIn(14, 0, 10), intIn("n/a", 0, 10)]).toEqual([8, 93, 10, 0]);
    expect(["Medium-High", "very high", "LOW", "Medium", "huge", ""].map(exposureLevel))
      .toEqual(["High", "Very High", "Low", "Medium", "", ""]);
    expect(eventBreadth("sector-specific", "")).toBe("sector_specific");
    expect(eventBreadth("macro-ish", "Currency move")).toBe("broad_currency");
    expect(eventBreadth(undefined, "Something new")).toBe("sector_specific");
    expect([confidence3("High"), confidence3("certain")]).toEqual(["high", "low"]);
  });
});

describe("call readiness counts FX payment signals only", () => {
  it("three secondary words aren't strong FX evidence", () => {
    const lead = {
      id: "x", priority: "WARM", score: 70, route_grade: "A", website: "https://a.co.uk", website_confidence: "medium",
      fx_payment_signals: [], secondary_signals: ["italian", "french", "german"], signal_count: 3,
    } as unknown as Lead;
    expect(callReadiness(lead).status).not.toBe("READY");
    expect(callReadiness({ ...lead, fx_payment_signals: ["import", "export", "currency"] } as Lead).status).toBe("READY");
  });
});

describe("dedup's multi-event boost counts distinct events", () => {
  const L = (id: string, event_id: string, extra: Partial<Lead> = {}) =>
    ({ id, event_id, company_number: "01234567", company_name: "Acme Ltd", score: 60, priority: "WARM", ...extra }) as Lead;

  it("a CH lead and a web lead from one event get no boost; two events get +4 once", () => {
    const leads: Record<string, Lead> = { a: L("a", "e1"), b: L("b", "e1") };
    expect(dedupLeads(leads).totalAfter).toBe(1);
    expect(Object.values(leads)[0]!.score).toBe(60);
    const two: Record<string, Lead> = { a: L("a", "e1"), b: L("b", "e2") };
    dedupLeads(two);
    const merged = Object.values(two)[0]!;
    expect([merged.score, merged.multi_event_count]).toEqual([64, 2]);
    // next run: scoring already gave the +4 for these two events; merging again adds nothing more
    const again: Record<string, Lead> = { a: { ...merged, id: "a" }, c: L("c", "e2") };
    dedupLeads(again);
    expect(Object.values(again)[0]!.score).toBe(64);
  });
});
