// Filters, the Daily Call List rules (top 25 READY) and the views' presets.
// (Split out of App.jsx; no behaviour change.)
import { DailyCallListView } from "./CallListViews.jsx";
import { fetchData } from "./data.js";

// ─── FILTER STATE ──────────────────────────────────────────────────
// view: "call_list" | "research" | "all" | "new"
export const BLANK_FILTERS = {
  view:         "call_list",
  priorities:   [],
  siteConfs:    [],
  hasFxSignals: false,
  hasWebsite:   false,
  hasDirector:  false,
  minScore:     0,
  minRevenue:   0,           // 0 = any; otherwise minimum confirmed annual_turnover in £
  eventId:      "all",
  currencyPair: "all",
  segment:      "all",
  statuses:     [],
  grades:       [],
  sortBy:       "score",    // "score" | "readiness" | "grade" | "confidence" | "fx_likelihood"
  search:       "",
};

export const CALL_LIST_FILTERS = { ...BLANK_FILTERS, view: "call_list", sortBy: "readiness" };
export const RESEARCH_FILTERS  = { ...BLANK_FILTERS, view: "research"  };
export const ALL_FILTERS       = { ...BLANK_FILTERS, view: "all"       };
export const NEW_FILTERS       = { ...BLANK_FILTERS, view: "new", sortBy: "readiness" };

// ── READY eligibility helpers (mirrors scoring.ts isReadyEligible) ────────────
// Platform/cloud/SaaS domains — not operating companies.
export const PLATFORM_DOMAINS_SET = new Set([
  "microsoft.com","azure.microsoft.com","azure.com","office.com",
  "google.com","googleapis.com","cloud.google.com",
  "aws.amazon.com","amazonaws.com",
  "shopify.com","shopify.co.uk","wix.com","squarespace.com",
  "wordpress.com","wordpress.org","medium.com","substack.com",
  "blogger.com","blogspot.com","hubspot.com","mailchimp.com","salesforce.com",
  "linkedin.com","facebook.com","twitter.com","x.com","instagram.com",
  "youtube.com","tiktok.com","indeed.com","glassdoor.com",
  "totaljobs.com","reed.co.uk","cv-library.co.uk",
  "rightmove.co.uk","zoopla.co.uk","onthemarket.com",
  "amazon.com","amazon.co.uk","ebay.com","ebay.co.uk","etsy.com",
  // whisky investment / content sites
  "casktrade.com","whiskyinvestdirect.com","whiskyintelligence.com",
]);
// Content page path patterns — same as scoring.ts CONTENT_PAGE_RE
export const CONTENT_PATH_RE = /\/(blog|article|articles|news|pricing|price|report|reports|statistics?|stats|figures?|guide|guides|resources?|academy|dictionary|encyclopedia|faq|case-stud|whitepaper|press-release|press\/|events\/|webinar|sitemap|index\.htm|investment-guide)/i;
// Long content-slug heuristic: path segments containing "figures", "statistics", "analysis", "investment" + year or hyphen-heavy
export const CONTENT_SLUG_RE = /\/[a-z-]*(?:figures?|statistics?|analysis|investment-guide|market-report|export-data|import-data|price-comparison)[a-z0-9-]*\//i;

