import { describe, expect, it } from "vitest";
import { crmDetail, crmNote, plain, registeredActivity, sameBank } from "./crm.js";
import { industryOf, setKnownGroups } from "./format.js";

describe("For CRM, full detail (Zac, 24 Nov 2026)", () => {
  const today = new Date("2026-11-24T12:00:00Z");
  const r = { company_number: "09000001", company_name: "GLOBAL CHARTER SERVICES LIMITED", sic_codes: ["51102"], fx_gain_loss_gbp: "-96000",
    fx_gain_loss_prior_gbp: "12000", accounts_filed_on: "2026-09-28", overseas_turnover_share: "62%", main_currency: "USD", currency_direction: "Sells (exporter)",
    currency_source: "currency named in accounts", turnover_gbp: "48000000", turnover_growth: "+54%", employees: "212",
    incumbent_bank: "HSBC UK BANK PLC: all-assets debenture since 12 Mar 2021 (Companies House charges register)", bank_type: "clearing",
    lenders: "HSBC UK BANK PLC: all-assets debenture, registered 12 Mar 2021 | CLOSE BROTHERS LIMITED: asset finance, registered 3 Oct 2026 (Companies House charges register)",
    cash_gbp: "3100000", auditor: "BDO LLP", finance_contact: "Jane Smith", finance_contact_role: "Finance Director", finance_contact_confidence: "Confirmed",
    accounts_url: "https://find-and-update.company-information.service.gov.uk/company/09000001/filing-history",
    incumbent_bank_url: "https://find-and-update.company-information.service.gov.uk/company/09000001/charges/abc",
    lead_flags: { newFd: true, fdWhy: "New finance director (Jane Smith appointed 3 Nov 2026)" } };

  it("puts who they bank with, the FX and the rest in plain lines", () => {
    const text = crmDetail(r, { today });
    const lines = text.split("\n");
    expect(lines[0]).toBe("GLOBAL CHARTER SERVICES LIMITED (Companies House 09000001)");
    expect(lines[1]).toBe("Industry: Non-scheduled passenger air transport (SIC 51102)");   // the register's own words
    expect(lines).toContain("Bank: HSBC UK BANK PLC (clearing) - all-assets debenture since 12 Mar 2021");
    expect(lines).toContain("Other lenders: CLOSE BROTHERS LIMITED: asset finance, registered 3 Oct 2026");   // the bank itself isn't repeated
    expect(lines).toContain("FX loss: £96k in the accounts filed 28 Sept 2026 (a £12k gain the year before)");
    expect(lines).toContain("Main currency: USD (sells) - from currency named in accounts");
    expect(lines).toContain("Hedging: none named in its accounts");
    expect(lines).toContain("Turnover: £48.0m, up 54% on the year before");
    expect(lines).toContain("Finance contact: Jane Smith, Finance Director (Confirmed)");
    expect(lines).toContain("New finance director: Jane Smith appointed 3 Nov 2026");
    expect(lines.at(-1)).toBe("Source: public records (Companies House accounts and charges register), 24 Nov 2026");
  });
  it("has no links anywhere, even from his own note, which comes last", () => {
    const text = crmDetail(r, { today, note: "FD back Thursday, see https://example.com/page and www.acme.co.uk" });
    expect(text).not.toMatch(/https?:|www\./);
    expect(text.split("\n").at(-1)).toBe("Our notes: FD back Thursday, see and");
    expect(plain("A (Companies House charges register)\n https://x.y/z b")).toBe("A b");
  });
  it("leaves out what the records don't give", () => {
    const text = crmDetail({ company_number: "1", company_name: "BARE LTD" }, { today });
    expect(text).not.toMatch(/Bank:|FX loss|Hedging|Finance contact/);
    expect(text.split("\n")[0]).toBe("BARE LTD (Companies House 1)");
    const named = crmDetail({ company_number: "2", company_name: "NAMED LTD", main_bank: "Barclays Bank plc" }, { today });
    expect(named).toContain("Bank: Barclays Bank plc - named in its accounts");
  });
});

