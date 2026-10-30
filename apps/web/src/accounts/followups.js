// Follow-ups for the Accounts page: who was contacted, how and when, and what to do next. Shared by the page and
// /api/accounts (which saves the marks), so both apply a change the same way. Reminders and copy-ready text only:
// nothing is ever sent.
//
// A mark: {at, touches: [{at, channel}], response, response_at, follow_up_at} — `at` is the first contact. Marks
// saved before touches existed ({at} only) count as one touch.

export const CHANNELS = { phone: "Phone", email: "Email", linkedin: "LinkedIn", in_person: "In person" };
export const RESPONSES = { replied: "Replied", booked: "Meeting booked", not_interested: "Not interested" };
export const FOLLOW_UP_DAYS = [2, 4, 7];   // after the 1st, 2nd and 3rd touch
export const NURTURE_DAYS = 90;            // after that with no reply: look again in about three months
export const MAX_TOUCHES = 20;

const DAY_MS = 864e5;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The calendar day in the viewer's time zone ("2026-10-28"), so "due today" means today where Zac is.
export const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString("en-CA") : "");
const addDays = (iso, days) => new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
const daysBetween = (fromDay, toDay) => Math.round((Date.parse(toDay) - Date.parse(fromDay)) / DAY_MS);

export const touchesOf = (mark) => (!mark ? [] : mark.touches?.length ? mark.touches : [{ at: mark.at, channel: "" }]);

/** Why a change can't be saved, or "" when it can. */
export function invalidChange({ contacted, channel, response, follow_up_at: followUpAt, company_name: name } = {}) {
  if (name !== undefined && (typeof name !== "string" || name.length > 200)) return "company_name must be text (200 characters at most)";
  if (contacted !== undefined && typeof contacted !== "boolean") return "contacted must be true or false";
  if (channel !== undefined && channel !== "" && !(channel in CHANNELS)) return `channel must be one of ${Object.keys(CHANNELS).join(", ")}`;
  if (response !== undefined && response !== "" && !(response in RESPONSES)) return `response must be one of ${Object.keys(RESPONSES).join(", ")}`;
  if (followUpAt !== undefined && followUpAt !== "" && !DATE.test(followUpAt)) return "follow_up_at must be YYYY-MM-DD";
  return "";
}

/**
 * The marks after one change to one company, as a new object:
 *   {contacted: true, channel}  logs a touch (the first one marks the company contacted) and clears a chosen date;
 *   {contacted: false}          takes the company off the contacted list;
 *   {response}                  replied / booked / not_interested ("" clears it);
 *   {follow_up_at}              a chosen next date, "YYYY-MM-DD" ("" goes back to the suggested one).
 * A response or date for a company not yet contacted changes nothing.
 */
export function applyContact(marks, number, change, now = new Date().toISOString()) {
  const next = { ...marks };
  if (change.contacted === false) {
    delete next[number];
    return next;
  }
  let mark = next[number] ? { ...next[number], touches: touchesOf(next[number]) } : null;
  if (change.contacted === true) {
    mark = mark || { at: now, touches: [] };
    if (change.company_name) mark.name = change.company_name;   // kept so the company stays listed if a scan drops it
    mark.touches = [...mark.touches, { at: now, channel: change.channel || "" }].slice(-MAX_TOUCHES);
    delete mark.follow_up_at;
  }
  if (!mark) return next;
  if (change.response !== undefined) {
    if (change.response) Object.assign(mark, { response: change.response, response_at: now });
    else { delete mark.response; delete mark.response_at; }
  }
  if (change.follow_up_at !== undefined) {
    if (change.follow_up_at) mark.follow_up_at = change.follow_up_at; else delete mark.follow_up_at;
  }
  next[number] = mark;
  return next;
}

// Where a contacted company stands, in the order the Contacted tab lists them.
export const STATES = {
  overdue: "Overdue", due: "Due today", replied: "Replied — answer them", upcoming: "Upcoming",
  nurture: "Nurture", booked: "Meeting booked", closed: "Not interested",
};

