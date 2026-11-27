// The weekly gift send-out (Zac, 27 Nov 2026: "pick on Wednesday evening 15 of my good leads and get their registered
// address; once I enrich, add the contact name"). From Wednesday 18:00 UK time the Send-out tab freezes a batch of 15
// of his good leads (the Top 20
// order, `topGoodLeads`), skipping any company already in a batch, contacted, out, or a second company of a group
// already in the batch. Each row carries its registered office split into the Cedar sheet's columns, with a flag when
// the address is probably not where the team works (care of someone, a PO box, or a postcode shared by many companies —
// an accountant's or a registered-office service; 26 Nov 2026: two of fifteen hand-picked addresses were wrong). The
// contact names come from Cognism, so they're typed on the page and kept only in that browser tab (never saved: what
// Cognism returns stays there). Rule-based, no AI.
import { naturalCompany } from "./email.js";
import { goodLeadsList, groupKey, isOut, topGoodLeads, TOP_GOOD } from "./format.js";

export const SENDOUT = {
  n: 15,             // companies a week
  day: 3, hour: 18,  // Wednesday, 18:00 UK time
  sharedMin: 40,     // companies registered at one postcode before it's flagged as a probable accountant's / service address
  firstWeek: "2026-12-02",   // the first batch picked (the tab went live after the week of 25 Nov's gifts had gone out)
};
// Batches are picked from the first week on; before it the tab shows what it would pick and saves nothing, so no good
// lead is used up on a week that was sent by hand.
export const sendoutLive = (week, rules = SENDOUT) => String(week || "") >= rules.firstWeek;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// The batch's week: the UK date of the latest Wednesday whose 18:00 has passed ("2026-11-25" all through to the next
// Wednesday 18:00). UK time whatever the browser's zone, summer time included.
export function sendoutWeek(now = new Date(), { day = SENDOUT.day, hour = SENDOUT.hour } = {}) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  let back = (WEEKDAYS.indexOf(p.weekday) - day + 7) % 7;
  if (back === 0 && Number(p.hour) < hour) back = 7;
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) - back)).toISOString().slice(0, 10);
}

// Every company that's been in a batch (picked, or swapped out by Zac): never picked again.
export function inBatches(batches = []) {
  const seen = new Set();
  for (const b of batches) for (const n of [...(b.companies || []), ...(b.skipped || [])]) seen.add(n);
  return seen;
}

// The week's companies: his good leads in the Top 20 order (stars, score, owner, size, why now), not contacted, not
// out, not in an earlier batch (or swapped out of this one), not already sent a gift from the Mail list, and one per group.
export function sendoutPick(rows = [], marks = {}, { contacted = {}, batches = [], keep = [], n = SENDOUT.n } = {}) {
  const used = inBatches(batches);
  const gifted = (num) => marks.lists?.[num]?.list === "post" && marks.lists[num]?.seq?.gift;
  const ranked = topGoodLeads(goodLeadsList(rows, marks), { contacted }, { ...TOP_GOOD, n: Infinity });
  const byNumber = new Map(rows.map((r) => [r.company_number, r]));
  const picked = keep.filter((num) => byNumber.has(num));
  const groups = new Set(picked.map((num) => groupKey(byNumber.get(num))));
  for (const x of ranked) {
    if (picked.length >= n) break;
    const num = x.r.company_number;
    if (picked.includes(num) || used.has(num) || gifted(num) || isOut(x.r)) continue;
    const g = groupKey(x.r);
    if (groups.has(g)) continue;
    groups.add(g);
    picked.push(num);
  }
  return picked;
}

// The registered office in the Cedar sheet's columns. The rows carry it as one line ("Unit 3, Harbour Trade
// Park, Mill Lane Industrial Estate, Chepstow, Monmouthshire") plus the postcode: the county and
// country go, the town is the last part left, and a short "Unit 3" / "Suite 302" / "6" joins the street after it.
const COUNTIES = new Set([
  "bedfordshire", "berkshire", "buckinghamshire", "cambridgeshire", "cheshire", "city of london", "cornwall", "county durham",
  "cumbria", "derbyshire", "devon", "dorset", "east riding of yorkshire", "east sussex", "essex", "gloucestershire", "greater london",
  "greater manchester", "hampshire", "herefordshire", "hertfordshire", "isle of wight", "kent", "lancashire", "leicestershire",
  "lincolnshire", "merseyside", "middlesex", "norfolk", "north yorkshire", "northamptonshire", "northumberland", "nottinghamshire",
  "oxfordshire", "rutland", "shropshire", "somerset", "south yorkshire", "staffordshire", "suffolk", "surrey", "tyne and wear",
  "tyne & wear", "warwickshire", "west midlands", "west sussex", "west yorkshire", "wiltshire", "worcestershire", "avon", "cleveland",
  "humberside", "herts", "hants", "lancs", "notts", "northants", "glos", "oxon", "bucks", "beds", "berks", "wilts", "worcs", "cambs",
  "leics", "lincs", "staffs", "w yorks", "s yorks", "n yorks", "isle of anglesey", "anglesey", "gwynedd", "conwy", "denbighshire",
  "flintshire", "powys", "ceredigion", "pembrokeshire", "carmarthenshire", "neath port talbot", "vale of glamorgan", "glamorgan",
  "mid glamorgan", "south glamorgan", "west glamorgan", "rhondda cynon taf", "monmouthshire", "clwyd", "dyfed", "gwent",
  "aberdeenshire", "angus", "argyll and bute", "ayrshire", "north ayrshire", "south ayrshire", "east ayrshire", "clackmannanshire",
  "dumfries and galloway", "dunbartonshire", "east dunbartonshire", "west dunbartonshire", "east lothian", "midlothian",
  "west lothian", "lothian", "fife", "highland", "inverclyde", "lanarkshire", "north lanarkshire", "south lanarkshire", "moray",
  "perth and kinross", "perthshire", "renfrewshire", "east renfrewshire", "scottish borders", "stirlingshire",
  "county antrim", "co antrim", "co. antrim", "county armagh", "co armagh", "county down", "co down", "co. down", "county fermanagh",
  "county londonderry", "co londonderry", "county tyrone", "co tyrone",
]);
const COUNTRY = /^(england|wales|scotland|northern ireland|united kingdom|uk|u\.k\.|great britain|gb)$/i;
const SHORT_FIRST = /^(unit|suite|flat|floor|apartment|office|room|\d+[a-z]?(-\d+[a-z]?)?)\b/i;
export function splitAddress(r = {}) {
  const postcode = String(r.postcode || "").trim().toUpperCase();
  const squash = (s) => s.toUpperCase().replace(/\s+/g, "");
  let parts = String(r.registered_address || "").split(",").map((p) => p.trim()).filter(Boolean)
    .filter((p) => !COUNTRY.test(p) && (!postcode || squash(p) !== squash(postcode)));
  parts = parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase());   // CH repeats the premises in line 1
  const careOf = parts[0] && /^(c\/o|care of)\b/i.test(parts[0]) ? parts.shift() : "";
  if (parts.length > 2 && COUNTIES.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  const city = parts.length > 1 ? parts.pop() : "";
  if (parts.length > 2 && SHORT_FIRST.test(parts[0]) && parts[0].length <= 12) parts.splice(0, 2, `${parts[0]}, ${parts[1]}`);
  return { care_of: careOf, line1: parts[0] || "", line2: parts.slice(1).join(", "), city, postcode };
}

