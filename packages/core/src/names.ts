/**
 * names.ts — name handling utilities shared by every enrichment stage.
 *
 * What's in here:
 *   * cleanCompanyName / linkedinCompanyName — strip page-title artifacts,
 *     slogans, and legal suffixes. Used to build LinkedIn/Google search URLs
 *     and to display a tidy company label.
 *   * parseChName — split "SMITH, James David" into first/last/full/initials.
 *   * normalisedFirstName — collapse nicknames (Jim → James, Bob → Robert) so
 *     "Jim Smith" and "James Smith" match when comparing people across pages.
 *   * levenshtein + nameSimilarity — fuzzy comparison for cross-page dedup.
 *     Replaces the old "any token overlap" check that merged every "John".
 *
 * Pure functions, no I/O. Ported from scripts/legacy/enrich_decision_makers.py
 * with extra care around the well-documented dedup false-positives.
 */

// ── Company-name cleaner ─────────────────────────────────────────────────────
const TITLE_PREFIX_RE = /^(about\s+us|home|contact(\s+us)?|welcome\s+to|hello|news|blog|team|our\s+team|meet\s+the\s+team|management|leadership)\s*[-–—|:]\s*/i;
const LEGAL_SUFFIX_RE = /\s+(limited|ltd\.?|plc|llp|llc|inc\.?|corp\.?|group|holdings?|uk|united\s+kingdom)\s*$/i;

/** Return a clean company name for display + LinkedIn/Google search use. */
export function cleanCompanyName(raw: string): string {
  if (!raw) return "";
  let name = raw.trim();

  // CH-sourced names ship in ALL CAPS — title-case for readability.
  if (name === name.toUpperCase() && name.length > 2) {
    name = name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Strip page-title prefixes ("About Us - ", "Home | ").
  name = name.replace(TITLE_PREFIX_RE, "").trim();

  // Strip slogan suffixes after a separator when 3+ words follow ("Acme — the
  // best widgets in town" → "Acme") but keep short trade descriptors.
  for (const sep of ["|", "–", "—"]) {
    const idx = name.indexOf(sep);
    if (idx > 0) {
      const after = name.slice(idx + 1).trim();
      if (after.split(/\s+/).length >= 3) { name = name.slice(0, idx).trim(); break; }
    }
  }

  // Strip generic legal/geographic suffixes for search use.
  name = name.replace(LEGAL_SUFFIX_RE, "").trim();
  return name.replace(/[-–—|:,.\s]+$/, "");
}

/** Short version (≤ 3 words) of cleanCompanyName, ideal for LinkedIn search. */
export function linkedinCompanyName(raw: string): string {
  const clean = cleanCompanyName(raw);
  const words = clean.split(/\s+/).filter(Boolean);
  return words.slice(0, 3).join(" ") || clean;
}

// ── companyNameKey — aggressive normalisation for dedup grouping ─────────────
// Generic / trade-descriptor tokens that should not contribute to identity.
// "dragon import services" should dedup to "dragon" — but a single-token
// distinctive key is too weak to merge on (see isDedupableNameKey).
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  "the", "and", "of", "for",
  "company", "co", "uk",
  "ltd", "limited", "plc", "llp", "llc", "inc", "corp", "corporation",
  "group", "holdings", "holding",
  "import", "imports", "importer", "importers", "importing",
  "export", "exports", "exporter", "exporters", "exporting",
  "trade", "trading", "trader", "traders",
  "wholesale", "wholesaler", "wholesalers",
  "distributor", "distributors", "distribution",
  "supplier", "suppliers", "supply", "supplies",
  "services", "service", "solutions", "consulting",
  "international", "global", "worldwide",
  "about", "home", "contact", "welcome",
]);

/**
 * Normalised dedup key for a company name. Strips legal suffixes, page-title
 * slogans, punctuation, diacritics, generic trade tokens — leaves only the
 * distinctive identifying tokens. Returns "" if the input collapses to
 * nothing (eg. "Import Services Ltd" → all generic).
 *
 * Pair with isDedupableNameKey() before using the key to merge leads — a key
 * with a single short token is too weak (every "consulting" / "trading"
 * remnant would collide).
 */
export function companyNameKey(raw: string): string {
  if (!raw) return "";
  let name = cleanCompanyName(raw).toLowerCase();
  name = name.normalize("NFD").replace(/[̀-ͯ]/g, "");      // strip diacritics
  name = name.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return "";
  const tokens = name.split(" ").filter((t) => t && !GENERIC_NAME_TOKENS.has(t));
  return tokens.join(" ");
}

/**
 * Is a normalised key specific enough to safely merge leads on? Requires at
 * least 2 distinct tokens, ≥6 chars total — keeps "wine importers" → "wine"
 * (1 token) out, lets "boutique french wine" through.
 */
export function isDedupableNameKey(key: string): boolean {
  if (!key) return false;
  const tokens = key.split(" ").filter(Boolean);
  if (tokens.length < 2) return false;
  if (key.replace(/\s/g, "").length < 6) return false;
  return true;
}

// ── CH name parser ───────────────────────────────────────────────────────────
export interface ParsedName {
  full_name: string;
  first_name: string;
  last_name: string;
  initials: string;
}

