/**
 * scoring.ts — the ONE gate-based lead scorer. Faithful port of scripts/rescore.py
 * (the `rescore()` function + its helpers and gates A–I). Pure function, no I/O.
 *
 * ⚠ Do NOT change the gates / point weights here without explicit sign-off — this
 * mirrors the v1 behaviour exactly. If rescore.py changes, mirror it here (or vice
 * versa once this is the source of truth). Domain blocklists are *data*: keep them
 * in sync with scripts/rescore.py.
 */
import type { Lead, Priority } from "./schema.js";

// ── SIC TIERS ────────────────────────────────────────────────────────────────
const SIC_TIER1 = new Set<string>([
  "4671", "4672", "4673", "4674", "4675", "4676", "4677",
  "4631", "4632", "4633", "4634", "4635", "4636", "4637", "4638", "4639",
  "4641", "4642", "4643", "4644", "4645", "4646", "4647", "4648", "4649",
  "4610", "4620", "4630", "4650", "4660", "4669",
  "5010", "5020", "5110", "5121", "5122",
]);
const SIC_TIER2 = new Set<string>([
  ...Array.from({ length: 3400 - 1000 }, (_, i) => String(1000 + i)), // 1000..3399 (manufacturing)
  "4651", "4652", "4653", "4654", "46", "4600",
]);
const SIC_TIER3 = new Set<string>([
  ...Array.from({ length: 4800 - 4700 }, (_, i) => String(4700 + i)), // 4700..4799 (retail)
  "4910", "4920", "4930", "4941", "4942",
  "5210", "5221", "5222", "5223", "5224", "5229",
  "5231", "5232", "5239", "5240",
]);

const EXPOSURE_LEVEL_BOOST: Record<string, number> = {
  "Very High": 20, High: 12, Medium: 6, Low: 0,
};

function sicTier(sicCodes: ReadonlyArray<string>): 0 | 1 | 2 | 3 {
  for (const code of sicCodes) {
    const c = (code || "").replace(/\s/g, "");
    if ([...SIC_TIER1].some((t) => c.startsWith(t) || t.startsWith(c.slice(0, 4)))) return 1;
    if ([...SIC_TIER2].some((t) => c.startsWith(t) || t.startsWith(c.slice(0, 2)))) return 2;
    if ([...SIC_TIER3].some((t) => c.startsWith(t))) return 3;
  }
  return 0;
}
function sicBoost(sicCodes: ReadonlyArray<string>): number {
  return ({ 1: 15, 2: 10, 3: 7, 0: 0 } as const)[sicTier(sicCodes)];
}

// ── ASSOCIATION / TRADE-BODY DETECTION ───────────────────────────────────────
const ASSOCIATION_SICS = new Set(["94110", "94120", "94910", "94920", "94990"]);
const ASSOC_PATTERN =
  /\b(association|council|federation|institute|society|chamber|guild|consortium|forum|alliance|authority|union|bureau|agency)\b/i;

// Smaller B2B set used only by Gate G (intersection check on a lead's signal arrays)
const B2B_TRADE_SIGNALS = new Set([
  "wholesale", "wholesaler", "distributor", "distribution",
  "importer", "importing", "imported", "exporter", "exporting",
  "manufacturer", "manufacturing", "trade", "b2b",
  "supply chain", "agent", "agents", "reseller",
  "stockist", "supplier", "freight", "logistics",
  "cargo", "shipper", "forwarder",
]);

const NAME_TRADE_WORDS = [
  "trading", "international", "imports", "import", "export", "exports", "wholesale",
  "distribution", "distributor", "global", "worldwide", "overseas",
];
// NOTE: "nordic" and "iberian" appear twice — this mirrors scripts/rescore.py's
// NAME_ORIGIN_WORDS exactly (a duplication there). Kept for bit-for-bit parity:
// a name containing "iberian" therefore scores origin=2 (≈ +8, then 100-capped).
const NAME_ORIGIN_WORDS = [
  "italian", "french", "spanish", "german", "chinese", "mediterranean", "atlantic",
  "pacific", "european", "nordic", "iberian", "nordic", "iberian", "scandinavian",
  "oriental", "asian", "american", "african",
];
function nameSignalScore(name: string): number {
  const n = (name || "").toLowerCase();
  const trade = NAME_TRADE_WORDS.filter((w) => n.includes(w)).length;
  const origin = NAME_ORIGIN_WORDS.filter((w) => n.includes(w)).length;
  return Math.min(8, trade * 3 + origin * 4);
}

