import { describe, it, expect } from "vitest";
import { discoverPages } from "../src/sources/sitemap.js";
import type { HtmlFetcher } from "../src/sources/fetch.js";

function fixedFetcher(pages: Record<string, string>): HtmlFetcher {
  return async (url) => (url in pages ? { html: pages[url]!, finalUrl: url } : null);
}

describe("discoverPages", () => {
  it("reads /sitemap.xml + applies the relevance filter + dedupes", async () => {
    const pages: Record<string, string> = {
      "https://acmewine.co.uk/robots.txt": "User-Agent: *\nDisallow: /admin\nSitemap: https://acmewine.co.uk/sitemap.xml\n",
      "https://acmewine.co.uk/sitemap.xml": `<?xml version="1.0"?><urlset>
        <url><loc>https://acmewine.co.uk/</loc></url>
        <url><loc>https://acmewine.co.uk/about</loc></url>
        <url><loc>https://acmewine.co.uk/team</loc></url>
        <url><loc>https://acmewine.co.uk/blog/post-1</loc></url>
        <url><loc>https://acmewine.co.uk/our-vineyards</loc></url>
      </urlset>`,
    };
    const got = await discoverPages({
      homeUrl: "https://acmewine.co.uk",
      relevant: (_url, path) => /^(\/|\/about|\/team|\/our-vineyards)$/.test(path),
      fetcher: fixedFetcher(pages),
      headOk: async () => false,
    });
    expect(got).toEqual(expect.arrayContaining([
      "https://acmewine.co.uk/", "https://acmewine.co.uk/about",
      "https://acmewine.co.uk/team", "https://acmewine.co.uk/our-vineyards",
    ]));
    expect(got).not.toContain("https://acmewine.co.uk/blog/post-1");
  });

  it("follows a sitemap index one level deep", async () => {
    const pages: Record<string, string> = {
      "https://acmewine.co.uk/robots.txt": "Sitemap: https://acmewine.co.uk/sitemap.xml",
      "https://acmewine.co.uk/sitemap.xml": `<sitemapindex>
        <sitemap><loc>https://acmewine.co.uk/sitemap-products.xml</loc></sitemap>
      </sitemapindex>`,
      "https://acmewine.co.uk/sitemap-products.xml": `<urlset>
        <url><loc>https://acmewine.co.uk/products/wine</loc></url>
      </urlset>`,
    };
    const got = await discoverPages({
      homeUrl: "https://acmewine.co.uk",
      relevant: () => true,
      fetcher: fixedFetcher(pages),
      headOk: async () => false,
    });
    expect(got).toContain("https://acmewine.co.uk/products/wine");
  });

  it("falls back to HEAD-probing slugs when there's no sitemap", async () => {
    const pages: Record<string, string> = {};                     // no robots, no sitemap
    const probed = new Set<string>();
    const got = await discoverPages({
      homeUrl: "https://acmewine.co.uk",
      relevant: () => true,
      fallbackSlugs: ["about", "team", "ghost-page"],
      fetcher: fixedFetcher(pages),
      headOk: async (url) => { probed.add(url); return !url.includes("ghost-page"); },
    });
    expect(got).toContain("https://acmewine.co.uk/about");
    expect(got).toContain("https://acmewine.co.uk/team");
    expect(got).not.toContain("https://acmewine.co.uk/ghost-page");
    expect(probed.size).toBeGreaterThan(0);
  });

  it("skips off-origin URLs surfaced by the sitemap", async () => {
    const pages: Record<string, string> = {
      "https://acmewine.co.uk/sitemap.xml": `<urlset>
        <url><loc>https://acmewine.co.uk/about</loc></url>
        <url><loc>https://malicious.example/x</loc></url>
      </urlset>`,
    };
    const got = await discoverPages({
      homeUrl: "https://acmewine.co.uk",
      relevant: () => true,
      fetcher: fixedFetcher(pages),
      headOk: async () => false,
    });
    expect(got).not.toContain("https://malicious.example/x");
    expect(got).toContain("https://acmewine.co.uk/about");
  });

  it("respects maxPages and the prioritise hint", async () => {
    const pages: Record<string, string> = {
      "https://acmewine.co.uk/sitemap.xml": `<urlset>
        ${Array.from({ length: 15 }, (_, i) => `<url><loc>https://acmewine.co.uk/page-${i}</loc></url>`).join("")}
        <url><loc>https://acmewine.co.uk/team</loc></url>
        <url><loc>https://acmewine.co.uk/about</loc></url>
      </urlset>`,
    };
    const got = await discoverPages({
      homeUrl: "https://acmewine.co.uk",
      relevant: () => true,
      prioritise: ["team", "about"],
      maxPages: 3,
      fetcher: fixedFetcher(pages),
      headOk: async () => false,
    });
    expect(got).toHaveLength(3);
    expect(got[0]).toBe("https://acmewine.co.uk/team");
    expect(got[1]).toBe("https://acmewine.co.uk/about");
  });
});
