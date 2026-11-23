import { describe, expect, it } from "vitest";
import { dayWrap, localDay, markActions, shiftDay, wrapText } from "./accounts/wrapped.js";

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
});
