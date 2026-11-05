// The "Recent FX filings" list in the site's private store (key "filings" beside the account list), for the
// fx-filings workflow (lead-sourcer/tools/fx_filings.py merges the new hits into what's there):
//   node scripts/filings-store.mjs get filings.json   — the list so far ({} when none yet)
//   node scripts/filings-store.mjs put filings.json   — save the merged list
// Store settings: scripts/store.mjs. Counts only in the log (the repo is public).
import { readFile, writeFile } from "node:fs/promises";
import { FILINGS_KEY, STORE } from "../api/accounts.mjs";
import { openStore } from "./store.mjs";

const [command, path] = process.argv.slice(2);
if (!["get", "put"].includes(command) || !path) {
  console.error("usage: node scripts/filings-store.mjs get|put filings.json");
  process.exit(2);
}
const store = await openStore(STORE);
if (command === "get") {
  const data = (await store.get(FILINGS_KEY)) || {};
  await writeFile(path, JSON.stringify(data));
  console.log(`${(data.rows || []).length} companies listed, ${(data.files_done || []).length} files done (${store.where})`);
} else {
  const data = JSON.parse(await readFile(path, "utf8"));
  await store.set(FILINGS_KEY, data);
  console.log(`saved ${(data.rows || []).length} companies, ${(data.files_done || []).length} files done to ${store.where}`);
}
