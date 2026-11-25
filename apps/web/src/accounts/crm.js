// For CRM (Zac, 24 Nov 2026: "in the notes section of each company have a separate one which says for CRM and our notes
// but no hyperlinks etc, who they bank with, all useful info"): plain text to paste into the bank's CRM, built only from
// its public records (the facts the page shows): no links, no web addresses, nothing from the CRM. A fact the records
// don't give is left out.
//   crmNote   — the summary (Zac, 25 Nov 2026: "way more summarised, because that's what I'm gonna be reading"): who it
//               is, its size and owner on one line, then a line each for the bank, the FX, why now, the contact and what
//               to pitch, then his own note.
//   crmDetail — everything, a "Label: value" line a fact (the "Full detail" button).
import { pitchFor, pitchLine } from "./pitch.js";
import { filedIso, filedLabel, filedWhen, financeSeat, fxSizeLine, fxSizeOf, groupActivity, growthPct, industryOf, INDUSTRY_OTHER, money, ownership,
  parts, peBackedOf, presentedContact, sicCodes, tellingSicCodes, timelyReason } from "./format.js";
import { SIC_NAMES } from "./sic.js";

// What the register says it does, in its own words (UK SIC 2007): its telling sector codes, at most two — not head office,
// holding company, dormant or a catch-all when it has another — and a holding company's from its trading subsidiaries
// (Zac, 24 Nov 2026: the industry groups were wrong here; the register's words leave nothing to map).
export function registeredActivity(r = {}, max = 2) {
  const group = groupActivity(r);
  const named = tellingSicCodes(group?.sic || sicCodes(r)).slice(0, max).map((c) => {
    const k = String(c).padStart(5, "0");
    return SIC_NAMES[k] ? `${SIC_NAMES[k]} (SIC ${k})` : `SIC ${k}`;
  });
  return !named.length ? "" : group ? `holding company - its group trades in ${named.join("; ")}` : named.join("; ");
}

const LINK = /\b(?:https?:\/\/|www\.)\S+/gi;
// one line of plain text: no links, no "(Companies House charges register)" source tags, no line breaks
export const plain = (t) => String(t ?? "").replace(LINK, "").replace(/\s*\((?:Companies House )?charges register\)/gi, "")
  .replace(/\s+/g, " ").trim();
const cut = (t, n = 160) => { const s = plain(t); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };
const upper1 = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const lower1 = (t) => (/^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t);   // "Uses forwards" → "uses forwards"; "USD" stays
const end = (t) => (/[.…!?]$/.test(t) ? t : `${t}.`);

// The bank's other names on the register ("NatWest" holds charges as National Westminster, Royal Bank of Scotland,
// Lombard …: sourcer/banks.py), so it isn't listed again among the other lenders.
const BANK_ALIASES = {
  natwest: /NATWEST|NATIONAL WESTMINSTER|ROYAL BANK OF SCOTLAND|LOMBARD NORTH CENTRAL|ULSTER BANK|COUTTS/i,
  lloyds: /LLOYDS|HALIFAX|^(?:THE )?(?:GOVERNOR AND COMPANY OF THE )?BANK OF SCOTLAND/i,   // not "Royal Bank of Scotland" (NatWest)
  "virgin money": /VIRGIN MONEY|CLYDESDALE|YORKSHIRE BANK/i,
  citi: /CITIBANK|CITIGROUP/i, jpmorgan: /J\.?\s?P\.?\s?MORGAN/i, aib: /ALLIED IRISH|AIB GROUP/i,
  smbc: /SUMITOMO|SMBC/i, icbc: /INDUSTRIAL AND COMMERCIAL BANK OF CHINA|ICBC/i,
};
export const sameBank = (name = "", bank = "") => {
  const b = String(bank).trim().toLowerCase();
  return Boolean(b) && (String(name).toLowerCase().startsWith(b) || Boolean(BANK_ALIASES[b]?.test(name)));
};
// "CLOSE BROTHERS LIMITED: asset finance, registered 3 Oct 2026 | …" → ["CLOSE BROTHERS LIMITED (asset finance)", …]
function lenderList(lenders, bankName = "") {
  const seen = new Set();
  return String(lenders || "").split(/\s*\|\s*|;\s*/).map(plain).filter(Boolean).flatMap((x) => {
    const at = x.indexOf(":");
    const name = (at < 0 ? x : x.slice(0, at)).trim(), kind = at < 0 ? "" : x.slice(at + 1).split(",")[0].trim();
    if (!name || seen.has(name.toLowerCase()) || sameBank(name, bankName)) return [];
    seen.add(name.toLowerCase());
    return [`${name}${kind && kind !== "type not stated" ? ` (${kind})` : ""}`];
  });
}
// "United States (US), France (FR)" → "United States, France"
const countriesOf = (t) => {
  const all = plain(t).split(/\s*,\s*/).map((c) => c.replace(/\s*\([A-Z]{2,3}\)$/, "")).filter(Boolean);
  return all.length > 3 ? `${all.slice(0, 3).join(", ")} and ${all.length - 3} more` : all.join(", ");
};
const priorOf = (r) => (r.fx_gain_loss_prior_gbp === undefined || r.fx_gain_loss_prior_gbp === null || r.fx_gain_loss_prior_gbp === ""
  ? NaN : Number(r.fx_gain_loss_prior_gbp));

