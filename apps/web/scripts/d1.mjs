// The Accounts database (Cloudflare D1, api/db.mjs) from the workflows, through Cloudflare's HTTP API with the same
// CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID as the store. The token needs Account → D1: Edit as well as Pages and
// Workers KV; without it openD1 says so and returns null, and nothing else changes (the site runs from the store).
import { DB_NAME, applySchema } from "../api/db.mjs";
import { cfJson, cloudflareConfigured } from "./store.mjs";

let opened;
export async function databaseId({ create = true } = {}) {
  const found = (await cfJson(`/d1/database?name=${encodeURIComponent(DB_NAME)}`)) || [];
  const db = found.find((d) => d.name === DB_NAME);
  if (db) return db.uuid;
  if (!create) return "";
  return (await cfJson("/d1/database", { method: "POST", headers: { "content-type": "application/json" },
                                         body: JSON.stringify({ name: DB_NAME }) })).uuid;
}

// {query(sql, params) -> rows, id, where} or null with `why` printed (no Cloudflare secrets, or no D1 permission).
export async function openD1({ schema = true } = {}) {
  if (opened) return opened;
  if (!cloudflareConfigured()) {
    console.log("Database: no Cloudflare secrets — skipped");
    return null;
  }
  let id;
  try {
    id = await databaseId();
  } catch (e) {
    console.log(`Database: not reachable — ${e.message}. Add "Account → D1: Edit" to the CLOUDFLARE_API_TOKEN ` +
                "(Cloudflare dashboard → My Profile → API Tokens → edit the token); until then the site runs from the store.");
    return null;
  }
  // D1 reports the rows each statement read and wrote (what the free plan's daily limits count): kept in `used`.
  const used = { read: 0, written: 0 };
  // D1 now and then answers "7500: internal error" (15 Nov 2026, a CREATE TABLE IF NOT EXISTS): tried again up to
  // 3 times, a few seconds apart; the daily limit and other errors aren't retried.
  const post = (sql, params) => cfJson(`/d1/database/${id}/query`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, params }),
  });
  const query = async (sql, params = []) => {
    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await post(sql, params);
        break;
      } catch (e) {
        if (attempt >= 3 || !/internal error|temporarily unavailable|network connection lost/i.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    for (const r of result || []) {
      used.read += Number(r.meta?.rows_read || 0);
      used.written += Number(r.meta?.rows_written || 0);
    }
    return (result || []).flatMap((r) => r.results || []);
  };
  let remade = false;
  if (schema) remade = await applySchema(query);
  opened = { query, id, used, remade, where: `D1 ${DB_NAME}` };
  return opened;
}
