import { describe, expect, it } from "vitest";
import { bankUrl, contactGroup, factUrl, filterRows, fxLine, fxShare, googleFd, hasConfirmedFd, isFinanceDirector, isNew, money, sortContacted, sortRows, toCsv, wallet } from "./format.js";

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
    expect(filterRows(rows, { contact: "No one named" }).map((r) => r.rank)).toEqual([3]);
    expect(filterRows(rows, { query: "natco" }).map((r) => r.rank)).toEqual([2]);
    expect(filterRows(rows, { section: "Above" }).map((r) => r.rank)).toEqual([3]);
    expect(filterRows(rows, { triggersOnly: true }).map((r) => r.rank)).toEqual([1]);
    const withOut = [...rows, { rank: 4, section: "Core", company_name: "OUT LTD", qualified: "Out" }];
    expect(filterRows(withOut).map((r) => r.rank)).toEqual([1, 2, 3]);                    // "Out" hidden by default
    expect(filterRows(withOut, { showOut: true }).map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(sortRows(rows, "turnover").map((r) => r.rank)).toEqual([2, 1, 3]);
    expect(sortRows(rows, "confidence").map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("groups by who is named, hottest confirmed first, then our score", () => {
    const list = [
      { rank: 1, finance_contact: "A", finance_contact_confidence: "Likely" },
      { rank: 2 },
      { rank: 3, finance_contact: "C", finance_contact_confidence: "Verified" },
      { rank: 4, finance_contact: "D", finance_contact_confidence: "Guess" },
      { rank: 5, finance_contact: "E", finance_contact_confidence: "Confirmed" },
    ];
    expect(list.map(contactGroup)).toEqual(["Guess", "No one named", "Confirmed", "Guess", "Confirmed"]);
    expect(sortRows(list).map((r) => r.rank)).toEqual([3, 5, 1, 4, 2]);
    expect(sortRows(list, "rank").map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(filterRows(list, { contact: "Confirmed" }).map((r) => r.rank)).toEqual([3, 5]);
  });

  it("labels the latest scan's additions new and filters recent FX losses", () => {
    const list = [
      { rank: 1, first_seen: "2026-10-28T06:00:00+00:00", recent_fx_loss: "£150,512 FX loss, accounts filed 2026-09-12" },
      { rank: 2, first_seen: "2026-10-20T06:00:00+00:00" },
      { rank: 3 },
    ];
    const madeAt = "2026-10-28T06:00:00+00:00";
    expect(list.map((r) => isNew(r, madeAt))).toEqual([true, false, false]);
    expect(isNew(list[0], "")).toBe(false);
    expect(filterRows(list, { newOnly: true, madeAt }).map((r) => r.rank)).toEqual([1]);
    expect(filterRows(list, { fxLossOnly: true }).map((r) => r.rank)).toEqual([1]);
  });

  it("moves contacted companies off the list into the contacted view, latest first", () => {
    const list = [{ rank: 1, company_number: "01" }, { rank: 2, company_number: "02" }, { rank: 3, company_number: "03" }];
    const contacted = { "01": { at: "2026-10-27T09:00:00Z" }, "03": { at: "2026-10-28T09:00:00Z" } };
    expect(filterRows(list, { contacted }).map((r) => r.rank)).toEqual([2]);
    const done = filterRows(list, { contacted, view: "contacted" });
    expect(sortContacted(done, contacted).map((r) => r.rank)).toEqual([3, 1]);
  });

  it("sorts by largest FX loss, then gains, then no figure", () => {
    const rows = [
      { rank: 1, fx_gain_loss_gbp: "-50000", turnover_gbp: "40000000" },
      { rank: 2, fx_gain_loss_gbp: "" },
      { rank: 3, fx_gain_loss_gbp: "120000" },
      { rank: 4, fx_gain_loss_gbp: "-900000", turnover_gbp: "60000000" },
      { rank: 5, fx_gain_loss_gbp: "30000" },
    ];
    expect(sortRows(rows, "fxLoss").map((r) => r.rank)).toEqual([4, 1, 3, 5, 2]);
    expect(fxShare(rows[3])).toBe("1.5% of turnover");
    expect(fxShare(rows[0])).toBe("0.1% of turnover");
    expect(fxShare({ fx_gain_loss_gbp: "-1000", turnover_gbp: "50000000" })).toBe("<0.1% of turnover");
    expect(fxShare(rows[2])).toBe("");
    expect(fxLine({ ...rows[3], fx_gain_loss_prior_gbp: "-400000" })).toBe("−£900k loss (1.5% of turnover; prior year −£400k)");
  });

  it("links each fact to the record it came from", () => {
    const r = {
      accounts_url: "https://ch/acc", fx_gain_loss_url: "https://ch/acc#page=22", incumbent_bank_url: "https://ch/charge",
      main_bank: "HSBC", incumbent_bank: "HSBC: all-assets debenture since 1 Jan 2020 (Companies House charges register)",
    };
    expect(bankUrl(r)).toBe("https://ch/charge");                                 // the bank holding the debenture
    expect(bankUrl({ ...r, main_bank: "Barclays" })).toBe("https://ch/acc");      // named in the accounts' Bankers line
    expect(factUrl(r, "FX loss of £420k on the latest accounts")).toBe("https://ch/acc#page=22");
    expect(factUrl(r, "New charge to Lloyds registered 3 months ago")).toBe("https://ch/charge");
    expect(factUrl(r, "Turnover grew 24% last year")).toBe("https://ch/acc");
    expect(factUrl(r, "New finance director appointed")).toBe("");
    expect(factUrl({}, "FX loss of £420k")).toBe("");                              // older lists: no link
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
