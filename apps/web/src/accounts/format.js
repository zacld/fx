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

// Who to ask for: a finance contact a search or registry stands behind (Verified/Confirmed), one worked out from
// weaker clues (Likely/Guess), or nobody named yet.
export const CONTACT_GROUPS = ["Confirmed", "Guess", "No one named"];
export const contactGroup = (r) =>
  !r.finance_contact ? "No one named" : ["Verified", "Confirmed"].includes(r.finance_contact_confidence) ? "Confirmed" : "Guess";

// Added by the latest scan: the finder's upload keeps when each company first appeared (first_seen).
export const isNew = (r, madeAt) => Boolean(madeAt) && r.first_seen === madeAt;

// "Check on Google": plain "<company> finance director", which shows who holds the job now.
export const shortCompany = (name = "") =>
  name.replace(/[\s,.]*\b(?:public limited company|limited|ltd|plc|llp)\.?\s*$/i, "").trim();
export const googleFd = (r) =>
  "https://www.google.com/search?" + new URLSearchParams({ q: `${shortCompany(r.company_name)} finance director` });

// view "contacted" shows only the companies marked contacted; otherwise they are left out of the list.
export function filterRows(rows, { section = "", query = "", contact = "", fdOnly = false, pair = "", triggersOnly = false,
                                   showOut = false, newOnly = false, fxLossOnly = false, madeAt = "", view = "",
                                   contacted = {} } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) =>
    (view === "contacted") === Boolean(contacted[r.company_number]) &&
    (!section || r.section === section) &&
    (!contact || contactGroup(r) === contact) &&
    (!newOnly || isNew(r, madeAt)) &&
    (!fxLossOnly || Boolean(r.recent_fx_loss)) &&
    (!fdOnly || hasConfirmedFd(r)) &&
    (!pair || parts(r.currency_pairs).includes(pair)) &&
    (!triggersOnly || Boolean(r.triggers)) &&
    (showOut || !isOut(r)) &&
    (!q || [r.company_name, r.finance_contact, r.fx_niche, r.main_bank, r.postcode, r.company_number]
      .some((v) => (v || "").toLowerCase().includes(q))));
}

// FX gain/loss as a share of turnover ("0.8% of turnover"); "" without both figures.
export function fxShare(r) {
  const fx = Number(r.fx_gain_loss_gbp), t = Number(r.turnover_gbp);
  if (!r.fx_gain_loss_gbp || !Number.isFinite(fx) || !(t > 0)) return "";
  const pct = (Math.abs(fx) / t) * 100;
  return `${pct < 0.1 ? "<0.1" : pct.toFixed(1)}% of turnover`;
}

export const fxLine = (r) => r.fx_gain_loss_gbp
  ? `${money(r.fx_gain_loss_gbp)} ${Number(r.fx_gain_loss_gbp) < 0 ? "loss" : "gain"}` +
    ` (${[fxShare(r), `prior year ${money(r.fx_gain_loss_prior_gbp) || "n/a"}`].filter(Boolean).join("; ")})`
  : "";

// Where each fact came from, as a public Companies House page: the filed accounts (at the FX line's page when
// known) or the charge on the register. Lists made before the links existed have none: no link is shown.
export const bankUrl = (r) =>
  r.incumbent_bank && r.main_bank && r.incumbent_bank.toLowerCase().startsWith(r.main_bank.toLowerCase())
    ? r.incumbent_bank_url || r.accounts_url : r.accounts_url;

// A headline fact links to the record it is about: FX figures to the accounts' FX line, charges and debentures to
// the register, anything else from the accounts to the accounts.
export function factUrl(r, fact = "") {
  if (/\bFX\b|exchange|currency/i.test(fact) && r.fx_gain_loss_url) return r.fx_gain_loss_url;
  if (/debenture|charge|lender|refinanc|security/i.test(fact) && r.incumbent_bank_url) return r.incumbent_bank_url;
  if (/accounts|facility|turnover|grew|growth|filed/i.test(fact)) return r.accounts_url || "";
  return "";
}

// Biggest FX loss first, then gains (biggest first), then no figure.
const fxLossKey = (r) => {
  const fx = Number(r.fx_gain_loss_gbp);
  if (!r.fx_gain_loss_gbp || !Number.isFinite(fx)) return 4e15;
  return fx < 0 ? fx : 2e15 - fx;
};

// "Hottest": confirmed contacts first, then guesses, then no one named; within each, the finder's ranking
// (FX evidence + untapped + triggers + a recent FX loss).
export const SORTS = {
  hot: { label: "Hottest (confirmed first)", key: (r) => CONTACT_GROUPS.indexOf(contactGroup(r)) * 1e6 + r.rank },
  rank: { label: "Our score", key: (r) => r.rank },
  turnover: { label: "Turnover", key: (r) => -(Number(r.turnover_gbp) || 0) },
  wallet: { label: "FX wallet", key: (r) => -(Number(r.fx_wallet_high_gbp) || 0) },
  fxLoss: { label: "Largest FX loss", key: fxLossKey },
  confidence: { label: "Contact confidence", key: (r) => (r.finance_contact ? CONFIDENCE.indexOf(r.finance_contact_confidence) : 9) * 10000 + r.rank },
};

export const sortRows = (rows, by = "hot") =>
  [...rows].sort((a, b) => SORTS[by].key(a) - SORTS[by].key(b) || a.rank - b.rank);

// The contacted list: most recently contacted first.
export const sortContacted = (rows, contacted = {}) =>
  [...rows].sort((a, b) => (contacted[b.company_number]?.at || "").localeCompare(contacted[a.company_number]?.at || "") || a.rank - b.rank);

export const EXPORT_FIELDS = [
  "rank", "section", "qualified", "qualify_reason", "warm_route", "company_name", "company_number",
  "finance_contact", "finance_contact_role",
  "finance_contact_confidence", "finance_contact_linkedin", "search_check", "lead_director", "turnover_gbp",
  "fx_wallet_low_gbp", "fx_wallet_high_gbp", "currency_pairs", "import_currencies", "export_currencies",
  "fx_gain_loss_gbp", "fx_gain_loss_prior_gbp", "fx_gain_loss_check", "recent_fx_loss", "accounts_filed_on", "first_seen",
  "main_bank", "bank_type", "fact_1", "fact_2", "main_currency", "currency_direction",
  "currency_evidence", "currency_confidence", "opener", "fx_estimate", "incumbent_bank", "facility_ends",
  "facility_ends_evidence", "fx_today", "fx_today_evidence", "lenders", "triggers", "when_to_call", "fx_niche", "call_angle",
  "website", "generic_emails", "accounts_url", "fx_gain_loss_url", "incumbent_bank_url",
  "companies_house_url",
];

export function toCsv(rows, fields = EXPORT_FIELDS) {
  const cell = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.join(","), ...rows.map((r) => fields.map((f) => cell(r[f])).join(","))].join("\n");
}
