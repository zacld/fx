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
    expect(k.map(([l]) => l)).toEqual(["Why now", "FX", "Owner", "Pitch"]);
    expect(k[0][1]).toBe("New finance director appointed 3 March 2026");
    expect(k[1][1]).toBe("FX loss £320k · USD · no hedging named · 40% of sales abroad");
    expect(k[2][1]).toBe("UK-owned");
    expect(k[2][2]).toMatch(/google\.com\/search\?q=who%20owns%20ACME%20LIMITED/);
    expect(keyPoints({ company_number: "2" }).map(([l]) => l)).toEqual(["Why now", "FX", "Owner"]);
  });
});

import { ownershipOf } from "./control.js";
describe("Who owns it, up the chain (16 Nov 2026)", () => {
  it("the accounts' ultimate parent first, then the register's chain, then the owners list", () => {
    const fromAccounts = ownershipOf({ company_name: "ACME LIMITED", ultimate_parent: "Acme Holding GmbH", ultimate_parent_country: "Germany" },
      { top: "1", top_name: "ACME UK HOLDINGS LIMITED", hops: 1, abroad: "" });
    expect([fromAccounts.status, fromAccounts.country]).toEqual(["foreign", "Germany"]);
    expect(fromAccounts.chain).toEqual(["ACME LIMITED", "ACME UK HOLDINGS LIMITED (UK)", "Acme Holding GmbH (Germany)"]);
    const viaRegister = ownershipOf({ company_name: "WIDGETS LIMITED" }, { top: "2", top_name: "WIDGET GROUP LIMITED", hops: 2, abroad: "WIDGET INC (United States)" });
    expect([viaRegister.status, viaRegister.owner, viaRegister.country]).toEqual(["foreign", "WIDGET INC", "United States"]);
    const home = ownershipOf({ company_name: "BRICKS LIMITED", owners: "J SMITH (individual, England)" }, { top: "3", top_name: "BRICK HOLDINGS LIMITED", hops: 1, abroad: "" });
    expect([home.status, home.owner]).toEqual(["uk", "BRICK HOLDINGS LIMITED"]);
    // nothing on the register above it: not known (was read as UK-owned)
    expect(ownershipOf({ company_name: "MANGO LIMITED" }, { top: "4", hops: 0, abroad: "" }).status).toBe("unknown");
    expect(ownershipOf({ company_name: "SEA LIMITED" }, { top: "5", hops: 0, abroad: "SEA HOLDINGS LIMITED" }).status).toBe("unknown");
    expect(ownershipOf({ company_name: "P LIMITED", owners: "A PERSON (individual, Spain)" }).status).toBe("foreign");
    expect(home.searches.map(([l]) => l)).toEqual(["Who owns BRICKS LIMITED?", "Where is BRICK HOLDINGS LIMITED based?", "BRICKS LIMITED parent company"]);
    expect(ownershipOf({ company_name: "X LIMITED" }).status).toBe("unknown");
    expect(ownershipOf({ company_name: "Y LIMITED", owners: "J SMITH (individual, England)" }).status).toBe("uk");
  });
  it("names the owner the web search found over the holding company", () => {
    const o = ownershipOf({ company_name: "TXO SYSTEMS LTD" }, { top: "1", top_name: "Txo Delta Topco Ltd", hops: 2, abroad: "" }, null,
      { owner: "TowerBrook Capital Partners", kind: "pe", country: "United States", quote: "acquired by TowerBrook", url: "https://x" });
    expect([o.status, o.owner, o.kind]).toEqual(["foreign", "TowerBrook Capital Partners", "pe"]);
    expect(o.chain.join(" → ")).toBe("TXO SYSTEMS LTD → Txo Delta Topco Ltd (UK) → TowerBrook Capital Partners (United States)");
    const p = ownershipOf({ company_name: "SENZA GROUP LIMITED" }, { top: "2", top_name: "NLC GROUP OF COMPANIES LIMITED", hops: 1, abroad: "" }, null,
      { owner: "NLC Group", kind: "company", country: "" });
    expect([p.status, p.owner]).toEqual(["unknown", "NLC Group"]);
  });
});