describe("For CRM summary (Zac, 25 Nov 2026: \"way more summarised, because that's what I'm gonna be reading\")", () => {
  const r = { company_number: "09000001", company_name: "GLOBAL CHARTER SERVICES LIMITED", sic_codes: ["51102"], fx_gain_loss_gbp: "-96000",
    fx_gain_loss_prior_gbp: "12000", accounts_filed_on: "2026-09-28", overseas_turnover_share: "62%", main_currency: "USD", currency_direction: "Sells (exporter)",
    currency_source: "currency named in accounts", turnover_gbp: "48000000", turnover_growth: "+54%", employees: "212",
    incumbent_bank: "HSBC: all-assets debenture since 12 Mar 2021 (Companies House charges register)", main_bank: "HSBC", bank_type: "high-street",
    lenders: "HSBC UK BANK PLC: all-assets debenture, registered 12 Mar 2021 | CLOSE BROTHERS LIMITED: asset finance, registered 3 Oct 2026 (Companies House charges register)",
    cash_gbp: "3100000", auditor: "BDO LLP", finance_contact: "Jane Smith", finance_contact_role: "Finance Director", finance_contact_confidence: "Confirmed",
    accounts_url: "https://find-and-update.company-information.service.gov.uk/company/09000001/filing-history",
    lead_flags: { newFd: true, fdWhy: "New finance director (Jane Smith appointed 3 Nov 2026)" } };

  it("is a few short lines: who, bank, FX, why now, contact, pitch", () => {
    const lines = crmNote(r).split("\n");
    expect(lines).toEqual([
      "GLOBAL CHARTER SERVICES LIMITED (CH 09000001)",
      "Non-scheduled passenger air transport (SIC 51102). £48.0m turnover (up 54%), 212 staff.",
      "Bank: HSBC (debenture since Mar 2021); also CLOSE BROTHERS LIMITED (asset finance); cash £3.1m.",
      "FX: £96k loss in accounts filed Sept 2026, after a £12k gain; sells in USD; 62% of sales abroad; no hedging named.",
      "Why now: New finance director (Jane Smith appointed 3 Nov 2026).",
      "Contact: Jane Smith, Finance Director (Confirmed).",
      "Pitch: Corporate deposits, FX spot and forwards, Working capital.",
    ]);
    expect(crmNote(r).length).toBeLessThan(crmDetail(r).length * 0.7);   // the auditor, source and the like stay in the full detail
    expect(crmDetail(r)).toContain("Auditor: BDO LLP");
  });
  it("leads the FX line with its FX a year when the finder estimated it (the desk's £5m+ measure)", () => {
    const fx = crmNote({ ...r, fx_wallet_low_gbp: "3600000", fx_wallet_high_gbp: "7200000", fx_wallet_basis: "imports 40–80% of cost of sales" })
      .split("\n").find((l) => l.startsWith("FX:"));
    expect(fx).toBe("FX: About £3.6m–£7.2m a year (estimate); £96k loss in accounts filed Sept 2026, after a £12k gain; sells in USD; 62% of sales abroad; no hedging named.");
    expect(crmDetail({ ...r, fx_wallet_low_gbp: "3600000", fx_wallet_high_gbp: "7200000", fx_wallet_basis: "imports 40–80% of cost of sales" }))
      .toContain("FX a year (estimate): £3.6m–£7.2m - imports 40–80% of cost of sales");
  });
  it("has no links, and his own note comes last", () => {
    const text = crmNote(r, { note: "FD back Thursday, see https://example.com/page" });
    expect(text).not.toMatch(/https?:|www\./);
    expect(text.split("\n").slice(-2)).toEqual(["", "Our notes: FD back Thursday, see"]);
  });
  it("says who owns it, and where FX is likely decided when that's abroad", () => {
    const abroad = crmNote({ ...r, ultimate_parent: "ACME GMBH", ultimate_parent_country: "Germany" }).split("\n")[1];
    expect(abroad).toMatch(/212 staff\. Owned from Germany \(ACME GMBH\), (ask where FX is decided|FX likely run from abroad|decides FX in the UK)\.$/);
    expect(crmNote({ ...r, ultimate_parent: "GLOBAL CHARTER GROUP LIMITED", ultimate_parent_country: "England" }).split("\n")[1])
      .toMatch(/UK-owned \(part of GLOBAL CHARTER GROUP LIMITED\)\.$/);
  });
  it("falls back to customs records and a size estimate, and leaves out what the records don't give", () => {
    expect(crmNote({ company_number: "1", company_name: "BARE LTD" })).toBe("BARE LTD (CH 1)");
    const lines = crmNote({ company_number: "2", company_name: "TRADER LTD", sic: ["46330"], size_estimate: "likely £16m–£26m",
      hmrc_trade: "HMRC customs records: imports in 12 of the last 24 months, exports in 3 (goods: dairy) (matched on the registered name)" }).split("\n");
    expect(lines[1]).toBe("Wholesale of dairy products, eggs and edible oils and fats (SIC 46330). Turnover likely £16m–£26m (estimate).");
    expect(lines[2]).toBe("FX: Customs records show imports in 12 of the last 24 months, exports in 3 (goods: dairy).");
    expect(crmNote({ company_number: "3", company_name: "NAMED LTD", main_bank: "Barclays" })).toContain("Bank: Barclays (named in its accounts).");
  });
  it("doesn't list the bank again under its other names", () => {
    expect(sameBank("NATIONAL WESTMINSTER BANK PLC", "NatWest")).toBe(true);
    expect(sameBank("LOMBARD NORTH CENTRAL PLC", "NatWest")).toBe(true);
    expect(sameBank("BANK OF SCOTLAND PLC", "Lloyds")).toBe(true);
    expect(sameBank("THE ROYAL BANK OF SCOTLAND PLC", "Lloyds")).toBe(false);
    const bank = crmNote({ company_number: "4", company_name: "X LTD", incumbent_bank: "NatWest: all-assets debenture since 3 Oct 2024",
      lenders: "NATIONAL WESTMINSTER BANK PLC: all-assets debenture, 3 Oct 2024; ARES MANAGEMENT LIMITED: all-assets debenture, 1 Feb 2025" }).split("\n")[1];
    expect(bank).toBe("Bank: NatWest (debenture since Oct 2024); also ARES MANAGEMENT LIMITED (all-assets debenture).");
    expect(crmNote({ company_number: "5", company_name: "Y LTD", lenders: "CLOSE BROTHERS LIMITED: asset finance, 1 Feb 2025", cash_gbp: "900000" }))
      .toContain("Lenders: CLOSE BROTHERS LIMITED (asset finance); cash £900k.");
  });
});

