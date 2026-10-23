/**
 * contacts.ts — pull contact routes out of a company's own website HTML.
 * Pure (takes an HTML string; no I/O).
 *
 *   const c = extractContactInfo(html, "https://acme.co.uk/", "acme.co.uk");
 *   // -> { contact_phone, contact_phones, contact_email, contact_emails_found,
 *   //      contact_page, about_page, team_page }
 *   lead.best_contact_route = bestContactRoute({ ...lead, ...c });
 *
 * Phone numbers are parsed via libphonenumber-js (default region GB) and stored
 * in two parallel arrays: display ("020 7946 0123") and normalised E.164
 * ("+442079460123"). De-dup is by E.164, so "020 7946 0123" and "+44 20 7946 0123"
 * collapse to one entry.
 *
 * Emails are handled in two passes:
 *   1. Cloudflare email-obfuscation deobfuscator runs over the raw HTML first
 *      (data-cfemail="..." → real address).
 *   2. "[at]" / "[dot]" / "(at)" patterns are normalised before regex extraction.
 */
import * as cheerio from "cheerio";
// /max imports the full metadata bundle (~140 KB) so getType() returns
// "MOBILE"/"FIXED_LINE"/"TOLL_FREE" etc. The default "min" build only validates,
// it doesn't classify — and "is this a switchboard or a personal mobile?" is
// useful enough to be worth the bytes (we only run this server-side anyway).
import { parsePhoneNumberFromString, type PhoneNumber } from "libphonenumber-js/max";

const FINANCE_PREFIXES = ["accounts", "finance", "ap", "ar", "payments", "treasury", "purchasing", "procurement"];
const GENERIC_PREFIXES = ["info", "enquiries", "enquiry", "hello", "contact", "office", "admin", "sales", "mail", "team"];
const JUNK_EMAIL_HOSTS = ["sentry.io", "wixpress.com", "example.com", "domain.com", "email.com", "yourdomain.com", "sentry-next.wixpress.com"];

const PAGE_KEYWORDS: Record<"contact_page" | "about_page" | "team_page", string[]> = {
  contact_page: ["contact", "contact-us", "contactus", "get-in-touch"],
  about_page: ["about", "about-us", "aboutus", "who-we-are", "our-story", "our-company", "the-company"],
  team_page: ["team", "our-team", "meet-the-team", "people", "our-people", "management", "leadership", "directors", "staff", "key-people"],
};

// Wide-net phone regex — anything that looks like 9+ digits separated by typical
// punctuation. libphonenumber-js does the real validation downstream.
const PHONE_RE = /(?<![\w/])(?:\+?\d[\d\s().\-]{8,18}\d)(?![\w/])/g;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * Reverse Cloudflare's email obfuscation. `<a data-cfemail="xxxx...">` encodes
 * the address by XOR'ing each byte with the first byte (the "key"). Idempotent —
 * inputs without data-cfemail come back unchanged.
 */
export function deobfuscateCloudflareEmails(html: string): string {
  return html.replace(/data-cfemail=["']([a-f0-9]+)["']/gi, (full, hex: string) => {
    if (!hex || hex.length < 4 || hex.length % 2) return full;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) {
      const code = parseInt(hex.slice(i, i + 2), 16) ^ key;
      if (Number.isNaN(code)) return full;
      out += String.fromCharCode(code);
    }
    return `data-cfemail="${hex}">${out}<`;
  });
}

/** Normalise common "[at]" / "[dot]" / "(at)" obfuscations to "@" / "." so EMAIL_RE catches them. */
export function deobfuscateAtDot(text: string): string {
  return text
    .replace(/\s*[[(\{]\s*at\s*[\])\}]\s*/gi, "@")
    .replace(/\s*[[(\{]\s*dot\s*[\])\}]\s*/gi, ".")
    .replace(/\s+at\s+(?=[a-z0-9][a-z0-9.-]*\s+dot\s+[a-z]{2,})/gi, "@")    // " name at acme dot com"
    .replace(/(?<=@[a-z0-9-]+(?:\.[a-z0-9-]+)*)\s+dot\s+(?=[a-z]{2,})/gi, ".");
}

/**
 * Parse a raw phone string with libphonenumber-js (default region GB).
 * Returns { display, e164, type } or null if it doesn't look like a real number.
 *   - display: normalised national format ("020 7946 0123")
 *   - e164: "+442079460123" (used for dedup)
 *   - type: "fixed_line" | "mobile" | "toll_free" | "premium_rate" | … or "" if unknown
 */
