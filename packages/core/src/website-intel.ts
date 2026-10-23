/**
 * website-intel.ts — extract FX evidence from a company's website pages.
 *
 * Pure functions over HTML / plaintext. Used by the enrich-website-intel
 * pipeline stage. Returns:
 *
 *   * fx_evidence_snippets  — 30-400 char sentences actually said on the site
 *     that contain FX-related keywords. These are the gold for call openers.
 *   * country_evidence      — countries mentioned in a sourcing/trade context
 *   * inferred_currency_pairs — currency pairs implied by those countries
 *   * supplier_evidence     — short phrases like "Italian producers", "sourced
 *     directly from Spain"
 *   * import_export_evidence — explicit "import from X" / "made in X" phrases
 *   * size_signals          — warehouse / nationwide / family-business / etc.
 *   * tech_signals          — passed through from tech-stack.ts
 *
 * Country → currency mapping favours the most likely pair from a UK importer's
 * perspective. Where a country has its own free-floating currency (Sweden,
 * NZ, Brazil) the dedicated pair is preferred over the previous
 * single-pair-per-region approximation.
 */

// ── Country → currency pair ──────────────────────────────────────────────────
interface CountryEntry { re: RegExp; label: string; pair: string }
const COUNTRIES: ReadonlyArray<CountryEntry> = [
  // EUR zone
  { re: /\b(italy|italian)\b/i,               label: "Italy",       pair: "GBP/EUR" },
  { re: /\b(france|french)\b/i,               label: "France",      pair: "GBP/EUR" },
  { re: /\b(germany|german|deutsch)\b/i,      label: "Germany",     pair: "GBP/EUR" },
  { re: /\b(spain|spanish)\b/i,               label: "Spain",       pair: "GBP/EUR" },
  { re: /\b(portugal|portuguese)\b/i,         label: "Portugal",    pair: "GBP/EUR" },
  { re: /\b(netherlands|dutch|holland)\b/i,   label: "Netherlands", pair: "GBP/EUR" },
  { re: /\b(belgium|belgian)\b/i,             label: "Belgium",     pair: "GBP/EUR" },
  { re: /\b(austria|austrian)\b/i,            label: "Austria",     pair: "GBP/EUR" },
  { re: /\b(greece|greek|grecian)\b/i,        label: "Greece",      pair: "GBP/EUR" },
  { re: /\b(ireland|irish)\b/i,               label: "Ireland",     pair: "GBP/EUR" },
  // Non-EUR Europe
  { re: /\b(sweden|swedish)\b/i,              label: "Sweden",      pair: "GBP/SEK" },
  { re: /\b(denmark|danish)\b/i,              label: "Denmark",     pair: "GBP/DKK" },
  { re: /\b(norway|norwegian)\b/i,            label: "Norway",      pair: "GBP/NOK" },
  { re: /\b(finland|finnish)\b/i,             label: "Finland",     pair: "GBP/EUR" },
  { re: /\b(switzerland|swiss)\b/i,           label: "Switzerland", pair: "GBP/CHF" },
  { re: /\b(poland|polish)\b/i,               label: "Poland",      pair: "GBP/PLN" },
  { re: /\b(czech|czechia)\b/i,               label: "Czech Republic", pair: "GBP/CZK" },
  // Catch-alls
  { re: /\bscandinavia\w*\b/i,                label: "Scandinavia", pair: "GBP/EUR" },
  { re: /\b(europe|european|continental)\b/i, label: "Europe",      pair: "GBP/EUR" },
  // USD
  { re: /\b(usa|united states|america\b|american)\b/i, label: "USA", pair: "GBP/USD" },
  { re: /\b(china|chinese|prc)\b/i,            label: "China",       pair: "GBP/USD" },
  { re: /\b(hong kong)\b/i,                    label: "Hong Kong",   pair: "GBP/USD" },
  { re: /\b(india|indian)\b/i,                 label: "India",       pair: "GBP/INR" },
  { re: /\b(canada|canadian)\b/i,              label: "Canada",      pair: "GBP/CAD" },
  // Other
  { re: /\b(japan|japanese)\b/i,               label: "Japan",       pair: "GBP/JPY" },
  { re: /\b(australia|australian)\b/i,         label: "Australia",   pair: "GBP/AUD" },
  { re: /\b(new zealand|kiwi)\b/i,             label: "New Zealand", pair: "GBP/NZD" },
  { re: /\b(south africa|south african)\b/i,   label: "South Africa", pair: "GBP/ZAR" },
  { re: /\b(turkey|turkish)\b/i,               label: "Turkey",      pair: "GBP/TRY" },
  { re: /\b(brazil|brazilian)\b/i,             label: "Brazil",      pair: "GBP/BRL" },
  { re: /\b(mexico|mexican)\b/i,               label: "Mexico",      pair: "GBP/MXN" },
  { re: /\b(middle east|uae|dubai|saudi)\b/i,  label: "Middle East", pair: "GBP/USD" },
  { re: /\b(asia\b|asian)\b/i,                 label: "Asia",        pair: "GBP/USD" },
  { re: /\b(global|worldwide|international)\b/i, label: "Global",    pair: "GBP/USD" },
];

