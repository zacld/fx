// A workflow's outcome for the Accounts page's freshness strip, in the site's private store (fx-accounts/status):
//   node scripts/status.mjs <finder|filings|market|audit> <ok|partial|failed> [note] [extra.json]
// The last step of each data workflow (if: always()), so a failed or stalled run shows on the page instead of passing
// unnoticed. extra.json's fields are added (the finder's search allowance). Skipped without store secrets.
import { readFile } from "node:fs/promises";
import { STATUS_KEY, STORE, recordStatus } from "../api/accounts.mjs";
import { cloudflareConfigured, netlifyConfigured, openStore } from "./store.mjs";

const [job, state, note = "", extraPath = ""] = process.argv.slice(2);
if (!job || !["ok", "partial", "failed"].includes(state)) {
  console.error("usage: node scripts/status.mjs <job> <ok|partial|failed> [note] [extra.json]");
  process.exit(2);
}
if (!cloudflareConfigured() && !netlifyConfigured()) {
  console.log("No store secrets: status not recorded");
  process.exit(0);
}
let extra = {};
if (extraPath) {
  try { extra = JSON.parse(await readFile(extraPath, "utf8")); } catch { /* no extra this run */ }
}
const run = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "";
const store = await openStore(STORE);
const status = recordStatus(await store.get(STATUS_KEY), job, { at: new Date().toISOString(), state, note, run, ...extra });
await store.set(STATUS_KEY, status);
console.log(`status: ${job} ${state}${note ? ` (${note})` : ""} (${store.where})`);
