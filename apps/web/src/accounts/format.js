import { financeSeat, SEAT_LABEL, ownershipOf, OWNERSHIP_LABEL } from "./control.js";
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
                                   contacted = {}, notes = {}, role = "", peOnly = false, opsOnly = false, newFdOnly = false, industry = "", ownership = "", lookalikeOnly = false } = {}) {
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
    (!peOnly || Boolean(peBackedOf(r))) &&
    (!opsOnly || Boolean(overseasOps(r))) &&
    (!lookalikeOnly || lookalike(r)) &&
    (!industry || industryOf(r) === industry) &&
    (!ownership || ownership(r).status === ownership) &&
    (!newFdOnly || Boolean(r.lead_flags?.newFd)) &&
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
      ["Found via", r.found_via, r.found_via_url], ["Exposure", r.fx_exposure], ["Why untapped", r.untapped_reasons],
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
  // Discovery days (Zac's five good finds of 20 Nov 2026 were all Fit 100 but ranked 37th–52nd on timing): the right
  // company first, the timely ones first among equals.
  fitFirst: { label: "Fit first, then Now", key: (r) => -(r.lead_fit || 0) * 1e9 - (r.lead_score || 0) * 1e6 - (r.lead_timing || 0) * 1e3 + (r.rank || 0) },
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
// Groups (Zac, 14 Nov 2026: Cognism files people under the group, and one group showed up as several leads): each
// company's top UK parent from the ownership register (tools/psc_deals.py --groups-out → leads/ranked group_of:
// {number: {top, top_name, hops, abroad}}). hops 0 = it is its own top.
let knownGroups = {};
export const setKnownGroups = (map) => { knownGroups = map || {}; };
export const groupOf = (r) => knownGroups[r.company_number] || null;
// Private-equity backed, and what says so: the finder's / filings scan's own reading (a PE owner on the register, a PE
// house or fund the accounts name as controlling party, buyout-style debt), else a PE house, fund or buyout vehicle
// anywhere up its chain of owners (the daily ownership pass, group_of[number].pe). {name, why} or null.
export function peBackedOf(r) {
  if (r.pe_backed) return { name: r.pe_backed, why: r.pe_backed_evidence || "a private-equity owner on the register" };
  if (r.pe_sponsor) return { name: r.pe_sponsor, why: r.pe_sponsor_evidence ? `accounts: ${r.pe_sponsor_evidence}` : "named in its accounts" };
  const up = groupOf(r)?.pe;
  if (up?.name) return { name: up.name, why: `${up.name} owns it, ${up.hops} level${up.hops === 1 ? "" : "s"} up the ownership register` };
  const owned = /^Owned by (.+?) \(.*— private-equity backed$/.exec(r.owner || "");
  return owned ? { name: owned[1], why: r.owner } : null;
}
export const groupKey = (r) => (groupOf(r)?.hops ? groupOf(r).top : r.company_number);
export const groupName = (r) => (groupOf(r)?.hops ? groupOf(r).top_name || "" : "");
// One row per group: the group's best lead (highest lead score, else first) stands for it, the others listed on it as
// group_members [{company_number, company_name}]. Rows not in a group pass through as they are.
export function collapseGroups(rows) {
  const best = new Map();
  for (const r of rows) {
    const k = groupKey(r);
    const b = best.get(k);
    if (!b) best.set(k, { lead: r, members: [] });
    else if ((r.lead_score || 0) > (b.lead.lead_score || 0)) { b.members.push(b.lead); b.lead = r; }
    else b.members.push(r);
  }
  const keep = new Map([...best.values()].map((b) => [b.lead, b.members]));
  return rows.filter((r) => keep.has(r)).map((r) => (keep.get(r).length
    ? { ...r, group_members: keep.get(r).map((m) => ({ company_number: m.company_number, company_name: m.company_name })) }
    : r));
}
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
// Cognism's company list (search by company, then filter by job title): one row per group — named as the group (its
// top UK parent) with the group's website when Cognism would file the people there, else the company's own — and only
// rows with a confirmed website, the field Cognism matches companies on. Best lead first as given.
export const COGNISM_COMPANY_COLUMNS = [
  ["company_name", "Company Name", 34], ["domain", "Website", 26], ["country", "Country", 14], ["role_to_find", "Job Titles to Find", 30],
  ["registered_company", "Registered Company (lead)", 34], ["group_companies", "Group Companies on the List", 40],
  ["company_number", "Company Number", 15], ["lead_score", "Lead Score", 10, true], ["why_fx", "Why FX", 50],
].map(([key, header, width, number]) => ({ key, header, width, number: Boolean(number) }));
export function cognismCompanyRows(rows) {
  return collapseGroups(rows).map((r) => {
    const g = groupOf(r);
    const groupSite = g?.hops ? knownSites[g.top] || "" : "";
    const site = groupSite || siteOf(r);
    return site && {
      ...cognismRow(r), lead_score: r.lead_score ?? "",
      company_name: (g?.hops && g.top_name) || r.company_name || "", domain: domainOf(site),
      registered_company: r.company_name || "", group_companies: (r.group_members || []).map((m) => m.company_name).join("; "),
      role_to_find: r.no_fd_likely ? "Managing Director; Finance Director" : "Finance Director; CFO; Financial Controller; Head of Finance",
    };
  }).filter(Boolean);
}
export const cognismCsv = (rows) => toCsv(rows.map(cognismRow), COGNISM_FIELDS);

export const EXPORT_FIELDS = ["hidden_from_filters", 
  "company_and_fd", "industry", "ownership", "ultimate_owner", "owner_country", "finance_decided", "what_to_pitch", "my_list", "lead_score", "lead_fit", "lead_timing", "lead_reasons", "lead_checklist", "reasons_not_to_progress", "rank", "section", "qualified", "qualify_reason", "warm_route", "company_name", "company_number",
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
// Where a lead came from (Zac's brief, 19 Nov 2026: measure which sources find companies not already prospected):
// the finder's `found_via` (tools/ch_alerts.py discoveries — a job advert naming currency work, a news story, a charge
// alert), else the FX filings scan, the modern slavery register, the customs records or a niche.
export const LEAD_SOURCES = ["Your niche search", "Like your good leads", "Job advert", "News", "Charge / owner alert", "FX filings", "Emerging niche", "Modern slavery register", "Customs records", "Niche search"];
export function leadSource(r) {
  const via = String(r.found_via || "");
  if (/^niche search:/i.test(via)) return "Your niche search";
  if (/^like /i.test(via)) return "Like your good leads";
  if (/^job advert/i.test(via)) return "Job advert";
  if (/^news/i.test(via)) return "News";
  if (via) return "Charge / owner alert";
  if (r.from_filings || r.fx_niche === "FX in their filed accounts") return "FX filings";
  if (/^Emerging/i.test(r.fx_niche || "")) return "Emerging niche";
  if (/modern slavery/i.test(r.fx_niche || "")) return "Modern slavery register";
  if (r.hmrc_import_months || r.hmrc_export_months) return "Customs records";
  return "Niche search";
}

// What a mark says about a lead (Zac, 23 Nov 2026: "if a bank had an open lead or they were using, I just put them as
// open; the skips were either could not find the finance director at all"): "good" — a new prospect (Good lead,
// Research harder, Added to mine, or put on the call / email / mail list); "taken" — Open lead: not a new prospect;
// "bad" — Not a fit, Owned abroad; "neutral" — Skip (no finance director found); null — unmarked. A review mark (the
// buttons) outranks a verdict, and a list beats both: he means to work it.
export function markClass(n, { checks = {}, verdicts = {}, lists = {} } = {}) {
  const m = checks[n]?.review, v = verdicts[n]?.verdict;
  if (lists[n]?.list) return "good";
  if (m === "abroad") return "bad";
  if (m === "research" || m === "mine") return "good";
  if (m === "open") return "taken";
  if (m === "skip") return "neutral";
  if (v === "good") return "good";
  if (v === "not_fit") return "bad";
  return null;
}
// What Zac's own checks say (the feedback loop): for each source, niche and industry, how many of the leads he judged
// were new prospects (markClass "good") against already open ("taken") or not a fit / owned abroad ("bad") — skips
// (no FD found) aren't a judgement of the company — and the lean the lead score takes from it (LEAD_POINTS review*):
// with reviewMin+ judged, a niche or source at reviewLift × his usual rate or better lifts its leads, one at
// reviewSink × or under lowers them — so the score steers to where new prospects come from, away from where the
// companies are already open. `checks` / `verdicts` / `lists` are the page's own store items.
export function reviewLearnings(rows = [], checks = {}, verdicts = {}, rules = LEAD_POINTS, lists = {}) {
  const groups = { source: {}, niche: {}, industry: {} };
  let reviewed = 0, goods = 0;
  for (const r of rows) {
    const cls = markClass(r.company_number, { checks, verdicts, lists });
    if (!cls || cls === "neutral") continue;
    reviewed += 1;
    if (cls === "good") goods += 1;
    for (const [kind, key] of [["source", leadSource(r)], ["niche", r.fx_niche || "(no niche)"], ["industry", industryOf(r)]]) {
      const g = (groups[kind][key] ||= { key, good: 0, not: 0, taken: 0 });
      g[cls === "good" ? "good" : cls === "taken" ? "taken" : "not"] += 1;
    }
  }
  const usual = reviewed ? Math.round((100 * goods) / reviewed) : 0;
  const lean = { source: {}, niche: {} };
  const done = (kind) => Object.values(groups[kind]).map((g) => {
    const n = g.good + g.not + g.taken, share = Math.round((100 * g.good) / n);
    const points = n < rules.reviewMin || !usual ? 0 : share >= usual * rules.reviewLift ? rules.reviewGood
      : share <= usual * rules.reviewSink ? rules.reviewPoor : 0;
    if (points && lean[kind] && g.key !== "(no niche)") lean[kind][g.key] = { key: g.key, share, reviewed: n, points, usual };
    return { ...g, reviewed: n, good_share: share, points };
  }).sort((a, b) => b.reviewed - a.reviewed);
  return { reviewed, usual, source: done("source"), niche: done("niche"), industry: done("industry"), lean };
}

// Lookalikes by profile (Zac, 22 Nov 2026: "make it incredible" — the customs lookalikes can't help holding companies,
// which trade nothing themselves): each good lead's profile — industry (its group's for a holding company), niche, size
// band, FX proof, holding company, PE-backed, an FX loss, growth, subsidiaries abroad, where we found it — and every other
// lead scored on how much of that profile it shares (the good lead's traits only, weighted: PROFILE_WEIGHTS). One that
// shares LIKE.min of it, its industry or niche among them, gets LEAD_POINTS.likeGood (Fit) with the traits named.
const SIZE_BANDS = ["under £20m", "£20m–£50m", "£50m–£100m", "£100m–£300m", "£300m+"];
export const PROFILE_WEIGHTS = { industry: 3, niche: 3, size: 2, fx: 2, holdco: 2, pe: 1, loss: 1, growth: 1, abroad: 1, source: 1 };
export const LIKE = { min: 0.7, minTraits: 6, maxGood: 150, perLead: 1 };
const GENERIC_NICHE = /^(?:FX in their filed accounts|Broad wholesale \/ trade sector|)$/;
export function leadProfile(r) {
  const t = Number(r.turnover_gbp) || Number(r.turnover_foreign_gbp) || 0;
  const fx = fxScore(r);
  const codes = sicCodes(r);
  const industry = industryOf(r);
  return {
    industry: industry === INDUSTRY_OTHER ? "" : industry,
    niche: GENERIC_NICHE.test(r.fx_niche || "") ? "" : r.fx_niche,
    size: !t ? "" : SIZE_BANDS[t < 20e6 ? 0 : t < 50e6 ? 1 : t < 100e6 ? 2 : t < 300e6 ? 3 : 4],
    fx: fx >= 50 ? "strong FX proof" : fx > 0 ? "some FX proof" : "",
    holdco: codes.length && codes.every(nonTradingCode) ? "a holding company" : "",
    pe: peBackedOf(r) ? "PE-backed" : "",
    loss: (-Number(r.fx_gain_loss_gbp) || 0) >= 50000 ? "an FX loss" : "",
    growth: growthPct(r) >= 20 ? "growing 20%+" : "",
    abroad: r.subsidiaries_abroad ? "subsidiaries abroad" : "",
    source: leadSource(r),
  };
}
// {score 0–1, same: [traits]} — how much of the good lead's profile the candidate shares (a neighbouring size band half).
export function profileMatch(good, cand) {
  let max = 0, got = 0;
  const same = [];
  for (const [k, w] of Object.entries(PROFILE_WEIGHTS)) {
    if (!good[k]) continue;
    max += w;
    if (cand[k] === good[k]) { got += w; if (k !== "source") same.push(good[k]); }
    else if (k === "size" && cand[k] && Math.abs(SIZE_BANDS.indexOf(cand[k]) - SIZE_BANDS.indexOf(good[k])) === 1) got += w / 2;
  }
  const core = (good.industry && cand.industry === good.industry) || (good.niche && cand.niche === good.niche);
  return { score: max >= LIKE.minTraits && core ? got / max : 0, same };
}
const isGoodMark = (checks, verdicts, n, lists = {}) => markClass(n, { checks, verdicts, lists }) === "good";
const isBadMark = (checks, verdicts, n, lists = {}) => markClass(n, { checks, verdicts, lists }) === "bad";
// The good leads among the rows (Zac's marks: new prospects), best rated then newest first: [{company_number,
// company_name, profile}].
export function goodLeads(rows = [], checks = {}, verdicts = {}, lists = {}) {
  const at = (n) => String(lists[n]?.at || checks[n]?.review_at || verdicts[n]?.at || "");
  const rate = (n) => Number(verdicts[n]?.rating) || 0;
  return rows.filter((r) => r.company_number && isGoodMark(checks, verdicts, r.company_number, lists))
    .sort((a, b) => rate(b.company_number) - rate(a.company_number) || at(b.company_number).localeCompare(at(a.company_number))).slice(0, LIKE.maxGood)
    .map((r) => ({ company_number: r.company_number, company_name: r.company_name, profile: leadProfile(r) }));
}
// {company number: {like, like_name, score, same}} — each unmarked lead's closest good lead, when it shares LIKE.min.
export function likeGoodLeads(rows = [], checks = {}, verdicts = {}, lists = {}) {
  const good = goodLeads(rows, checks, verdicts, lists);
  const out = {};
  if (!good.length) return out;
  for (const r of rows) {
    const n = r.company_number;
    if (!n || markClass(n, { checks, verdicts, lists })) continue;
    const p = leadProfile(r);
    let best = null;
    for (const g of good) {
      const m = profileMatch(g.profile, p);
      if (m.score >= LIKE.min && (!best || m.score > best.score)) best = { like: g.company_number, like_name: g.company_name, score: Math.round(m.score * 100) / 100, same: m.same };
    }
    if (best) out[n] = best;
  }
  return out;
}

// Marking many at once (Zac, 22 Nov 2026: the leads he took, pasted from another screen): each line, or each comma-
// separated part, is a company number or a registered name (Ltd / Limited / punctuation aside; a unique prefix will do).
// {matched: [{text, row}], unmatched: [text]} — the page then marks the matched ones itself; nothing else is read.
const nameKey = (s) => String(s || "").toUpperCase().replace(/&/g, " AND ").replace(/\b(?:LIMITED|LTD|PLC|LLP)\b\.?/g, " ")
  .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export function matchCompanies(text = "", rows = []) {
  // each line as written first ("360 BRAND GROUP LTD" is a name, not a numbered list), then with a list number dropped
  // ("12. ACME LIMITED", "3) ACME")
  const items = String(text).split(/[\n;]+|,(?![^(]*\))/).map((t) => t.replace(/\s+£[\d.,]+m?.*$/i, "").trim()).filter(Boolean);
  const byNumber = new Map(rows.map((r) => [String(r.company_number || "").toUpperCase(), r]));
  const byName = new Map();
  for (const r of rows) { const k = nameKey(r.company_name); if (k && !byName.has(k)) byName.set(k, r); }
  const keys = [...byName.keys()];
  const find = (text) => {
    const num = text.replace(/\s/g, "").toUpperCase();
    if (/^[A-Z]{0,2}\d{6,8}$/.test(num)) return byNumber.get(num.padStart(8, "0")) || byNumber.get(num) || null;
    // a name cut short on screen ("PROJECT TWENTY TOPCO LIMIT…"): its last, partial word dropped, then a unique prefix
    const cut = /(?:…|\.\.\.)\s*$/.test(text);
    const k = nameKey(cut ? text.replace(/\s*\S*(?:…|\.\.\.)\s*$/, "") : text);
    let row = byName.get(k) || null;
    if (!row && (k.length >= 6 || cut)) { const hits = keys.filter((x) => x.startsWith(k)); if (hits.length === 1) row = byName.get(hits[0]); }
    return row;
  };
  const matched = [], unmatched = [], seen = new Set();
  for (const text of items) {
    const listed = text.replace(/^\d{1,4}\s*[.)\-:]\s*(?=\S)/, "");
    const row = find(text) || (listed !== text ? find(listed) : null);
    if (row && !seen.has(row.company_number)) { seen.add(row.company_number); matched.push({ text, row }); } else if (!row) unmatched.push(text);
  }
  return { matched, unmatched };
}

// Several marks in one paste: a heading line names the mark for the names under it — "Added to mine:", "Open lead:",
// "Owned abroad:", "Not a fit:" or "Not a fit (No real FX):" (the reason one of VERDICT_REASONS' words); names before
// any heading take `fallback`. [{mark: {review} | {verdict: "not_fit", reason}, label, text}] in the order given.
export const MARK_HEADINGS = [[/^added to mine$/i, { review: "mine" }, "Added to mine"], [/^open lead$/i, { review: "open" }, "Open lead"],
  [/^owned abroad$/i, { review: "abroad" }, "Owned abroad"], [/^good lead$/i, { verdict: "good" }, "Good lead"],
  [/^skip(?:ped)?$/i, { review: "skip" }, "Skipped"], [/^research(?: harder)?$/i, { review: "research" }, "Research harder"]];
export function markSections(text = "", fallback = { review: "mine" }) {
  const out = [];
  let cur = { mark: fallback, label: MARK_HEADINGS.find(([, m]) => JSON.stringify(m) === JSON.stringify(fallback))?.[2] || "Added to mine", text: "" };
  for (const line of String(text).split(/\n/)) {
    const h = line.trim().replace(/:$/, "").trim();
    const known = MARK_HEADINGS.find(([re]) => re.test(h));
    const notFit = /^not a fit(?:\s*[(—-]\s*([^)]*?)\s*\)?)?$/i.exec(h);
    if (known || notFit) {
      if (cur.text.trim()) out.push(cur);
      cur = known ? { mark: known[1], label: known[2], text: "" }
        : { mark: { verdict: "not_fit", reason: notFit[1] || "" }, label: `Not a fit${notFit[1] ? ` (${notFit[1]})` : ""}`, text: "" };
      continue;
    }
    cur.text += `${line}\n`;
  }
  if (cur.text.trim()) out.push(cur);
  return out;
}

// The scoreboard (Zac, 22 Nov 2026): for each source, niche and industry, how many live leads it has, how many fit well
// (Fit 60+), how many he has checked and how many of those were good — so the finding effort goes where his good leads
// come from — and the well-fitting leads still waiting for a look. [{key, leads, fit60, checked, good, not, good_share,
// waiting}] per kind, most good first.
export function scoreboard(rows = [], checks = {}, verdicts = {}, lists = {}) {
  const kinds = { source: (r) => leadSource(r), niche: (r) => r.fx_niche || "(no niche)", industry: (r) => industryOf(r) };
  const out = {};
  for (const [kind, keyOf] of Object.entries(kinds)) {
    const by = {};
    for (const r of rows) {
      if (!r.company_number || r.dropped) continue;
      const g = (by[keyOf(r)] ||= { key: keyOf(r), leads: 0, fit60: 0, checked: 0, good: 0, not: 0, waiting: 0 });
      const cls = markClass(r.company_number, { checks, verdicts, lists });
      const good = cls === "good", bad = cls === "bad" || cls === "taken";
      if (good) g.good += 1;
      if (bad) g.not += 1;
      if (good || bad) g.checked += 1;
      if (isOut(r) && !good) continue;
      g.leads += 1;
      if ((r.lead_fit || 0) >= 60) { g.fit60 += 1; if (!good && !bad) g.waiting += 1; }
    }
    out[kind] = Object.values(by).map((g) => ({ ...g, good_share: g.checked ? Math.round((100 * g.good) / g.checked) : null }))
      .sort((a, b) => b.good - a.good || (b.good_share ?? -1) - (a.good_share ?? -1) || b.fit60 - a.fit60);
  }
  return out;
}

// Teams abroad (the feedback-loop brief's idea 2): subsidiaries the accounts place in an offshore delivery hub — software
// and engineering teams in Eastern Europe or India, call centres in South Africa or the Philippines … — or a job advert
// naming a team, office or payroll there. {countries, text} or null.
export const OFFSHORE_HUBS = ["Poland", "Romania", "Bulgaria", "Ukraine", "Serbia", "Czech Republic", "Czechia", "Hungary",
  "Slovakia", "Lithuania", "Latvia", "Estonia", "Croatia", "North Macedonia", "Bosnia", "Moldova", "Belarus", "Georgia",
  "Armenia", "India", "Sri Lanka", "Pakistan", "Bangladesh", "Philippines", "Vietnam", "Malaysia", "Indonesia",
  "South Africa", "Egypt", "Morocco", "Tunisia", "Kenya", "Nigeria", "Mexico", "Colombia", "Argentina", "Brazil", "Costa Rica"];
const HUB_RE = new RegExp(`\\b(${OFFSHORE_HUBS.join("|")})\\b`, "i");
const OPS_WORDS = /\b(offshore|nearshore|overseas payroll|international payroll|global payroll|(?:team|office|centre|center|hub|developers?|engineers?|operations) (?:in|based in) (?:Poland|Romania|Bulgaria|Ukraine|India|Philippines|South Africa|Sri Lanka|Vietnam|Egypt|Mexico|Colombia))\b/i;
export function overseasOps(r) {
  const countries = [...new Set(String(r.subsidiaries_abroad || "").split(",").map((c) => c.replace(/\(.*\)/, "").trim())
    .filter((c) => HUB_RE.test(c)))];
  const advert = OPS_WORDS.test(String(r.found_via || "")) ? "a job advert names a team or payroll abroad" : "";
  if (!countries.length && !advert) return null;
  return { countries, text: [countries.length ? `teams in ${countries.join(", ")}` : "", advert].filter(Boolean).join("; ") };
}

// Hidden from the usual filters (Zac, 21 Nov 2026: "everyone uses Market IQ or Zint — we want companies that aren't on
// there"): every company is on the register those tools are built from, but a standard search (turnover £20m+, a
// manufacturing / wholesale sector code, an importer flag) can't see some of them. Each reason says which filter drops it.
export const HIDDEN_KINDS = [
  ["no_turnover", "No turnover filed"], ["group", "Sized by its group"], ["foreign", "Accounts in another currency"],
  ["scanned", "Scanned accounts"], ["sector", "Sector code hides it"], ["new", "Too new for the filters"],
  ["found", "Found by goods or wording"],
];
const HIDING_SIC = { "70100": "head office", "64209": "holding company", "64205": "holding company", "64201": "holding company",
  "64202": "holding company", "64203": "holding company", "64204": "holding company", "82990": "other business support",
  "74909": "other professional activities", "74990": "non-trading", "96090": "other services", "99999": "dormant",
  "68209": "letting property", "68100": "property dealing" };
export function hiddenFromFilters(r, today = new Date()) {
  const out = [];
  const add = (key, text) => out.push({ key, label: HIDDEN_KINDS.find(([k]) => k === key)[1], text });
  const turnover = Number(r.turnover_gbp) || 0;
  if (r.turnover_basis === "group") add("group", "its own accounts look small — the group's turnover sizes it, so a turnover filter on the company drops it");
  // only when the filing really has none (filleted / no profit and loss account), not when we just haven't read it
  else if (!turnover && !Number(r.turnover_foreign_gbp) && !/not read|not checked/i.test(r.turnover_check || "")
           && (r.turnover_check || r.size_estimate)) add("no_turnover", `no turnover in its filed accounts${r.size_estimate ? ` (${r.size_estimate})` : ""} — a turnover filter drops it`);
  if (r.reporting_currency || Number(r.turnover_foreign_gbp)) add("foreign", `accounts kept in ${String(r.reporting_currency || "another currency").replace(/^(\w{3}).*$/, "$1")} — a sterling turnover filter misses it`);
  if (r.accounts_format && r.accounts_format !== "ixbrl") add("scanned", "accounts filed as a scanned document — no figures in the databases' feeds (we read them by OCR)");
  const codes = sicCodes(r);
  if (codes.length && codes.every((c) => HIDING_SIC[c.padStart(5, "0")])) {
    const act = groupActivity(r);
    add("sector", `filed as ${HIDING_SIC[codes[0].padStart(5, "0")]} (${codes[0]}) — a sector search for traders or makers misses it${act ? `; the group trades as ${industryOf(r).toLowerCase()} through ${activityLine(act)}` : ""}`);
  }
  const inc = /^\d{4}-\d{2}-\d{2}/.test(r.incorporated_on || "") ? new Date(`${r.incorporated_on.slice(0, 10)}T00:00:00Z`) : null;
  if (r.moved_up) add("new", "moved up from small accounts this year — last year it was below every size filter");
  else if (inc && (today - inc) / 86_400_000 < 3 * 365) add("new", `incorporated ${r.incorporated_on.slice(0, 4)} — too new for most size filters`);
  const src = leadSource(r);
  if (["Job advert", "Your niche search", "Like your good leads"].includes(src)) add("found", `found through ${src === "Job advert" ? "a job advert naming currency work" : src === "Your niche search" ? "the goods in its customs records" : "the goods your good leads trade"}, not a database filter`);
  return out;
}

// New leads (Zac, 18 Nov 2026: "make a section which is new leads"): the day a company joined our lists — the finder's
// upload stamps first_seen; the FX filings scan lists a company the day its accounts are filed, so its filing date.
export const NEW_LEAD_DAYS = [3, 7, 14, 30];
export const addedOn = (r) => (/^\d{4}-\d{2}-\d{2}/.test(r.first_seen || "") ? r.first_seen.slice(0, 10) : filedIso(r));
export function newLead(r, days, today = new Date()) {
  const on = addedOn(r);
  if (!on) return false;
  return (today - new Date(`${on}T00:00:00Z`)) / 86_400_000 <= days;
}

// Fresh finds (Zac, 22 Nov 2026 — the phone layout's second section): the leads few bankers have seen, in one list.
// Why each is fresh: new on the lists in the last FRESH_DAYS (not a fresh FX filing — every bank reads those), found by a
// quiet source (a job advert, his Niche search, a lookalike of a good lead, an emerging niche), in a niche few bankers
// search, or hidden from the usual Zint / Market IQ filters.
export const FRESH_DAYS = 14;
export const QUIET_SOURCES = ["Job advert", "Your niche search", "Like your good leads", "Emerging niche"];
export const FRESH_KINDS = [["new", "New on the lists"], ["source", "Found by a quiet source"], ["niche", "A niche few bankers search"],
  ["hidden", "Hidden from the usual filters"]];
export function freshFind(r, today = new Date()) {
  const source = leadSource(r);
  const out = [];
  if (source !== "FX filings" && newLead(r, FRESH_DAYS, today)) out.push("new");
  if (QUIET_SOURCES.includes(source)) out.push("source");
  if (/^(?:Emerging|Proven trader)\b/i.test(r.fx_niche || "")) out.push("niche");
  if (hiddenFromFilters(r).length) out.push("hidden");
  return out;
}

// Today's list (Zac, 22 Nov 2026: "just the best ranked companies — company name, Companies House, Google it, check for
// FD, and small buttons: tick good lead, X not enough revenue, orange open, blue call list"): the best leads he hasn't
// marked, best lead score first — not contacted, no review / verdict / list on it or on any company in its group (he has
// judged the group), not out, no serious reason not to progress, Fit FIT.min+, one per group. A mark takes a lead off
// and the next one moves up.
export const TODAYS_LIST = 25;
// Owned abroad and Skip (Zac, 23 Nov 2026: "add the buttons current client and owned abroad"). What he means by them
// (Zac, 23 Nov 2026): Open lead — already open, not a new prospect; Skip — no finance director found (no judgement of the
// company). The scanner learns from them that way (markClass).
export const TODAYS_MARKS = [
  ["good", "✓", "Good lead"], ["research", "?", "Good lead, no contact info: research harder"], ["small", "✕", "Not enough revenue"],
  ["open", "●", "Open lead (already open)"], ["call", "☎", "Call list"], ["abroad", "✈\uFE0E", "Owned abroad"], ["skip", "»", "Skip (no FD found)"],
];
// The Research harder list (Zac, 23 Nov 2026: "good lead but no contact info and add it to a research harder section"):
// marked "research" (a good lead in the feedback loop), not put on a list since, not out; newest mark first.
export function researchList(rows, { checks = {}, lists = {}, contacted = {} } = {}) {
  return rows.filter((r) => checks[r.company_number]?.review === "research" && !lists[r.company_number] && !contacted[r.company_number] && !isOut(r))
    .sort((a, b) => String(checks[b.company_number].review_at || "").localeCompare(String(checks[a.company_number].review_at || "")));
}
export function todaysList(rows, { contacted = {}, checks = {}, verdicts = {}, lists = {} } = {}) {
  const marked = (n) => contacted[n] || checks[n]?.review || verdicts[n] || lists[n];
  const judged = new Set(rows.filter((r) => marked(r.company_number)).map(groupKey));
  const seen = new Set();
  return rows
    .filter((r) => !r.dropped && !isOut(r) && (r.lead_fit || 0) >= FIT.min && !judged.has(groupKey(r))
      && !reasonsNotToProgress(r).some((x) => x.serious))
    .sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0) || (b.lead_fit || 0) - (a.lead_fit || 0))
    .filter((r) => { const k = groupKey(r); if (seen.has(k)) return false; seen.add(k); return true; });
}
// How many leads he marked today (any of the four buttons, or a mark made elsewhere).
export function markedToday({ checks = {}, verdicts = {}, lists = {} } = {}, today = new Date().toISOString().slice(0, 10)) {
  const n = new Set();
  for (const [k, v] of Object.entries(checks)) if (String(v?.review_at || "").startsWith(today)) n.add(k);
  for (const [k, v] of Object.entries(verdicts)) if (String(v?.at || "").startsWith(today)) n.add(k);
  for (const [k, v] of Object.entries(lists)) if (String(v?.at || "").startsWith(today)) n.add(k);
  return n.size;
}
export const googleCompany = (r) => "https://www.google.com/search?" + new URLSearchParams({ q: r.company_name || "" });

