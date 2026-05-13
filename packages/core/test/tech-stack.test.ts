import { describe, it, expect } from "vitest";
import { detectTechStack, techStackFxScore } from "../src/tech-stack.js";

describe("detectTechStack", () => {
  it("detects Shopify", () => {
    const html = `<head><script src="//cdn.shopify.com/s/files/1/0/x.js"></script></head>`;
    expect(detectTechStack(html).map((s) => s.label)).toContain("shopify");
  });

  it("detects WooCommerce + Stripe", () => {
    const html = `<html><body class="woocommerce-page"><script src="https://js.stripe.com/v3"></script></body></html>`;
    const labels = detectTechStack(html).map((s) => s.label);
    expect(labels).toContain("woocommerce");
    expect(labels).toContain("stripe");
  });

  it("detects multi-currency switcher", () => {
    const html = `<div class="currency-switcher"><button>£</button><button>€</button><button>$</button></div>`;
    expect(detectTechStack(html).map((s) => s.label)).toContain("multi-currency-switcher");
  });

  it("detects EUR meta priceCurrency on a UK site as non-gbp-price", () => {
    const html = `<meta itemprop="priceCurrency" content="EUR" />`;
    const labels = detectTechStack(html).map((s) => s.label);
    expect(labels).toContain("currency-meta");
    expect(labels).toContain("non-gbp-price");
  });

  it("detects language switcher via hreflang or path", () => {
    const html = `<link rel="alternate" hreflang="de-DE" href="https://acme.com/de/">`;
    expect(detectTechStack(html).map((s) => s.label)).toContain("language-switcher");
  });

  it("returns [] for empty input", () => {
    expect(detectTechStack("")).toEqual([]);
  });

  it("dedupes signals when patterns match multiple times", () => {
    const html = `<script src="//cdn.shopify.com/x"></script><script src="//cdn.shopify.com/y"></script>`;
    expect(detectTechStack(html).filter((s) => s.label === "shopify")).toHaveLength(1);
  });
});

describe("techStackFxScore", () => {
  it("weights international-commerce signals heavily", () => {
    const sigs = detectTechStack(`
      <div class="currency-switcher"></div>
      <meta itemprop="priceCurrency" content="EUR" />
      <link rel="alternate" hreflang="de-DE" />
      <script src="//cdn.shopify.com/x"></script>
      <script src="https://js.stripe.com/v3"></script>
    `);
    expect(techStackFxScore(sigs)).toBeGreaterThanOrEqual(30);
  });
  it("local-only sites score zero", () => {
    expect(techStackFxScore([])).toBe(0);
  });
});
