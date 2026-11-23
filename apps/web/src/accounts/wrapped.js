// Your day (Zac, 23 Nov 2026: "a tracker of what I do each day — the total of leads I've looked through, the good leads,
// the open ones … like a Spotify Wrapped of the day; the sectors that worked, didn't work"). Worked out from his own
// marks only — each mark keeps the time it was made (checks.review_at, verdicts.at, lists.at, a touch's at, a sequence
// step's date, a note's at) — so nothing new is stored and nothing comes from the bank's records. A company counts on the
// day of its latest mark: one marked again later moves to that day, and an undone mark isn't counted.
import { chCompanyUrl, growthPct, hedgingNamed, hiddenFromFilters, inCoreBand, industryOf, leadSource, money, peBackedOf, siteOf } from "./format.js";
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

// The day in depth (Zac, 23 Nov 2026: "really in depth — what type of companies, how many I did, percentages"): the same
// day cut by size, lead score, signal and hour, and the week / month / all time so far.
export const SIZE_BANDS = ["Under £20m", "£20m–£50m", "£50m–£100m", "£100m–£300m", "£300m+", "No turnover filed"];
const sizeBand = (r) => { const t = sizeOf(r); return !t ? SIZE_BANDS[5] : t < 20e6 ? SIZE_BANDS[0] : t < 50e6 ? SIZE_BANDS[1]
  : t < 100e6 ? SIZE_BANDS[2] : t <= 300e6 ? SIZE_BANDS[3] : SIZE_BANDS[4]; };
export const SCORE_BANDS = ["60+", "50–59", "40–49", "30–39", "Under 30", "No score"];
const scoreBand = (r) => { const v = Number(r?.lead_score); return !Number.isFinite(v) || r?.lead_score == null ? SCORE_BANDS[5] : v >= 60 ? SCORE_BANDS[0]
  : v >= 50 ? SCORE_BANDS[1] : v >= 40 ? SCORE_BANDS[2] : v >= 30 ? SCORE_BANDS[3] : SCORE_BANDS[4]; };