const SOURCING_CONTEXT_RE = /(import|export|sourc|supply|supplier|partner|producer|manufactur|warehouse|distrib|wholesal|from|origin|made in|based in|ship)/i;

// ── FX keywords for snippet scoring ──────────────────────────────────────────
const FX_KEYWORDS = [
  // import/export
  "import", "importer", "importing", "imported from",
  "export", "exporter", "exporting",
  "direct from", "sourced from", "source from", "sourcing from",
  "shipped from", "manufactured in", "made in", "produced in",
  "origin", "country of origin",
  // supplier language
  "overseas supplier", "foreign supplier", "international supplier",
  "european supplier", "italian supplier", "german supplier", "french supplier", "spanish supplier",
  "global supplier", "overseas producer",
  // currency / payment
  "pay in euros", "pay in dollars", "eur invoice", "usd invoice",
  "foreign currency", "exchange rate", "fx", "hedging", "hedge",
  "currency risk", "currency exposure", "multi-currency",
  // trade
  "wholesale", "distributor", "distribution partner",
  "trade account", "trade customer", "trade only",
];

const FX_KW_RE = new RegExp("\\b(" + FX_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i");
const FX_KW_RE_G = new RegExp(FX_KW_RE.source, "ig");

// supplier-phrase pattern (richer phrases get a scoring bonus)
const SUPPLIER_PHRASE_RE = /(sourc\w* (from|directly|in)|import\w* from|direct from|(european|italian|french|german|spanish|american|global|overseas) (supplier|producer|manufacturer|partner|brand)|(supplier|producer|manufacturer|partner)s? (in|from|across) \w+|family.{0,10}(producer|farm|vineyard|winery|grower)|(wholesale|trade) (supplier|distributor|partner))/i;
const SUPPLIER_PHRASE_RE_G = new RegExp(SUPPLIER_PHRASE_RE.source, "ig");

// import/export explicit phrases
const IE_PHRASE_RE = /(import\w*\s+from\s+\w+|export\w*\s+to\s+\w+|sourc\w*\s+(directly\s+)?from\s+\w+|direct\s+from\s+\w+|made\s+in\s+\w+|produced\s+in\s+\w+|(our\s+)?supplier[s]?\s+(in|from|across)\s+\w+|(manufactured|produced|grown|harvested)\s+(in|by)\s+\w+)/gi;

// ── Size signals ─────────────────────────────────────────────────────────────
const SIZE_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bwarehouse\b/i, label: "warehouse" },
  { re: /\bdistribution cent(er|re)\b/i, label: "distribution centre" },
  { re: /\bnationwide\b/i, label: "nationwide" },
  { re: /\bestab(lished)?\s+(in\s+)?(18|19|20)\d{2}\b/i, label: "long-established" },
  { re: /\bfamily[\s-](business|company|run|owned)\b/i, label: "family business" },
  { re: /\btrade (customers?|accounts?|only)\b/i, label: "trade customers" },
  { re: /\b(large|extensive|wide|broad)\s+(stock|range|selection|inventory)\b/i, label: "large stock range" },
  { re: /\bfleet\s+of\b/i, label: "vehicle fleet" },
  { re: /\bshowroom\b/i, label: "showroom" },
  { re: /\bB2B\b/, label: "B2B" },
  { re: /\bwholesale\b/i, label: "wholesale" },
  { re: /\b(multi.?site|multiple sites?|multiple locations?)\b/i, label: "multi-site" },
  { re: /\bnational(ly)? deliver\w*\b/i, label: "national delivery" },
  { re: /\b\d{2,4}\s+(employees?|staff|people)\b/i, label: "sizeable workforce" },
  { re: /\b(over|more than)\s+(50|100|200|500)\s+(customers?|clients?)\b/i, label: "large customer base" },
  { re: /\bexport\w*\s+to\s+\d+\s+(countries|markets)\b/i, label: "exports to multiple countries" },
  { re: /\b(award.?winning|industry.?leading|market.?leading)\b/i, label: "award-winning" },
];