describe("Industry in the register's own words (Zac, 24 Nov 2026: the industry groups were wrong)", () => {
  it("skips a generic first code for the telling one, at most two", () => {
    expect(registeredActivity({ company_number: "1", sic_codes: "46190|10512" })).toBe("Butter and cheese production (SIC 10512)");
    expect(industryOf({ company_number: "1", sic_codes: "46190|10512" })).toBe("Manufacturing: food, drink & tobacco");
    expect(registeredActivity({ company_number: "2", sic: ["46330", "10512", "46390"] }))
      .toBe("Wholesale of dairy products, eggs and edible oils and fats (SIC 46330); Butter and cheese production (SIC 10512)");
    expect(registeredActivity({ company_number: "3", sic_codes: "1110" })).toBe("Growing of cereals (except rice), leguminous crops and oil seeds (SIC 01110)");
  });
  it("keeps a generic code when it's all there is, and says a holding company's group trades in its subsidiaries' line", () => {
    expect(registeredActivity({ company_number: "4", sic_codes: "70100" })).toBe("Activities of head offices (SIC 70100)");
    setKnownGroups({ "5": { top: "5", activity: { sic: ["52290"], subs: 3 } } });
    expect(registeredActivity({ company_number: "5", sic_codes: "64209" })).toBe("holding company - its group trades in Other transportation support activities (SIC 52290)");
    setKnownGroups({});
    expect(registeredActivity({ company_number: "6" })).toBe("");
  });
});
