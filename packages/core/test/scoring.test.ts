import { describe, it, expect } from "vitest";
import { scoreLead, exposureConfidence, isHardSkipDomain, isKnownBadDomain, isReadyEligible, looksLikePageTitle } from "../src/scoring.js";
import type { Lead } from "../src/schema.js";

function lead(p: Partial<Lead>): Partial<Lead> {
  return p;
}

describe("scoreLead — faithful to rescore.py gates", () => {
  it("a strong active importer with a verified website is HOT", () => {
    const r = scoreLead(lead({
      company_name: "Acme Wine Importers Ltd",
      company_status: "active",
      website: "https://acmewine.co.uk",
      website_confidence: "high",
      website_source: "ddg_search",
      director_name: "Jane Doe",
      incorporated: "2008-04-01",
      sic_codes: ["46342"],
      exposure_level: "Very High",
      exposure_type: "Import cost exposure",
      fx_payment_signals: ["we import", "sourced from", "french suppliers"],
      b2b_signals: ["wholesale", "trade customers"],
      secondary_signals: ["european", "distributor"],
      pays_fx_confirmed: true,
      why_affected: "Imports wine from European producers, invoiced in EUR, revenue in GBP — GBP/EUR moves squeeze margin on each shipment.",
    }), 8);
    expect(r.priority).toBe("HOT");
    expect(r.score).toBeGreaterThanOrEqual(80);
  });

  it("Gate A: no website → SKIP (score ≤ 39)", () => {
    const r = scoreLead(lead({
      company_name: "Some Importers Ltd", company_status: "active",
      sic_codes: ["46342"], exposure_level: "Very High",
      fx_payment_signals: ["we import"], website: null,
    }), 9);
    expect(r.priority).toBe("SKIP");
    expect(r.score).toBeLessThanOrEqual(39);
    expect(r.reasons.some((x) => x.includes("No website"))).toBe(true);
  });

  it("Gate F: dissolved company → SKIP regardless of other evidence", () => {
    const r = scoreLead(lead({
      company_name: "Defunct Wine Importers Ltd", company_status: "dissolved",
      website: "https://defunct.co.uk", website_confidence: "high",
      sic_codes: ["46342"], exposure_level: "Very High",
      fx_payment_signals: ["we import", "sourced from"], b2b_signals: ["wholesale"],
      why_affected: "x".repeat(60),
    }), 9);
    expect(r.priority).toBe("SKIP");
    expect(r.score).toBeLessThanOrEqual(39);
  });

  it("Gate E: association name → SKIP", () => {
    const r = scoreLead(lead({
      company_name: "British Wine & Spirit Trade Association", company_status: "active",
      website: "https://wsta.co.uk", website_confidence: "high",
      fx_payment_signals: ["we import"], b2b_signals: ["wholesale"],
      why_affected: "x".repeat(60),
    }), 8);
    expect(r.priority).toBe("SKIP");
  });

  it("Gate C: HOT-scoring lead with no direct FX → capped at WARM (79)", () => {
    const r = scoreLead(lead({
      company_name: "Acme Distribution Ltd", company_status: "active",
      website: "https://acmedist.co.uk", website_confidence: "high",
      director_name: "Bob Smith", incorporated: "2005-01-01",
      sic_codes: ["46900"], exposure_level: "Very High", exposure_type: "x",
      fx_payment_signals: [], b2b_signals: ["wholesale", "distributor"],
      secondary_signals: ["international", "europe", "supplier"],   // hasIntl via 3 secondary
      why_affected: "x".repeat(60),
    }), 9);
    // strong score but no fx_payment_signals → Gate C caps to 79
    expect(r.priority).toBe("WARM");
    expect(r.score).toBeLessThanOrEqual(79);
  });

  it("Gate I: large org → capped at QUEUE (49)", () => {
    const r = scoreLead(lead({
      company_name: "Massive Drinks Group PLC", company_status: "active",
      website: "https://example.com", website_confidence: "high",
      director_name: "X", incorporated: "1990-01-01",
      sic_codes: ["46342"], exposure_level: "Very High",
      fx_payment_signals: ["we import", "sourced from"], b2b_signals: ["wholesale"],
      pays_fx_confirmed: true, why_affected: "x".repeat(60),
      is_large_org: true,
    }), 9);
    expect(r.score).toBeLessThanOrEqual(49);
    expect(["QUEUE", "SKIP"]).toContain(r.priority);
  });

  it("Gate H: thin exposure thesis → capped at QUEUE (59)", () => {
    const r = scoreLead(lead({
      company_name: "Acme Wine Importers Ltd", company_status: "active",
      website: "https://acmewine.co.uk", website_confidence: "high",
      director_name: "Jane Doe", incorporated: "2008-01-01",
      sic_codes: ["46342"], exposure_level: "Very High",
      fx_payment_signals: ["we import", "sourced from"], b2b_signals: ["wholesale"],
      pays_fx_confirmed: true,
      why_affected: "short", exposure_thesis: "",
    }), 8);
    expect(r.score).toBeLessThanOrEqual(59);
    expect(["QUEUE", "SKIP"]).toContain(r.priority);
  });
});

