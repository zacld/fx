/**
 * sources/source-page-miner.ts — pull candidate company websites out of a trade
 * association / supplier-directory / "find a supplier" page.
 *
 * isSourcePage(url, html) — does this look like a member/supplier/trade directory?
 * mineSourcePage(html, sourceUrl, opts) — extract outbound company links, skipping
 * social / PDFs / images / internal nav / news-aggregator domains; dedupe by
 * domain (keep the strongest candidate); cap; confidence-score by link context.
 * The source page itself is never returned as a candidate (and downstream it must
 * never become a lead — it goes through normal website validation + scoring).
 */
import * as cheerio from "cheerio";
import { SKIP_DOMAINS, domainFromUrl } from "./blocklists.js";

const SOURCE_PAGE_PATH_KEYWORDS = [
  "members", "member-directory", "memberdirectory", "directory", "suppliers", "supplier-list",
  "find-a-supplier", "find-a-member", "our-members", "membership", "business-directory",
  "trade-directory", "exporters", "importers", "manufacturers", "members-list",
];
const SOURCE_PAGE_TEXT_KEYWORDS = [
  "members", "member directory", "supplier directory", "find a supplier", "find a member",
  "trade members", "directory of members", "industry directory", "our members", "membership directory",
  "list of members", "list of suppliers",
];

const SOCIAL_DOMAINS = new Set([
  "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com",
  "tiktok.com", "pinterest.com", "reddit.com", "wa.me", "whatsapp.com", "t.me", "telegram.org",
]);
const NON_COMPANY_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif|svg|webp|ico|mp4|mp3|wav)(\?|#|$)/i;

export interface SourcePageCandidate {
  candidate_url: string;
  candidate_domain: string;
  candidate_name: string;
  source_page_url: string;
  source_query?: string;
  source_segment?: string;
  source_micro_category?: string;
  extraction_confidence: "high" | "medium" | "low";
  extraction_reason: string;
}

export function isSourcePage(url: string, html: string): { isSource: boolean; reason: string } {
  let path = "";
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = (url || "").toLowerCase(); }
  for (const k of SOURCE_PAGE_PATH_KEYWORDS) if (new RegExp(`(^|[/\\-_])${k}([/\\-_]|$)`).test(path)) return { isSource: true, reason: `path keyword: ${k}` };
  try {
    const $ = cheerio.load(html);
    const hay = `${$("title").first().text()} ${$("h1").first().text()} ${$("body").text().slice(0, 3000)}`.toLowerCase();
    for (const k of SOURCE_PAGE_TEXT_KEYWORDS) if (hay.includes(k)) return { isSource: true, reason: `text keyword: ${k}` };
  } catch { /* */ }
  return { isSource: false, reason: "" };
}

const RANK = { high: 2, medium: 1, low: 0 } as const;

export function mineSourcePage(
  html: string,
  sourcePageUrl: string,
  opts: { maxLinks?: number; query?: string; segment?: string; microCategory?: string } = {},
): SourcePageCandidate[] {
  const maxLinks = opts.maxLinks ?? 15;
  if (!html) return [];
  const sourceDomain = domainFromUrl(sourcePageUrl) || "";
  let $: cheerio.CheerioAPI;
  try { $ = cheerio.load(html); } catch { return []; }

  const byDomain = new Map<string, SourcePageCandidate>();
  $("a[href]").each((_i, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let absu: string;
    try { absu = new URL(href, sourcePageUrl).toString().split("#")[0]!; } catch { return; }
    if (!/^https?:\/\//i.test(absu)) return;
    if (NON_COMPANY_EXT.test(absu)) return;
    const dom = domainFromUrl(absu);
    if (!dom) return;
    if (dom === sourceDomain || dom.endsWith(`.${sourceDomain}`)) return;          // internal nav
    if (SOCIAL_DOMAINS.has(dom)) return;
    for (const s of SKIP_DOMAINS) if (dom === s || dom.endsWith(`.${s}`)) return;   // news / aggregators / gov / etc.

    const linkText = $(el).text().replace(/\s+/g, " ").trim();
    const parentText = $(el).closest("li, article, tr, .card, .member, .listing, .result, div").first()
      .text().replace(/\s+/g, " ").trim().toLowerCase();
    const inCard = parentText.length < 600 && /\b(member|members|supplier|company|profile|listing)\b/.test(parentText);
    const nearWebsite = /\b(website|visit|homepage|home page|www\.|http)\b/.test(`${linkText} ${parentText}`.toLowerCase());
    const looksLikeName = /\b(ltd|limited|plc|llp|group)\b/i.test(linkText)
      || (linkText.length > 2 && linkText.length < 60 && /[a-z]/i.test(linkText) && !/^https?:/i.test(linkText));

    let confidence: SourcePageCandidate["extraction_confidence"] = "medium";
    let reason = "outbound link from a directory-like page";
    if (inCard && (nearWebsite || looksLikeName)) { confidence = "high"; reason = "outbound link inside a member/supplier card"; }
    else if (!looksLikeName && !nearWebsite) { confidence = "low"; reason = "outbound link with weak context"; }

    const cand: SourcePageCandidate = {
      candidate_url: absu, candidate_domain: dom, candidate_name: looksLikeName ? linkText : "",
      source_page_url: sourcePageUrl, source_query: opts.query, source_segment: opts.segment,
      source_micro_category: opts.microCategory, extraction_confidence: confidence, extraction_reason: reason,
    };
    const prev = byDomain.get(dom);
    if (!prev || RANK[confidence] > RANK[prev.extraction_confidence] || (RANK[confidence] === RANK[prev.extraction_confidence] && !prev.candidate_name && cand.candidate_name)) {
      byDomain.set(dom, cand);
    }
  });

  return [...byDomain.values()]
    .sort((a, b) => RANK[b.extraction_confidence] - RANK[a.extraction_confidence])
    .slice(0, maxLinks);
}