// ── HTML → plain text ────────────────────────────────────────────────────────
export function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Extractors ───────────────────────────────────────────────────────────────
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z\d])/;
const NAV_PREFIX_RE = /^(click|read|learn|find out|discover|contact us|call us|home|menu)/i;

export function extractFxEvidenceSnippets(text: string, max = 5): string[] {
  const sentences = text.split(SENTENCE_SPLIT_RE);
  const scored: Array<{ score: number; sent: string }> = [];
  for (const raw of sentences) {
    const sent = raw.trim();
    if (sent.length < 30 || sent.length > 400) continue;
    if (NAV_PREFIX_RE.test(sent)) continue;
    const kwMatches = sent.match(FX_KW_RE_G);
    if (!kwMatches) continue;
    const supMatches = sent.match(SUPPLIER_PHRASE_RE_G);
    scored.push({ score: kwMatches.length * 2 + (supMatches?.length ?? 0) * 3, sent });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { sent } of scored) {
    const key = sent.slice(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sent);
    if (out.length >= max) break;
  }
  return out;
}

export function extractCountryEvidence(text: string): { countries: string[]; pairs: string[] } {
  const countries: string[] = [];
  const pairs: string[] = [];
  const seenC = new Set<string>(), seenP = new Set<string>();
  for (const entry of COUNTRIES) {
    const re = new RegExp(entry.re.source, "ig");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const window = text.slice(Math.max(0, m.index - 150), Math.min(text.length, m.index + m[0].length + 150));
      if (!SOURCING_CONTEXT_RE.test(window)) continue;
      if (!seenC.has(entry.label)) { seenC.add(entry.label); countries.push(entry.label); }
      if (!seenP.has(entry.pair)) { seenP.add(entry.pair); pairs.push(entry.pair); }
      break;  // one match per country is enough
    }
  }
  return { countries, pairs };
}

export function extractSupplierEvidence(text: string, max = 5): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(SUPPLIER_PHRASE_RE.source, "ig");
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 30);
    const end = Math.min(text.length, m.index + m[0].length + 80);
    let chunk = text.slice(start, end).trim().replace(/\s+/g, " ");
    if (chunk.length > 120) chunk = chunk.slice(0, 120).replace(/\s+\S*$/, "") + "…";
    const key = chunk.slice(0, 40).toLowerCase();
    if (!seen.has(key) && chunk.length > 20) {
      seen.add(key);
      phrases.push(chunk);
      if (phrases.length >= max) break;
    }
  }
  return phrases;
}

export function extractImportExportEvidence(text: string, max = 5): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = IE_PHRASE_RE.exec(text)) !== null) {
    const phrase = m[0].trim();
    const key = phrase.toLowerCase().slice(0, 30);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(phrase);
      if (found.length >= max) break;
    }
  }
  return found;
}

export function extractSizeSignals(text: string, max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { re, label } of SIZE_PATTERNS) {
    if (seen.has(label)) continue;
    if (re.test(text)) { seen.add(label); out.push(label); }
    if (out.length >= max) break;
  }
  return out;
}

