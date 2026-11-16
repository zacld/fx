import { describe, expect, it } from "vitest";
import { financeSeat, foreignOwner } from "./control.js";
import { leadScore } from "./format.js";

describe("Where finance decisions sit (16 Nov 2026)", () => {
  const owned = { company_number: "1", company_name: "ACME LIMITED", owners: "ACME HOLDING GMBH (corporate, Germany); J SMITH (individual, England)" };
  it("reads the foreign owner from the register", () => {
    expect(foreignOwner(owned)).toEqual({ name: "ACME HOLDING GMBH", country: "Germany" });
    expect(foreignOwner({ owners: "ACME GROUP LIMITED (corporate, England)" })).toBeNull();
    expect(foreignOwner({ owner: "Owned by ACME SA (France)" })).toEqual({ name: "ACME SA", country: "France" });
    expect(foreignOwner({ owner: "Owned by ACME GROUP LIMITED (UK, 01234567)" })).toBeNull();
  });
  it("owned abroad alone: ask; with its own UK facility and hedging: decided here", () => {
    expect(financeSeat(owned).lean).toBe("unclear");
    const own = financeSeat({ ...owned, incumbent_bank: "HSBC UK BANK PLC: all-assets debenture", fx_forwards: "to buy €2m",
      board_line: "3 of 4 directors live in the UK" });
    expect(own.lean).toBe("uk");
    expect(own.signs.map((x) => x.text).join(" ")).toMatch(/Hsbc.*UK bank/);
  });
  it("group treasury, cash pool or a US bank tip it abroad", () => {
    const run = financeSeat({ ...owned, control_clues: "abroad|group_treasury|Treasury is managed centrally by the parent. ‖ abroad|cash_pool|The company is in the group cash pool.",
      incumbent_bank: "JPMORGAN CHASE BANK N.A.", board_line: "1 of 4 directors live in the UK" });
    expect(run.lean).toBe("abroad");
    expect(run.signs.some((x) => /US bank/.test(x.text))).toBe(true);
    expect(run.questions[0]).toMatch(/group treasury in Germany/);
  });
  it("a UK-owned company is decided here, and the lead score follows the lean", () => {
    expect(financeSeat({ company_name: "ACME LIMITED", owners: "J SMITH (individual, England)" }).lean).toBe("uk-owned");
    const today = new Date("2026-11-16T12:00:00Z");
    const away = leadScore({ ...owned, control_clues: "abroad|fx_by_group|FX is managed by the group." }, { today });
    expect(away.parts.find(([w]) => w.startsWith("Likely run from abroad"))[1]).toBe(-20);
    const here = leadScore({ ...owned, incumbent_bank: "BARCLAYS BANK PLC", fx_today: "Uses forward contracts" }, { today });
    expect(here.parts.find(([w]) => w.startsWith("Owned abroad, but decides in the UK"))[1]).toBe(5);
  });
});

import { keyPoints } from "./format.js";
describe("Key points on a card (16 Nov 2026: summarise)", () => {
  it("gives at most four short lines: why now, FX, who decides, pitch", () => {
    const r = { company_number: "1", company_name: "ACME LIMITED", fx_gain_loss_gbp: "-320000", main_currency: "USD",
      currency_source: "forward contracts in the accounts", overseas_turnover_share: "40%", owners: "J SMITH (individual, England)",
      lead_flags: { newFd: true, fdWhy: "New finance director appointed 3 March 2026" } };
    const k = keyPoints(r, "Corporate deposits · FX spot and forwards");
    expect(k.map(([l]) => l)).toEqual(["Why now", "FX", "Decides", "Pitch"]);
    expect(k[0][1]).toBe("New finance director appointed 3 March 2026");
    expect(k[1][1]).toBe("FX loss £320k · USD · no hedging named · 40% of sales abroad");
    expect(k[2][1]).toBe("UK-owned");
    expect(keyPoints({ company_number: "2" }).map(([l]) => l)).toEqual(["Why now", "FX", "Decides"]);
  });
});
