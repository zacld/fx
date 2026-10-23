// GET /api/market — today's market moves for the /moves page (official ECB
// rates and the pound's moves against them; no company or personal data, so
// no password). Written by the "FX market moves" workflow to the site's
// private Blobs store ("fx-market", key "latest").
import { getStore } from "@netlify/blobs";

export const STORE = "fx-market";
export const KEY = "latest";

const reply = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function handle(req, { store = () => getStore(STORE) } = {}) {
  if (req.method !== "GET") return reply({ error: "method not allowed" }, 405);
  const data = await store().get(KEY, { type: "json" });
  if (!data) return reply({ error: "no market data yet — it arrives with the next market moves run" }, 404);
  return reply(data, 200);
}

export default (req) => handle(req);

export const config = { path: "/api/market" };
