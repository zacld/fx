// Your day (Zac, 23 Nov 2026: "a tracker of what I do each day — the total of leads I've looked through, the good leads,
// the open ones … like a Spotify Wrapped of the day; the sectors that worked, didn't work"). Worked out from his own
// marks only — each mark keeps the time it was made (checks.review_at, verdicts.at, lists.at, a touch's at, a sequence
// step's date, a note's at) — so nothing new is stored and nothing comes from the bank's records. A company counts on the
// day of its latest mark: one marked again later moves to that day, and an undone mark isn't counted.
import { industryOf, leadSource } from "./format.js";
import { SEQUENCE } from "./sequence.js";
import { touchesOf } from "./followups.js";

// [key, label, group]: keep — worth going after; drop — not for us; skip — off the list with no reason kept (neutral,
// as in the feedback loop). The first seven are Today's list's buttons; the rest are marks made on other tabs.
export const OUTCOMES = [
  ["good", "Good lead", "keep"], ["research", "Research harder", "keep"], ["open", "Open lead", "keep"],
  ["call", "Call list", "keep"], ["mine", "Added to mine", "keep"], ["email", "Email list", "keep"], ["post", "Mail list", "keep"],
  ["small", "Not enough revenue", "drop"], ["abroad", "Owned abroad", "drop"], ["notfit", "Not a fit (other reason)", "drop"],
  ["skip", "Skipped", "skip"],
];
const GROUP = Object.fromEntries(OUTCOMES.map(([k, , g]) => [k, g]));
export const outcomeLabel = (k) => OUTCOMES.find(([x]) => x === k)?.[1] || k;

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (day) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
// The local calendar day of a mark's time ("2026-11-23T09:12:00Z" → "2026-11-23" in the viewer's time zone); a bare date
// stays as it is.
export function localDay(at) {
  const s = String(at || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : fmt(d);
}
export const shiftDay = (day, k) => { const d = dateOf(day); d.setDate(d.getDate() + k); return fmt(d); };
export const isWeekend = (day) => [0, 6].includes(dateOf(day).getDay());
export const dayLabel = (day) => dateOf(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const hasTime = (at) => /T\d{2}:\d{2}/.test(String(at || ""));

// Every mark as an action: [{n, kind, at, day}].
export function markActions({ checks = {}, verdicts = {}, lists = {} } = {}) {
  const out = [];
  for (const [n, v] of Object.entries(checks)) if (GROUP[v?.review] && v.review_at) out.push({ n, kind: v.review, at: v.review_at });
  for (const [n, v] of Object.entries(verdicts)) {
    if (v?.verdict && v.at) out.push({ n, kind: v.verdict === "good" ? "good" : v.reason === "Too small" ? "small" : "notfit", at: v.at });
  }
  for (const [n, v] of Object.entries(lists)) if (GROUP[v?.list] && v.at) out.push({ n, kind: v.list, at: v.at });
  return out.map((a) => ({ ...a, day: localDay(a.at) })).filter((a) => a.day);
}

// {day: companies marked that day}
function perDay(actions) {
  const days = new Map();
  for (const a of actions) { if (!days.has(a.day)) days.set(a.day, new Set()); days.get(a.day).add(a.n); }
  return new Map([...days].map(([d, s]) => [d, s.size]));
}

// Each key's keep / drop / skip counts; rate = kept ÷ (kept + dropped), skips aside.
function tally(items, keyOf) {
  const t = new Map();
  for (const it of items) {
    const key = keyOf(it) || "(none)";
    const e = t.get(key) || { key, keep: 0, drop: 0, skip: 0, total: 0, drops: {} };
    e[GROUP[it.kind]] += 1;
    e.total += 1;
    if (GROUP[it.kind] === "drop") e.drops[it.kind] = (e.drops[it.kind] || 0) + 1;
    t.set(key, e);
  }
  return [...t.values()].map((e) => ({ ...e, rate: e.keep + e.drop ? e.keep / (e.keep + e.drop) : null,
    mainDrop: Object.entries(e.drops).sort((a, b) => b[1] - a[1])[0]?.[0] || "" }));
}
// What worked: the most kept, then the best rate. What didn't: two or more judged, a third or fewer kept, most dropped first.
const worked = (t) => t.filter((e) => e.keep > 0).sort((a, b) => b.keep - a.keep || b.rate - a.rate || b.total - a.total).slice(0, 4);
const didnt = (t) => t.filter((e) => e.keep + e.drop >= 2 && e.rate <= 1 / 3).sort((a, b) => b.drop - a.drop || a.rate - b.rate).slice(0, 4);

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sizeOf = (r) => Number(r?.turnover_gbp) || Number(r?.turnover_foreign_gbp) || 0;

/**
 * The day's wrap: what he looked through and how he marked it, what worked, his pace, the day against others, and what
 * else he got done. `rows` are the companies the page knows (a mark on one it doesn't still counts, as "Not on the lists").
 */
export function dayWrap(rows = [], { checks = {}, verdicts = {}, lists = {}, contacted = {}, notes = {} } = {}, day = localDay(new Date().toISOString())) {
  const byNo = new Map(rows.map((r) => [r.company_number, r]));
  const actions = markActions({ checks, verdicts, lists });
  const latest = new Map();
  for (const a of actions) if (a.day === day && (!latest.has(a.n) || String(a.at) > String(latest.get(a.n).at))) latest.set(a.n, a);
  const marked = [...latest.values()].map((a) => ({ ...a, r: byNo.get(a.n) || null }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));

  const counts = Object.fromEntries(OUTCOMES.map(([k]) => [k, 0]));
  for (const a of marked) counts[a.kind] += 1;
  const groupCount = (g) => marked.filter((a) => GROUP[a.kind] === g).length;
  const keep = groupCount("keep"), drop = groupCount("drop"), skip = groupCount("skip");

  const known = marked.filter((a) => a.r);
  const keepers = known.filter((a) => GROUP[a.kind] === "keep"), drops = known.filter((a) => GROUP[a.kind] === "drop");
  const tallies = {
    sector: tally(marked, (a) => (a.r ? industryOf(a.r) : "Not on the lists")),
    niche: tally(known, (a) => a.r.fx_niche || "(no niche)"),
    source: tally(known, (a) => leadSource(a.r) || "Finder"),
  };
  const best = [...keepers].sort((a, b) => (b.r.lead_score || 0) - (a.r.lead_score || 0))[0] || null;
  const score = (xs) => { const v = avg(xs.map((a) => a.r.lead_score).filter((x) => Number.isFinite(x))); return v == null ? null : Math.round(v); };
  const size = (xs) => median(xs.map((a) => sizeOf(a.r)).filter((x) => x > 0));

  // Pace: from the first mark to the last, and the busiest hour.
  const times = marked.filter((a) => hasTime(a.at)).map((a) => new Date(a.at)).sort((a, b) => a - b);
  const minutes = times.length >= 2 ? (times[times.length - 1] - times[0]) / 60000 : 0;
  const hours = new Map();
  for (const t of times) hours.set(t.getHours(), (hours.get(t.getHours()) || 0) + 1);
  const [busyHour, busyCount] = [...hours].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] || [null, 0];

  // The day against the others: the last 14 days, the working day before, his average day (days he marked in the 4 weeks
  // before), his best day, and the streak (days in a row with a mark; a weekend without marks doesn't break it).
  const daily = perDay(actions);
  const count = (d) => daily.get(d) || 0;
  const history = Array.from({ length: 14 }, (_, i) => shiftDay(day, i - 13)).map((d) => ({ day: d, count: count(d) }));
  let before = shiftDay(day, -1);
  while (isWeekend(before) && !count(before)) before = shiftDay(before, -1);
  const recent = Array.from({ length: 28 }, (_, i) => count(shiftDay(day, -1 - i))).filter((c) => c > 0);
  const bestDay = [...daily].filter(([d]) => d <= day).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0] || null;
  let streak = 0;
  for (let d = count(day) ? day : before, i = 0; i < 400; d = shiftDay(d, -1), i += 1) {
    if (count(d)) streak += 1;
    else if (!isWeekend(d)) break;
  }

  // What else got done: sequence steps ticked (calls, emails, LinkedIn), contacts logged, notes written.
  const kindOf = Object.fromEntries(SEQUENCE.map((s) => [String(s.step), s.kind]));
  const steps = { call: 0, email: 0, linkedin: 0 };
  for (const v of Object.values(lists)) {
    for (const [step, d] of Object.entries(v?.seq?.done || {})) if (localDay(d) === day && kindOf[step] in steps) steps[kindOf[step]] += 1;
  }
  let touches = 0;
  const touched = new Set(), channels = {};
  for (const [n, mark] of Object.entries(contacted)) {
    for (const t of touchesOf(mark)) {
      if (localDay(t.at) !== day) continue;
      touches += 1; touched.add(n);
      const c = t.channel || "other"; channels[c] = (channels[c] || 0) + 1;
    }
  }
  const notesToday = Object.values(notes).filter((x) => x?.text && localDay(x.at) === day).length;

  return {
    day, looked: marked.length, keep, drop, skip, counts, marked,
    keepRate: keep + drop ? Math.round((100 * keep) / (keep + drop)) : null,
    worked: { sector: worked(tallies.sector), niche: worked(tallies.niche), source: worked(tallies.source) },
    didnt: { sector: didnt(tallies.sector), niche: didnt(tallies.niche), source: didnt(tallies.source) },
    best: best && { company_number: best.n, company_name: best.r.company_name, kind: best.kind, lead_score: best.r.lead_score,
      industry: industryOf(best.r), turnover: sizeOf(best.r), turnover_basis: best.r.turnover_basis || "" },
    scores: { keep: score(keepers), drop: score(drops) }, sizes: { keep: size(keepers), drop: size(drops) },
    pace: { first: times[0] || null, last: times[times.length - 1] || null, minutes: Math.round(minutes),
      perHour: times.length >= 3 && minutes >= 15 ? Math.round(times.length / (minutes / 60)) : null,
      busyHour, busyCount },
    history, before: { day: before, count: count(before) }, average: recent.length ? Math.round(avg(recent)) : null,
    bestDay: bestDay && { day: bestDay[0], count: bestDay[1] }, streak,
    done: { ...steps, touches, contacted: touched.size, channels, notes: notesToday },
  };
}