// The summary: a few short lines, the ones a banker reads first.
export function crmNote(r = {}, { note = "" } = {}) {
  const lines = [`${plain(r.company_name)}${r.company_number ? ` (CH ${r.company_number})` : ""}`];
  const line = (label, parts) => { const v = parts.map(plain).filter(Boolean).join("; "); if (v) lines.push(end(label ? `${label}: ${upper1(v)}` : upper1(v))); };
  const f = r.lead_flags || {};
  // 1. what it does, how big, who owns it
  const industry = industryOf(r);
  const what = registeredActivity(r, 1) || (industry === INDUSTRY_OTHER ? "" : industry);
  const t = Number(r.turnover_gbp) || 0, tf = Number(r.turnover_foreign_gbp) || 0, g = growthPct(r);
  const grew = Number.isFinite(g) && Math.round(g) ? ` (${g > 0 ? "up" : "down"} ${Math.abs(Math.round(g))}%)` : "";
  const size = t ? `${money(t)}${r.turnover_basis === "group" ? " group" : ""} turnover${grew}`
    : tf ? `about ${money(tf)} turnover (accounts in ${String(r.reporting_currency || "").slice(0, 3) || "another currency"})${grew}`
      : r.size_estimate ? `turnover ${plain(r.size_estimate)} (estimate)` : "";
  const staff = Number(r.employees) ? `${Number(r.employees).toLocaleString("en-GB")} staff` : "";
  const own = ownership(r);
  const seat = own.status === "foreign" ? { uk: "decides FX in the UK", abroad: "FX likely run from abroad", unclear: "ask where FX is decided" }[financeSeat(r).lean] : "";
  const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  const owner = own.status === "uk" ? `UK-owned${own.owner && !same(own.owner, r.company_name) ? ` (part of ${own.owner})` : ""}`
    : own.status === "foreign" ? `owned from ${own.country || "abroad"}${own.owner ? ` (${own.owner})` : ""}${seat ? `, ${seat}` : ""}`
      : own.owner ? `owner ${own.owner} (where it's based not known yet)` : "";
  const pe = peBackedOf(r);
  const who = [upper1(plain(what)), [size, staff].filter(Boolean).join(", "), [owner, pe ? (same(pe.name, own.owner) || !pe.name ? "PE-backed" : `PE-backed (${pe.name})`) : ""].filter(Boolean).join(", ")]
    .map((x) => upper1(plain(x))).filter(Boolean);
  if (who.length) lines.push(who.map(end).join(" "));
  // 2. who it banks with
  const bankName = plain(r.incumbent_bank).split(":")[0].trim();
  const since = (plain(r.incumbent_bank).match(/since\s+(?:\d{1,2}\s+)?([A-Za-z]{3,9}\.?\s+\d{4})/) || [])[1];
  const bank = bankName ? `${bankName}${since ? ` (debenture since ${since})` : ""}`
    + `${r.main_bank && !sameBank(bankName, r.main_bank) && !sameBank(String(r.main_bank), bankName) ? `, its accounts name ${plain(r.main_bank)} as bankers` : ""}`
    : r.main_bank ? `${plain(r.main_bank)} (named in its accounts)` : "";
  const others = lenderList(r.lenders, bankName).slice(0, 2);
  const money2 = [r.facility_ends && `facility ends ${plain(r.facility_ends)}`, Number(r.bank_borrowings_gbp) && `borrowing ${money(r.bank_borrowings_gbp)}`,
    Number(r.cash_gbp) && `cash ${money(r.cash_gbp)}`].filter(Boolean).join(", ");
  if (bank) line("Bank", [bank, others.length ? `also ${others.join(", ")}` : "", money2]);
  else if (others.length) line("Lenders", [others.join(", "), money2]);   // no bank holds its debenture or is named as bankers
  else line("Money", [money2]);
  // 3. its FX: the loss, the currency, sales abroad, hedging — then the rest, briefly
  const fx = [];
  const loss = -Number(r.fx_gain_loss_gbp) || 0, prior = priorOf(r), filed = filedIso(r);
  const after = !Number.isFinite(prior) || !prior ? "" : prior > 0 ? `, after a ${money(prior)} gain` : `, after a ${money(-prior)} loss`;
  const when = filed ? ` in accounts filed ${filedWhen(filed).replace(/^\d{1,2} /, "")}` : "";   // "Sept 2026"
  if (loss >= 1000) fx.push(`${money(loss)} loss${when}${after}`);
  else if (-loss >= 1000) fx.push(`${money(-loss)} gain${when}${after}`);
  const cur = r.main_currency && !/niche default/.test(r.currency_source || "") ? r.main_currency : "";
  const dir = String(r.currency_direction || "");
  if (cur) fx.push(/^Buys/.test(dir) ? `pays suppliers in ${cur}` : /^Sells/.test(dir) ? `sells in ${cur}` : /^Both/.test(dir) ? `buys and sells in ${cur}` : `main currency ${cur}`);
  else if (r.currencies_in_accounts) fx.push(`currencies ${cut(r.currencies_in_accounts, 50)}`);
  if (r.overseas_turnover_share) fx.push(`${plain(r.overseas_turnover_share)} of sales abroad`);
  const exposed = fx.length > 0;
  if (r.fx_forwards) fx.push(`uses forward contracts (${cut(r.fx_forwards, 50)})`);
  else if (/^Uses\b/.test(r.fx_today || "")) fx.push(lower1(cut(r.fx_today, 60)));
  else if (/^Doesn't hedge|^Natural hedge/.test(r.fx_today || "")) fx.push(`${lower1(plain(r.fx_today))} (its accounts say)`);
  else if (exposed) fx.push("no hedging named");
  if (r.reporting_currency) fx.push(`accounts kept in ${String(r.reporting_currency).slice(0, 3)}`);
  if (r.subsidiaries_abroad) fx.push(`subsidiaries in ${countriesOf(r.subsidiaries_abroad)}`);
  if (r.fx_borrowings) fx.push("borrows in another currency");
  if (!exposed) {
    const customs = r.hmrc_trade ? cut(String(r.hmrc_trade).replace(/^HMRC customs records:\s*/i, "").replace(/\s*\(matched[^)]*\)\s*$/, ""), 80)
      : [Number(r.hmrc_import_months) && `imports in ${r.hmrc_import_months} of the last 12 months`,
        Number(r.hmrc_export_months) && `exports in ${r.hmrc_export_months}`].filter(Boolean).join(", ");
    if (customs) fx.push(`customs records show ${customs}`);
  }
  // its FX a year, the desk's measure (Zac, 25 Nov 2026: £5m+ FX, not turnover) — the finder's estimate, first
  const perYear = fxSizeOf(r);
  if (perYear?.wallet) fx.unshift(`about ${fxSizeLine(perYear)} a year (estimate)`);
  line("FX", fx);
  // 4. why now (the FX loss is already above), 5. who to speak to, 6. what to pitch
  const why = [];
  if (f.moment) why.push(cut(f.moment, 80));
  if (f.newFd) why.push(cut(f.fdWhy || "new finance director", 90));
  else if (r.new_fd_in_accounts) why.push(`new finance director in its accounts: ${cut(r.new_fd_in_accounts, 60)}`);
  if (r.acquisitions || f.buying) why.push(`buying companies${r.acquisitions ? ` (${cut(r.acquisitions, 60)})` : ""}`);
  if (f.pe) why.push("private-equity deal");
  if (f.funded) why.push("just raised funding");
  if (!why.length && parts(r.triggers)[0]) why.push(cut(parts(r.triggers)[0], 90));
  line("Why now", [...new Set(why)].slice(0, 2).map(lower1));
  if (presentedContact(r)) line("Contact", [`${r.finance_contact}${r.finance_contact_role ? `, ${r.finance_contact_role}` : ""}`
    + `${r.finance_contact_confidence ? ` (${r.finance_contact_confidence})` : ""}`]);
  const pitch = pitchFor(r).slice(0, 3).map((p) => p.name.split(" — ")[0]);
  if (pitch.length) lines.push(end(`Pitch: ${pitch.join(", ")}`));
  const own_note = String(note || "").replace(LINK, "").replace(/[ \t]{2,}/g, " ").trim();
  if (own_note) lines.push("", `Our notes: ${own_note}`);
  return lines.join("\n");
}

