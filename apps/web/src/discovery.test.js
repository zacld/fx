import { afterEach, describe, expect, it } from "vitest";
import { SORTS, freshFind, markedToday, researchList, reviewLearnings, todaysList, markSections, matchCompanies, groupActivity, hiddenFromFilters, industryOf, leadProfile, leadScore, leadSource, likeGoodLeads, profileMatch, scoreboard,
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
  const checks = { 1: { review: "mine", review_at: "2026-11-20" } };   // Added to mine: a new prospect (Open is already open)

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
  it("counts the quiet signs over Fit's cap in the ranking", () => {
    // two leads at Fit 100: the one few bankers see (a quiet niche, sized by its group) ranks higher
    const strong = { company_number: "1", filed_fx_score: 80, turnover_gbp: 60e6, fx_gain_loss_gbp: -300000, turnover_growth: "45%",
      subsidiaries_abroad: "ACME GMBH (Germany)", fx_currencies: "USD" };
    const loud = leadScore(strong);
    const quiet = leadScore({ ...strong, fx_niche: "Emerging: Charter airlines", turnover_basis: "group" });
    expect(loud.fit).toBe(100);
    expect(quiet.fit).toBe(100);
    expect(quiet.rankFit - loud.rankFit).toBeGreaterThanOrEqual(6);
    expect(quiet.score).toBeGreaterThan(loud.score);
    // under the cap nothing changes: the ranking's Fit is Fit
    const small = leadScore({ company_number: "2", filed_fx_score: 30, turnover_gbp: 30e6, fx_niche: "Emerging: Charter airlines" });
    expect(small.rankFit).toBe(small.fit);
  });
  it("matches pasted names and numbers to the lists", () => {
    const rows = [{ company_number: "10303149", company_name: "VOLANTEUS LIMITED" }, { company_number: "13582451", company_name: "ITS GROUP HOLDINGS LIMITED" },
      { company_number: "02532281", company_name: "LIMBS & THINGS LIMITED" }, { company_number: "1", company_name: "PROJECT TWENTY TOPCO LIMITED" }];
    const { matched, unmatched } = matchCompanies("VOLANTEUS LIMITED £67.2m\n13582451, Limbs and Things Ltd\nPROJECT TWENTY TOPCO LIMIT…\nNOBODY LTD", rows);
    expect(matched.map((m) => m.row.company_number)).toEqual(["10303149", "13582451", "02532281", "1"]);
    expect(unmatched).toEqual(["NOBODY LTD"]);
    // a name starting with digits is a name, not a list number; a numbered list still works
    const rows2 = [{ company_number: "2", company_name: "360 BRAND GROUP LTD" }, { company_number: "3", company_name: "ACME LIMITED" }];
    expect(matchCompanies("360 BRAND GROUP LTD\n12. Acme Ltd", rows2).matched.map((m) => m.row.company_number)).toEqual(["2", "3"]);
  });
});

describe("marking in bulk", () => {
  it("splits a paste into headed sections", () => {
    const s = markSections("VOLANTEUS LIMITED\nOpen lead:\nTXO SYSTEMS LTD\nOwned abroad\nSEASALT LIMITED\nNot a fit (No real FX):\nCNC GROUP HOLDINGS LIMITED\nNot a fit:\nX LTD");
    expect(s.map((x) => [x.label, x.mark, x.text.trim()])).toEqual([
      ["Added to mine", { review: "mine" }, "VOLANTEUS LIMITED"], ["Open lead", { review: "open" }, "TXO SYSTEMS LTD"],
      ["Owned abroad", { review: "abroad" }, "SEASALT LIMITED"], ["Not a fit (No real FX)", { verdict: "not_fit", reason: "No real FX" }, "CNC GROUP HOLDINGS LIMITED"],
      ["Not a fit", { verdict: "not_fit", reason: "" }, "X LTD"]]);
  });
});

