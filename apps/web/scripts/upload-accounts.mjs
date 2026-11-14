// Uploads the finder's accounts.json to the site's private store, where /api/accounts (api/accounts.mjs) reads it
// after the password check. Run by the finder workflow (store settings: scripts/store.mjs):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/upload-accounts.mjs accounts.json [--carry]
// --carry (a run the time budget stopped part-way): companies on the list being replaced that this run didn't reach
// stay, as they were — the next nights carry on from the cache, so the list never shrinks because a night ran out.
import { readFile } from "node:fs/promises";
import { KEY, STORE, markFirstSeen } from "../api/accounts.mjs";
import { openStore } from "./store.mjs";

const [path, ...flags] = process.argv.slice(2);
const carry = flags.includes("--carry");
const MAX_BYTES = 24 * 1024 * 1024;   // a store item's limit is 25 MiB
if (!path) {
  console.error("usage: node scripts/upload-accounts.mjs accounts.json");
  process.exit(2);
}
const store = await openStore(STORE);
// Carries each company's first_seen over from the list being replaced, so the page can label new ones.
const previous = await store.get(KEY);
const fresh = JSON.parse(await readFile(path, "utf8"));
let carried = 0;
if (carry && previous?.rows?.length) {
  const have = new Set(fresh.rows.map((r) => r.company_number));
  const kept = previous.rows.filter((r) => r.company_number && !have.has(r.company_number));
  carried = kept.length;
  fresh.rows = [...fresh.rows, ...kept];
  fresh.count = fresh.rows.length;
}
const data = markFirstSeen(previous, fresh);
const bytes = Buffer.byteLength(JSON.stringify(data));
console.log(`list size ${(bytes / 1048576).toFixed(1)} MB (${data.rows.length} companies${carry ? `, ${carried} carried over from the last list` : ""})`);
if (bytes > MAX_BYTES) {
  console.error(`too big for one store item (limit ${(MAX_BYTES / 1048576).toFixed(0)} MB): list not replaced — lower DEFAULT_ENRICH or split the list`);
  process.exit(1);
}
await store.set(KEY, data);
const added = data.rows.filter((r) => r.first_seen === data.made_at).length;
console.log(`uploaded ${data.count ?? data.rows.length} accounts, ${added} new (made ${data.made_at}) to ${store.where}`);   // counts only: logs are readable
