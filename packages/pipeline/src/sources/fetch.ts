/**
 * sources/fetch.ts — minimal HTML fetcher for the pipeline stages.
 * Uses Node 22's global fetch + AbortSignal.timeout. Never throws — returns null.
 */
const UA = "Mozilla/5.0 (compatible; FXDiscoveryBot/2.0; +https://github.com/zacld/fx)";

export interface FetchedHtml {
  html: string;
  finalUrl: string;
}

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

export type HtmlFetcher = (url: string, timeoutMs?: number) => Promise<FetchedHtml | null>;
