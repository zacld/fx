// GET /api/feed — the Power Automate feed (Zac, 21 Nov 2026: "take all of the accounts in our site and we'll check them
// all"): every lead on the site, one flat row each, best lead score first — the Accounts list and the FX filings
// companies not on it (feed/all, written by the daily ranking, scripts/rank-leads.mjs), then the Emerging leads tab's
// companies not already in it (emerging/companies) — each with its status from the page's own marks (contacted, Open lead
// / Added to mine / Owned abroad, Good lead / Not a fit). Read-only: its own key (the page's "Power Automate feed"
// button shows it; a new key retires the old), never the Accounts password. Nothing is ever written through it.
//   GET /api/feed?key=…[&status=To check][&offset=0&limit=5000][&include_out=1][&format=csv]   (or header x-feed-key: …)
// status keeps only that status (any case; "to-check" works too) — so a flow can loop over body('HTTP')?['rows'] directly.
import { CHECKS_KEY, CONTACTED_KEY, EMERGING_KEY, FEED_KEY, FEED_SALT_KEY, VERDICTS_KEY, feedKey, samePassword } from "./accounts.mjs";
import { industryOf } from "../src/accounts/format.js";

export const FEED_COLUMNS = ["company_number", "company_name", "source", "status", "lead_score", "score", "fit", "now", "niche", "industry",
  "sic", "turnover_gbp", "postcode", "website", "companies_house_url", "ruled_out"];
const MAX_LIMIT = 20000;
const WRONG_KEY_DELAY_MS = 1000;

const json = (body, status) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
const csvCell = (v) => { const t = String(v ?? ""); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

export function statusOf(number, { contacted = {}, checks = {}, verdicts = {} } = {}) {
  if (contacted[number]) return "Contacted";
  const review = checks[number]?.review;
  if (review === "open") return "Open lead";
  if (review === "mine") return "Added to mine";
  if (review === "abroad") return "Owned abroad";
  if (review === "skip") return "Skipped";
  if (review === "research") return "Research harder";
  const verdict = verdicts[number]?.verdict;
  if (verdict === "good") return "Good lead";
  if (verdict === "not_fit") return "Not a fit";
  return "To check";
}

export async function handle(req, { password = "", store, delay = WRONG_KEY_DELAY_MS } = {}) {
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (!password) return json({ error: "ACCOUNTS_PASSWORD is not set on the site yet" }, 503);
  const url = new URL(req.url);
  const given = url.searchParams.get("key") || req.headers.get("x-feed-key") || "";
  const blobs = store();
  const salt = (await blobs.get(FEED_SALT_KEY, { type: "json" }))?.salt || "v1";
  if (!given || !(await samePassword(given, await feedKey(password, salt)))) {
    await new Promise((r) => setTimeout(r, delay));
    return json({ error: "wrong or retired feed key — the Accounts page's Power Automate feed button shows the current one" }, 401);
  }
  const [feed, emerging, contacted, checks, verdicts] = await Promise.all(
    [FEED_KEY, EMERGING_KEY, CONTACTED_KEY, CHECKS_KEY, VERDICTS_KEY].map((k) => blobs.get(k, { type: "json" })));
  const marks = { contacted: contacted || {}, checks: checks || {}, verdicts: verdicts || {} };
  const seen = new Set();
  let rows = [];
  for (const r of feed?.rows || []) { if (!seen.has(r.company_number)) { seen.add(r.company_number); rows.push(r); } }
  for (const e of emerging?.rows || []) {
    if (seen.has(e.company_number)) continue;
    seen.add(e.company_number);
    rows.push({ company_number: e.company_number, company_name: e.company_name, source: "Emerging niche", lead_score: "", score: "", fit: "", now: "",
                niche: (e.niches || []).join("; ").replace(/Emerging: /g, ""), industry: industryOf({ sic_codes: e.sic_codes }),
                sic: (e.sic_codes || []).join(" "), turnover_gbp: "", postcode: e.postcode || "", website: "", ruled_out: "" });
  }
  if (url.searchParams.get("include_out") !== "1") rows = rows.filter((r) => !r.ruled_out);
  rows = rows.map((r) => ({ ...r, status: statusOf(r.company_number, marks),
    companies_house_url: `https://find-and-update.company-information.service.gov.uk/company/${r.company_number}` }));
  const want = (url.searchParams.get("status") || "").toLowerCase().replace(/[-_]+/g, " ").trim();
  if (want) rows = rows.filter((r) => r.status.toLowerCase() === want);
  const total = rows.length;
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || MAX_LIMIT, 1), MAX_LIMIT);
  const page = rows.slice(offset, offset + limit).map((r) => Object.fromEntries(FEED_COLUMNS.map((k) => [k, r[k] ?? ""])));
  if (url.searchParams.get("format") === "csv") {
    const body = [FEED_COLUMNS.join(","), ...page.map((r) => FEED_COLUMNS.map((k) => csvCell(r[k])).join(","))].join("\r\n");
    return new Response(body, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  }
  return json({ made_at: feed?.made_at || "", total, offset, count: page.length, next_offset: offset + page.length < total ? offset + page.length : null,
                columns: FEED_COLUMNS, rows: page }, 200);
}
