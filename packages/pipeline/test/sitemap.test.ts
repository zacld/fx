import { describe, it, expect } from "vitest";
import { discoverPages, rankChildSitemaps } from "../src/sources/sitemap.js";
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

  it("reads only a few child sitemaps of a huge index, page sitemaps first", async () => {
    const children = Array.from({ length: 300 }, (_, i) => `https://shop.co.uk/product-sitemap${i + 1}.xml`);
    children.splice(150, 0, "https://shop.co.uk/page-sitemap.xml");
    const fetched: string[] = [];
    const fetcher: HtmlFetcher = async (url) => {
      fetched.push(url);
      if (url.endsWith("/sitemap.xml")) return { html: `<sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join("")}</sitemapindex>`, finalUrl: url };
      if (url.endsWith("/page-sitemap.xml")) return { html: "<urlset><url><loc>https://shop.co.uk/about-us</loc></url></urlset>", finalUrl: url };
      if (url.includes("product-sitemap")) return { html: "<urlset><url><loc>https://shop.co.uk/p/1</loc></url></urlset>", finalUrl: url };
      return null;
    };
    const got = await discoverPages({ homeUrl: "https://shop.co.uk", relevant: () => true, fetcher, headOk: async () => false });
    expect(got).toContain("https://shop.co.uk/about-us");
    expect(fetched.filter((u) => u.endsWith(".xml")).length).toBeLessThanOrEqual(6);
  });

  it("ranks page sitemaps before product / post ones", () => {
    expect(rankChildSitemaps(["a/product-sitemap.xml", "a/post-sitemap.xml", "a/sitemap-2.xml", "a/page-sitemap.xml"]))
      .toEqual(["a/page-sitemap.xml", "a/sitemap-2.xml", "a/product-sitemap.xml", "a/post-sitemap.xml"]);
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
