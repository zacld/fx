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

// The finance contact's job role, most senior first. A finance title beats a general one ("Finance Director"
// is FD, not "Other director"); "Assistant Financial Controller" counts as a controller.
export const ROLES = [
  ["CFO / Finance Director", /chief financ|\bcfo\b|financ(e|ial) director|finance (&|and) \w+ director|director of finance|\bfd\b|finance partner/i],
  ["Head of Finance / Treasurer", /head of (finance|treasury)|treasurer|vp,? finance|vice president,? finance|finance lead|treasury manager/i],
  ["Financial Controller", /controller|comptroller/i],
  ["Finance Manager", /financ(e|ial) manager|accounts manager|head of accounts|finance business partner/i],
  ["Accountant", /accountant|accounts|bookkeep|finance (officer|assistant|analyst)/i],
  ["Other director", /director|\bceo\b|chief executive|\bmd\b|chair|owner|founder|partner|secretary/i],
];
export const ROLE_GROUPS = [...ROLES.map(([label]) => label), "Other role", "No one named"];
export function roleGroup(r) {
  if (!r.finance_contact) return "No one named";
  return ROLES.find(([, re]) => re.test(r.finance_contact_role || ""))?.[0] || "Other role";
}

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
                                   contacted = {}, notes = {}, role = "" } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) =>
    (view === "contacted") === Boolean(contacted[r.company_number]) &&
    (!section || r.section === section) &&
    (!contact || contactGroup(r) === contact) &&
    (!role || roleGroup(r) === role) &&
    (!newOnly || isNew(r, madeAt)) &&
    (!fxLossOnly || Boolean(r.recent_fx_loss)) &&
    (!fdOnly || hasConfirmedFd(r)) &&
    (!pair || parts(r.currency_pairs).includes(pair)) &&
    (!triggersOnly || Boolean(r.triggers)) &&
    (showOut || !isOut(r)) &&
    (!q || [r.company_name, r.finance_contact, r.fx_niche, r.main_bank, r.postcode, r.company_number, notes[r.company_number]?.text]
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

// A company's own page: /accounts/<company number> (Netlify serves accounts.html for it).
export const companyPath = (number) => `/accounts/${number}`;
export const numberFromPath = (path = "") => (path.match(/^\/accounts\/([A-Z0-9]{8})\/?$/i) || [])[1]?.toUpperCase() || "";

// Everything known about a company, in sections of [label, value, source link]; empty values left out.
export function detailSections(r) {
  const join = (...xs) => xs.filter(Boolean).join(" — ");
  return [
    ["Banking", [
      ["Main bank", join(r.main_bank, r.bank_type), bankUrl(r)], ["Incumbent bank", r.incumbent_bank, r.incumbent_bank_url],
      ["Facility ends", r.facility_ends_evidence || r.facility_ends, r.accounts_url], ["FX today", r.fx_today_evidence, r.fx_today_url],
      ["Lenders", r.lenders], ["Banking", r.banking_relationships], ["Existing client", r.own_bank_client],
    ]],
    ["FX exposure", [
      ["FX gain/loss", fxLine(r), r.fx_gain_loss_url], ["Recent FX loss", r.recent_fx_loss, r.fx_gain_loss_url],
      ["FX figure to check", r.fx_gain_loss_check, r.fx_gain_loss_url], ["FX line in the accounts", r.fx_gain_loss_evidence, r.fx_gain_loss_url],
      ["FX size", r.fx_estimate], ["Wallet basis", r.fx_wallet_basis],
      ["Main currency", [r.main_currency, r.currency_direction, r.currency_confidence && `${r.currency_confidence} confidence`].filter(Boolean).join(" · ")],
      ["Currency evidence", r.currency_evidence], ["Imports in", r.import_currencies], ["Exports in", r.export_currencies],
      ["Trade", r.trade_countries], ["Customs goods", r.hmrc_goods], ["Why FX", r.fx_evidence], ["Niche", r.fx_niche],
      ["Exposure", r.fx_exposure], ["Why untapped", r.untapped_reasons],
    ]],
    ["People", [
      ["Contact source", r.finance_contact_source], ["Probably no FD", r.no_fd_likely], ["Contact evidence", r.finance_contact_evidence], ["Search check", r.search_check],
      ["Lead director", join(r.lead_director, r.lead_director_occupation)], ["Directors", r.all_directors],
      ["Company secretary", r.company_secretary], ["Signed accounts", r.accounts_signed_by], ["Owners", r.owners],
      ["Group", r.group_parent], ["Parent's finance contact", r.parent_finance_contact],
    ]],
    ["Company", [
      ["Accounts", r.size_basis, r.accounts_url], ["Accounts filed", r.accounts_filed_on, r.accounts_url],
      ["Growth", r.turnover_growth, r.accounts_url], ["Overseas sales", r.overseas_turnover_share, r.accounts_url],
      ["Cash / borrowings", [money(r.cash_gbp), money(r.bank_borrowings_gbp)].filter(Boolean).join(" / "), r.accounts_url],
      ["Net assets", money(r.net_assets_gbp), r.accounts_url], ["Auditor", join(r.auditor, r.auditor_tier)],
      ["Qualified", join(r.qualified, r.qualify_reason)], ["Warm route", r.warm_route], ["Triggers", r.triggers],
      ["When to call", r.when_to_call], ["Generic emails", r.generic_emails], ["Address", r.registered_address],
      ["SIC codes", r.sic_codes], ["Incorporated", r.incorporated_on],
    ]],
  ].map(([title, rows]) => [title, rows.filter(([, v]) => v)]).filter(([, rows]) => rows.length);
}

// The public records behind the facts, each once: the accounts (and its FX page), the charges, the register.
export function sourceDocuments(r) {
  const ch = r.companies_house_url || "";
  const docs = [
    ["Latest filed accounts", r.accounts_url], ["Accounts at the FX line", r.fx_gain_loss_url],
    [`Charge: ${r.main_bank || "bank"}`, r.incumbent_bank_url], ["FX provider's charge", r.fx_today_url],
    ["Companies House record", ch], ["Filing history", ch && `${ch}/filing-history`], ["Charges register", ch && `${ch}/charges`],
    ["Officers", ch && `${ch}/officers`], ["Owners (PSCs)", ch && `${ch}/persons-with-significant-control`],
  ];
  const seen = new Set();
  return docs.filter(([, url]) => url && !seen.has(url) && seen.add(url));
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
  // Most senior finance role first (CFO/FD, head of finance, controller, manager…); within a role, hottest first.
  role: { label: "Job role (CFO/FD first)", key: (r) => ROLE_GROUPS.indexOf(roleGroup(r)) * 1e7 + SORTS.hot.key(r) },
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
  "finance_contact_confidence", "finance_contact_linkedin", "search_check", "no_fd_likely", "lead_director", "turnover_gbp",
  "fx_wallet_low_gbp", "fx_wallet_high_gbp", "currency_pairs", "import_currencies", "export_currencies",
  "fx_gain_loss_gbp", "fx_gain_loss_prior_gbp", "fx_gain_loss_check", "recent_fx_loss", "accounts_filed_on", "first_seen",
  "main_bank", "bank_type", "fact_1", "fact_2", "main_currency", "currency_direction",
  "currency_evidence", "currency_confidence", "opener", "fx_estimate", "incumbent_bank", "facility_ends",
  "facility_ends_evidence", "fx_today", "fx_today_evidence", "lenders", "triggers", "when_to_call", "fx_niche", "call_angle",
  "website", "generic_emails", "notes", "accounts_url", "fx_gain_loss_url", "incumbent_bank_url",
  "companies_house_url",
];

export function toCsv(rows, fields = EXPORT_FIELDS) {
  const cell = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.join(","), ...rows.map((r) => fields.map((f) => cell(r[f])).join(","))].join("\n");
}
