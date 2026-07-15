/**
 * sources/no-website-fallback.ts — when a lead has no website, still surface a
 * usable contact route.
 *
 * Three things this helper does:
 *
 *  1. guessDomainCandidates(companyName) — emit plausible domains from the
 *     cleaned company name (acmewine.co.uk, acme-wine.co.uk, theacmewines.com,
 *     etc.). Caller HEAD-probes each via the cached fetcher; first 2xx wins.
 *
 *  2. ukSwitchboardHint(address) — extract a postcode area (e.g. SW1, M1, EH3)
 *     from the registered office address and look it up against the major UK
 *     area-code map. Surfaces "likely switchboard prefix 020" as a hint, NOT a
 *     phone number — Zac still has to find the real switchboard, but at least
 *     knows roughly where to look.
 *
 *  3. linkedinSearchForTown(name, town) — Google `site:linkedin.com/in
 *     "Director Name" "Bath"` search. Same Priority-12-compliant shape as
 *     the in-stage builders; lives here so the no-website branch doesn't
 *     have to know about Google query encoding.
 *
 * All pure functions. Caller (enrich-decision-makers) decides what to do
 * with the results.
 */

const UK_AREA_CODES: ReadonlyMap<string, string> = new Map([
  // London inner postcodes → 020
  ...["EC", "WC", "E", "N", "NW", "SE", "SW", "W"].map((p) => [p, "020"] as const),
  // Major city outer codes that map to the city's switchboard prefix
  ["B",  "0121"], // Birmingham
  ["M",  "0161"], // Manchester
  ["L",  "0151"], // Liverpool
  ["S",  "0114"], // Sheffield
  ["LS", "0113"], // Leeds
  ["NE", "0191"], // Newcastle
  ["BS", "0117"], // Bristol
  ["CF", "029"],  // Cardiff
  ["EH", "0131"], // Edinburgh
  ["G",  "0141"], // Glasgow
  ["BT", "028"],  // Belfast
  ["NG", "0115"], // Nottingham
  ["LE", "0116"], // Leicester
  ["DH", "0191"], // Durham
  ["OX", "01865"], // Oxford
  ["CB", "01223"], // Cambridge
  ["BA", "01225"], // Bath
  ["BN", "01273"], // Brighton
  ["RG", "0118"], // Reading
  ["SO", "023"],  // Southampton
  ["PO", "023"],  // Portsmouth
  ["PL", "01752"], // Plymouth
]);

const POSTCODE_PREFIX_RE = /\b([A-Z]{1,2})\d/g;

/** Extract a likely UK switchboard prefix from a free-text address. Returns null if no match. */
export function ukSwitchboardHint(address: string): { prefix: string; basis: string } | null {
  if (!address) return null;
  POSTCODE_PREFIX_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = POSTCODE_PREFIX_RE.exec(address.toUpperCase())) !== null) {
    const area = m[1]!;
    const prefix = UK_AREA_CODES.get(area);
    if (prefix) return { prefix, basis: `postcode area ${area} → ${prefix}` };
  }
  return null;
}

const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

/** Extract a plausible town/city for LinkedIn search out of a UK address.
 *  Walks comma-separated chunks right-to-left, skipping postcode-only chunks. */
export function townFromAddress(address: string): string {
  if (!address) return "";
  const chunks = address.split(",").map((c) => c.trim()).filter(Boolean);
  if (!chunks.length) return "";

  // Find the postcode-bearing chunk if any. Its non-postcode remainder is the
  // town ("Bath BA1 1AA" → "Bath"); failing that, the chunk immediately before
  // a country/postcode boundary.
  for (let i = chunks.length - 1; i >= 0; i--) {
    const c = chunks[i]!;
    if (POSTCODE_RE.test(c)) {
      const town = c.replace(POSTCODE_RE, "").trim();
      if (town.length >= 2) return town;
      // chunk was postcode-only — look at the previous chunk
      if (i > 0) return chunks[i - 1]!;
    }
  }
  // No postcode found anywhere. Drop trailing country tokens then take the
  // second-to-last for "Street, Town, County" patterns, last for "Street, Town".
  let pruned = chunks.slice();
  while (pruned.length && /^(uk|united\s+kingdom|england|scotland|wales|northern\s+ireland)$/i.test(pruned[pruned.length - 1]!)) pruned.pop();
  if (pruned.length >= 3) return pruned[pruned.length - 2]!;
  return pruned[pruned.length - 1] ?? "";
}

/** Build a Google→LinkedIn search URL for a person + town. */
export function linkedinSearchForTown(name: string, town: string): string {
  const q = encodeURIComponent(`"${name}"` + (town ? ` "${town}"` : ""));
  return `https://www.google.com/search?q=site:linkedin.com/in+${q}`;
}

// ── Domain guessing ──────────────────────────────────────────────────────────
const COMMON_TLDS = ["co.uk", "com", "uk", "ltd.uk", "io", "net"];

/** Generate plausible domains for a cleaned company name. Returns up to 8. */
export function guessDomainCandidates(companyNameClean: string, opts?: { tlds?: ReadonlyArray<string>; prefixWords?: ReadonlyArray<string> }): string[] {
  const tlds = opts?.tlds ?? COMMON_TLDS;
  const prefixWords = opts?.prefixWords ?? ["the"];
  if (!companyNameClean) return [];

  // tokenise: lowercase alphanumeric words, drop tiny words
  const tokens = companyNameClean.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  if (!tokens.length) return [];

  const concatenated = tokens.join("");                            // acmewine
  const hyphenated = tokens.join("-");                             // acme-wine
  const firstTwo = tokens.slice(0, 2).join("");                    // acmewine (already same in 2-token case)
  const firstTwoHyphen = tokens.slice(0, 2).join("-");
  const firstOnly = tokens[0]!;                                    // acme
  const withPrefix = prefixWords[0] ? `${prefixWords[0]}${concatenated}` : null;  // theacmewine

  const stems = Array.from(new Set([
    concatenated, hyphenated, firstTwo, firstTwoHyphen, firstOnly,
    withPrefix,
  ].filter((s): s is string => !!s && s.length >= 3)));

  // Iterate TLD-first so each stem gets a chance under each common TLD before
  // we exhaust the cap. "acme-wine.co.uk" + "theacmewine.co.uk" both make it
  // in before we move on to .com.
  const out = new Set<string>();
  for (const tld of tlds) {
    for (const stem of stems) {
      out.add(`https://${stem}.${tld}`);
      if (out.size >= 8) break;
    }
    if (out.size >= 8) break;
  }
  return Array.from(out);
}

// ── No-website fallback bundle ───────────────────────────────────────────────
export interface NoWebsiteHints {
  /** Plausible domains to HEAD-probe — first 2xx wins. */
  candidate_domains: string[];
  /** UK switchboard area-code hint, e.g. "020" or "0161". */
  switchboard_prefix: string | null;
  /** Town extracted from the registered address, used in LinkedIn searches. */
  town: string;
  /** Per-director Google→LinkedIn search URL with town qualifier. */
  linkedin_with_town?: string;
}

export function buildNoWebsiteHints(args: { companyNameClean: string; address?: string }): NoWebsiteHints {
  return {
    candidate_domains: guessDomainCandidates(args.companyNameClean),
    switchboard_prefix: args.address ? ukSwitchboardHint(args.address)?.prefix ?? null : null,
    town: args.address ? townFromAddress(args.address) : "",
  };
}
