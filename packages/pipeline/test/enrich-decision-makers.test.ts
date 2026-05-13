import { describe, it, expect } from "vitest";
import { computeRouteGrade, computeContactConfidence } from "../src/stages/enrich-decision-makers.js";
import type { DecisionMaker } from "@fx/core";

function dm(p: Partial<DecisionMaker>): DecisionMaker {
  return {
    name: p.name ?? "Test Person", first_name: p.first_name ?? "Test", last_name: p.last_name ?? "Person",
    role: p.role ?? "", tier: p.tier ?? 3, tier_label: p.tier_label ?? "Fallback",
    appointed_on: null, email: p.email ?? null, email_source: p.email_source ?? null,
    email_verified: p.email_verified ?? null, email_guesses: p.email_guesses ?? [],
    phone: null, linkedin_search: null, linkedin_name_only: null, google_email_search: null,
    source: "companies_house",
  };
}

describe("computeRouteGrade", () => {
  it("A: Tier-1 person + verified email", () => {
    const dms = [dm({ tier: 1, tier_label: "Primary", email: "fd@x.co", email_verified: true })];
    expect(computeRouteGrade({}, dms)).toBe("A");
  });

  it("A: Tier-1 person + phone (no email needed)", () => {
    expect(computeRouteGrade({ contact_phone: "020 ..." }, [dm({ tier: 1, tier_label: "Primary" })])).toBe("A");
  });

  it("B: Tier-1 + guessed email only", () => {
    expect(computeRouteGrade({}, [dm({ tier: 1, tier_label: "Primary", email_guesses: [{ email: "x@y", pattern: "first", smtp_verified: null, catch_all: false, pattern_confidence: 0 }] })])).toBe("B");
  });

  it("C: any person + phone", () => {
    expect(computeRouteGrade({ contact_phone: "x" }, [dm({ tier: 3 })])).toBe("C");
  });

  it("D: phone only (no person)", () => {
    expect(computeRouteGrade({ contact_phone: "x" }, [])).toBe("D");
  });

  it("E: website only", () => {
    expect(computeRouteGrade({ website: "https://x" }, [])).toBe("E");
  });

  it("F: nothing", () => {
    expect(computeRouteGrade({}, [])).toBe("F");
  });
});

describe("computeContactConfidence", () => {
  it("Tier-1 + verified email + phone = ≥ 85", () => {
    const dms = [dm({ tier: 1, email: "x@y", email_verified: true })];
    expect(computeContactConfidence({ contact_phone: "x" }, dms)).toBeGreaterThanOrEqual(85);
  });

  it("nothing = 0", () => {
    expect(computeContactConfidence({}, [])).toBe(0);
  });

  it("Tier-2 with guessed email = 22 + 14 = 36", () => {
    expect(computeContactConfidence({}, [dm({ tier: 2, email_guesses: [{ email: "x@y", pattern: "first", smtp_verified: null, catch_all: false, pattern_confidence: 0 }] })])).toBe(36);
  });
});
