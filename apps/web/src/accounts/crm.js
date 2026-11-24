// For CRM (Zac, 24 Nov 2026: "in the notes section of each company have a separate one which says for CRM and our notes
// but no hyperlinks etc, who they bank with, all useful info"): one plain-text note to paste into the bank's CRM — who
// the company is, who it banks with and its other lenders, the FX facts, who owns it, who to speak to, why now and what
// to pitch, then his own note — built only from its public records (the facts the page shows): no links, no web
// addresses, nothing from the CRM. "Label: value" lines; a fact the records don't give is left out.
import { pitchLine } from "./pitch.js";
import { filedIso, filedWhen, financeSeat, groupActivity, growthPct, industryOf, INDUSTRY_OTHER, money, ownership, peBackedOf, presentedContact,
  sicCodes, tellingSicCodes, timelyReason } from "./format.js";
import { SIC_NAMES } from "./sic.js";

// What the register says it does, in its own words (UK SIC 2007): its telling sector codes, at most two — not head office,
// holding company, dormant or a catch-all when it has another — and a holding company's from its trading subsidiaries
// (Zac, 24 Nov 2026: the industry groups were wrong here; the register's words leave nothing to map).
export function registeredActivity(r = {}) {
  const group = groupActivity(r);
  const named = tellingSicCodes(group?.sic || sicCodes(r)).slice(0, 2).map((c) => {
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

export function crmNote(r = {}, { note = "", today = new Date() } = {}) {
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
  add("Latest accounts filed", filed ? filedWhen(filed) : "");
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
    .filter((x) => x && !(bankName && x.toLowerCase().startsWith(bankName.toLowerCase()))).slice(0, 3);
  add("Other lenders", others.join("; "));
  add("Facility ends", r.facility_ends);
  add("Bank borrowing", Number(r.bank_borrowings_gbp) ? money(r.bank_borrowings_gbp) : cut(r.bank_debt, 100));
  add("Cash", Number(r.cash_gbp) ? money(r.cash_gbp) : "");
  // its FX
  const loss = -Number(r.fx_gain_loss_gbp) || 0;
  const prior = r.fx_gain_loss_prior_gbp === undefined || r.fx_gain_loss_prior_gbp === null || r.fx_gain_loss_prior_gbp === "" ? NaN : Number(r.fx_gain_loss_prior_gbp);
  const before = !Number.isFinite(prior) || !prior ? "" : prior > 0 ? ` (a ${money(prior)} gain the year before)` : ` (a ${money(-prior)} loss the year before)`;
  const inAccounts = filed ? ` in the accounts filed ${filedWhen(filed)}` : "";
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
