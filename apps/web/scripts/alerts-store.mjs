// The alerts job's files in the site's private store (tools/ch_alerts.py; workflow ch-alerts.yml):
//   node scripts/alerts-store.mjs tracked tracked.json          {company number: name} of the Accounts + FX filings lists
//   node scripts/alerts-store.mjs get alerts|stream|discoveries file.json
//   node scripts/alerts-store.mjs put alerts|stream|discoveries file.json
//   node scripts/alerts-store.mjs get|put niches file.json      each niche's measured numbers (tools/niche_hits.py)
// Counts only in the log (public repo).
import { readFile, writeFile } from "node:fs/promises";
import { ALERTS_KEY, DISCOVERIES_KEY, FILINGS_KEY, KEY, NICHES_KEY, STORE, STREAM_KEY, filingsMonthKey } from "../api/accounts.mjs";
import { openStore } from "./store.mjs";

const KEYS = { alerts: ALERTS_KEY, stream: STREAM_KEY, discoveries: DISCOVERIES_KEY, niches: NICHES_KEY };
const [command, name, file] = process.argv.slice(2);
if (command === "tracked" ? !name : !(["get", "put"].includes(command) && KEYS[name] && file)) {
  console.error("usage: node alerts-store.mjs tracked out.json | get|put alerts|stream|discoveries|niches file.json");
  process.exit(2);
}
const store = await openStore(STORE);
if (command === "tracked") {
  const tracked = {};
  const list = await store.get(KEY, "json");
  for (const r of list?.rows || []) if (r.company_number) tracked[r.company_number] = r.company_name || "";
  const index = await store.get(FILINGS_KEY, "json");
  for (const { month } of index?.months || []) {
    const item = await store.get(filingsMonthKey(month), "json");
    for (const r of item?.rows || []) if (r.company_number && !tracked[r.company_number]) tracked[r.company_number] = r.company_name || "";
  }
  await writeFile(name, JSON.stringify(tracked));
  console.log(`tracked: ${Object.keys(tracked).length} companies (${store.where})`);
} else if (command === "get") {
  const data = await store.get(KEYS[name], "json");
  await writeFile(file, JSON.stringify(data || {}));
  console.log(`${name}: ${data ? "fetched" : "none yet"} (${store.where})`);
} else {
  const data = JSON.parse(await readFile(file, "utf8"));
  await store.set(KEYS[name], data);
  console.log(`${name}: saved${data.count !== undefined ? ` (${data.count})` : ""} (${store.where})`);
}
