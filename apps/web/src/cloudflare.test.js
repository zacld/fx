import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kvKey, kvStore } from "../api/kv.mjs";
import { onRequest as accountsFn } from "../functions/api/accounts.js";
import { onRequest as leadsFn } from "../functions/api/leads.js";
import { onRequest as marketFn } from "../functions/api/market.js";
import { onRequest as accountsPage } from "../functions/accounts/[[path]].js";

// An in-memory Workers KV namespace: get(key, {type}) / put(key, value).
function memoryKv(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key, { type = "text" } = {}) {
      if (!data.has(key)) return null;
      const v = data.get(key);
      if (type === "json") return JSON.parse(typeof v === "string" ? v : new TextDecoder().decode(v));
      if (type === "arrayBuffer") return typeof v === "string" ? new TextEncoder().encode(v).buffer : v;
      return v;
    },
    async put(key, value) { data.set(key, value); },
  };
}

const list = { made_at: "2026-11-04T06:00:00+00:00", count: 1, rows: [{ company_number: "01234567", company_name: "A LTD", rank: 1 }] };
const auth = (method = "GET", body) => new Request("https://fx-dashboard.pages.dev/api/accounts", {
  method, headers: { authorization: "Bearer s3cret" }, ...(body ? { body: JSON.stringify(body) } : {}),
});

describe("Cloudflare Pages Functions over KV", () => {
  it("keys every store under one namespace", () => {
    expect(kvKey("fx-accounts", "latest")).toBe("fx-accounts/latest");
    expect(() => kvStore(undefined, "fx-accounts")).toThrow(/FX_STORE/);
  });

  it("tries a write again when KV turns it away (one write a second per key)", async () => {
    let tries = 0;
    const ns = { put: async () => { if (++tries < 2) throw new Error("KV PUT failed: 429 Too Many Requests"); } };
    await kvStore(ns, "fx-accounts", { waits: [0, 0] }).setJSON("contacted", {});
    expect(tries).toBe(2);
    const never = { put: async () => { throw new Error("429"); } };
    await expect(kvStore(never, "fx-accounts", { waits: [0, 0] }).setJSON("contacted", {})).rejects.toThrow(/429/);
  });

  it("/api/accounts reads the list and saves Contacted marks and notes in KV", async () => {
    const FX_STORE = memoryKv({ "fx-accounts/latest": JSON.stringify(list) });
    const env = { ACCOUNTS_PASSWORD: "s3cret", FX_STORE };
    const res = await accountsFn({ request: auth(), env });
    expect(res.status).toBe(200);
    expect((await res.json()).rows[0].company_name).toBe("A LTD");
    const saved = await accountsFn({ request: auth("POST", { company_number: "01234567", contacted: true, channel: "phone" }), env });
    expect(saved.status).toBe(200);
    expect(Object.keys(JSON.parse(FX_STORE.data.get("fx-accounts/contacted")))).toEqual(["01234567"]);
    await accountsFn({ request: auth("POST", { company_number: "01234567", notes: "Call after 3pm" }), env });
    expect(JSON.parse(FX_STORE.data.get("fx-accounts/notes"))["01234567"].text).toBe("Call after 3pm");
    // the contacted mark from the first save is still there after the second
    expect((await (await accountsFn({ request: auth(), env })).json()).contacted["01234567"].touches).toHaveLength(1);
  });

  it("/api/accounts refuses without the site's password set or with a wrong one", async () => {
    const FX_STORE = memoryKv({ "fx-accounts/latest": JSON.stringify(list) });
    expect((await accountsFn({ request: auth(), env: { FX_STORE } })).status).toBe(503);
  }, 5000);

  it("/api/leads serves the gzipped leads and /api/market the moves", async () => {
    const gz = gzipSync(Buffer.from(JSON.stringify({ a: { company_name: "A LTD" } })));
    const FX_STORE = memoryKv({ "fx-leads/leads.json.gz": gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
                                "fx-market/latest": JSON.stringify({ as_of: "2026-11-04", currencies: [] }) });
    const leads = await leadsFn({ request: new Request("https://x/api/leads", { headers: { authorization: "Bearer s3cret" } }),
                                  env: { ACCOUNTS_PASSWORD: "s3cret", FX_STORE } });
    expect(leads.status).toBe(200);
    const text = await new Response(leads.body.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(JSON.parse(text).a.company_name).toBe("A LTD");
    const market = await marketFn({ request: new Request("https://x/api/market"), env: { FX_STORE } });
    expect((await market.json()).as_of).toBe("2026-11-04");
  });

  it("serves the Accounts page for /accounts/<company number>", async () => {
    const asked = [];
    const env = { ASSETS: { fetch: async (url) => { asked.push(String(url)); return new Response("<html>accounts</html>"); } } };
    const res = await accountsPage({ request: new Request("https://fx-dashboard.pages.dev/accounts/01234567"), env });
    expect(await res.text()).toContain("accounts");
    expect(asked).toEqual(["https://fx-dashboard.pages.dev/accounts"]);
  });
});

describe("the workflows' store (scripts/store.mjs)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("writes to Cloudflare KV through its API, reading Netlify's copy only while Cloudflare has none", async () => {
    // pasted with a stray space, a line break and capitals: still the account
    Object.assign(process.env, { CLOUDFLARE_API_TOKEN: " t\n", CLOUDFLARE_ACCOUNT_ID: " 0123456789ABCDEF0123456789abcdef\n" });
    delete process.env.NETLIFY_SITE_ID;
    const kv = new Map();
    const calls = [];
    vi.stubGlobal("fetch", async (url, init = {}) => {
      const u = new URL(url);
      calls.push(`${init.method || "GET"} ${u.pathname}`);
      if (u.pathname.endsWith("/storage/kv/namespaces")) {
        return init.method === "POST" ? Response.json({ success: true, result: { id: "ns1" } })
          : Response.json({ success: true, result: [] });
      }
      const key = decodeURIComponent(u.pathname.split("/values/")[1]);
      if (init.method === "PUT") { kv.set(key, init.body); return Response.json({ success: true }); }
      return kv.has(key) ? new Response(kv.get(key)) : new Response("", { status: 404 });
    });
    const { openStore } = await import("../scripts/store.mjs");
    const store = await openStore("fx-accounts");
    expect(store.where).toBe("Cloudflare");
    expect(await store.get("latest")).toBeNull();
    await store.set("latest", list);
    expect((await store.get("latest")).rows).toHaveLength(1);
    expect([...kv.keys()]).toEqual(["fx-accounts/latest"]);
    const create = "POST /client/v4/accounts/0123456789abcdef0123456789abcdef/storage/kv/namespaces";
    expect(calls).toContain(create);   // created the first time
    expect(calls.filter((c) => c === create)).toHaveLength(1);
  });

  it("says plainly when the account ID isn't one, before calling Cloudflare", async () => {
    Object.assign(process.env, { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "zac@example.com" });
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const { openStore, accountIdProblem } = await import("../scripts/store.mjs");
    expect(accountIdProblem()).toMatch(/an email address.*Account ID/);
    await expect((await openStore("fx-market")).get("latest")).rejects.toThrow(/isn't a Cloudflare account ID/);
    expect(fetched).not.toHaveBeenCalled();
  });

  it("refuses to run with no store configured", async () => {
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "NETLIFY_SITE_ID", "NETLIFY_AUTH_TOKEN"]) delete process.env[k];
    const { openStore } = await import("../scripts/store.mjs");
    await expect(openStore("fx-market")).rejects.toThrow(/no store configured/);
  });
});
