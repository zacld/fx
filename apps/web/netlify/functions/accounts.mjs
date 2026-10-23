// GET /api/accounts — the finder's latest account list (FD names included),
// only for a request carrying the Accounts password:
//   Authorization: Bearer <password>
// The password is the ACCOUNTS_PASSWORD environment variable on Netlify
// (Site configuration → Environment variables). The list itself lives in
// the site's private Blobs store ("fx-accounts", key "latest"), put there by
// the finder workflow — never in the repo or the public build.
import { getStore } from "@netlify/blobs";

export const STORE = "fx-accounts";
export const KEY = "latest";
const WRONG_PASSWORD_DELAY_MS = 1000;   // slows down guessing

const reply = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });

// Compares SHA-256 digests byte by byte, so the time taken doesn't reveal how much of a guess was right.
export async function samePassword(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function expectedPassword() {
  const fromNetlify = typeof Netlify !== "undefined" ? Netlify.env.get("ACCOUNTS_PASSWORD") : undefined;
  return fromNetlify ?? process.env.ACCOUNTS_PASSWORD ?? "";
}

export async function handle(req, { password = expectedPassword(), store = () => getStore(STORE), delay = WRONG_PASSWORD_DELAY_MS } = {}) {
  if (req.method !== "GET") return reply({ error: "method not allowed" }, 405);
  if (!password) return reply({ error: "ACCOUNTS_PASSWORD is not set on Netlify yet" }, 503);
  const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!given || !(await samePassword(given, password))) {
    await new Promise((r) => setTimeout(r, delay));
    return reply({ error: "wrong password" }, 401);
  }
  const data = await store().get(KEY, { type: "json" });
  if (!data) return reply({ error: "no account list uploaded yet — it arrives with the next finder run" }, 404);
  return reply(data, 200);
}

export default (req) => handle(req);

export const config = { path: "/api/accounts" };
