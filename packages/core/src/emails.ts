/**
 * emails.ts — email pattern generation and domain-pattern inference.
 *
 * Two related concerns:
 *
 *   1. generateEmailGuesses(first, last, domain) — emit the standard 10 local-part
 *      patterns that account for ~95% of real corporate addresses. The Python v1
 *      shipped 6; this adds {last}@, {first}-{last}@, {first}.{l}@, {f}{l}@ and
 *      {l}{first}@ which are common in UK SMEs.
 *
 *   2. inferDomainEmailPattern(knownEmails, domain) — given a few real emails
 *      found on a company's own site (e.g. "info@acme.com", "joe.smith@acme.com"),
 *      identify which pattern the company uses and return a confidence in [0,1].
 *      Then rankEmailGuessesByPattern() upweights guesses matching that pattern.
 *
 *      Why: the Python v1 emits all 6 guesses with no preference signal — when
 *      SMTP can't verify (catch-all domains, or CI where port 25 is blocked),
 *      the dashboard has no way to rank them. Domain-pattern inference fills
 *      that gap entirely without a single new network call: if 3 emails on
 *      acme.com all use first.last@, every guess for acme directors gets
 *      first.last@ ranked first with high confidence.
 *
 * Pure functions, no I/O.
 */

const ALPHA = /[^a-z]/g;

/** Lower-case + strip non-letter characters. */
function clean(s: string | undefined | null): string {
  return (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(ALPHA, "");
}

export type EmailPattern =
  | "first"           // joe
  | "last"            // smith
  | "first.last"      // joe.smith
  | "first_last"      // joe_smith
  | "first-last"      // joe-smith
  | "firstlast"       // joesmith
  | "f.last"          // j.smith
  | "flast"           // jsmith
  | "first.l"         // joe.s
  | "firstl"          // joes
  | "last.first"      // smith.joe
  | "lfirst";         // sjoe

const PATTERN_BUILDERS: ReadonlyArray<{ pattern: EmailPattern; build: (f: string, l: string) => string }> = [
  { pattern: "first.last",  build: (f, l) => `${f}.${l}` },
  { pattern: "first",       build: (f) =>    f },
  { pattern: "firstlast",   build: (f, l) => `${f}${l}` },
  { pattern: "flast",       build: (f, l) => `${f[0] ?? ""}${l}` },
  { pattern: "f.last",      build: (f, l) => `${f[0] ?? ""}.${l}` },
  { pattern: "first_last",  build: (f, l) => `${f}_${l}` },
  { pattern: "first-last",  build: (f, l) => `${f}-${l}` },
  { pattern: "firstl",      build: (f, l) => `${f}${l[0] ?? ""}` },
  { pattern: "first.l",     build: (f, l) => `${f}.${l[0] ?? ""}` },
  { pattern: "last",        build: (_f, l) => l },
  { pattern: "last.first",  build: (f, l) => `${l}.${f}` },
  { pattern: "lfirst",      build: (f, l) => `${l[0] ?? ""}${f}` },
];

export interface GeneratedGuess { pattern: EmailPattern; email: string; }

/** Generate the standard 12 patterns for a name@domain. Caller can SMTP-verify or rank. */
export function generateEmailGuesses(first: string, last: string, domain: string): GeneratedGuess[] {
  const f = clean(first), l = clean(last), d = (domain || "").toLowerCase();
  if (!d) return [];
  if (!f && !l) return [];
  const seen = new Set<string>();
  const out: GeneratedGuess[] = [];
  for (const { pattern, build } of PATTERN_BUILDERS) {
    const local = build(f, l);
    if (!local || local.length < 2) continue;       // skip degenerate (e.g. {first}@ with no first)
    const email = `${local}@${d}`;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ pattern, email });
  }
  return out;
}

/**
 * Classify a single email's local-part against the standard patterns, given the
 * name it's known to belong to (if any). Returns null if no name context is
 * available — we never guess at "is jsmith@ a flast pattern for Smith?" without
 * a known surname to compare to.
 */
export function classifyLocalPart(localPart: string, first?: string, last?: string): EmailPattern | null {
  const local = (localPart || "").toLowerCase();
  const f = clean(first), l = clean(last);
  if (!local || (!f && !l)) return null;
  // Try every known pattern and return the first match.
  for (const { pattern, build } of PATTERN_BUILDERS) {
    if (build(f, l) === local && build(f, l).length >= 2) return pattern;
  }
  return null;
}

export interface DomainPatternResult {
  pattern: EmailPattern | null;
  confidence: number;             // 0..1 — share of evidence emails matching the chosen pattern
  evidence_count: number;         // how many emails contributed to the inference
}

const GENERIC_LOCALS = new Set([
  "info", "hello", "contact", "enquiries", "enquiry", "office", "admin", "sales", "mail", "team",
  "support", "help", "marketing", "noreply", "no-reply", "donotreply",
  "accounts", "finance", "ap", "ar", "payments", "treasury", "purchasing", "procurement", "billing",
]);

/**
 * Look at every email we already know belongs to a *named person* on a domain
 * (from on-site mailto:, schema.org Person, or SMTP-verified guesses with
 * known name context) and infer which pattern the company uses.
 *
 * `knownEmails` items: { email, first?, last? }. Generic addresses without a
 * known name are filtered out — they tell us nothing about the pattern.
 */
export function inferDomainEmailPattern(
  knownEmails: ReadonlyArray<{ email: string; first?: string; last?: string }>,
  domain: string,
): DomainPatternResult {
  const d = (domain || "").toLowerCase();
  if (!d) return { pattern: null, confidence: 0, evidence_count: 0 };

  const tally = new Map<EmailPattern, number>();
  let evidence = 0;
  for (const ev of knownEmails) {
    const email = (ev.email || "").toLowerCase();
    const at = email.indexOf("@");
    if (at <= 0) continue;
    const local = email.slice(0, at);
    const host = email.slice(at + 1);
    if (host !== d && !host.endsWith(`.${d}`)) continue;
    if (GENERIC_LOCALS.has(local)) continue;
    if (!ev.first && !ev.last) continue;
    const pattern = classifyLocalPart(local, ev.first, ev.last);
    if (!pattern) continue;
    evidence++;
    tally.set(pattern, (tally.get(pattern) ?? 0) + 1);
  }

  if (evidence === 0) return { pattern: null, confidence: 0, evidence_count: 0 };

  let best: EmailPattern | null = null, bestN = 0;
  for (const [p, n] of tally) if (n > bestN) { best = p; bestN = n; }
  return { pattern: best, confidence: bestN / evidence, evidence_count: evidence };
}

/**
 * Re-rank a list of guesses so the inferred-pattern entry sits first and
 * carries a pattern_confidence in [0,1]. Other guesses keep their position
 * relative to each other.
 */
export interface RankedGuess extends GeneratedGuess { pattern_confidence: number; }
export function rankEmailGuessesByPattern(
  guesses: ReadonlyArray<GeneratedGuess>,
  inferred: DomainPatternResult,
): RankedGuess[] {
  if (!inferred.pattern) return guesses.map((g) => ({ ...g, pattern_confidence: 0 }));
  const winners: RankedGuess[] = [];
  const rest: RankedGuess[] = [];
  for (const g of guesses) {
    if (g.pattern === inferred.pattern) winners.push({ ...g, pattern_confidence: inferred.confidence });
    else rest.push({ ...g, pattern_confidence: 0 });
  }
  return [...winners, ...rest];
}