function ageScore(incorporated: string | null | undefined): number {
  if (!incorporated) return 0;
  const year = parseInt(String(incorporated).slice(0, 4), 10);
  if (!Number.isFinite(year)) return 0;
  const age = new Date().getUTCFullYear() - year;
  if (age >= 20) return 8;
  if (age >= 10) return 5;
  if (age >= 5) return 2;
  if (age >= 2) return 0;
  return -5;
}

// ── DOMAIN BLOCKLISTS (data — keep in sync with scripts/rescore.py) ──────────
const HARD_SKIP_DOMAINS = new Set([
  // reference / encyclopaedia
  "britannica.com", "britannica.co.uk", "britannicakids.com", "merriam-webster.com",
  "dictionary.com", "thesaurus.com", "encyclopedia.com", "thoughtco.com", "wikipedia.org",
  // supermarkets / consumer grocery
  "morrisons.com", "tesco.com", "sainsburys.co.uk", "asda.com", "waitrose.com",
  "marksandspencer.com", "ocado.com", "iceland.co.uk", "aldi.co.uk", "lidl.co.uk", "costco.co.uk",
  // consumer wine / drinks retail
  "majestic.co.uk", "thedrinkshop.com", "laithwaites.co.uk", "thewinesociety.com",
  "wineowners.com", "virginwines.com",
]);
const KNOWN_BAD_DOMAINS = new Set([
  // trade publications / news
  "foodmanufacture.co.uk", "foodnavigator.com", "fooddrinkeurope.eu",
  "thegrocer.co.uk", "just-drinks.com", "just-food.com", "meatinfo.co.uk", "fruitnet.com",
  "freshplaza.com", "harpers.co.uk", "decanter.com", "thedrinksbusiness.com",
  "morningadvertiser.co.uk", "barbob.co.uk", "oilprice.com", "hydrocarbons-technology.com",
  "offshore-technology.com", "gasworld.com", "icis.com", "chemicalwatch.com",
  "chemeurope.com", "chemicalprocessing.com", "seafoodsource.com", "undercurrentnews.com",
  "fishfocus.co.uk", "news.italianfood.net", "italianfood.net", "italianfoodnews.com",
  "beveragetradenetwork.com", "beveragetradenews.com",
  // sector portals / aggregators / data
  "ukfoodanddrink.org", "fdf.org.uk", "seafish.org", "gov.uk", "companieshouse.gov.uk",
  "grokipedia.com", "ensun.io", "craft.co", "zoominfo.com", "opencorporates.com",
  "albertapallet.ca", "whiskyinvestdirect.com", "whiskyintelligence.com",
  "thelawyer.com", "legalcheek.com", "chambers.com",
  "kayak.co.uk", "kayak.com", "aito.com", "expedia.co.uk",
  "luxurytribune.com", "luxurydaily.com", "womanandhome.com", "shiptothemoon.com",
  "j5fashion.com", "gemimports.co.uk", "thewholesaler.co.uk", "dinainternational.co.uk",
  "europages.com", "europages.co.uk", "thomasnet.com", "kompass.com",
  // whisky investment content sites (not operating companies)
  "casktrade.com", "whiskyinvestment.co.uk", "caskwhiskyinvesting.com",
]);

function extractDomain(website: string | null | undefined): string {
  if (!website) return "";
  try {
    return new URL(website).hostname.toLowerCase().replace(/^www\d*\./, "");
  } catch {
    return "";
  }
}
function domainInSet(website: string | null | undefined, set: ReadonlySet<string>): boolean {
  const dom = extractDomain(website);
  if (!dom) return false;
  if (set.has(dom)) return true;
  for (const entry of set) if (dom.endsWith(`.${entry}`)) return true;
  return false;
}
export const isHardSkipDomain = (website: string | null | undefined) => domainInSet(website, HARD_SKIP_DOMAINS);
export const isKnownBadDomain = (website: string | null | undefined) => domainInSet(website, KNOWN_BAD_DOMAINS);

