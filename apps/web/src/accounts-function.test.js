import { describe, expect, it } from "vitest";
import { applyEmail, filingsCalls, filingsLosses, filingsMonth, handle, markFirstSeen, recordStatus } from "../api/accounts.mjs";

const list = { made_at: "2026-10-21T06:00:00+00:00", count: 1, rows: [{ company_name: "A LTD", rank: 1 }] };
// An in-memory Blobs store: the list under "latest", Zac's contacted marks under "contacted".
const memory = (data = list, marks = null) => {
  const blobs = { latest: data, contacted: marks, notes: null };
  return Object.assign(() => ({ get: async (k) => blobs[k] ?? null, setJSON: async (k, v) => { blobs[k] = v; } }), { blobs });
};
const store = (data = list) => memory(data);
const get = (auth) => new Request("https://x/api/accounts", { headers: auth ? { authorization: auth } : {} });
const post = (body, auth = "Bearer s3cret") =>
  new Request("https://x/api/accounts", { method: "POST", headers: { authorization: auth }, body: JSON.stringify(body) });

describe("/api/accounts", () => {
  it("returns the list for the right password, never cached", async () => {
    const res = await handle(get("Bearer s3cret"), { password: "s3cret", store: store(), delay: 0 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).rows[0].company_name).toBe("A LTD");
  });

  it("refuses a wrong or missing password without the list", async () => {
    for (const auth of ["Bearer nope", "", "Bearer s3cre"]) {
      const res = await handle(get(auth), { password: "s3cret", store: store(), delay: 0 });
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain("A LTD");
    }
  });

  it("is closed until a password is set, and says when nothing is uploaded", async () => {
    expect((await handle(get("Bearer x"), { password: "", store: store(), delay: 0 })).status).toBe(503);
    expect((await handle(get("Bearer s3cret"), { password: "s3cret", store: store(null), delay: 0 })).status).toBe(404);
    const put = new Request("https://x/api/accounts", { method: "PUT", headers: { authorization: "Bearer s3cret" } });
    expect((await handle(put, { password: "s3cret", store: store(), delay: 0 })).status).toBe(405);
  });

  it("marks and unmarks a company contacted, and returns the marks with the list", async () => {
    const s = memory();
    const opts = { password: "s3cret", store: s, delay: 0 };
    const res = await handle(post({ company_number: "01234567", contacted: true }), opts);
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()).contacted)).toEqual(["01234567"]);
    expect((await (await handle(get("Bearer s3cret"), opts)).json()).contacted["01234567"].at).toMatch(/^\d{4}-/);
    await handle(post({ company_number: "01234567", contacted: false }), opts);
    expect(s.blobs.contacted).toEqual({});
    expect(s.blobs.latest).toBe(list);                        // the finder's list is never rewritten
  });

  it("returns the Recent FX filings list on ?view=filings, behind the same password", async () => {
    const s = memory();
    const filings = { made_at: "2026-11-05T07:00:00+00:00", rows: [{ company_number: "01234567", company_name: "B LTD" }],
                      files_done: ["Accounts_Bulk_Data-2026-11-04.zip"] };
    const opts = { password: "s3cret", store: s, delay: 0 };
    const view = (auth) => new Request("https://x/api/accounts?view=filings", { headers: { authorization: auth } });
    expect((await handle(view("Bearer s3cret"), opts)).status).toBe(404);   // not scanned yet
    s.blobs.filings = filings;
    const res = await handle(view("Bearer s3cret"), opts);
    const body = await res.json();
    expect(body.rows[0].company_name).toBe("B LTD");
    expect(body.files_done).toBeUndefined();                                // bookkeeping stays in the store
    expect(body.contacted).toBeUndefined();
    expect((await handle(view("Bearer nope"), opts)).status).toBe(401);
    // a year of filings is kept one month per item: the index lists the months, ?month= returns one
    s.blobs.filings = { made_at: "x", months: [{ month: "2026-09", count: 1 }], files_done: ["a.zip"] };
    s.blobs["filings/2026-09"] = { month: "2026-09", rows: [{ company_number: "02", company_name: "C LTD" }] };
    expect((await (await handle(view("Bearer s3cret"), opts)).json()).months).toEqual([{ month: "2026-09", count: 1 }]);
    const month = (m) => new Request(`https://x/api/accounts?view=filings&month=${m}`, { headers: { authorization: "Bearer s3cret" } });
    expect((await (await handle(month("2026-09"), opts)).json()).rows[0].company_name).toBe("C LTD");
    expect((await (await handle(month("2026-08"), opts)).json()).rows).toEqual([]);
    expect((await handle(month("../latest"), opts)).status).toBe(400);
  });

  it("returns the year's FX losses on ?view=losses, biggest first and trimmed to what the tab shows", async () => {
    const s = memory();
    const opts = { password: "s3cret", store: s, delay: 0 };
    const view = (auth) => new Request("https://x/api/accounts?view=losses", { headers: { authorization: auth } });
    expect((await (await handle(view("Bearer s3cret"), opts)).json()).rows).toEqual([]);   // none saved yet
    const losses = filingsLosses([
      { company_number: "01", company_name: "A LTD", fx_gain_loss_gbp: "-20000", fx_mentions: ["long text"], filed: "2026-10-01" },
      { company_number: "02", company_name: "B LTD", fx_gain_loss_gbp: "35000" },
      { company_number: "03", company_name: "C LTD", fx_gain_loss_gbp: "-900000", fx_forwards: "" },
    ]);
    expect(losses.map((r) => r.company_number)).toEqual(["03", "01"]);
    expect(losses[1].fx_mentions).toBeUndefined();
    expect("fx_forwards" in losses[0]).toBe(false);   // empty fields left out
    s.blobs["filings/losses"] = { made_at: "x", count: 2, rows: losses };
    expect((await (await handle(view("Bearer s3cret"), opts)).json()).count).toBe(2);
    expect((await handle(view("Bearer nope"), opts)).status).toBe(401);
  });

  it("keeps the lead checklist's CRM tick (a date only) and returns it with the list", async () => {
    const s = memory();
    s.blobs.latest = { rows: [{ company_number: "01234567", company_name: "A LTD" }] };
    const opts = { password: "s3cret", store: s, delay: 0 };
    const post = (body) => handle(new Request("https://x/api/accounts", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify(body) }), opts);
    expect((await post({ company_number: "01234567", crm_checked: "yes" })).status).toBe(400);
    const ticked = await (await post({ company_number: "01234567", crm_checked: true })).json();
    expect(Object.keys(ticked.checks)).toEqual(["01234567"]);
    expect(ticked.checks["01234567"].crm).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const got = await (await handle(new Request("https://x/api/accounts", { headers: { authorization: "Bearer s3cret" } }), opts)).json();
    expect(Object.keys(got.checks)).toEqual(["01234567"]);
    expect((await (await post({ company_number: "01234567", crm_checked: false })).json()).checks).toEqual({});
  });

  it("keeps the filings list's Call today candidates and serves them", async () => {
    const s = memory();
    const opts = { password: "s3cret", store: s, delay: 0 };
    const calls = filingsCalls([
      { company_number: "01", turnover_gbp: "30000000", filed_fx_score: 60, rank_score: 60, fx_gain_loss_gbp: "-1000" },
      { company_number: "02", turnover_gbp: "30000000", filed_fx_score: 90, rank_score: 90, triggers: "new charge (2026-08)" },
      { company_number: "03", turnover_gbp: "30000000", filed_fx_score: 90, fx_gain_loss_gbp: "5000" },          // no loss, no trigger
      { company_number: "04", turnover_gbp: "500000000", filed_fx_score: 90, triggers: "x" },                      // above the band
      { company_number: "05", turnover_gbp: "30000000", filed_fx_score: 40, triggers: "x" },                       // weak proof
    ]);
    expect(calls.map((r) => r.company_number)).toEqual(["02", "01"]);
    s.blobs["filings/calls"] = { made_at: "x", count: 2, rows: calls };
    const res = await handle(new Request("https://x/api/accounts?view=calls", { headers: { authorization: "Bearer s3cret" } }), opts);
    expect((await res.json()).count).toBe(2);
  });

  it("keeps the Email generator's companies on the site: add, edit, reset, remove", async () => {
    const s = memory();
    const opts = { password: "s3cret", store: s, delay: 0 };
    const row = { company_number: "01234567", company_name: "A LTD", fx_mentions: ["not kept"], finance_contact: "Jane Smith" };
    let res = await handle(post({ company_number: "01234567", email: { row } }), opts);
    expect(res.status).toBe(200);
    expect(s.blobs.emails["01234567"]).toMatchObject({ row: { company_name: "A LTD", finance_contact: "Jane Smith" }, text: null });
    expect(s.blobs.emails["01234567"].row.fx_mentions).toBeUndefined();
    await handle(post({ company_number: "01234567", email: { text: "Hi Jane" } }), opts);
    expect(s.blobs.emails["01234567"]).toMatchObject({ text: "Hi Jane", row: { company_name: "A LTD" } });
    await handle(post({ company_number: "01234567", email: { text: null } }), opts);
    expect(s.blobs.emails["01234567"].text).toBe(null);
    expect((await handle(post({ company_number: "01234567", email: { text: 5 } }), opts)).status).toBe(400);
    expect((await handle(post({ company_number: "bad", email: null }), opts)).status).toBe(400);
    await handle(post({ company_number: "01234567", email: null }), opts);
    expect(s.blobs.emails).toEqual({});
    expect((await handle(post({ company_number: "01234567", email: null }, "Bearer nope"), opts)).status).toBe(401);
    const many = Array.from({ length: 105 }, (_, i) => i).reduce((e, i) =>
      applyEmail(e, String(i).padStart(8, "0"), { row: { company_name: `C${i}` } }, `2026-11-08T00:${String(i % 60).padStart(2, "0")}:${String(Math.floor(i / 60)).padStart(2, "0")}Z`), {});
    expect(Object.keys(many)).toHaveLength(100);
  });

  it("records each workflow's last outcome and when it last worked", () => {
    let st = recordStatus({}, "finder", { at: "2026-11-08T20:00:00Z", state: "ok" });
    st = recordStatus(st, "finder", { at: "2026-11-09T20:00:00Z", state: "failed", run: "https://github.com/x" });
    expect(st.jobs.finder).toEqual({ at: "2026-11-09T20:00:00Z", state: "failed", run: "https://github.com/x", last_ok: "2026-11-08T20:00:00Z" });
  });

  it("files a filing under the month it was filed", () => {
    expect([filingsMonth("2026-11-04"), filingsMonth("September 2026"), filingsMonth("")]).toEqual(["2026-11", "2026-09", "unknown"]);
  });

  it("saves, returns and deletes a company's notes", async () => {
    const s = memory();
    const opts = { password: "s3cret", store: s, delay: 0 };
    const res = await handle(post({ company_number: "01234567", notes: "  Spoke to FD, call back Jan  " }), opts);
    expect((await res.json()).notes["01234567"].text).toBe("Spoke to FD, call back Jan");
    expect(s.blobs.contacted).toBe(null);                      // a note doesn't touch the contacted marks
    expect((await (await handle(get("Bearer s3cret"), opts)).json()).notes["01234567"].text).toBe("Spoke to FD, call back Jan");
    await handle(post({ company_number: "01234567", notes: "" }), opts);
    expect(s.blobs.notes).toEqual({});
    expect((await handle(post({ company_number: "01234567", notes: "x".repeat(4001) }), opts)).status).toBe(400);
  });

  it("logs touches by channel, a reply and a chosen follow-up date", async () => {
    const s = memory();
    const opts = { password: "s3cret", store: s, delay: 0 };
    await handle(post({ company_number: "01234567", contacted: true, channel: "phone" }), opts);
    await handle(post({ company_number: "01234567", contacted: true, channel: "email" }), opts);
    await handle(post({ company_number: "01234567", follow_up_at: "2026-11-05" }), opts);
    const res = await handle(post({ company_number: "01234567", response: "replied" }), opts);
    const mark = (await res.json()).contacted["01234567"];
    expect(mark.touches.map((t) => t.channel)).toEqual(["phone", "email"]);
    expect([mark.follow_up_at, mark.response]).toEqual(["2026-11-05", "replied"]);
    expect((await handle(post({ company_number: "01234567", channel: "fax", contacted: true }), opts)).status).toBe(400);
    expect((await handle(post({ company_number: "01234567", response: "maybe" }), opts)).status).toBe(400);
  });

  it("refuses a bad contacted mark, and any mark without the password", async () => {
    const s = memory();
    for (const body of [{ company_number: "../x", contacted: true }, { company_number: "01234567" }, {}]) {
      expect((await handle(post(body), { password: "s3cret", store: s, delay: 0 })).status).toBe(400);
    }
    expect((await handle(post({ company_number: "01234567", contacted: true }, "Bearer no"), { password: "s3cret", store: s, delay: 0 })).status).toBe(401);
    expect(s.blobs.contacted).toBe(null);
  });
});

describe("markFirstSeen", () => {
  it("keeps when each company first appeared, so only the latest scan's additions are new", () => {
    const old = { made_at: "2026-10-27", rows: [{ company_number: "01", first_seen: "2026-10-01" }, { company_number: "02" }] };
    const next = { made_at: "2026-10-28", rows: [{ company_number: "01" }, { company_number: "02" }, { company_number: "03" }] };
    expect(markFirstSeen(old, next).rows.map((r) => r.first_seen)).toEqual(["2026-10-01", "2026-10-27", "2026-10-28"]);
    expect(markFirstSeen(null, next).rows.every((r) => r.first_seen === "2026-10-28")).toBe(true);
  });
});
