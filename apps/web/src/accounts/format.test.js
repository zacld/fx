import { describe, expect, it } from "vitest";
import { filterRows, googleFd, hasConfirmedFd, isFinanceDirector, money, sortRows, toCsv, wallet } from "./format.js";

const rows = [
  { rank: 1, section: "Core", company_name: "L.J. FAIRBURN AND SON LIMITED", finance_contact: "Alan Metcalfe",
    finance_contact_role: "Finance Director", finance_contact_confidence: "Confirmed", turnover_gbp: "116362737",
    fx_wallet_low_gbp: "43700000", fx_wallet_high_gbp: "94400000", currency_pairs: "GBP/EUR|GBP/USD",
    triggers: "HSBC facility from 2022-10 — renewal is near" },
  { rank: 2, section: "Core", company_name: "NATCO FOODS LIMITED", finance_contact: "Devinder Shinh",
    finance_contact_role: "Financial Controller", finance_contact_confidence: "Confirmed", turnover_gbp: "300000000",
    currency_pairs: "GBP/USD" },
  { rank: 3, section: "Above", company_name: "QUATRA UK LTD", currency_pairs: "GBP/EUR", call_angle: 'Say "hi", then' },
];

describe("accounts helpers", () => {
  it("formats money", () => {
    expect(money("116362737")).toBe("£116.4m");
    expect(money("-1925")).toBe("−£2k");
    expect(money("")).toBe("");
    expect(wallet(rows[0])).toBe("£43.7m–£94.4m");
  });

  it("tells a finance director from a controller", () => {
    expect(isFinanceDirector("Finance & Administration Director")).toBe(true);
    expect(isFinanceDirector("Group CFO")).toBe(true);
    expect(isFinanceDirector("Financial Controller")).toBe(false);
    expect(rows.map(hasConfirmedFd)).toEqual([true, false, false]);
  });

  it("filters and sorts", () => {
    expect(filterRows(rows, { fdOnly: true }).map((r) => r.rank)).toEqual([1]);
    expect(filterRows(rows, { pair: "GBP/USD" }).map((r) => r.rank)).toEqual([1, 2]);
    expect(filterRows(rows, { confidence: "none" }).map((r) => r.rank)).toEqual([3]);
    expect(filterRows(rows, { query: "natco" }).map((r) => r.rank)).toEqual([2]);
    expect(filterRows(rows, { section: "Above" }).map((r) => r.rank)).toEqual([3]);
    expect(filterRows(rows, { triggersOnly: true }).map((r) => r.rank)).toEqual([1]);
    const withOut = [...rows, { rank: 4, section: "Core", company_name: "OUT LTD", qualified: "Out" }];
    expect(filterRows(withOut).map((r) => r.rank)).toEqual([1, 2, 3]);                    // "Out" hidden by default
    expect(filterRows(withOut, { showOut: true }).map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(sortRows(rows, "turnover").map((r) => r.rank)).toEqual([2, 1, 3]);
    expect(sortRows(rows, "confidence").map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("searches Google for the company's finance director", () => {
    expect(googleFd(rows[0])).toBe("https://www.google.com/search?q=L.J.+FAIRBURN+AND+SON+finance+director");
    expect(googleFd({ company_name: "Babystyle Ltd." })).toBe("https://www.google.com/search?q=Babystyle+finance+director");
  });

  it("exports CSV with quoting", () => {
    const csv = toCsv([rows[2]], ["company_name", "call_angle"]);
    expect(csv).toBe('company_name,call_angle\nQUATRA UK LTD,"Say ""hi"", then"');
  });
});
