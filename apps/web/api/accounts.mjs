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
import { applyContact, invalidChange } from "../src/accounts/followups.js";

export const STORE = "fx-accounts";
export const KEY = "latest";
export const CONTACTED_KEY = "contacted";   // {company_number: {at, touches, response, follow_up_at}} — Zac's, never the finder's
export const CHECKS_KEY = "checks";         // {company_number: {crm: iso}} — the lead checklist's "CRM checked" tick
export const NOTES_KEY = "notes";           // {company_number: {text, at}} — Zac's notes, likewise
export const FILINGS_KEY = "filings";       // {made_at, files_done, months: [{month, count}]} — the Recent FX filings tab's index
export const filingsMonthKey = (month) => `filings/${month}`;   // {month, rows}: the companies filed that month
export const STATUS_KEY = "status";   // {jobs: {finder|filings|market|audit: {at, state, run, note, …}}} — each workflow's last outcome
export const EMAILS_KEY = "emails";   // {company_number: {row, text, at}} — the Email generator tab's companies (Zac's)
export const EMAILS_MAX = 100;
export const EMAIL_TEXT_MAX = 8000;
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
export async function handle(req, { password = "", store, delay = WRONG_PASSWORD_DELAY_MS } = {}) {
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
    if ("email" in body) {
      const e = body.email;
      if (!COMPANY_NUMBER.test(number || "") || (e !== null && (typeof e !== "object" || (!e.row && !("text" in e))))) {
        return reply({ error: "send {company_number, email: {row} | {text} | null}" }, 400);
      }
      if (e && "text" in e && e.text !== null && (typeof e.text !== "string" || e.text.length > EMAIL_TEXT_MAX)) {
        return reply({ error: `an email's text is a string of at most ${EMAIL_TEXT_MAX} characters` }, 400);
      }
      const emails = applyEmail((await blobs.get(EMAILS_KEY, { type: "json" })) || {}, number, e, new Date().toISOString());
      await blobs.setJSON(EMAILS_KEY, emails);
      return reply({ emails }, 200);
    }
    if ("crm_checked" in body) {   // the lead checklist's own tick: Zac checked the bank's CRM (kept here as a date only)
      if (!COMPANY_NUMBER.test(number || "") || typeof body.crm_checked !== "boolean") {
        return reply({ error: "send {company_number, crm_checked: true | false}" }, 400);
      }
      const checks = (await blobs.get(CHECKS_KEY, { type: "json" })) || {};
      if (body.crm_checked) checks[number] = { ...(checks[number] || {}), crm: new Date().toISOString() };
      else delete checks[number];
      await blobs.setJSON(CHECKS_KEY, checks);
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
    const [stored, noted] = await Promise.all([CONTACTED_KEY, NOTES_KEY].map(async (k) => (await blobs.get(k, { type: "json" })) || {}));
    const at = new Date().toISOString();
    const marks = touchesContact ? applyContact(stored, number, change, at) : stored;
    if (typeof notes === "string") { if (notes.trim()) noted[number] = { text: notes.trim(), at }; else delete noted[number]; }
    if (touchesContact) await blobs.setJSON(CONTACTED_KEY, marks);
    if (typeof notes === "string") await blobs.setJSON(NOTES_KEY, noted);
    return reply({ contacted: marks, notes: noted }, 200);
  }
  const params = new URL(req.url).searchParams;
  if (params.get("view") === "losses") {
    return reply((await blobs.get(LOSSES_KEY, { type: "json" })) || { rows: [] }, 200);
  }
  if (params.get("view") === "alerts") {
    const [alerts, found] = await Promise.all([ALERTS_KEY, DISCOVERIES_KEY].map((k) => blobs.get(k, { type: "json" })));
    return reply({ ...(alerts || { items: [] }), discoveries: found?.rows || [] }, 200);
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
    const { files_done: _done, files_rescanned: _rescanned, files_rescanned_r2: _r2, files_rescanned_r3: _r3, ...rest } = filings;
    return reply(rest, 200);   // the index (months and counts); the first version carried its rows here too
  }
  const [data, marks, noted, status, emails, checks] = await Promise.all([KEY, CONTACTED_KEY, NOTES_KEY, STATUS_KEY, EMAILS_KEY, CHECKS_KEY]
    .map((k) => blobs.get(k, { type: "json" })));
  if (!data) return reply({ error: "no account list uploaded yet — it arrives with the next finder run" }, 404);
  return reply({ ...data, contacted: marks || {}, notes: noted || {}, status: status || {}, emails: emails || {}, checks: checks || {} }, 200);
}
