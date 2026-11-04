// The event engine's leads file in the site's private store (read by /api/leads behind the Accounts password),
// instead of in git. Run by the discovery workflows from the repo root (store settings: scripts/store.mjs):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node apps/web/scripts/leads-store.mjs get data/leads.json
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node apps/web/scripts/leads-store.mjs put data/leads.json
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { KEY, STORE } from "../api/leads.mjs";
import { openStore } from "./store.mjs";

const [command, path] = process.argv.slice(2);
if (!["get", "put"].includes(command) || !path) {
  console.error("usage: node leads-store.mjs get|put data/leads.json");
  process.exit(2);
}
const store = await openStore(STORE);
const count = (text) => Object.keys(JSON.parse(text)).length;   // counts only: logs are readable

// A run must never shrink the store by much: a schema change or a bug that drops leads would otherwise delete them
// (and their enrichment) for good. Dedup removes a few each run; more than MAX_SHRINK of them is refused.
const MAX_SHRINK = 0.1;
const tooSmall = (before, after) => before > 0 && after < before * (1 - MAX_SHRINK);

if (command === "put") {
  const text = await readFile(path, "utf8");
  const n = count(text);   // refuses to store a broken file
  const stored = await store.get(KEY, "bytes");
  const before = stored ? count(gunzipSync(stored).toString("utf8")) : 0;
  if (tooSmall(before, n) && process.env.LEADS_ALLOW_SHRINK !== "1") {
    console.error(`refusing to store ${n} leads over ${before} (more than ${MAX_SHRINK * 100}% fewer); ` +
                  "set LEADS_ALLOW_SHRINK=1 for one run if that's intended");
    process.exit(4);
  }
  await store.set(KEY, gzipSync(Buffer.from(text, "utf8"), { level: 9 }));
  console.log(`stored ${n} leads (was ${before}) in ${store.where}`);
} else {
  const data = await store.get(KEY, "bytes");
  if (!data) {
    console.error("no leads in the store yet");
    process.exit(3);
  }
  const text = gunzipSync(data).toString("utf8");
  await writeFile(path, text);
  console.log(`fetched ${count(text)} leads from ${store.where}`);
}
