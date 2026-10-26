import { describe, it, expect } from "vitest";
import type { Lead } from "@fx/core";
import {
  accountsFields, employeeBand, inferAccountsType, parseIxbrlFinancials, sizeBandFromNetAssets, sizeBandFromTurnover,
} from "../src/stages/enrich-ch-accounts.js";
import { callReadiness } from "../src/stages/call-readiness.js";
import { auditLeads } from "../src/stages/audit.js";

// Expected values were checked against the Python scripts they replace (scripts/enrich_ch_accounts.py,
// compute_call_readiness.py): identical on these cases, and call readiness on all 1,297 leads.

describe("enrich-ch-accounts", () => {
  it("reads turnover, current net assets and employees from iXBRL", () => {
    const doc = `<ix:nonFraction name="core:TurnoverRevenue" contextRef="FY2024" unitRef="GBP" scale="3">23,412</ix:nonFraction>
      <ix:nonFraction name="core:NetAssetsLiabilities" contextRef="prior" unitRef="GBP">999</ix:nonFraction>
      <ix:nonFraction name="core:NetAssetsLiabilities" contextRef="current_bs" unitRef="GBP">1,234,567</ix:nonFraction>
      <ix:nonFraction name="core:AverageNumberEmployeesDuringPeriod" contextRef="cy" unitRef="pure">42</ix:nonFraction>`;
    expect(parseIxbrlFinancials(doc)).toEqual({ turnover: 23_412_000, netAssets: 1_234_567, totalAssets: null, employees: 42 });
  });

  it("names the accounts type from the filing", () => {
    expect(["full", "small", "micro-entity", "dormant", "group", "medium"].map((t) =>
      inferAccountsType({ type: "AA", description: `accounts-with-accounts-type-${t}` })))
      .toEqual(["full", "small", "micro-entity", "dormant", "group", "medium"]);
    expect(inferAccountsType({ type: "MCSA" })).toBe("micro-entity");
    expect(inferAccountsType({ type: "XYZ" })).toBe("unknown");
  });

  it("bands size by turnover, else net assets, and employees", () => {
    expect([999_999, 1e6, 5e6, 25e6, 1e8].map(sizeBandFromTurnover)).toEqual(["<£1m", "£1m–£5m", "£5m–£25m", "£25m–£100m", "£100m+"]);
    expect([100, 316_000, 5.1e6, 18e6].map(sizeBandFromNetAssets)).toEqual(["<£1m", "£1m–£5m", "£5m–£25m", "£25m–£100m"]);
    expect([1, 5, 25, 250, null].map(employeeBand)).toEqual(["1–4", "5–9", "25–49", "250+", "unknown"]);
  });

  it("builds the lead fields: turnover first, micro-entities small, dormant flagged", () => {
    const filing = { type: "AA", description: "accounts-with-accounts-type-full", description_values: { made_up_date: "2025-03-31" } };
    expect(accountsFields(filing, { turnover: 30e6, netAssets: 2e6, totalAssets: null, employees: 60 })).toEqual({
      accounts_type: "full", last_accounts_date: "2025-03-31", accounts_source: "ch_ixbrl", turnover_amount: 30_000_000,
      company_size_band: "£25m–£100m", net_assets: 2_000_000, employee_count: 60, employee_band: "50–99",
    });
    expect(accountsFields({ type: "AA", description: "micro-entity" }, null).company_size_band).toBe("<£1m");
    expect(accountsFields({ type: "AA", description: "dormant" }, null).company_size_band).toBe("dormant");
  });
});

describe("call-readiness", () => {
  const base = { priority: "HOT", score: 85, route_grade: "A", fx_likelihood_score: 70, website_confidence: "high",
    website: "https://acme.co.uk", fx_payment_signals: ["import"] } as unknown as Lead;

  it("READY when every gate passes", () => {
    expect(callReadiness(base)).toEqual({ status: "READY", reasons: [] });
  });
  it("REVIEW with grade C and some FX evidence, saying what's missing", () => {
    const r = callReadiness({ ...base, route_grade: "C" } as Lead);
    expect(r.status).toBe("REVIEW");
    expect(r.reasons).toEqual(["route grade C — need A or B (named FD/MD + contact)"]);
  });
  it("HOLD without a website", () => {
    expect(callReadiness({ ...base, website: null } as unknown as Lead).status).toBe("HOLD");
  });
});

describe("audit", () => {
  it("counts priorities, grades, gaps and anomalies", () => {
    const leads = [
      { id: "a", priority: "HOT", score: 90, route_grade: "D", website: "https://a.co.uk", event_id: "e1" },
      { id: "b", priority: "WARM", score: 70, route_grade: "A", fx_likelihood_score: 20, website: "https://a.co.uk", event_id: "e1" },
      { id: "c", priority: "SKIP", score: 10, event_id: "e2" },
    ] as unknown as Lead[];
    const a = auditLeads(leads);
    expect(a.priority).toEqual({ hot: 1, warm: 1, queue: 0, skip: 1 });
    expect(a.missing.website).toBe(1);
    expect(a.duplicate_domains.map(([d]) => d)).toEqual(["a.co.uk"]);
    expect(Object.values(a.anomalies).map((l) => l.length)).toEqual([1, 0, 1, 1]);
  });
});
