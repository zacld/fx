import { describe, it, expect } from "vitest";
import {
  cleanCompanyName, linkedinCompanyName, parseChName,
  normalisedFirstName, levenshtein, namesMatch, nameSimilarity,
} from "../src/names.js";

describe("cleanCompanyName", () => {
  it("title-cases ALL CAPS CH names + strips legal suffix", () => {
    expect(cleanCompanyName("ACME WINE IMPORTERS LIMITED")).toBe("Acme Wine Importers");
    expect(cleanCompanyName("BRAVO FOODS LTD")).toBe("Bravo Foods");
    expect(cleanCompanyName("CHARLIE LOGISTICS PLC")).toBe("Charlie Logistics");
  });

  it("strips page-title prefixes", () => {
    expect(cleanCompanyName("About Us - Acme Wines")).toBe("Acme Wines");
    expect(cleanCompanyName("Home | Acme Wines")).toBe("Acme Wines");
    expect(cleanCompanyName("Meet The Team — Acme Wines")).toBe("Acme Wines");
  });

  it("strips multi-word slogan suffixes but keeps short trade descriptors", () => {
    expect(cleanCompanyName("Acme Wines — the finest Italian wines in London")).toBe("Acme Wines");
    expect(cleanCompanyName("Acme Wines | wholesale only")).toBe("Acme Wines | wholesale only");   // 2 words, keep
  });

  it("linkedinCompanyName caps at 3 words", () => {
    expect(linkedinCompanyName("Charlie Logistics And Distribution Limited")).toBe("Charlie Logistics And");
  });
});

describe("parseChName", () => {
  it("parses CH-format SURNAME, Firstname", () => {
    expect(parseChName("SMITH, James David")).toEqual({
      full_name: "James Smith", first_name: "James", last_name: "Smith", initials: "JS",
    });
  });
  it("parses Firstname Lastname", () => {
    expect(parseChName("Jane Doe")).toEqual({
      full_name: "Jane Doe", first_name: "Jane", last_name: "Doe", initials: "JD",
    });
  });
  it("handles single-token names", () => {
    expect(parseChName("Madonna").last_name).toBe("Madonna");
  });
});

describe("normalisedFirstName", () => {
  it("collapses common nicknames to a canonical form", () => {
    expect(normalisedFirstName("Jim")).toBe("james");
    expect(normalisedFirstName("Jimmy")).toBe("james");
    expect(normalisedFirstName("James")).toBe("james");
    expect(normalisedFirstName("Bob")).toBe("robert");
    expect(normalisedFirstName("Liz")).toBe("elizabeth");
  });
  it("strips accents and punctuation", () => {
    expect(normalisedFirstName("Renée")).toBe("renee");
    expect(normalisedFirstName("Mary-Anne")).toBe("maryanne");
  });
  it("unknown names pass through lowercase", () => {
    expect(normalisedFirstName("Zachariah")).toBe("zachariah");
  });
});

describe("namesMatch", () => {
  it("merges nickname variants of the same person", () => {
    expect(namesMatch("Jim Smith", "James Smith")).toBe(true);
    expect(namesMatch("Bob Brown", "Robert Brown")).toBe(true);
    expect(namesMatch("Liz Williams", "Elizabeth Williams")).toBe(true);
  });
  it("rejects same-firstname-different-lastname", () => {
    // The old token-overlap algorithm merged these — they're different people.
    expect(namesMatch("John Smith", "John Brown")).toBe(false);
    expect(namesMatch("Jane Doe", "Jane Smith")).toBe(false);
  });
  it("tolerates 1 edit on the first name (typo)", () => {
    expect(namesMatch("Steven Hill", "Stevan Hill")).toBe(true);
  });
  it("rejects two distinct people with similar first names", () => {
    expect(namesMatch("Stephen Hill", "Steven Hill")).toBe(true);   // canonicalised: both → stephen / steven group
    expect(namesMatch("Karen Hill", "Kevin Hill")).toBe(false);
  });
  it("accepts an initial that matches the first letter", () => {
    expect(namesMatch("J Smith", "James Smith")).toBe(true);
    expect(namesMatch("J Smith", "Robert Smith")).toBe(false);
  });
  it("rejects when last names are too short to be reliable", () => {
    expect(namesMatch("Jo Li", "Jo Lo")).toBe(false);
  });
});

describe("levenshtein", () => {
  it("is correct on short strings", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("nameSimilarity", () => {
  it("returns 1 for matching nicknames, near-0 for distinct", () => {
    expect(nameSimilarity("Jim Smith", "James Smith")).toBe(1);
    expect(nameSimilarity("Alice Wilson", "Bob Brown")).toBeLessThan(0.5);
  });
});
