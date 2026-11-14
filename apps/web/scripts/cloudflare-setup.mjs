// Before each Cloudflare deploy (deploy workflow), all of it safe to repeat:
//   - the KV namespace for the site's private data (created the first time);
//   - the Pages project (created the first time; its address is printed and written to $GITHUB_OUTPUT as `url`);
//   - the Accounts password as a secret on the project, from ACCOUNTS_PASSWORD (left as it is when that's unset);
//   - the Accounts database (D1, created the first time; needs Account → D1: Edit on the token — skipped without it);
//   - wrangler.toml next to the build, binding the namespace as FX_STORE (and the database as FX_DB) for the Functions.
// Needs CLOUDFLARE_API_TOKEN (Account: Cloudflare Pages Edit + Workers KV Storage Edit) and CLOUDFLARE_ACCOUNT_ID.
import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BINDING } from "../api/kv.mjs";
import { DB_BINDING, DB_NAME } from "../api/db.mjs";
import { openD1 } from "./d1.mjs";
import { accountIdProblem, cloudflareConfigured, kvNamespaceId } from "./store.mjs";

export const PROJECT = process.env.CLOUDFLARE_PAGES_PROJECT || "fx-dashboard";
const API = `https://api.cloudflare.com/client/v4/accounts/${(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim()}`;
const headers = { authorization: `Bearer ${(process.env.CLOUDFLARE_API_TOKEN || "").trim()}`, "content-type": "application/json" };

async function call(path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && body.success !== false, body };
}

const fail = (what, r) => {
  const why = (r.body.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${r.status}`;
  console.error(`${what} failed — ${why}`);
  process.exit(1);
};

if (!cloudflareConfigured()) {
  console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are needed");
  process.exit(2);
}
if (accountIdProblem()) {
  console.error(accountIdProblem());
  process.exit(2);
}
const namespace = await kvNamespaceId();

let project = await call(`/pages/projects/${PROJECT}`);
if (project.status === 404) {
  project = await call("/pages/projects", { method: "POST", body: JSON.stringify({ name: PROJECT, production_branch: "main" }) });
  if (!project.ok) fail(`creating the Pages project ${PROJECT}`, project);
  console.log(`created the Pages project ${PROJECT}`);
} else if (!project.ok) {
  fail(`reading the Pages project ${PROJECT}`, project);
}
const url = `https://${project.body.result.subdomain}`;

if (process.env.ACCOUNTS_PASSWORD) {
  const r = await call(`/pages/projects/${PROJECT}`, {
    method: "PATCH",
    body: JSON.stringify({ deployment_configs: { production: { env_vars: {
      ACCOUNTS_PASSWORD: { type: "secret_text", value: process.env.ACCOUNTS_PASSWORD } } } } }),
  });
  if (!r.ok) fail("setting the Accounts password on the Pages project", r);
  console.log("Accounts password set on the project");
} else {
  console.log("ACCOUNTS_PASSWORD not set in GitHub: the project's password is left as it is");
}

// The Accounts database (D1, api/db.mjs): created and its tables made the first time; bound as FX_DB when the token
// may use D1 (Account → D1: Edit) — without it the site deploys as before, on the store alone. The tables are made by
// the syncs (scripts/db-sync.mjs), not here: a deploy never writes to the database, so its daily limit never costs the binding.
const d1 = await openD1({ schema: false }).catch((e) => { console.log(`Database not set up: ${e.message}`); return null; });

await writeFile(resolve(import.meta.dirname, "../wrangler.toml"), [
  "# Written by scripts/cloudflare-setup.mjs before each deploy (not committed).",
  `name = "${PROJECT}"`,
  'pages_build_output_dir = "./dist"',
  'compatibility_date = "2025-01-01"',
  "",
  "[[kv_namespaces]]",
  `binding = "${BINDING}"`,
  `id = "${namespace}"`,
  "",
  ...(d1 ? ["[[d1_databases]]", `binding = "${DB_BINDING}"`, `database_name = "${DB_NAME}"`, `database_id = "${d1.id}"`, ""] : []),
].join("\n"));

console.log(`Pages project ${PROJECT} at ${url}; KV store bound as ${BINDING}${d1 ? `; database ${DB_NAME} bound as ${DB_BINDING}` : "; no database yet"}`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `url=${url}\nproject=${PROJECT}\n`);
