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
  const query = async (sql, params = []) => {
    const result = await cfJson(`/d1/database/${id}/query`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql, params }),
    });
    return (result || []).flatMap((r) => r.results || []);
  };
  if (schema) await applySchema(query);
  opened = { query, id, where: `D1 ${DB_NAME}` };
  return opened;
}
