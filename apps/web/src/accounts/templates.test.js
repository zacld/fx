import { describe, expect, it } from "vitest";
import { STEP_TEMPLATES, TEMPLATES, fillTemplate, stepTemplate } from "./templates.js";

const r = { company_number: "1", company_name: "ACME WIDGETS LIMITED", finance_contact: "Jane Smith", finance_contact_confidence: "Confirmed",
  turnover_growth: "+28%", main_currency: "USD", currency_source: "forward contracts in the accounts" };

describe("Email templates for the sequence", () => {
  it("fills the personalised FX email from the records, saying where each part came from", () => {
    const e = fillTemplate("personal", r, { USD: { "3m": -4.12, "1m": 1 } });
    expect(e.text).toMatch(/^Morning Jane,/);
    expect(e.text).toMatch(/Acme Widgets's accounts|Acme Widgets’s accounts|ACME|Acme/);
    expect(e.text).toMatch(/\(\+28% on last year\)/);
    expect(e.text).toMatch(/GBP\/USD has moved 4\.1% over the past 3 months/);
    expect(e.sources.join(" ")).toMatch(/ECB/);
  });
  it("leaves placeholders when the records can't support a part", () => {
    const e = fillTemplate("personal", { company_name: "ACME LIMITED" }, {});
    expect(e.text).toMatch(/^Morning \[First name\],/);
    expect(e.text).toMatch(/a real exposure to currency risk/);
    expect(e.text).toMatch(/\[GBP\/currency\]/);
  });
  it("starts each route's email steps with the right template, and keeps no names from the originals", () => {
    expect([stepTemplate("post", 1), stepTemplate("post", 3), stepTemplate("email", 1), stepTemplate("call", 8)]).toEqual(["choc1", "choc2", "generic", "fxdesk"]);
    expect(stepTemplate("email", 18)).toBe("");
    for (const [k, t] of Object.entries(TEMPLATES)) {
      const text = t.text({ first: "[First name]", company: "[Company]", growth: "", swing: "x" });
      expect(text, k).not.toMatch(/Matthew|Simon|Aaron|Amanda|Steve|Bri-Stor|Inventus|First Point/);
    }
    expect(Object.keys(STEP_TEMPLATES)).toEqual(["post", "cold"]);
  });
});