/** Parse a CH-style "SURNAME, Firstname Middle" or "Firstname Surname" string. */
export function parseChName(raw: string): ParsedName {
  const name = (raw || "").trim();
  let first = "", last = "";

  if (name.includes(",")) {
    const [lastRaw, restRaw = ""] = name.split(",", 2);
    last = titleCase((lastRaw ?? "").trim());
    const parts = restRaw.trim().split(/\s+/).filter(Boolean);
    first = parts[0] ? capitalise(parts[0]) : "";
  } else {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      last = titleCase(parts[0]!);
    } else if (parts.length >= 2) {
      first = capitalise(parts[0]!);
      last = titleCase(parts[parts.length - 1]!);
    }
  }

  const full = first ? `${first} ${last}`.trim() : last;
  const initials = full.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? "").join("");
  return { full_name: full, first_name: first, last_name: last, initials };
}

function titleCase(s: string): string { return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()); }
function capitalise(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

// ── Nickname dictionary ──────────────────────────────────────────────────────
// English-language nicknames → canonical form. Used so "Jim Smith" (on a
// careers page) merges with CH's "James Smith". Bidirectional inside each
// group: every variant maps to the canonical (first listed), and the canonical
// maps to itself. Intentionally not exhaustive — only the high-confidence
// pairings where collision risk is essentially zero.
const NICKNAME_GROUPS: ReadonlyArray<readonly string[]> = [
  ["james", "jim", "jimmy", "jamie"],
  ["robert", "bob", "bobby", "rob", "robbie"],
  ["william", "will", "bill", "billy", "willy"],
  ["richard", "rick", "dick", "rich", "richie"],
  ["michael", "mike", "mick", "mikey"],
  ["thomas", "tom", "tommy"],
  ["edward", "ed", "eddie", "ted", "teddy", "ned"],
  ["charles", "charlie", "chuck"],
  ["christopher", "chris", "christo"],
  ["nicholas", "nick", "nicky"],
  ["anthony", "tony"],
  ["alexander", "alex", "alec", "sandy"],
  ["benjamin", "ben", "benji"],
  ["daniel", "dan", "danny"],
  ["david", "dave", "davy"],
  ["donald", "don", "donny"],
  ["francis", "frank", "frankie"],
  ["frederick", "fred", "freddy", "freddie"],
  ["gerald", "gerry", "jerry"],
  ["henry", "harry", "hank"],
  ["jonathan", "jon", "jonny", "jonathon"],
  ["joseph", "joe", "joey"],
  ["kenneth", "ken", "kenny"],
  ["lawrence", "larry"],
  ["leonard", "len", "lenny", "leo"],
  ["matthew", "matt", "matty"],
  ["patrick", "pat", "paddy"],
  ["peter", "pete"],
  ["philip", "phil"],
  ["raymond", "ray"],
  ["ronald", "ron", "ronnie"],
  ["samuel", "sam", "sammy"],
  ["stephen", "steve", "steven", "stevie"],
  ["steven", "steve", "stephen", "stevie"],
  ["timothy", "tim", "timmy"],
  ["victor", "vic"],
  // Women
  ["elizabeth", "liz", "beth", "betty", "lizzie", "eliza"],
  ["katherine", "kate", "katie", "kathy", "kathleen", "kit"],
  ["catherine", "kate", "katie", "kathy", "cathy"],
  ["margaret", "maggie", "meg", "peggy", "margie"],
  ["jennifer", "jen", "jenny"],
  ["patricia", "pat", "patty", "tricia", "trish"],
  ["susan", "sue", "susie"],
  ["deborah", "deb", "debbie"],
  ["rebecca", "becky", "becca"],
  ["alexandra", "alex", "lexi", "sandra"],
];

const NICKNAME_TO_CANONICAL: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const group of NICKNAME_GROUPS) {
    const canon = group[0]!;
    for (const v of group) m.set(v, canon);
  }
  return m;
})();

/** Lower-case, accent-stripped, nickname-collapsed first name. */
export function normalisedFirstName(name: string): string {
  const cleaned = (name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
  if (!cleaned) return "";
  return NICKNAME_TO_CANONICAL.get(cleaned) ?? cleaned;
}

// ── Levenshtein + nameSimilarity ─────────────────────────────────────────────
/** Standard Levenshtein edit distance. O(n*m); fine for short strings (names). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * "Are these two names the same person?" Conservative — last name must match
 * exactly (≥3 chars) and first name must either match after nickname-collapse
 * or be within Levenshtein 1 (typo tolerance). The previous implementation
 * returned true on any token overlap, merging every "John" into one person.
 */
export function namesMatch(a: string, b: string): boolean {
  const A = parseChName(a), B = parseChName(b);
  if (!A.last_name || !B.last_name) return false;
  const lastA = A.last_name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const lastB = B.last_name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (lastA.length < 3 || lastB.length < 3) return false;
  if (lastA !== lastB) return false;

  if (!A.first_name || !B.first_name) return true;       // last match alone is enough when one side has no first
  const fa = normalisedFirstName(A.first_name);
  const fb = normalisedFirstName(B.first_name);
  if (!fa || !fb) return true;
  if (fa === fb) return true;
  // Single-letter initials are weak evidence — accept only if one is the initial of the other
  if (fa.length === 1) return fa === fb[0];
  if (fb.length === 1) return fb === fa[0];
  // Typo tolerance: one edit for 4+ letter names, exact otherwise
  return Math.min(fa.length, fb.length) >= 4 && levenshtein(fa, fb) <= 1;
}

/** Similarity in [0,1] — exposed for ranking/cluster cases that want a score, not a boolean. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (namesMatch(a, b)) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  return 1 - levenshtein(a.toLowerCase(), b.toLowerCase()) / maxLen;
}
