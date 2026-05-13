/**
 * signals.ts — centralised FX signal definitions. Faithful port of scripts/signals.py.
 *
 * Rules (unchanged from v1):
 *  - Bare nationality adjectives (italian, french, …) are NEVER direct FX evidence —
 *    they go in ORIGIN_ADJECTIVES / `fx_origin_hints`, not `fx_payment_signals`.
 *  - Contextual matches ("French suppliers", "sourced from Germany") ARE evidence —
 *    extracted by extractContextualFx() and returned as fx payment signals.
 *  - SECONDARY_SIGNALS = trade/international words only — no bare adjectives.
 */

// ── BARE NATIONALITY / COUNTRY ADJECTIVES (origin hints only) ────────────────
export const ORIGIN_ADJECTIVES: ReadonlySet<string> = new Set([
  "italian", "french", "spanish", "german", "chinese", "american", "japanese",
  "portuguese", "greek", "dutch", "belgian", "swedish", "danish", "norwegian",
  "finnish", "swiss", "austrian", "polish", "turkish", "indian", "thai",
  "vietnamese", "korean", "mexican", "brazilian", "australian", "scandinavian",
  "mediterranean", "continental", "oriental", "iberian", "nordic", "african",
]);
/** Backward-compatible alias used by rescore (v1). */
export const WEAK_ORIGIN_TOKENS = ORIGIN_ADJECTIVES;

// ── CONTEXTUAL FX PATTERNS ───────────────────────────────────────────────────
const _ADJ = [...ORIGIN_ADJECTIVES].sort().join("|");
const _SRC =
  "supplier|suppliers|producer|producers|manufacturer|manufacturers|" +
  "factory|factories|partner|partners|vineyard|vineyards|" +
  "importer|importers|ingredient|ingredients|component|components|" +
  "part|parts|material|materials|brand|brands|wholesaler|wholesalers|" +
  "distributor|distributors|source|sourcing|origin|origins|" +
  "grown|farmed|crafted|made|brewed|distilled|winery|wineries";

export const CONTEXTUAL_FX_PATTERNS: ReadonlyArray<RegExp> = [
  // "French suppliers", "Italian producers", "German components"
  new RegExp(`\\b(${_ADJ})\\s+(${_SRC})\\b`, "gi"),
  // "sourced from Italy", "imported from France", "direct from Germany"
  new RegExp(`\\b(sourced|imported|procured|purchased|shipped|brought|direct)\\s+from\\s+(${_ADJ})\\b`, "gi"),
  // "supplier from France", "suppliers in Germany"
  new RegExp(`\\bsupplier[s]?\\s+(from|in)\\s+(${_ADJ})\\b`, "gi"),
  // "from Italian manufacturers", "by French producers"
  new RegExp(`\\b(from|by|with)\\s+(${_ADJ})\\s+(${_SRC})\\b`, "gi"),
];

/** Contextually matched FX phrases (e.g. "french suppliers"). Deduped, max 6. */
export function extractContextualFx(text: string): string[] {
  const tlow = (text || "").toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pat of CONTEXTUAL_FX_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(tlow)) !== null) {
      const phrase = m[0].trim();
      if (phrase && !seen.has(phrase)) {
        seen.add(phrase);
        out.push(phrase);
        if (out.length >= 6) return out;
      }
      if (m.index === pat.lastIndex) pat.lastIndex++; // guard zero-length matches
    }
  }
  return out;
}

/** Bare nationality adjectives present in the text (whole-word). For `fx_origin_hints`. */
export function extractOriginHints(text: string): string[] {
  const tlow = (text || "").toLowerCase();
  return [...ORIGIN_ADJECTIVES].filter((adj) => new RegExp(`\\b${adj}\\b`).test(tlow)).sort();
}

