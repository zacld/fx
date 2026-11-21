import { describe, expect, it } from "vitest";
import { handle as accounts } from "../api/accounts.mjs";
import { handle, statusOf } from "../api/feed.mjs";
import { feedRows } from "./accounts/ranking.js";

const memory = (blobs) => () => ({ get: async (k) => blobs[k] ?? null, setJSON: async (k, v) => { blobs[k] = v; } });
const feedGet = (q) => new Request(`https://x/api/feed${q}`);
const keyOf = async (store) => (await (await accounts(new Request("https://x/api/accounts?view=feedkey", { headers: { authorization: "Bearer s3cret" } }),
  { password: "s3cret", store, delay: 0 })).json()).key;

describe("/api/feed (Power Automate)", () => {
  const blobs = {
    "feed/all": { made_at: "2026-11-21T05:00:00Z", rows: [
      { company_number: "01234567", company_name: "ACME LTD", source: "Accounts list", lead_score: 70, ruled_out: "" },
      { company_number: "07654321", company_name: "BANKY PLC", source: "FX filings", lead_score: 40, ruled_out: "a bank" }] },
    "emerging/companies": { rows: [{ company_number: "01234567", company_name: "ACME LTD", niches: ["Emerging: Tableware (customs 3924)"] },
      { company_number: "SC123456", company_name: "TOMATO CO", niches: ["Emerging: Tomatoes (customs 2002)"], sic_codes: ["46310"] }] },
    contacted: { "01234567": { at: "x" } },
    checks: { SC123456: { review: "open" } },
  };
  const store = memory(blobs);

  it("serves every lead with its status for the right key, never the password", async () => {
    const key = await keyOf(store);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    expect((await handle(feedGet("?key=s3cret"), { password: "s3cret", store, delay: 0 })).status).toBe(401);   // the password isn't the key
    expect((await handle(feedGet(""), { password: "s3cret", store, delay: 0 })).status).toBe(401);
    const body = await (await handle(feedGet(`?key=${key}`), { password: "s3cret", store, delay: 0 })).json();
    expect(body.total).toBe(2);                                                     // the bank is ruled out; ACME not twice
    expect(body.rows.map((r) => [r.company_number, r.status, r.source])).toEqual([
      ["01234567", "Contacted", "Accounts list"], ["SC123456", "Open lead", "Emerging niche"]]);
    expect(body.rows[1].niche).toBe("Tomatoes (customs 2002)");
    expect(body.rows[0].companies_house_url).toContain("/company/01234567");
    const all = await (await handle(feedGet(`?key=${key}&include_out=1&limit=1&offset=1`), { password: "s3cret", store, delay: 0 })).json();
    expect([all.total, all.count, all.next_offset]).toEqual([3, 1, 2]);
    const todo = await (await handle(feedGet(`?key=${key}&status=to-check&include_out=1`), { password: "s3cret", store, delay: 0 })).json();
    expect(todo.rows.map((r) => r.company_number)).toEqual(["07654321"]);   // only the ones still to check
    const csv = await (await handle(feedGet(`?key=${key}&format=csv`), { password: "s3cret", store, delay: 0 })).text();
    expect(csv.split("\r\n")[0]).toMatch(/^company_number,company_name,source,status/);
  });

  it("retires the old key when a new one is made", async () => {
    const old = await keyOf(store);
    const res = await accounts(new Request("https://x/api/accounts", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ feed_key: "new" }) }),
      { password: "s3cret", store, delay: 0 });
    const fresh = (await res.json()).key;
    expect(fresh).not.toBe(old);
    expect((await handle(feedGet(`?key=${old}`), { password: "s3cret", store, delay: 0 })).status).toBe(401);
    expect((await handle(feedGet(`?key=${fresh}`), { password: "s3cret", store, delay: 0 })).status).toBe(200);
  });

  it("names each status and builds flat rows from the ranking", () => {
    expect(statusOf("A", { verdicts: { A: { verdict: "not_fit" } } })).toBe("Not a fit");
    expect(statusOf("A", {})).toBe("To check");
    const rows = feedRows([{ company_number: "01234567", company_name: "ACME LTD", onList: true, niche: "Coffee", score: 61, fit: 50, timing: 10, absurd: "" }],
      [{ company_number: "01234567", sic_codes: ["46370"], turnover_gbp: "45000000", postcode: "AB1 2CD" }]);
    expect(rows[0]).toMatchObject({ source: "Accounts list", lead_score: 61, now: 10, turnover_gbp: 45000000, sic: "46370", postcode: "AB1 2CD" });
  });
});