export function parsePhone(raw: string, defaultRegion: "GB" | "US" | "IE" | "FR" | "DE" = "GB"):
  | { display: string; e164: string; type: string }
  | null
{
  if (!raw) return null;
  let parsed: PhoneNumber | undefined;
  try { parsed = parsePhoneNumberFromString(raw, defaultRegion); } catch { return null; }
  if (!parsed || !parsed.isPossible()) return null;
  const type = (parsed.getType?.() ?? "").toString().toLowerCase();
  return { display: parsed.formatNational(), e164: parsed.number, type };
}

function registrable(host: string): string {
  return (host || "").toLowerCase().split(":")[0]!.replace(/^www\d*\./, "");
}

function sameSite(url: string, baseDomain: string): boolean {
  try {
    const host = new URL(url).hostname;
    return registrable(host) === baseDomain || !host;
  } catch {
    return false;
  }
}

function emailRank(email: string): number {
  const local = email.split("@", 1)[0]!.toLowerCase();
  if (FINANCE_PREFIXES.includes(local)) return 0;
  if (FINANCE_PREFIXES.some((p) => local.startsWith(p))) return 1;
  if (GENERIC_PREFIXES.includes(local)) return 2;
  if (GENERIC_PREFIXES.some((p) => local.startsWith(p))) return 3;
  return 4;
}

export interface ContactInfo {
  contact_phone: string | null;          // display format, e.g. "020 7946 0123"
  contact_phones: string[];              // display format, deduped via E.164
  contact_phones_e164: string[];         // canonical "+44…" for the same list, same order
  contact_phone_types: string[];         // "fixed_line" | "mobile" | "toll_free" | "" — same order
  contact_email: string | null;
  contact_emails_found: string[];
  contact_page: string | null;
  about_page: string | null;
  team_page: string | null;
}

export const CONTACT_FIELDS = [
  "contact_phone", "contact_phones", "contact_phones_e164", "contact_phone_types",
  "contact_email", "contact_emails_found",
  "contact_page", "about_page", "team_page",
] as const;

const EMPTY_CONTACT: ContactInfo = {
  contact_phone: null, contact_phones: [], contact_phones_e164: [], contact_phone_types: [],
  contact_email: null, contact_emails_found: [],
  contact_page: null, about_page: null, team_page: null,
};

/** Extract phones / on-page emails / contact-about-team page links from page HTML. */
export function extractContactInfo(html: string, baseUrl: string, companyDomain?: string): ContactInfo {
  const out: ContactInfo = { ...EMPTY_CONTACT };
  if (!html) return out;

  let baseDomain = "";
  try {
    baseDomain = companyDomain ? registrable(companyDomain) : registrable(new URL(baseUrl).hostname);
  } catch { baseDomain = ""; }

  // Reverse Cloudflare obfuscation up-front so cheerio gets clean mailto: text.
  const deobfHtml = deobfuscateCloudflareEmails(html);

  let $: cheerio.CheerioAPI;
  try { $ = cheerio.load(deobfHtml); } catch { return out; }

  type PhoneHit = { display: string; e164: string; type: string };
  const phoneHits: PhoneHit[] = [];
  const emails: string[] = [];

  $('a[href^="tel:"]').each((_i, el) => {
    const p = parsePhone(($(el).attr("href") || "").slice(4));
    if (p) phoneHits.push(p);
  });
  $('a[href^="mailto:"]').each((_i, el) => {
    const e = ($(el).attr("href") || "").slice(7).split("?")[0]!.trim().toLowerCase();
    if (e.includes("@")) emails.push(e);
  });

  $("a[href]").each((_i, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/.test(href)) return;
    let absu: string;
    try { absu = new URL(href, baseUrl).toString(); } catch { return; }
    if (baseDomain && !sameSite(absu, baseDomain)) return;
    let path = "";
    try { path = new URL(absu).pathname; } catch { path = ""; }
    const hay = `${path} ${$(el).text().replace(/\s+/g, " ").trim()}`.toLowerCase();
    for (const field of ["contact_page", "about_page", "team_page"] as const) {
      if (out[field]) continue;
      if (PAGE_KEYWORDS[field].some((k) => new RegExp(`(^|[/\\s\\-_])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([/\\s\\-_]|$)`).test(hay))) {
        out[field] = absu;
      }
    }
  });

  // free-text scan (phones/emails not wrapped in links). Run the [at]/[dot]
  // deobfuscator over plain text so obfuscated emails get caught too.
  const rawText = ($("body").length ? $("body").text() : $.root().text()).replace(/\s+/g, " ");
  const text = deobfuscateAtDot(rawText);
  for (const m of text.match(PHONE_RE) ?? []) { const p = parsePhone(m); if (p) phoneHits.push(p); }
  for (const m of text.match(EMAIL_RE) ?? []) emails.push(m.trim().toLowerCase());

  // dedupe + filter emails
  const seenE = new Set<string>();
  const cleanE: string[] = [];
  for (const e of emails) {
    if (seenE.has(e)) continue;
    const at = e.indexOf("@");
    if (at < 1 || at === e.length - 1) continue;            // no/empty local or host
    const host = e.slice(at + 1);
    if (JUNK_EMAIL_HOSTS.some((j) => host.endsWith(j))) continue;
    if (baseDomain && !(host === baseDomain || host.endsWith(`.${baseDomain}`))) continue;
    seenE.add(e);
    cleanE.push(e);
  }
  cleanE.sort((a, b) => emailRank(a) - emailRank(b));

  // dedupe phones by E.164, keep first-seen order
  const seenP = new Set<string>();
  const display: string[] = [], e164: string[] = [], types: string[] = [];
  for (const p of phoneHits) {
    if (seenP.has(p.e164)) continue;
    seenP.add(p.e164);
    display.push(p.display); e164.push(p.e164); types.push(p.type);
  }

  out.contact_phones = display.slice(0, 3);
  out.contact_phones_e164 = e164.slice(0, 3);
  out.contact_phone_types = types.slice(0, 3);
  out.contact_phone = display[0] ?? null;
  out.contact_emails_found = cleanE.slice(0, 4);
  out.contact_email = cleanE[0] ?? null;
  return out;
}

