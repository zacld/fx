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
