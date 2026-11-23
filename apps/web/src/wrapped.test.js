import { describe, expect, it } from "vitest";
import { dayReport, dayWrap, localDay, markActions, reportHtml, reportMarkdown, shiftDay, wrapText } from "./accounts/wrapped.js";

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
];
const MARKS = {
  checks: {
    "00000001": { review: "open", review_at: at(MON, "09:00") },
    "00000002": { review: "research", review_at: at(MON, "09:05") },
    "00000003": { review: "abroad", review_at: at(MON, "09:10") },
    "00000004": { review: "skip", review_at: at(MON, "09:20") },
    "00000009": { crm: at(MON, "09:21") },   // a CRM tick alone isn't a mark
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
  it("counts each company once, by its latest mark of the day", () => {
    const w = dayWrap(ROWS, MARKS, MON);
    expect(w.looked).toBe(7);
    expect(w.counts).toMatchObject({ call: 2, research: 1, good: 1, abroad: 1, small: 1, skip: 1, open: 0 });
    expect([w.keep, w.drop, w.skip]).toEqual([4, 2, 1]);
    expect(w.keepRate).toBe(67);
    expect(w.marked.find((a) => a.n === "00000001").kind).toBe("call");
    expect(markActions(MARKS).some((a) => a.n === "00000009")).toBe(false);
  });

  it("finds the sector that worked and the one that didn't land", () => {
    const w = dayWrap(ROWS, MARKS, MON);
    expect(w.worked.sector[0]).toMatchObject({ key: "Manufacturing: machinery", keep: 3, drop: 0 });
    expect(w.didnt.sector[0]).toMatchObject({ key: "Wholesale: general", keep: 0, drop: 2, skip: 1 });
    expect(w.best).toMatchObject({ company_name: "ECHO FOODS LTD", lead_score: 75 });
    expect(w.scores.keep).toBeGreaterThan(w.scores.drop);
    expect(w.sizes).toEqual({ keep: 37.5e6, drop: 10.5e6 });
  });

  it("measures the pace, the streak and the day against the others", () => {
    const w = dayWrap(ROWS, MARKS, MON);
    expect(w.pace.minutes).toBe(175);   // 09:05 to 12:00 (company 1 counts at its later mark)
    expect(w.pace.perHour).toBe(2);   // 7 marks in under 3 hours
    expect(w.pace.busyHour).not.toBeNull();
    expect(w.before).toEqual({ day: FRI, count: 1 });   // the weekend skipped
    expect(w.streak).toBe(2);   // Friday and Monday: an empty weekend doesn't break it
    expect(w.history).toHaveLength(14);
    expect(w.history.at(-1)).toEqual({ day: MON, count: 7 });
    expect(w.bestDay).toEqual({ day: MON, count: 7 });
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
    expect(text).toMatch(/7 leads looked through/);
    expect(text).toMatch(/Keepers: 4 \(1 good lead, 1 research harder, 2 call list\)/);
    expect(text).toMatch(/Best sector: Manufacturing: machinery \(3 of 3 kept\)/);
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
    expect(rep.sections.map((x) => x.key)).toEqual(["good", "research", "call"]);
    expect(rep.sections.find((x) => x.key === "call").items.map((i) => i.name)).toEqual(["ACME MACHINES LTD", "HOTEL MACHINES LTD"]);   // best score first
    expect(rep.keepers).toHaveLength(4);
    expect(rep.notFor).toEqual([{ label: "Not enough revenue", count: 1, names: ["FOXTROT GENERAL LTD"] },
      { label: "Owned abroad", count: 1, names: ["CARGO GENERAL LTD"] }]);
    expect(rep.summary[0]).toBe("7 leads looked through: 4 keepers (57%), 2 not for us (29%), 1 skipped (14%) — 67% of those judged kept.");
    expect(rep.summary[1]).toBe("Most looked at: Manufacturing: machinery — 3 (43% of the day), 3 kept.");
    const md = reportMarkdown(rep);
    expect(md).toMatch(/^# Day report — Mon 23 Nov/);
    expect(md).toMatch(/## Good leads \(1\)/);
    expect(md).toContain("- **ECHO FOODS LTD** — [00000005](https://find-and-update.company-information.service.gov.uk/company/00000005)");
    expect(md).toContain("    - Note: FD back Thursday");
    expect(md).toContain("- Skipped: 1");
    expect(md).not.toContain("DELTA GENERAL");   // skipped companies are counted, never named
    const html = reportHtml(rep);
    expect(html).toContain("<li>Note: R&amp;D team &lt;Leeds&gt;</li>");
    expect(html).not.toContain("<Leeds>");
    expect(html).not.toContain("DELTA GENERAL");
  });

  it("a day with nothing kept still makes a report", () => {
    const rep = dayReport(dayWrap(ROWS, MARKS, "2026-11-22"));
    expect(rep.sections).toEqual([]);
    expect(reportMarkdown(rep)).toContain("No keepers.");
  });

  it("the day in depth: type of company, size, score, signals, hours and running totals, with percentages", () => {
    const w = dayWrap(ROWS, MARKS, MON), d = w.depth;
    expect(d.marks.map((m) => [m.label, m.count, Math.round(100 * m.share)])).toEqual([
      ["Good lead", 1, 14], ["Research harder", 1, 14], ["Call list", 2, 29], ["Not enough revenue", 1, 14], ["Owned abroad", 1, 14], ["Skipped", 1, 14]]);
    expect(d.sector.map((e) => [e.key, e.total, e.keep, e.drop, e.skip])).toEqual([
      ["Manufacturing: machinery", 3, 3, 0, 0], ["Wholesale: general", 3, 0, 2, 1], ["Manufacturing: food, drink & tobacco", 1, 1, 0, 0]]);
    expect(d.size.map((e) => [e.key, e.total, e.keep])).toEqual([["Under £20m", 3, 0], ["£20m–£50m", 3, 3], ["£50m–£100m", 1, 1]]);
    expect(d.score.map((e) => [e.key, e.total, e.rate])).toEqual([["60+", 4, 1], ["50–59", 2, 0], ["40–49", 1, 0]]);
    const band = d.signals.find((x) => x.label === "£20m–£300m turnover");
    expect([band.with.looked, band.with.rate, band.without.looked, band.without.rate, band.lift]).toEqual([4, 1, 3, 0, 1]);
    expect(d.hourly.reduce((n, h) => n + h.total, 0)).toBe(7);
    expect([d.totals.week.looked, d.totals.week.days, d.totals.month.looked, d.totals.month.days, d.totals.all.looked]).toEqual([7, 1, 8, 2, 8]);
    const md = reportMarkdown(dayReport(w));
    expect(md).toContain("## The day in numbers");
    expect(md).toContain("| Type of company | Looked at | % of day | Kept | Not for us | Skipped | Kept % |");
    expect(md).toContain("| Manufacturing: machinery | 3 | 43% | 3 | 0 | 0 | 100% |");
    expect(md).toContain("| £20m–£300m turnover | 4 | 100% | 3 | 0% | +100 pts |");
    expect(md).toContain("| **Total** | **7** | **100%** |");
    expect(md).toContain("| This month | 2 | 8 | 5 | 2 | 1 | 71% |");
    expect(md).toContain("| This week | 1 | 7 | 4 | 2 | 1 | 67% |");
    expect(reportHtml(dayReport(w))).toContain("<h3>Size (filed turnover)</h3>");
  });
});
