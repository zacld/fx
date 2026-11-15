import { describe, expect, it } from "vitest";
import { PRODUCTS, pitchFor, pitchLine } from "./pitch.js";

describe("What we can pitch them", () => {
  it("matches Investec's products to the company's own facts, each with why", () => {
    const r = { company_number: "1", cash_gbp: "7400000", bank_borrowings_gbp: "12000000", main_currency: "USD", fx_today: "",
      fx_gain_loss_gbp: "-250000", turnover_growth: "+28%", sic_codes: "28290", facility_ends: "March 2027", incumbent_bank: "HSBC UK BANK PLC" };
    const p = pitchFor(r);
    const keys = p.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(["deposits", "fxForwards", "fxOptions", "rateHedging", "refinance", "workingCapital", "assetFinance"]));
    expect(p.find((x) => x.key === "deposits").why).toMatch(/£7\.4m cash/);
    expect(p.find((x) => x.key === "fxForwards").why).toMatch(/no hedging named/);
    expect(p.find((x) => x.key === "refinance").why).toMatch(/March 2027.*HSBC/);
    for (const x of p) expect(x.source).toMatch(/^https:\/\/www\.investec\.com\/en_gb\//);
    expect(pitchLine(r)).toMatch(/^Corporate deposits · /);
  });
  it("pitches nothing it can't back with a fact, and never quotes a rate", () => {
    expect(pitchFor({ company_number: "2" })).toEqual([]);
    expect(pitchFor({ company_number: "3", cash_gbp: "900000" }).length).toBe(0);
    expect(pitchFor({ company_number: "4", cash_gbp: "3000000" })[0].why).toMatch(/below the £5m/);
    for (const prod of Object.values(PRODUCTS)) expect(`${prod.name} ${prod.what}`).not.toMatch(/\d+(\.\d+)?\s*%/);
  });
  it("offers acquisition finance to buyers and PE-backed companies, a competing quote to those already hedging", () => {
    expect(pitchFor({ acquisitions: "Acme GmbH" }).map((x) => x.key)).toContain("acquisitionFinance");
    expect(pitchFor({ pe_backed: "ACME BIDCO LIMITED" }).find((x) => x.key === "acquisitionFinance").why).toMatch(/PE-backed/);
    expect(pitchFor({ main_currency: "EUR", fx_forwards: "Forward contracts to buy €2m" }).find((x) => x.key === "fxForwards").why).toMatch(/quote against/);
  });
});