// The day in a few lines, to copy into a message or a note (company names only — no people).
export function wrapText(w) {
  if (!w.looked) return `${dayLabel(w.day)}: no leads marked.`;
  const part = (keys) => keys.filter((k) => w.counts[k]).map((k) => `${w.counts[k]} ${outcomeLabel(k).toLowerCase()}`).join(", ");
  const lines = [`${dayLabel(w.day)} — ${w.looked} leads looked through.`];
  if (w.keep) lines.push(`Keepers: ${w.keep} (${part(["good", "research", "open", "call", "mine", "email", "post"])}).`);
  if (w.drop) lines.push(`Not for us: ${w.drop} (${part(["small", "abroad", "notfit"])}).`);
  if (w.skip) lines.push(`Skipped: ${w.skip}.`);
  const s = w.worked.sector[0];
  if (s) lines.push(`Best sector: ${s.key} (${s.keep} of ${s.keep + s.drop} kept).`);
  const d = w.didnt.sector[0];
  if (d) lines.push(`Didn't land: ${d.key} (${d.keep} of ${d.keep + d.drop} kept).`);
  if (w.best) lines.push(`Best find: ${w.best.company_name} (score ${w.best.lead_score}).`);
  const done = [w.done.call && `${w.done.call} calls`, w.done.email && `${w.done.email} emails`, w.done.linkedin && `${w.done.linkedin} LinkedIn`,
    w.done.contacted && `${w.done.contacted} contacted`].filter(Boolean);
  if (done.length) lines.push(`Done: ${done.join(", ")}.`);
  return lines.join("\n");
}