export function buildCurrencyReason(countries: string[], pairs: string[], snippets: string[]): string {
  if (!pairs.length) return "";
  const primary = pairs[0]!;
  const countryStr = countries.slice(0, 3).join(", ");
  const bestSnippet = snippets.find((s) => s.length < 200);
  if (bestSnippet) return `Website mentions ${countryStr} → likely ${primary} exposure. Evidence: "${bestSnippet.slice(0, 120)}"`;
  if (countryStr) return `Website mentions ${countryStr} in a sourcing/trade context → likely ${primary} exposure`;
  return `Inferred ${primary} from trade language on website`;
}

// ── Website confidence reason (human-readable) ───────────────────────────────
export function generateWebsiteConfidenceReason(lead: {
  website_confidence?: string | null;
  website_source?: string | null;
  website_domain?: string;
  company_name?: string;
  fx_payment_signals?: string[] | null;
}): string {
  const conf = (lead.website_confidence || "").toLowerCase();
  const src = (lead.website_source || "").replace(/_/g, " ");
  const domain = lead.website_domain || "";
  const ch = (lead.company_name || "").toLowerCase();
  const sigs = (lead.fx_payment_signals || []).length;
  if (conf === "high" || conf === "confirmed") {
    const parts: string[] = [];
    if (sigs >= 3) parts.push(`${sigs} FX/trade signals found on website`);
    if (src) parts.push(`discovered via ${src}`);
    if (domain && ch.split(/\s+/).slice(0, 2).some((tok) => tok.length > 3 && domain.includes(tok))) parts.push("domain name matches company name");
    return "High confidence: " + (parts.length ? parts.join("; ") : "strong website + signal match");
  }
  if (conf === "medium") return "Medium confidence: website found but weaker signal match — worth validating manually";
  if (conf === "low") return "Low confidence: website uncertain, check domain before calling";
  if (conf === "guessed") return "Guessed: no verified website found — domain inferred from company name";
  return "Unknown: website confidence not assessed";
}

// ── Aggregated extraction ────────────────────────────────────────────────────
export interface WebsiteIntelEvidence {
  fx_evidence_snippets: string[];
  country_evidence: string[];
  inferred_currency_pairs: string[];
  supplier_evidence: string[];
  import_export_evidence: string[];
  size_signals: string[];
  currency_reason: string;
}

export function extractWebsiteIntel(combinedText: string): WebsiteIntelEvidence {
  const snippets = extractFxEvidenceSnippets(combinedText);
  const { countries, pairs } = extractCountryEvidence(combinedText);
  const supplier = extractSupplierEvidence(combinedText);
  const ie = extractImportExportEvidence(combinedText);
  const size = extractSizeSignals(combinedText);
  return {
    fx_evidence_snippets: snippets,
    country_evidence: countries,
    inferred_currency_pairs: pairs,
    supplier_evidence: supplier,
    import_export_evidence: ie,
    size_signals: size,
    currency_reason: buildCurrencyReason(countries, pairs, snippets),
  };
}

/** 0-100 score for *evidence of FX exposure*, separate from contact quality. */
export function computeFxLikelihood(
  existingFxPaymentSignals: number,
  evidence: WebsiteIntelEvidence,
  techStackScore = 0,
): number {
  let s = 0;
  s += Math.min(28, evidence.fx_evidence_snippets.length * 8);
  s += Math.min(20, evidence.supplier_evidence.length * 7);
  if (evidence.country_evidence.length) s += Math.min(14, evidence.country_evidence.length * 5);
  if (evidence.inferred_currency_pairs.length) s += 8;
  s += Math.min(15, evidence.import_export_evidence.length * 5);
  s += Math.min(10, existingFxPaymentSignals * 3);
  if (evidence.size_signals.length >= 2) s += 5;
  else if (evidence.size_signals.length === 1) s += 2;
  s += Math.min(20, techStackScore / 2);     // tech stack contributes up to 20
  return Math.min(100, Math.round(s));
}