export function filedIso(r) {
  const f = r.accounts_filed_on || r.filed || "";
  if (/^\d{4}-\d{2}-\d{2}/.test(f)) return f.slice(0, 10);
  const m = /^([A-Z][a-z]+) (\d{4})$/.exec(f);
  return m && MONTH_NAMES.includes(m[1]) ? `${m[2]}-${String(MONTH_NAMES.indexOf(m[1]) + 1).padStart(2, "0")}-01` : "";
}

// Hedging named in the company's own accounts: its forward contracts, or "Uses …" (forwards, options, a provider).
// turnover growth on last year in % ("+54%" → 54), NaN when not known
export const growthPct = (r) => parseFloat(String(r?.turnover_growth || "").replace(/[+%,\s]/g, ""));
// "Like Global Charter" (Zac's best lead from his first review, 16 Nov 2026): UK-owned, £20m–£100m, an FX loss of £50k+,
// no hedging named, still growing — the closest matches to the profile that converts
export function lookalike(r) {
  const t = Number(r.turnover_gbp) || Number(r.turnover_foreign_gbp) || 0;
  return t >= 20e6 && t <= 100e6 && (-Number(r.fx_gain_loss_gbp) || 0) >= 50000 && !hedgingNamed(r)
    && growthPct(r) > 0 && !foreignOwned(r) && !ukNamed(r);
}
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
    if (reasonsNotToProgress(r, { today, signals: lead.signals || knownSignals }).some((x) => x.serious)) return null;
    const loss = -Number(r.fx_gain_loss_gbp) || 0;
    const filedOn = filedIso(r);
    const recentLoss = Boolean(r.recent_fx_loss) || (loss >= rules.minLoss && Boolean(filedOn) && filedOn >= since);
    const row = onList ? r : filingRow(r);
    const lead_ = leadScore(row, { ...lead, today });   // the order: the lead score (LEAD_POINTS), its reasons shown
    const trigger = parts(r.triggers)[0] || lead_.flags.moment || "";
    if (!recentLoss && !trigger) return null;
    const fx = r.fx_forwards || r.fx_today || r.currencies_in_accounts || r.turnover_regions || "";
    const why = [
      recentLoss && `FX loss of ${money(loss)} in accounts filed ${filedWhen(filedOn)}`,
      trigger,
      `Filed FX proof ${fxScore(r)}${fx ? `: ${fx}` : ""}`,
      r.run_from_abroad && "Owned abroad: pitch the UK team",
    ].filter(Boolean);
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
// Each company's signals as the page last loaded them (?view=signals), for the reasons not to progress wherever shown.
let knownSignals = {};
export const setKnownSignals = (map) => { knownSignals = map || {}; };
export function reasonsNotToProgress(r, { today = new Date(), signals = knownSignals } = {}) {
  const out = [];
  const add = (text, serious = false) => out.push({ text, serious });
  const t = Number(r.turnover_gbp) || 0;
  const trouble = (signals[r.company_number] || []).find((s) => HOLD_OFF_KINDS.includes(s.kind));
  if (ukNamed(r)) add("“UK” in its name — kept in the UK in name tab, out of the other lists", true);
  else if (foreignOwned(r)) add(`Owned from abroad${ownership(r).owner ? ` (${ownership(r).owner}${ownership(r).country ? `, ${ownership(r).country}` : ""})` : ""} — kept in the Foreign-owned tab, out of the other lists`, true);
  if (trouble) add(`${trouble.title}${trouble.at ? ` (${String(trouble.at).slice(0, 10)})` : ""} — hold off`, true);
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
// --- Industry (Zac, 15 Nov 2026: "a type of company section, ie what industry") ------------------------------------
// From the company's own sector codes (SIC 2007, first code): the register's division, wholesale split by what it sells.
export const INDUSTRY_OTHER = "Other / not known";
const WHOLESALE = { 461: "Trade agents & brokers", 462: "Wholesale: agricultural goods & live animals",
  463: "Wholesale: food, drink & tobacco", 464: "Wholesale: household & consumer goods", 465: "Wholesale: IT & electronics",
  466: "Wholesale: machinery & equipment", 467: "Wholesale: fuel, metals, chemicals & materials", 469: "Wholesale: general" };
const DIVISIONS = [
  [1, 3, "Farming, forestry & fishing"], [5, 9, "Mining & quarrying"], [10, 12, "Manufacturing: food, drink & tobacco"],
  [13, 15, "Manufacturing: textiles & clothing"], [16, 18, "Manufacturing: wood, paper & print"],
  [19, 22, "Manufacturing: chemicals, pharma & plastics"], [23, 25, "Manufacturing: metals & minerals"],
  [26, 27, "Manufacturing: electronics & electrical"], [28, 28, "Manufacturing: machinery"],
  [29, 30, "Manufacturing: vehicles & transport equipment"], [31, 33, "Manufacturing: furniture & other"],
  [35, 39, "Energy, water & waste"], [41, 43, "Construction"], [45, 45, "Motor trade"], [46, 46, "Wholesale"],
  [47, 47, "Retail"], [49, 53, "Transport, logistics & freight"], [55, 56, "Hotels & food service"],
  [58, 63, "Media, telecoms & IT"], [64, 66, "Finance & insurance"], [68, 68, "Property"],
  [69, 75, "Professional services"], [77, 82, "Business support & rental"], [84, 88, "Public sector, education & health"],
  [90, 99, "Leisure & other services"],
];
export const sicCodes = (r) => String(Array.isArray(r.sic) ? r.sic.join(" ") : r.sic || r.sic_codes || "").match(/\d{4,5}/g) || [];
// A holding company's own codes (head office, holding company, financial services, dormant) say nothing about what it
// trades; its trading subsidiaries' do (the daily ownership pass reads down the register: group_of[number].activity =
// {sic, subs, names, niche} — tools/psc_deals.py, sourcer/owners.group_activity). That group's activity, or null.
const nonTradingCode = (c) => { const n = String(c).padStart(5, "0"); return Boolean(HIDING_SIC[n]) || ["64", "66"].includes(n.slice(0, 2)) || n.startsWith("701"); };
export function groupActivity(r) {
  const a = groupOf(r)?.activity;
  if (!a?.sic?.length) return null;
  const own = sicCodes(r);
  return !own.length || own.every(nonTradingCode) ? a : null;
}
export const activityLine = (a) => (a ? `its ${a.subs} trading subsidiar${a.subs === 1 ? "y" : "ies"}${a.names?.length ? ` (${a.names.slice(0, 2).join(", ")}${a.subs > 2 ? " …" : ""})` : ""}` : "");
export function industryOf(r) {
  const code = (groupActivity(r)?.sic || sicCodes(r))[0];
  if (!code) return INDUSTRY_OTHER;
  const n = code.padStart(5, "0");
  const div = Number(n.slice(0, 2));
  if (div === 46) return WHOLESALE[Number(n.slice(0, 3))] || "Wholesale: general";
  return DIVISIONS.find(([a, b]) => div >= a && div <= b)?.[2] || INDUSTRY_OTHER;
}
export const INDUSTRIES = [...new Set([...DIVISIONS.flatMap(([, , l]) => (l === "Wholesale" ? Object.values(WHOLESALE) : [l])), INDUSTRY_OTHER])];

export const SHEET_COLUMNS = [
  ["company", "Company", (r) => r.company_name, (r) => r.company_name || ""],
  ["industry", "Industry", (r) => industryOf(r), (r) => industryOf(r)],
  ["lead", "Score", (r) => (r.lead_score !== undefined ? String(r.lead_score) : ""), (r) => -(r.lead_score || 0), true],
  ["fit", "Fit", (r) => (r.lead_fit !== undefined ? String(r.lead_fit) : ""), (r) => -(r.lead_fit || 0), true],
  ["owner", "Owner", (r) => { const o = ownership(r); return o.status === "unknown" ? "?" : `${OWNERSHIP_LABEL[o.status]}${o.status === "foreign" ? ` (${o.country})` : ""}`; },
   (r) => ({ uk: 0, unknown: 1, foreign: 2 }[ownership(r).status]), false],
  ["seat", "Decided", (r) => SEAT_LABEL[financeSeat(r).lean], (r) => ({ abroad: 3, unclear: 2, uk: 1, "uk-owned": 0 }[financeSeat(r).lean]), false],
  ["timing", "Now", (r) => (r.lead_timing !== undefined ? String(r.lead_timing) : ""), (r) => -(r.lead_timing || 0), true],
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

// The Simplified dash (Zac, 20 Nov 2026: "company name, CH number, type of company, P&L sheet style — change nothing in
// how it works, just how it looks"): the same leads as the Accounts list laid out like a profit and loss sheet. Each
// column: [key, header, display, sort key, numeric, export value]. Gross profit is turnover less cost of sales, and
// shown only when both were filed.
const num = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const grossProfit = (r) => { const t = num(r.turnover_gbp), c = num(r.cost_of_sales_gbp); return t !== null && c !== null && c > 0 ? t - c : null; };
const signed = (v) => (v === null ? "" : `${v < 0 ? "−" : "+"}${money(Math.abs(v))}`);
const figure = (key, header, get, fmt = money) => [key, header, (r) => { const v = get(r); return v === null ? "" : fmt(v); },
  (r) => { const v = get(r); return v === null ? 1e18 : -v; }, true, (r) => get(r) ?? ""];
export const SIMPLE_COLUMNS = [
  ["company", "Company", (r) => r.company_name, (r) => r.company_name || "", false, (r) => r.company_name || ""],
  ["number", "CH number", (r) => r.company_number || "", (r) => r.company_number || "", false, (r) => r.company_number || ""],
  ["industry", "Type of company", (r) => industryOf(r), (r) => industryOf(r), false, (r) => industryOf(r)],
  figure("turnover", "Turnover", (r) => num(r.turnover_gbp) ?? num(r.turnover_foreign_gbp)),
  figure("prior", "Prior year", (r) => turnoverYears(r).prior || null),
  ["growth", "Growth", (r) => r.turnover_growth || "", (r) => -(parseFloat(r.turnover_growth) || -1e9), true, (r) => r.turnover_growth || ""],
  figure("cos", "Cost of sales", (r) => num(r.cost_of_sales_gbp)),
  figure("gp", "Gross profit", grossProfit),
  ["margin", "Gross margin", (r) => { const g = grossProfit(r); return g === null ? "" : `${Math.round((g / Number(r.turnover_gbp)) * 100)}%`; },
   (r) => { const g = grossProfit(r); return g === null ? 1e9 : -(g / Number(r.turnover_gbp)); }, true,
   (r) => { const g = grossProfit(r); return g === null ? "" : `${Math.round((g / Number(r.turnover_gbp)) * 100)}%`; }],
  figure("fx", "FX gain/loss", (r) => num(r.fx_gain_loss_gbp), signed),
  figure("cash", "Cash", (r) => num(r.cash_gbp)),
  figure("debt", "Bank borrowing", (r) => num(r.bank_borrowings_gbp)),
  figure("assets", "Net assets", (r) => num(r.net_assets_gbp)),
  figure("staff", "Staff", (r) => num(r.employees), (v) => v.toLocaleString("en-GB")),
  figure("score", "Score", (r) => num(r.lead_score), String),
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
  subsidiaries: 10, open: 5, ownedAbroad: -10, runAbroad: -20, decidesHere: 5,
  // Zac, 13 Nov 2026: "if a company is NAME then UK, score it lower — it's obviously got an overseas owner"
  ukArmName: -10,
  // The feedback loop (Zac's origination ideas, 21 Nov 2026: "use previously identified successful prospects to teach
  // the scanner"): his own marks (markClass) — Good lead / Research harder / Added to mine / a list count as new
  // prospects; Open lead, Not a fit and Owned abroad as not; Skip (no FD found) not at all — give each niche and source
  // a new-prospect rate (`reviewLearnings`); with reviewMin+ judged, one at reviewLift × his usual rate lifts its leads,
  // one at reviewSink × or under lowers them (23 Nov 2026: Open means already open, so it stopped counting as good).
  // Nothing from the CRM: only his clicks on this page.
  // Overseas operations (Zac's origination ideas, 21 Nov 2026: "UK software companies paying developers in Poland,
  // call centres in South Africa, outsourcing to the Philippines or Eastern Europe"): teams in an offshore hub mean
  // payroll and supplier payments abroad every month — FX found through what a company does, not its sector code.
  overseasOps: 8,
  hidden: 10,          // hidden from the usual database filters (hiddenFromFilters): fewer people calling them (8 until
                       // 22 Nov 2026: 38% of the leads Zac took had a sector code that hides them, v 23% of the top 300)
  quietNiche: 6,       // an emerging niche or a customs-goods trader niche: few bankers search them (his picks 20% v 7%)
  likeGood: 8,         // shares most of a good lead's profile (likeGoodLeads): industry / niche, size, FX proof, structure
  reviewGood: 8, reviewPoor: -8, reviewMin: 5, reviewLift: 1.5, reviewSink: 0.5,
  // Deals (Zac, 12 Nov 2026: "filed recently with an FX loss and a new FD, or purchasing subsidiaries … just funded or
  // just bought by PE"): buying companies 15, bought by private equity 15, just funded 10, a new overseas owner or an
  // employee ownership trust 10, and the hit-list combo — a recent FX loss with a new FD / a purchase / a PE deal — 15.
  buying: 15, peBought: 15, funded: 10, newOwner: 10, combo: 15, fdInAccountsDays: 365,
  // Zac, 15 Nov 2026 ("improve the FD, PE-backed and private equity companies"): private-equity backed at all — a PE
  // owner anywhere up the chain, a PE house or fund named in the accounts, buyout-style debt — 10 (a fresh PE deal's
  // 15 instead when there is one); a finance director / CFO advertised counts as a new FD (20).
  peBacked: 10,
  // Moments (Zac, 14 Nov 2026: "a company that just got funded, a new FD, large FX losses — let's think of more"). Each
  // fades with age: full points for fullDays, down to half by halfDays, half until momentDays, then nothing.
  fundingRound: 15, sharesAllotted: 8, articles: 5, bankSwitch: 15, auditorChanged: 8, yearEndChanged: 8,
  directorAbroad: 5, newTrader: 20, newFlow: 15, tradeUp: 10, fullDays: 30, halfDays: 90, momentDays: 120,
  // from the company's own accounts: overseas share up 5+ points on last year, a gain turned into a £25k+ loss,
  // forward contracts maturing within a year (renewal coming)
  overseasRising: 10, overseasRiseMin: 5, fxSwing: 10, fxSwingMin: 25000, forwardsMaturing: 5,
  // its main currency (from its own documents) moved 3%+ in a week or 5%+ in a month against the pound (ECB rates)
  currencyMoved: 10, moveWeek: 3, moveMonth: 5,
  // an insolvency filing or case, or a winding-up petition: hold off
  insolvency: -60,
  // From Zac's first review (16 Nov 2026 — Global Charter, "the best so far", ranked 77th: growing 54%, a USD loss, no
  // hedging named, a new equipment-finance lender): growth 20%+ 10 (40%+ 15), an FX loss with no hedging named 10, and
  // a new charge — new borrowing or a new lender — 15 rather than a plain change's 10.
  growth: 10, fastGrowth: 15, growthMin: 20, fastGrowthMin: 40, lossNoHedge: 10, newLender: 15,
};
// Fit and Timing (Zac, 15 Nov 2026: "do the fit and timing split"): each lead's reasons count in Fit (the right
// company — FX proof and pain, size, niche, ownership; 0–100) or Timing (why call now — moments, deals, a new FD, a
// recent filing; 0–100). The ranking (lead_score): a lead with Fit FIT.min+ scores base + fitWeight × Fit + timingWeight
// × Timing (32–100), so among good fits the timely ones come first; one under it scores Fit ÷ 2 (under 15), below them all.
// Second recalibration (Zac's review of 22 Nov 2026): of the top 300 by lead score he took 9 — the rest were already
// known to the bank. The 21 he took had a lower Now (median 20 v 30: a freshly filed FX loss draws every bank) at the
// same Fit, so Timing weighs 0.3, not 0.5 (simulated on the day's ranking: his picks' median rank 383 → 275).
// The same review: his picks and the leads already known to the bank were both at Fit ~91–100, where the cap made them
// equal — so the signs of a lead few bankers see (hidden from the usual filters, a quiet niche, like a good lead of his,
// his checks' lean) count over the cap in the ranking, up to quietMax (lead_fit as shown stays 0–100).
export const FIT = { min: 30, base: 20, fitWeight: 0.3, timingWeight: 0.3, quietMax: 30 };
// The signal kinds that are moments (above), each with its points key; the strongest of a group counts once.
export const MOMENT_KINDS = {
  funding_round: "fundingRound", shares_allotted: "sharesAllotted", articles_changed: "articles", bank_switch: "bankSwitch",
  auditor_changed: "auditorChanged", year_end_changed: "yearEndChanged", director_abroad: "directorAbroad",
  new_trader: "newTrader", new_import: "newFlow", new_export: "newFlow", trade_up: "tradeUp",
};
const MOMENT_GROUPS = [["funding_round", "shares_allotted", "articles_changed"], ["new_trader", "new_import", "new_export", "trade_up"]];
export const HOLD_OFF_KINDS = ["insolvency", "petition"];
// 1 → 0.5 → 0 as a moment ages (rules.fullDays / halfDays / momentDays).
export function fade(at, today = new Date(), rules = LEAD_POINTS) {
  const t = Date.parse(String(at || "").slice(0, 10));
  if (!Number.isFinite(t)) return 0;
  const age = (today.getTime() - t) / 864e5;
  if (age <= rules.fullDays) return 1;
  if (age <= rules.halfDays) return 1 - (0.5 * (age - rules.fullDays)) / (rules.halfDays - rules.fullDays);
  return age <= rules.momentDays ? 0.5 : 0;
}
const pct = (v) => (v === undefined || v === null || v === "" ? null : parseFloat(String(v)));
// "USD" from a row's main currency when it comes from the company's own documents (not the niche's default).
export function ownCurrency(r) {
  if (/niche default/i.test(r.currency_source || "")) return "";
  const code = String(r.main_currency || r.currency || "").match(/\b[A-Z]{3}\b/)?.[0] || "";
  return code === "GBP" ? "" : code;
}
// {code: {"1w", "1m", as_of}} from the market moves document (/api/market).
export const movesByCurrency = (market) => Object.fromEntries((market?.currencies || []).map((c) => [c.code, { ...c.changes, as_of: market.as_of }]));
export const FORWARDS_DUE = /within\s+(?:one|1|twelve|12)\s+(?:year|months)|(?:less than|under)\s+(?:one|1)\s+year|matur\w*\s+(?:with)?in\s+(?:the\s+)?(?:next\s+)?(?:12|twelve)\s+months|(?:matur|expir|settl)\w*[^.;]{0,40}\bwithin\s+(?:one|a|1)\s+year/i;
// The accounts' own changes: overseas share rising, an FX gain turned to a loss, forwards maturing within a year.
export function accountsMoments(r, rules = LEAD_POINTS) {
  const out = [];
  const now = pct(r.overseas_turnover_share), before = pct(r.overseas_turnover_share_prior);
  if (now !== null && before !== null && now - before >= rules.overseasRiseMin) {
    out.push([rules.overseasRising, `Overseas sales up: ${Math.round(now)}% of turnover v ${Math.round(before)}% last year`]);
  }
  const fx = Number(r.fx_gain_loss_gbp), prior = r.fx_gain_loss_prior_gbp === undefined || r.fx_gain_loss_prior_gbp === "" ? NaN : Number(r.fx_gain_loss_prior_gbp);
  if (Number.isFinite(fx) && Number.isFinite(prior) && prior > 0 && -fx >= rules.fxSwingMin) {
    out.push([rules.fxSwing, `FX swung from a ${money(prior)} gain to a ${money(-fx)} loss`]);
  }
  const fwd = `${r.fx_forwards_evidence || ""} ${r.fx_forwards || ""}`;
  if (r.fx_forwards && (r.fx_forwards_due === "yes" || FORWARDS_DUE.test(fwd))) out.push([rules.forwardsMaturing, "Forward contracts maturing within a year — renewal coming"]);
  return out;
}
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
// "UK" (or U.K. / (UK)) as a word anywhere in the registered name (Zac, 15 Nov 2026: "move every company that has UK in
// the name to its own section, remove it from the others") — not UKAY or PUK.
export const UK_NAME = /(?:^|[^A-Z0-9])\(?U\.?K\.?\)?(?=[^A-Z0-9]|$)/i;
export const ukNamed = (r) => UK_NAME.test(String(r?.company_name || ""));
export const ukArmName = (r) => UK_ARM.test(String(r.company_name || "").trim()) && !peopleOwned(r);
const NEW_FD = /\bnew (?:finance director|FD|CFO|chief financial officer)|\b(?:finance director|CFO|chief financial officer)\b[^.;]*\b(?:appointed|joined)/i;

// {niche name: {tier, hit_rate, open_share}} from the measured niches; tiers as the finder's (sourcer/niches.py TIERS).
export function nicheTiers(stats = {}) {
  const tierOf = (s) => (s.verdict === "few" ? 1 : s.score >= 8 ? 3 : s.score >= 4 ? 2 : s.score >= 1.5 ? 1 : 0);
  return Object.fromEntries(Object.values(stats).filter((s) => s?.name).map((s) => [s.name, { ...s, tier: tierOf(s) }]));
}

export function leadScore(r, { today = new Date(), niches = {}, signals = {}, moves = {}, madeAt = "", reviews = null, likes = null, rules = LEAD_POINTS } = {}) {
  const out = [];
  let cat = "fit";   // which half each reason counts in: "fit" (the right company), "timing" (why now), "stop"
  const add = (points, why) => { if (points) out.push([why, points, cat]); };
  // the signs of a lead few bankers have seen (FIT.quietMax): counted in Fit, and over its 100 cap in the ranking
  let quiet = 0;
  const addQuiet = (points, why) => { if (points) { add(points, why); quiet += points; } };
  const day = (n) => new Date(today.getTime() - n * 864e5).toISOString().slice(0, 10);
  const fx = fxScore(r);
  add(fx >= 50 ? rules.strongFx : fx > 0 ? rules.someFx : 0, fx >= 50 ? `Strong FX proof in its filings (${fx})` : `Some FX proof (${fx})`);
  const loss = -Number(r.fx_gain_loss_gbp) || 0;
  const filedOn = filedIso(r);
  if (loss >= rules.lossMin) {
    add(loss >= rules.bigLossMin ? rules.bigLoss : rules.loss, `FX loss of ${money(loss)}`);
    cat = "timing";
    if (filedOn && filedOn >= day(rules.recentDays)) add(rules.recentLoss, `… in accounts filed ${filedWhen(filedOn)}`);
    cat = "fit";
  }
  cat = "timing";
  if (filedOn && filedOn >= day(rules.justFiledDays) && !(loss >= rules.lossMin)) add(rules.justFiled, `Accounts just filed (${filedWhen(filedOn)})`);
  if (madeAt && r.first_seen === madeAt) add(rules.newOnList, "New on the list");
  cat = "fit";
  const niche = niches[r.fx_niche];
  if (niche) add(rules.nicheByTier[niche.tier] || 0, `Niche: ${r.fx_niche} (${niche.hit_rate}% of its companies prove FX)`);
  const lean = reviews?.lean?.niche?.[r.fx_niche] || reviews?.lean?.source?.[leadSource(r)];
  if (lean) addQuiet(lean.points, `Your checks: ${lean.share}% of ${lean.key} leads were new prospects (${lean.reviewed} judged; your usual ${lean.usual ?? "–"}%)`);
  const like = likes?.[r.company_number];
  if (like) addQuiet(rules.likeGood, `Like your good lead ${like.like_name} (${like.same.slice(0, 4).join(", ")})`);
  const recent = (signals[r.company_number] || []).filter((s) => String(s.at || "").slice(0, 10) >= day(rules.signalDays));
  const fdSignal = recent.find((s) => /^(new|news)_fd$|^hiring_fd$/.test(s.kind));
  const triggers = parts(r.triggers);
  const fdTrigger = [...triggers, r.fact_1, r.fact_2].find((t) => t && NEW_FD.test(t));
  const fdFiled = r.new_fd_in_accounts && appointedIso(r.new_fd_in_accounts) >= day(rules.fdInAccountsDays) ? r.new_fd_in_accounts : "";
  const newFd = Boolean(fdSignal || fdTrigger || fdFiled);
  const fdWhy = !newFd ? "" : fdSignal ? (fdSignal.kind === "hiring_fd" ? `Hiring a finance director (${fdSignal.title.replace(/^Hiring a finance director: /, "")}, ${String(fdSignal.at).slice(0, 10)})`
    : `New finance director (${fdSignal.title})`) : fdTrigger ? `New finance director: ${fdTrigger}` : `New finance director: ${fdFiled} (accounts)`;
  cat = "timing";
  if (newFd) add(rules.newFd, fdWhy);
  // Deals: buying companies (its accounts, or the ownership register), bought by PE, just funded, a new owner
  const bought = recent.find((s) => s.kind === "acquired");
  const buying = Boolean(r.acquisitions || bought);
  if (buying) add(rules.buying, `Buying companies: ${r.acquisitions || bought.title}`);
  const pe = recent.find((s) => /^(pe_buyout|news_pe|new_owner_pe|pe_debt)$/.test(s.kind));
  if (pe) add(rules.peBought, `Private-equity deal: ${pe.title}`);
  const backedBy = !pe && peBackedOf(r);
  cat = "fit";
  if (backedBy) add(rules.peBacked, `PE-backed: ${backedBy.name} — buyout lenders usually require a hedging policy`);
  cat = "timing";
  const funded = recent.find((s) => s.kind === "news_funding");
  if (funded) add(rules.funded, `Just raised funding: ${funded.title}`);
  const owner = !pe && recent.find((s) => /^(overseas_buyer|eot)$/.test(s.kind));
  if (owner) add(rules.newOwner, `New owner: ${owner.title}`);
  // Moments, each fading with age; one per group (a funding round beats its parts, a new trader beats trade growing)
  const all = signals[r.company_number] || [];
  const moments = [];
  const seen = new Set();
  for (const s of all) {
    const key = MOMENT_KINDS[s.kind];
    if (!key) continue;
    const group = MOMENT_GROUPS.find((g) => g.includes(s.kind));
    const points = Math.round((rules[key] || 0) * fade(s.at, today, rules));
    if (!points) continue;
    moments.push({ s, points, group: group ? group.join() : s.kind });
  }
  moments.sort((a, b) => b.points - a.points);
  for (const m of moments) {
    if (seen.has(m.group)) continue;
    seen.add(m.group);
    add(m.points, `${m.s.title}${m.s.detail ? `: ${m.s.detail}` : ""}${fade(m.s.at, today, rules) < 1 ? ` (${String(m.s.at).slice(0, 10)})` : ""}`);
  }
  const switched = moments.some((m) => m.s.kind === "bank_switch");
  for (const [points, why] of accountsMoments(r, rules)) add(points, why);
  const ccy = ownCurrency(r);
  const move = ccy && moves[ccy];
  if (move) {
    const week = Number(move["1w"]), month = Number(move["1m"]);
    const big = Math.abs(week) >= rules.moveWeek ? ["a week", week] : Math.abs(month) >= rules.moveMonth ? ["a month", month] : null;
    if (big) add(rules.currencyMoved, `Its currency moved: the pound ${big[1] > 0 ? "up" : "down"} ${Math.abs(big[1]).toFixed(1)}% against ${ccy} in ${big[0]}`);
  }
  const holdOff = all.find((s) => HOLD_OFF_KINDS.includes(s.kind));
  cat = "stop";
  if (holdOff) add(rules.insolvency, `${holdOff.title} — hold off`);
  cat = "timing";
  const other = triggers.find((t) => !NEW_FD.test(t)) ||
    recent.find((s) => /^(new_owner|new_charge|charge_paid|fx_charge)$/.test(s.kind) && !(switched && /charge/.test(s.kind)))?.title;
  const lender = other && /new charge|new borrowing|new lender|new bank/i.test(other);
  add(other && !owner ? (lender ? rules.newLender : rules.trigger) : 0, lender ? `New borrowing / lender: ${other}` : `Change: ${other}`);
  const abroad = recent.find((s) => s.kind === "news_abroad");
  add(abroad ? rules.abroadNews : 0, `In the news: ${abroad?.title || ""}`);
  const hiring = recent.find((s) => s.kind === "hiring");
  add(hiring ? rules.hiring : 0, `${hiring?.title || ""}`);
  cat = "fit";
  add(r.subsidiaries_abroad ? rules.subsidiaries : 0, `Subsidiaries abroad: ${r.subsidiaries_abroad}`);
  const ops = overseasOps(r);
  if (ops) add(rules.overseasOps, `Overseas operations: ${ops.text}`);
  if (/^(?:Emerging|Proven trader)\b/i.test(r.fx_niche || "")) addQuiet(rules.quietNiche, `A niche few bankers search: ${r.fx_niche}`);
  const hid = hiddenFromFilters(r);
  if (hid.length) addQuiet(rules.hidden, `Hidden from the usual filters: ${hid.map((h) => h.label.toLowerCase()).join(", ")}`);
  add(inCoreBand(r) ? rules.band : 0, "Turnover £20m–£300m");
  add(fx > 0 && !hedgingNamed(r) ? rules.open : 0, "No hedging named — probably on the bank's rate");
  add(loss >= rules.lossMin && !hedgingNamed(r) ? rules.lossNoHedge : 0, "FX loss with no hedging named — the clearest need");
  const growth = growthPct(r);
  add(growth >= rules.fastGrowthMin ? rules.fastGrowth : growth >= rules.growthMin ? rules.growth : 0, `Growing fast: turnover ${r.turnover_growth} on last year`);
  // where finance decisions sit (control.js): owned abroad counts against it unless its own records show the UK decides
  const seat = financeSeat(r);
  const topSign = (side) => seat.signs.filter((x) => (side > 0 ? x.points > 0 : x.points < 0)).sort((a, b) => Math.abs(b.points) - Math.abs(a.points))[0]?.text.split(":")[0] || "";
  if (seat.lean === "abroad") add(rules.runAbroad, `Likely run from abroad — ${topSign(-1)}`);
  else if (seat.lean === "uk" && seat.owner) add(rules.decidesHere, `Owned abroad, but decides in the UK — ${topSign(1)}`);
  else if (seat.owner) add(rules.ownedAbroad, "Owned abroad: ask where FX is decided");
  add(!r.run_from_abroad && ukArmName(r) ? rules.ukArmName : 0, "Name ends in UK — probably a foreign group's UK arm");
  const recentLoss = loss >= rules.lossMin && Boolean(filedOn) && filedOn >= day(rules.recentDays);
  const change = newFd ? "a new FD" : buying ? "buying companies" : pe ? "a private-equity deal" : "";
  cat = "timing";
  if (recentLoss && change) add(rules.combo, `Hit list: a recent FX loss and ${change}`);
  // Fit (the right company: FX proof and pain, size, niche, ownership) and Timing (why call now), each 0–100. A lead
  // that fits ranks on timing; one under FIT.min ranks below every one that does, whatever its news.
  const sum = (c) => out.filter((p) => p[2] === c).reduce((n, [, p]) => n + p, 0);
  const fit = Math.max(0, Math.min(100, sum("fit")));
  const timing = Math.max(0, Math.min(100, sum("timing")));
  // The ranking's Fit: the rest of Fit capped at 100, then the quiet signs on top (up to FIT.quietMax more), so two
  // leads at Fit 100 still part on whether other bankers can see them.
  const rankFit = Math.max(0, Math.min(100, sum("fit") - quiet) + Math.min(FIT.quietMax, quiet));
  const score = (fit >= FIT.min ? Math.round(FIT.base + FIT.fitWeight * rankFit + FIT.timingWeight * timing) : Math.round(fit / 2)) + sum("stop");
  return { score, fit, timing, rankFit, parts: out,
           flags: { recentLoss, newFd, fdWhy, buying, pe: Boolean(pe), peBacked: Boolean(pe || backedBy), funded: Boolean(funded), hit: Boolean(recentLoss && change),
                    moment: moments[0] ? moments[0].s.title : "", holdOff: holdOff ? holdOff.title : "" } };
}

// "Lead score 85: FX loss of £320k +30 · … " — the breakdown in one line.
export const leadLine = (s) => `Lead score ${s.score}${s.fit !== undefined ? ` (Fit ${s.fit} · Now ${s.timing})` : ""}: ${s.parts.map(([why, p]) => `${why} ${p > 0 ? "+" : "−"}${Math.abs(p)}`).join(" · ")}`;

// Rows with lead_score / lead_parts / lead_reasons attached (sorted by SORTS.lead; lead_reasons for the exports).
export const withLeadScores = (rows, ctx) => rows.map((r) => {
  if (r.dropped) return r;
  const s = leadScore(r, ctx);
  return { ...r, lead_score: s.score, lead_fit: s.fit, lead_timing: s.timing, lead_parts: s.parts, lead_flags: s.flags, lead_reasons: s.parts.map(([why, p]) => `${why} ${p > 0 ? "+" : "−"}${Math.abs(p)}`).join("; ") };
});

// --- The outreach plan (Zac, 14 Nov 2026: "the best leads ranked top 40, which we send our outreach letter to … then
// rank the rest by either email sequence or cold call") ----------------------------------------------------------------
// Every lead not contacted, not qualified out and with no serious reason not to progress, one per group (a group with
// any company contacted is left out: one approach per group), by lead score: the top `letters` get the Investec letter;
// the rest go to a cold call when there's something timely to say (a moment, a recently filed FX loss, a new FD, a deal,
// a trigger) or to the email sequence when there isn't (a good fit with no news: the sequence warms them up).
export const OUTREACH = { letters: 40 };
export function timelyReason(r) {
  const f = r.lead_flags || {};
  const loss = -Number(r.fx_gain_loss_gbp) || 0;
  return f.moment || (f.recentLoss && `FX loss of ${money(loss)} in accounts filed ${filedWhen(filedIso(r))}`)
    || (f.newFd && (f.fdWhy || "New finance director")) || (f.buying && `Buying companies${r.acquisitions ? `: ${r.acquisitions}` : ""}`)
    || (f.pe && "Private-equity deal") || (f.funded && "Just raised funding") || parts(r.triggers)[0] || "";
}
export const letterAddressee = (r) => (presentedContact(r)
  ? `${r.finance_contact}${r.finance_contact_role ? `, ${r.finance_contact_role}` : ""}`
  : r.no_fd_likely ? "The Managing Director" : "The Finance Director");
export function outreachPlan(rows = [], { contacted = {}, letters = OUTREACH.letters, today = new Date() } = {}) {
  const touched = new Set(rows.filter((r) => contacted[r.company_number]).map(groupKey));
  const live = rows.filter((r) => !r.dropped && !contacted[r.company_number] && !isOut(r) && !touched.has(groupKey(r)));
  const ready = [];
  const held = [];
  for (const r of live) (reasonsNotToProgress(r, { today }).some((x) => x.serious) ? held : ready).push(r);
  const ranked = collapseGroups([...ready].sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0)
    || String(a.company_name).localeCompare(String(b.company_name))));
  const all = ranked.map((r, i) => ({ ...r, why_now: timelyReason(r), outreach_rank: i + 1 }));
  const list = (r) => (r.outreach_rank <= letters ? "letter" : r.why_now ? "call" : "email");
  const out = { letter: [], call: [], email: [], held };
  for (const r of all) {
    const k = list(r);
    out[k].push({ ...r, outreach_list: k, outreach_why: outreachWhy(r, k, { letters, total: all.length }) });
  }
  return out;
}

