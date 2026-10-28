import { describe, expect, it } from "vitest";
import { handle, markFirstSeen } from "../netlify/functions/accounts.mjs";

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