// ── DIRECT FX PAYMENT SIGNALS (high weight) — no bare adjectives ─────────────
export const FX_PAYMENT_SIGNALS: ReadonlyArray<string> = [
  "we import", "we source", "sourced from", "imported from", "direct from",
  "importing from", "we buy from", "purchased from", "procured from",
  "overseas supplier", "european supplier", "international supplier", "foreign supplier",
  "global supplier", "worldwide supplier",
  "from italy", "from france", "from spain", "from germany", "from china", "from usa",
  "from america", "from japan", "from india", "from norway", "from australia",
  "from new zealand", "from south africa", "from denmark", "from netherlands",
  "from europe", "from asia", "from the us", "from the usa", "from the eu",
  "foreign currency", "currency risk", "exchange rate", "fx exposure",
  "international payments", "overseas payments", "currency hedging", "fx risk",
  "importer", "import company", "import business", "exclusive importer",
  "uk importer", "sole importer", "we distribute", "import and distribute",
  "export", "exports", "exporting", "we export", "overseas customers", "global customers",
  "international customers", "us customers", "american customers", "european customers",
];

// ── SECONDARY / TRADE SIGNALS (lower weight) — no bare adjectives ────────────
export const SECONDARY_SIGNALS: ReadonlyArray<string> = [
  "international", "global", "worldwide", "overseas", "distribution", "distributor",
  "wholesale", "wholesaler", "logistics", "freight", "shipping", "customs", "clearance",
  "europe", "european", "asia", "north america", "south america",
  "supply chain", "supplier", "sourcing", "procurement",
  "currency", "forex", "exchange", "sterling", "dollar", "euro", "euros", "dollars",
  "import", "export", "trading",
];

// ── B2B SIGNALS ──────────────────────────────────────────────────────────────
export const B2B_SIGNALS: ReadonlyArray<string> = [
  "wholesale", "wholesaler", "wholesale only", "trade only", "trade prices",
  "trade customers", "trade enquiries", "distributor", "distribution",
  "minimum order", "bulk order", "bulk pricing", "bulk discount",
  "b2b", "business to business", "business customers", "corporate customers",
  "stockist", "stockists", "nationwide stockists", "become a stockist",
  "reseller", "resellers", "agent", "agents", "authorised dealer", "authorized dealer",
  "contract manufacturing", "own label", "private label", "white label",
  "we supply", "we manufacture and supply", "supply chain",
  "catalogue available", "brochure available", "price list",
  "no vat", "ex vat", "plus vat", "+vat",
];

// ── NEGATIVE SIGNALS ─────────────────────────────────────────────────────────
export const NEGATIVE_SIGNALS: ReadonlyArray<string> = [
  "restaurant", "cafe", "coffee shop", "takeaway", "food delivery", "just eat",
  "hair salon", "nail salon", "beauty salon", "barber", "hairdresser",
  "recruitment agency", "job agency", "staffing agency", "we hire", "submit your cv",
  "estate agent", "letting agent", "property management", "rental property", "for sale",
  "blog", "personal blog", "my thoughts", "travel diary", "lifestyle",
  "local delivery only", "local area only", "uk delivery only", "mainland uk only",
  "dental", "dentist", "gp surgery", "medical practice", "clinic", "pharmacy",
  "nursery", "primary school", "secondary school", "sixth form", "university",
  "charity", "not for profit", "non profit", "registered charity", "donate",
  "plumber", "electrician", "roofer", "builder", "handyman", "decorator",
  "personal trainer", "fitness instructor", "yoga", "pilates", "gym", "crossfit",
  "wedding", "event planning", "party planning", "catering for weddings",
  "under construction", "coming soon", "parked domain", "placeholder",
];

// ── classifyText ─────────────────────────────────────────────────────────────
export interface SignalClassification {
  /** Direct FX evidence: explicit phrases + contextual nationality+sourcing matches. */
  fxPaymentSignals: string[];
  /** Bare nationality adjectives (weak — never count as FX evidence on their own). */
  originHints: string[];
  contextualFx: string[];
  secondarySignals: string[];
  b2bSignals: string[];
  negativeSignals: string[];
  /** True if there is direct FX evidence (≥1 fx signal) or ≥3 secondary signals. */
  paysFx: boolean;
}

function _present(needles: ReadonlyArray<string>, padded: string): string[] {
  return [...new Set(needles.filter((n) => padded.includes(n)))].sort();
}

