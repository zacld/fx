// Uploads the finder's accounts.json to the site's private Blobs store, where
// /api/accounts (netlify/functions/accounts.mjs) reads it after the password
// check. Run by the finder workflow:
//   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node scripts/upload-accounts.mjs accounts.json
import { readFile } from "node:fs/promises";
import { getStore } from "@netlify/blobs";
import { KEY, STORE, markFirstSeen } from "../netlify/functions/accounts.mjs";

const [path] = process.argv.slice(2);
const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!path || !siteID || !token) {
  console.error("usage: NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node scripts/upload-accounts.mjs accounts.json");
  process.exit(2);
}
const store = getStore({ name: STORE, siteID, token });
// Carries each company's first_seen over from the list being replaced, so the page can label new ones.
const data = markFirstSeen(await store.get(KEY, { type: "json" }), JSON.parse(await readFile(path, "utf8")));
await store.setJSON(KEY, data);
const added = data.rows.filter((r) => r.first_seen === data.made_at).length;
console.log(`uploaded ${data.count ?? data.rows.length} accounts, ${added} new (made ${data.made_at})`);   // counts only: logs are readable
