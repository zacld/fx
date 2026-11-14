// Copies the Accounts data from the site's store into the database (api/db.mjs, stage 1: a mirror), writing only
// what changed: every company on the Accounts and FX filings lists with its lead score (format.js leadScore — the
// page's own), group and niche; every alert, deal and customs moment; Zac's marks (contacted, notes, verdicts, CRM
// checks, email drafts). Run after each workflow that writes them (finder upload, Niche hits, Alerts):
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/db-sync.mjs
// Counts only in the log (public repo). Without D1 permission on the token it says so and stops, changing nothing.
import { ALERTS_KEY, CHECKS_KEY, CONTACTED_KEY, DEALS_KEY, DETAIL_SHARDS, DETAILS_PREFIX, EMAILS_KEY, FILINGS_KEY, KEY,
  MOMENTS_KEY, NICHES_KEY, NOTES_KEY, RANKED_KEY, STORE, VERDICTS_KEY, dealSignals, filingsMonthKey, signalsByCompany } from "../api/accounts.mjs";
import { KEY as MARKET_KEY, STORE as MARKET_STORE } from "../api/market.mjs";
import { companyRecord, markRecord, signalRecord, syncTable } from "../api/db.mjs";
import { filingRow, groupKey, leadScore, movesByCurrency, nicheTiers, reasonsNotToProgress, setKnownGroups, timelyReason } from "../src/accounts/format.js";
import { RANKED_FIELDS } from "../src/accounts/ranking.js";
import { openD1 } from "./d1.mjs";
import { openStore } from "./store.mjs";

// The records the database should hold, from the store's items (pure: tested on Node's SQLite).
export function buildRecords({ list, details = [], filingRows = [], ranked = {}, niches = {}, alerts = {}, deals = {}, moments = {},
  moves = {}, marks = {}, today = new Date() }) {
  setKnownGroups(ranked.group_of || {});
  const signalItems = [...(alerts.items || []), ...dealSignals(deals.items || []), ...(moments.items || [])];
  const ctx = { niches: nicheTiers(niches.niches || {}), signals: signalsByCompany(signalItems), moves, today };
  const detailOf = Object.assign({}, ...details.map((d) => d || {}));
  const shyOf = ranked.shy_of || {};
  // The outreach inputs the database ranks on (stage 2): the lead score with its parts, a serious reason not to
  // progress (held), the timely reason (cold call v email), the hit-list flag, the hard-to-broker sector.
  const scoreOf = (row) => {
    const s = leadScore(row, ctx);
    const scored = { ...row, lead_flags: s.flags };
    const held = reasonsNotToProgress(row, { today, signals: ctx.signals }).find((x) => x.serious)?.text || "";
    return { score: s.score, held, timely: timelyReason(scored), hit: s.flags.hit, shy: shyOf[row.company_number]?.niche || "",
             lead: { score: s.score, parts: s.parts, flags: s.flags } };
  };
  const ruledOut = ranked.ruled_out || {};
  const nicheOf = ranked.niche_of || {};
  const companies = [];
  const onList = new Set();
  for (const r of list?.rows || []) {
    if (!r.company_number) continue;
    onList.add(r.company_number);
    const row = { ...r, fx_niche: nicheOf[r.company_number] ?? r.fx_niche };
    if (ruledOut[r.company_number]) Object.assign(row, { qualified: "Out", qualify_reason: ruledOut[r.company_number] });
    companies.push(companyRecord(row, { source: "list", details: detailOf[r.company_number], ...scoreOf(row),
      groupKey: groupKey(row), niche: row.fx_niche, ruledOut: ruledOut[r.company_number] || "" }));
  }
  const fullFiling = new Map(filingRows.filter((r) => r.company_number).map((r) => [r.company_number, r]));
  for (const slim of ranked.rows || []) {
    if (!slim.company_number || onList.has(slim.company_number)) continue;
    const full = fullFiling.get(slim.company_number) || {};
    const extra = Object.fromEntries(Object.entries(full).filter(([k, v]) => !RANKED_FIELDS.includes(k) && v !== "" && v !== null && v !== undefined));
    companies.push(companyRecord(slim, { source: "filings", details: extra, ...scoreOf(filingRow(slim)),
      groupKey: groupKey(slim), niche: slim.fx_niche, ruledOut: ruledOut[slim.company_number] || "" }));
  }
  const signals = [
    ...(alerts.items || []).map((a) => signalRecord(a, "alerts")),
    ...(deals.items || []).map((d) => signalRecord({ ...d, ...dealSignals([d])[0], id: `${d.kind}:${d.company_number}:${d.date || ""}` }, "deals")),
    ...(moments.items || []).map((m) => signalRecord(m, "moments")),
  ].filter((s) => s.number && s.number !== "undefined");
  const markRows = [];
  for (const [kind, map] of Object.entries(marks)) for (const [number, value] of Object.entries(map || {})) {
    if (number && value !== null && value !== undefined) markRows.push(markRecord(number, kind, value));
  }
  return { companies, signals, marks: markRows };
}

async function main() {
  const db = await openD1();
  if (!db) return;
  const store = await openStore(STORE);
  const get = (k) => store.get(k, "json").catch(() => null);
  const [list, index, ranked, niches, alerts, deals, moments, contacted, notes, verdicts, checks, emails] = await Promise.all(
    [KEY, FILINGS_KEY, RANKED_KEY, NICHES_KEY, ALERTS_KEY, DEALS_KEY, MOMENTS_KEY, CONTACTED_KEY, NOTES_KEY, VERDICTS_KEY, CHECKS_KEY, EMAILS_KEY].map(get));
  const details = await Promise.all(Array.from({ length: DETAIL_SHARDS }, (_, i) => get(`${DETAILS_PREFIX}${i}`)));
  let filingRows = [];
  for (const { month } of index?.months || []) filingRows = filingRows.concat((await get(filingsMonthKey(month)))?.rows || []);
  let moves = {};
  try { moves = movesByCurrency(await (await openStore(MARKET_STORE)).get(MARKET_KEY, "json")); } catch { /* no market data */ }
  const records = buildRecords({ list: list || {}, details, filingRows, ranked: ranked || {}, niches: niches || {}, alerts: alerts || {},
    deals: deals || {}, moments: moments || {}, moves,
    marks: { contacted: contacted || {}, notes: notes || {}, verdict: verdicts || {}, check: checks || {}, email: emails || {} } });
  const now = new Date().toISOString();
  const out = {};
  for (const table of ["companies", "signals", "marks"]) out[table] = await syncTable(db.query, table, records[table], { now });
  await db.query("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ["synced", JSON.stringify({ at: now, list_made_at: list?.made_at || "", counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.total])) })]);
  const bySource = await db.query("SELECT source, COUNT(*) AS n FROM companies GROUP BY source");
  for (const [table, r] of Object.entries(out)) {
    console.log(`Database ${table}: ${r.total.toLocaleString()} (${r.written.toLocaleString()} written, ${r.deleted.toLocaleString()} deleted, ${r.unchanged.toLocaleString()} unchanged)`);
  }
  const expect = { list: (list?.rows || []).length, filings: records.companies.filter((c) => c.source === "filings").length };
  const got = Object.fromEntries(bySource.map((r) => [r.source, Number(r.n)]));
  const match = got.list === expect.list && (got.filings || 0) === expect.filings;
  console.log(`Check: Accounts list ${got.list ?? 0} in the database v ${expect.list} in the store; FX filings ${got.filings ?? 0} v ${expect.filings} — ${match ? "match" : "MISMATCH"}`);
  if (!match) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
