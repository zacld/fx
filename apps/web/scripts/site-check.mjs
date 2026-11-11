// Is the live site exactly what we built? (malware / tampering check, read-only)
//   node scripts/site-check.mjs https://fx-dashboard-a2y.pages.dev dist
// Fetches the live pages and every same-site file they load, hashes each and compares it with the fresh build in
// `dist`; lists every outside host a live page loads a script, style, frame or image from; confirms the private data
// and API stay locked without the password; reports the security headers. Exits 1 on a mismatch or anything unlocked.
// Prints only public facts (paths, hashes, hosts, status codes) — never data.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [base = "https://fx-dashboard-a2y.pages.dev", dist = "dist"] = process.argv.slice(2);
const origin = new URL(base).origin;
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
const problems = [];
const get = async (path, init) => {
  const res = await fetch(new URL(path, base), { redirect: "manual", ...init });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
};

// Pages and the files they load
const PAGES = { "/": "index.html", "/accounts": "accounts.html", "/accounts.html": "accounts.html", "/moves": "moves.html", "/moves.html": "moves.html" };
const assets = new Set(["/manifest.json"]);
const outside = new Map();
for (const [path, file] of Object.entries(PAGES)) {
  let { res, body } = await get(path);
  if ([301, 302, 307, 308].includes(res.status)) ({ res, body } = await get(res.headers.get("location")));
  const html = body.toString("utf8");
  const local = existsSync(join(dist, file)) ? readFileSync(join(dist, file)) : null;
  const same = local && sha(local) === sha(body);
  console.log(`${path.padEnd(15)} ${res.status}  live ${sha(body)}  build ${local ? sha(local) : "(none)"}  ${same ? "MATCH" : "DIFFERENT"}`);
  if (!same) {
    const mine = new Set((local?.toString("utf8") || "").split("\n").map((l) => l.trim()));
    const extra = html.split("\n").map((l) => l.trim()).filter((l) => l && !mine.has(l));
    if (extra.length) { problems.push(`${path}: lines on the live page that the build doesn't have`); extra.slice(0, 15).forEach((l) => console.log(`    + ${l.slice(0, 200)}`)); }
  }
  for (const m of html.matchAll(/<(script|link|iframe|img|source|embed|object)\b[^>]*?(?:src|href|data)=["']([^"']+)["']/gi)) {
    const url = new URL(m[2], base);
    if (url.origin === origin) assets.add(url.pathname);
    else outside.set(`${m[1]} ${url.origin}`, (outside.get(`${m[1]} ${url.origin}`) || 0) + 1);
  }
  if (/<iframe|document\.write|eval\(|\bwebminer|coinhive/i.test(html)) problems.push(`${path}: an iframe / eval / miner pattern in the live HTML`);
}

console.log("\nFiles the live pages load:");
for (const path of [...assets].sort()) {
  const { res, body } = await get(path);
  const localPath = join(dist, path.replace(/^\//, ""));
  const local = existsSync(localPath) ? readFileSync(localPath) : null;
  const same = local && sha(local) === sha(body);
  console.log(`  ${path.padEnd(40)} ${res.status}  ${same ? "MATCH" : local ? "DIFFERENT" : "NOT IN THE BUILD"}`);
  if (!same) problems.push(`${path}: ${local ? "differs from the build" : "not in the build"}`);
  if (/\.js$/.test(path)) {
    const js = body.toString("utf8");
    // An API key in a public script (Companies House keys are UUIDs): counted, never printed.
    const keys = new Set(js.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) || []);
    if (keys.size) {
      console.log(`      key-shaped strings readable in it: ${keys.size} (not printed)`);
      problems.push(`${path}: ${keys.size} API-key-shaped string(s) readable by anyone who opens the script`);
    }
    const hosts = new Set([...js.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()));
    console.log(`      hosts named in it: ${[...hosts].sort().join(", ") || "none"}`);
  }
}

console.log("\nOutside hosts the live pages load from:");
if (!outside.size) console.log("  none");
for (const [k, n] of outside) console.log(`  ${k} (${n})`);
const ALLOWED = /^(link|script) https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|static\.cloudflareinsights\.com)$/;
for (const k of outside.keys()) if (!ALLOWED.test(k)) problems.push(`loads from an unexpected outside host: ${k}`);

console.log("\nPrivate data locked without the password:");
const home = (await get("/")).body;
const LOCKED = ["/api/accounts", "/api/accounts?view=ranked", "/api/accounts?view=filings", "/api/accounts?view=alerts", "/api/leads"];
for (const path of LOCKED) {
  const { res } = await get(path, { headers: { authorization: "Bearer not-the-password" } });
  const ok = [401, 403].includes(res.status);
  console.log(`  ${path.padEnd(30)} ${res.status}  ${ok ? "locked" : "OPEN?"}`);
  if (!ok) problems.push(`${path} answered ${res.status} with a wrong password`);
}
// Files that must not be public: a 404, or Cloudflare's fallback to the app page (the file itself isn't there).
for (const path of ["/data/leads.json", "/data/accounts.json", "/data/fx_companies.csv", "/accounts.json", "/leads.json"]) {
  const { res, body } = await get(path);
  const fallback = res.status === 200 && (sha(body) === sha(home) || /^\s*<!doctype html/i.test(body.toString("utf8", 0, 100)));
  const ok = res.status === 404 || fallback;
  console.log(`  ${path.padEnd(30)} ${res.status}  ${res.status === 404 ? "not there" : fallback ? "not there (the app page is shown instead)" : "SERVED?"}`);
  if (!ok) problems.push(`${path} is served publicly (${res.status})`);
}
// Public by design: the /moves page's exchange rates (no password) — must carry no company data.
{
  const { res, body } = await get("/api/market");
  const leaks = /company_number|company_name|finance_contact/.test(body.toString("utf8"));
  console.log(`  /api/market (public: rates only)  ${res.status}  ${leaks ? "HAS COMPANY DATA?" : "rates only"}`);
  if (leaks) problems.push("/api/market (public) contains company data");
}

console.log("\nSecurity headers on /accounts:");
const { res } = await get("/accounts");
for (const h of ["strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy"]) {
  console.log(`  ${h.padEnd(28)} ${res.headers.get(h) || "(not set)"}`);
}

console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n- ${problems.join("\n- ")}` : "\nAll clear: the live site is the build, nothing loads from unexpected hosts, private data is locked.");
process.exit(problems.length ? 1 : 0);