// Why a lead sits in its outreach list, in words: its place in the ranking, the lead score's biggest reasons, and the
// timely reason (or its absence) that decided cold call v email sequence. [{label, text}] for the card and the export.
export function outreachWhy(r, list, { letters = OUTREACH.letters, total = 0 } = {}) {
  const reasons = (r.lead_parts || []).filter(([, p]) => p > 0).slice(0, 4).map(([w, p]) => `${w} (+${p})`);
  const minus = (r.lead_parts || []).filter(([, p]) => p < 0).map(([w, p]) => `${w} (${p})`);
  const place = `#${r.outreach_rank}${total ? ` of ${total}` : ""} by lead score (${r.lead_score || 0})`;
  const out = [];
  if (list === "letter") {
    out.push({ label: "Why the letter", text: `In the top ${letters}: ${place}, one per group, nothing serious against it.` });
  } else if (list === "call") {
    out.push({ label: "Why a cold call", text: `Something timely to raise: ${r.why_now}. ${place} — outside the letter's top ${letters}, so a call while it's fresh.` });
  } else {
    out.push({ label: "Why the email sequence", text: `A good fit (${place}, outside the letter's top ${letters}) but nothing timely to call about yet — no recent FX loss filing, new finance director, deal, trigger or moment. The sequence keeps them warm; a trigger moves them to a cold call.` });
  }
  if (reasons.length) out.push({ label: "What scores it", text: reasons.join(" · ") });
  if (minus.length) out.push({ label: "Against it", text: minus.join(" · ") });
  if (list === "letter" && r.why_now) out.push({ label: "Timely too", text: r.why_now });
  if (r.group_members?.length) out.push({ label: "Group", text: `Stands for ${r.group_members.length} other group compan${r.group_members.length === 1 ? "y" : "ies"} on the list: ${r.group_members.map((m) => m.company_name).join("; ")}` });
  return out;
}
export const outreachWhyLine = (r) => (r.outreach_why || []).map((w) => `${w.label}: ${w.text}`).join(" | ");

