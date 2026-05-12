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
const NAME_ORIGIN_WORDS = [
  "italian", "french", "spanish", "german", "chinese", "mediterranean", "atlantic",
  "pacific", "european", "nordic", "iberian", "scandinavian",
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
  // Gate C: HOT requires direct FX
  if (score >= 80 && !hasFx) {
    score = 79;
    reasons.push("⚠ HOT capped → WARM: no direct FX signal on website");
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

  const priority: Priority = score >= 80 ? "HOT" : score >= 60 ? "WARM" : score >= 40 ? "QUEUE" : "SKIP";
  return { score, priority, reasons };
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
