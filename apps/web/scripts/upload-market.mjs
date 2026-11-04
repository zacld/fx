// Uploads market.json (market-moves/moves.py) to the site's private store, where /api/market (api/market.mjs)
// serves it. Run by the "FX market moves" workflow (store settings: scripts/store.mjs):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/upload-market.mjs market.json
import { readFile } from "node:fs/promises";
import { KEY, STORE } from "../api/market.mjs";
import { openStore } from "./store.mjs";

const [path] = process.argv.slice(2);
if (!path) {
  console.error("usage: node scripts/upload-market.mjs market.json");
  process.exit(2);
}
const data = JSON.parse(await readFile(path, "utf8"));
const store = await openStore(STORE);
await store.set(KEY, data);
console.log(`uploaded market moves to ${data.as_of} (${data.currencies?.length ?? 0} currencies) to ${store.where}`);
