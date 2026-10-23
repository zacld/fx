/**
 * sources/website.ts — fetch + validate a candidate company website.
 * Port of validate_website / scrape_website in scripts/discover_web.py + discover.py.
 *
 * validateWebsite(html, finalUrl, nameTokens, segmentSignals) is pure (takes HTML):
 * runs the parking / multi-company-directory rejection gates, classifies signals
 * via @fx/core classifyText, checks name-on-page, extracts contact routes via
 * @fx/core extractContactInfo, and assigns a website_confidence. fetchAndValidate()
 * fetches first (via sources/fetch.ts, injectable).
 *
 * NOTE: this is *validation* only — scoring stays in @fx/core scoreLead (run by the
 * `score` stage). The discover stage just builds lead records from these signals.
 */
import * as cheerio from "cheerio";
import { classifyText, extractContactInfo } from "@fx/core";
import { domainFromUrl } from "./blocklists.js";
import { fetchHtml, type HtmlFetcher } from "./fetch.js";

const PARKING_SIGNALS = [
  "domain is for sale", "this domain is available", "buy this domain", "parked by",
  "this site is coming soon", "under construction", "website coming soon", "domain parking",
  "register this domain", "404 not found", "page not found",
];

export interface WebsiteValidation {
  fx_payment_signals: string[];
  fx_origin_hints: string[];
  b2b_signals: string[];
  secondary_signals: string[];
  negative_signals: string[];
  segment_signals: string[];
  snippet: string;
  name_on_page: boolean;
  website_confidence: "high" | "medium" | "low" | "none";
  pays_fx: boolean;
  is_b2b: boolean;
  text_length: number;
  reject_reason: string;
  contact_phone: string | null;
  contact_phones: string[];
  contact_email: string | null;
  contact_emails_found: string[];
  contact_page: string | null;
  about_page: string | null;
  team_page: string | null;
}

const EMPTY: WebsiteValidation = {
  fx_payment_signals: [], fx_origin_hints: [], b2b_signals: [], secondary_signals: [], negative_signals: [],
  segment_signals: [], snippet: "", name_on_page: false, website_confidence: "none", pays_fx: false,
  is_b2b: false, text_length: 0, reject_reason: "",
  contact_phone: null, contact_phones: [], contact_email: null, contact_emails_found: [],
  contact_page: null, about_page: null, team_page: null,
};

function plainText(html: string): string {
  try {
    const $ = cheerio.load(html);
    $("script,style,nav,footer,header,noscript").remove();
    return ($("body").length ? $("body").text() : $.root().text()).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}
function companyRefCount(text: string): number {
  return (text.match(/\b(limited|ltd|plc|llp|inc|corp)\b/gi) ?? []).length;
}

export function validateWebsite(html: string, finalUrl: string, nameTokensSet: Set<string> = new Set(), segmentSignals: string[] = []): WebsiteValidation {
  if (!html) return { ...EMPTY, reject_reason: "no html" };
  const text = plainText(html);
  if (text.length < 100) return { ...EMPTY, reject_reason: "page too sparse / unreadable" };
  const tlow = text.toLowerCase();
  if (PARKING_SIGNALS.some((p) => tlow.includes(p))) return { ...EMPTY, reject_reason: "parked or placeholder page" };
  const refs = companyRefCount(text);
  if (refs > 15) return { ...EMPTY, reject_reason: `appears to be a directory (company refs: ${refs})` };

  const cls = classifyText(text);
  const segSigs = [...new Set((segmentSignals ?? []).filter((s) => tlow.includes(String(s).toLowerCase())))].sort();
  const wordsOnPage = new Set(tlow.match(/[a-z]+/g) ?? []);
  const nameOnPage = nameTokensSet.size > 0
    && [...nameTokensSet].filter((t) => wordsOnPage.has(t)).length >= Math.max(1, Math.floor(nameTokensSet.size * 0.5));
  const fxSigs = cls.fxPaymentSignals;
  const b2b = cls.b2bSignals;
  const paysFx = fxSigs.length >= 1 || segSigs.length >= 1 || cls.secondarySignals.length >= 3;

  let conf: WebsiteValidation["website_confidence"];
  if (fxSigs.length && nameOnPage) conf = "high";
  else if (fxSigs.length) conf = "medium";
  else if ((segSigs.length || b2b.length >= 3) && nameOnPage) conf = "medium";
  else if (b2b.length || cls.secondarySignals.length || cls.originHints.length) conf = "low";
  else conf = "none";

  const contact = extractContactInfo(html, finalUrl, domainFromUrl(finalUrl) ?? undefined);
  return {
    fx_payment_signals: fxSigs, fx_origin_hints: cls.originHints, b2b_signals: b2b,
    secondary_signals: cls.secondarySignals, negative_signals: cls.negativeSignals, segment_signals: segSigs,
    snippet: text.slice(0, 800), name_on_page: nameOnPage, website_confidence: conf, pays_fx: paysFx,
    is_b2b: b2b.length >= 1, text_length: text.length, reject_reason: "",
    contact_phone: contact.contact_phone, contact_phones: contact.contact_phones,
    contact_email: contact.contact_email, contact_emails_found: contact.contact_emails_found,
    contact_page: contact.contact_page, about_page: contact.about_page, team_page: contact.team_page,
  };
}

export async function fetchAndValidate(
  url: string, nameTokensSet: Set<string>, segmentSignals: string[], fetcher: HtmlFetcher = fetchHtml,
): Promise<{ validation: WebsiteValidation; finalUrl: string; fetched: boolean }> {
  const got = await fetcher(url);
  if (!got) return { validation: { ...EMPTY, reject_reason: "fetch failed" }, finalUrl: url, fetched: false };
  return { validation: validateWebsite(got.html, got.finalUrl, nameTokensSet, segmentSignals), finalUrl: got.finalUrl, fetched: true };
}
