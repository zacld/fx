// GET /api/accounts — the finder's latest account list (FD names included),
// or with ?view=filings the Recent FX filings list (companies whose new
// accounts show FX: lead-sourcer/sourcer/filings.py), or with ?view=losses
// that list's companies whose latest accounts show an FX loss,
// with the companies marked contacted and Zac's notes; POST /api/accounts
// {company_number, contacted: true, channel} logs a touch (the first marks it
// contacted), {contacted: false} takes it off the list, {response} /
// {follow_up_at} record a reply or a chosen next date (src/accounts/
// followups.js), and {notes: "..."} saves its notes ("" deletes them). Only
// for a request carrying the Accounts password:
//   Authorization: Bearer <password>
// The password is the ACCOUNTS_PASSWORD secret on the Cloudflare Pages
// project (set by the deploy workflow from the GitHub secret of that name).
// The list itself lives in the site's private KV store ("fx-accounts/latest"),
// put there by the finder workflow — never in the repo or the public build.
// Platform-free: functions/api/accounts.js passes the password and the store.
import { validSequence } from "../src/accounts/sequence.js";
import { applyContact, invalidChange } from "../src/accounts/followups.js";
import { markDiff, marksLive, outreachPage, readMarks, writeMarks } from "./db.mjs";
import { OUTREACH, outreachWhy } from "../src/accounts/format.js";

export const STORE = "fx-accounts";
export const KEY = "latest";
export const CONTACTED_KEY = "contacted";   // {company_number: {at, touches, response, follow_up_at}} — Zac's, never the finder's
export const VERDICTS_KEY = "verdicts";     // {company_number: {verdict: "good" | "not_fit", reason, at}} — Zac's review
export const VERDICT_REASONS = ["Too small", "Too big", "No real FX", "Wrong sector", "FX run abroad", "Other"];
export const LISTS_KEY = "lists";           // {company_number: {list: "call" | "post" | "email", at, missing?}} — Zac's own lists
export const LISTS = ["call", "post", "email"];   // call list, chocolate / mailing list, email list
export const CHECKS_KEY = "checks";         // {company_number: {crm: iso, review, review_at}} — the "CRM checked" tick and
                                             // the Simplified dash's review: open lead / added to mine / owned abroad
// "skip": taken off the lists with no reason kept (Zac, 23 Nov 2026, for companies the bank already has — which ones never
// stays here, so only "skipped" is recorded)
export const REVIEWS = ["open", "mine", "abroad", "skip"];
export const MARKS_MAX = 500;   // marks in one bulk save (POST {marks})
export const NOTES_KEY = "notes";           // {company_number: {text, at}} — Zac's notes, likewise
export const FILINGS_KEY = "filings";       // {made_at, files_done, months: [{month, count}]} — the Recent FX filings tab's index
export const filingsMonthKey = (month) => `filings/${month}`;   // {month, rows}: the companies filed that month
export const STATUS_KEY = "status";   // {jobs: {finder|filings|market|audit: {at, state, run, note, …}}} — each workflow's last outcome
export const EMAILS_KEY = "emails";   // {company_number: {row, text, at}} — the Email generator tab's companies (Zac's)
export const EMAILS_MAX = 100;
export const EMAIL_TEXT_MAX = 8000;
// Zac's marks by kind (the database's marks table, api/db.mjs) and the store item each kind is kept in.
export const MARK_ITEMS = { contacted: CONTACTED_KEY, notes: NOTES_KEY, verdict: VERDICTS_KEY, check: CHECKS_KEY, email: EMAILS_KEY, list: LISTS_KEY };
// {"<kind>:<number>": at} — saves the database couldn't take (written to the store only); db-sync puts them in.
export const MARKS_UNSYNCED_KEY = "marks/unsynced";
// What the Email generator needs of a company (src/accounts/email.js) and shows beside its draft.
export const EMAIL_ROW_FIELDS = ["company_number", "company_name", "rank", "finance_contact", "finance_contact_role",
  "finance_contact_confidence", "no_fd_likely", "turnover_regions", "main_currency", "currency_source", "currency_direction",
  "fx_forwards", "currencies_in_accounts"];

