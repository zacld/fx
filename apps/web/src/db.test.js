import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { applySchema, batches, companyRecord, hashOf, markRecord, signalRecord, syncTable } from "../api/db.mjs";
import { buildRecords } from "../scripts/db-sync.mjs";
import { handle } from "../api/accounts.mjs";
import { setKnownGroups } from "./accounts/format.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
// D1's `query(sql, params) -> rows` on Node's own SQLite (the same engine D1 runs)
function memoryDb() {
  const db = new DatabaseSync(":memory:");
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push(sql.split(" ")[0]);
    const st = db.prepare(sql);
    return /^\s*(SELECT|WITH)/i.test(sql) ? st.all(...params) : (st.run(...params), []);
  };
  return { db, query, calls };
}

describe("Database (D1) mirror", () => {
  it("creates the tables, writes only what changed, and deletes what's gone", async () => {
    const { query } = memoryDb();
    await applySchema(query);
    await applySchema(query);   // safe to repeat
    const a = companyRecord({ company_number: "01", company_name: "A LTD", turnover_gbp: "40000000" }, { source: "list", score: 72, details: { x: "long" } });
    const b = companyRecord({ company_number: "02", company_name: "B LTD" }, { source: "filings", score: 40 });
    expect(await syncTable(query, "companies", [a, b], { now: "t1" })).toEqual({ written: 2, deleted: 0, unchanged: 0, total: 2 });
    expect(await syncTable(query, "companies", [a, b], { now: "t2" })).toEqual({ written: 0, deleted: 0, unchanged: 2, total: 2 });
    const a2 = companyRecord({ company_number: "01", company_name: "A LTD", turnover_gbp: "41000000" }, { source: "list", score: 75 });
    expect(await syncTable(query, "companies", [a2], { now: "t3" })).toEqual({ written: 1, deleted: 1, unchanged: 0, total: 1 });
    const rows = await query("SELECT number, lead_score, turnover_gbp, updated_at, details, row FROM companies");
    expect(rows.map((r) => [r.number, r.lead_score, r.turnover_gbp, r.updated_at, r.details])).toEqual([["01", 75, 41000000, "t3", null]]);
    expect(JSON.parse(rows[0].row).company_name).toBe("A LTD");
  });
  it("keys marks by company and kind, signals by id, and splits big writes into batches", async () => {
    const { query, calls } = memoryDb();
    await applySchema(query);
    const marks = [markRecord("01", "contacted", { at: "2026-11-14", touches: 1 }), markRecord("01", "notes", { text: "rang", at: "x" }),
      markRecord("02", "verdict", { verdict: "good" })];
    expect((await syncTable(query, "marks", marks)).written).toBe(3);
    expect((await syncTable(query, "marks", marks.slice(1))).deleted).toBe(1);
    expect((await query("SELECT number, kind FROM marks ORDER BY number, kind")).map((r) => `${r.number}/${r.kind}`)).toEqual(["01/notes", "02/verdict"]);
    const many = Array.from({ length: 300 }, (_, i) => signalRecord({ id: `s${i}`, company_number: "01", kind: "new_trader", at: "2026-11-01", title: "x".repeat(200) }, "moments"));
    expect(batches(many, 20_000).length).toBeGreaterThan(3);
    calls.length = 0;
    expect((await syncTable(query, "signals", many, { maxBytes: 20_000 })).written).toBe(300);
    expect(calls.filter((c) => c === "INSERT").length).toBeGreaterThan(3);
    expect((await query("SELECT COUNT(*) AS n FROM signals"))[0].n).toBe(300);
    expect(hashOf({ a: 1 })).toBe(hashOf({ a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
  it("builds every company with its lead score, group and details, and the signals and marks", () => {
    const list = { made_at: "m", rows: [{ company_number: "01", company_name: "A LTD", filed_fx_score: 60, turnover_gbp: "40000000" },
      { company_number: "03", company_name: "C BANK PLC" }] };
    const ranked = { rows: [{ company_number: "02", company_name: "B LTD", filed_fx_score: 55, fx_niche: "Wine" },
      { company_number: "01", company_name: "A LTD" }], ruled_out: { "03": "a bank" }, niche_of: { "01": "Wine" },
      group_of: { "02": { top: "P1", hops: 1 } } };
    const out = buildRecords({ list, details: [{ "01": { fx_today_evidence: "quote" } }], filingRows: [{ company_number: "02", fx_mentions: "long text" }],
      ranked, alerts: { items: [{ id: "a1", company_number: "01", kind: "bank_switch", at: "2026-11-10T09:00:00", title: "Changed bank", hot: true }] },
      deals: { items: [{ company_number: "02", kind: "pe_buyout", date: "2026-11-01", detail: "Bought by X Bidco" }] },
      marks: { contacted: { "01": { at: "2026-11-12" } } }, today: new Date("2026-11-14") });
    const by = Object.fromEntries(out.companies.map((c) => [c.number, c]));
    expect(Object.keys(by).sort()).toEqual(["01", "02", "03"]);           // 01 once (on the list), 02 from the filings scan
    expect([by["01"].source, by["01"].fx_niche, JSON.parse(by["01"].details).fx_today_evidence]).toEqual(["list", "Wine", "quote"]);
    expect(by["01"].lead_score).toBeGreaterThan(by["03"].lead_score);
    expect([by["03"].ruled_out, JSON.parse(by["03"].row).qualified]).toEqual(["a bank", "Out"]);
    expect([by["02"].source, by["02"].group_key, JSON.parse(by["02"].details).fx_mentions]).toEqual(["filings", "P1", "long text"]);
    expect(out.signals.map((s) => [s.id, s.hot])).toEqual([["a1", 1], ["pe_buyout:02:2026-11-01", 0]]);
    expect(out.marks.map((m) => `${m.number}/${m.kind}`)).toEqual(["01/contacted"]);
    setKnownGroups({});
  });
  it("tells the page whether the database is bound, when it was copied and how much it holds", async () => {
    const { query } = memoryDb();
    await applySchema(query);
    await syncTable(query, "companies", [companyRecord({ company_number: "01", company_name: "A LTD" }, { source: "list", score: 50 })]);
    await query("INSERT INTO meta (key, value) VALUES ('synced', ?1)", [JSON.stringify({ at: "2026-11-14T20:00:00Z" })]);
    const ask = (db) => handle(new Request("https://x/api/accounts?view=db", { headers: { authorization: "Bearer pw" } }),
      { password: "pw", store: () => ({ get: async () => null }), db, delay: 0 }).then((r) => r.json());
    expect(await ask(query)).toEqual({ bound: true, synced: { at: "2026-11-14T20:00:00Z" }, counts: { companies: 1, signals: 0, marks: 0 } });
    expect(await ask(null)).toEqual({ bound: false });
  });
});