// Everything: a "Label: value" line a fact.
export function crmDetail(r = {}, { note = "", today = new Date() } = {}) {
  const lines = [`${plain(r.company_name)}${r.company_number ? ` (Companies House ${r.company_number})` : ""}`];
  const add = (label, value) => { const v = plain(value); if (v) lines.push(`${label}: ${v}`); };
  const f = r.lead_flags || {};
  // who it is
  const industry = industryOf(r);
  add("Industry", registeredActivity(r) || (industry === INDUSTRY_OTHER ? "" : industry));
  const t = Number(r.turnover_gbp) || 0, tf = Number(r.turnover_foreign_gbp) || 0, g = growthPct(r);
  const grew = Number.isFinite(g) && Math.round(g) ? `, ${g > 0 ? "up" : "down"} ${Math.abs(Math.round(g))}% on the year before` : "";
  if (t) add("Turnover", `${money(t)}${r.turnover_basis === "group" ? " (the group's)" : ""}${grew}`);
  else if (tf) add("Turnover", `about ${money(tf)} (accounts in ${String(r.reporting_currency || "").slice(0, 3) || "another currency"})${grew}`);
  else add("Size", r.size_estimate);
  add("Employees", Number(r.employees) ? Number(r.employees).toLocaleString("en-GB") : "");
  const filed = filedIso(r);
  add("Latest accounts filed", filed ? filedLabel(r) : "");
  // who it banks with
  const bank = plain(r.incumbent_bank);
  const bankName = bank.split(":")[0].trim();
  if (bank) {
    const terms = bank.slice(bankName.length).replace(/^:\s*/, "");
    add("Bank", `${bankName}${r.bank_type ? ` (${r.bank_type})` : ""}${terms ? ` - ${terms}` : ""}`);
  }
  else if (r.main_bank) add("Bank", `${r.main_bank}${r.bank_type ? ` (${r.bank_type})` : ""} - named in its accounts`);
  if (bank && r.main_bank && !bankName.toLowerCase().includes(String(r.main_bank).toLowerCase().split(/\s+/)[0])) add("Bankers named in its accounts", r.main_bank);
  const others = String(r.lenders || "").split(/\s*\|\s*|;\s*/).map(plain)
    .filter((x) => x && !sameBank(x, bankName)).slice(0, 3);
  add("Other lenders", others.join("; "));
  add("Facility ends", r.facility_ends);
  add("Bank borrowing", Number(r.bank_borrowings_gbp) ? money(r.bank_borrowings_gbp) : cut(r.bank_debt, 100));
  add("Cash", Number(r.cash_gbp) ? money(r.cash_gbp) : "");
  // its FX
  const loss = -Number(r.fx_gain_loss_gbp) || 0;
  const prior = r.fx_gain_loss_prior_gbp === undefined || r.fx_gain_loss_prior_gbp === null || r.fx_gain_loss_prior_gbp === "" ? NaN : Number(r.fx_gain_loss_prior_gbp);
  const before = !Number.isFinite(prior) || !prior ? "" : prior > 0 ? ` (a ${money(prior)} gain the year before)` : ` (a ${money(-prior)} loss the year before)`;
  const inAccounts = filed ? ` in the accounts filed ${filedLabel(r)}` : "";
  if (loss >= 1000) add("FX loss", `${money(loss)}${inAccounts}${before}`);
  else if (-loss >= 1000) add("FX gain", `${money(-loss)}${inAccounts}${before}`);
  const cur = r.main_currency && !/niche default/.test(r.currency_source || "") ? r.main_currency : "";
  const dir = String(r.currency_direction || "");
  if (cur) add("Main currency", `${cur}${/^Buys/.test(dir) ? " (pays suppliers)" : /^Sells/.test(dir) ? " (sells)" : /^Both/.test(dir) ? " (buys and sells)" : ""}`
    + `${r.currency_source ? ` - from ${r.currency_source}` : ""}`);
  add("Currencies in its accounts", cut(r.currencies_in_accounts, 120));
  add("Sales abroad", r.overseas_turnover_share ? `${r.overseas_turnover_share}${r.turnover_regions ? ` (${cut(r.turnover_regions, 100)})` : ""}` : cut(r.turnover_regions, 120));
  const exposed = loss >= 1000 || cur || r.currencies_in_accounts || r.overseas_turnover_share;
  add("Hedging", r.fx_forwards ? `forward contracts - ${cut(r.fx_forwards, 100)}` : /^Uses\b/.test(r.fx_today || "") ? cut(r.fx_today, 100)
    : exposed ? "none named in its accounts" : "");
  add("FX sensitivity", cut(r.fx_sensitivity, 140));
  add("Foreign-currency balances", cut(r.fx_balances, 120));
  add("Accounts kept in", r.reporting_currency ? String(r.reporting_currency).slice(0, 3) : "");
  add("Borrowing in another currency", cut(r.fx_borrowings, 120));
  add("Subsidiaries abroad", cut(r.subsidiaries_abroad, 140));
  add("Customs", cut(r.hmrc_trade, 120));
  const perYear = fxSizeOf(r);
  if (perYear?.wallet) add("FX a year (estimate)", `${fxSizeLine(perYear)}${perYear.basis ? ` - ${cut(perYear.basis, 120)}` : ""}`);
  // who owns it
  const own = ownership(r);
  add("Owner", own.status === "uk" ? `UK-owned${own.owner && own.owner !== r.company_name ? ` (top parent: ${own.owner})` : ""}`
    : own.status === "foreign" ? `owned from ${own.country || "abroad"}${own.owner ? ` by ${own.owner}` : ""}`
      : own.owner ? `${own.owner} (where it's based not known yet)` : "");
  if ((own.chain || []).length > 2) add("Ownership chain", own.chain.join(" > "));
  const pe = peBackedOf(r);
  if (pe) add("Private equity", pe.name);
  if (own.status === "foreign") add("Where FX is decided", financeSeat(r).verdict);
  // who to speak to, why now, what to pitch
  if (presentedContact(r)) add("Finance contact", `${r.finance_contact}${r.finance_contact_role ? `, ${r.finance_contact_role}` : ""}`
    + `${r.finance_contact_confidence ? ` (${r.finance_contact_confidence})` : ""}`);
  const fd = String(f.fdWhy || "");
  if (f.newFd && /^Hiring/i.test(fd)) add("Hiring", fd);
  else if (f.newFd) add("New finance director", fd.replace(/^New finance director:?\s*/i, "").replace(/^\((.*)\)$/, "$1") || "named in the last few months");
  else if (r.new_fd_in_accounts) add("New finance director", `${r.new_fd_in_accounts} (per its accounts)`);
  add("Auditor", r.auditor);
  if (r.acquisitions || f.buying) add("Buying companies", cut(r.acquisitions || "yes - in the ownership register", 140));
  const why = timelyReason(r);
  if (why && !/^FX loss of/.test(why) && why !== fd && !/^Buying companies/.test(why)) add("Why now", cut(why, 140));
  add("What to pitch", pitchLine(r));
  add("Source", `public records (Companies House accounts and charges register), ${today.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
  const own_note = String(note || "").replace(LINK, "").replace(/[ \t]{2,}/g, " ").trim();
  if (own_note) lines.push("", `Our notes: ${own_note}`);
  return lines.join("\n");
}
