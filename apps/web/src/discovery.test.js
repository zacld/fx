import { afterEach, describe, expect, it } from "vitest";
import { SORTS, matchCompanies, groupActivity, hiddenFromFilters, industryOf, leadProfile, leadScore, leadSource, likeGoodLeads, profileMatch, scoreboard,
  setKnownGroups, sortRows } from "./accounts/format.js";
import { rankLeads } from "./accounts/ranking.js";

afterEach(() => setKnownGroups({}));

// Zac's good finds of 20 Nov 2026: a holding company filed as "head office" whose group runs freight.
const HOLDCO = { company_number: "13582451", company_name: "ITS GROUP HOLDINGS LIMITED", sic_codes: ["70100"], turnover_gbp: 20_200_000,
  filed_fx_score: 60, fx_niche: "FX in their filed accounts" };
const GROUPS = { 13582451: { top: "13582451", top_name: "", hops: 0, abroad: "",
  activity: { sic: ["52290", "49410"], subs: 3, names: ["ITS FREIGHT LIMITED", "ITS ROAD LIMITED"], niche: "Freight forwarders" } } };

describe("holding companies: what the group trades", () => {
  it("labels the industry from its trading subsidiaries", () => {
    expect(industryOf(HOLDCO)).toBe("Professional services");
    setKnownGroups(GROUPS);
    expect(groupActivity(HOLDCO).subs).toBe(3);
    expect(industryOf(HOLDCO)).toBe("Transport, logistics & freight");
    expect(hiddenFromFilters(HOLDCO).find((h) => h.key === "sector").text).toMatch(/group trades as transport, logistics & freight through its 3 trading subsidiaries/);
  });
  it("leaves a trading company's own sector alone", () => {
    setKnownGroups({ 1: { top: "1", hops: 0, activity: { sic: ["52290"], subs: 1, names: [], niche: "" } } });
    expect(industryOf({ company_number: "1", sic_codes: ["46390"] })).toBe("Wholesale: food, drink & tobacco");
    expect(groupActivity({ company_number: "1", sic_codes: ["46390"] })).toBeNull();
  });
  it("gives a generic niche the group's niche in the ranking", () => {
    const { niche_of, rows } = rankLeads([HOLDCO], [{ ...HOLDCO, company_number: "99999999", company_name: "OTHER TOPCO LIMITED" }],
      { groups: { ...GROUPS, 99999999: { ...GROUPS[13582451], top: "99999999" } }, enrich: {} });
    expect(niche_of["13582451"]).toBe("Freight forwarders");
    expect(rows[0].fx_niche).toBe("Freight forwarders");
  });
});

describe("lookalikes by profile", () => {
  const good = { company_number: "1", company_name: "GOOD FREIGHT LIMITED", sic_codes: ["52290"], turnover_gbp: 30e6, filed_fx_score: 60,
    fx_gain_loss_gbp: -90000, fx_niche: "Freight forwarders" };
  const like = { company_number: "2", company_name: "SIMILAR LOGISTICS LIMITED", sic_codes: ["52290"], turnover_gbp: 45e6, filed_fx_score: 55,
    fx_gain_loss_gbp: -60000, fx_niche: "Freight forwarders" };
  const other = { company_number: "3", company_name: "SOFTWARE CO LIMITED", sic_codes: ["62012"], turnover_gbp: 30e6, filed_fx_score: 60 };
  const checks = { 1: { review: "open", review_at: "2026-11-20" } };

  it("finds the lead sharing most of a good lead's profile", () => {
    const likes = likeGoodLeads([good, like, other], checks, {});
    expect(Object.keys(likes)).toEqual(["2"]);
    expect(likes[2].like_name).toBe("GOOD FREIGHT LIMITED");
    expect(likes[2].same).toEqual(expect.arrayContaining(["Transport, logistics & freight", "Freight forwarders", "strong FX proof"]));
  });
  it("needs the industry or niche in common", () => {
    expect(profileMatch(leadProfile(good), leadProfile(other)).score).toBe(0);
  });
  it("lifts the lookalike's Fit with the reason", () => {
    const likes = likeGoodLeads([good, like, other], checks, {});
    const s = leadScore(like, { likes });
    expect(s.parts.find(([w]) => w.startsWith("Like your good lead"))).toEqual([expect.stringContaining("GOOD FREIGHT"), 8, "fit"]);
  });
  it("skips leads already marked either way", () => {
    expect(likeGoodLeads([good, like], { ...checks, 2: { review: "abroad" } }, {})).toEqual({});
  });
});

describe("scoreboard", () => {
  it("counts leads, good marks and waiting leads per source", () => {
    const rows = [
      { company_number: "1", fx_niche: "Emerging: Charter airlines", lead_fit: 100 },
      { company_number: "2", fx_niche: "Emerging: Charter airlines", lead_fit: 80 },
      { company_number: "3", from_filings: true, lead_fit: 90 },
      { company_number: "4", from_filings: true, lead_fit: 40, qualified: "Out" },
    ];
    expect(leadSource(rows[0])).toBe("Emerging niche");
    const b = scoreboard(rows, { 1: { review: "mine" }, 4: { review: "abroad" } }, {});
    const emerging = b.source.find((g) => g.key === "Emerging niche");
    expect(emerging).toMatchObject({ leads: 2, fit60: 2, checked: 1, good: 1, good_share: 100, waiting: 1 });
    expect(b.source.find((g) => g.key === "FX filings")).toMatchObject({ leads: 1, checked: 1, good: 0, good_share: 0, waiting: 1 });
  });
});

describe("Fit first sort", () => {
  it("puts the best fit first and the timely first among equals", () => {
    const rows = [{ rank: 1, lead_fit: 60, lead_timing: 80, lead_score: 78 }, { rank: 2, lead_fit: 100, lead_timing: 10, lead_score: 55 },
      { rank: 3, lead_fit: 100, lead_timing: 30, lead_score: 65 }];
    expect(sortRows(rows, "fitFirst").map((r) => r.rank)).toEqual([3, 2, 1]);
    expect(SORTS.fitFirst.label).toMatch(/Fit first/);
  });
});

describe("second recalibration (22 Nov 2026)", () => {
  it("weighs timing at 0.3 and gives a quiet niche points", () => {
    const s = leadScore({ company_number: "1", filed_fx_score: 60, turnover_gbp: 30e6, fx_niche: "Emerging: Non-scheduled passenger air transport" });
    expect(s.parts.find(([w]) => w.startsWith("A niche few bankers search"))).toEqual([expect.any(String), 6, "fit"]);
  });
  it("matches pasted names and numbers to the lists", () => {
    const rows = [{ company_number: "10303149", company_name: "VOLANTEUS LIMITED" }, { company_number: "13582451", company_name: "ITS GROUP HOLDINGS LIMITED" },
      { company_number: "02532281", company_name: "LIMBS & THINGS LIMITED" }, { company_number: "1", company_name: "PROJECT TWENTY TOPCO LIMITED" }];
    const { matched, unmatched } = matchCompanies("VOLANTEUS LIMITED £67.2m\n13582451, Limbs and Things Ltd\nPROJECT TWENTY TOPCO LIMIT…\nNOBODY LTD", rows);
    expect(matched.map((m) => m.row.company_number)).toEqual(["10303149", "13582451", "02532281", "1"]);
    expect(unmatched).toEqual(["NOBODY LTD"]);
  });
});