describe("Fresh finds", () => {
  const today = new Date("2026-11-22T12:00:00Z");
  it("says why a lead is fresh", () => {
    expect(freshFind({ company_number: "1", found_via: "Job advert — Accounts assistant, EUR payments", first_seen: "2026-11-20", sic_codes: ["46390"] }, today))
      .toEqual(["new", "source", "hidden"]);   // found by a job advert: no standard filter sees it either
    expect(freshFind({ company_number: "2", fx_niche: "Emerging: Charter airlines", first_seen: "2026-01-01", sic_codes: ["51101"] }, today))
      .toEqual(["source", "niche"]);
  });
  it("doesn't count a fresh FX filing as new — every bank reads those", () => {
    expect(freshFind({ company_number: "3", from_filings: true, accounts_filed_on: "2026-11-18", sic_codes: ["46390"], turnover_gbp: 40e6 }, today)).toEqual([]);
  });
});

describe("Today's list", () => {
  const lead = (n, score, extra = {}) => ({ company_number: n, company_name: `CO ${n} LIMITED`, lead_score: score, lead_fit: 80, filed_fx_score: 60,
    turnover_gbp: 40e6, ...extra });
  it("the best unmarked leads first, one per group, a judged group left out", () => {
    setKnownGroups({ 3: { top: "9", top_name: "G", hops: 1 }, 4: { top: "9", top_name: "G", hops: 1 }, 5: { top: "8", hops: 1 }, 6: { top: "8", hops: 1 } });
    const rows = [lead("1", 50), lead("2", 70), lead("3", 65), lead("4", 60), lead("5", 90), lead("6", 40), lead("7", 99, { qualified: "Out" }),
      lead("10", 95, { lead_fit: 10 })];
    // 6 is marked (Not enough revenue), so its group — 5 too — is done; 3 and 4 share a group: only the better shows
    const got = todaysList(rows, { verdicts: { 6: { verdict: "not_fit", reason: "Too small" } } });
    expect(got.map((r) => r.company_number)).toEqual(["2", "3", "1"]);
    expect(todaysList(rows, { lists: { 2: { list: "call" } }, checks: { 1: { review: "open" } } }).map((r) => r.company_number)).toEqual(["5", "3"]);
    // Owned abroad and Skip take a company off like the others
    expect(todaysList(rows, { checks: { 5: { review: "skip" }, 2: { review: "abroad" } } }).map((r) => r.company_number)).toEqual(["3", "1"]);
  });
  it("counts the marks made today", () => {
    expect(markedToday({ checks: { 1: { review: "open", review_at: "2026-11-22T09:00:00Z" } }, verdicts: { 2: { verdict: "good", at: "2026-11-21T09:00:00Z" } },
      lists: { 1: { list: "call", at: "2026-11-22T10:00:00Z" }, 3: { list: "call", at: "2026-11-22T11:00:00Z" } } }, "2026-11-22")).toBe(2);
  });
});

describe("Research harder", () => {
  const rows = [{ company_number: "1", company_name: "A LTD" }, { company_number: "2", company_name: "B LTD" }, { company_number: "3", company_name: "C LTD" },
    { company_number: "4", company_name: "D LTD", qualified: "Out" }];
  const checks = { 1: { review: "research", review_at: "2026-11-22T09:00:00Z" }, 2: { review: "research", review_at: "2026-11-23T09:00:00Z" },
    3: { review: "research", review_at: "2026-11-23T10:00:00Z" }, 4: { review: "research", review_at: "2026-11-23T11:00:00Z" } };
  it("lists the good leads with no contact info, newest first; a list or Not a fit moves them on", () => {
    expect(researchList(rows, { checks }).map((r) => r.company_number)).toEqual(["3", "2", "1"]);
    expect(researchList(rows, { checks, lists: { 3: { list: "call" } } }).map((r) => r.company_number)).toEqual(["2", "1"]);
  });
  it("counts as a good lead in the feedback loop", () => {
    const learned = reviewLearnings(rows.slice(0, 3).map((r) => ({ ...r, fx_niche: "Cut flowers" })), checks, {});
    expect(learned.reviewed).toBe(3);
  });
});