// The Email generator's companies after one change: {row} adds or refreshes a company (newest first, at most
// EMAILS_MAX), {text} saves an edit (null: back to the generated draft), null removes it.
export function applyEmail(emails, number, change, at) {
  const out = { ...(emails || {}) };
  if (change === null) { delete out[number]; return out; }
  const prev = out[number] || {};
  const row = change.row ? Object.fromEntries(EMAIL_ROW_FIELDS.filter((k) => change.row[k] !== undefined).map((k) => [k, change.row[k]])) : prev.row;
  out[number] = { row, text: "text" in change ? change.text : change.row ? null : prev.text ?? null, at: change.row ? at : prev.at || at };
  const keep = Object.entries(out).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, EMAILS_MAX);
  return Object.fromEntries(keep);
}
export const LOSSES_KEY = "filings/losses";   // {made_at, count, rows}: every listed filing with an FX loss (the FX losses tab)

// The fields the FX losses tab shows for a filing (kept small: one store item for the whole year's losses).
const LOSS_FIELDS = ["company_number", "company_name", "filed", "period_end", "turnover_gbp", "turnover_basis", "size_estimate",
  "fx_gain_loss_gbp", "fx_gain_loss_prior_gbp", "fx_gain_loss_evidence", "accounts_url", "fx_forwards", "fx_today",
  "currency", "currency_source", "currencies_in_accounts", "turnover_regions", "owner", "run_from_abroad", "incumbent_bank",
  "incumbent_bank_url", "lenders", "fd_search_url", "directors", "triggers", "hmrc_trade", "filed_fx_score", "moved_up",
  "also_filed", "reporting_currency", "subsidiaries_abroad", "fx_borrowings", "turnover_foreign_gbp", "size_estimate_basis"];

// A workflow's outcome into the status record the Accounts page's freshness strip reads (scripts/status.mjs).
export function recordStatus(status, job, entry) {
  const jobs = { ...((status && status.jobs) || {}) };
  jobs[job] = { ...(jobs[job] || {}), ...entry };
  if (entry.state === "ok") jobs[job].last_ok = entry.at;
  return { ...(status || {}), jobs };
}

// Every filing in the Recent FX filings list whose latest accounts show an FX loss, biggest first.
export function filingsLosses(rows = []) {
  return rows.filter((r) => Number(r.fx_gain_loss_gbp) < 0)
    .map((r) => Object.fromEntries(LOSS_FIELDS.filter((k) => r[k] !== undefined && r[k] !== "").map((k) => [k, r[k]])))
    .sort((a, b) => Number(a.fx_gain_loss_gbp) - Number(b.fx_gain_loss_gbp));
}

export const ALERTS_KEY = "alerts";          // {made_at, count, items}: tools/ch_alerts.py — new FD, charges, owners…
export const DISCOVERIES_KEY = "discoveries";   // {made_at, rows}: companies found by a charge to an FX provider / trade finance
// The ownership register's purchases as signals: {company_number, kind, at, title}.
export const dealSignals = (items = []) => items.map((d) => ({ company_number: d.company_number, kind: d.kind, at: d.date,
  title: d.detail }));

// The dashboard's alert banner (Zac, 14 Nov 2026: "just have the alert on the dash"): the hot alerts of the last 7 days,
// newest first (at most 50), and how many alerts of any kind arrived in the last 24 hours.
export function alertsSummary(items = [], now = new Date()) {
  const since = (days) => new Date(now.getTime() - days * 864e5).toISOString().slice(0, 19);
  const hot = items.filter((a) => a.hot && String(a.at || "") >= since(7))
    .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50)
    .map((a) => ({ at: a.at, title: a.title, company_number: a.company_number, company_name: a.company_name || "", tracked: Boolean(a.tracked) }));
  return { hot, day: items.filter((a) => String(a.at || "") >= since(1)).length };
}

// {company number: [{kind, at, title}]} from the alerts, newest first — what the lead score reads.
export function signalsByCompany(items = []) {
  const out = {};
  for (const a of items) {
    if (!a?.company_number) continue;
    (out[a.company_number] ||= []).push({ kind: a.kind, at: a.at, title: a.title, ...(a.detail ? { detail: String(a.detail).slice(0, 140) } : {}) });
  }
  for (const list of Object.values(out)) list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}
// The list's long text (Zac, 14 Nov 2026: "slim it down so we can fit more"): the quoted evidence sentences and other
// fields only the company page shows live in DETAIL_SHARDS store items ("details/0".."details/15", {number: {field:
// value}}), not in the list the page loads; the company page fetches its own (GET ?view=details&company=…).
export const DETAILS_PREFIX = "details/";
export const DETAIL_SHARDS = 16;
export const DETAIL_FIELDS = ["fx_wallet_basis", "currency_evidence", "fx_evidence", "hmrc_goods", "all_directors",
  "banking_relationships", "untapped_reasons", "verify_finance_contact_url", "fx_exposure", "turnover_source",
  "company_secretary", "accounts_signed_by", "generic_emails", "search_check"];