// ── READY-ELIGIBLE FILTER ─────────────────────────────────────────────────────
/** Platform/cloud/SaaS/social domains — not operating companies */
const READY_EXCLUDE_DOMAINS = new Set([
  // Cloud / software platforms
  "microsoft.com", "azure.microsoft.com", "azure.com", "office.com",
  "google.com", "googleapis.com", "cloud.google.com",
  "aws.amazon.com", "amazonaws.com",
  "shopify.com", "shopify.co.uk", "shopify.dev",
  "wix.com", "squarespace.com", "wordpress.com", "wordpress.org",
  "medium.com", "substack.com", "blogger.com", "blogspot.com",
  "hubspot.com", "mailchimp.com", "salesforce.com",
  // Social / job boards
  "linkedin.com", "facebook.com", "twitter.com", "x.com",
  "instagram.com", "youtube.com", "tiktok.com",
  "indeed.com", "glassdoor.com", "totaljobs.com", "reed.co.uk", "cv-library.co.uk",
  // Property
  "rightmove.co.uk", "zoopla.co.uk", "onthemarket.com",
  // Marketplaces / retail
  "amazon.com", "amazon.co.uk", "ebay.com", "ebay.co.uk",
  "etsy.com", "notonthehighstreet.com", "wayfair.com", "wayfair.co.uk",
]);

/** URL path patterns that indicate a content/article/pricing page — not a company homepage */
const CONTENT_PAGE_RE = /\/(blog|article|articles|news|pricing|price|report|reports|statistics?|stats|figures|guide|guides|resources?|resource|academy|dictionary|encyclopedia|faq|case-stud|whitepaper|press-release|press\/|events\/|webinar|sitemap|index\.htm)/i;

/**
 * True when company_name is clearly a scraped page <title>, not a real company.
 * Mirrors apps/web/src/App.jsx isPageTitleName so backend ready_score = 0 for
 * leads the dashboard would already filter out client-side.
 */
export function looksLikePageTitle(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = String(name).trim();
  if (!n) return false;
  if (n.includes("|")) return true;
  // "About Us", "About —", "About" alone, "Home:", "Welcome to…"
  if (/^(about(\s+(us|the|our|company|page)\b.*)?\s*$|home\s*[-–—|:]\s*|welcome\s+to\s+)/i.test(n)) return true;
  if (n.endsWith("...") || n.endsWith("…")) return true;
  if (/[?!]/.test(n)) return true;
  if (/^(how\s+to|what\s+is|why\s+|where\s+to|when\s+to|the\s+best|top\s+\d+)\b/i.test(n)) return true;
  if (/\b20\d{2}\b/.test(n) && /\b(figures?|statistics?|report|exports?|imports?|guide|analysis|data|tutorial|review)\b/i.test(n)) return true;
  // "Top N exports/imports/products [of year/country]"
  if (/^top\s+\d+\b/i.test(n)) return true;
  // News headlines: contain news verbs or start with news subjects
  if (/\b(hails?|announces?|reveals?|seals?\s+deal|strikes?\s+deal|clinches?|inks?\s+deal)\b/i.test(n)) return true;
  if (/^(economy|government|minister|chancellor|president|treasury|parliament|trade\s+deal|uk[\s-]gulf|uk[\s-]us|uk[\s-]eu)\b/i.test(n)) return true;
  // "win as [something]" news framing
  if (/\bwin\s+as\b/i.test(n)) return true;
  // Search-query style phrases scraped as company names.
  // e.g. "Shipping To China", "Sourcing From Europe", "Importing From Italy"
  if (/^[A-Za-z]+(ing|tion)\s+(to|from|into|in|out\s+of)\s+/i.test(n)) return true;
  // "[anything] UK based [place]" — scraper description, not a company name
  if (/\bUK[\s-]based\s+[A-Z]/i.test(n)) return true;
  // Single bare common-word names that are page elements, not companies
  if (/^(home|welcome|contact|services|products|solutions|overview|introduction|menu|index|main|default|untitled)$/i.test(n)) return true;
  return false;
}

/**
 * True when a company name looks like a search-engine query phrase rather than
 * a real trading name. These slip through looksLikePageTitle because they're not
 * page titles — they're keyword phrases the scraper used as a search query.
 *
 * Examples: "FMCG Wholesale", "Consumer Electronics Equipment Distribut",
 * "Budget Shipping Containers", "Hot Tile Importers".
 *
 * Heuristic: ≥ 2 words, ALL words are from a closed set of generic trade/category
 * nouns or modifiers with no proper-noun anchor.
 */
