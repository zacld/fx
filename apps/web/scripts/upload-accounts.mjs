// Uploads the finder's accounts.json to the site's private store, where /api/accounts (api/accounts.mjs) reads it
// after the password check. Run by the finder workflow (store settings: scripts/store.mjs):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/upload-accounts.mjs accounts.json [--carry]
// --carry (a run the time budget stopped part-way): companies on the list being replaced that this run didn't reach
// stay, as they were — the next nights carry on from the cache, so the list never shrinks because a night ran out.
// The long text (quoted evidence etc., api/accounts.mjs DETAIL_FIELDS) goes to separate detail items the company page
// loads, so the list itself fits more companies; a list still over the item limit drops its lowest-ranked companies.
import { readFile } from "node:fs/promises";
import { DETAIL_SHARDS, DETAILS_PREFIX, KEY, STORE, detailShard, markFirstSeen, splitDetails } from "../api/accounts.mjs";
import { FORWARDS_DUE } from "../src/accounts/format.js";
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
// The lead score's one need from the long text: forward contracts the accounts say mature within a year
for (const r of data.rows) if (r.fx_forwards && FORWARDS_DUE.test(`${r.fx_forwards_evidence || ""} ${r.fx_forwards}`)) r.fx_forwards_due = "yes";
// The long text goes to the detail shards (the company page loads its own); the list keeps the rest
const before = Buffer.byteLength(JSON.stringify(data));
const fieldBytes = {};
for (const r of data.rows) for (const [k, v] of Object.entries(r)) fieldBytes[k] = (fieldBytes[k] || 0) + Buffer.byteLength(JSON.stringify(v)) + k.length + 4;
const { rows, shards } = splitDetails(data.rows);
data.rows = rows;
if (carry) {   // carried-over companies keep the details they had (their rows came from the previous list, already slim)
  const kept = new Set(rows.map((r) => r.company_number));
  for (let i = 0; i < DETAIL_SHARDS; i++) {
    const old = (await store.get(`${DETAILS_PREFIX}${i}`)) || {};
    for (const [n, d] of Object.entries(old)) if (kept.has(n) && !shards[i][n] && detailShard(n) === i) shards[i][n] = d;
  }
}
let bytes = Buffer.byteLength(JSON.stringify(data));
// Still too big for one store item: the lowest-ranked companies (and carried-over ones, last in the list) give way,
// rather than the night's list not being uploaded at all
let trimmed = 0;
while (bytes > MAX_BYTES && data.rows.length) {
  const cut = Math.max(1, Math.ceil(data.rows.length * 0.03));
  data.rows = data.rows.slice(0, -cut);
  trimmed += cut;
  bytes = Buffer.byteLength(JSON.stringify(data));
}
if (trimmed) {
  data.count = data.rows.length;
  console.log(`list over ${(MAX_BYTES / 1048576).toFixed(0)} MB: the ${trimmed} lowest-ranked companies left out to fit`);
}
const detailBytes = shards.reduce((n, s) => n + Buffer.byteLength(JSON.stringify(s)), 0);
console.log(`list size ${(bytes / 1048576).toFixed(1)} MB (${data.rows.length} companies${carry ? `, ${carried} carried over from the last list` : ""}); ` +
            `was ${(before / 1048576).toFixed(1)} MB before the long text moved to the details (${(detailBytes / 1048576).toFixed(1)} MB in ${DETAIL_SHARDS} items)`);
console.log("Biggest fields (MB, all companies): " + Object.entries(fieldBytes).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .map(([k, n]) => `${k} ${(n / 1048576).toFixed(2)}`).join(", "));
for (let i = 0; i < DETAIL_SHARDS; i++) await store.set(`${DETAILS_PREFIX}${i}`, shards[i]);
await store.set(KEY, data);
const added = data.rows.filter((r) => r.first_seen === data.made_at).length;
console.log(`uploaded ${data.count ?? data.rows.length} accounts, ${added} new (made ${data.made_at}) to ${store.where}`);   // counts only: logs are readable