describe("domain blocklists", () => {
  it("hard-skip catches britannica / supermarkets / consumer wine", () => {
    expect(isHardSkipDomain("https://www.britannica.com/topic/wine")).toBe(true);
    expect(isHardSkipDomain("https://www.tesco.com")).toBe(true);
    expect(isHardSkipDomain("https://acmewine.co.uk")).toBe(false);
  });
  it("known-bad catches trade pubs / aggregators", () => {
    expect(isKnownBadDomain("https://www.thegrocer.co.uk/x")).toBe(true);
    expect(isKnownBadDomain("https://italianfoodnews.com/x")).toBe(true);
    expect(isKnownBadDomain("https://acmewine.co.uk")).toBe(false);
  });
});

describe("looksLikePageTitle", () => {
  it("flags pipe-separated page titles", () => {
    expect(looksLikePageTitle("Boutique French Wine Importer UK | Exclusive French Wines")).toBe(true);
    expect(looksLikePageTitle("Wholesale Fabrics | Oddies Textiles | Order Online")).toBe(true);
    expect(looksLikePageTitle("Home | tropifresh | Exotic Fruit")).toBe(true);
  });
  it("flags 'About Us -' prefixed page titles", () => {
    expect(looksLikePageTitle("About Us - Franceline Transport the French Haulage Specialist")).toBe(true);
  });
  it("flags blog-style titles (How to / Top N / questions)", () => {
    expect(looksLikePageTitle("How to Sell from the UK to the US: 2025 Guide - Xigen")).toBe(true);
    expect(looksLikePageTitle("Top 5 Importers of European Wine")).toBe(true);
    expect(looksLikePageTitle("Why is GBP weakening?")).toBe(true);
  });
  it("flags truncated titles ending in ellipsis", () => {
    expect(looksLikePageTitle("Map Imports (uk) Ltd | Sourcing agent for products...")).toBe(true);
  });
  it("does not flag real company names", () => {
    expect(looksLikePageTitle("ACME WINE IMPORTERS LIMITED")).toBe(false);
    expect(looksLikePageTitle("Dragon Import Services Ltd")).toBe(false);
    expect(looksLikePageTitle("Smith & Oakley Imports Limited")).toBe(false);
  });
});

describe("isReadyEligible", () => {
  const base = {
    website: "https://acmewine.co.uk",
    website_confidence: "high" as const,
    company_number: "12345678",
    company_name: "Acme Wine Importers Ltd",
  };
  it("accepts a confirmed CH-backed company with real name", () => {
    expect(isReadyEligible(base)).toBe(true);
  });
  it("rejects a lead whose company_name is a page title", () => {
    expect(isReadyEligible({ ...base, company_name: "Boutique French Wine Importer | Exclusive Wines" })).toBe(false);
  });
  it("rejects blog/article paths", () => {
    expect(isReadyEligible({ ...base, website: "https://acmewine.co.uk/blog/how-to-source" })).toBe(false);
  });
  it("rejects platform domains", () => {
    expect(isReadyEligible({ ...base, website: "https://acmewine.shopify.com" })).toBe(false);
  });
});

describe("exposureConfidence", () => {
  it("strong evidence → high", () => {
    expect(exposureConfidence({
      fx_payment_signals: ["a", "b"], segment_signals: ["x"], website_confidence: "high",
      exposure_level: "Very High", pays_fx_confirmed: true,
    })).toBe("high");
  });
  it("no evidence → none", () => {
    expect(exposureConfidence({})).toBe("none");
  });
});