// The card's summary (Zac, 16 Nov 2026: "the key points on the cards need to be summarised — looks like a lot of
// info"): at most four one-line points — why call now, the FX in its records, who decides, what to pitch — each [label,
// text]; everything else stays one click away.
export function keyPoints(r, pitch = "") {
  const out = [];
  const cut = (t, n = 90) => (String(t).length > n ? `${String(t).slice(0, n - 1).trimEnd()}…` : String(t));
  const why = timelyReason(r);
  out.push(["Why now", why ? cut(why) : "Nothing timely — a good fit to work in the sequence"]);
  const loss = -Number(r.fx_gain_loss_gbp) || 0;
  const cur = r.main_currency && !/niche default/.test(r.currency_source || "") ? r.main_currency : "";
  const fx = [loss >= 10000 ? `FX loss ${money(loss)}` : "", cur || (r.currencies_in_accounts ? cut(r.currencies_in_accounts, 40) : ""),
    r.fx_forwards ? "uses forwards" : /^Uses/.test(r.fx_today || "") ? cut(r.fx_today.toLowerCase(), 40) : (cur || loss) ? "no hedging named" : "",
    r.overseas_turnover_share ? `${r.overseas_turnover_share} of sales abroad` : ""].filter(Boolean);
  out.push(["FX", fx.length ? fx.join(" · ") : r.hmrc_trade ? cut(r.hmrc_trade) : "Nothing in the filings yet"]);
  const own = ownership(r);
  const seat = financeSeat(r);
  const who = own.status === "unknown" ? "Owner not known — check who owns it"
    : `${OWNERSHIP_LABEL[own.status]}${own.owner && own.owner !== r.company_name ? ` — ${cut(own.owner, 40)}${own.status === "foreign" ? ` (${own.country})` : ""}` : ""}`;
  const extra = own.status === "foreign" ? ` · ${seat.verdict}` : r.pe_backed ? ` · PE-backed (${cut(r.pe_backed, 30)})` : "";
  out.push(["Owner", who + extra, own.searches[0][1]]);
  if (pitch) out.push(["Pitch", cut(pitch)]);
  return out;
}

