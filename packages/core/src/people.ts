/**
 * people.ts — extract named decision-makers (name + role + optional email) from
 * a company's own pages. Pure function over an HTML string.
 *
 * Three-pass extractor, ordered by signal quality:
 *
 *   1. JSON-LD <script type="application/ld+json"> schema.org/Person — explicit,
 *      structured, near-zero false positives. Captures jobTitle + email.
 *   2. HTML structure — team-card markup. Each pattern looks for a person's
 *      name in an <h*>/<strong>/<b> + role text in a sibling <p>/<span>/<div>.
 *      Also reads <img alt="James Smith, Finance Director"> attributes.
 *   3. Body-text proximity — capitalised Firstname Lastname within ±120 chars
 *      of a known role label. Conservative; this pass is last because it's
 *      the noisiest (it accidentally grabs "Click Here" if the stop-word list
 *      misses something).
 *
 * mailto: links within ±150 chars of a person's name attach the email.
 *
 * Output items are deduped via namesMatch() — so "Jim Smith" found on /team
 * and "James Smith" found in JSON-LD merge to one Person.
 */
import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { namesMatch, parseChName } from "./names.js";

/** Tier + canonical role label, as written by the decision-maker stage. */
export interface RoleClassification {
  tier: 1 | 2 | 3;
  label: string;
}

// (pattern, tier, canonical label). First match wins, so put more specific
// patterns above less specific ones (e.g. "Finance Director" before "Director").
const ROLE_PATTERNS: ReadonlyArray<{ re: RegExp; tier: 1 | 2 | 3; label: string }> = [
  // Tier 1 — finance + ownership
  { re: /\b(financ\w* director|financial director)\b/i, tier: 1, label: "Finance Director" },
  { re: /\bFD\b/, tier: 1, label: "Finance Director" },
  { re: /\b(chief financial officer|CFO)\b/i, tier: 1, label: "CFO" },
  { re: /\b(head of finance|head of accounts)\b/i, tier: 1, label: "Head of Finance" },
  { re: /\b(treasury manager|treasurer)\b/i, tier: 1, label: "Treasurer" },
  { re: /\b(finance manager)\b/i, tier: 1, label: "Finance Manager" },
  { re: /\b(managing director|MD)\b/i, tier: 1, label: "Managing Director" },
  { re: /\b(chief executive officer?|CEO)\b/i, tier: 1, label: "CEO" },
  { re: /\b(co-?founder|founder)\b/i, tier: 1, label: "Founder" },
  { re: /\b(owner|proprietor)\b/i, tier: 1, label: "Owner" },
  // Tier 2 — commercial / ops / procurement
  { re: /\b(commercial director)\b/i, tier: 2, label: "Commercial Director" },
  { re: /\b(operations director|ops director)\b/i, tier: 2, label: "Operations Director" },
  { re: /\b(procurement director|purchasing director)\b/i, tier: 2, label: "Procurement Director" },
  { re: /\b(supply chain director)\b/i, tier: 2, label: "Supply Chain Director" },
  { re: /\b(sales director)\b/i, tier: 2, label: "Sales Director" },
  { re: /\b(purchasing manager|procurement manager)\b/i, tier: 2, label: "Purchasing Manager" },
  { re: /\b(accounts manager|accounts payable)\b/i, tier: 2, label: "Accounts Manager" },
  { re: /\b(general manager)\b/i, tier: 2, label: "General Manager" },
  // Tier 3 — fallback
  { re: /\b(director)\b/i, tier: 3, label: "Director" },
  { re: /\b(company secretary|secretary)\b/i, tier: 3, label: "Company Secretary" },
  { re: /\bnon-?executive\b/i, tier: 3, label: "Non-Executive" },
];

const ROLE_LABEL_ALL_RE = new RegExp(
  "\\b(" + ROLE_PATTERNS.map((p) => p.re.source.replace(/^\\b\(|\)\\b$/g, "").replace(/^\\b|\\b$/g, "")).join("|") + ")\\b",
  "i",
);

/** Classify a free-text role string. Returns null if no known role appears. */
export function classifyRole(role: string): RoleClassification | null {
  if (!role) return null;
  for (const { re, tier, label } of ROLE_PATTERNS) if (re.test(role)) return { tier, label };
  return null;
}

// Words that look like capitalised proper nouns but aren't names — filter from
// the body-text proximity pass to cut false positives like "Meet Our".
const NAME_STOPWORDS = new Set([
  "about", "the", "and", "for", "our", "your", "with", "from", "team",
  "meet", "home", "contact", "welcome", "services", "products", "company",
  "north", "south", "east", "west", "united", "great", "new", "old",
  "read", "more", "view", "profile", "click", "here", "back", "next",
  "first", "last", "find", "learn", "book", "call", "email", "send",
  "finance", "director", "manager", "head", "chief", "managing", "sales",
  "marketing", "operations", "procurement", "commercial", "supply", "chain",
  "limited", "group", "holdings", "plc", "ltd",
]);

const NAME_RE = /\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})(?:\s+[A-Z][a-z]{1,20})?\b/g;