const GENERIC_TRADE_WORDS = new Set([
  "fmcg", "b2b", "b2c", "sme", "smb", "uk", "eu", "us", "usa", "gb",
  "importer", "importers", "importing", "exporter", "exporters", "exporting",
  "wholesale", "wholesaler", "wholesalers", "wholesaling",
  "distributor", "distributors", "distribution",
  "supplier", "suppliers", "supply", "supplies",
  "freight", "logistics", "shipping", "cargo", "haulage", "haulier",
  "sourcing", "procurement", "trading", "trader", "traders",
  "manufacturer", "manufacturers", "manufacturing",
  "import", "export",
  "food", "drink", "drinks", "beverage", "beverages",
  "produce", "fruit", "vegetable", "vegetables", "grocery", "groceries",
  "electronics", "electrical", "consumer", "industrial", "commercial",
  "components", "parts", "equipment", "machinery", "products", "goods",
  "budget", "premium", "global", "national", "international", "direct",
  "services", "solutions", "group", "company", "limited", "ltd",
  "hot", "cool", "fresh", "quality", "express", "fast", "quick",
  "containers", "packaging", "boxes", "tiles", "tile",
]);

// Registered company legal suffixes — presence strongly implies it's a real company name.
const COMPANY_SUFFIX_RE = /\b(ltd|limited|plc|llp|llc|inc|corp|gmbh|bv|nv|sa|sas|srl|co\.?\s*ltd|trading\s+as)\b\.?$/i;

export function looksLikeKeywordPhrase(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = String(name).trim();
  // If the name ends with a registered legal suffix it's a real company, not a keyword phrase
  if (COMPANY_SUFFIX_RE.test(n)) return false;
  const words = n.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  // Only apply to multi-word names — single word handled by looksLikePageTitle
  if (words.length < 2 || words.length > 7) return false;
  // If every word is a generic trade word, it's a keyword phrase not a company
  const allGeneric = words.every(w => GENERIC_TRADE_WORDS.has(w));
  if (allGeneric) return true;
  // 4+ words where all but one are generic: "Hot Tile Importers Uk", "Consumer Electronics Equipment Dist"
  const genericCount = words.filter(w => GENERIC_TRADE_WORDS.has(w)).length;
  if (words.length >= 4 && genericCount >= words.length - 1) return true;
  return false;
}

/**
 * Returns false for content/article/pricing pages, platform domains, and leads
 * without enough validation to justify a same-day call.
 * Leads that fail this check get ready_score = 0 (excluded from Daily Call List
 * Top 10 / Backup 15 but remain visible in Research Queue).
 */
