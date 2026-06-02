/**
 * Revenue filter unit tests.
 *
 * sizeFit(lead, minRevenue) rules:
 *   - "passes"    → annual_turnover is a number AND >= minRevenue
 *   - "below"     → annual_turnover is a number AND < minRevenue
 *   - "unverified"→ annual_turnover is null / undefined / not a number
 *   - minRevenue 0 → always "passes" (Any mode)
 *
 * applyFilters with minRevenue > 0 must:
 *   - include only "passes" leads in the main list
 *   - exclude "below" leads entirely
 *   - exclude "unverified" leads from main list (they go to the unverified section in the UI)
 */

import { describe, it, expect } from "vitest";

// ── Copy of the production helpers under test ─────────────────────
// These are plain functions extracted from App.jsx logic.

function sizeFit(lead, minRevenue) {
  if (!minRevenue || minRevenue <= 0) return "passes";
  const t = lead.annual_turnover;
  if (t == null || typeof t !== "number") return "unverified";
  return t >= minRevenue ? "passes" : "below";
}

// Minimal applyFilters stub — only revenue filter, returns main-list leads
function applyRevenueFilter(leads, minRevenue) {
  if (!minRevenue || minRevenue <= 0) return leads;
  return leads.filter(l => sizeFit(l, minRevenue) === "passes");
}

function unverifiedLeads(leads, minRevenue) {
  if (!minRevenue || minRevenue <= 0) return [];
  return leads.filter(l => sizeFit(l, minRevenue) === "unverified");
}

// ── Fixtures ──────────────────────────────────────────────────────

const confirmed6m   = { id: "a", annual_turnover: 6_000_000, priority: "HOT" };
const confirmed4m   = { id: "b", annual_turnover: 4_000_000, priority: "HOT" };
const confirmed5m   = { id: "c", annual_turnover: 5_000_000, priority: "HOT" };
const confirmed10m  = { id: "d", annual_turnover: 10_000_000, priority: "HOT" };
const confirmed25m  = { id: "e", annual_turnover: 25_000_000, priority: "HOT" };
const nullTurnover  = { id: "f", annual_turnover: null,       priority: "HOT" };
const undefTurnover = { id: "g",                              priority: "HOT" };  // field absent
const strTurnover   = { id: "h", annual_turnover: "£8m",     priority: "HOT" };  // string — not confirmed
const zeroed        = { id: "i", annual_turnover: 0,          priority: "HOT" };

const ALL = [confirmed6m, confirmed4m, confirmed5m, confirmed10m, confirmed25m, nullTurnover, undefTurnover, strTurnover, zeroed];

// ── Tests ─────────────────────────────────────────────────────────

describe("sizeFit", () => {
  it("1. confirmed £6m passes £5m+ threshold", () => {
    expect(sizeFit(confirmed6m, 5_000_000)).toBe("passes");
  });

  it("2. confirmed £4m fails £5m+ threshold", () => {
    expect(sizeFit(confirmed4m, 5_000_000)).toBe("below");
  });

  it("3. null turnover does not pass £5m+", () => {
    expect(sizeFit(nullTurnover, 5_000_000)).toBe("unverified");
  });

  it("4. undefined turnover (field absent) is unverified", () => {
    expect(sizeFit(undefTurnover, 5_000_000)).toBe("unverified");
  });

  it("5. string turnover ('£8m') is treated as unverified — not confirmed", () => {
    expect(sizeFit(strTurnover, 5_000_000)).toBe("unverified");
  });

  it("6a. £25m+ excludes £5m confirmed company", () => {
    expect(sizeFit(confirmed5m, 25_000_000)).toBe("below");
  });

  it("6b. £25m+ excludes £10m confirmed company", () => {
    expect(sizeFit(confirmed10m, 25_000_000)).toBe("below");
  });

  it("6c. £25m passes £25m+ threshold (exact boundary)", () => {
    expect(sizeFit(confirmed25m, 25_000_000)).toBe("passes");
  });

  it("10. minRevenue 0 (Any) always returns passes regardless of turnover", () => {
    expect(sizeFit(nullTurnover, 0)).toBe("passes");
    expect(sizeFit(undefTurnover, 0)).toBe("passes");
    expect(sizeFit(confirmed4m, 0)).toBe("passes");
    expect(sizeFit(strTurnover, 0)).toBe("passes");
  });
});

describe("applyRevenueFilter (main list)", () => {
  it("7/8/9. READY/Backup/Remaining: £5m+ removes confirmed-below and unknown companies", () => {
    const result = applyRevenueFilter(ALL, 5_000_000);
    const ids = result.map(l => l.id);
    // confirmed 6m, 5m (exact), 10m, 25m pass
    expect(ids).toContain("a"); // 6m
    expect(ids).toContain("c"); // 5m exact
    expect(ids).toContain("d"); // 10m
    expect(ids).toContain("e"); // 25m
    // confirmed 4m must be excluded
    expect(ids).not.toContain("b");
    // null/undefined/string turnover must not appear in main list
    expect(ids).not.toContain("f"); // null
    expect(ids).not.toContain("g"); // absent
    expect(ids).not.toContain("h"); // string
    // zero turnover (0 < 5m) is excluded
    expect(ids).not.toContain("i");
  });

  it("unverified companies go to unverified section, not main list", () => {
    const main  = applyRevenueFilter(ALL, 5_000_000);
    const unver = unverifiedLeads(ALL, 5_000_000);
    const mainIds  = main.map(l => l.id);
    const unverIds = unver.map(l => l.id);
    // null and absent-field leads are unverified
    expect(unverIds).toContain("f");
    expect(unverIds).toContain("g");
    expect(unverIds).toContain("h"); // string is also unverified
    // none of these appear in main
    for (const id of unverIds) {
      expect(mainIds).not.toContain(id);
    }
  });

  it("10. Any (minRevenue=0) returns all leads unchanged", () => {
    const result = applyRevenueFilter(ALL, 0);
    expect(result.length).toBe(ALL.length);
  });

  it("£25m+ removes £5m and £10m confirmed companies", () => {
    const result = applyRevenueFilter(ALL, 25_000_000);
    const ids = result.map(l => l.id);
    expect(ids).not.toContain("c"); // 5m
    expect(ids).not.toContain("d"); // 10m
    expect(ids).toContain("e");     // 25m passes
  });
});