// What the records said about each company, to see which signs went with a keeper (kept % with the sign v without it).
export const SIGNALS = [
  ["Strong FX proof in its filings (50+)", (r) => Number(r.filed_fx_score) >= 50],
  ["FX loss of £50k+", (r) => -Number(r.fx_gain_loss_gbp) >= 50000],
  ["No hedging named in its accounts", (r) => !hedgingNamed(r)],
  ["Growing 20%+", (r) => growthPct(r) >= 20],
  ["£20m–£300m turnover", (r) => inCoreBand(r)],
  ["Subsidiaries abroad", (r) => Boolean(r.subsidiaries_abroad)],
  ["PE-backed", (r) => Boolean(peBackedOf(r))],
  ["Hidden from the usual filters", (r) => hiddenFromFilters(r).length > 0],
  ["Sized by its group's accounts", (r) => r.turnover_basis === "group"],
];
const safely = (test, r) => { try { return Boolean(test(r)); } catch { return false; } };
const judged = (xs) => {
  const keep = xs.filter((a) => GROUP[a.kind] === "keep").length, drop = xs.filter((a) => GROUP[a.kind] === "drop").length;
  return { looked: xs.length, keep, drop, skip: xs.length - keep - drop, rate: keep + drop ? keep / (keep + drop) : null };
};

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

  // In depth: every cut of the day with its share of the day and kept %, the signals, the hours, and the running totals.
  const table = (items, keyOf, order) => {
    const out = tally(items, keyOf).map((e) => ({ ...e, share: marked.length ? e.total / marked.length : 0 }));
    return order ? out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : out.sort((a, b) => b.total - a.total || b.keep - a.keep);
  };
  const signals = SIGNALS.map(([label, test]) => {
    const yes = known.filter((a) => safely(test, a.r)), no = known.filter((a) => !safely(test, a.r));
    const w1 = judged(yes), w0 = judged(no);
    return { label, with: w1, without: w0, lift: w1.rate != null && w0.rate != null ? w1.rate - w0.rate : null };
  }).filter((x) => x.with.looked > 0).sort((a, b) => b.with.looked - a.with.looked);
  const hourKey = (a) => `${String(new Date(a.at).getHours()).padStart(2, "0")}:00`;
  const hourly = table(marked.filter((a) => hasTime(a.at)), hourKey).sort((a, b) => a.key.localeCompare(b.key));
  let weekStart = day;
  while (dateOf(weekStart).getDay() !== 1) weekStart = shiftDay(weekStart, -1);
  const totalsFrom = (from) => {
    const inRange = actions.filter((a) => a.day >= from && a.day <= day), last = new Map();
    for (const a of inRange) if (!last.has(a.n) || String(a.at) > String(last.get(a.n).at)) last.set(a.n, a);
    return { from, days: new Set(inRange.map((a) => a.day)).size, ...judged([...last.values()]) };
  };
  const depth = {
    marks: OUTCOMES.filter(([k]) => counts[k]).map(([k, label]) => ({ key: k, label, count: counts[k], share: marked.length ? counts[k] / marked.length : 0 })),
    sector: tallies.sector.map((e) => ({ ...e, share: marked.length ? e.total / marked.length : 0 })).sort((a, b) => b.total - a.total || b.keep - a.keep),
    size: table(known, (a) => sizeBand(a.r), SIZE_BANDS),
    score: table(known, (a) => scoreBand(a.r), SCORE_BANDS),
    niche: table(known, (a) => a.r.fx_niche || "(no niche)"),
    source: table(known, (a) => leadSource(a.r) || "Finder"),
    signals, hourly,
    totals: { week: totalsFrom(weekStart), month: totalsFrom(`${day.slice(0, 8)}01`), all: totalsFrom("0000-00-00") },
  };

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
    depth,
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

