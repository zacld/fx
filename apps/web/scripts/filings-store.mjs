// The "Recent FX filings" list in the site's private store, for the fx-filings workflow
// (lead-sourcer/tools/fx_filings.py merges new hits into what's there). A year of filings runs to ~15,000 companies,
// past a store item's 25MB, so the rows are kept one month per item ("filings/2026-09": the month they were filed)
// under an index ("filings": made_at, files_done, months with their counts):
//   node scripts/filings-store.mjs get filings.json   — every month's rows put back together ({} when none yet)
//   node scripts/filings-store.mjs put filings.json   — split by month and saved, then the index
// Store settings: scripts/store.mjs. Counts only in the log (the repo is public).
import { readFile, writeFile } from "node:fs/promises";
import { FILINGS_KEY, STORE, filingsMonth, filingsMonthKey } from "../api/accounts.mjs";
import { openStore } from "./store.mjs";

const [command, path] = process.argv.slice(2);
if (!["get", "put"].includes(command) || !path) {
  console.error("usage: node scripts/filings-store.mjs get|put filings.json");
  process.exit(2);
}
const store = await openStore(STORE);
const index = (await store.get(FILINGS_KEY)) || {};
if (command === "get") {
  let rows = index.rows || [];   // the first version kept every row in the index
  for (const { month } of index.months || []) rows = rows.concat((await store.get(filingsMonthKey(month)))?.rows || []);
  const { months: _months, ...rest } = index;
  await writeFile(path, JSON.stringify({ ...rest, rows }));
  console.log(`${rows.length} companies listed over ${(index.months || []).length} months, ${(index.files_done || []).length} files done (${store.where})`);
} else {
  const data = JSON.parse(await readFile(path, "utf8"));
  const byMonth = new Map();
  for (const row of data.rows || []) {
    const month = filingsMonth(row.filed);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row);
  }
  for (const [month, rows] of byMonth) await store.set(filingsMonthKey(month), { month, rows });
  for (const { month } of index.months || []) {
    if (!byMonth.has(month)) await store.set(filingsMonthKey(month), { month, rows: [] });   // no delete: emptied
  }
  const months = [...byMonth].map(([month, rows]) => ({ month, count: rows.length })).sort((a, b) => b.month.localeCompare(a.month));
  const { rows: _rows, ...rest } = data;
  await store.set(FILINGS_KEY, { ...rest, count: (data.rows || []).length, months });
  console.log(`saved ${(data.rows || []).length} companies over ${months.length} months, ${(data.files_done || []).length} files done to ${store.where}`);
}
