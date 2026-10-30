import { describe, it, expect } from "vitest";
import { computeReadyScore, multiEventBoost, scoreLead } from "../src/scoring.js";

// A lead with plenty of FX evidence, a contact route and a long exposure thesis: HOT on its merits.
type Input = Parameters<typeof scoreLead>[0];
const strong: Input = {
  company_name: "Acme Imports Ltd", website: "https://acme-imports.co.uk", website_confidence: "high",
  website_source: "search", fx_payment_signals: ["import", "imported from", "overseas supplier", "EUR invoice", "currency"],
  secondary_signals: [], b2b_signals: ["wholesale", "trade customers", "distributor"], sic_codes: ["46390"],
  exposure_level: "Very High", exposure_type: "importer", pays_fx_confirmed: true, company_status: "active",
  director_name: "Jo Bloggs", contact_phone: "+44 20 7946 0000", incorporated: "2001-01-01",
  why_affected: "Buys most of its stock from Italian and Spanish suppliers invoiced in euros.",
  exposure_thesis: "GBP revenue against EUR supplier costs: a weaker pound raises every invoice.",
};

describe("scoring fixes from the review", () => {
  it("caps a low-confidence or name-guessed website below WARM (Gate K)", () => {
    expect(scoreLead({ ...strong }, 8).priority).toBe("HOT");
    for (const website_confidence of ["low", "guessed"]) {
      const r = scoreLead({ ...strong, website_confidence } as Input, 8);
      expect(r.score).toBeLessThanOrEqual(59);
      expect(r.priority).toBe("QUEUE");
      expect(r.reasons.join(" ")).toMatch(/Website not verified/);
    }
    expect(scoreLead({ ...strong, website_confidence: null } as Input, 8).priority).toBe("HOT");   // older leads: unchanged
  });

  it("keeps the multi-event bonus on every run, by distinct events", () => {
    expect([1, 2, 3, 4].map(multiEventBoost)).toEqual([0, 4, 8, 8]);
    const base = scoreLead({ ...strong, website_confidence: "medium", pays_fx_confirmed: false } as Input, 0).score;
    const linked = scoreLead({ ...strong, website_confidence: "medium", pays_fx_confirmed: false,
                               linked_event_ids: ["e1", "e2", "e2"] } as never, 0);
    expect(linked.score).toBe(Math.min(100, base + 4));                       // two distinct events, not three rows
    expect(linked.reasons.join(" ")).toMatch(/2 separate events/);
  });

  it("gives the verified-email credit only to a verified address", () => {
    const lead = { ...strong, priority: "HOT", contact_email: "", decision_makers: [] } as never;
    const guessed = computeReadyScore({ ...(lead as object), decision_makers: [{ email_candidate: "jo@acme.co.uk" }] } as never);
    const verified = computeReadyScore({ ...(lead as object), decision_makers: [{ email_candidate: "jo@acme.co.uk", email_verified: true }] } as never);
    expect(verified - guessed).toBe(3);                                         // +8 (phone + verified) vs +5 (phone + email)
  });
});