export function classifyText(text: string): SignalClassification {
  const tlow = ` ${(text || "").toLowerCase().replace(/\s+/g, " ")} `;
  const contextualFx = extractContextualFx(text);
  const explicitFx = _present(FX_PAYMENT_SIGNALS, tlow);
  const fxPaymentSignals = [...new Set([...explicitFx, ...contextualFx])].sort();
  const secondarySignals = _present(SECONDARY_SIGNALS, tlow);
  return {
    fxPaymentSignals,
    contextualFx,
    originHints: extractOriginHints(text),
    secondarySignals,
    b2bSignals: _present(B2B_SIGNALS, tlow),
    negativeSignals: _present(NEGATIVE_SIGNALS, tlow),
    paysFx: fxPaymentSignals.length >= 1 || secondarySignals.length >= 3,
  };
}

// ── LARGE / UNREACHABLE ORGANISATION DETECTION ───────────────────────────────
const _LARGE_ORG_NAME_RES: ReadonlyArray<RegExp> = [
  /\bplc\b/i,
  /\b(group|holdings|holding)\b.{0,30}\bplc\b/i,
  /\b(global|worldwide|international)\s+(corporation|corp|group)\b/i,
  /\bnational\s+(airline|rail|grid|shipping|freight|carrier)\b/i,
  /\bstate[\s-]owned\b/i,
];

const _LARGE_ORG_WEBSITE_PHRASES: ReadonlySet<string> = new Set([
  "listed on the", "stock exchange", "publicly traded", "listed company",
  "global offices in", "offices in over", "worldwide offices", "we operate in over",
  "operating in over", "worldwide network of", "global network of", "state-owned",
  "government-owned", "over 10,000 employees", "over 5,000 employees", "ftse 100",
  "ftse 250", "annual revenue of", "billion turnover", "billion in revenue",
]);

const _LARGE_ORG_DOMAINS: ReadonlySet<string> = new Set([
  "cosco.co.uk", "cosco.com", "cosco-shipping.com",
  "maersk.com", "maersk.co.uk", "cma-cgm.com", "msc.com", "hapag-lloyd.com",
  "dhl.com", "dhl.co.uk", "fedex.com", "fedex.co.uk", "ups.com", "ups.co.uk",
  "dpd.co.uk", "evri.com", "royalmail.com",
  "britishairways.com", "ba.com", "easyjet.com", "ryanair.com", "jet2.com",
  "lufthansa.com", "klm.com", "airfrance.com",
  "tesco.com", "sainsburys.co.uk", "morrisons.com", "asda.com", "waitrose.com",
  "marksandspencer.com", "iceland.co.uk", "aldi.co.uk", "lidl.co.uk",
  "amazon.co.uk", "amazon.com", "ebay.co.uk", "ebay.com",
  "diageo.com", "pernod-ricard.com", "bacardi.com", "hendricksgin.com", "williamgrant.com",
  "shell.com", "shell.co.uk", "bp.com", "exxonmobil.com",
  "unilever.com", "unilever.co.uk", "nestle.com", "nestle.co.uk", "mondelez.com", "pg.com",
]);

function _bareDomain(website: string): string {
  try {
    const host = new URL(website).hostname.toLowerCase();
    return host.replace(/^www\d*\./, "");
  } catch {
    return "";
  }
}

/** PLC / state-owned / global-corp / household-name — not an SME cold-call target. */
export function isLargeOrg(companyName: string, website: string, pageText = ""): boolean {
  const name = (companyName || "").toLowerCase();
  const text = (pageText || "").toLowerCase();

  const dom = _bareDomain(website || "");
  if (dom) {
    if (_LARGE_ORG_DOMAINS.has(dom)) return true;
    for (const d of _LARGE_ORG_DOMAINS) if (dom.endsWith(`.${d}`)) return true;
  }
  for (const re of _LARGE_ORG_NAME_RES) if (re.test(name)) return true;
  if (text) {
    let hits = 0;
    for (const phrase of _LARGE_ORG_WEBSITE_PHRASES) if (text.includes(phrase)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}
