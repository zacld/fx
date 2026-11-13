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

// A finance contact we can put a name to: a finance title says so (Verified/Confirmed) or a qualified accountant /
// "Accountant" on the board (Likely). A Guess — a company secretary or accounts signatory alone, or a pick a registry
// or search contradicts — is never presented as the contact: it's a research clue (lists before the finder stopped
// picking them still carry a few).
export const presentedContact = (r) => Boolean(r.finance_contact) && r.finance_contact_confidence !== "Guess";
export const contactClues = (r) => [
  ...(r.finance_contact && !presentedContact(r)
    ? [`${r.finance_contact}${r.finance_contact_role ? ` (${r.finance_contact_role})` : ""} — not confirmed`] : []),
  ...parts(r.finance_contact_clues),
];
// Who to ask for when nobody is confirmed: the MD where the company probably has no FD, else the Finance Director.
export const askFor = (r) => (r.no_fd_likely ? "Ask for the Managing Director" : "Ask for the Finance Director");

// Who to ask for: a finance contact a search or registry stands behind (Verified/Confirmed), a likely finance lead
// (Likely), or nobody confirmed — ask for the FD by title.
export const CONTACT_GROUPS = ["Confirmed", "Likely", "Ask for the FD"];
export const contactGroup = (r) =>
  !presentedContact(r) ? "Ask for the FD" : ["Verified", "Confirmed"].includes(r.finance_contact_confidence) ? "Confirmed" : "Likely";

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
  if (!presentedContact(r)) return "No one named";
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
    (!q || [r.company_name, r.finance_contact, r.finance_contact_clues, r.fx_niche, r.main_bank, r.postcode, r.company_number, notes[r.company_number]?.text]
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

// A company's own page: /accounts/<company number> (functions/accounts/[[path]].js serves accounts.html for it).
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
      ["FX proof in the filings", r.filed_fx_score ? `${r.filed_fx_score} — ${parts(r.filed_fx).join(" · ")}` : ""],
      ["Forward contracts", r.fx_forwards_evidence || r.fx_forwards, r.fx_notes_url],
      ["Currencies in the accounts", join(r.currencies_in_accounts, r.currencies_in_accounts_evidence), r.fx_notes_url],
      ["Currency sensitivity", r.fx_sensitivity, r.fx_notes_url], ["Foreign-currency balances", r.fx_balances, r.fx_notes_url],
      ["Turnover by region", r.turnover_regions, r.turnover_regions_url || r.accounts_url],
      ["Group accounts", join(r.group_parent_accounts, r.group_fx), r.group_fx_url],
      ["FX gain/loss", fxLine(r), r.fx_gain_loss_url], ["Recent FX loss", r.recent_fx_loss, r.fx_gain_loss_url],
      ["FX figure to check", r.fx_gain_loss_check, r.fx_gain_loss_url], ["FX line in the accounts", r.fx_gain_loss_evidence, r.fx_gain_loss_url],
      ["FX size", r.fx_estimate], ["Wallet basis", r.fx_wallet_basis],
      ["Main currency", [r.main_currency, r.currency_direction, r.currency_confidence && `${r.currency_confidence} confidence`, r.currency_source].filter(Boolean).join(" · ")],
      ["Currency evidence", r.currency_evidence], ["Imports in", r.import_currencies], ["Exports in", r.export_currencies],
      ["Trade", r.trade_countries], ["Customs goods", r.hmrc_goods], ["Why FX", r.fx_evidence], ["Niche", r.fx_niche],
      ["Exposure", r.fx_exposure], ["Why untapped", r.untapped_reasons],
    ]],
    ["People", [
      ["Contact source", presentedContact(r) && r.finance_contact_source], ["Probably no FD", r.no_fd_likely],
      ["Research clues", contactClues(r).join(" · ")],
      ["Former FD", r.former_finance_director], ["Contact evidence", r.finance_contact_evidence], ["Search check", r.search_check],
      ["Lead director", join(r.lead_director, r.lead_director_occupation)], ["Directors", r.all_directors],
      ["Company secretary", r.company_secretary], ["Signed accounts", r.accounts_signed_by], ["Owners", r.owners],
      ["Group", r.group_parent], ["Owned abroad", r.run_from_abroad], ["Parent's finance contact", r.parent_finance_contact],
    ]],
    ["Company", [
      ["Accounts", r.size_basis, r.accounts_url], ["Turnover source", r.turnover_source, r.turnover_url],
      ["Turnover", r.turnover_gbp ? "" : r.turnover_check, r.turnover_url], ["Accounts filed", r.accounts_filed_on, r.accounts_url],
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
    ["Latest filed accounts", r.accounts_url], ["Accounts at the turnover line", r.turnover_url],
    ["Accounts at the FX line", r.fx_gain_loss_url], ["Accounts at the currency notes", r.fx_notes_url],
    ["Accounts at turnover by region", r.turnover_regions_url], ["Parent company's accounts", r.group_fx_url],
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

// What the company's own filings prove about its FX (the finder's filed_fx_score: forward contracts with a size,
// how they handle FX, sensitivity, FX gain/loss, turnover by region, currencies named, foreign-currency balances).
export const FX_GROUPS = ["Strong FX proof", "Some FX proof", "No FX in the filings yet"];
export const fxScore = (r) => Number(r.filed_fx_score) || 0;
export const fxGroup = (r) => (fxScore(r) >= 50 ? FX_GROUPS[0] : fxScore(r) > 0 ? FX_GROUPS[1] : FX_GROUPS[2]);
// Owned from abroad with no sign of running FX locally (run_from_abroad): pitch the UK team, but the decision may sit
// at head office, so it ranks this much lower within its group — lead-sourcer hooks.ABROAD_RULES["points"].
export const ABROAD_POINTS = 10;
const rankedFx = (r) => fxScore(r) - (r.run_from_abroad ? ABROAD_POINTS : 0);

// The FX facts a card leads with, each [label, value, source link, the quote behind it]; empty ones left out.
// "Currencies" are the ones the accounts tie to the business, else the main currency and where it came from.
export function fxFacts(r) {
  const before = (s = "") => s.split(" — ")[0];
  const after = (s = "") => s.split(" — ").slice(1).join(" — ");
  const currencies = r.currencies_in_accounts ||
    (r.main_currency ? `${r.main_currency}${r.currency_source ? ` (${r.currency_source})` : ""}` : "");
  const handles = [r.fx_forwards, !r.fx_forwards || /provider/i.test(r.fx_today || "") ? r.fx_today : ""].filter(Boolean).join(" · ");
  return [
    ["Currencies", currencies, r.currencies_in_accounts ? r.fx_notes_url || r.accounts_url : "",
     r.currencies_in_accounts_evidence || r.currency_evidence],
    ["How they do FX", handles, r.fx_forwards ? r.fx_notes_url || r.accounts_url : r.fx_today_url,
     r.fx_forwards ? r.fx_forwards_evidence : r.fx_today_evidence],
    ["FX gain/loss", fxLine(r), r.fx_gain_loss_url, r.fx_gain_loss_evidence],
    ["Sales by region", r.turnover_regions, r.turnover_regions_url || r.accounts_url, ""],
    ["Currency sensitivity", before(r.fx_sensitivity), r.fx_notes_url || r.accounts_url, after(r.fx_sensitivity)],
    ["Foreign-currency balances", r.fx_balances, r.fx_notes_url || r.accounts_url, ""],
    ["Runs in another currency", r.reporting_currency, r.accounts_url, r.reporting_currency_evidence],
    ["Subsidiaries abroad", r.subsidiaries_abroad, r.accounts_url, r.subsidiaries_abroad_evidence],
    ["Foreign-currency borrowing", r.fx_borrowings, r.accounts_url, r.fx_borrowings_evidence],
    // the UK parent's consolidated accounts: the group's treasury often holds the FX
    ["Group", r.group_fx, r.group_fx_url, r.group_parent_accounts],
  ].filter(([, v]) => v);
}

// "Hottest": the strongest FX proof in the company's own filings first; within the same score, the finder's ranking
// (FX evidence + untapped + triggers + a recent FX loss). FX probably run from an overseas parent: ABROAD_POINTS lower,
// within its group. Who to ask for is a quick Google: see "Contact confidence".
export const SORTS = {
  lead: { label: "Lead score (best first)", key: (r) => -(r.lead_score || 0) * 1e6 + r.rank },
  hot: { label: "Hottest (strongest FX proof)", key: (r) => FX_GROUPS.indexOf(fxGroup(r)) * 1e9 - rankedFx(r) * 1e6 + r.rank },
  rank: { label: "Our score", key: (r) => r.rank },
  // Most senior finance role first (CFO/FD, head of finance, controller, manager…); within a role, hottest first.
  role: { label: "Job role (CFO/FD first)", key: (r) => ROLE_GROUPS.indexOf(roleGroup(r)) * 1e7 + SORTS.hot.key(r) },
  turnover: { label: "Turnover", key: (r) => -(Number(r.turnover_gbp) || 0) },
  wallet: { label: "FX wallet", key: (r) => -(Number(r.fx_wallet_high_gbp) || 0) },
  fxLoss: { label: "Largest FX loss", key: fxLossKey },
  confidence: { label: "Contact confidence", key: (r) => (presentedContact(r) ? CONFIDENCE.indexOf(r.finance_contact_confidence) : 9) * 10000 + r.rank },
  contactFirst: { label: "Confirmed contact first", key: (r) => CONTACT_GROUPS.indexOf(contactGroup(r)) * 1e6 + r.rank },
};

export const sortRows = (rows, by = "hot") =>
  [...rows].sort((a, b) => SORTS[by].key(a) - SORTS[by].key(b) || a.rank - b.rank);

// One cell to copy: "ACME LIMITED – Jane Smith, Finance Director" for a presented finance contact (never a Guess),
// else who to ask for: "ACME LIMITED – ask for the Finance Director" (the MD where there's probably no FD).
export function companyAndFd(r) {
  const who = presentedContact(r) ? [r.finance_contact, r.finance_contact_role].filter(Boolean).join(", ")
    : askFor(r).replace(/^Ask/, "ask");
  return `${r.company_name || ""} – ${who}`;
}

// --- Export for Cognism: only what its upload matches on (company, domain, location, the person if named) -------------
// Zac enriches this in Cognism on the bank's licence; what Cognism returns stays there, never back in this system.
// In the order Cognism's upload reads them, with plain headers its column matching recognises; Email, Direct phone,
// Mobile and Notes are left blank to be filled in (by Cognism's enrichment or by hand).
export const COGNISM_COLUMNS = [
  ["company_and_fd", "Company – Finance Director", 44], ["company_name", "Company Name", 34], ["domain", "Website", 24],
  ["first_name", "First Name", 14], ["last_name", "Last Name", 16], ["job_title", "Job Title", 24], ["linkedin_url", "LinkedIn URL", 34],
  ["email", "Email", 28], ["direct_phone", "Direct Phone", 16], ["mobile", "Mobile", 16], ["role_to_find", "Role to Find", 22],
  ["country", "Country", 14], ["postcode", "Postcode", 11], ["company_number", "Company Number", 15], ["turnover_gbp", "Turnover (£)", 14, true],
  ["why_fx", "Why FX", 50], ["notes", "Notes", 30], ["companies_house_url", "Companies House", 40],
].map(([key, header, width, number]) => ({ key, header, width, number: Boolean(number) }));
export const COGNISM_FIELDS = COGNISM_COLUMNS.map((c) => c.key);
const TITLES = /^(mr|mrs|ms|miss|dr|prof|sir|dame|lord|lady)\.?$/i;
export function splitName(name = "") {
  const words = String(name).replace(/\(.*?\)/g, " ").split(/\s+/).filter((w) => w && !TITLES.test(w));
  return words.length < 2 ? { first: words[0] || "", last: "" } : { first: words[0], last: words[words.length - 1] };
}
// Websites the daily website finder confirmed (tools/find_domains.py, ?view=signals → websites): a row's own website wins.
let knownSites = {};
export const setKnownSites = (map) => { knownSites = map || {}; };
export const siteOf = (r) => r.website || knownSites[r.company_number] || "";
export const domainOf = (website = "") => String(website).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
export function cognismRow(r) {
  const named = presentedContact(r);
  const { first, last } = named ? splitName(r.finance_contact) : { first: "", last: "" };
  const linkedin = /linkedin\.com\/in\//i.test(r.finance_contact_linkedin || "") ? r.finance_contact_linkedin : "";
  const why = [r.recent_fx_loss, parts(r.triggers)[0], r.fx_forwards || r.fx_today, r.currencies_in_accounts].filter(Boolean)[0] || "";
  return {
    company_and_fd: companyAndFd(r), company_name: r.company_name || "", domain: domainOf(siteOf(r)), company_number: r.company_number || "",
    postcode: r.postcode || "", country: "United Kingdom", first_name: first, last_name: last,
    job_title: named ? r.finance_contact_role || "" : "", linkedin_url: linkedin, email: "", direct_phone: "", mobile: "", notes: "",
    role_to_find: r.no_fd_likely ? "Managing Director" : "Finance Director / CFO", turnover_gbp: r.turnover_gbp || "",
    why_fx: why, companies_house_url: r.companies_house_url || `https://find-and-update.company-information.service.gov.uk/company/${r.company_number}`,
  };
}
// Cognism's company list (search by company, then filter by job title): only companies with a confirmed website — the
// field Cognism matches companies on — one row each, best lead first as given.
export const COGNISM_COMPANY_COLUMNS = [
  ["company_name", "Company Name", 34], ["domain", "Website", 26], ["country", "Country", 14], ["role_to_find", "Job Titles to Find", 30],
  ["company_number", "Company Number", 15], ["lead_score", "Lead Score", 10, true], ["why_fx", "Why FX", 50],
].map(([key, header, width, number]) => ({ key, header, width, number: Boolean(number) }));
export function cognismCompanyRows(rows) {
  return rows.filter((r) => siteOf(r)).map((r) => ({
    ...cognismRow(r), lead_score: r.lead_score ?? "",
    role_to_find: r.no_fd_likely ? "Managing Director; Finance Director" : "Finance Director; CFO; Financial Controller; Head of Finance",
  }));
}
export const cognismCsv = (rows) => toCsv(rows.map(cognismRow), COGNISM_FIELDS);

export const EXPORT_FIELDS = [
  "company_and_fd", "lead_score", "lead_reasons", "lead_checklist", "reasons_not_to_progress", "rank", "section", "qualified", "qualify_reason", "warm_route", "company_name", "company_number",
  "filed_fx_score", "filed_fx", "currencies_in_accounts", "fx_forwards", "fx_sensitivity", "fx_balances", "turnover_regions",
  "currency_source", "group_parent_accounts", "group_fx", "run_from_abroad",
  "finance_contact", "finance_contact_role",
  "finance_contact_confidence", "finance_contact_clues", "finance_contact_linkedin", "search_check", "no_fd_likely", "former_finance_director", "lead_director", "turnover_gbp", "turnover_basis", "turnover_check",
  "fx_wallet_low_gbp", "fx_wallet_high_gbp", "currency_pairs", "import_currencies", "export_currencies",
  "fx_gain_loss_gbp", "fx_gain_loss_prior_gbp", "fx_gain_loss_check", "recent_fx_loss", "accounts_filed_on", "first_seen",
  "main_bank", "bank_type", "fact_1", "fact_2", "main_currency", "currency_direction",
  "currency_evidence", "currency_confidence", "opener", "email_draft", "fx_estimate", "incumbent_bank", "facility_ends",
  "facility_ends_evidence", "fx_today", "fx_today_evidence", "lenders", "triggers", "when_to_call", "fx_niche", "call_angle",
  "website", "generic_emails", "notes", "accounts_url", "fx_gain_loss_url", "incumbent_bank_url",
  "companies_house_url",
];

// A cell a spreadsheet would run as a formula ("=HYPERLINK(...)", "+1", "@x", "-2+3") is prefixed with ' so it opens as
// text. Plain negative numbers ("-150512", an FX loss) stay numbers.
export const safeCell = (s) => (/^[=+@\t\r]/.test(s) || /^-(?!\d+(\.\d+)?$)/.test(s) ? `'${s}` : s);

export function toCsv(rows, fields = EXPORT_FIELDS) {
  const cell = (v) => {
    const s = safeCell(v === undefined || v === null ? "" : String(v));
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.join(","), ...rows.map((r) => fields.map((f) => cell(r[f])).join(","))].join("\n");
}

// --- Recent FX filings (lead-sourcer/sourcer/filings.py) --------------------------------------------------------

// A scanned filing as a row the FX strip can show: every fact links to the company's filing history.
export function filingRow(r) {
  return { ...r, fx_gain_loss_url: r.accounts_url, fx_today_url: r.accounts_url, main_currency: r.currency || "" };
}

// "4 Nov 2026" for a day file's date; "October 2026" (a month's archive) as it is.
export function filedWhen(filed = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(filed)
    ? new Date(`${filed}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : filed;
}

// The tab's filters: search (company name or number, and the FX facts' text), strong proof only, FX loss only.
export function filterFilings(rows, { query = "", strongOnly = false, lossOnly = false, movedOnly = false, band = false } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (!strongOnly || (r.filed_fx_score || 0) >= 50)
    && (!lossOnly || Number(r.fx_gain_loss_gbp) < 0)
    && (!movedOnly || Boolean(r.moved_up))
    && (!band || inCoreBand(r))
    && (!q || [r.company_name, r.company_number, r.currencies_in_accounts, r.fx_forwards, r.fx_today, r.turnover_regions, r.hmrc_trade,
               r.bank_debt, r.moved_up, r.incumbent_bank, r.owner, r.directors, r.triggers, ...(r.fx_mentions || [])]
      .some((v) => (v || "").toLowerCase().includes(q))));
}

// The filings tab's order: newest filed (as stored), or strongest first — filed FX proof less ABROAD_POINTS for FX
// probably run abroad (rank_score from the scan), then newest.
export function sortFilings(rows, by = "newest") {
  if (by !== "strongest") return rows;
  const score = (r) => (r.rank_score ?? rankedFx(r));
  return [...rows].sort((a, b) => score(b) - score(a) || (b.filed || "").localeCompare(a.filed || ""));
}

// A Google search for a company's turnover, for one that filed none (filleted accounts): press, the group's
// accounts, its own site. Checked by hand — directory sites' figures are estimates.
export function turnoverSearch(name = "") {
  return `https://www.google.com/search?q=${encodeURIComponent(`"${name.replace(/\s+(LIMITED|LTD\.?)$/i, "")}" turnover`)}`;
}

// The company's own Companies House page, by number: searching its name can find another (a dissolved namesake).
export function chCompanyUrl(number = "") {
  return `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(number)}`;
}

// A group's filing: consolidated figures, or the same figures filed by several group companies.
export function isGroupFiling(r) {
  return r.turnover_basis === "group" || Boolean(r.also_filed);
}

// "Sep 2026" for "2026-09".
export function monthLabel(month = "") {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${names[+m[2] - 1]} ${m[1]}` : month;
}

// --- FX losses (the FX losses tab) ---------------------------------------------------------------------------------

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December"];
// "2026-11-04" for a filing's date: the main list's accounts_filed_on, a day file's date, or the 1st of a month's archive.
export function filedIso(r) {
  const f = r.accounts_filed_on || r.filed || "";
  if (/^\d{4}-\d{2}-\d{2}/.test(f)) return f.slice(0, 10);
  const m = /^([A-Z][a-z]+) (\d{4})$/.exec(f);
  return m && MONTH_NAMES.includes(m[1]) ? `${m[2]}-${String(MONTH_NAMES.indexOf(m[1]) + 1).padStart(2, "0")}-01` : "";
}

// Hedging named in the company's own accounts: its forward contracts, or "Uses …" (forwards, options, a provider).
export const hedgingNamed = (r) => Boolean(r.fx_forwards) || /^Uses\b/.test(r.fx_today || "");

// Every company with an FX loss in its latest accounts: the main list's (full research, finance contact) first, then
// the Recent FX filings list's companies not on it yet. Each with loss (positive £), prior (last year's figure, signed),
// share (of turnover) and onList.
export function lossRows(listRows = [], filingLosses = []) {
  const shape = (r, onList) => {
    const loss = -Number(r.fx_gain_loss_gbp);
    const turnover = Number(r.turnover_gbp) || 0;
    const prior = r.fx_gain_loss_prior_gbp === undefined || r.fx_gain_loss_prior_gbp === "" ? null : Number(r.fx_gain_loss_prior_gbp);
    return { ...r, loss, prior, share: turnover ? loss / turnover : null, onList, filedOn: filedIso(r) };
  };
  const listed = listRows.filter((r) => Number(r.fx_gain_loss_gbp) < 0);
  const numbers = new Set(listRows.map((r) => r.company_number));
  return [...listed.map((r) => shape(r, true)),
    ...filingLosses.filter((r) => !numbers.has(r.company_number) && Number(r.fx_gain_loss_gbp) < 0).map((r) => shape(filingRow(r), false))];
}

// The loss grew on last year's: a loss now bigger than last year's loss, or a loss after last year's gain.
export const lossGrew = (r) => r.prior !== null && (r.prior >= 0 || r.loss > -r.prior);

// The desk's sweet spot (Nov 2026): turnover £20m–£300m, filed or the group's. A size estimate alone doesn't count.
export const CORE_BAND = [20_000_000, 300_000_000];
export const inCoreBand = (r) => {
  // filed turnover in pounds, else (accounts kept in another currency) its filed turnover at a rough rate
  const t = Number(r.turnover_gbp) || Number(r.turnover_foreign_gbp) || 0;
  return t >= CORE_BAND[0] && t <= CORE_BAND[1];
};

export function filterLosses(rows, { min = 0, query = "", recentDays = 0, unhedged = false, grew = false, band = false, today = new Date() } = {}) {
  const q = query.trim().toLowerCase();
  const since = recentDays ? new Date(today.getTime() - recentDays * 864e5).toISOString().slice(0, 10) : "";
  return rows.filter((r) => r.loss >= min
    && (!q || [r.company_name, r.company_number, r.finance_contact, r.currency, r.main_currency, r.currencies_in_accounts,
      r.turnover_regions, r.incumbent_bank, r.fx_niche].some((v) => String(v || "").toLowerCase().includes(q)))
    && (!since || (r.filedOn && r.filedOn >= since))
    && (!unhedged || !hedgingNamed(r))
    && (!grew || lossGrew(r))
    && (!band || inCoreBand(r)));
}

// --- Call today: the day's shortlist across the Accounts list and the Recent FX filings list -------------------------

// £20m–£300m, strong FX proof in the filings (50+), not qualified Out, and a reason to ring now: an FX loss of £50k+ in
// accounts filed in the last 6 months, or a trigger (new owner, new or paid-off charge, facility renewal, new
// directors). Companies with a confirmed finance contact first, then likely, then "ask for the FD"; within each,
// strongest FX proof (owned abroad lower) plus 30 for the loss and 15 for a trigger. Rule-based, every pick says why.
export const CALL_TODAY_MAX = 25;
export const CALL_RULES = { minScore: 50, minLoss: 50000, recentDays: 183, lossPoints: 30, triggerPoints: 15 };
export function callToday(listRows = [], filingRows = [], { today = new Date(), max = CALL_TODAY_MAX, rules = CALL_RULES, lead = {} } = {}) {
  const since = new Date(today.getTime() - rules.recentDays * 864e5).toISOString().slice(0, 10);
  const numbers = new Set(listRows.map((r) => r.company_number));
  const pick = (r, onList) => {
    if (!inCoreBand(r) || fxScore(r) < rules.minScore || r.qualified === "Out") return null;
    if (reasonsNotToProgress(r, { today }).some((x) => x.serious)) return null;
    const loss = -Number(r.fx_gain_loss_gbp) || 0;
    const filedOn = filedIso(r);
    const recentLoss = Boolean(r.recent_fx_loss) || (loss >= rules.minLoss && Boolean(filedOn) && filedOn >= since);
    const trigger = parts(r.triggers)[0] || "";
    if (!recentLoss && !trigger) return null;
    const fx = r.fx_forwards || r.fx_today || r.currencies_in_accounts || r.turnover_regions || "";
    const why = [
      recentLoss && `FX loss of ${money(loss)} in accounts filed ${filedWhen(filedOn)}`,
      trigger,
      `Filed FX proof ${fxScore(r)}${fx ? `: ${fx}` : ""}`,
      r.run_from_abroad && "Owned abroad: pitch the UK team",
    ].filter(Boolean);
    const row = onList ? r : filingRow(r);
    const lead_ = leadScore(row, { ...lead, today });   // the order: the lead score (LEAD_POINTS), its reasons shown
    return { ...row, onList, loss, filedOn, why, score: lead_.score, lead_score: lead_.score, lead_parts: lead_.parts,
             group: CONTACT_GROUPS.indexOf(contactGroup(r)) };
  };
  return [...listRows.map((r) => pick(r, true)),
    ...filingRows.filter((r) => !numbers.has(r.company_number)).map((r) => pick(r, false))]
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.group - b.group || a.company_name.localeCompare(b.company_name))
    .slice(0, max);
}

// --- Lead checklist and reasons not to progress (the team's onboarding steer, Nov 2026) ------------------------------
// Before a lead goes to Sales: who owns it, is it in the band, does it trade abroad, has something changed, does it
// need FX, is there a reason to call — and every reason it would NOT be an opportunity. Filled from the company's own
// records; "CRM checked" is Zac's own tick (the bank's CRM stays out of this system). States: yes / no / check / warn.
const sizeLine = (r) => (r.turnover_gbp ? `${money(r.turnover_gbp)}${r.turnover_basis === "group" ? " (group)" : ""}`
  : r.turnover_foreign_gbp ? `≈${money(r.turnover_foreign_gbp)} (filed in ${r.reporting_currency?.match(/in (\w+)/)?.[1] || "another currency"})` : "");
const firstOwner = (r) => r.owner || (r.owners ? `Owned by ${String(r.owners).split(";")[0].trim()}` : "");
export function leadChecklist(r, checks = {}) {
  const t = Number(r.turnover_gbp) || 0;
  const abroad = [r.turnover_regions && `Sales by region: ${r.turnover_regions}`, r.overseas_turnover_share && `${r.overseas_turnover_share} of sales overseas`,
    (Number(r.hmrc_import_months) || Number(r.hmrc_export_months)) && `HMRC: imports in ${r.hmrc_import_months || 0}, exports in ${r.hmrc_export_months || 0} months`,
    r.hmrc_trade && `HMRC: ${r.hmrc_trade}`, r.currencies_in_accounts && `Currencies: ${r.currencies_in_accounts}`, r.trade_countries && `Trades with ${r.trade_countries}`]
    .filter(Boolean);
  const growth = parseFloat(r.turnover_growth) >= 20 ? `Turnover ${r.turnover_growth} on last year` : "";
  const change = [parts(r.triggers)[0], growth].filter(Boolean);   // ownership, charges, directors, growth — an FX loss is a reason, not a change
  const reason = [r.recent_fx_loss, parts(r.triggers)[0], r.fact_1].filter(Boolean)[0]
    || (Number(r.fx_gain_loss_gbp) < 0 ? `FX loss of ${money(-Number(r.fx_gain_loss_gbp))} in its latest accounts` : "");
  const crm = checks[r.company_number]?.crm;
  return [
    { key: "owner", label: "Ownership",
      ...(r.run_from_abroad ? { state: "warn", detail: r.run_from_abroad }
        : firstOwner(r) ? { state: "yes", detail: `${firstOwner(r)}${r.pe_backed ? " — private-equity backed" : ""}` }
        : { state: "check", detail: "Owners not read — check the PSC register on Companies House" }) },
    { key: "band", label: "Turnover £20m–£300m",
      ...(inCoreBand(r) ? { state: "yes", detail: sizeLine(r) }
        : t ? { state: "no", detail: `${sizeLine(r)} — ${t > CORE_BAND[1] ? "above" : "below"} the band` }
        : { state: "check", detail: r.size_estimate ? `${r.size_estimate} (estimate)` : "No turnover filed" }) },
    { key: "abroad", label: "International activity", ...(abroad.length ? { state: "yes", detail: abroad[0] } : { state: "check", detail: "None in the records — ask" }) },
    { key: "change", label: "Business change / trigger", ...(change.length ? { state: "yes", detail: change[0] } : { state: "no", detail: "No recent change found — find one before calling" }) },
    { key: "fx", label: "Likely FX need",
      ...(fxScore(r) >= 50 ? { state: "yes", detail: `Filed FX proof ${fxScore(r)}${r.fx_forwards || r.fx_today ? `: ${r.fx_forwards || r.fx_today}` : ""}` }
        : fxScore(r) > 0 ? { state: "warn", detail: `Some FX proof (${fxScore(r)})` } : { state: "no", detail: "No FX in its filed accounts" }) },
    { key: "reason", label: "Reason to contact", ...(reason ? { state: "yes", detail: reason } : { state: "no", detail: "No specific reason yet" }) },
    { key: "crm", label: "CRM checked (ownership, duplicates, past activity)", manual: true,
      ...(crm ? { state: "yes", detail: `Ticked ${filedWhen(crm.slice(0, 10))}` } : { state: "check", detail: "Not yet — check the CRM before contact" }) },
  ];
}
// "✓ Ownership · ✓ Turnover £20m–£300m · ? International activity …" for a spreadsheet cell.
export const checklistLine = (items) => items.map((i) => `${{ yes: "✓", no: "✗", check: "?", warn: "!" }[i.state]} ${i.label.split(" (")[0]}`).join(" · ");

// Every reason this would NOT be an opportunity, from the records. Serious ones keep a company off Call today.
export function reasonsNotToProgress(r, { today = new Date() } = {}) {
  const out = [];
  const add = (text, serious = false) => out.push({ text, serious });
  const t = Number(r.turnover_gbp) || 0;
  if (r.qualified === "Out") add(`Qualified out${r.qualify_reason ? `: ${r.qualify_reason}` : ""}`, true);
  if (t > CORE_BAND[1]) add(`Turnover ${money(t)} — above £300m (check the desk's upper limit)`, true);
  else if (t && t < CORE_BAND[0]) add(`Turnover ${money(t)} — below £20m`, true);
  else if (!t && r.turnover_foreign_gbp) add("Turnover filed in another currency — the £ size is an estimate at a rough rate");
  else if (!t) add(r.size_estimate ? `No turnover filed — size is an estimate (${r.size_estimate})` : "No turnover filed — size unknown");
  else if (r.turnover_basis === "group") add(`Sized by its group${r.group_parent ? ` (${r.group_parent})` : ""} — its own size is unknown`);
  if (!fxScore(r)) add("No FX in its filed accounts", true);
  if (r.run_from_abroad) add(`${r.run_from_abroad.split(" — ")[0]} — FX may be run by the parent`);
  if (r.own_bank_client) add("Already banks with Investec — check the CRM owner before contact");
  if (/^Uses an FX provider/.test(r.fx_today || "")) add(`${r.fx_today.replace(/^Uses/, "Already uses")} — a competitive pitch`);
  if (r.turnover_check) add(`Turnover sent to check: ${r.turnover_check}`);
  if (r.fx_gain_loss_check) add(`FX figure sent to check: ${r.fx_gain_loss_check}`);
  const filed = filedIso(r);
  if (filed && (today - new Date(filed)) / 864e5 > 400) add(`Latest accounts filed ${filedWhen(filed)} — look for newer ones`);
  if (Number(r.group_companies_in_list) > 1) add(`${r.group_companies_in_list} group companies on your list — one call for the group`);
  return out;
}

export const LOSS_SORTS = {
  biggest: { label: "Biggest loss", key: (r) => -r.loss },
  share: { label: "Biggest share of turnover", key: (r) => -(r.share ?? -1) },
  newest: { label: "Newest filed", key: (r) => -Number((r.filedOn || "0").replace(/-/g, "")) },
  grew: { label: "Grew most on last year", key: (r) => (r.prior === null ? 1e15 : -(r.loss + r.prior)) },
};
export const sortLosses = (rows, by = "biggest") =>
  [...rows].sort((a, b) => LOSS_SORTS[by].key(a) - LOSS_SORTS[by].key(b) || (a.onList === b.onList ? 0 : a.onList ? -1 : 1));

// --- Freshness strip (each data workflow's last outcome: scripts/status.mjs) -----------------------------------------

// How often each runs, and so how old its last good run may be before the strip shows it stale.
export const STATUS_JOBS = [
  ["finder", "Accounts list", 30],          // every evening
  ["filings", "FX filings", 80],            // Tue–Sat mornings (a weekend gap)
  ["market", "Market moves", 80],           // weekdays, twice
  ["audit", "Accuracy audit", 8 * 24],      // weekly
  ["alerts", "Alerts", 8],                  // every 3 hours
];
const ago = (hours) => (hours < 1 ? "under an hour ago" : hours < 48 ? `${Math.round(hours)}h ago` : `${Math.round(hours / 24)} days ago`);

// [{job, label, level: ok | stale | failed | unknown, text, run, note}] for the strip, oldest-news first never hidden.
export function statusLines(status, now = new Date()) {
  const jobs = (status && status.jobs) || {};
  return STATUS_JOBS.map(([job, label, maxHours]) => {
    const j = jobs[job];
    if (!j) return { job, label, level: "unknown", text: "no run recorded yet" };
    const lastOk = j.last_ok ? (now - new Date(j.last_ok)) / 36e5 : null;
    const level = j.state === "failed" ? "failed" : lastOk === null || lastOk > maxHours ? "stale" : j.state === "partial" ? "stale" : "ok";
    const text = j.state === "failed" ? `last run failed ${ago((now - new Date(j.at)) / 36e5)}${lastOk !== null ? ` · last good ${ago(lastOk)}` : ""}`
      : j.state === "partial" && j.note === "no stream key" ? "waiting for its Companies House streaming key (CH_STREAM_KEY)"
      : j.state === "partial" ? `ran out of time ${ago((now - new Date(j.at)) / 36e5)} — carries on next run`
      : `updated ${ago(lastOk ?? 0)}`;
    const blocked = searchBlocked(j);
    if (blocked) {
      const detail = j.search_problems.map((p) => `${p.name}: ${p.why}`).join("\n");
      return { job, label, level: level === "failed" ? "failed" : "stale", text: `${text} · ${blocked}`, run: j.run || "", note: [j.note, detail].filter(Boolean).join("\n") };
    }
    return { job, label, level, text, run: j.run || "", note: j.note || "" };
  });
}

// "contact searches blocked (1,296 waiting): Search1api key rejected · Serper out of credits · Tavily allowance used"
// when the finder's last run had sized companies waiting and no search provider able to answer (confirm_contacts.py
// search_problems): the strip turns amber instead of reading "ok".
export function searchBlocked(job) {
  const problems = Array.isArray(job?.search_problems) ? job.search_problems : [];
  if (!problems.length) return "";
  const reason = (why = "") => (/\b40[13]\b|unauthori[sz]ed|invalid/i.test(why) ? "key rejected"
    : /\b402\b|credit/i.test(why) ? "out of credits" : /allowance/i.test(why) ? "month's allowance used" : "failing");
  const name = (n = "") => `${n[0].toUpperCase()}${n.slice(1)}`;
  const waiting = Number(job.search_waiting) || 0;
  return `contact searches blocked${waiting ? ` (${waiting.toLocaleString()} waiting)` : ""}: ${problems.map((p) => `${name(p.name)} ${reason(p.why)}`).join(" · ")}`;
}

// "Searches left this month: Tavily 812 of 1,000 · Serper 1,240 of 2,500" from the finder's last run.
export function searchAllowance(status) {
  const s = status?.jobs?.finder?.search;
  if (!Array.isArray(s) || !s.length) return "";
  return s.map((p) => `${p.name[0].toUpperCase()}${p.name.slice(1)} ${p.cap ? `${Math.max(0, p.cap - p.used).toLocaleString()} of ${p.cap.toLocaleString()}` : `${p.used.toLocaleString()} used (no cap)`}`).join(" · ");
}

// --- Finance charts (the company page) and the sheet view --------------------------------------------------------

// "£56m" / "£3.3m" / "£850k" / "£1.2bn" / "56,000,000" -> pounds; NaN when not a figure.
export function parseMoney(text = "") {
  const m = /(-)?£?\s*([\d,]+(?:\.\d+)?)\s*(bn|m|k)?\b/i.exec(String(text));
  if (!m) return NaN;
  const n = Number(m[2].replace(/,/g, "")) * ({ bn: 1e9, m: 1e6, k: 1e3 }[(m[3] || "").toLowerCase()] || 1);
  return m[1] ? -n : n;
}

// "UK £56m · Europe £3.3m · Rest of the world £1.2m" -> [{region, value}], biggest first.
export function regionBars(r) {
  return String(r.turnover_regions || "").split(/\s*·\s*/).map((part) => {
    const m = /^(.*?)\s+(-?£[\d.,]+\s*(?:bn|m|k)?)$/i.exec(part.trim());
    return m ? { region: m[1], value: parseMoney(m[2]) } : null;
  }).filter((x) => x && Number.isFinite(x.value) && x.value > 0).sort((a, b) => b.value - a.value);
}

// Turnover this year and last (from the growth figure when last year's isn't kept), pounds.
export function turnoverYears(r) {
  const now = Number(r.turnover_gbp) || 0;
  const growth = parseFloat(String(r.turnover_growth || "").replace("+", ""));
  const prior = Number(r.turnover_prior_gbp) || (now && Number.isFinite(growth) && growth > -100 ? now / (1 + growth / 100) : 0);
  return { now, prior, growth: Number.isFinite(growth) ? growth : null };
}

// Where a turnover sits on a log scale from £1m to £1bn (0–1), for the size bar with the £20m–£300m band shaded.
export const SIZE_SCALE = [1e6, 1e9];
export const sizePosition = (gbp) => (gbp > 0 ? Math.min(1, Math.max(0, Math.log10(gbp / SIZE_SCALE[0]) / Math.log10(SIZE_SCALE[1] / SIZE_SCALE[0]))) : null);

// The sheet view's columns: [key, header, value(r), sort key(r), number?]
export const SHEET_COLUMNS = [
  ["company", "Company", (r) => r.company_name, (r) => r.company_name || ""],
  ["lead", "Score", (r) => (r.lead_score !== undefined ? String(r.lead_score) : ""), (r) => -(r.lead_score || 0), true],
  ["turnover", "Turnover", (r) => (r.turnover_gbp ? money(r.turnover_gbp) : r.turnover_foreign_gbp ? `≈${money(r.turnover_foreign_gbp)}` : ""),
   (r) => -(Number(r.turnover_gbp) || Number(r.turnover_foreign_gbp) || 0), true],
  ["growth", "Growth", (r) => r.turnover_growth || "", (r) => -(parseFloat(r.turnover_growth) || -1e9), true],
  ["fxscore", "FX proof", (r) => (fxScore(r) ? String(fxScore(r)) : ""), (r) => -fxScore(r), true],
  ["fxloss", "FX gain/loss", (r) => (r.fx_gain_loss_gbp ? `${Number(r.fx_gain_loss_gbp) < 0 ? "−" : "+"}${money(Math.abs(Number(r.fx_gain_loss_gbp)))}` : ""),
   (r) => Number(r.fx_gain_loss_gbp) || 0, true],
  ["currencies", "Currencies", (r) => r.currencies_in_accounts || r.main_currency || "", (r) => r.currencies_in_accounts || r.main_currency || "~"],
  ["fx", "How they do FX", (r) => r.fx_forwards || r.fx_today || "", (r) => (r.fx_forwards ? 0 : r.fx_today ? 1 : 2)],
  ["contact", "Finance contact", (r) => (presentedContact(r) ? `${r.finance_contact}${r.finance_contact_role ? `, ${r.finance_contact_role}` : ""}` : askFor(r)),
   (r) => CONTACT_GROUPS.indexOf(contactGroup(r))],
  ["grade", "Grade", (r) => (presentedContact(r) ? r.finance_contact_confidence || "" : ""), (r) => CONTACT_GROUPS.indexOf(contactGroup(r))],
  ["bank", "Bank", (r) => (r.incumbent_bank || r.main_bank || "").split(":")[0], (r) => (r.incumbent_bank || r.main_bank || "~").toLowerCase()],
  ["trigger", "Trigger", (r) => parts(r.triggers)[0] || r.recent_fx_loss || "", (r) => (r.triggers || r.recent_fx_loss ? 0 : 1)],
];

// --- Lead score: which companies rank first (Zac's steer, 10 Nov 2026) ------------------------------------------------
// Points, each with its reason, so the order explains itself and the weights can be recalibrated against what Sales
// takes: an FX loss (bigger and more recent, more), proof of FX in the filings, a measured good niche, a new finance
// director, other changes (owner, charges, hiring for treasury, expanding abroad), subsidiaries abroad, accounts just
// filed, new on the list, in the £20m–£300m band, nobody hedging named (probably on the bank's rate). Owned abroad
// with FX probably run by the parent: fewer. `niches`: {niche name: {tier}} (tools/niche_hits.py, nicheTiers);
// `signals`: {company number: [{kind, at, title}]} (the Alerts job).
export const LEAD_POINTS = {
  strongFx: 20, someFx: 8, band: 10,
  loss: 20, bigLoss: 30, lossMin: 50000, bigLossMin: 250000, recentLoss: 10, recentDays: 183,
  justFiled: 10, justFiledDays: 90, newOnList: 5,
  nicheByTier: [0, 3, 8, 15],
  newFd: 20, newFdDays: 120, trigger: 10, abroadNews: 8, hiring: 5, signalDays: 120,
  subsidiaries: 10, open: 5, ownedAbroad: -10,
  // Zac, 13 Nov 2026: "if a company is NAME then UK, score it lower — it's obviously got an overseas owner"
  ukArmName: -10,
  // Deals (Zac, 12 Nov 2026: "filed recently with an FX loss and a new FD, or purchasing subsidiaries … just funded or
  // just bought by PE"): buying companies 15, bought by private equity 15, just funded 10, a new overseas owner or an
  // employee ownership trust 10, and the hit-list combo — a recent FX loss with a new FD / a purchase / a PE deal — 15.
  buying: 15, peBought: 15, funded: 10, newOwner: 10, combo: 15, fdInAccountsDays: 365,
};
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "Finance director appointed 2 June 2026" -> "2026-06-02" ("" when it can't be read).
export function appointedIso(text = "") {
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\s+(20\d\d)/.exec(text) || null;
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1])).toISOString().slice(0, 10);
  }
  const d = /(\d{1,2})\/(\d{1,2})\/(20\d\d)/.exec(text);
  return d ? new Date(Date.UTC(+d[3], +d[2] - 1, +d[1])).toISOString().slice(0, 10) : "";
}
// "ACME UK LIMITED", "ACME (UK) LTD", "ACME U.K. LIMITED", "ACME (GB) LIMITED": usually a foreign group's UK arm.
const UK_ARM = /\s\(?(?:U\.?K\.?|G\.?B\.?|GREAT BRITAIN|UNITED KINGDOM)\)?\s+(?:LIMITED|LTD\.?|PLC|LLP)\s*$/i;
// Owned by people (a family business that put UK in its name) — the register shows no foreign parent behind it.
const peopleOwned = (r) => /^Owned by \d+ individuals?$/.test(r.owner || "") ||
  (Boolean(r.owners) && String(r.owners).split(";").every((o) => /\(individual/i.test(o)));
export const ukArmName = (r) => UK_ARM.test(String(r.company_name || "").trim()) && !peopleOwned(r);
const NEW_FD = /\bnew (?:finance director|FD|CFO|chief financial officer)|\b(?:finance director|CFO|chief financial officer)\b[^.;]*\b(?:appointed|joined)/i;

// {niche name: {tier, hit_rate, open_share}} from the measured niches; tiers as the finder's (sourcer/niches.py TIERS).
export function nicheTiers(stats = {}) {
  const tierOf = (s) => (s.verdict === "few" ? 1 : s.score >= 8 ? 3 : s.score >= 4 ? 2 : s.score >= 1.5 ? 1 : 0);
  return Object.fromEntries(Object.values(stats).filter((s) => s?.name).map((s) => [s.name, { ...s, tier: tierOf(s) }]));
}

export function leadScore(r, { today = new Date(), niches = {}, signals = {}, madeAt = "", rules = LEAD_POINTS } = {}) {
  const out = [];
  const add = (points, why) => { if (points) out.push([why, points]); };
  const day = (n) => new Date(today.getTime() - n * 864e5).toISOString().slice(0, 10);
  const fx = fxScore(r);
  add(fx >= 50 ? rules.strongFx : fx > 0 ? rules.someFx : 0, fx >= 50 ? `Strong FX proof in its filings (${fx})` : `Some FX proof (${fx})`);
  const loss = -Number(r.fx_gain_loss_gbp) || 0;
  const filedOn = filedIso(r);
  if (loss >= rules.lossMin) {
    add(loss >= rules.bigLossMin ? rules.bigLoss : rules.loss, `FX loss of ${money(loss)}`);
    if (filedOn && filedOn >= day(rules.recentDays)) add(rules.recentLoss, `… in accounts filed ${filedWhen(filedOn)}`);
  }
  if (filedOn && filedOn >= day(rules.justFiledDays) && !(loss >= rules.lossMin)) add(rules.justFiled, `Accounts just filed (${filedWhen(filedOn)})`);
  if (madeAt && r.first_seen === madeAt) add(rules.newOnList, "New on the list");
  const niche = niches[r.fx_niche];
  if (niche) add(rules.nicheByTier[niche.tier] || 0, `Niche: ${r.fx_niche} (${niche.hit_rate}% of its companies prove FX)`);
  const recent = (signals[r.company_number] || []).filter((s) => String(s.at || "").slice(0, 10) >= day(rules.signalDays));
  const fdSignal = recent.find((s) => /^(new|news)_fd$/.test(s.kind));
  const triggers = parts(r.triggers);
  const fdTrigger = [...triggers, r.fact_1, r.fact_2].find((t) => t && NEW_FD.test(t));
  const fdFiled = r.new_fd_in_accounts && appointedIso(r.new_fd_in_accounts) >= day(rules.fdInAccountsDays) ? r.new_fd_in_accounts : "";
  const newFd = Boolean(fdSignal || fdTrigger || fdFiled);
  if (newFd) add(rules.newFd, fdSignal ? `New finance director (${fdSignal.title})` : fdTrigger ? `New finance director: ${fdTrigger}` : `New finance director: ${fdFiled} (accounts)`);
  // Deals: buying companies (its accounts, or the ownership register), bought by PE, just funded, a new owner
  const bought = recent.find((s) => s.kind === "acquired");
  const buying = Boolean(r.acquisitions || bought);
  if (buying) add(rules.buying, `Buying companies: ${r.acquisitions || bought.title}`);
  const pe = recent.find((s) => /^(pe_buyout|news_pe|new_owner_pe)$/.test(s.kind));
  if (pe) add(rules.peBought, `Private-equity deal: ${pe.title}`);
  const funded = recent.find((s) => s.kind === "news_funding");
  if (funded) add(rules.funded, `Just raised funding: ${funded.title}`);
  const owner = !pe && recent.find((s) => /^(overseas_buyer|eot)$/.test(s.kind));
  if (owner) add(rules.newOwner, `New owner: ${owner.title}`);
  const other = triggers.find((t) => !NEW_FD.test(t)) ||
    recent.find((s) => /^(new_owner|new_charge|charge_paid|fx_charge)$/.test(s.kind))?.title;
  add(other && !owner ? rules.trigger : 0, `Change: ${other}`);
  const abroad = recent.find((s) => s.kind === "news_abroad");
  add(abroad ? rules.abroadNews : 0, `In the news: ${abroad?.title || ""}`);
  const hiring = recent.find((s) => s.kind === "hiring");
  add(hiring ? rules.hiring : 0, `${hiring?.title || ""}`);
  add(r.subsidiaries_abroad ? rules.subsidiaries : 0, `Subsidiaries abroad: ${r.subsidiaries_abroad}`);
  add(inCoreBand(r) ? rules.band : 0, "Turnover £20m–£300m");
  add(fx > 0 && !hedgingNamed(r) ? rules.open : 0, "No hedging named — probably on the bank's rate");
  add(r.run_from_abroad ? rules.ownedAbroad : 0, "Owned abroad: FX may be run by the parent");
  add(!r.run_from_abroad && ukArmName(r) ? rules.ukArmName : 0, "Name ends in UK — probably a foreign group's UK arm");
  const recentLoss = loss >= rules.lossMin && Boolean(filedOn) && filedOn >= day(rules.recentDays);
  const change = newFd ? "a new FD" : buying ? "buying companies" : pe ? "a private-equity deal" : "";
  if (recentLoss && change) add(rules.combo, `Hit list: a recent FX loss and ${change}`);
  return { score: out.reduce((n, [, p]) => n + p, 0), parts: out,
           flags: { recentLoss, newFd, buying, pe: Boolean(pe), funded: Boolean(funded), hit: Boolean(recentLoss && change) } };
}

// "Lead score 85: FX loss of £320k +30 · … " — the breakdown in one line.
export const leadLine = (s) => `Lead score ${s.score}: ${s.parts.map(([why, p]) => `${why} ${p > 0 ? "+" : "−"}${Math.abs(p)}`).join(" · ")}`;

// Rows with lead_score / lead_parts / lead_reasons attached (sorted by SORTS.lead; lead_reasons for the exports).
export const withLeadScores = (rows, ctx) => rows.map((r) => {
  if (r.dropped) return r;
  const s = leadScore(r, ctx);
  return { ...r, lead_score: s.score, lead_parts: s.parts, lead_flags: s.flags, lead_reasons: s.parts.map(([why, p]) => `${why} ${p > 0 ? "+" : "−"}${Math.abs(p)}`).join("; ") };
});