export { financeSeat, SEAT_LABEL, ownershipOf, OWNERSHIP_LABEL };
let knownLei = {};
export const setKnownLei = (map) => { knownLei = map || {}; };
// the daily owner search's answers (store key `owners`, via ?view=signals): {number: {owner, kind, country, quote, url}}
// the ultimate parent each lead's own latest accounts name (tools/parents_from_accounts.py, best leads first): used when
// the row itself doesn't carry one yet
let knownParents = {};
export const setKnownParents = (map) => { knownParents = map || {}; };
const withParent = (r) => {
  const p = knownParents[r?.company_number];
  return p && !r.ultimate_parent ? { ...r, ultimate_parent: p.ultimate_parent, ultimate_parent_country: p.country, ultimate_parent_evidence: p.evidence } : r;
};
let knownOwnerSearch = {};
export const setKnownOwnerSearch = (map) => { knownOwnerSearch = map || {}; };
// owned from abroad by any source (accounts, LEI register, Companies House, the owner search): the Foreign-owned tab
export const foreignOwned = (r) => ownership(r).status === "foreign";
// in a tab of its own, out of every other list
export const elsewhere = (r) => ukNamed(r) || foreignOwned(r);
export const ownership = (r) => ownershipOf(withParent(r), groupOf(r), knownLei[r.company_number] || null, knownOwnerSearch[r.company_number] || null);
