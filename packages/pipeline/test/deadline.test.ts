import { describe, it, expect, afterEach } from "vitest";
import { stageDeadline, stoppable } from "../src/sources/deadline.js";

describe("stageDeadline", () => {
  afterEach(() => { delete process.env.FX_PIPELINE_DEADLINE; });

  it("is the stage's own budget when the pipeline sets no deadline", () => {
    expect(stageDeadline(35, 21, 1_000_000)).toBe(1_000_000 + 35 * 60_000);
  });

  it("stops earlier to leave the later stages their time before the pipeline's end", () => {
    const now = 1_000_000_000;
    process.env.FX_PIPELINE_DEADLINE = String((now + 40 * 60_000) / 1000);   // 40 min left in the step
    expect(stageDeadline(35, 21, now)).toBe(now + 19 * 60_000);             // 40 - 21, not 35
    expect(stageDeadline(15, 5, now)).toBe(now + 15 * 60_000);              // own budget is the tighter one
  });
});

describe("stoppable", () => {
  it("makes no new requests once the lead is given up on", async () => {
    const calls: string[] = [];
    const stop = { stopped: false };
    const fetch = stoppable(async (url: string) => { calls.push(url); return url; }, stop);
    expect(await fetch("a")).toBe("a");
    stop.stopped = true;
    expect(await fetch("b")).toBeNull();
    expect(calls).toEqual(["a"]);
  });
});
