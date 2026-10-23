import { describe, it, expect } from "vitest";
import {
  classifyText, extractContextualFx, extractOriginHints, isLargeOrg,
  ORIGIN_ADJECTIVES, FX_PAYMENT_SIGNALS, SECONDARY_SIGNALS,
} from "../src/signals.js";

describe("signals — nationality adjectives are origin hints, not FX evidence", () => {
  it("bare 'Italian wine' is an origin hint, NOT an FX payment signal", () => {
    const c = classifyText("Buy our Italian Chianti and Spanish Rioja online.");
    expect(c.fxPaymentSignals).toEqual([]);
    expect(c.originHints).toEqual(expect.arrayContaining(["italian", "spanish"]));
    expect(c.paysFx).toBe(false);
  });

  it("'French suppliers' / 'sourced from Germany' ARE contextual FX evidence", () => {
    const c = classifyText("We work with French suppliers and goods are sourced from Germany. We import direct from Italy.");
    expect(c.contextualFx.length).toBeGreaterThan(0);
    expect(c.fxPaymentSignals).toEqual(expect.arrayContaining([expect.stringContaining("french suppliers")]));
    // explicit phrases too
    expect(c.fxPaymentSignals).toEqual(expect.arrayContaining(["direct from", "we import"]));
    expect(c.paysFx).toBe(true);
  });

  it("no bare nationality adjective leaks into FX_PAYMENT_SIGNALS or SECONDARY_SIGNALS", () => {
    for (const adj of ORIGIN_ADJECTIVES) {
      expect(FX_PAYMENT_SIGNALS).not.toContain(adj);
      expect(SECONDARY_SIGNALS).not.toContain(adj);
    }
  });

  it("extractOriginHints / extractContextualFx are whole-word & deduped", () => {
    expect(extractOriginHints("german engineering, GERMANY notes")).toEqual(["german"]);
    expect(extractContextualFx("Italian producers and Italian producers again")).toEqual(["italian producers"]);
  });
});

describe("signals — B2B / negative classification", () => {
  it("picks up B2B and negative phrases", () => {
    const c = classifyText("Wholesale only. Trade customers welcome. Minimum order applies. We are a wedding caterer too.");
    expect(c.b2bSignals).toEqual(expect.arrayContaining(["wholesale", "trade customers", "minimum order"]));
    expect(c.negativeSignals).toEqual(expect.arrayContaining(["wedding"]));
  });
});

describe("signals — large-org detection", () => {
  it("flags PLCs by name", () => {
    expect(isLargeOrg("Big Drinks Group PLC", "https://example.com")).toBe(true);
  });
  it("flags known large-org domains", () => {
    expect(isLargeOrg("Some Wine Ltd", "https://www.hendricksgin.com/range")).toBe(true);
    expect(isLargeOrg("Tesco something", "https://www.tesco.com")).toBe(true);
  });
  it("requires 2+ website phrases (avoids false positives)", () => {
    expect(isLargeOrg("Small Wine Importers Ltd", "https://acmewine.co.uk", "We are publicly traded.")).toBe(false);
    expect(isLargeOrg("Small Wine Importers Ltd", "https://acmewine.co.uk", "We are publicly traded and listed on the London Stock Exchange.")).toBe(true);
  });
  it("does not flag a normal SME importer", () => {
    expect(isLargeOrg("Acme Wine Importers Ltd", "https://acmewine.co.uk", "We import wine from French suppliers.")).toBe(false);
  });
});
