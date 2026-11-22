// Copies the Accounts data from the site's store into the database (api/db.mjs, stage 1: a mirror), writing only
// what changed: every company on the Accounts and FX filings lists with its lead score (format.js leadScore — the
// page's own), group and niche; every alert, deal and customs moment; Zac's marks (contacted, notes, verdicts, CRM
// checks, email drafts). Run after each workflow that writes them (finder upload, Niche hits, Alerts):
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/db-sync.mjs
// Counts only in the log (public repo). Without D1 permission on the token it says so and stops, changing nothing.
import { ALERTS_KEY, CHECKS_KEY, CONTACTED_KEY, DEALS_KEY, DETAIL_SHARDS, DETAILS_PREFIX, EMAILS_KEY, FILINGS_KEY, KEY,
  MOMENTS_KEY, NICHES_KEY, NOTES_KEY, RANKED_KEY, STORE, VERDICTS_KEY, LISTS_KEY, dealSignals, filingsMonthKey, signalsByCompany } from "../api/accounts.mjs";
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
  const ctx = { niches: nicheTiers(niches.niches || {}), signals: signalsByCompany(signalItems), moves, today,
                reviews: ranked.reviews || null, likes: ranked.likes || null };
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

// The free plan's daily limit is 100,000 rows written (reset at midnight UTC); the syncs keep to DAILY_WRITES of it,
// leaving the rest for the page's own saves. The day's writes so far are kept in meta ("writes": {day, rows}, from D1's
// own counts); a sync past the budget writes the best companies first and leaves the rest for the next.
export const DAILY_WRITES = 40_000;   // 15 Nov 2026: 60,000 by our count still met the limit — dropping the old tables cost writes D1 counts but doesn't report back