export function isReadyEligible(lead: Partial<Lead>): boolean {
  const website = lead.website ?? null;
  if (!website) return false;
  // Block known platform / cloud / social domains
  if (domainInSet(website, READY_EXCLUDE_DOMAINS)) return false;
  // Also block any subdomain of a hard-skip domain (e.g. azure.microsoft.com)
  if (domainInSet(website, HARD_SKIP_DOMAINS)) return false;
  // Block URL paths that indicate a content/article/pricing/blog page
  try {
    const path = new URL(website).pathname;
    if (CONTENT_PAGE_RE.test(path)) return false;
    // /2024/04/... — blog date-based URL pattern
    if (/\/\d{4}\/\d{2}\//.test(path)) return false;
  } catch { /* not a valid URL — don't block */ }
  // Block low-confidence website leads from READY
  if (lead.website_confidence === "low") return false;
  // Block leads whose company_name is a scraped page title, not a company.
  // Prefer company_name_clean (after prefix/slogan stripping) — if the cleaned
  // name passes, the raw page-title artifact has been resolved and the lead is valid.
  const cleanName = (lead as Record<string, unknown>).company_name_clean as string | undefined;
  const nameToCheck = (cleanName && cleanName.trim()) ? cleanName : lead.company_name;
  if (looksLikePageTitle(nameToCheck)) return false;
  if (looksLikeKeywordPhrase(nameToCheck)) return false;
  // Block micro-entity filers — turnover definitively below £632k (~£53k/month),
  // well under the £100k/month minimum viable FX client floor.
  const accsType = (lead as Record<string, unknown>).accounts_type as string | undefined;
  if (typeof accsType === "string" && accsType.toLowerCase().includes("micro")) return false;
  // Require Companies House number OR high-confidence validated website
  const hasCompanyNumber = !!(lead.company_number);
  const hasHighConf = ["high", "confirmed"].includes(lead.website_confidence ?? "");
  if (!hasCompanyNumber && !hasHighConf) return false;
  return true;
}

// ── scoreLead ────────────────────────────────────────────────────────────────
export interface ScoreResult {
  score: number;
  priority: Priority;
  reasons: string[];
}

type ScoreInput = Pick<
  Lead,
  | "fx_payment_signals" | "secondary_signals" | "b2b_signals" | "sic_codes"
  | "exposure_level" | "exposure_type" | "company_name" | "incorporated"
  | "director_name" | "website" | "website_confidence" | "website_source"
  | "company_status" | "pays_fx_confirmed" | "why_affected" | "exposure_thesis"
  | "is_large_org"
  // Gate J — actionable contact route required for HOT
  | "contact_phone" | "contact_email" | "contact_page"
>;

/**
 * Score a lead. `urgency` is the trigger event's urgency (0–10) — the caller
 * resolves it (rescore.py reads it from urgency_map). Faithful to rescore.py.
 */
export function scoreLead(lead: Partial<ScoreInput>, urgency = 0): ScoreResult {
  let score = 0;
  const reasons: string[] = [];

  const fxSigs = lead.fx_payment_signals ?? [];
  const secSigs = lead.secondary_signals ?? [];
  const sicCodes = (lead.sic_codes ?? []).map((s) => String(s));

  // 1. Website FX signals (0–30)
  if (fxSigs.length) {
    const s = Math.min(30, 8 + fxSigs.length * 4);
    score += s;
    reasons.push(`Direct FX payment signals: ${fxSigs.slice(0, 3).join(", ")}`);
  }
  // 2. Secondary international signals (0–10)
  if (secSigs.length) {
    const s = Math.min(10, secSigs.length * 2);
    score += s;
    reasons.push(`International activity signals (${secSigs.length})`);
  }
  // 3. SIC tier (0–15)
  const sb = sicBoost(sicCodes);
  if (sb) {
    score += sb;
    const t = sicTier(sicCodes);
    const label = ({ 1: "core trade/wholesale", 2: "manufacturing", 3: "logistics/retail" } as Record<number, string>)[t];
    reasons.push(`SIC tier ${t} (${label}): ${sicCodes.slice(0, 2).join(", ")}`);
  }
  // 4. Exposure level boost (0–20)
  const expBoost = EXPOSURE_LEVEL_BOOST[lead.exposure_level ?? ""] ?? 0;
  if (expBoost) {
    score += expBoost;
    reasons.push(`Segment exposure: ${lead.exposure_level} — ${(lead.exposure_type ?? "").slice(0, 40)}`);
  }
  // 5. Event urgency (0–10)
  if (urgency >= 7) { score += 10; reasons.push(`High urgency event (score ${urgency}/10)`); }
  else if (urgency >= 4) { score += 5; }
  // 6. Company-name trade signals (0–8)
  const ns = nameSignalScore(lead.company_name ?? "");
  if (ns) { score += ns; reasons.push(`Company name signals trade/international activity (+${ns})`); }
  // 7. Company age (−5..+8)
  const a = ageScore(lead.incorporated);
  score += a;
  if (a > 0) reasons.push(`Established company (+${a}) — incorporated ${String(lead.incorporated ?? "").slice(0, 4)}`);
  else if (a < 0) reasons.push(`Very new company (${a}) — incorporated ${String(lead.incorporated ?? "").slice(0, 4)}`);
  // 8. Director found (+5)
  if (lead.director_name) { score += 5; reasons.push(`Director found: ${lead.director_name}`); }
  // 9. Website tier (+25/+15/+8/−20)
  const conf = lead.website_confidence ?? null;
  const src = lead.website_source ?? "";
  if (lead.website) {
    if (conf === "high") { score += 25; reasons.push(`Website verified — strong name match (${src})`); }
    else if (conf === "medium" || conf === "confirmed") { score += 15; reasons.push(`Website verified (${src})`); }
    else if (conf === "low") { score += 8; reasons.push(`Website found — low confidence (${src})`); }
    else { score += 15; reasons.push("Website confirmed"); }
  } else {
    score -= 20;
    reasons.push("No website found (−20)");
  }
  // 10. Active status (+5)
  if ((lead.company_status ?? "").toLowerCase() === "active") { score += 5; reasons.push("Active on Companies House"); }

  score = Math.min(score, 100);

  // ── Evidence gates ─────────────────────────────────────────────────────────
  let hasWebsite = !!lead.website;
  const hasFx = !!lead.pays_fx_confirmed || fxSigs.length > 0;
  const hasIntl = hasFx || secSigs.length >= 3;
  const hasSic = sb > 0;
  const wc = lead.website_confidence ?? "";

  // Gate -1: hard-skip content/retail domain → SKIP
  if (hasWebsite && isHardSkipDomain(lead.website)) {
    score = Math.min(score, 39);
    reasons.push(`⚠ Content/retail site (${extractDomain(lead.website)}) — not a B2B prospect, capped at SKIP`);
    hasWebsite = false;
  }
  // Gate 0: known-bad domain → cap 49
  if (hasWebsite && isKnownBadDomain(lead.website)) {
    score = Math.min(score, 49);
    reasons.push(`⚠ Bad domain (${extractDomain(lead.website)}) — trade publication/aggregator, not company site`);
    hasWebsite = false;
  }
  // Gate A: no website → SKIP
  if (!hasWebsite) {
    score = Math.min(score, 39);
    reasons.push("⚠ No website — SKIP cap (no direct evidence)");
  }
  // Gate B: no FX + no intl → SKIP (or QUEUE if strong SIC)
  if (hasWebsite && !hasFx && !hasIntl) {
    if (hasSic) { score = Math.min(score, 55); reasons.push("⚠ No website FX signals — QUEUE cap (SIC only)"); }
    else { score = Math.min(score, 39); reasons.push("⚠ No trade evidence at all — SKIP"); }
  }
  // Gate C: HOT requires at least 1 real extracted website FX signal.
  // pays_fx_confirmed alone (set from secondary signals / segment signals) is NOT
  // sufficient — a lead needs actual scraped evidence ("we import", "overseas suppliers",
  // "EUR invoices", etc.) to justify a same-day call.
  if (score >= 80 && fxSigs.length === 0) {
    score = 79;
    reasons.push("⚠ HOT capped → WARM: no real website FX signal (secondary/segment signals don't count for HOT)");
  }
  // Gate D: WARM requires international evidence (unless decent website confidence)
  if (score >= 60 && !hasIntl && hasWebsite) {
    if (!["high", "medium", "confirmed"].includes(String(wc))) {
      score = 55;
      reasons.push("⚠ WARM capped → QUEUE: low website confidence, no FX signals");
    }
  }
  // Gate E: association / trade body → SKIP
  const isAssocSic = sicCodes.some((s) => ASSOCIATION_SICS.has(s.trim()));
  const isAssocName = ASSOC_PATTERN.test(lead.company_name ?? "");
  if (isAssocSic || isAssocName) {
    score = Math.min(score, 39);
    reasons.push(`⚠ Trade/membership organisation (${isAssocSic ? "SIC" : "name pattern"}) — capped at SKIP`);
  }
  // Gate F: dissolved → SKIP
  if ((lead.company_status ?? "").toLowerCase() === "dissolved") {
    score = Math.min(score, 39);
    reasons.push("⚠ Dissolved company — capped at SKIP");
  }
  // Gate F2: dormant (from CH accounts enrichment) → cap at QUEUE
  const sizeBand = (lead as Record<string, unknown>).company_size_band as string | undefined;
  const accsType = (lead as Record<string, unknown>).accounts_type as string | undefined;
  const isDormant =
    sizeBand === "dormant" ||
    (typeof accsType === "string" && accsType.toLowerCase().includes("dormant"));
  if (isDormant) {
    score = Math.min(score, 49);
    reasons.push("⚠ Dormant company (CH accounts) — capped at QUEUE");
  }
  // Gate F3: micro-entity accounts filer → cap at QUEUE.
  // UK micro-entity threshold: turnover ≤ £632k / balance sheet ≤ £316k / ≤ 10 employees
  // (two of three). Well below the £100k/month (~£1.2M/year) minimum viable FX client floor.
  // Micro-entity leads stay visible in Research Queue but cannot reach HOT or WARM.
  const isMicroEntity = typeof accsType === "string" && accsType.toLowerCase().includes("micro");
  if (isMicroEntity) {
    score = Math.min(score, 49);
    reasons.push("⚠ Micro-entity accounts filer (likely <£632k turnover) — capped at QUEUE");
  }
  // Gate G: WARM/HOT requires B2B/trade evidence
  if (score >= 65) {
    const allSigs = new Set<string>([
      ...(lead.fx_payment_signals ?? []),
      ...(lead.b2b_signals ?? []),
      ...(lead.secondary_signals ?? []),
    ].map((s) => String(s).toLowerCase()));
    let hasB2b = [...allSigs].some((s) => B2B_TRADE_SIGNALS.has(s));
    if (!hasB2b) hasB2b = (lead.b2b_signals ?? []).length > 0;
    if (!hasB2b) hasB2b = !!lead.pays_fx_confirmed;
    if (!hasB2b) {
      const nameLower = (lead.company_name ?? "").toLowerCase();
      hasB2b = [...B2B_TRADE_SIGNALS].some((w) => nameLower.includes(w));
    }
    if (!hasB2b) {
      score = Math.min(score, 64);
      reasons.push("⚠ No B2B/trade evidence on website — capped below WARM");
    }
  }
  // Gate H: empty exposure thesis → cap at QUEUE
  if (score >= 60) {
    const ta = (lead.why_affected ?? "").trim();
    const tb = (lead.exposure_thesis ?? "").trim();
    if (ta.length < 40 && tb.length < 40) {
      score = Math.min(score, 59);
      reasons.push("⚠ No exposure thesis — capped at QUEUE (why_affected/exposure_thesis both thin)");
    }
  }
  // Gate I: large / unreachable organisation → cap at QUEUE
  if (lead.is_large_org) {
    score = Math.min(score, 49);
    reasons.push("⚠ Large/unreachable organisation — capped at QUEUE");
  }
  // Gate J: HOT requires at least one actionable contact route.
  // A lead with a score of 80+ but no way to reach anyone is not call-ready.
  // Checks fields available at scoring time: phone, email, director name, contact page.
  if (score >= 80) {
    const hasContactRoute =
      !!(lead.contact_phone) ||
      !!(lead.contact_email) ||
      !!(lead.director_name) ||
      !!(lead.contact_page);
    if (!hasContactRoute) {
      score = 79;
      reasons.push("⚠ HOT capped → WARM: no contact route (no phone, email, director, or contact page)");
    }
  }

  const priority: Priority = score >= 80 ? "HOT" : score >= 60 ? "WARM" : score >= 40 ? "QUEUE" : "SKIP";
  return { score, priority, reasons };
}

// ── computeReadyScore ─────────────────────────────────────────────────────────
/**
 * Ranks HOT leads for the Daily Call List (Top 10 / Backup 15 / Remaining HOT).
 * Pure function — no I/O. Only meaningful when priority === "HOT"; returns 0 otherwise.
 *
 * Dimensions (100 pts total):
 *  1. FX evidence depth      0–25   (count of real website FX signals)
 *  2. Evidence quality       0–20   (fx_evidence_snippets / supplier / import-export)
 *  3. Website confidence     0–15   (high > medium > low)
 *  4. Contact route quality  0–20   (route_grade A > B > C > D)
 *  5. Decision-maker quality 0–10   (tier-1 with email > tier-1 any > any DM)
 *  6. B2B / trade fit        0–10   (lead_type + b2b_signal count)
 *  7. Company maturity       0–5    (established age)
 *  [max 105, capped at 100]
 */
export function computeReadyScore(lead: Partial<Lead>): number {
  let s = 0;

  // 1. FX evidence depth (0–25)
  const fxN = (lead.fx_payment_signals ?? []).length;
  s += fxN >= 5 ? 25 : fxN >= 3 ? 20 : fxN >= 2 ? 15 : fxN >= 1 ? 8 : 0;

  // 2. Evidence quality (0–20) — deep-page evidence snippets
  const snippets = ((lead as Record<string, unknown>).fx_evidence_snippets as string[] | undefined) ?? [];
  const supplierEv = ((lead as Record<string, unknown>).supplier_evidence as string[] | undefined) ?? [];
  const importExEv = ((lead as Record<string, unknown>).import_export_evidence as string[] | undefined) ?? [];
  if (snippets.length >= 3) s += 20;
  else if (snippets.length >= 2) s += 15;
  else if (snippets.length >= 1) s += 10;
  else if (supplierEv.length >= 1 || importExEv.length >= 1) s += 5;

  // 3. Website confidence (0–15)
  const wc = lead.website_confidence ?? "";
  s += wc === "high" ? 15 : (wc === "medium" || wc === "confirmed") ? 10 : wc === "low" ? 4 : 0;

  // 4. Contact route quality (0–20) — route_grade A/B/C/D/E/F
  const GRADE_PTS: Record<string, number> = { A: 20, B: 15, C: 8, D: 4 };
  const grade = ((lead as Record<string, unknown>).route_grade as string | undefined) ?? "F";
  s += GRADE_PTS[grade] ?? 0;

  // 5. Decision-maker quality (0–10)
  const dms = ((lead as Record<string, unknown>).decision_makers as Array<Record<string, unknown>> | undefined) ?? [];
  const tier1Email = dms.find((d) => d["tier"] === 1 && (d["email"] || d["email_candidate"]));
  const tier1Any   = dms.find((d) => d["tier"] === 1);
  const anyDm      = dms.length > 0;
  s += tier1Email ? 10 : tier1Any ? 7 : anyDm ? 3 : 0;

  // 6. B2B / trade fit (0–10)
  const lt = lead.lead_type ?? "unknown";
  const b2bN = (lead.b2b_signals ?? []).length;
  s += lt === "both" ? 10 : lt === "evergreen_saving" ? 8 : lt === "trigger_exposed" ? 5 : 0;
  if (b2bN >= 3) s += 2; // small bonus — already contributing to score gate

  // 7. Company maturity (0–5)
  const yr = parseInt(String(lead.incorporated ?? "").slice(0, 4), 10);
  const age = Number.isFinite(yr) ? new Date().getUTCFullYear() - yr : 0;
  s += age >= 10 ? 5 : age >= 5 ? 3 : age >= 2 ? 1 : 0;

  // 8. Contact richness (0–8) — leads with both phone AND a named email are
  //    genuinely more call-ready than phone-only or email-only leads.
  const hasPhone = !!(lead.contact_phone);
  const hasEmail = !!(lead.contact_email ||
    dms.find((d) => d["email"] || d["email_candidate"]));
  const hasVerifiedEmail = !!(lead.contact_email ||
    dms.find((d) => d["email_verified"] || d["email_candidate"]));
  if (hasPhone && hasVerifiedEmail) s += 8;
  else if (hasPhone && hasEmail) s += 5;
  else if (hasPhone) s += 2;
  else if (hasEmail) s += 1;

  // 9. Accounts filing quality (0–4) — full/group/medium filers are more
  //    established and larger than abridged/small/unknown.
  const at = ((lead as Record<string, unknown>).accounts_type as string | undefined) ?? "";
  const atL = at.toLowerCase();
  if (["full", "group", "medium"].some((v) => atL.includes(v))) s += 4;
  else if (["small", "abridged"].some((v) => atL.includes(v))) s += 2;

  // 10. Freshness (0–12) — leads discovered today surface above older recycled ones.
  //     Ensures the daily call list reflects today's market intelligence, not weeks-old data.
  const createdAt = (lead as Record<string, unknown>).created_at as string | undefined;
  if (createdAt) {
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86_400_000;
    if (ageDays < 1)        s += 12;   // discovered today
    else if (ageDays < 3)   s += 8;    // last 3 days
    else if (ageDays < 7)   s += 4;    // this week
    else if (ageDays < 14)  s += 1;    // last 2 weeks
    // older → 0 (stale, stays at bottom of READY list)
  }
  // Leads without created_at are very old imports — no freshness bonus.

  return Math.min(s, 100);
}

// ── exposure confidence (port of rescore.compute_exposure_confidence) ────────
export function exposureConfidence(lead: Partial<Lead>): "high" | "medium" | "low" | "none" {
  const fx = (lead.fx_payment_signals ?? []).length;
  const seg = (lead.segment_signals ?? []).length;
  const sec = (lead.secondary_signals ?? []).length;
  const wc = lead.website_confidence ?? null;
  const expLvl = lead.exposure_level ?? "";
  const paysFx = !!lead.pays_fx_confirmed;

  let ev = 0;
  if (paysFx) ev += 3;
  if (fx >= 2) ev += 3; else if (fx === 1) ev += 2;
  if (seg >= 1) ev += 2;
  if (sec >= 3) ev += 1;
  if (wc === "high") ev += 2; else if (wc === "medium" || wc === "confirmed") ev += 1;
  if (expLvl === "Very High") ev += 2; else if (expLvl === "High") ev += 1;

  if (ev >= 7) return "high";
  if (ev >= 4) return "medium";
  if (ev >= 1) return "low";
  return "none";
}
