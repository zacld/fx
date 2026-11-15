import { describe, expect, it } from "vitest";
import { SEQUENCE, addWorkingDays, gridCells, nextStep, plan, sequenceRank, validSequence } from "./sequence.js";

describe("Outreach sequence (Zac's follow-up grid)", () => {
  it("has the grid's 18 steps over 20 working days", () => {
    expect(SEQUENCE.length).toBe(18);
    expect(SEQUENCE.at(-1)).toMatchObject({ step: 18, day: 20, label: "Email 8 — break-up" });
  });
  it("counts working days, as the grid does (Day 0 Wednesday 11th → Day 1 Thursday 12th, Day 2 Friday 13th)", () => {
    expect([addWorkingDays("2026-11-11", 1), addWorkingDays("2026-11-11", 2), addWorkingDays("2026-11-11", 4)])
      .toEqual(["2026-11-12", "2026-11-13", "2026-11-17"]);
    expect(addWorkingDays("2026-11-14", 0)).toBe("2026-11-16");   // a Saturday start counts from Monday
  });
  it("puts the next step first and says when it's due", () => {
    const seq = { start: "2026-11-11", done: { 1: "2026-11-11", 2: "2026-11-12" } };
    expect(nextStep(seq, new Date("2026-11-13T09:00:00Z"))).toMatchObject({ step: 3, when: "overdue" });
    expect(plan(seq)[0]).toMatchObject({ step: 1, due: "2026-11-11", done: "2026-11-11" });
    expect(sequenceRank(seq, new Date("2026-11-13T09:00:00Z")) < sequenceRank({ start: "2026-12-01" }, new Date("2026-11-13T09:00:00Z"))).toBe(true);
    expect(gridCells(seq).step_1).toBe("2026-11-11 ✓");
    expect(gridCells(seq).step_18).toBe(addWorkingDays("2026-11-11", 20));
  });
  it("accepts only well-formed sequences", () => {
    expect(validSequence({ start: "2026-11-11", done: { 3: "2026-11-12" } })).toBe(true);
    expect(validSequence(null)).toBe(true);
    expect(validSequence({ start: "11/11/2026" })).toBe(false);
    expect(validSequence({ start: "2026-11-11", done: { 99: "2026-11-12" } })).toBe(false);
  });
});

import { callScript, todayQueue } from "./sequence.js";
describe("Email the finance team, call the next day", () => {
  it("asks for the most senior person emailed, and says the email went yesterday", () => {
    const c = callScript({}, { start: "2026-11-12", roles: ["fd", "fc", "fm"], done: { 1: "2026-11-12" } }, "Jane", new Date("2026-11-13T09:00:00Z"));
    expect(c.ask).toBe("Ask for Jane (Finance Director / CFO)");
    expect(c.line).toMatch(/^Hi Jane, it's Zac from Investec — I sent you and the finance team an email yesterday/);
    expect(callScript({}, { start: "2026-11-13", done: { 1: "2026-11-13" } }, "", new Date("2026-11-16T09:00:00Z")).line).toMatch(/yesterday/);   // Fri → Mon
    expect(callScript({}, {}, "").ask).toBe("Ask for the Finance Director");
  });
  it("puts today's calls, emails and new starts in order", () => {
    const rows = [{ company_number: "A", lead_score: 50 }, { company_number: "B", lead_score: 80 }, { company_number: "C", lead_score: 90, lead_fit: 60 },
      { company_number: "D", lead_score: 95, lead_fit: 10 }];
    const lists = { A: { list: "email", seq: { start: "2026-11-12", done: { 1: "2026-11-12" } } }, B: { list: "call" } };
    const q = todayQueue(rows, lists, { today: new Date("2026-11-13T09:00:00Z") });
    expect(q.calls.map((x) => [x.r.company_number, x.step.step])).toEqual([["A", 2]]);
    expect(q.start.map((x) => x.r.company_number)).toEqual(["B", "C"]);   // listed but not started first, then the best fit
  });
});
