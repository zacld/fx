// The outreach sequence (Zac's follow-up grid, 15 Nov 2026): 18 steps over 20 working days from Day 0, the cold email
// or the gift ("Send out" — the chocolate mailing — or "Cold"). Each company on a list can start it; the page shows
// every step's date, ticks them off, and puts the next one due first. Nothing is sent: Zac sends, the page reminds.
// Days count working days (Mon–Fri), so Day 1 after a Wednesday is the Thursday, as in the grid.

export const SEQUENCE = [
  { step: 1, day: 0, kind: "email", label: "Gift sent / cold email" },
  { step: 2, day: 1, kind: "call", label: "Call 1" },
  { step: 3, day: 1, kind: "email", label: "Follow-up email" },
  { step: 4, day: 2, kind: "call", label: "Call 2" },
  { step: 5, day: 2, kind: "email", label: "Email 2 — intro" },
  { step: 6, day: 2, kind: "linkedin", label: "LinkedIn request" },
  { step: 7, day: 4, kind: "call", label: "Call 3" },
  { step: 8, day: 3, kind: "email", label: "Email 3 — treasury" },
  { step: 9, day: 7, kind: "call", label: "Call 4" },
  { step: 10, day: 4, kind: "email", label: "Email 4 — case study" },
  { step: 11, day: 7, kind: "call", label: "Call 5" },
  { step: 12, day: 7, kind: "email", label: "Email 5 — market insight" },
  { step: 13, day: 10, kind: "email", label: "Email 6 — money" },
  { step: 14, day: 12, kind: "linkedin", label: "LinkedIn message" },
  { step: 15, day: 14, kind: "call", label: "Call 6" },
  { step: 16, day: 14, kind: "email", label: "Email 7 — Investec" },
  { step: 17, day: 20, kind: "call", label: "Final call" },
  { step: 18, day: 20, kind: "email", label: "Email 8 — break-up" },
];

const iso = (d) => d.toISOString().slice(0, 10);
const asDate = (s) => new Date(`${String(s).slice(0, 10)}T12:00:00Z`);

// Day 0 plus n working days.
export function addWorkingDays(start, n) {
  const d = asDate(start);
  while ((d.getUTCDay() + 6) % 7 > 4) d.setUTCDate(d.getUTCDate() + 1);   // a weekend start counts from Monday
  for (let left = n; left > 0;) {
    d.setUTCDate(d.getUTCDate() + 1);
    if ((d.getUTCDay() + 6) % 7 < 5) left -= 1;
  }
  return iso(d);
}

// Every step with its due date and whether it's done: [{...step, due, done}] in date order (then step order).
export function plan(seq = {}) {
  if (!seq.start) return [];
  const done = seq.done || {};
  return SEQUENCE.map((s) => ({ ...s, due: addWorkingDays(seq.start, s.day), done: done[s.step] || "" }))
    .sort((a, b) => a.due.localeCompare(b.due) || a.step - b.step);
}

// The next step not done, with "overdue" / "today" / "upcoming" against today; null when finished or not started.
export function nextStep(seq = {}, today = new Date()) {
  const t = iso(today);
  const next = plan(seq).find((s) => !s.done);
  if (!next) return null;
  return { ...next, when: next.due < t ? "overdue" : next.due === t ? "today" : "upcoming" };
}

// For sorting a list: overdue first, then today, then by date; not started after, finished last.
export function sequenceRank(seq, today = new Date()) {
  if (!seq?.start) return "8";
  const n = nextStep(seq, today);
  return n ? `${n.when === "upcoming" ? 2 : n.when === "today" ? 1 : 0}${n.due}` : "9";
}

// The grid's columns for an export: Step 1 (Day 0) … Step 18 (Day 20), each the date done, else the date due.
export const GRID_COLUMNS = SEQUENCE.map((s) => [`step_${s.step}`, `Step ${s.step} - ${s.label} (Day ${s.day})`]);
export function gridCells(seq = {}) {
  const out = {};
  for (const s of plan(seq)) out[`step_${s.step}`] = s.done ? `${s.done.slice(0, 10)} ✓` : s.due;
  return out;
}

// Server-side check of a saved sequence: {start, gift?, done: {step: iso}} with sane dates.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export function validSequence(seq) {
  if (seq === null) return true;
  if (!seq || typeof seq !== "object" || !DAY.test(seq.start || "")) return false;
  if (seq.gift && !DAY.test(seq.gift)) return false;
  return Object.entries(seq.done || {}).every(([k, v]) => SEQUENCE.some((s) => String(s.step) === k) && DAY.test(String(v).slice(0, 10)));
}