export function bareDomain(url) {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase().replace(/^www\d*\./, ""); } catch { return ""; }
}
export function isPlatformDomain(url) {
  const d = bareDomain(url);
  if (!d) return false;
  if (PLATFORM_DOMAINS_SET.has(d)) return true;
  for (const p of PLATFORM_DOMAINS_SET) if (d.endsWith("." + p)) return true;
  return false;
}
export function isContentPage(url) {
  if (!url) return false;
  try {
    const path = new URL(url).pathname;
    if (CONTENT_PATH_RE.test(path)) return true;
    if (/\/\d{4}\/\d{2}\//.test(path)) return true;  // /2024/04/... blog date pattern
    if (CONTENT_SLUG_RE.test(path)) return true;       // /scotch-whisky-export-figures-2024/
  } catch { /* not parseable */ }
  return false;
}

// Page-title company name indicators — a name containing these markers is a scraped page title, not a company
export function isPageTitleName(name) {
  if (!name) return false;
  if (name.includes("|")) return true;          // "Scotch Whisky Figures 2024 | Casktrade"
  if (/^about\s+(us\s*[-–]?\s*)?/i.test(name)) return true;  // "About Us - Franceline Transport"
  // Name contains a year AND content-page words → page title
  if (/\b20\d{2}\b/.test(name) && /\b(figures?|statistics?|report|export|import|guide|analysis|data)\b/i.test(name)) return true;
  return false;
}

// ── Client-side DM name validator ─────────────────────────────────────────────
// Used when pipeline hasn't yet populated dm_valid (enrich-decision-makers not re-run).
// Mirrors the NOT_A_NAME_WORD logic in enrich-decision-makers.ts.
export const NOT_A_FIRST_NAME_CLIENT = new Set([
  "sourcing","specialist","general","manager","director","marketing","sales",
  "accounts","admin","support","info","contact","team","import","imports","importer",
  "export","exports","exporter","trade","trading","group","services","service",
  "solutions","solution","international","global","limited","ltd","plc","consulting",
  "holdings","partners","partner","wholesale","retail","logistics","distribution",
  "procurement","purchasing","department","mobile","portrait","quality","value",
  "leading","premium","trusted","welcome","about","overview","address","line","sector",
  "price","pricing","statistics","figures","report","news","blog","guide",
  "whisky","scotch","wine","beer","spirits","food","furniture","electronics",
  "samsung","apple","google","microsoft","brand","china","france","italy",
  "germany","spain","india","taiwan","korea","europe","asia","america",
  "target","dragon","sole","source","sourced","product","products","accessories",
  "textile","textiles","apparel","clothing","medical","optical","dental","pharma",
  "tamil","naidu","korea","korean","brands","designs","collections","collection",
]);
export function isPlausibleFirstNameClient(fn) {
  if (!fn || fn.length < 2 || fn.length > 20) return false;
  if (NOT_A_FIRST_NAME_CLIENT.has(fn.toLowerCase())) return false;
  // Must start with capital letter
  if (!/^[A-Z]/.test(fn)) return false;
  return true;
}

// Client-side READY eligibility check (mirrors pipeline scoring.ts isReadyEligible)
export function isReadyEligibleClient(l) {
  if (!l.website) return false;
  if (isPlatformDomain(l.website)) return false;
  if (isContentPage(l.website)) return false;
  if (isPageTitleName(l.company_name)) return false;
  if (l.website_confidence === "low") return false;
  // Block micro-entity filers — CH threshold <£632k turnover, well under £100k/month floor
  if (typeof l.accounts_type === "string" && l.accounts_type.toLowerCase().includes("micro")) return false;
  const hasCompanyNumber = !!l.company_number;
  const hasHighConf = ["high","confirmed"].includes(l.website_confidence||"");
  if (!hasCompanyNumber && !hasHighConf) return false;
  return true;
}

export function isCallListEligible(l) {
  // Daily Call List eligibility: HOT-only with real evidence + contact route.
  // Ranking within the call list is by ready_score (computed by pipeline).
  // WARM leads go to Research Queue — not the call list.
  const isHot         = l.priority === "HOT";
  const hasWebConf    = ["high","medium","confirmed"].includes(l.website_confidence);
  const hasWebsite    = !!l.website;
  // Require at least 1 real scraped FX signal — no pays_fx_confirmed bypass
  const hasFxEvidence = (l.fx_payment_signals||[]).length > 0;
  const notExcluded   = !["not_relevant"].includes(l.outreach_status);
  const hasDirector   = !!l.director_name;
  // Additional READY exclusions: content pages, platform domains, no CH number + low conf
  const readyOk       = isReadyEligibleClient(l);
  return isHot && hasWebsite && hasWebConf && hasFxEvidence && hasDirector && notExcluded && readyOk;
}

// Sort HOT leads by ready_score desc, fall back to score then company name
export function sortByReadyScore(leads) {
  return [...leads].sort((a, b) => {
    const rd = (b.ready_score || 0) - (a.ready_score || 0);
    if (rd !== 0) return rd;
    const sd = (b.score || 0) - (a.score || 0);
    if (sd !== 0) return sd;
    return (a.company_name || "").localeCompare(b.company_name || "");
  });
}

export const CALL_LIST_MAX = 25;

// ── READY deduplication ────────────────────────────────────────────
// Before ranking Top 10 / Backup 15, deduplicate by domain, company_number,
// and normalised company name. Keeps the higher-ranked (ready_score) lead.
export function normaliseCoName(name) {
  return (name||"").toLowerCase()
    .replace(/\s+(ltd|limited|plc|llp|llc|inc|corp|co|group|holdings?|uk|international|global)\.?$/i,"")
    .replace(/[^a-z0-9]/g,"")
    .trim();
}
export function dedupeForReady(leads) {
  const seenDomains = new Set();
  const seenCompanyNums = new Set();
  const seenNames = new Set();
  const result = [];
  // Input should already be sorted by ready_score desc — first occurrence wins
  for (const l of leads) {
    const domain = bareDomain(l.website);
    const cn = l.company_number;
    const normName = normaliseCoName(l.company_name);
    if (domain && seenDomains.has(domain)) continue;
    if (cn && seenCompanyNums.has(cn)) continue;
    if (normName.length >= 5 && seenNames.has(normName)) continue;
    if (domain) seenDomains.add(domain);
    if (cn) seenCompanyNums.add(cn);
    if (normName.length >= 5) seenNames.add(normName);
    result.push(l);
  }
  return result;
}

// Revenue fit — uses ONLY confirmed iXBRL-parsed annual_turnover.
// company_size_band, accounts_type, net_assets, employee_count are NOT treated as confirmed.
// Returns: "passes" | "below" | "unverified"
export function sizeFit(lead, minRevenue) {
  if (!minRevenue || minRevenue <= 0) return "passes";
  const t = lead.annual_turnover;
  if (t == null || typeof t !== "number") return "unverified";
  return t >= minRevenue ? "passes" : "below";
}

export function applyFilters(leads, filters, getCrmStatus) {
  let r = leads;

  // Primary view filter
  // call_list = all eligible HOT leads sorted by ready_score (pipeline-computed ranking)
  // research  = everything NOT in the call list (remaining HOT shown in DailyCallListView,
  //             WARM + QUEUE in research tab)
  if (filters.view === "call_list") {
    r = sortByReadyScore(r.filter(isCallListEligible));
  } else if (filters.view === "new") {
    const cutoff = Date.now() - 24*60*60*1000;
    r = sortByReadyScore(r.filter(l => l.created_at && new Date(l.created_at).getTime() > cutoff));
  } else if (filters.view === "research") {
    // by lead id: a domain / company-number key was undefined for leads with neither, which then hid every other
    // such lead from Research
    const callListIds = new Set(r.filter(isCallListEligible).map(l => l.id));
    r = r.filter(l => !callListIds.has(l.id));
  }

  // Additional filters
  if (filters.priorities.length)    r = r.filter(l => filters.priorities.includes(l.priority));
  if (filters.siteConfs.length)     r = r.filter(l => filters.siteConfs.includes(l.website_confidence));
  if (filters.hasFxSignals)         r = r.filter(l => (l.fx_payment_signals||[]).length > 0);
  if (filters.hasWebsite)           r = r.filter(l => l.website);
  if (filters.hasDirector)          r = r.filter(l => l.director_name);
  if (filters.minScore > 0)         r = r.filter(l => (l.score||0) >= filters.minScore);
  if (filters.eventId !== "all")    r = r.filter(l => l.event_id === filters.eventId);
  if (filters.currencyPair !== "all") r = r.filter(l => (l.fx_exposure||"").includes(filters.currencyPair));
  if (filters.segment !== "all")    r = r.filter(l => (l.segment_name||"")===filters.segment);
  if (filters.statuses.length)      r = r.filter(l => filters.statuses.includes(getCrmStatus(l)));
  if (filters.grades.length)        r = r.filter(l => filters.grades.includes(l.route_grade));
  // Revenue filter — strictly confirmed annual_turnover only. "unverified" and "below" are excluded.
  if (filters.minRevenue > 0)        r = r.filter(l => sizeFit(l, filters.minRevenue) === "passes");
  if (filters.search) {
    const q = filters.search.toLowerCase();
    r = r.filter(l =>
      (l.company_name||"").toLowerCase().includes(q) ||
      (l.director_name||"").toLowerCase().includes(q)
    );
  }
  // Sort
  const GRADE_ORDER = {A:0,B:1,C:2,D:3,E:4,F:5};
  if (filters.sortBy === "readiness") {
    // call_list view already sorted by ready_score above; for other views fall back to ready_score
    r = sortByReadyScore(r);
  } else if (filters.sortBy === "grade") {
    r = [...r].sort((a,b) => {
      const gd = (GRADE_ORDER[a.route_grade]??9) - (GRADE_ORDER[b.route_grade]??9);
      return gd !== 0 ? gd : (b.score||0) - (a.score||0);
    });
  } else if (filters.sortBy === "confidence") {
    r = [...r].sort((a,b) => (b.contact_confidence||0) - (a.contact_confidence||0));
  } else if (filters.sortBy === "fx_likelihood") {
    r = [...r].sort((a,b) => (b.fx_likelihood_score||0) - (a.fx_likelihood_score||0));
  }
  // default "score" sort: leads already come in score order from fetchData
  return r;
}