// short evidence the list's chips show on hover stays on the list (why it's PE-backed)
export const LIST_EVIDENCE = ["pe_backed_evidence"];
export const isDetailField = (k) => (k.endsWith("_evidence") && !LIST_EVIDENCE.includes(k)) || DETAIL_FIELDS.includes(k);
export const detailShard = (number) => {
  let h = 0;
  for (const c of String(number)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % DETAIL_SHARDS;
};
// {rows: the list without detail fields, shards: [{number: {detail fields}}] × DETAIL_SHARDS}
export function splitDetails(rows = []) {
  const shards = Array.from({ length: DETAIL_SHARDS }, () => ({}));
  const slim = rows.map((r) => {
    const keep = {};
    const more = {};
    for (const [k, v] of Object.entries(r)) (isDetailField(k) ? more : keep)[k] = v;
    if (Object.keys(more).length && r.company_number) shards[detailShard(r.company_number)][r.company_number] = more;
    return keep;
  });
  return { rows: slim, shards };
}
export const RANKED_KEY = "leads/ranked";   // {made_at, rows, ruled_out, niches}: every scanned lead ranked (scripts/rank-leads.mjs)
export const PARENTS_KEY = "parents";   // {made_at, companies: {number: {ultimate_parent, country, evidence, accounts_url, read} | {none, read}}}: tools/parents_from_accounts.py
export const OWNERS_KEY = "owners";     // {made_at, companies: {number: {owner, kind, country, quote, url, searched}}, usage}: tools/owner_search.py
export const DOMAINS_KEY = "domains";   // {made_at, sites: {number: {website, confidence, found}}, none}: tools/find_domains.py
export const DEALS_KEY = "deals";   // {made_at, items}: purchases from the ownership register (tools/psc_deals.py)
// {made_at, latest, items: [{company_number, kind, at, title, detail, tracked}]}: customs moments (tools/niche_hits.py) —
// new to importing / exporting, a flow started, trade growing — signals like the alerts
export const MOMENTS_KEY = "moments";
// The Niche search (Zac, 21 Nov 2026: "focus on finding niche companies"): the page asks, the Niche search workflow
// answers (tools/niche_search.py) — two items so neither writer overwrites the other.
export const SEARCHES_KEY = "searches";              // {searches: [{id, text, asked_at}]} — written only by the page
export const SEARCH_RESULTS_KEY = "search_results";  // {made_at, results: {id: {text, codes, rows, counts, done_at}}}
export const SEARCHES_MAX = 30;
export const SEARCH_TEXT_MAX = 200;
export const JOBS_KEY = "jobs";   // {made_at, counts, queries, employers, lookups}: the job-advert finder (tools/ch_alerts.py --signals, sourcer/jobs.py)
export const EMERGING_KEY = "emerging/companies";   // {made_at, niches, rows}: every sized company in an emerging niche (niche_hits)
export const LOOKALIKES_KEY = "lookalikes";
// The Power Automate feed (api/feed.mjs): feed/all is written by the daily ranking; feed/salt makes its key (rotatable)
export const FEED_KEY = "feed/all";
export const FEED_SALT_KEY = "feed/salt";   // {made_at, good, leads, count, items}: like Zac's good leads (niche_hits)
export const NICHES_KEY = "niches/stats";   // {made_at, niches: {id: measured numbers}, headings}: tools/niche_hits.py
export const STREAM_KEY = "ch/stream";      // {officers, charges, psc}: the streams' last timepoints
export const CALLS_KEY = "filings/calls";   // {made_at, count, rows}: the Call today tab's candidates from the filings list
export const CALLS_MAX = 1500;
// The Recent FX filings list's candidates for the Call today tab (format.js callToday picks the day's 25): turnover
// £20m–£300m (filed or the group's), strong filed FX proof (50+), and an FX loss or a trigger; strongest first.
export function filingsCalls(rows = []) {
  return rows.filter((r) => {
    const turnover = Number(r.turnover_gbp) || Number(r.turnover_foreign_gbp) || 0;
    return turnover >= 20_000_000 && turnover <= 300_000_000 && (Number(r.filed_fx_score) || 0) >= 50
      && (Number(r.fx_gain_loss_gbp) < 0 || Boolean(r.triggers));
  })
    .sort((a, b) => (Number(b.rank_score ?? b.filed_fx_score) || 0) - (Number(a.rank_score ?? a.filed_fx_score) || 0))
    .slice(0, CALLS_MAX)
    .map((r) => Object.fromEntries([...LOSS_FIELDS, "rank_score", "currency_source"].filter((k) => r[k] !== undefined && r[k] !== "").map((k) => [k, r[k]])));
}

// "2026-11" for a day file's "2026-11-04"; "2026-09" for a monthly archive's "September 2026".
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function filingsMonth(filed = "") {
  if (/^\d{4}-\d{2}/.test(filed)) return filed.slice(0, 7);
  const m = /^([A-Z][a-z]+) (\d{4})$/.exec(filed);
  return m && MONTHS.includes(m[1]) ? `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}` : "unknown";
}
export const NOTES_MAX = 4000;
const COMPANY_NUMBER = /^[A-Z0-9]{8}$/i;
const WRONG_PASSWORD_DELAY_MS = 1000;   // slows down guessing

const reply = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });

// The Power Automate feed's key: an HMAC of the Accounts password and the store's salt — read-only, rotated by a new salt.
export async function feedKey(password, salt = "v1") {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`fx-feed:${salt}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

// Compares SHA-256 digests byte by byte, so the time taken doesn't reveal how much of a guess was right.
export async function samePassword(given, expected) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// When each company first appeared: kept from the list it replaces, so the page can label the latest scan's
// additions "new". Companies already listed before first_seen existed date from that list.
export function markFirstSeen(previous, next) {
  const before = new Map((previous?.rows || []).map((r) => [r.company_number, r.first_seen || previous.made_at]));
  return { ...next, rows: (next.rows || []).map((r) => ({ ...r, first_seen: before.get(r.company_number) || next.made_at })) };
}

// `store()` gives {get(key, {type: "json"}), setJSON(key, value)} (api/kv.mjs over the KV binding). A save reads the
// marks the previous one wrote: KV shows a write at once to later requests in the same Cloudflare location, and the
// page sends saves one at a time.
// Zac's marks, read and changed. Once the database holds them (marksLive: db-sync copied the store's in), a save reads
// that kind from the database, lets `fn` change it, and writes only the rows that changed — a mark saved meanwhile from
// another device is never overwritten — then copies the change into the store item (the workflows read those; db-sync
// heals any copy that missed). When the database can't be reached the save goes to the store and is noted in
// MARKS_UNSYNCED_KEY for db-sync to carry over. Before that (no database, or not filled yet) the store is the source and
// the database gets a copy, as before. `fn(map)` changes the map it's given and returns it.
export async function openMarks(blobs, db) {
  let live = false;
  if (db) { try { live = await marksLive(db); } catch { live = false; } }
  const fromStore = async (kind) => (await blobs.get(MARK_ITEMS[kind], { type: "json" })) || {};
  const toStore = async (kind, sets, deletes) => {
    const item = await fromStore(kind);
    Object.assign(item, sets);
    for (const n of deletes) delete item[n];
    await blobs.setJSON(MARK_ITEMS[kind], item);
  };
  return {
    live,
    // {contacted, notes, verdict, check, email, list} maps: the database's (with any save it missed), else the store's
    async all() {
      if (live) {
        try {
          const maps = await readMarks(db);
          const missed = Object.keys((await blobs.get(MARKS_UNSYNCED_KEY, { type: "json" })) || {});
          for (const kind of new Set(missed.map((k) => k.split(":")[0]))) {
            if (!MARK_ITEMS[kind]) continue;
            const item = await fromStore(kind);
            for (const n of missed.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1))) {
              if (n in item) (maps[kind] ||= {})[n] = item[n]; else if (maps[kind]) delete maps[kind][n];
            }
          }
          return Object.fromEntries(Object.keys(MARK_ITEMS).map((k) => [k, maps[k] || {}]));
        } catch { /* the store's copies */ }
      }
      return Object.fromEntries(await Promise.all(Object.keys(MARK_ITEMS).map(async (k) => [k, await fromStore(k)])));
    },
    async change(kind, fn) {
      if (live) {
        let written = false;
        try {
          const before = (await readMarks(db, kind))[kind] || {};
          const after = fn(structuredClone(before)) || {};
          const { sets, deletes } = markDiff(before, after);
          if (!Object.keys(sets).length && !deletes.length) return after;
          await writeMarks(db, kind, sets, deletes);
          written = true;
          try { await toStore(kind, sets, deletes); } catch { /* the next sync heals the store's copy */ }
          return after;
        } catch (e) {
          if (written) throw e;
        }
        const before = await fromStore(kind);   // the database couldn't take it: the store, noted for db-sync
        const after = fn(structuredClone(before)) || {};
        const { sets, deletes } = markDiff(before, after);
        await blobs.setJSON(MARK_ITEMS[kind], after);
        const missed = (await blobs.get(MARKS_UNSYNCED_KEY, { type: "json" })) || {};
        const at = new Date().toISOString();
        for (const n of [...Object.keys(sets), ...deletes]) missed[`${kind}:${n}`] = at;
        await blobs.setJSON(MARKS_UNSYNCED_KEY, missed);
        return after;
      }
      const before = await fromStore(kind);
      const after = fn(structuredClone(before)) || {};
      const { sets, deletes } = markDiff(before, after);
      if (!Object.keys(sets).length && !deletes.length) return after;
      await blobs.setJSON(MARK_ITEMS[kind], after);
      if (db) {   // a copy for the database, never failing the save: the next sync puts it right
        try { await writeMarks(db, kind, sets, deletes); } catch { /* the next sync catches up */ }
      }
      return after;
    },
  };
}

export async function handle(req, { password = "", store, db = null, delay = WRONG_PASSWORD_DELAY_MS } = {}) {
  if (req.method !== "GET" && req.method !== "POST") return reply({ error: "method not allowed" }, 405);
  if (!password) return reply({ error: "ACCOUNTS_PASSWORD is not set on the site yet" }, 503);
  const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!given || !(await samePassword(given, password))) {
    await new Promise((r) => setTimeout(r, delay));
    return reply({ error: "wrong password" }, 401);
  }
  const blobs = store();
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const { company_number: number, notes } = body;
    if (Array.isArray(body.marks)) {   // many marks at once (the Scoreboard's paste box): one read and one write of each
      // item, so rapid saves can't overwrite each other (KV serves a key's last value for up to a minute elsewhere)
      const marks = body.marks;
      const bad = marks.length > MARKS_MAX || marks.some((m) => !COMPANY_NUMBER.test(m?.company_number || "")
        || !(("review" in m && REVIEWS.includes(m.review)) || ("verdict" in m && (m.verdict === "good"
          || (m.verdict === "not_fit" && (!m.reason || VERDICT_REASONS.includes(m.reason)))))));
      if (!marks.length || bad) {
        return reply({ error: `send {marks: [{company_number, review: ${REVIEWS.join(" | ")}} | {company_number, verdict: "good" | "not_fit", reason?}]} (at most ${MARKS_MAX})` }, 400);
      }
      const at = new Date().toISOString();
      const io = await openMarks(blobs, db);
      const checks = await io.change("check", (checks) => {
        for (const m of marks.filter((x) => "review" in x)) {
          const n = m.company_number.toUpperCase();
          checks[n] = { ...(checks[n] || {}), review: m.review, review_at: at };
        }
        return checks;
      });
      const verdicts = await io.change("verdict", (verdicts) => {
        for (const m of marks.filter((x) => !("review" in x))) {
          verdicts[m.company_number.toUpperCase()] = { verdict: m.verdict, ...(m.reason ? { reason: m.reason } : {}), at };
        }
        return verdicts;
      });
      return reply({ checks, verdicts, saved: marks.length }, 200);
    }
    if ("feed_key" in body) {   // a new Power Automate feed key: the old one stops working
      const salt = crypto.randomUUID();
      await blobs.setJSON(FEED_SALT_KEY, { salt, at: new Date().toISOString() });
      return reply({ key: await feedKey(password, salt), path: "/api/feed" }, 200);
    }
    if ("niche_search" in body || "niche_search_remove" in body || "niche_search_again" in body) {
      const stored = (await blobs.get(SEARCHES_KEY, { type: "json" })) || {};
      let searches = stored.searches || [];
      const at = new Date().toISOString();
      if ("niche_search" in body) {
        const text = typeof body.niche_search === "string" ? body.niche_search.replace(/\s+/g, " ").trim() : "";
        if (!text || text.length > SEARCH_TEXT_MAX) return reply({ error: `send {niche_search: "words or customs codes"} (at most ${SEARCH_TEXT_MAX} characters)` }, 400);
        const same = searches.find((s) => s.text.toLowerCase() === text.toLowerCase());
        if (same) same.asked_at = at;
        else searches = [{ id: `s${Date.now().toString(36)}`, text, asked_at: at }, ...searches].slice(0, SEARCHES_MAX);
      } else if ("niche_search_again" in body) {
        const s = searches.find((x) => x.id === body.niche_search_again);
        if (!s) return reply({ error: "no such search" }, 400);
        s.asked_at = at;
      } else {
        searches = searches.filter((x) => x.id !== body.niche_search_remove);
      }
      await blobs.setJSON(SEARCHES_KEY, { searches });
      return reply({ searches }, 200);
    }
    if ("email" in body) {
      const e = body.email;
      if (!COMPANY_NUMBER.test(number || "") || (e !== null && (typeof e !== "object" || (!e.row && !("text" in e))))) {
        return reply({ error: "send {company_number, email: {row} | {text} | null}" }, 400);
      }
      if (e && "text" in e && e.text !== null && (typeof e.text !== "string" || e.text.length > EMAIL_TEXT_MAX)) {
        return reply({ error: `an email's text is a string of at most ${EMAIL_TEXT_MAX} characters` }, 400);
      }
      const emails = await (await openMarks(blobs, db)).change("email", (emails) => applyEmail(emails, number, e, new Date().toISOString()));
      return reply({ emails }, 200);
    }
    if ("sequence" in body) {   // the outreach sequence of a company on a list: {start, gift?, done: {step: date}} or null
      if (!validSequence(body.sequence)) return reply({ error: "send {company_number, sequence: {start: YYYY-MM-DD, gift?, done: {step: YYYY-MM-DD}} | null}" }, 400);
      let onList = true;
      const lists = await (await openMarks(blobs, db)).change("list", (lists) => {
        if (!lists[number]) { onList = false; return lists; }
        if (body.sequence) lists[number] = { ...lists[number], seq: body.sequence };
        else { const { seq: _gone, ...rest } = lists[number]; lists[number] = rest; }
        return lists;
      });
      if (!onList) return reply({ error: "put the company on a list first" }, 400);
      return reply({ lists }, 200);
    }
    if ("list" in body) {   // Zac's own call / chocolate-mailing / email list; one list a company, null takes it off
      if (body.list !== null && !LISTS.includes(body.list)) return reply({ error: `send {company_number, list: ${LISTS.join(" | ")} | null}` }, 400);
      const lists = await (await openMarks(blobs, db)).change("list", (lists) => {
        const kept = lists[number]?.list === body.list ? lists[number].at : null;   // marking "can't find info" keeps its place
        const seq = lists[number]?.seq;   // the outreach sequence carries over when the company moves list
        if (body.list) lists[number] = { list: body.list, at: kept || new Date().toISOString(), ...(body.missing ? { missing: true } : {}), ...(seq ? { seq } : {}) };
        else delete lists[number];
        return lists;
      });
      return reply({ lists }, 200);
    }
    if ("verdict" in body) {   // Zac's review of a lead: good / not a fit (with a reason) / cleared — never a bank record
      const ok = body.verdict === null || body.verdict === "good" ||
        (body.verdict === "not_fit" && (!body.reason || VERDICT_REASONS.includes(body.reason)));
      if (!COMPANY_NUMBER.test(number || "") || !ok) {
        return reply({ error: `send {company_number, verdict: "good" | "not_fit" | null, reason?: ${VERDICT_REASONS.join(" | ")}}` }, 400);
      }
      const verdicts = await (await openMarks(blobs, db)).change("verdict", (verdicts) => {
        if (body.verdict) verdicts[number] = { verdict: body.verdict, ...(body.reason ? { reason: body.reason } : {}), at: new Date().toISOString() };
        else delete verdicts[number];
        return verdicts;
      });
      return reply({ verdicts }, 200);
    }
    if ("crm_checked" in body) {   // the lead checklist's own tick: Zac checked the bank's CRM (kept here as a date only)
      if (!COMPANY_NUMBER.test(number || "") || typeof body.crm_checked !== "boolean") {
        return reply({ error: "send {company_number, crm_checked: true | false}" }, 400);
      }
      const checks = await (await openMarks(blobs, db)).change("check", (checks) => {
        if (body.crm_checked) checks[number] = { ...(checks[number] || {}), crm: new Date().toISOString() };
        else if (checks[number]) { delete checks[number].crm; if (!Object.keys(checks[number]).length) delete checks[number]; }
        return checks;
      });
      return reply({ checks }, 200);
    }
    if ("review" in body) {   // the Simplified dash's buttons: Zac's own read of the lead (no reason, nothing from the CRM)
      if (!COMPANY_NUMBER.test(number || "") || !(body.review === null || REVIEWS.includes(body.review))) {
        return reply({ error: `send {company_number, review: ${REVIEWS.map((r) => `"${r}"`).join(" | ")} | null}` }, 400);
      }
      const checks = await (await openMarks(blobs, db)).change("check", (checks) => {
        const entry = { ...(checks[number] || {}) };
        if (body.review) Object.assign(entry, { review: body.review, review_at: new Date().toISOString() });
        else { delete entry.review; delete entry.review_at; }
        if (Object.keys(entry).length) checks[number] = entry; else delete checks[number];
        return checks;
      });
      return reply({ checks }, 200);
    }
    const change = Object.fromEntries(["contacted", "channel", "response", "follow_up_at", "company_name"]
      .filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    const touchesContact = "contacted" in change || "response" in change || "follow_up_at" in change;
    if (!COMPANY_NUMBER.test(number || "") || (!touchesContact && typeof notes !== "string")) {
      return reply({ error: "send {company_number} with contacted / channel / response / follow_up_at, or notes" }, 400);
    }
    const invalid = invalidChange(change);
    if (invalid) return reply({ error: invalid }, 400);
    if (typeof notes === "string" && notes.length > NOTES_MAX) return reply({ error: `notes are limited to ${NOTES_MAX} characters` }, 400);
    const at = new Date().toISOString();
    const io = await openMarks(blobs, db);
    const marks = await io.change("contacted", (stored) => (touchesContact ? applyContact(stored, number, change, at) : stored));
    const noted = await io.change("notes", (noted) => {
      if (typeof notes === "string") { if (notes.trim()) noted[number] = { text: notes.trim(), at }; else delete noted[number]; }
      return noted;
    });
    return reply({ contacted: marks, notes: noted }, 200);
  }
  const params = new URL(req.url).searchParams;
  if (params.get("view") === "feedkey") {
    const salt = (await blobs.get(FEED_SALT_KEY, { type: "json" }))?.salt || "v1";
    return reply({ key: await feedKey(password, salt), path: "/api/feed" }, 200);
  }
  if (params.get("view") === "jobs") {
    const jobs = (await blobs.get(JOBS_KEY, { type: "json" })) || { employers: [], queries: [] };
    delete jobs.lookups;   // the name-search cache stays server-side
    return reply(jobs, 200);
  }
  if (params.get("view") === "emerging") {
    return reply((await blobs.get(EMERGING_KEY, { type: "json" })) || { rows: [], niches: [] }, 200);
  }
  if (params.get("view") === "search") {
    const [asked, results, alike] = await Promise.all([SEARCHES_KEY, SEARCH_RESULTS_KEY, LOOKALIKES_KEY].map((k) => blobs.get(k, { type: "json" })));
    return reply({ searches: asked?.searches || [], results: results?.results || {}, results_made_at: results?.made_at || "",
                   lookalikes: alike || { items: [] } }, 200);
  }
  if (params.get("view") === "losses") {
    return reply((await blobs.get(LOSSES_KEY, { type: "json" })) || { rows: [] }, 200);
  }
  if (params.get("view") === "alerts") {
    const [alerts, found, moments] = await Promise.all([ALERTS_KEY, DISCOVERIES_KEY, MOMENTS_KEY].map((k) => blobs.get(k, { type: "json" })));
    // customs moments for the lists' companies sit with the alerts (new to importing / exporting, trade growing)
    const items = [...(alerts?.items || []), ...(moments?.items || []).filter((m) => m.tracked)]
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return reply({ ...(alerts || {}), items, discoveries: found?.rows || [] }, 200);
  }
  // For the lead score: each measured niche's numbers (niche_hits) and each company's recent alerts (kind, date, title).
  if (params.get("view") === "signals") {
    const [niches, alerts, deals, domains, moments, owners, parents] = await Promise.all([NICHES_KEY, ALERTS_KEY, DEALS_KEY, DOMAINS_KEY, MOMENTS_KEY, OWNERS_KEY, PARENTS_KEY].map((k) => blobs.get(k, { type: "json" })));
    const websites = Object.fromEntries(Object.entries(domains?.sites || {}).map(([n, s]) => [n, s.website]));
    const owners_search = Object.fromEntries(Object.entries(owners?.companies || {}).filter(([, o]) => o.owner)
      .map(([n, o]) => [n, { owner: o.owner, kind: o.kind, country: o.country || "", quote: o.quote || "", url: o.url || "", chain: (o.chain || []).map((c) => c.owner) }]));
    return reply({ niches: niches?.niches || {}, niches_made_at: niches?.made_at || "", headings: niches?.headings || [], codes: (niches?.codes || []).slice(0, 60), websites, owners_search, parents_of: Object.fromEntries(Object.entries(parents?.companies || {}).filter(([, p]) => p.ultimate_parent)
                     .map(([n, p]) => [n, { ultimate_parent: p.ultimate_parent, country: p.country || "", evidence: p.evidence || "", accounts_url: p.accounts_url || "" }])),
                   alerts_summary: alertsSummary(alerts?.items || []),
                   signals: signalsByCompany([...(alerts?.items || []), ...dealSignals(deals?.items || []), ...(moments?.items || [])]) }, 200);
  }
  // The New money tab: purchases from the ownership register, plus the news of PE deals and funding rounds.
  if (params.get("view") === "deals") {
    const [deals, alerts] = await Promise.all([DEALS_KEY, ALERTS_KEY].map((k) => blobs.get(k, { type: "json" })));
    return reply({ made_at: deals?.made_at || "", window_days: deals?.window_days || 0, items: deals?.items || [],
                   news: (alerts?.items || []).filter((a) => /^(news_(pe|funding)|pe_debt)$/.test(a.kind)) }, 200);
  }
  // The database move (api/db.mjs): is it bound, when was it last copied, how many rows — the check before stage 2.
  // The Outreach tab from the database (stage 2): one list a page at a time, ranked in SQL; each row with its why.
  if (params.get("view") === "outreach") {
    if (!db) return reply({ error: "no database yet" }, 404);
    const list = ["letter", "call", "email"].includes(params.get("list")) ? params.get("list") : "letter";
    const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 500);
    const offset = Math.max(Number(params.get("offset")) || 0, 0);
    const { contacted, verdict: verdicts } = await (await openMarks(blobs, db)).all();
    const notFit = Object.entries(verdicts || {}).filter(([, v]) => v?.verdict === "not_fit").map(([n]) => n);
    const page = await outreachPage(db, { list, offset, limit, letters: OUTREACH.letters, contacted: Object.keys(contacted || {}), notFit });
    if (!page.complete) return reply({ error: "the database is still being filled" }, 404);   // the page ranks in the browser
    const rows = page.rows.map((r) => ({ ...r, outreach_list: list, outreach_why: outreachWhy(r, list, { letters: OUTREACH.letters, total: page.total }) }));
    return reply({ list, offset, limit, rows, counts: page.counts, total: page.total, synced_at: page.synced_at, source: "database" }, 200);
  }
  if (params.get("view") === "db") {
    if (!db) return reply({ bound: false }, 200);
    const [synced] = await db("SELECT value FROM meta WHERE key = 'synced'");
    const counts = await db("SELECT 'companies' AS t, COUNT(*) AS n FROM companies UNION ALL SELECT 'signals', COUNT(*) FROM signals UNION ALL SELECT 'marks', COUNT(*) FROM marks");
    return reply({ bound: true, synced: synced ? JSON.parse(synced.value) : null, counts: Object.fromEntries(counts.map((c) => [c.t, Number(c.n)])) }, 200);
  }
  if (params.get("view") === "details") {
    const number = String(params.get("company") || "").toUpperCase();
    const shard = number ? await blobs.get(`${DETAILS_PREFIX}${detailShard(number)}`, { type: "json" }) : null;
    return reply({ company_number: number, details: shard?.[number] || {} }, 200);
  }
  if (params.get("view") === "ranked") {
    return reply((await blobs.get(RANKED_KEY, { type: "json" })) || { rows: [], ruled_out: {}, niches: [] }, 200);
  }
  if (params.get("view") === "calls") {
    return reply((await blobs.get(CALLS_KEY, { type: "json" })) || { rows: [] }, 200);
  }
  if (params.get("view") === "filings") {
    const month = params.get("month") || "";
    if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) return reply({ error: "month is YYYY-MM" }, 400);
      return reply((await blobs.get(filingsMonthKey(month), { type: "json" })) || { month, rows: [] }, 200);
    }
    const filings = await blobs.get(FILINGS_KEY, { type: "json" });
    if (!filings) return reply({ error: "no FX filings scanned yet — they arrive with the next FX filings run" }, 404);
    const { files_done: _done, files_rescanned: _rescanned, files_rescanned_r2: _r2, files_rescanned_r3: _r3, files_rescanned_r4: _r4, ...rest } = filings;
    return reply(rest, 200);   // the index (months and counts); the first version carried its rows here too
  }
  const [data, status, m] = await Promise.all([blobs.get(KEY, { type: "json" }), blobs.get(STATUS_KEY, { type: "json" }), openMarks(blobs, db).then((io) => io.all())]);
  if (!data) return reply({ error: "no account list uploaded yet — it arrives with the next finder run" }, 404);
  return reply({ ...data, contacted: m.contacted, notes: m.notes, status: status || {}, emails: m.email, checks: m.check, verdicts: m.verdict, lists: m.list }, 200);
}