// ── route suggestion ─────────────────────────────────────────────────────────
interface RouteLead {
  contact_phone?: string | null;
  contact_email?: string | null;
  contact_emails_found?: string[];
  contact_page?: string | null;
  director_name?: string | null;
  director_role?: string | null;
  generic_emails?: Array<{ email?: string }> | null;
  guessed_emails?: Array<{ email?: string }> | null;
  website?: string | null;
}

export function hasContactRoute(lead: RouteLead): boolean {
  return !!(lead.contact_phone || lead.contact_email || (lead.contact_emails_found?.length)
    || lead.contact_page || lead.director_name || (lead.guessed_emails?.length) || lead.website);
}

export function bestContactRoute(lead: RouteLead): string {
  const phone = lead.contact_phone ?? null;
  const emailsFound = lead.contact_emails_found?.length ? lead.contact_emails_found : (lead.contact_email ? [lead.contact_email] : []);
  const contactPage = lead.contact_page ?? null;
  const director = lead.director_name ?? null;
  const role = lead.director_role ?? null;
  const generic = (lead.generic_emails ?? lead.guessed_emails ?? []).map((e) => e?.email).filter((x): x is string => !!x);
  const website = lead.website ?? null;

  const fin = emailsFound.find((e) => e.includes("@") && FINANCE_PREFIXES.includes(e.split("@", 1)[0]!.toLowerCase()));
  if (fin) return `Email ${fin} directly (accounts/finance) — say you'd like a quick word with whoever handles supplier payments / currency.`;
  if (phone) {
    const who = !director ? "the Finance Director / MD" : `${director}${role ? ` (${role})` : ""}`;
    return `Call the switchboard on ${phone} — ask for ${who}.`;
  }
  const realGeneric = emailsFound.find((e) => e.includes("@") && GENERIC_PREFIXES.includes(e.split("@", 1)[0]!.toLowerCase()));
  if (realGeneric) return `Email ${realGeneric} — ask to be put through to whoever handles supplier payments / FX.`;
  if (contactPage) {
    const who = !director ? "the Finance Director / MD" : `${director}${role ? ` (${role})` : ""}`;
    return `Use the contact page (${contactPage}) — ask for ${who}.`;
  }
  if (director) return `Look up ${director}${role ? ` (${role})` : ""} on LinkedIn (or use the Companies-House director route), then call the switchboard.`;
  if (generic.length) return `Find the switchboard number from the website; failing that, try ${generic[0]}.`;
  if (website) return `Pull the phone number / contact page from ${website}.`;
  return "No contact route yet — needs manual research (try Companies House for a director, then the website).";
}

const ARRAY_FIELDS: ReadonlySet<typeof CONTACT_FIELDS[number]> = new Set([
  "contact_phones", "contact_phones_e164", "contact_phone_types", "contact_emails_found",
]);

/** Set the CONTACT_FIELDS to their defaults on a lead-like object (idempotent). */
export function clearContactFields(lead: Record<string, unknown>): void {
  for (const f of CONTACT_FIELDS) lead[f] = ARRAY_FIELDS.has(f) ? [] : null;
}

/** Ensure CONTACT_FIELDS exist on a lead-like object (default null / []), without overwriting set values. */
export function ensureContactFields(lead: Record<string, unknown>): void {
  for (const f of CONTACT_FIELDS) {
    if (lead[f] === undefined) lead[f] = ARRAY_FIELDS.has(f) ? [] : null;
  }
}
