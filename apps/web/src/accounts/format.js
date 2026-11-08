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
    // the UK parent's consolidated accounts: the group's treasury often holds the FX
    ["Group", r.group_fx, r.group_fx_url, r.group_parent_accounts],
  ].filter(([, v]) => v);
}

// "Hottest": the strongest FX proof in the company's own filings first; within the same score, the finder's ranking
// (FX evidence + untapped + triggers + a recent FX loss). FX probably run from an overseas parent: ABROAD_POINTS lower,
// within its group. Who to ask for is a quick Google: see "Contact confidence".
export const SORTS = {
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

export const EXPORT_FIELDS = [
  "rank", "section", "qualified", "qualify_reason", "warm_route", "company_name", "company_number",
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
export function filterFilings(rows, { query = "", strongOnly = false, lossOnly = false, movedOnly = false } = {}) {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (!strongOnly || (r.filed_fx_score || 0) >= 50)
    && (!lossOnly || Number(r.fx_gain_loss_gbp) < 0)
    && (!movedOnly || Boolean(r.moved_up))
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

export function filterLosses(rows, { min = 0, query = "", recentDays = 0, unhedged = false, grew = false, today = new Date() } = {}) {
  const q = query.trim().toLowerCase();
  const since = recentDays ? new Date(today.getTime() - recentDays * 864e5).toISOString().slice(0, 10) : "";
  return rows.filter((r) => r.loss >= min
    && (!q || [r.company_name, r.company_number, r.finance_contact, r.currency, r.main_currency, r.currencies_in_accounts,
      r.turnover_regions, r.incumbent_bank, r.fx_niche].some((v) => String(v || "").toLowerCase().includes(q)))
    && (!since || (r.filedOn && r.filedOn >= since))
    && (!unhedged || !hedgingNamed(r))
    && (!grew || lossGrew(r)));
}

export const LOSS_SORTS = {
  biggest: { label: "Biggest loss", key: (r) => -r.loss },
  share: { label: "Biggest share of turnover", key: (r) => -(r.share ?? -1) },
  newest: { label: "Newest filed", key: (r) => -Number((r.filedOn || "0").replace(/-/g, "")) },
  grew: { label: "Grew most on last year", key: (r) => (r.prior === null ? 1e15 : -(r.loss + r.prior)) },
};
export const sortLosses = (rows, by = "biggest") =>
  [...rows].sort((a, b) => LOSS_SORTS[by].key(a) - LOSS_SORTS[by].key(b) || (a.onList === b.onList ? 0 : a.onList ? -1 : 1));
