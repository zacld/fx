import { describe, expect, it } from "vitest";
import { crmNote, plain, registeredActivity } from "./crm.js";
import { industryOf, setKnownGroups } from "./format.js";

describe("For CRM note (Zac, 24 Nov 2026)", () => {
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
    const text = crmNote(r, { today });
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
    const text = crmNote(r, { today, note: "FD back Thursday, see https://example.com/page and www.acme.co.uk" });
    expect(text).not.toMatch(/https?:|www\./);
    expect(text.split("\n").at(-1)).toBe("Our notes: FD back Thursday, see and");
    expect(plain("A (Companies House charges register)\n https://x.y/z b")).toBe("A b");
  });
  it("leaves out what the records don't give", () => {
    const text = crmNote({ company_number: "1", company_name: "BARE LTD" }, { today });
    expect(text).not.toMatch(/Bank:|FX loss|Hedging|Finance contact/);
    expect(text.split("\n")[0]).toBe("BARE LTD (Companies House 1)");
    const named = crmNote({ company_number: "2", company_name: "NAMED LTD", main_bank: "Barclays Bank plc" }, { today });
    expect(named).toContain("Bank: Barclays Bank plc - named in its accounts");
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
