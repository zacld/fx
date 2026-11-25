import { describe, expect, it } from "vitest";
import { dayReport, dayWrap, localDay, markActions, reportHtml, reportMarkdown, shiftDay, wrapText } from "./accounts/wrapped.js";
import { setScoreScale } from "./accounts/format.js";

// Monday 23 Nov 2026 and the Friday before, marked from Today's list and elsewhere. Times at midday-ish (UTC) so the
// local day is the same in any UK time zone.
const MON = "2026-11-23", FRI = "2026-11-20";
const at = (day, hm) => `${day}T${hm}:00.000Z`;
const row = (n, name, sic, score, turnover) => ({ company_number: n, company_name: name, sic_codes: [sic], lead_score: score, turnover_gbp: turnover });
const ROWS = [
  row("00000001", "ACME MACHINES LTD", "28290", 70, 40e6), row("00000002", "BOLT MACHINES LTD", "28290", 66, 30e6),
  row("00000003", "CARGO GENERAL LTD", "46900", 52, 12e6), row("00000004", "DELTA GENERAL LTD", "46900", 50, 15e6),
  row("00000005", "ECHO FOODS LTD", "10890", 75, 60e6), row("00000006", "FOXTROT GENERAL LTD", "46900", 48, 9e6),
  row("00000007", "GOLF MACHINES LTD", "28290", 60, 25e6), row("00000008", "HOTEL MACHINES LTD", "28290", 64, 35e6),
  row("00000010", "INDIA GENERAL LTD", "46900", 45, 8e6),
];
const MARKS = {
  checks: {
    "00000001": { review: "open", review_at: at(MON, "09:00") },
    "00000002": { review: "research", review_at: at(MON, "09:05") },
    "00000003": { review: "abroad", review_at: at(MON, "09:10") },
    "00000004": { review: "open", review_at: at(MON, "09:20") },   // already open: not a new prospect
    "00000009": { crm: at(MON, "09:21") },   // a CRM tick alone isn't a mark
    "00000010": { review: "skip", review_at: at(MON, "09:50") },   // no finance director found
  },
  verdicts: {
    "00000005": { verdict: "good", at: at(MON, "09:30") },
    "00000006": { verdict: "not_fit", reason: "Too small", at: at(MON, "09:40") },
    "00000007": { verdict: "good", at: at(FRI, "10:00") },
  },
  lists: {
    "00000001": { list: "call", at: at(MON, "12:00") },   // marked open, then put on the call list: the later mark counts
    "00000008": { list: "call", at: at(MON, "10:00"), seq: { start: MON, done: { 2: MON, 3: MON, 4: FRI } } },
  },
  contacted: { "00000008": { at: at(MON, "11:00"), touches: [{ at: at(MON, "11:00"), channel: "phone" }] } },
  notes: { "00000002": { text: "FD back Thursday", at: at(MON, "09:06") }, "00000003": { text: "old", at: at(FRI, "09:00") } },
};

