// Helpers for the Accounts page: money, filters and CSV export over the
// finder's rows (lead-sourcer/tools/to_accounts_json.py).

export const CONFIDENCE = ["Verified", "Confirmed", "Likely", "Guess"];

// Mirrors lead-sourcer people.is_finance_director: runs the finance function, not a controller under them.
const FD_TITLE = /chief financ|\bcfo\b|financ(e|ial) director|finance (&|and) \w+ director|director of finance|head of finance|treasurer|head of treasury|\bfd\b/i;
export const isFinanceDirector = (title = "") => FD_TITLE.test(title);

export function money(value) {
  const n = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(n)) return "";
  const a = Math.abs(n), sign = n < 0 ? "−" : "";
  if (a >= 1e9) return `${sign}£${(a / 1e9).toFixed(1)}bn`;
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(1)}m`;
  if (a >= 1e3) return `${sign}£${Math.round(a / 1e3)}k`;
  return `${sign}£${Math.round(a)}`;
}

export const wallet = (r) =>
  r.fx_wallet_low_gbp || r.fx_wallet_high_gbp ? `${money(r.fx_wallet_low_gbp)}–${money(r.fx_wallet_high_gbp)}` : "";

export const parts = (value = "", sep = /\s*\|\s*/) => String(value).split(sep).map((s) => s.trim()).filter(Boolean);

// A named finance director the search or a registry stands behind.
export const hasConfirmedFd = (r) =>
  Boolean(r.finance_contact) && isFinanceDirector(r.finance_contact_role) &&
  ["Verified", "Confirmed"].includes(r.finance_contact_confidence);

// Older lists have no `qualified` column: every row counts as in.
export const isOut = (r) => r.qualified === "Out";

// "Check on Google": plain "<company> finance director", which shows who holds the job now.
export const shortCompany = (name = "") =>
  name.replace(/[\s,.]*\b(?:public limited company|limited|ltd|plc|llp)\.?\s*$/i, "").trim();
export const googleFd = (r) =>
  "https://www.google.com/search?" + new URLSearchParams({ q: `${shortCompany(r.company_name)} finance director` });

export function filterRows(rows, { section = "", query = "", confidence = "", fdOnly = false, pair = "", triggersOnly = false,
                                   showOut = false } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) =>
    (!section || r.section === section) &&
    (!confidence || (confidence === "none" ? !r.finance_contact : r.finance_contact_confidence === confidence)) &&
    (!fdOnly || hasConfirmedFd(r)) &&
    (!pair || parts(r.currency_pairs).includes(pair)) &&
    (!triggersOnly || Boolean(r.triggers)) &&
    (showOut || !isOut(r)) &&
    (!q || [r.company_name, r.finance_contact, r.fx_niche, r.main_bank, r.postcode, r.company_number]
      .some((v) => (v || "").toLowerCase().includes(q))));
}

export const SORTS = {
  rank: { label: "List order", key: (r) => r.rank },
  turnover: { label: "Turnover", key: (r) => -(Number(r.turnover_gbp) || 0) },
  wallet: { label: "FX wallet", key: (r) => -(Number(r.fx_wallet_high_gbp) || 0) },
  confidence: { label: "Contact confidence", key: (r) => (r.finance_contact ? CONFIDENCE.indexOf(r.finance_contact_confidence) : 9) * 10000 + r.rank },
};

export const sortRows = (rows, by = "rank") => [...rows].sort((a, b) => SORTS[by].key(a) - SORTS[by].key(b));

export const EXPORT_FIELDS = [
  "rank", "section", "qualified", "qualify_reason", "warm_route", "company_name", "company_number",
  "finance_contact", "finance_contact_role",
  "finance_contact_confidence", "finance_contact_linkedin", "search_check", "lead_director", "turnover_gbp",
  "fx_wallet_low_gbp", "fx_wallet_high_gbp", "currency_pairs", "import_currencies", "export_currencies",
  "main_bank", "bank_type", "fact_1", "fact_2", "main_currency", "currency_direction",
  "currency_evidence", "currency_confidence", "opener", "fx_estimate", "incumbent_bank", "facility_ends",
  "facility_ends_evidence", "fx_today", "fx_today_evidence", "lenders", "triggers", "when_to_call", "fx_niche", "call_angle",
  "website", "generic_emails",
  "companies_house_url",
];

export function toCsv(rows, fields = EXPORT_FIELDS) {
  const cell = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.join(","), ...rows.map((r) => fields.map((f) => cell(r[f])).join(","))].join("\n");
}
