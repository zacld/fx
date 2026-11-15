import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { applySchema, batches, companyRecord, hashOf, markRecord, outreachPage, setMark, signalRecord, syncTable } from "../api/db.mjs";
import { buildRecords, changedFields } from "../scripts/db-sync.mjs";
import { handle } from "../api/accounts.mjs";
import { outreachPlan, setKnownGroups, withLeadScores } from "./accounts/format.js";

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
    expect(await syncTable(query, "companies", [a, b], { now: "t1" })).toEqual({ written: 2, deleted: 0, unchanged: 0, deferred: 0, total: 2 });
    expect(await syncTable(query, "companies", [a, b], { now: "t2" })).toEqual({ written: 0, deleted: 0, unchanged: 2, deferred: 0, total: 2 });
    const a2 = companyRecord({ company_number: "01", company_name: "A LTD", turnover_gbp: "41000000" }, { source: "list", score: 75 });
    expect(await syncTable(query, "companies", [a2], { now: "t3" })).toEqual({ written: 1, deleted: 1, unchanged: 0, deferred: 0, total: 1 });
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
  it("ranks the Outreach lists in the database exactly as the page does", async () => {
    const { query } = memoryDb();
    await applySchema(query);
    const today = new Date("2026-11-14");
    const rows = Array.from({ length: 60 }, (_, i) => ({ company_number: String(10000000 + i), company_name: `CO ${String(i).padStart(2, "0")} LIMITED`,
      filed_fx_score: 30 + (i * 7) % 50, turnover_gbp: String(25e6 + i * 1e6), fx_gain_loss_gbp: i % 3 ? String(-60000 - i * 1000) : "",
      accounts_filed_on: i % 2 ? "2026-10-01" : "2025-06-01", triggers: i % 5 === 0 ? `new charge to HSBC (2026-10)` : "" }));
    rows.push({ company_number: "20000001", company_name: "SMALL LIMITED", filed_fx_score: 60, turnover_gbp: "5000000" });   // held: under £20m
    const groups = { 10000001: { top: "P1", hops: 1 }, 10000002: { top: "P1", hops: 1 }, 10000004: { top: "P2", hops: 1 }, 10000005: { top: "P2", hops: 1 } };
    const contacted = { 10000005: { at: "2026-11-10", touches: 1 } };
    const verdict = { 10000007: { verdict: "not_fit", reason: "Too small" } };
    const recs = buildRecords({ list: { rows }, ranked: { group_of: groups }, marks: { contacted, verdict }, today });
    await syncTable(query, "companies", recs.companies);
    await query("INSERT INTO meta (key, value) VALUES ('synced', ?1)", [JSON.stringify({ at: "2026-11-14T20:00:00Z", deferred: 0 })]);
    const marks = { contacted: Object.keys(contacted), notFit: Object.keys(verdict) };
    // the page's own plan on the same rows
    setKnownGroups(groups);
    const scored = withLeadScores(rows.map((r) => (verdict[r.company_number] ? { ...r, qualified: "Out" } : r)), { today });
    const plan = outreachPlan(scored, { contacted, letters: 10, today });
    for (const list of ["letter", "call", "email"]) {
      const page = await outreachPage(query, { list, limit: 500, letters: 10, ...marks });
      expect(page.complete).toBe(true);
      expect(page.rows.map((r) => r.company_number)).toEqual(plan[list].map((r) => r.company_number));
      expect(page.counts[list]).toBe(plan[list].length);
      expect(page.rows.map((r) => r.why_now)).toEqual(plan[list].map((r) => r.why_now));
    }
    const letter = await outreachPage(query, { list: "letter", limit: 3, offset: 2, letters: 10, ...marks });
    expect(letter.rows.map((r) => r.outreach_rank)).toEqual([3, 4, 5]);                     // a page at a time
    // a Contacted saved on the page (in the store) drops the company — and its group — at once, database written or not
    const first = (await outreachPage(query, { list: "letter", limit: 1, letters: 10, ...marks })).rows[0].company_number;
    const after = await outreachPage(query, { list: "letter", limit: 1, letters: 10, ...marks, contacted: [...marks.contacted, first] });
    expect(after.rows[0].company_number).not.toBe(first);
    expect((await outreachPage(query, { list: "letter", limit: 1, letters: 10, ...marks })).rows[0].company_number).toBe(first);
    // a copy cut short by the daily budget isn't served: the page ranks in the browser until a full copy
    await query("UPDATE meta SET value = ?1 WHERE key = 'synced'", [JSON.stringify({ at: "x", deferred: 5 })]);
    expect((await outreachPage(query, { list: "letter", limit: 1, letters: 10 })).complete).toBe(false);
    setKnownGroups({});
  });
  it("keeps to a write budget, best first, and leaves the rest for the next sync", async () => {
    const { query } = memoryDb();
    await applySchema(query);
    const recs = Array.from({ length: 10 }, (_, i) => companyRecord({ company_number: `0${i}`, company_name: `C${i}` }, { source: "list", score: 100 - i }));
    expect(await syncTable(query, "companies", recs, { budget: 4 })).toMatchObject({ written: 4, deferred: 6 });
    expect((await query("SELECT number FROM companies ORDER BY number")).map((r) => r.number)).toEqual(["00", "01", "02", "03"]);
    expect(await syncTable(query, "companies", recs, { budget: 100 })).toMatchObject({ written: 6, unchanged: 4, deferred: 0 });
    expect(await syncTable(query, "companies", recs.slice(0, 7), { budget: 2 })).toMatchObject({ deleted: 2, deferred: 1 });
  });
  it("doesn't rewrite a company when only the figures in its reasons move (a currency's %, a fading moment)", () => {
    const rec = (pct) => companyRecord({ company_number: "01" }, { source: "list", score: 60,
      lead: { score: 60, parts: [[`Its currency moved: the pound up ${pct}% against USD in a week`, 10]], flags: {} } });
    expect(rec("3.1").hash).toBe(rec("3.4").hash);
    expect(JSON.parse(rec("3.4").lead).parts[0][0]).toContain("3.4%");
    const other = companyRecord({ company_number: "01" }, { source: "list", score: 60,
      lead: { score: 60, parts: [["FX loss of £80k", 10]], flags: {} } });
    expect(other.hash).not.toBe(rec("3.1").hash);
  });
  it("remakes the tables once for a new layout: one row per record, no indexes", async () => {
    const { query } = memoryDb();
    await query("CREATE TABLE companies (number TEXT PRIMARY KEY, x TEXT)");
    await query("CREATE INDEX companies_score ON companies (x)");
    await query("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
    await query("INSERT INTO meta VALUES ('synced', '{\"at\":\"old\"}')");
    expect(await applySchema(query)).toBe(true);
    expect(await applySchema(query)).toBe(false);
    const objects = await query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
    expect(objects.filter((o) => o.type === "index")).toEqual([]);
    expect(objects.filter((o) => o.type === "table" && o.name !== "meta").every((o) => /WITHOUT ROWID/.test(o.sql))).toBe(true);
    expect(await query("SELECT key FROM meta ORDER BY key")).toEqual([{ key: "schema" }]);
  });
  it("names the fields that differ when a record is rewritten (for the sync's log)", () => {
    const before = { number: "01", name: "A", hash: "x", row: JSON.stringify({ a: 1, b: [1, 2] }), lead: JSON.stringify({ score: 5 }), timely: "" };
    const after = { number: "01", name: "A", hash: "y", row: JSON.stringify({ a: 1, b: [2, 1] }), lead: JSON.stringify({ score: 5 }), timely: "x" };
    expect(changedFields(before, after).sort()).toEqual(["row.b", "timely"]);
  });
});
