// The event engine's leads file in the site's private Blobs store (read by
// /api/leads behind the Accounts password), instead of in git. Run by the
// discovery workflows from the repo root:
//   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node apps/web/scripts/leads-store.mjs get data/leads.json
//   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node apps/web/scripts/leads-store.mjs put data/leads.json
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { getStore } from "@netlify/blobs";
import { KEY, STORE } from "../netlify/functions/leads.mjs";

const [command, path] = process.argv.slice(2);
const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (!["get", "put"].includes(command) || !path || !siteID || !token) {
  console.error("usage: NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... node leads-store.mjs get|put data/leads.json");
  process.exit(2);
}
const store = getStore({ name: STORE, siteID, token });
const count = (text) => Object.keys(JSON.parse(text)).length;   // counts only: logs are readable

if (command === "put") {
  const text = await readFile(path, "utf8");
  const n = count(text);   // refuses to store a broken file
  await store.set(KEY, gzipSync(Buffer.from(text, "utf8"), { level: 9 }));
  console.log(`stored ${n} leads`);
} else {
  const data = await store.get(KEY, { type: "arrayBuffer" });
  if (!data) {
    console.error("no leads in the store yet");
    process.exit(3);
  }
  const text = gunzipSync(Buffer.from(data)).toString("utf8");
  await writeFile(path, text);
  console.log(`fetched ${count(text)} leads`);
}
