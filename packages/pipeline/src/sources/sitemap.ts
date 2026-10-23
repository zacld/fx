/**
 * sources/sitemap.ts — discover the set of pages worth crawling on a company's
 * website, in order of preference:
 *
 *   1. /sitemap.xml (and any siblings advertised in /robots.txt)
 *   2. <link rel="sitemap"> in the homepage HTML
 *   3. Fallback to HEAD-probing a fixed set of known good slugs (/about,
 *      /contact, /team, …) — the only behaviour the Python scripts had.
 *
 * Why bother with sitemap first: bespoke sites use bespoke URLs (a wine
 * importer's /our-vineyards, a coffee roaster's /where-our-beans-come-from)
 * that no slug list can predict. Sitemaps let us find them with one fetch.
 *
 * Caller passes:
 *   * homeUrl: the company homepage (e.g. https://acmewine.co.uk)
 *   * relevant: a function deciding whether a discovered URL is worth keeping
 *     (e.g. matches /about|/team|/suppliers/i for the decision-maker stage,
 *     or /products|/suppliers/i for the website-intel stage).
 *   * maxPages: hard cap on returned URLs (default 8).
 *   * fetcher: usually a CachedFetcher.fetch (so robots/sitemap fetches share
 *     the on-disk page cache).
 *   * headOk: HEAD-probe function (defaults to the one in sources/fetch.ts).
 */
import { fetchHtml as defaultFetchHtml, headOk as defaultHeadOk, type HtmlFetcher } from "./fetch.js";

export interface DiscoverPagesOptions {
  homeUrl: string;
  relevant: (url: string, path: string) => boolean;
  /** Slugs to HEAD-probe when the sitemap is empty / unreachable. */
  fallbackSlugs?: ReadonlyArray<string>;
  /** Bias the priority — slugs containing any of these substrings rank earlier. */
  prioritise?: ReadonlyArray<string>;
  maxPages?: number;
  fetcher?: HtmlFetcher;
  headOk?: (url: string, timeoutMs?: number) => Promise<boolean>;
}

const SITEMAP_LIMIT_BYTES = 500_000;

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}
function pathOf(url: string): string {
  try { return new URL(url).pathname.toLowerCase(); } catch { return ""; }
}

/** Parse a sitemap.xml body for <loc>...</loc> URLs. Sitemap-index files are followed one level deep. */
async function readSitemap(url: string, fetcher: HtmlFetcher, depth = 0): Promise<string[]> {
  if (depth > 1) return [];
  const got = await fetcher(url, 8000);
  if (!got) return [];
  const xml = got.html.slice(0, SITEMAP_LIMIT_BYTES);
  const locs = Array.from(xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)).map((m) => m[1]!.trim());
  // Sitemap-index? Children that end with .xml are themselves sitemaps.
  const out: string[] = [];
  for (const loc of locs) {
    if (/\.xml(\?|$)/i.test(loc)) {
      for (const u of await readSitemap(loc, fetcher, depth + 1)) out.push(u);
    } else {
      out.push(loc);
    }
    if (out.length > 5000) break;       // safety
  }
  return out;
}

/** Extract `Sitemap: <url>` lines from a robots.txt body. */
function sitemapsFromRobots(body: string): string[] {
  return Array.from(body.matchAll(/^\s*sitemap:\s*(\S+)/gim)).map((m) => m[1]!.trim());
}

/**
 * Resolve the candidate pages worth crawling for a company. Returns absolute
 * URLs, deduped, prioritised, and capped at maxPages.
 */
export async function discoverPages(opts: DiscoverPagesOptions): Promise<string[]> {
  const max = opts.maxPages ?? 8;
  const fetcher = opts.fetcher ?? defaultFetchHtml;
  const headProbe = opts.headOk ?? defaultHeadOk;
  const origin = originOf(opts.homeUrl);
  if (!origin) return [];

  const seen = new Set<string>();
  const keep = (url: string) => {
    if (!url || seen.has(url)) return;
    let abs: string;
    try { abs = new URL(url, opts.homeUrl).toString(); } catch { return; }
    if (originOf(abs) !== origin) return;       // same-origin only
    if (seen.has(abs)) return;
    if (!opts.relevant(abs, pathOf(abs))) return;
    seen.add(abs);
  };

  // 1) /robots.txt → sitemap list (cheap; HEAD probes are 1 RTT each).
  const robots = await fetcher(`${origin}/robots.txt`, 6000);
  const sitemapUrls = new Set<string>();
  if (robots) for (const s of sitemapsFromRobots(robots.html)) sitemapUrls.add(s);
  sitemapUrls.add(`${origin}/sitemap.xml`);
  sitemapUrls.add(`${origin}/sitemap_index.xml`);

  // Generous candidate pool — relevance() does the real filtering, and we want
  // to collect enough that the prioritise step has the URLs it needs to pick
  // from. Hard ceiling of 200 still avoids pathological 10k-URL sitemaps.
  const COLLECT_CAP = Math.max(50, max * 8, 200);
  for (const sm of sitemapUrls) {
    if (seen.size >= COLLECT_CAP) break;
    for (const u of await readSitemap(sm, fetcher)) {
      keep(u);
      if (seen.size >= COLLECT_CAP) break;
    }
  }

  // 2) Slug probes as a fallback (always run; cheap HEADs). Skip slugs we
  //    already have from the sitemap.
  const slugs = opts.fallbackSlugs ?? [];
  for (const slug of slugs) {
    const url = `${origin}/${slug.replace(/^\//, "")}`;
    if (seen.has(url)) continue;
    if (!opts.relevant(url, pathOf(url))) continue;
    if (await headProbe(url)) keep(url);
    if (seen.size >= COLLECT_CAP) break;
  }

  // Always include the homepage itself (origin form, de-dup'd via seen).
  keep(`${origin}/`);

  // Priority: matches against opts.prioritise rank first, then by depth (short paths first), then alphabetical.
  const prio = (opts.prioritise ?? []).map((s) => s.toLowerCase());
  const scored = Array.from(seen).map((url) => {
    const path = pathOf(url);
    const matched = prio.findIndex((p) => path.includes(p));
    return { url, score: matched >= 0 ? matched : prio.length, depth: path.split("/").filter(Boolean).length };
  });
  scored.sort((a, b) => a.score - b.score || a.depth - b.depth || a.url.localeCompare(b.url));
  return scored.slice(0, max).map((s) => s.url);
}