// Why an address may not reach the team: {kind, text} each.
export function addressFlags(r = {}, { shared = 0, rules = SENDOUT } = {}) {
  const flags = [];
  const a = splitAddress(r);
  if (!a.line1 && !a.city) flags.push({ kind: "none", text: "No registered office on file — look it up on Companies House" });
  if (a.care_of) flags.push({ kind: "care_of", text: `Registered care of ${a.care_of.replace(/^(c\/o|care of)\s*/i, "")} — probably their accountant; use the trading address` });
  if (/\bp\.?\s?o\.?\s+box\b/i.test(r.registered_address || "")) flags.push({ kind: "po_box", text: "A PO box — use the trading address" });
  if (shared >= rules.sharedMin) {
    flags.push({ kind: "shared", text: `${shared.toLocaleString("en-GB")} companies are registered at this postcode — probably an accountant's or a registered-office service; check where the team works` });
  }
  return flags;
}

// "ACME TEXTILES LIMITED" -> "Acme Textiles Limited" (a name in capitals only; others are kept as filed).
const SMALL = new Set(["and", "of", "the", "for", "in", "on", "at", "to", "&"]);
export function companyLabel(name = "") {
  const s = String(name).trim();
  if (s !== s.toUpperCase()) return s;
  return s.split(/\s+/).map((w, i) => {
    const lower = w.toLowerCase();
    if (i > 0 && SMALL.has(lower)) return lower;
    if (/^\(?(PLC|LLP|LLC|UK|U\.K\.)\)?$/.test(w) || /[\d.]/.test(w) || w.replace(/[^A-Z]/g, "").length <= 2) return w;
    return lower.replace(/(^|[-(/'])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }).join(" ");
}
// The team the gift's message names: the company as people say it, deal vehicles dropped ("Falcon Topco" -> "Falcon").
export const teamName = (name = "") => naturalCompany(name).replace(/\s+(?:topco|bidco|midco|holdco)$/i, "").trim();

// The card's message: {first_name}, {team} and {owner_first} filled in; a missing first name stays as a placeholder.
export const DEFAULT_MESSAGE = "Dear {first_name},\n\nA little something from Investec Bank before the holidays — hopefully it makes a busy December a "
  + "little sweeter for you and the wider {team} team.\n\nLooking forward to hopefully catching up soon.\n\nBest wishes,\n{owner_first}";
export function fillMessage(template = DEFAULT_MESSAGE, { first = "", team = "", owner = "" } = {}) {
  return String(template || DEFAULT_MESSAGE)
    .replaceAll("{first_name}", first.trim() || "[First name]")
    .replaceAll("{team}", team.trim() || "[company]")
    .replaceAll("{owner_first}", owner.trim().split(/\s+/)[0] || "[your name]");
}

// The Cedar send outs sheet, column for column.
export const CEDAR_COLUMNS = [
  ["owner", "Owner (Sales Person)"], ["owner_email", "Owners email address"], ["owner_phone", "Owners telephone number"],
  ["first_name", "First Name"], ["last_name", "Last Name"], ["company_name", "Company Name"], ["address_1", "Address 1"],
  ["address_2", "Address 2"], ["postcode", "Postcode"], ["city", "City"], ["gift", "Gift"], ["message", "Message to be included"],
];
export function cedarRow(r, { owner = "", email = "", phone = "", gift = "", template = DEFAULT_MESSAGE, first = "", last = "", message = "" } = {}) {
  const a = splitAddress(r);
  return {
    owner, owner_email: email, owner_phone: phone, first_name: first.trim(), last_name: last.trim(),
    company_name: companyLabel(r.company_name), address_1: a.line1, address_2: a.line2, postcode: a.postcode, city: a.city, gift,
    message: message || fillMessage(template, { first, team: teamName(r.company_name), owner }),
  };
}
