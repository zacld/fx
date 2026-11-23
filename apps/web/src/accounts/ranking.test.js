import { describe, expect, it } from "vitest";
import { FILINGS_SECTION, leadRows, learningRows, nicheLearnings, rankLeads, verdictLearnings } from "./ranking.js";
import { likeGoodLeads, reviewLearnings } from "./format.js";

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

describe("learningRows: what Zac's marks are learnt from", () => {
  // the nightly ranking learnt from every list row plus every filings row until 24 Nov 2026, so a company on both lists
  // counted twice ("694 judged, 15% new" with 54 new prospects); the page learnt from each company once
  const list = [{ company_number: "B1", company_name: "BOTH LTD", fx_niche: "FX in their filed accounts", sic_codes: ["46900"] },
                { company_number: "L2", company_name: "LIST ONLY LTD", fx_niche: "Nuts" },
                { company_number: "X1", company_name: "EBURY LTD", fx_niche: "Nuts" }];
  const filings = [{ company_number: "B1", company_name: "BOTH LTD", filed_fx_score: 60 },
                   { company_number: "F1", company_name: "FILINGS ONLY LTD", filed_fx_score: 70 }];
  const enrich = { B1: { niche: "Aircraft parts & aviation suppliers" }, F1: { niche: "Nuts" }, X1: { absurd: "An FX provider itself" } };

  it("lists each company once: the list's rows with their corrected niche (Out when ruled out), then the filings companies not on it", () => {
    const rows = learningRows(list, leadRows(list, filings, { enrich }));
    expect(rows.map((r) => r.company_number)).toEqual(["B1", "L2", "X1", "F1"]);
    expect(rows[0].fx_niche).toBe("Aircraft parts & aviation suppliers");
    expect(rows[2]).toMatchObject({ qualified: "Out", qualify_reason: "An FX provider itself" });
    expect(rows[3]).toMatchObject({ from_filings: true, fx_niche: "Nuts", main_currency: "" });
  });
  it("is what the page builds from the saved ranking (rows, niche_of, ruled_out), and copes without one", () => {
    const { rows, niche_of, ruled_out } = rankLeads(list, filings, { enrich });
    expect(learningRows(list, { rows, niche_of, ruled_out })).toEqual(learningRows(list, leadRows(list, filings, { enrich })));
    expect(learningRows(list, null).map((r) => r.company_number)).toEqual(["B1", "L2", "X1"]);
    // a filings company the list has taken on since the ranking was saved is the list's row, not a second one
    expect(learningRows([...list, { company_number: "F1", company_name: "FILINGS ONLY LTD" }], { rows }).map((r) => r.company_number))
      .toEqual(["B1", "L2", "X1", "F1"]);
  });
  it("counts a company on both lists once in the feedback loop and the lookalikes", () => {
    const verdicts = { B1: { verdict: "good" }, L2: { verdict: "not_fit", reason: "too_small" } };
    const rows = learningRows(list, leadRows(list, filings, { enrich }));
    const l = reviewLearnings(rows, {}, verdicts);
    expect(l.reviewed).toBe(2);
    expect(l.usual).toBe(50);
    expect(l.niche.find((g) => g.key === "Aircraft parts & aviation suppliers")).toMatchObject({ good: 1, reviewed: 1 });
    expect(l.niche.find((g) => g.key === "FX in their filed accounts")).toBeUndefined();
    // the old way: both rows of B1 counted, one under each niche
    const doubled = reviewLearnings([...list, ...filings.map((r) => ({ ...r, fx_niche: enrich[r.company_number]?.niche || "" }))], {}, verdicts);
    expect(doubled.reviewed).toBe(3);
    expect(Object.keys(likeGoodLeads(rows, {}, verdicts))).not.toContain("B1");
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

describe("Verdict learnings", () => {
  it("splits Zac's verdicts by source, score band, niche and sector", () => {
    const scored = [{ company_number: "1", onList: true, niche: "Scrap", score: 85 }, { company_number: "2", onList: false, niche: "Scrap", score: 45 },
                    { company_number: "3", onList: false, niche: "Wine", score: 90 }];
    const out = verdictLearnings(scored, { "1": { verdict: "good" }, "2": { verdict: "not_fit", reason: "Too small" } }, { shyOf: { "1": { niche: "Scrap" }, "2": { niche: "Scrap" } } });
    expect(out.reviewed).toBe(2);
    expect(out.niche).toEqual([{ key: "Scrap", good: 1, not_fit: 1, reviewed: 2, good_share: 50 }]);
    expect(out.band.map((g) => g.key).sort()).toEqual(["75–89", "under 75"]);   // out of 100 (no scale set here: the raw score)
    expect(out.reasons).toEqual({ "Too small": 1 });
  });
});