const NEXT_ACTION = {
  phone: "Email follow-up", email: "Call the office", linkedin: "LinkedIn follow-up", in_person: "Email follow-up", "": "Call the office",
};

/**
 * {state, touches, last, nextDay, inDays, action, line} for a contacted company: the next follow-up 2, 4 then 7 days
 * after each touch (or the date Zac chose), then nurture; a reply or meeting stops the sequence. `line` is the
 * copy-ready follow-up for the next touch.
 */
export function followUp(mark, r = {}, now = new Date()) {
  const touches = touchesOf(mark);
  if (!touches.length) return null;
  const last = touches[touches.length - 1];
  const n = touches.length;
  const today = dayOf(now.toISOString());
  const base = { touches: n, last, response: mark.response || "", line: followUpLine(r, n) };
  if (mark.response === "booked") return { ...base, state: "booked", nextDay: "", inDays: null, action: "Meeting booked — prepare for it", line: "" };
  if (mark.response === "not_interested") return { ...base, state: "closed", nextDay: "", inDays: null, action: "Leave it — not interested", line: "" };
  if (mark.response === "replied") {
    return { ...base, state: "replied", nextDay: mark.follow_up_at || dayOf(mark.response_at) || today, inDays: 0,
             action: "They replied — answer and book a meeting", line: "" };
  }
  const nurture = n > FOLLOW_UP_DAYS.length;
  const nextDay = mark.follow_up_at || dayOf(addDays(last.at, nurture ? NURTURE_DAYS : FOLLOW_UP_DAYS[n - 1]));
  const inDays = daysBetween(today, nextDay);
  const state = nurture && !mark.follow_up_at ? (inDays <= 0 ? "due" : "nurture") : inDays < 0 ? "overdue" : inDays === 0 ? "due" : "upcoming";
  const action = nurture ? "Nurture — try again when a market move hits their currency"
    : n === 1 ? NEXT_ACTION[last.channel || ""] || NEXT_ACTION[""]
    : n === 2 ? "Call the office — ask who handles overseas supplier payments"
    : "Last try — a short break-up note, then nurture";
  return { ...base, state, nextDay, inDays, action };
}

const lcFirst = (s = "") => (/^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));   // "FX loss" stays

/**
 * The copy-ready follow-up after `n` touches, matching the suggested action: event reminder (after the 1st), soft bump
 * — who handles overseas payments? (2nd), break-up — the last try (3rd); in nurture, a new angle to reopen with
 * later. No AI.
 */
export function followUpLine(r = {}, n = 1) {
  const cur = r.main_currency || (r.currency_pairs || "").split("|")[0]?.replace("GBP/", "") || "";
  const payments = cur ? `${cur} supplier payments` : "overseas supplier payments";
  if (n <= 1) {
    const why = r.fact_1 ? ` (${lcFirst(r.fact_1).replace(/\.$/, "")})` : "";
    return `Just following up — with sterling still moving, upcoming ${payments} could be worth a quick review${why}. Would a 10-minute call this week work?`;
  }
  if (n === 2) {
    return `Not sure if you're the right person for this — would ${payments} normally sit with finance or with ${r.lead_director || "the MD"}?`;
  }
  if (n === 3) {
    return `No worries if it's not relevant — I just thought it could be useful given the recent moves. I'll leave it there for now, but do get in touch if ${payments} come up.`;
  }
  return `A lot of businesses paying overseas suppliers just use their bank and don't always see the rate and spread difference — happy to run a quick comparison on a recent ${cur ? `${cur} ` : ""}payment, no commitment.`;
}

/** Contacted companies in follow-up order: overdue, due, replied, upcoming (soonest first), nurture, booked, closed. */
export function sortFollowUps(rows, marks, now = new Date()) {
  const order = Object.keys(STATES);
  const info = new Map(rows.map((r) => [r, followUp(marks[r.company_number], r, now)]));
  return [...rows].sort((a, b) => {
    const x = info.get(a), y = info.get(b);
    return order.indexOf(x?.state) - order.indexOf(y?.state) || (x?.nextDay || "9").localeCompare(y?.nextDay || "9") || a.rank - b.rank;
  });
}