// Finish day (Zac, 23 Nov 2026: "a button … finish day, then it will compile the report and a document with the good lead
// names I can put on Notion"): the day's report as one document — the summary, then every keeper by its mark (best lead
// score first) with its Companies House link, website, industry, size, score and his note, then what was ruled out.
// Skipped companies are counted, never named (Skip is how he takes off a company the bank already has).
export const REPORT_SECTIONS = [
  ["good", "Good leads"], ["research", "Good leads to research harder (no contact found yet)"], ["open", "Open leads"],
  ["call", "Added to the call list"], ["mine", "Added to mine"], ["email", "Added to the email list"], ["post", "Added to the mail list"],
];
const DROPS = [["small", "Not enough revenue"], ["abroad", "Owned abroad"], ["notfit", "Not a fit (other reason)"]];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clockOf = (at) => (hasTime(at) ? new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
export function dayReport(w, notes = {}) {
  const item = (a) => {
    const r = a.r, size = sizeOf(r);
    return {
      kind: a.kind, mark: outcomeLabel(a.kind), name: r?.company_name || a.n, number: a.n, url: chCompanyUrl(a.n),
      website: r ? siteOf(r) : "", industry: r ? industryOf(r) : "", turnover: size || null, lead_score: r?.lead_score ?? null,
      meta: r ? [industryOf(r), size ? `${money(size)}${r.turnover_basis === "group" ? " (group)" : ""}` : "",
        Number.isFinite(r.lead_score) ? `score ${r.lead_score}` : ""].filter(Boolean).join(" · ") : "not on the lists",
      note: String(notes[a.n]?.text || "").trim(), at: clockOf(a.at),
    };
  };
  const byScore = (a, b) => (b.lead_score ?? -1) - (a.lead_score ?? -1);
  const sections = REPORT_SECTIONS.map(([k, title]) => ({ key: k, title, items: w.marked.filter((a) => a.kind === k).map(item).sort(byScore) }))
    .filter((sec) => sec.items.length);
  const summary = [];
  const share = (n) => (w.looked ? ` (${Math.round((100 * n) / w.looked)}%)` : "");
  const dp = w.depth;
  if (!w.looked) summary.push("No leads marked.");
  else {
    summary.push(`${plural(w.looked, "lead")} looked through: ${plural(w.keep, "keeper")}${share(w.keep)}, ${w.drop} not for us${share(w.drop)}, ${w.skip} skipped${share(w.skip)}`
      + `${w.keepRate != null ? ` — ${w.keepRate}% of those judged kept` : ""}.`);
    const most = dp.sector[0];
    if (most) summary.push(`Most looked at: ${most.key} — ${most.total} (${pct(most.share)} of the day), ${most.keep} kept.`);
    const sign = dp.signals.filter((x) => x.lift != null && x.with.keep + x.with.drop >= 3 && x.without.keep + x.without.drop >= 3)
      .sort((a, b) => b.lift - a.lift)[0];
    if (sign && sign.lift > 0) summary.push(`Strongest sign of a keeper: ${sign.label.toLowerCase()} — ${pct(sign.with.rate)} kept with it, ${pct(sign.without.rate)} without.`);
    const sd = w.depth.size.filter((e) => e.keep + e.drop >= 2).sort((a, b) => b.rate - a.rate || b.keep - a.keep)[0];
    if (sd) summary.push(`Best size band: ${sd.key} — ${sd.keep} of ${sd.keep + sd.drop} kept.`);
    const s = w.worked.sector[0], d = w.didnt.sector[0];
    if (s) summary.push(`Best sector: ${s.key} — ${s.keep} of ${s.keep + s.drop} kept.`);
    if (d) summary.push(`Didn't land: ${d.key} — ${d.keep} of ${d.keep + d.drop} kept${d.mainDrop ? `, mostly ${outcomeLabel(d.mainDrop).toLowerCase()}` : ""}.`);
    if (w.best) summary.push(`Best find: ${w.best.company_name} (score ${w.best.lead_score}).`);
    if (w.pace.first) {
      summary.push(`Worked ${clockOf(w.pace.first.toISOString())}${w.pace.minutes ? `–${clockOf(w.pace.last.toISOString())}` : ""}${w.pace.perHour ? `, about ${w.pace.perHour} leads an hour` : ""}.`);
    }
  }
  const done = [w.done.call && plural(w.done.call, "call"), w.done.email && plural(w.done.email, "email"),
    w.done.linkedin && plural(w.done.linkedin, "LinkedIn touch", "LinkedIn touches"), w.done.contacted && `${plural(w.done.contacted, "company", "companies")} contacted`,
    w.done.notes && plural(w.done.notes, "note")].filter(Boolean);
  if (done.length) summary.push(`Also done: ${done.join(", ")}.`);
  const vs = [w.before.count ? `${w.before.count} on ${dayLabel(w.before.day)}` : "", w.average != null ? `average day ${w.average}` : "",
    w.streak > 1 ? `${w.streak} days in a row` : ""].filter(Boolean);
  if (w.looked && vs.length) summary.push(`Against other days: ${vs.join(" · ")}.`);
  const notFor = DROPS.filter(([k]) => w.counts[k]).map(([k, label]) => ({
    label, count: w.counts[k], names: w.marked.filter((a) => a.kind === k).map((a) => a.r?.company_name || a.n),
  }));
  return { title: `Day report — ${dayLabel(w.day)}`, day: w.day, summary, tables: depthTables(w), sections, notFor, skipped: w.skip,
    keepers: sections.flatMap((sec) => sec.items) };
}

const pct = (x) => (x == null ? "–" : `${Math.round(100 * x)}%`);
const CUT_HEAD = ["Looked at", "% of day", "Kept", "Not for us", "Skipped", "Kept %"];
const cutRows = (rows, limit = rows.length) => rows.slice(0, limit).map((e) => ({
  cells: [e.key, String(e.total), pct(e.share), String(e.keep), String(e.drop), String(e.skip), pct(e.rate)], rate: e.rate }));
// The day's numbers as tables — {key, title, head, rows: [{cells, rate}], foot?, note?, meter?, minor?: the columns a
// phone leaves out (the report and downloads keep them)} — shared by the page,
// the Markdown and the HTML, so all three say the same.
export function depthTables(w) {
  const d = w.depth, t = d.totals;
  const totalRow = (label, x) => ({ cells: [label, String(x.days), String(x.looked), String(x.keep), String(x.drop), String(x.skip), pct(x.rate)], rate: x.rate });
  return [
    { key: "marks", title: "How you marked them", head: ["Mark", "Companies", "% of day"],
      rows: d.marks.map((m) => ({ cells: [m.label, String(m.count), pct(m.share)] })), foot: ["Total", String(w.looked), w.looked ? "100%" : "–"] },
    { key: "sector", title: "Type of company", head: ["Type of company", ...CUT_HEAD], rows: cutRows(d.sector), meter: true, minor: [4, 5] },
    { key: "size", title: "Size (filed turnover)", head: ["Turnover", ...CUT_HEAD], rows: cutRows(d.size), meter: true, minor: [4, 5] },
    { key: "score", title: "Lead score", head: ["Score", ...CUT_HEAD], rows: cutRows(d.score), meter: true, minor: [4, 5],
      note: "Does the ranking agree with you? A higher kept % in the higher bands says it does." },
    { key: "signals", title: "Signs of a keeper: kept % with and without", head: ["Sign in the records", "With it", "Kept % with", "Without", "Kept % without", "Difference"],
      rows: d.signals.map((x) => ({ cells: [x.label, String(x.with.looked), pct(x.with.rate), String(x.without.looked), pct(x.without.rate),
        x.lift == null ? "–" : `${x.lift >= 0 ? "+" : "−"}${Math.round(Math.abs(100 * x.lift))} pts`] })), minor: [1, 3, 4],
      note: "Kept % = keepers ÷ (keepers + not for us); skipped companies are left out." },
    { key: "niche", title: "Niches", head: ["Niche", ...CUT_HEAD], rows: cutRows(d.niche, 15), meter: true, minor: [4, 5],
      note: d.niche.length > 15 ? `The 15 most looked at of ${d.niche.length}.` : "" },
    { key: "source", title: "Where they came from", head: ["Source", ...CUT_HEAD], rows: cutRows(d.source), meter: true, minor: [4, 5] },
    { key: "hourly", title: "Hour by hour", head: ["Hour", ...CUT_HEAD], rows: cutRows(d.hourly), meter: true, minor: [4, 5] },
    { key: "totals", title: "Running totals", head: ["Period", "Days worked", "Looked at", "Kept", "Not for us", "Skipped", "Kept %"],
      rows: [totalRow("This week", t.week), totalRow("This month", t.month), totalRow("All time", t.all)], meter: true, minor: [4, 5],
      note: `The week from ${dayLabel(t.week.from)}; a company counts once in each period, by its latest mark.` },
  ].filter((tb) => tb.rows.length && (tb.key === "totals" ? t.all.looked > 0 : w.looked > 0));
}

const mdEscape = (t) => String(t).replace(/([\\`*_[\]#<>|])/g, "\\$1");
export const siteHref = (site) => (/^https?:\/\//i.test(site) ? site : `https://${site}`);
const href = siteHref;
// The report as Markdown — pasted into Notion it becomes headings, bullets and links (also a .md file).
export function reportMarkdown(rep) {
  const out = [`# ${rep.title}`, "", ...rep.summary.map((x) => `- ${mdEscape(x)}`)];
  if (rep.tables?.length) out.push("", "## The day in numbers");
  for (const tb of rep.tables || []) {
    out.push("", `### ${tb.title}`, "");
    if (tb.note) out.push(`_${mdEscape(tb.note)}_`, "");
    out.push(`| ${tb.head.map(mdEscape).join(" | ")} |`, `| ${tb.head.map((_, i) => (i ? "---:" : "---")).join(" | ")} |`);
    for (const r of tb.rows) out.push(`| ${r.cells.map(mdEscape).join(" | ")} |`);
    if (tb.foot) out.push(`| ${tb.foot.map((c) => `**${mdEscape(c)}**`).join(" | ")} |`);
  }
  if (rep.tables?.length) out.push("", "## The companies");
  if (!rep.sections.length) out.push("", "No keepers.");
  for (const sec of rep.sections) {
    out.push("", `## ${sec.title} (${sec.items.length})`, "");
    for (const it of sec.items) {
      out.push(`- **${mdEscape(it.name)}** — [${it.number}](${it.url})${it.website ? ` · [website](${href(it.website)})` : ""}${it.meta ? ` · ${mdEscape(it.meta)}` : ""}`);
      if (it.note) out.push(`    - Note: ${mdEscape(it.note.replace(/\s*\n+\s*/g, " "))}`);
    }
  }
  if (rep.notFor.length || rep.skipped) {
    out.push("", "## Not for us", "");
    for (const x of rep.notFor) out.push(`- ${x.label} (${x.count}): ${x.names.map(mdEscape).join(", ")}`);
    if (rep.skipped) out.push(`- Skipped: ${rep.skipped}`);
  }
  out.push("", `_From the FX accounts dashboard, ${rep.day}._`);
  return out.join("\n");
}

const htmlEscape = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// The same report as HTML, for pasting into Notion, an email or Teams with its formatting.
export function reportHtml(rep) {
  const a = (url, text) => `<a href="${htmlEscape(url)}">${htmlEscape(text)}</a>`;
  const out = [`<h1>${htmlEscape(rep.title)}</h1>`, `<ul>${rep.summary.map((x) => `<li>${htmlEscape(x)}</li>`).join("")}</ul>`];
  if (rep.tables?.length) out.push("<h2>The day in numbers</h2>");
  for (const tb of rep.tables || []) {
    const row = (cells, tag) => `<tr>${cells.map((c, i) => `<${tag}${i ? ' style="text-align:right"' : ""}>${htmlEscape(c)}</${tag}>`).join("")}</tr>`;
    out.push(`<h3>${htmlEscape(tb.title)}</h3>`, tb.note ? `<p><em>${htmlEscape(tb.note)}</em></p>` : "",
      `<table><thead>${row(tb.head, "th")}</thead><tbody>${tb.rows.map((r) => row(r.cells, "td")).join("")}${tb.foot ? row(tb.foot, "th") : ""}</tbody></table>`);
  }
  if (rep.tables?.length) out.push("<h2>The companies</h2>");
  if (!rep.sections.length) out.push("<p>No keepers.</p>");
  for (const sec of rep.sections) {
    out.push(`<h2>${htmlEscape(sec.title)} (${sec.items.length})</h2><ul>`);
    for (const it of sec.items) {
      out.push(`<li><strong>${htmlEscape(it.name)}</strong> — ${a(it.url, it.number)}${it.website ? ` · ${a(href(it.website), "website")}` : ""}${it.meta ? ` · ${htmlEscape(it.meta)}` : ""}`
        + `${it.note ? `<ul><li>Note: ${htmlEscape(it.note)}</li></ul>` : ""}</li>`);
    }
    out.push("</ul>");
  }
  if (rep.notFor.length || rep.skipped) {
    out.push("<h2>Not for us</h2><ul>", ...rep.notFor.map((x) => `<li>${htmlEscape(x.label)} (${x.count}): ${x.names.map(htmlEscape).join(", ")}</li>`),
      rep.skipped ? `<li>Skipped: ${rep.skipped}</li>` : "", "</ul>");
  }
  out.push(`<p><em>From the FX accounts dashboard, ${htmlEscape(rep.day)}.</em></p>`);
  return out.join("");
}
