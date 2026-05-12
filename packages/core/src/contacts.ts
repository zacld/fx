/**
 * contacts.ts — pull contact routes out of a company's own website HTML.
 * Faithful port of scripts/contacts.py. Pure (takes an HTML string; no I/O).
 *
 *   const c = extractContactInfo(html, "https://acme.co.uk/", "acme.co.uk");
 *   // -> { contact_phone, contact_phones, contact_email, contact_emails_found,
 *   //      contact_page, about_page, team_page }
 *   lead.best_contact_route = bestContactRoute({ ...lead, ...c });
 */
import * as cheerio from "cheerio";

const FINANCE_PREFIXES = ["accounts", "finance", "ap", "ar", "payments", "treasury", "purchasing", "procurement"];
const GENERIC_PREFIXES = ["info", "enquiries", "enquiry", "hello", "contact", "office", "admin", "sales", "mail", "team"];
const JUNK_EMAIL_HOSTS = ["sentry.io", "wixpress.com", "example.com", "domain.com", "email.com", "yourdomain.com", "sentry-next.wixpress.com"];

const PAGE_KEYWORDS: Record<"contact_page" | "about_page" | "team_page", string[]> = {
  contact_page: ["contact", "contact-us", "contactus", "get-in-touch"],
  about_page: ["about", "about-us", "aboutus", "who-we-are", "our-story", "our-company", "the-company"],
  team_page: ["team", "our-team", "meet-the-team", "people", "our-people", "management", "leadership", "directors", "staff", "key-people"],
};

// UK-ish phone numbers in free text — optional +44 / leading 0, then 9–13 more digits with separators.
const PHONE_RE = /(?<![\d/])(?:\+44\s?\(?0?\)?\s?|\(?0)\s?\d{1,5}[)\s.-]?\s?\d{2,4}[\s.-]?\d{3,4}(?![\d/])/g;
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function normPhone(raw: string): string | null {
  let digits = (raw || "").replace(/[^\d+]/g, "");
  digits = digits.replace(/^\+440/, "+44").replace(/^00/, "+");
  const n = digits.replace(/\D/g, "");
  if (n.length < 9 || n.length > 13) return null;
  return (raw || "").trim().replace(/\s+/g, " ");
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
  contact_phone: string | null;
  contact_phones: string[];
  contact_email: string | null;
  contact_emails_found: string[];
  contact_page: string | null;
  about_page: string | null;
  team_page: string | null;
}

export const CONTACT_FIELDS = [
  "contact_phone", "contact_phones", "contact_email", "contact_emails_found",
  "contact_page", "about_page", "team_page",
] as const;

const EMPTY_CONTACT: ContactInfo = {
  contact_phone: null, contact_phones: [], contact_email: null, contact_emails_found: [],
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

  let $: cheerio.CheerioAPI;
  try { $ = cheerio.load(html); } catch { return out; }

  const phones: string[] = [];
  const emails: string[] = [];

  $('a[href^="tel:"]').each((_i, el) => {
    const p = normPhone(($(el).attr("href") || "").slice(4));
    if (p) phones.push(p);
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

  // free-text scan (phones/emails not wrapped in links)
  const text = ($("body").length ? $("body").text() : $.root().text()).replace(/\s+/g, " ");
  for (const m of text.match(PHONE_RE) ?? []) { const p = normPhone(m); if (p) phones.push(p); }
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

  // dedupe phones (by digit string), keep order
  const seenP = new Set<string>();
  const cleanP: string[] = [];
  for (const p of phones) {
    const key = p.replace(/\D/g, "");
    if (!key || seenP.has(key)) continue;
    seenP.add(key);
    cleanP.push(p);
  }

  out.contact_phones = cleanP.slice(0, 3);
  out.contact_phone = cleanP[0] ?? null;
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

/** Set the CONTACT_FIELDS to their defaults on a lead-like object (idempotent). */
export function clearContactFields(lead: Record<string, unknown>): void {
  lead.contact_phone = null;
  lead.contact_phones = [];
  lead.contact_email = null;
  lead.contact_emails_found = [];
  lead.contact_page = null;
  lead.about_page = null;
  lead.team_page = null;
}

/** Ensure CONTACT_FIELDS exist on a lead-like object (default null / []), without overwriting set values. */
export function ensureContactFields(lead: Record<string, unknown>): void {
  for (const f of CONTACT_FIELDS) {
    if (lead[f] === undefined) lead[f] = f === "contact_phones" || f === "contact_emails_found" ? [] : null;
  }
}
