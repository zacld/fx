import { describe, it, expect } from "vitest";
import {
  generateEmailGuesses, inferDomainEmailPattern, classifyLocalPart, rankEmailGuessesByPattern,
} from "../src/emails.js";

describe("generateEmailGuesses", () => {
  it("emits the standard patterns and dedupes them", () => {
    const got = generateEmailGuesses("James", "Smith", "acme.com");
    const emails = got.map((g) => g.email);
    expect(emails).toContain("james.smith@acme.com");
    expect(emails).toContain("james@acme.com");
    expect(emails).toContain("j.smith@acme.com");
    expect(emails).toContain("jsmith@acme.com");
    expect(emails).toContain("smith@acme.com");
    expect(emails).toContain("smith.james@acme.com");
    expect(new Set(emails).size).toBe(emails.length);            // no dupes
  });

  it("works with only a last name", () => {
    const got = generateEmailGuesses("", "Smith", "acme.com");
    expect(got.map((g) => g.email)).toContain("smith@acme.com");
  });

  it("strips accents + non-letters", () => {
    const got = generateEmailGuesses("Renée", "O'Brien", "acme.com");
    expect(got.map((g) => g.email)).toContain("renee.obrien@acme.com");
  });

  it("returns [] for empty inputs", () => {
    expect(generateEmailGuesses("", "", "acme.com")).toEqual([]);
    expect(generateEmailGuesses("Jane", "Doe", "")).toEqual([]);
  });
});

describe("classifyLocalPart", () => {
  it("classifies known patterns when a name is supplied", () => {
    expect(classifyLocalPart("joe.smith", "Joe", "Smith")).toBe("first.last");
    expect(classifyLocalPart("jsmith", "Joe", "Smith")).toBe("flast");
    expect(classifyLocalPart("joes", "Joe", "Smith")).toBe("firstl");
    expect(classifyLocalPart("smith", "Joe", "Smith")).toBe("last");
  });
  it("returns null without a name context", () => {
    expect(classifyLocalPart("jsmith")).toBeNull();
  });
});

describe("inferDomainEmailPattern", () => {
  it("identifies first.last from 2+ named emails on a domain", () => {
    const r = inferDomainEmailPattern([
      { email: "joe.smith@acme.com", first: "Joe", last: "Smith" },
      { email: "jane.brown@acme.com", first: "Jane", last: "Brown" },
      { email: "info@acme.com" },                                  // generic — filtered
    ], "acme.com");
    expect(r.pattern).toBe("first.last");
    expect(r.confidence).toBe(1);
    expect(r.evidence_count).toBe(2);
  });

  it("returns mixed evidence with the most common pattern + < 1 confidence", () => {
    const r = inferDomainEmailPattern([
      { email: "joe.smith@acme.com", first: "Joe", last: "Smith" },
      { email: "jane.brown@acme.com", first: "Jane", last: "Brown" },
      { email: "rbailey@acme.com", first: "Robert", last: "Bailey" },   // flast — odd one out
    ], "acme.com");
    expect(r.pattern).toBe("first.last");
    expect(r.confidence).toBeCloseTo(2 / 3, 5);
  });

  it("returns null when no evidence is usable", () => {
    expect(inferDomainEmailPattern([{ email: "info@acme.com" }], "acme.com").pattern).toBeNull();
    expect(inferDomainEmailPattern([], "acme.com").evidence_count).toBe(0);
  });

  it("ignores off-domain emails", () => {
    const r = inferDomainEmailPattern([
      { email: "joe.smith@otherco.com", first: "Joe", last: "Smith" },
    ], "acme.com");
    expect(r.evidence_count).toBe(0);
  });
});

describe("rankEmailGuessesByPattern", () => {
  it("moves the inferred-pattern guess to the front + stamps confidence", () => {
    const guesses = generateEmailGuesses("James", "Smith", "acme.com");
    const ranked = rankEmailGuessesByPattern(guesses, {
      pattern: "flast", confidence: 0.8, evidence_count: 3,
    });
    expect(ranked[0]!.pattern).toBe("flast");
    expect(ranked[0]!.email).toBe("jsmith@acme.com");
    expect(ranked[0]!.pattern_confidence).toBe(0.8);
    // other guesses keep zero confidence
    expect(ranked[1]!.pattern_confidence).toBe(0);
  });
  it("no inferred pattern → input order preserved with zero confidence", () => {
    const guesses = generateEmailGuesses("Jane", "Doe", "acme.com");
    const ranked = rankEmailGuessesByPattern(guesses, { pattern: null, confidence: 0, evidence_count: 0 });
    expect(ranked.map((r) => r.email)).toEqual(guesses.map((g) => g.email));
    expect(ranked.every((r) => r.pattern_confidence === 0)).toBe(true);
  });
});
