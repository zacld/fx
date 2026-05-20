/**
 * sources/search.ts — DuckDuckGo + Bing HTML search → filtered result lists.
 * Port of the ddg_search / bing_search bits of scripts/discover_web.py.
 *
 * parseDdgResults / parseBingResults are pure (take an HTML string) — easy to
 * fixture-test. ddgSearch / bingSearch fetch then parse; they take an injectable
 * fetcher so tests don't hit the network. Returns [] gracefully on a block / empty
 * page (the caller falls back to the next source).
 */
import * as cheerio from "cheerio";
import { shouldSkipUrl, shouldSkipTitle } from "./blocklists.js";
import type { HtmlFetcher } from "./fetch.js";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchStats {
  status: "ok" | "blocked" | "empty";
  raw: number;
  kept: number;
  skippedDomain: number;
  skippedTitle: number;
}

function unwrapDdgHref(href: string): string | null {
  if (!href) return null;
  if (href.includes("uddg=")) {
    try {
      const u = href.startsWith("//") ? `https:${href}` : href;
      const uddg = new URL(u, "https://duckduckgo.com").searchParams.get("uddg");
      return uddg ? decodeURIComponent(uddg) : null;
    } catch { return null; }
  }
  return href.startsWith("http") ? href : null;
}

/** Parse DuckDuckGo HTML (html.duckduckgo.com/html) results. Pure. */
export function parseDdgResults(html: string, max = 10): { results: SearchResult[]; stats: SearchStats } {
  const stats: SearchStats = { status: "ok", raw: 0, kept: 0, skippedDomain: 0, skippedTitle: 0 };
  if (!html || html.length < 5000) { stats.status = "blocked"; return { results: [], stats }; }
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $(".result").each((_i, el) => {
    if (results.length >= max) return;
    const a = $(el).find(".result__a").first();
    if (!a.length) return;
    stats.raw++;
    const url = unwrapDdgHref(a.attr("href") || "");
    if (!url) return;
    const sk = shouldSkipUrl(url);
    if (sk.skip) { stats.skippedDomain++; return; }
    const title = a.text().trim();
    const skt = shouldSkipTitle(title);
    if (skt.skip) { stats.skippedTitle++; return; }
    const snippet = $(el).find(".result__snippet").first().text().trim();
    results.push({ url, title, snippet });
  });
  stats.kept = results.length;
  if (stats.raw === 0) stats.status = "empty";
  return { results, stats };
}

/** Parse Bing HTML (bing.com/search) results. Pure. */
export function parseBingResults(html: string, max = 10): { results: SearchResult[]; stats: SearchStats } {
  const stats: SearchStats = { status: "ok", raw: 0, kept: 0, skippedDomain: 0, skippedTitle: 0 };
  if (!html || html.length < 4000) { stats.status = "blocked"; return { results: [], stats }; }
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];
  $("li.b_algo").each((_i, el) => {
    if (results.length >= max) return;
    const h2a = $(el).find("h2 a").first();
    if (!h2a.length) return;
    stats.raw++;
    const url = (h2a.attr("href") || "").trim();
    if (!/^https?:\/\//i.test(url)) return;
    const sk = shouldSkipUrl(url);
    if (sk.skip) { stats.skippedDomain++; return; }
    const title = h2a.text().trim();
    const skt = shouldSkipTitle(title);
    if (skt.skip) { stats.skippedTitle++; return; }
    const snippet = $(el).find(".b_caption p, .b_lineclamp2, .b_paractl").first().text().trim();
    results.push({ url, title, snippet });
  });
  stats.kept = results.length;
  if (stats.raw === 0) stats.status = "empty";
  return { results, stats };
}

export async function ddgSearch(query: string, n: number, fetcher: HtmlFetcher): Promise<{ results: SearchResult[]; stats: SearchStats }> {
  const got = await fetcher(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  if (!got) return { results: [], stats: { status: "blocked", raw: 0, kept: 0, skippedDomain: 0, skippedTitle: 0 } };
  return parseDdgResults(got.html, n);
}

export async function bingSearch(query: string, n: number, fetcher: HtmlFetcher): Promise<{ results: SearchResult[]; stats: SearchStats }> {
  const got = await fetcher(`https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.max(10, n)}`);
  if (!got) return { results: [], stats: { status: "blocked", raw: 0, kept: 0, skippedDomain: 0, skippedTitle: 0 } };
  return parseBingResults(got.html, n);
}

/**
 * Brave Search API — JSON, no bot detection, no HTML parsing.
 * Free tier: 2000 requests/month. Paid: $3/1000 queries.
 * Set BRAVE_API_KEY repo secret to enable. Falls back silently if unset.
 * https://api.search.brave.com/app/documentation/web-search/get-started
 */
export async function braveSearch(
  query: string,
  n: number,
  apiKey: string,
): Promise<{ results: SearchResult[]; stats: SearchStats }> {
  const empty: SearchStats = { status: "empty", raw: 0, kept: 0, skippedDomain: 0, skippedTitle: 0 };
  if (!apiKey) return { results: [], stats: { ...empty, status: "blocked" } };
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, Math.max(5, n))}&country=GB&search_lang=en&result_filter=web`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // 429 = rate limit, 401 = bad key
      return { results: [], stats: { ...empty, status: res.status === 429 ? "blocked" : "empty" } };
    }
    const json = await res.json() as {
      web?: { results?: Array<{ url: string; title: string; description?: string }> };
    };
    const raw = json.web?.results ?? [];
    empty.raw = raw.length;
    const results: SearchResult[] = [];
    for (const item of raw) {
      if (results.length >= n) break;
      const { url, title, description } = item;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const sk = shouldSkipUrl(url);
      if (sk.skip) { empty.skippedDomain++; continue; }
      const st = shouldSkipTitle(title ?? "");
      if (st.skip) { empty.skippedTitle++; continue; }
      results.push({ url, title: title ?? "", snippet: description ?? "" });
    }
    empty.kept = results.length;
    empty.status = results.length > 0 ? "ok" : raw.length > 0 ? "empty" : "empty";
    return { results, stats: empty };
  } catch {
    return { results: [], stats: { ...empty, status: "blocked" } };
  }
}
