// Uploads market.json (market-moves/moves.py) to the site's private Blobs
// store, where /api/market (netlify/functions/market.mjs) serves it. Run by
// the "FX market moves" workflow:
//   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node scripts/upload-market.mjs market.json
import { readFile } from "node:fs/promises";
import { getStore } from "@netlify/blobs";
import { KEY, STORE } from "../netlify/functions/market.mjs";

const [path] = process.argv.slice(2);
const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!path || !siteID || !token) {
  console.error("usage: NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node scripts/upload-market.mjs market.json");
  process.exit(2);
}
const data = JSON.parse(await readFile(path, "utf8"));
await getStore({ name: STORE, siteID, token }).setJSON(KEY, data);
console.log(`uploaded market moves to ${data.as_of} (${data.currencies?.length ?? 0} currencies)`);
