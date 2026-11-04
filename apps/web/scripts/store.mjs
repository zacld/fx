// The site's private store, from the workflows (Node): Cloudflare Workers KV through Cloudflare's API, the same keys
// the Pages Functions read (api/kv.mjs: "<store>/<key>" in the "fx-dashboard-store" namespace).
//
//   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID set  -> Cloudflare (Netlify's copy is read only when Cloudflare has
//                                                       nothing yet, so the first runs after the move carry on);
//   only NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN set      -> Netlify Blobs, as before the move.
//
// openStore(name) -> {where, get(key, "json" | "bytes"), set(key, value)}; value: an object (stored as JSON) or bytes.
import { kvKey } from "../api/kv.mjs";

export const NAMESPACE_TITLE = process.env.CLOUDFLARE_KV_NAMESPACE || "fx-dashboard-store";
const API = "https://api.cloudflare.com/client/v4";

// Secrets pasted with a stray space or line break still work; an account ID that isn't one says so plainly.
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (process.env[k] !== undefined) process.env[k] = process.env[k].trim();
}
if (/^[0-9a-f]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID || "")) {
  process.env.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID.toLowerCase();
}
export const cloudflareConfigured = () => Boolean(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID);

/** Why CLOUDFLARE_ACCOUNT_ID can't be an account ID, or "" — the API only answers "could not route" otherwise. */
export function accountIdProblem(id = process.env.CLOUDFLARE_ACCOUNT_ID || "") {
  if (/^[0-9a-f]{32}$/.test(id)) return "";
  const shape = id.includes("@") ? "an email address" : /^[0-9a-f]{32}$/i.test(id) ? "in capitals"
    : `${id.length} characters${/[^0-9a-f]/i.test(id) ? ", not all hex digits" : ""}`;
  return `CLOUDFLARE_ACCOUNT_ID isn't a Cloudflare account ID (expected 32 lower-case hex characters; got ${shape}). ` +
    "Copy the Account ID from the Cloudflare dashboard → Workers & Pages (right-hand side) or Account home → ⋯ → " +
    "Copy account ID — not the Zone ID or your email — into the GitHub secret.";
}
export const netlifyConfigured = () => Boolean(process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN);

async function cf(path, init = {}) {
  const problem = accountIdProblem();
  if (problem) throw new Error(problem);
  const res = await fetch(`${API}/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, ...(init.headers || {}) },
  });
  return res;
}

async function cfJson(path, init) {
  const res = await cf(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const why = (body.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${init?.method || "GET"} ${path.split("?")[0]} failed — ${why}`);
  }
  return body.result;
}

let namespaceId;
/** The KV namespace's id, found by its title and created the first time. */
export async function kvNamespaceId() {
  if (namespaceId) return namespaceId;
  for (let page = 1; page < 50; page++) {
    const list = await cfJson(`/storage/kv/namespaces?per_page=100&page=${page}`);
    const found = list.find((n) => n.title === NAMESPACE_TITLE);
    if (found) return (namespaceId = found.id);
    if (list.length < 100) break;
  }
  const made = await cfJson("/storage/kv/namespaces", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: NAMESPACE_TITLE }),
  });
  return (namespaceId = made.id);
}

const valuePath = async (store, key) =>
  `/storage/kv/namespaces/${await kvNamespaceId()}/values/${encodeURIComponent(kvKey(store, key))}`;

function cloudflareStore(name) {
  return {
    where: "Cloudflare",
    async get(key, type = "json") {
      const res = await cf(await valuePath(name, key));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Cloudflare KV read of ${name}/${key} failed: HTTP ${res.status}`);
      return type === "bytes" ? Buffer.from(await res.arrayBuffer()) : JSON.parse(await res.text());
    },
    async set(key, value) {
      const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array;
      const res = await cf(await valuePath(name, key), {
        method: "PUT",
        headers: { "content-type": bytes ? "application/octet-stream" : "application/json" },
        body: bytes ? value : JSON.stringify(value),
      });
      if (!res.ok) throw new Error(`Cloudflare KV write of ${name}/${key} failed: HTTP ${res.status}`);
    },
  };
}

async function netlifyStore(name) {
  const { getStore } = await import("@netlify/blobs");
  const blobs = getStore({ name, siteID: process.env.NETLIFY_SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN });
  return {
    where: "Netlify",
    async get(key, type = "json") {
      const v = await blobs.get(key, { type: type === "bytes" ? "arrayBuffer" : "json" });
      return v && type === "bytes" ? Buffer.from(v) : v;
    },
    set: (key, value) => (Buffer.isBuffer(value) || value instanceof Uint8Array ? blobs.set(key, value) : blobs.setJSON(key, value)),
  };
}

export async function openStore(name) {
  if (cloudflareConfigured()) {
    const primary = cloudflareStore(name);
    const old = netlifyConfigured() ? await netlifyStore(name) : null;
    return {
      where: "Cloudflare",
      // Netlify's copy only while Cloudflare has nothing under the key (the first runs after the move)
      async get(key, type) {
        const v = await primary.get(key, type);
        return v ?? (old ? old.get(key, type).catch(() => null) : null);
      },
      set: (key, value) => primary.set(key, value),
    };
  }
  if (netlifyConfigured()) return netlifyStore(name);
  throw new Error("no store configured: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (or the old NETLIFY_* secrets)");
}

export { cloudflareStore, netlifyStore };