const JUNK_EMAIL_HOSTS = ["sentry.io", "wixpress.com", "example.com", "domain.com", "email.com", "yourdomain.com"];

export interface ExtractedPerson {
  name: string;
  first_name: string;
  last_name: string;
  role: string;
  role_canonical: string;
  tier: 1 | 2 | 3;
  email: string | null;
  source: "jsonld" | "structure" | "proximity" | "mailto";
}

interface FlatObj { [k: string]: unknown }
function flattenJsonLd(v: unknown, out: FlatObj[] = []): FlatObj[] {
  if (Array.isArray(v)) for (const x of v) flattenJsonLd(x, out);
  else if (v && typeof v === "object") {
    out.push(v as FlatObj);
    for (const x of Object.values(v as FlatObj)) flattenJsonLd(x, out);
  }
  return out;
}

function nameLooksReal(first: string, last: string): boolean {
  if (NAME_STOPWORDS.has(first.toLowerCase()) || NAME_STOPWORDS.has(last.toLowerCase())) return false;
  return first.length >= 2 && last.length >= 2;
}

function mergeOrAdd(found: ExtractedPerson[], p: ExtractedPerson): void {
  for (const existing of found) {
    if (namesMatch(existing.name, p.name)) {
      // Prefer the higher-signal source (jsonld > structure > mailto > proximity)
      const rank = { jsonld: 0, structure: 1, mailto: 2, proximity: 3 };
      if (rank[p.source] < rank[existing.source]) {
        existing.role = p.role || existing.role;
        existing.role_canonical = p.role_canonical || existing.role_canonical;
        existing.tier = Math.min(existing.tier, p.tier) as 1 | 2 | 3;
        existing.source = p.source;
      }
      // Take any new email we don't have.
      if (!existing.email && p.email) existing.email = p.email;
      // Always take the lowest tier (best classification) regardless of source.
      if (p.tier < existing.tier) { existing.tier = p.tier; existing.role_canonical = p.role_canonical; }
      return;
    }
  }
  found.push(p);
}

function cleanRoleText(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim().replace(/[|–—•·:,.]+$/, "").trim();
}

/**
 * Find every named decision-maker on the page. The output is unsorted —
 * decision-maker stage sorts by tier then merges with CH officers.
 */
