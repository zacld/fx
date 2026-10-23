import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { handle } from "../netlify/functions/leads.mjs";

const leads = { a1: { company_name: "A LTD", director_name: "Jo Bloggs", score: 81 } };
const gz = gzipSync(Buffer.from(JSON.stringify(leads)));
const store = (data = gz) => () => ({ get: async () => (data ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null) });
const get = (auth) => new Request("https://x/api/leads", { headers: auth ? { authorization: auth } : {} });

describe("/api/leads", () => {
  it("returns the gzipped leads for the right password, which the browser un-gzips", async () => {
    const res = await handle(get("Bearer s3cret"), { password: "s3cret", store: store(), delay: 0 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await new Response(res.body.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(text).a1.director_name).toBe("Jo Bloggs");
  });

  it("refuses a wrong or missing password without the leads", async () => {
    for (const auth of ["Bearer nope", ""]) {
      const res = await handle(get(auth), { password: "s3cret", store: store(), delay: 0 });
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("Jo Bloggs");
    }
  });

  it("is closed until a password is set, and says when nothing is stored", async () => {
    expect((await handle(get("Bearer x"), { password: "", store: store(), delay: 0 })).status).toBe(503);
    expect((await handle(get("Bearer s3cret"), { password: "s3cret", store: store(null), delay: 0 })).status).toBe(404);
  });
});
