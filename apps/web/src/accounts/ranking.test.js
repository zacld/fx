import { describe, expect, it } from "vitest";
import { FILINGS_SECTION, nicheLearnings, rankLeads } from "./ranking.js";

describe("rankLeads", () => {
  const today = new Date("2026-11-10T12:00:00Z");
  const list = [{ company_number: "L1", company_name: "LISTED LTD", filed_fx_score: 60, turnover_gbp: "40000000", fx_niche: "Nuts" }];
  const filings = [
    { company_number: "L1", company_name: "LISTED LTD", filed_fx_score: 60 },
    { company_number: "F1", company_name: "LOSS LTD", filed: "2026-10-01", filed_fx_score: 70, fx_gain_loss_gbp: "-300000",
      turnover_gbp: "50000000", fx_mentions: ["long text"], directors: "A PERSON" },
    { company_number: "F2", company_name: "EBURY PARTNERS UK LIMITED", filed_fx_score: 90, turnover_gbp: "80000000" },
  ];
  const enrich = { F1: { niche: "Nuts", sic: ["46390"], absurd: "" }, F2: { niche: "", sic: ["66190"], absurd: "An FX provider itself — a competitor, not a client" } };
  const niches = { a: { name: "Nuts", score: 22, hit_rate: 35, verdict: "keep" } };

  it("adds the filings companies not on the list, slim, with their niche, and rules out the absurd ones", () => {
    const { rows, ruled_out, scored } = rankLeads(list, filings, { enrich, niches, today });
    expect(rows.map((r) => r.company_number)).toEqual(["F1", "F2"]);
    expect(rows[0]).toMatchObject({ section: FILINGS_SECTION, fx_niche: "Nuts", from_filings: true });
    expect(rows[0].fx_mentions).toBeUndefined();
    expect(rows[0].directors).toBeUndefined();
    expect(rows[1]).toMatchObject({ qualified: "Out", qualify_reason: enrich.F2.absurd });
    expect(ruled_out).toEqual({ F2: enrich.F2.absurd });
    expect(scored[0].company_number).toBe("F1");   // FX loss filed lately, good niche
    expect(scored[0].parts.some(([w]) => w.startsWith("Niche: Nuts"))).toBe(true);
  });
  it("learns per niche: leads, average score, how many 60+, ruled out", () => {
    const { scored } = rankLeads(list, filings, { enrich, niches, today });
    const learn = nicheLearnings(scored, 1);
    const nuts = learn.find((n) => n.niche === "Nuts");
    expect(nuts).toMatchObject({ leads: 2, ruled_out: 0 });
    expect(nuts.strong).toBeGreaterThanOrEqual(1);
    expect(learn.find((n) => n.niche === "(no niche)")).toMatchObject({ leads: 1, ruled_out: 1, avg: 0 });
  });
});

describe("niche relabelling", () => {
  it("drops a list company's sector niche the corrected tagging doesn't confirm, and takes a customs one", () => {
    const niches = { m: { name: "Musical Instrument Distributors", kind: "sector", score: 9, hit_rate: 10, verdict: "keep" } };
    const list = [{ company_number: "T1", company_name: "TOOTHBRUSHES LTD", fx_niche: "Musical Instrument Distributors" },
                  { company_number: "T2", company_name: "NUTS LTD", fx_niche: "Proven trader: 08 fruit & nuts" },
                  { company_number: "T3", company_name: "KEEP LTD", fx_niche: "FX in their filed accounts" }];
    const enrich = { T1: { niche: "" }, T2: { niche: "Nut, seed & dried fruit importers" }, T3: { niche: "" } };
    const { niche_of, scored } = rankLeads(list, [], { enrich, niches });
    expect(niche_of).toEqual({ T1: "", T2: "Nut, seed & dried fruit importers" });
    expect(scored.find((s) => s.company_number === "T1").parts.some(([w]) => w.startsWith("Niche"))).toBe(false);
  });
});

describe("Hard to broker", () => {
  it("tags list and filings companies from the morning enrich, never a ruled-out one", () => {
    const enrich = { "1": { shy: { niche: "Scrap & recycled-metal traders", why: "x" } }, "2": { absurd: "A bank", shy: { niche: "Scrap & recycled-metal traders", why: "x" } },
                     "3": { shy: { niche: "Tobacco importers & wholesalers", why: "y" } } };
    const { shy_of } = rankLeads([{ company_number: "1", company_name: "A" }, { company_number: "2", company_name: "B" }],
                                  [{ company_number: "3", company_name: "C" }], { enrich });
    expect(Object.keys(shy_of).sort()).toEqual(["1", "3"]);
  });
});
