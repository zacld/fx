// Uploads the finder's accounts.json to the site's private Blobs store, where
// /api/accounts (netlify/functions/accounts.mjs) reads it after the password
// check. Run by the finder workflow:
//   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node scripts/upload-accounts.mjs accounts.json
import { readFile } from "node:fs/promises";
import { getStore } from "@netlify/blobs";
import { KEY, STORE } from "../netlify/functions/accounts.mjs";

const [path] = process.argv.slice(2);
const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!path || !siteID || !token) {
  console.error("usage: NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node scripts/upload-accounts.mjs accounts.json");
  process.exit(2);
}
const data = JSON.parse(await readFile(path, "utf8"));
await getStore({ name: STORE, siteID, token }).setJSON(KEY, data);
console.log(`uploaded ${data.count ?? data.rows?.length ?? 0} accounts (made ${data.made_at})`);   // counts only: logs are readable
