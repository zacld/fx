import { describe, it, expect } from "vitest";
import {
  htmlToText, extractFxEvidenceSnippets, extractCountryEvidence,
  extractSupplierEvidence, extractImportExportEvidence, extractSizeSignals,
  buildCurrencyReason, generateWebsiteConfidenceReason, extractWebsiteIntel, computeFxLikelihood,
} from "../src/website-intel.js";

describe("htmlToText", () => {
  it("strips tags, script/style, entities, and collapses whitespace", () => {
    const html = `<style>x{}</style><script>alert(1)</script><p>Hello&nbsp;world</p>`;
    expect(htmlToText(html)).toBe("Hello world");
  });
});

describe("extractFxEvidenceSnippets", () => {
  it("scores keyword-rich sentences higher and dedupes near-duplicates", () => {
    const text = "Click here. We import wine direct from Italy and sourcing from France. Our European suppliers ship weekly. Welcome to our shop.";
    const snippets = extractFxEvidenceSnippets(text);
    expect(snippets.some((s) => s.includes("import wine"))).toBe(true);
    expect(snippets.every((s) => !/^click/i.test(s))).toBe(true);
  });
});

describe("extractCountryEvidence", () => {
  it("maps countries to currency pairs only when a sourcing context is nearby", () => {
    const { countries, pairs } = extractCountryEvidence("We import our finest wines from Italy and source cheese from France.");
    expect(countries).toEqual(expect.arrayContaining(["Italy", "France"]));
    expect(pairs).toEqual(expect.arrayContaining(["GBP/EUR"]));
  });

  it("does NOT pick up a country mentioned without trade context", () => {
    const { countries } = extractCountryEvidence("Our HQ is on Italy Road. We sell to UK customers only.");
    expect(countries).toEqual([]);
  });

  it("uses dedicated currency pairs for Sweden, NZ, Brazil etc.", () => {
    expect(extractCountryEvidence("We source from Sweden").pairs).toEqual(["GBP/SEK"]);
    expect(extractCountryEvidence("Importer of New Zealand lamb").pairs).toEqual(["GBP/NZD"]);
    expect(extractCountryEvidence("We import directly from Brazil").pairs).toEqual(["GBP/BRL"]);
  });
});

describe("extractSupplierEvidence", () => {
  it("captures phrases around the supplier pattern", () => {
    const phrases = extractSupplierEvidence("Our Italian suppliers have been with us for decades. We work with French producers across the south.");
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases.some((p) => p.toLowerCase().includes("italian suppliers"))).toBe(true);
  });
});

describe("extractImportExportEvidence", () => {
  it("finds explicit import/export phrases", () => {
    const found = extractImportExportEvidence("We import from Italy and export to over 20 countries. Made in Italy.");
    expect(found.some((p) => /import\s+from/i.test(p))).toBe(true);
    expect(found.some((p) => /made\s+in/i.test(p))).toBe(true);
  });
});

describe("extractSizeSignals", () => {
  it("detects warehouse / nationwide / family business signals", () => {
    const sigs = extractSizeSignals("Family-business established in 1965, with nationwide delivery from our warehouse.");
    expect(sigs).toEqual(expect.arrayContaining(["warehouse", "nationwide", "family business", "long-established"]));
  });
});

describe("buildCurrencyReason", () => {
  it("uses an evidence snippet when available", () => {
    expect(buildCurrencyReason(["Italy"], ["GBP/EUR"], ["We import wine direct from Italy."]))
      .toContain("Website mentions Italy");
    expect(buildCurrencyReason([], [], [])).toBe("");
  });
});

describe("generateWebsiteConfidenceReason", () => {
  it("returns a high-confidence sentence with signal count + source", () => {
    const r = generateWebsiteConfidenceReason({
      website_confidence: "high", website_source: "ddg_search", website_domain: "acmewine.co.uk",
      company_name: "Acme Wine Importers", fx_payment_signals: ["a", "b", "c", "d"],
    });
    expect(r).toMatch(/^High confidence/);
    expect(r).toContain("4 FX/trade signals");
  });
  it("handles guessed / unknown gracefully", () => {
    expect(generateWebsiteConfidenceReason({ website_confidence: "guessed" })).toMatch(/^Guessed/);
    expect(generateWebsiteConfidenceReason({})).toMatch(/^Unknown/);
  });
});

describe("extractWebsiteIntel + computeFxLikelihood", () => {
  it("scores a real-looking importer page > 60", () => {
    const text = "We import wine direct from Italy and France. Our European suppliers ship to our warehouse weekly. Family business since 1965. Wholesale and trade customers welcome.";
    const evidence = extractWebsiteIntel(text);
    expect(evidence.country_evidence.length).toBeGreaterThan(0);
    expect(evidence.fx_evidence_snippets.length).toBeGreaterThan(0);
    expect(computeFxLikelihood(2, evidence, 10)).toBeGreaterThan(60);
  });

  it("an empty page scores 0", () => {
    expect(computeFxLikelihood(0, extractWebsiteIntel(""), 0)).toBe(0);
  });
});
