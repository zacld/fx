/**
 * sources/fetch.ts — shared HTML fetcher for the pipeline stages.
 *
 * Two responsibilities the bare global fetch() can't do:
 *
 *  1. Per-host serialisation + spacing. The pipeline runs with concurrency 6+
 *     and several stages (discover, enrich-contacts, enrich-decision-makers,
 *     enrich-website-intel) crawl overlapping subsets of the same handful of
 *     domains. Without a per-host gate, six workers can all hammer one site at
 *     once. We hold a per-host queue and enforce a minimum interval between
 *     starts (default 600ms; configurable via FX_HOST_MIN_INTERVAL_MS).
 *
 *  2. A shared on-disk page cache. The pipeline stages used to each fetch /,
 *     /about, /contact independently. With createCachedFetcher() they share
 *     one FileCache (default data/cache/pages.json) keyed by URL — second-time
 *     visitors hit the cache, third stages don't pay network at all.
 *
 * The bare fetchHtml() still exists for callers that don't want either
 * (search.ts, sitemap probes, HEAD checks).
 *
 * Never throws — returns null on any failure.
 */
import { resolve } from "node:path";
import { FileCache, repoRoot } from "@fx/core";

const UA = "Mozilla/5.0 (compatible; FXDiscoveryBot/2.0; +https://github.com/zacld/fx)";

export interface FetchedHtml {
  html: string;
  finalUrl: string;
}

export type HtmlFetcher = (url: string, timeoutMs?: number) => Promise<FetchedHtml | null>;

/** Lower-level fetch — no cache, no rate limit, no retries. */
export async function fetchHtml(url: string, timeoutMs = 12000): Promise<FetchedHtml | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !/html|xml|text|json/i.test(ct)) return null;
    const html = await res.text();
    return { html, finalUrl: res.url };
  } catch {
    return null;
  }
}

/** HEAD probe — used by sitemap/slug existence checks. Returns true on 2xx. */
export async function headOk(url: string, timeoutMs = 6000): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": UA } });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Per-host rate limiter ────────────────────────────────────────────────────
function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\d*\./, ""); } catch { return ""; }
}

interface HostGate { queue: Array<() => void>; nextAllowed: number; running: boolean; }
const HOST_GATES = new Map<string, HostGate>();

/** Schedule a function to run, but never two on the same host within minIntervalMs. */
export async function withHostGate<T>(url: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const host = hostOf(url);
  if (!host || minIntervalMs <= 0) return fn();
  let gate = HOST_GATES.get(host);
  if (!gate) { gate = { queue: [], nextAllowed: 0, running: false }; HOST_GATES.set(host, gate); }
  await new Promise<void>((resolve) => { gate!.queue.push(resolve); pump(host, minIntervalMs); });
  try { return await fn(); }
  finally {
    // Update nextAllowed *after* the call finishes, not before — slow servers
    // self-throttle the rest of their host's queue.
    gate.nextAllowed = Date.now() + minIntervalMs;
    gate.running = false;
    pump(host, minIntervalMs);
  }
}

function pump(host: string, minIntervalMs: number): void {
  const gate = HOST_GATES.get(host);
  if (!gate || gate.running || gate.queue.length === 0) return;
  const wait = Math.max(0, gate.nextAllowed - Date.now());
  gate.running = true;
  const next = gate.queue.shift()!;
  if (wait === 0) { next(); return; }
  setTimeout(() => { next(); }, wait);
}

// ── Cached fetcher ───────────────────────────────────────────────────────────
// Schema version of the cached PageEntry shape. Bump when the stored shape
// changes; FileCache will then ignore stale entries from older runs.
const PAGE_CACHE_VERSION = 1;

interface PageEntry {
  ok: boolean;
  html?: string;
  finalUrl?: string;
  status?: number | null;
  fetchedAt: number;       // unix seconds
}

const DEFAULT_HOST_MIN_INTERVAL_MS = Number(process.env.FX_HOST_MIN_INTERVAL_MS ?? "600");
const DEFAULT_PAGE_CACHE_TTL_SEC = Number(process.env.FX_PAGE_CACHE_TTL_DAYS ?? "7") * 86400;

export interface CachedFetcherOptions {
  cachePath?: string;
  ttlSeconds?: number;
  hostIntervalMs?: number;
  maxHtmlBytes?: number;        // truncate stored HTML to this many bytes (default 600 KB)
  timeoutMs?: number;
  cache?: FileCache;            // injectable
  bypass?: boolean;             // skip read cache (still writes)
}

export interface CachedFetcher {
  fetch: HtmlFetcher;
  flush(): void;
  stats(): { hits: number; misses: number; networkOk: number; networkFail: number; rateLimited: number };
}

export function createCachedFetcher(opts: CachedFetcherOptions = {}): CachedFetcher {
  const cachePath = opts.cachePath ?? resolve(repoRoot(), "data/cache/pages.json");
  const ttl = opts.ttlSeconds ?? DEFAULT_PAGE_CACHE_TTL_SEC;
  const minInterval = opts.hostIntervalMs ?? DEFAULT_HOST_MIN_INTERVAL_MS;
  const maxBytes = opts.maxHtmlBytes ?? 600_000;
  const timeoutDefault = opts.timeoutMs ?? 12000;
  const cache = opts.cache ?? new FileCache(cachePath, PAGE_CACHE_VERSION);
  const stats = { hits: 0, misses: 0, networkOk: 0, networkFail: 0, rateLimited: 0 };

  const cachedFetch: HtmlFetcher = async (url, timeoutMs = timeoutDefault) => {
    const key = `page:${url}`;
    if (!opts.bypass) {
      const { hit, value } = cache.lookup(key, ttl);
      if (hit) {
        stats.hits++;
        const e = value as PageEntry | null;
        if (!e || !e.ok || typeof e.html !== "string") return null;
        return { html: e.html, finalUrl: e.finalUrl ?? url };
      }
    }
    stats.misses++;
    const got = await withHostGate(url, minInterval, () => fetchHtml(url, timeoutMs));
    if (!got) {
      stats.networkFail++;
      cache.store(key, { ok: false, fetchedAt: Math.floor(Date.now() / 1000) } satisfies PageEntry, true);
      return null;
    }
    stats.networkOk++;
    const html = got.html.length > maxBytes ? got.html.slice(0, maxBytes) : got.html;
    const entry: PageEntry = { ok: true, html, finalUrl: got.finalUrl, fetchedAt: Math.floor(Date.now() / 1000) };
    cache.store(key, entry);
    return { html, finalUrl: got.finalUrl };
  };

  return {
    fetch: cachedFetch,
    flush() { cache.flush(ttl); },
    stats() { return { ...stats }; },
  };
}

/** Test-only: drop every in-memory host gate. */
export function _resetHostGatesForTests(): void { HOST_GATES.clear(); }
