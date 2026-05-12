/**
 * sources/rss.ts — RSS/Atom feed parsing + the rule-based commercial-relevance
 * pre-filter. Pure (parseFeed takes XML text). Port of the pre-filter / feed bits
 * of scripts/ingest.py (the keyword gate + _BOOST_RULES/_PENALTY_RULES, RSS_FEEDS,
 * dedupe_id). No AI, no network here.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export interface RssFeed { source: string; url: string; }
export const RSS_FEEDS: ReadonlyArray<RssFeed> = [
  { source: "BBC Business", url: "http://feeds.bbci.co.uk/news/business/rss.xml" },
  { source: "Reuters Business", url: "https://feeds.reuters.com/reuters/businessNews" },
  { source: "FXStreet", url: "https://www.fxstreet.com/rss/news" },
  { source: "Bank of England", url: "https://www.bankofengland.co.uk/rss/news" },
  { source: "GOV.UK Trade", url: "https://www.gov.uk/search/news-and-communications.atom?keywords=trade" },
  { source: "The Guardian Biz", url: "https://www.theguardian.com/uk/business/rss" },
  { source: "Sky News Biz", url: "https://feeds.skynews.com/feeds/rss/business.xml" },
];

export interface FeedEntry { title: string; link: string; summary: string; }

/** Parse an RSS or Atom feed XML string into entries. Pure. */
export function parseFeed(xml: string, max = 25): FeedEntry[] {
  if (!xml) return [];
  let $: cheerio.CheerioAPI;
  try { $ = cheerio.load(xml, { xmlMode: true }); } catch { return []; }
  const items = $("item").length ? $("item") : $("entry");
  const out: FeedEntry[] = [];
  items.each((_i, el) => {
    if (out.length >= max) return;
    const $el = $(el);
    const title = $el.find("title").first().text().trim();
    if (!title) return;
    const link = ($el.find("link").first().attr("href") || $el.find("link").first().text() || $el.find("guid").first().text() || "").trim();
    const summary = ($el.find("summary").first().text() || $el.find("description").first().text() || $el.find("content").first().text() || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push({ title, link, summary });
  });
  return out;
}

// ── commercial-relevance pre-filter (port of ingest.py) ─────────────────────
const BOOST_RULES: ReadonlyArray<[RegExp, number]> = [
  [/\bgbp\b|\bpound\b|\bsterling\b/i, 4],
  [/\beur\b|\beuro\b/i, 2],
  [/\busd\b|\bdollar\b/i, 2],
  [/\btariff|\btrade war|\btrade deal|\bimport duty|\bcustoms duty\b/i, 5],
  [/\bsanction|\btrade ban|\btrade restriction|\bembargo\b/i, 4],
  [/\bimport|\bexport\b/i, 3],
  [/\bbank of england|\bboe\b|\bbase rate\b/i, 4],
  [/\binterest rate|\brate decision|\brate cut|\brate hike\b/i, 3],
  [/\bfed\b|\bfederal reserve\b|\becb\b|\brate rise\b/i, 2],
  [/\bshipping cost|\bfreight|\bsupply chain disruption|\bcontainer\b/i, 4],
  [/\bred sea|\bsuez|\bpanama canal\b/i, 4],
  [/\boil price|\bcrude oil|\bwti|\bbrent\b/i, 3],
  [/\benergy price|\bgas price|\bfuel cost\b/i, 3],
  [/\bwheat|\bgrain|\bsteel|\bcopper|\baluminium\b/i, 2],
  [/\buk business|\buk compan|\buk exporters|\buk importers\b/i, 4],
  [/\binflation\b/i, 2],
  [/\brecession\b/i, 2],
];
const PENALTY_RULES: ReadonlyArray<[RegExp, number]> = [
  [/\bgold\b|\bsilver\b|\bprecious metal\b/i, -3],
  [/\bbitcoin|\bcrypto|\bethereum|\bdigital asset\b/i, -5],
  [/\bdow jones|\bs&p 500|\bnasdaq|\bstock market\b/i, -3],
  [/\bftse\b/i, -2],
  [/\bdxy|\bdollar index\b/i, -1],
  [/\bholds above|\bbounces|\bfades after|\bslips after\b/i, -3],
  [/\btechnical analysis|\bresistance level|\bsupport level\b/i, -3],
  [/\bbullish|\bbearish|\boverbought|\boversold\b/i, -3],
  [/\bspeculators|\boptions traders|\bfutures\b/i, -2],
  [/\bpowell comment|\bcomment by|\bspeech by\b/i, -2],
];
export const ENTRY_KEYWORDS = /\b(currency|exchange rate|sterling|pound|gbp|euro|eur|dollar|usd|forex|fx|tariff|trade|import|export|sanction|supply chain|oil|gas|opec|energy|fuel|commodity|commodities|shipping|freight|inflation|interest rate|bank of england|boe|fed|ecb|war|conflict|ukraine|russia|china|iran|sanctions|recession|gdp|growth)\b/i;

/** Rule-based commercial relevance 0–10 (≥7 strong · 5–6 moderate · <5 skip). */
export function scoreCommercialRelevance(headline: string, summary = ""): { score: number; reason: string } {
  const text = `${headline} ${summary}`;
  let score = 0;
  const reasons: string[] = [];
  for (const [re, pts] of BOOST_RULES) if (re.test(text)) { score += pts; if (pts >= 3) reasons.push(`+${pts} ${re.source.slice(0, 30)}`); }
  for (const [re, pts] of PENALTY_RULES) if (re.test(text)) { score += pts; if (pts <= -2) reasons.push(`${pts} ${re.source.slice(0, 30)}`); }
  score = Math.max(0, Math.min(10, Math.round(score / 2)));
  return { score, reason: reasons.slice(0, 3).join("; ") || "no strong signals" };
}

export function dedupeId(source: string, title: string): string {
  const norm = (title || "").trim().toLowerCase().split(/\s+/).join(" ");
  return createHash("sha256").update(`${source}:${norm}`).digest("hex").slice(0, 16);
}
