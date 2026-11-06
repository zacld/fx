import { describe, expect, it } from "vitest";
import { ASK, INVESTEC_PARAGRAPH, SIGN_OFF, currenciesFor, emailDraft, firstName, naturalCompany, regionsAbroad } from "./email.js";

describe("naturalCompany", () => {
  it("drops the legal suffix, group/holdings, and title-cases capitals", () => {
    expect(naturalCompany("BRITISH BAKELS LIMITED")).toBe("British Bakels");
    expect(naturalCompany("KEPAK GROUP LIMITED")).toBe("Kepak");
    expect(naturalCompany("TENTBOX HOLDINGS LIMITED")).toBe("Tentbox");
    expect(naturalCompany("Swisslog (UK) Ltd")).toBe("Swisslog");
    expect(naturalCompany("L.J. FAIRBURN AND SON LIMITED")).toBe("L.J. Fairburn and Son");
    expect(naturalCompany("HUNT'S FOOD GROUP LTD")).toBe("Hunt's Food");
    expect(naturalCompany("CLOETTA UK LIMITED")).toBe("Cloetta UK");
    expect(naturalCompany("S.A.V. United Kingdom Limited")).toBe("S.A.V. United Kingdom");
    expect(naturalCompany("Meltwater (UK) Limited")).toBe("Meltwater");
  });
});

describe("firstName", () => {
  it("uses a presented finance contact's first name, never a Guess or an initial", () => {
    expect(firstName({ finance_contact: "Alan Metcalfe", finance_contact_confidence: "Confirmed" })).toBe("Alan");
    expect(firstName({ finance_contact: "Mrs Jane Smith", finance_contact_confidence: "Likely" })).toBe("Jane");
    expect(firstName({ finance_contact: "JANE SMITH", finance_contact_confidence: "Verified" })).toBe("Jane");
    expect(firstName({ finance_contact: "J. Smith", finance_contact_confidence: "Verified" })).toBe("");
    expect(firstName({ finance_contact: "Alan Metcalfe", finance_contact_confidence: "Guess" })).toBe("");
    expect(firstName({})).toBe("");
  });
});

describe("regionsAbroad", () => {
  it("keeps the places abroad, largest first, without the UK or catch-alls", () => {
    expect(regionsAbroad("United Kingdom £73.5m · Rest of Europe £5.8m · Rest of the World £1m")).toEqual(["Europe"]);
    expect(regionsAbroad("Rest of World £17.3m · UK & Europe £14.5m · USA £1.4m")).toEqual(["Europe", "the US"]);
    expect(regionsAbroad("United Kingdom £86.1m · France £56.3m · Rest of Europe £34.2m · United States £27.7m · Canada £5m"))
      .toEqual(["France", "Europe", "the US"]);
    expect(regionsAbroad("Africa £24.9m · Europe £938k")).toEqual(["Africa", "Europe"]);
    expect(regionsAbroad("United Kingdom £122m")).toEqual([]);
    expect(regionsAbroad("")).toEqual([]);
  });
});

describe("currenciesFor", () => {
  it("takes the main currency unless it's only the niche's default, then forwards, then the accounts", () => {
    expect(currenciesFor({ main_currency: "USD", currency_source: "forwards" })).toEqual(["USD"]);
    expect(currenciesFor({ main_currency: "EUR", currency_source: "niche" })).toEqual([]);
    expect(currenciesFor({ fx_forwards: "Forward contracts to buy US$9.2m (prior year US$8.1m)" })).toEqual(["USD"]);
    expect(currenciesFor({ currencies_in_accounts: "EUR (buys), USD (buys)" })).toEqual(["EUR", "USD"]);
    expect(currenciesFor({ turnover_regions: "United Kingdom £39m · Europe £9m" })).toEqual(["EUR"]);
  });
});

describe("emailDraft", () => {
  it("fills the master template from the filings and keeps the Investec paragraph and ask as written", () => {
    const { text, gaps, basis } = emailDraft({
      company_name: "BRITISH BAKELS LIMITED", finance_contact: "Alan Metcalfe", finance_contact_confidence: "Confirmed",
      turnover_regions: "United Kingdom £73.5m · Rest of Europe £5.8m · Rest of the World £1m",
      main_currency: "EUR", currency_source: "text", currency_direction: "Buys (importer)",
      fx_forwards: "Forward contracts to buy €2m", fx_gain_loss_gbp: "-1600000",
    });
    expect(text).toBe([
      "Hi Alan,",
      "Given British Bakels’ trading relationships across Europe, I thought it would be worth getting in touch.",
      "With overseas suppliers to pay, I imagine movements in GBP/EUR are a regular consideration. I’d be interested to " +
        "hear how you’re approaching this and explore where Investec might be able to support.",
      INVESTEC_PARAGRAPH, ASK, SIGN_OFF,
    ].join("\n\n"));
    expect(gaps).toEqual([]);
    expect(basis.join(" | ")).toMatch(/turnover note/);
    // researched, not invasive: no forwards, losses or lenders quoted back
    expect(text).not.toMatch(/forward|loss|£|€2m/i);
  });

  it("leaves placeholders, never guesses, when the filings don't say", () => {
    const { text, gaps } = emailDraft({ company_name: "ACME WIDGETS LIMITED", main_currency: "EUR", currency_source: "niche" });
    expect(text).toMatch(/^Hi \[First Name\],/);
    expect(text).toContain("Given Acme Widgets’ international trading relationships");
    expect(text).toContain("movements in [Currency Pair]");
    expect(gaps).toHaveLength(2);
  });

  it("speaks to sellers abroad and names two pairs", () => {
    const { text } = emailDraft({ company_name: "TXO SYSTEMS LTD", currencies_in_accounts: "EUR, USD",
      turnover_regions: "Rest of World £17.3m · UK & Europe £14.5m · USA £1.4m" });
    expect(text).toContain("Given TXO Systems’ trading relationships across Europe and the US");
    expect(text).toContain("With sales coming in from overseas, I imagine movements in GBP/EUR and GBP/USD are");
  });
});