export function extractPeople(html: string, companyDomain?: string): ExtractedPerson[] {
  if (!html) return [];
  const found: ExtractedPerson[] = [];
  const domain = (companyDomain || "").toLowerCase().replace(/^www\d*\./, "");

  let $: cheerio.CheerioAPI;
  try { $ = cheerio.load(html); } catch { return []; }

  // ── 1) JSON-LD schema.org/Person ───────────────────────────────────────
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    for (const node of flattenJsonLd(parsed)) {
      const t = node["@type"];
      const isPerson = typeof t === "string" ? t.includes("Person") : Array.isArray(t) ? t.some((x) => typeof x === "string" && x.includes("Person")) : false;
      if (!isPerson) continue;
      const name = String(node["name"] ?? "").trim();
      const jobTitle = String(node["jobTitle"] ?? node["roleName"] ?? "").trim();
      const emailRaw = String(node["email"] ?? "").replace(/^mailto:/, "").trim().toLowerCase();
      if (!name || name.split(/\s+/).length < 2) continue;
      const parsed = parseChName(name);
      const cls = classifyRole(jobTitle);
      const host = emailRaw.split("@")[1] ?? "";
      const email = emailRaw.includes("@") && !JUNK_EMAIL_HOSTS.some((j) => host.endsWith(j)) ? emailRaw : null;
      mergeOrAdd(found, {
        name: parsed.full_name,
        first_name: parsed.first_name,
        last_name: parsed.last_name,
        role: jobTitle,
        role_canonical: cls?.label ?? "",
        tier: cls?.tier ?? 3,
        email,
        source: "jsonld",
      });
    }
  });

  // ── 2) HTML structure: team-card patterns ──────────────────────────────
  // Match <h*|strong|b> with a name + adjacent text containing a role keyword.
  // siblingsText() joins prev+next siblings' text with explicit spaces, because
  // cheerio's .text() concatenates adjacent element text without any whitespace
  // — turning <h3>Jane Doe</h3><p>Managing Director</p> into
  // "Jane DoeManaging Director", which kills the \b before "Managing".
  const siblingsText = (el: AnyNode): string => {
    const prevs = $(el).prevAll().toArray().slice(0, 3).map((n) => $(n).text());
    const nexts = $(el).nextAll().toArray().slice(0, 3).map((n) => $(n).text());
    return [...prevs.reverse(), $(el).text(), ...nexts].join(" ").replace(/\s+/g, " ").trim();
  };

  const tagSelectors = ["h2", "h3", "h4", "h5", "strong", "b"];
  for (const sel of tagSelectors) {
    $(sel).each((_i, el) => {
      const nameText = $(el).text().replace(/\s+/g, " ").trim();
      if (!nameText) return;
      const nameMatch = nameText.match(/^([A-Z][a-z]+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)$/);
      if (!nameMatch) return;
      const [, first, lastRest] = nameMatch;
      if (!first || !lastRest) return;
      const last = lastRest.split(/\s+/)[0]!;
      if (!nameLooksReal(first, last)) return;

      const context = siblingsText(el);
      const roleMatch = context.match(ROLE_LABEL_ALL_RE);
      if (!roleMatch) return;

      const role = cleanRoleText(roleMatch[0]);
      const cls = classifyRole(role);
      mergeOrAdd(found, {
        name: `${first} ${last}`, first_name: first, last_name: last,
        role, role_canonical: cls?.label ?? role,
        tier: cls?.tier ?? 3,
        email: null,
        source: "structure",
      });
    });
  }

  // ── 2b) <img alt="James Smith, Finance Director"> ──────────────────────
  $("img[alt]").each((_i, el) => {
    const alt = ($(el).attr("alt") || "").replace(/\s+/g, " ").trim();
    if (!alt) return;
    // "James Smith, Finance Director" or "James Smith - Finance Director"
    const m = alt.match(/^([A-Z][a-z]+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*[,–—\-|]\s*(.+)$/);
    if (!m) return;
    const [, first, lastRest, role] = m;
    if (!first || !lastRest || !role) return;
    const last = lastRest.split(/\s+/)[0]!;
    if (!nameLooksReal(first, last)) return;
    const cls = classifyRole(role);
    if (!cls) return;          // require a real role match to avoid grabbing "James Smith, our customer"
    mergeOrAdd(found, {
      name: `${first} ${last}`, first_name: first, last_name: last,
      role: role.trim(), role_canonical: cls.label, tier: cls.tier,
      email: null, source: "structure",
    });
  });

  // ── 3) Body-text proximity ─────────────────────────────────────────────
  const text = $("body").length ? $("body").text() : $.root().text();
  const flat = text.replace(/\s+/g, " ");
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(flat)) !== null) {
    const first = m[1]!, lastRest = m[2]!;
    const last = lastRest.split(/\s+/)[0]!;
    if (!nameLooksReal(first, last)) continue;
    const start = Math.max(0, m.index - 120);
    const end = Math.min(flat.length, m.index + m[0].length + 120);
    const window = flat.slice(start, end);
    const roleMatch = window.match(ROLE_LABEL_ALL_RE);
    if (!roleMatch) continue;
    const role = cleanRoleText(roleMatch[0]);
    const cls = classifyRole(role);
    mergeOrAdd(found, {
      name: `${first} ${last}`, first_name: first, last_name: last,
      role, role_canonical: cls?.label ?? role, tier: cls?.tier ?? 3,
      email: null, source: "proximity",
    });
  }

  // ── 4) mailto: with surrounding name context. First sweep: try team-card
  //       siblings (h3 + p containing mailto). Second sweep: if no name context
  //       found, try matching the email's local-part to a person we already
  //       extracted (so "sarah@acme.co.uk" can attach to Sarah Brown from h3).
  const unattachedEmails: Array<{ email: string; ctx: string }> = [];
  $("a[href^='mailto:']").each((_i, el) => {
    const href = ($(el).attr("href") || "").trim();
    const email = href.slice(7).split("?")[0]!.toLowerCase().trim();
    if (!email.includes("@")) return;
    const host = email.split("@")[1] ?? "";
    if (!host || JUNK_EMAIL_HOSTS.some((j) => host.endsWith(j))) return;
    if (domain && host !== domain && !host.endsWith(`.${domain}`)) return;
    // Widen context up to the nearest container (team card / list item / table cell).
    const container = $(el).closest("div, section, article, li, td, tr, p").first();
    const ctx = (container.text() || $(el).parent().text() || $(el).text()).replace(/\s+/g, " ");
    const nm = ctx.match(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
    if (!nm) { unattachedEmails.push({ email, ctx }); return; }
    const first = nm[1]!, last = nm[2]!.split(" ")[0]!;
    if (!nameLooksReal(first, last)) { unattachedEmails.push({ email, ctx }); return; }
    const roleMatch = ctx.match(ROLE_LABEL_ALL_RE);
    const role = roleMatch ? cleanRoleText(roleMatch[0]) : "";
    const cls = classifyRole(role);
    mergeOrAdd(found, {
      name: `${first} ${last}`, first_name: first, last_name: last,
      role, role_canonical: cls?.label ?? role, tier: cls?.tier ?? 3,
      email, source: "mailto",
    });
  });

  // Local-part fallback for emails we couldn't attach by name context.
  for (const ue of unattachedEmails) {
    const local = ue.email.split("@")[0]!.toLowerCase().replace(/[^a-z.]/g, "");
    for (const p of found) {
      if (p.email) continue;
      const f = p.first_name.toLowerCase();
      const l = p.last_name.toLowerCase();
      if (!f || !l) continue;
      if (local === f || local === l || local === `${f}.${l}` || local === `${f[0] ?? ""}.${l}` || local === `${f[0] ?? ""}${l}` || local === `${f}${l[0] ?? ""}` || local === `${f}${l}`) {
        p.email = ue.email;
        break;
      }
    }
  }

  return found;
}
