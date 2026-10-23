import { describe, expect, it } from "vitest";
import { handle } from "../netlify/functions/accounts.mjs";

const list = { made_at: "2026-10-21T06:00:00+00:00", count: 1, rows: [{ company_name: "A LTD", rank: 1 }] };
const store = (data = list) => () => ({ get: async () => data });
const get = (auth) => new Request("https://x/api/accounts", { headers: auth ? { authorization: auth } : {} });

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
    const post = new Request("https://x/api/accounts", { method: "POST", headers: { authorization: "Bearer s3cret" } });
    expect((await handle(post, { password: "s3cret", store: store(), delay: 0 })).status).toBe(405);
  });
});