describe("Your day (a Wrapped of the day)", () => {
  it("counts each company once, by its latest mark of the day — Open and a list alone are already open, Skip is no FD found", () => {
    const w = dayWrap(ROWS, MARKS, MON);
    expect(w.looked).toBe(8);
    expect(w.counts).toMatchObject({ call: 2, research: 1, good: 1, abroad: 1, small: 1, skip: 1, open: 1 });
    expect([w.keep, w.taken, w.drop, w.skip]).toEqual([2, 3, 2, 1]);   // the call list: mostly already open, not new
    expect(w.keepRate).toBe(29);   // 2 new of the 7 judged (the skip left out)
    expect(w.marked.find((a) => a.n === "00000001").kind).toBe("call");   // marked open, then put on the call list
    expect(markActions(MARKS).some((a) => a.n === "00000009")).toBe(false);
  });

  it("finds the sector that worked and the one that didn't land", () => {
    const w = dayWrap(ROWS, MARKS, MON);
    expect(w.worked.sector[0]).toMatchObject({ key: "Manufacturing: food, drink & tobacco", keep: 1, judged: 1 });
    expect(w.didnt.sector[0]).toMatchObject({ key: "Wholesale: general", keep: 0, taken: 1, drop: 2, skip: 1, judged: 3 });
    expect(w.best).toMatchObject({ company_name: "ECHO FOODS LTD", lead_score: 75 });
    expect([w.scores.keep, w.scores.drop]).toEqual([71, 57]);
    expect(w.sizes).toEqual({ keep: 45e6, drop: 15e6 });
  });

  it("measures the pace, the streak and the day against the others", () => {
    const w = dayWrap(ROWS, MARKS, MON);
    expect(w.pace.minutes).toBe(175);   // 09:05 to 12:00 (company 1 counts at its later mark)
    expect(w.pace.perHour).toBe(3);   // 8 marks in under 3 hours
    expect(w.pace.busyHour).not.toBeNull();
    expect(w.before).toEqual({ day: FRI, count: 1 });   // the weekend skipped
    expect(w.streak).toBe(2);   // Friday and Monday: an empty weekend doesn't break it
    expect(w.history).toHaveLength(14);
    expect(w.history.at(-1)).toEqual({ day: MON, count: 8 });
    expect(w.bestDay).toEqual({ day: MON, count: 8 });
    expect(w.average).toBe(1);
  });

  it("adds what else got done: sequence steps, contacts, notes", () => {
    const w = dayWrap(ROWS, MARKS, MON);
    expect(w.done).toMatchObject({ call: 1, email: 1, linkedin: 0, contacted: 1, touches: 1, notes: 1 });
    expect(w.done.channels).toEqual({ phone: 1 });
  });

  it("an earlier day, an empty day, and the summary to copy", () => {
    const fri = dayWrap(ROWS, MARKS, FRI);
    expect(fri.looked).toBe(1);
    expect(fri.done.call).toBe(1);   // step 4 ticked on Friday
    const sun = dayWrap(ROWS, MARKS, "2026-11-22");
    expect(sun.looked).toBe(0);
    expect(sun.keepRate).toBeNull();
    expect(wrapText(sun)).toMatch(/no leads marked/);
    const text = wrapText(dayWrap(ROWS, MARKS, MON));
    expect(text).toMatch(/8 leads looked through/);
    expect(text).toMatch(/New prospects: 2 \(1 good lead, 1 research harder\)/);
    expect(text).toMatch(/Already open or on a list: 3 \(1 open lead \(already open\), 2 call list \(mostly already open\)\)\./);
    expect(text).toMatch(/Best sector: Manufacturing: food, drink & tobacco \(1 new of 1 judged\)/);
    expect(text).not.toMatch(/FD back/);   // notes stay out of the summary
  });

  it("works in calendar days", () => {
    expect(localDay("2026-11-23")).toBe("2026-11-23");
    expect(localDay("")).toBe("");
    expect(shiftDay("2026-11-30", 1)).toBe("2026-12-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("Finish day: the report and its good leads as a document for Notion", () => {
    const w = dayWrap(ROWS, MARKS, MON);
    const rep = dayReport(w, { ...MARKS.notes, "00000005": { text: "R&D team <Leeds>", at: at(MON, "09:31") } });
    expect(rep.title).toBe("Day report — Mon 23 Nov");
    expect(rep.sections.map((x) => x.key)).toEqual(["good", "research"]);   // the call list isn't new: counted, not named
    expect(rep.keepers).toHaveLength(2);
    expect(rep.notFor).toEqual([{ label: "Not enough revenue", count: 1, names: ["FOXTROT GENERAL LTD"] },
      { label: "Owned abroad", count: 1, names: ["CARGO GENERAL LTD"] },
      { label: "Skipped — no finance director found (worth another go)", count: 1, names: ["INDIA GENERAL LTD"] }]);
    expect([rep.open, rep.openParts]).toEqual([3, "1 open lead, 2 on your call list"]);
    expect(rep.summary[0]).toBe("8 leads looked through: 2 new prospects (25%), 3 already open or on a list (38%), 2 not for us (25%), 1 skipped — no FD found (13%). 29% of those judged were new prospects.");
    expect(rep.summary[1]).toBe("Most looked at: Wholesale: general — 4 (50% of the day), 0 new.");
    const md = reportMarkdown(rep);
    expect(md).toMatch(/^# Day report — Mon 23 Nov/);
    expect(md).toMatch(/## Good leads \(1\)/);
    expect(md).toContain("- **ECHO FOODS LTD** — [00000005](https://find-and-update.company-information.service.gov.uk/company/00000005)");
    expect(md).toContain("    - Note: FD back Thursday");
    expect(md).toContain("- Already open or on a list: 3 (1 open lead, 2 on your call list)");
    expect(md).not.toContain("DELTA GENERAL");   // already-open companies are counted, never named
    expect(md).not.toContain("HOTEL MACHINES");   // nor the call list's
    const html = reportHtml(rep);
    expect(html).toContain("<li>Note: R&amp;D team &lt;Leeds&gt;</li>");
    expect(html).not.toContain("<Leeds>");
    expect(html).not.toContain("DELTA GENERAL");
  });

  it("the report carries each good lead's rating and a written brief, best rated first", () => {
    const rows = ROWS.map((r) => (r.company_number === "00000002" ? { ...r, fx_gain_loss_gbp: -96000, accounts_filed_on: "2026-10-12",
      main_currency: "USD", currency_source: "currency named in accounts", turnover_growth: "+54%" } : r));
    const verdicts = { ...MARKS.verdicts, "00000002": { rating: 3, rated_at: at(MON, "15:00") } };   // Research harder, rated on its own
    const rep = dayReport(dayWrap(rows, { ...MARKS, verdicts }, MON), MARKS.notes, { verdicts });
    const it2 = rep.keepers.find((i) => i.number === "00000002");
    expect(it2.rating).toBe(3);
    expect(it2.brief).toMatch(/^Bolt Machines is a machinery manufacturer with £30\.0m turnover \(up 54% on the year before\)\./);
    expect(it2.brief).toMatch(/a £96k FX loss \(filed 12 Oct 2026\) and USD as its main currency — and no hedging named\./);
    expect(it2.findings).toContain("Hedging: No hedging named in its accounts");
    // why it's a good lead, FX first (Zac, 24 Nov 2026), then who it is — the brief's first sentence
    expect(it2.why).toMatch(/^It lost £96k on currency in the accounts it filed on 12 Oct 2026, with no hedging named — the clearest need for forwards\. Its main currency is USD\./);
    expect(it2.why).toContain("Turnover £30.0m, up 54% on the year before — its currency needs grow with it.");
    expect(it2.about).toBe("Bolt Machines is a machinery manufacturer with £30.0m turnover (up 54% on the year before).");
    const md = reportMarkdown(rep);
    expect(md).toContain("- **BOLT MACHINES LTD** ★★★ — [00000002]");
    expect(md).toContain("    - **Why it's a good lead:** It lost £96k on currency");
    expect(md).toContain("    - Bolt Machines is a machinery manufacturer with £30.0m turnover (up 54% on the year before).\n");
    expect(reportHtml(rep)).toContain("<strong>BOLT MACHINES LTD</strong> ★★★");
    expect(reportHtml(rep)).toContain("<li><strong>Why it's a good lead:</strong> It lost £96k on currency");
    expect(dayWrap(rows, { ...MARKS, verdicts }, MON).looked).toBe(8);   // a rating alone isn't a mark
  });

  it("a day with nothing kept still makes a report", () => {
    const rep = dayReport(dayWrap(ROWS, MARKS, "2026-11-22"));
    expect(rep.sections).toEqual([]);
    expect(reportMarkdown(rep)).toContain("No keepers.");
  });

  it("the day in depth: type of company, size, score, signals, hours and running totals, with percentages", () => {
    const w = dayWrap(ROWS, MARKS, MON), d = w.depth;
    expect(d.marks.map((m) => [m.label, m.count, Math.round(100 * m.share)])).toEqual([
      ["Good lead", 1, 13], ["Research harder", 1, 13], ["Open lead (already open)", 1, 13], ["Call list (mostly already open)", 2, 25],
      ["Not enough revenue", 1, 13], ["Owned abroad", 1, 13], ["Skipped (no FD found)", 1, 13]]);
    expect(d.sector.map((e) => [e.key, e.total, e.keep, e.taken, e.drop, e.skip])).toEqual([
      ["Wholesale: general", 4, 0, 1, 2, 1], ["Manufacturing: machinery", 3, 1, 2, 0, 0], ["Manufacturing: food, drink & tobacco", 1, 1, 0, 0, 0]]);
    expect(d.size.map((e) => [e.key, e.total, e.keep])).toEqual([["Under £20m", 4, 0], ["£20m–£50m", 3, 1], ["£50m–£100m", 1, 1]]);
    try {   // the score out of 100: where each lead stands among these nine
      setScoreScale(ROWS.map((r) => r.lead_score));
      expect(dayWrap(ROWS, MARKS, MON).depth.score.map((e) => [e.key, e.total, e.rate]))
        .toEqual([["95–100", 1, 1], ["75–89", 2, 0.5], ["50–74", 1, 0], ["Under 50", 4, 0]]);
    } finally { setScoreScale([]); }
    const band = d.signals.find((x) => x.label === "£20m–£300m turnover");
    expect([band.with.looked, band.with.rate, band.without.looked, band.without.rate, band.lift]).toEqual([4, 0.5, 4, 0, 0.5]);
    expect(d.hourly.reduce((n, h) => n + h.total, 0)).toBe(8);
    expect([d.totals.week.looked, d.totals.week.days, d.totals.month.looked, d.totals.month.days, d.totals.all.looked]).toEqual([8, 1, 9, 2, 9]);
    const md = reportMarkdown(dayReport(w));
    expect(md).toContain("## The day in numbers");
    expect(md).toContain("| Type of company | Looked at | % of day | New | Open | Not for us | Skipped | New % |");
    expect(md).toContain("| Manufacturing: machinery | 3 | 38% | 1 | 2 | 0 | 0 | 33% |");
    expect(md).toContain("| £20m–£300m turnover | 4 | 50% | 4 | 0% | +50 pts |");
    expect(md).toContain("| **Total** | **8** | **100%** |");
    expect(md).toContain("| This month | 2 | 9 | 3 | 3 | 2 | 1 | 38% |");
    expect(md).toContain("| This week | 1 | 8 | 2 | 3 | 2 | 1 | 29% |");
    expect(reportHtml(dayReport(w))).toContain("<h3>Size (filed turnover)</h3>");
  });
});

describe("Not enough FX (Zac, 25 Nov 2026: the desk sizes a lead by £5m+ FX a year)", () => {
  it("counts the red ✕'s new reason on its own, the old 'too small' marks as before", () => {
    const acts = markActions({ verdicts: {
      "00000001": { verdict: "not_fit", reason: "Not enough FX", at: at(MON, "10:00") },
      "00000002": { verdict: "not_fit", reason: "Too small", at: at(MON, "10:05") } } });
    expect(acts.map((a) => [a.n, a.kind])).toEqual([["00000001", "smallfx"], ["00000002", "small"]]);
    const rep = dayReport(dayWrap(ROWS, { verdicts: { "00000001": { verdict: "not_fit", reason: "Not enough FX", at: at(MON, "10:00") } } }, MON));
    expect(rep.notFor).toEqual([{ label: "Not enough FX (under £5m)", count: 1, names: ["ACME MACHINES LTD"] }]);
  });
});
