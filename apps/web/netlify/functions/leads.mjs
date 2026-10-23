// GET /api/leads — the event engine's leads (director names, phones, emails),
// gzipped, only for a request carrying the Accounts password:
//   Authorization: Bearer <password>
// The file lives in the site's private Blobs store ("fx-leads"), put there by
// the discovery workflow (scripts/leads-store.mjs) — never in the repo or the
// public build. The dashboard un-gzips it in the browser.
import { getStore } from "@netlify/blobs";
import { expectedPassword, samePassword } from "./accounts.mjs";

export const STORE = "fx-leads";
export const KEY = "leads.json.gz";
const WRONG_PASSWORD_DELAY_MS = 1000;   // slows down guessing

const fail = (error, status) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });

export async function handle(req, { password = expectedPassword(), store = () => getStore(STORE), delay = WRONG_PASSWORD_DELAY_MS } = {}) {
  if (req.method !== "GET") return fail("method not allowed", 405);
  if (!password) return fail("ACCOUNTS_PASSWORD is not set on Netlify yet", 503);
  const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!given || !(await samePassword(given, password))) {
    await new Promise((r) => setTimeout(r, delay));
    return fail("wrong password", 401);
  }
  const data = await store().get(KEY, { type: "arrayBuffer" });
  if (!data) return fail("no leads uploaded yet — they arrive with the next discovery run", 404);
  return new Response(data, {
    status: 200,
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

export default (req) => handle(req);

export const config = { path: "/api/leads" };