// Which fields differ for records about to be rewritten (a sample, compared with what the database holds): the log
// says why a sync writes as much as it does — field names and counts only (public repo).
export function changedFields(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (k === "hash" || k === "updated_at") continue;
    const a = before?.[k] ?? null, b = after?.[k] ?? null;
    if (String(a) === String(b)) continue;
    if (typeof a === "string" && typeof b === "string" && /^[[{]/.test(a) && /^[[{]/.test(b)) {
      let x, y;
      try { x = JSON.parse(a); y = JSON.parse(b); } catch { out.push(k); continue; }
      if (x && y && typeof x === "object" && !Array.isArray(x)) {
        for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
          if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) out.push(`${k}.${f}`);
        }
        continue;
      }
    }
    out.push(k);
  }
  return out;
}
async function whyRewritten(db, table, records, key, sample = 300) {
  const have = new Map((await db.query(`SELECT ${key}, hash FROM ${table}`)).map((r) => [r[key], r.hash]));
  const changed = records.filter((r) => have.has(r[key]) && have.get(r[key]) !== r.hash).slice(0, sample);
  if (!changed.length) return;
  const old = new Map((await db.query(`SELECT * FROM ${table} WHERE ${key} IN (SELECT value FROM json_each(?1))`,
    [JSON.stringify(changed.map((r) => r[key]))])).map((r) => [r[key], r]));
  const counts = {};
  for (const r of changed) for (const f of changedFields(old.get(r[key]), r)) counts[f] = (counts[f] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([f, n]) => `${f} ${n}`).join(", ");
  console.log(`Database ${table}: of ${changed.length} changed records sampled, the fields that differ — ${top || "none (only the hash)"}`);
}
export const LIMIT_HIT = /limit exceeded|too many requests|daily.*limit|7429|exceeded/i;
// 7429 "exceeded its CPU time limit" is one heavy statement, not the day's writes: said as such, so it isn't mistaken
// for the write limit (16 Nov 2026).
export const limitWhat = (msg = "") => (/CPU time/i.test(msg) ? "a statement ran over D1's CPU time limit" : "Cloudflare's daily write limit reached");

async function main() {
  let db;
  try {
    db = await openD1();
  } catch (e) {
    if (!LIMIT_HIT.test(e.message)) throw e;
    console.log(`Database: Cloudflare's daily limit reached (${e.message.slice(0, 120)}) — skipped; it resets at midnight UTC, the site runs from the store meanwhile`);
    return;
  }
  if (!db) return;
  const store = await openStore(STORE);
  const get = (k) => store.get(k, "json").catch(() => null);
  const [list, index, ranked, niches, alerts, deals, moments, contacted, notes, verdicts, checks, emails, lists] = await Promise.all(
    [KEY, FILINGS_KEY, RANKED_KEY, NICHES_KEY, ALERTS_KEY, DEALS_KEY, MOMENTS_KEY, CONTACTED_KEY, NOTES_KEY, VERDICTS_KEY, CHECKS_KEY, EMAILS_KEY, LISTS_KEY].map(get));
  const details = await Promise.all(Array.from({ length: DETAIL_SHARDS }, (_, i) => get(`${DETAILS_PREFIX}${i}`)));
  let filingRows = [];
  for (const { month } of index?.months || []) filingRows = filingRows.concat((await get(filingsMonthKey(month)))?.rows || []);
  let moves = {};
  try { moves = movesByCurrency(await (await openStore(MARKET_STORE)).get(MARKET_KEY, "json")); } catch { /* no market data */ }
  const records = buildRecords({ list: list || {}, details, filingRows, ranked: ranked || {}, niches: niches || {}, alerts: alerts || {},
    deals: deals || {}, moments: moments || {}, moves,
    marks: { contacted: contacted || {}, notes: notes || {}, verdict: verdicts || {}, check: checks || {}, email: emails || {}, list: lists || {} } });
  records.companies.sort((a, b) => (b.lead_score ?? -1e9) - (a.lead_score ?? -1e9));   // the best first, if the budget runs short
  try {
    await whyRewritten(db, "companies", records.companies, "number");
    await whyRewritten(db, "signals", records.signals, "id");
  } catch (e) { console.log(`Database: couldn't compare the changed records (${e.message.slice(0, 80)})`); }
  const now = new Date().toISOString();
  const day = now.slice(0, 10);
  const [w] = await db.query("SELECT value FROM meta WHERE key = 'writes'");
  const before = w ? JSON.parse(w.value) : {};
  const usedToday = (before.day === day ? Number(before.rows) || 0 : 0) + db.used.written;
  let budget = Math.max(0, DAILY_WRITES - usedToday);
  if (db.remade) console.log("Database: tables remade for the new layout (one row written per record, no indexes) — filling them again");
  console.log(`Database: ${usedToday.toLocaleString()} rows written today so far; this sync may write ${budget.toLocaleString()}`);
  const out = {};
  try {
    for (const table of ["marks", "signals", "companies"]) {   // the small tables first: Zac's marks always fit
      const start = db.used.written;
      out[table] = await syncTable(db.query, table, records[table], { now, budget });
      budget = Math.max(0, budget - (db.used.written - start));
    }
  } catch (e) {
    if (!LIMIT_HIT.test(e.message)) throw e;
    console.log(`Database: ${limitWhat(e.message)} part-way (${e.message.slice(0, 120)}) — the rest goes on the next sync`);
  }
  const total = usedToday + db.used.written;
  try {
    await db.query("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ["writes", JSON.stringify({ day, rows: total + 2 })]);
    await db.query("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ["synced", JSON.stringify({ at: now, list_made_at: list?.made_at || "", counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.total])),
        deferred: Object.values(out).reduce((n, v) => n + v.deferred, 0) })]);
  } catch (e) {
    if (!LIMIT_HIT.test(e.message)) throw e;
  }
  for (const [table, r] of Object.entries(out)) {
    console.log(`Database ${table}: ${r.total.toLocaleString()} (${r.written.toLocaleString()} written, ${r.deleted.toLocaleString()} deleted, ` +
                `${r.unchanged.toLocaleString()} unchanged${r.deferred ? `, ${r.deferred.toLocaleString()} left for the next sync (daily budget)` : ""})`);
  }
  console.log(`Database: ${db.used.written.toLocaleString()} rows written and ${db.used.read.toLocaleString()} read by this sync; ` +
              `${total.toLocaleString()} of the ${DAILY_WRITES.toLocaleString()} budget (Cloudflare's limit 100,000) used today`);
  if (Object.values(out).some((r) => r.deferred) || Object.keys(out).length < 3) return;   // not a full copy: nothing to check yet
  const bySource = await db.query("SELECT source, COUNT(*) AS n FROM companies GROUP BY source");
  const expect = { list: (list?.rows || []).length, filings: records.companies.filter((c) => c.source === "filings").length };
  const got = Object.fromEntries(bySource.map((r) => [r.source, Number(r.n)]));
  const match = (got.list || 0) === expect.list && (got.filings || 0) === expect.filings;
  console.log(`Check: Accounts list ${got.list ?? 0} in the database v ${expect.list} in the store; FX filings ${got.filings ?? 0} v ${expect.filings} — ${match ? "match" : "MISMATCH"}`);
  if (!match) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
