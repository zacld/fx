// Uploads the finder's accounts.json to the site's private store, where /api/accounts (api/accounts.mjs) reads it
// after the password check. Run by the finder workflow (store settings: scripts/store.mjs):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/upload-accounts.mjs accounts.json
import { readFile } from "node:fs/promises";
import { KEY, STORE, markFirstSeen } from "../api/accounts.mjs";
import { openStore } from "./store.mjs";

const [path] = process.argv.slice(2);
if (!path) {
  console.error("usage: node scripts/upload-accounts.mjs accounts.json");
  process.exit(2);
}
const store = await openStore(STORE);
// Carries each company's first_seen over from the list being replaced, so the page can label new ones.
const data = markFirstSeen(await store.get(KEY), JSON.parse(await readFile(path, "utf8")));
await store.set(KEY, data);
const added = data.rows.filter((r) => r.first_seen === data.made_at).length;
console.log(`uploaded ${data.count ?? data.rows.length} accounts, ${added} new (made ${data.made_at}) to ${store.where}`);   // counts only: logs are readable
