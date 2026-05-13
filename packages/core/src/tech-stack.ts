/**
 * tech-stack.ts — detect technology signals on a company's website that
 * correlate with multi-currency / international commerce.
 *
 * The thesis: a site running Shopify with EUR/USD checkout enabled is almost
 * certainly transacting cross-border. A WooCommerce site with WPML's language
 * switcher is selling to multiple regions. A Klaviyo + Stripe stack with
 * non-GBP currency in a Stripe payment intent embed is taking foreign cards.
 *
 * Each detection is cheap pattern-matching over the homepage HTML. Returns a
 * deduped list of labels (e.g. "shopify", "multi-currency", "stripe non-GBP").
 * The enrichment stage feeds these into fx_likelihood_score and surfaces them
 * to the dashboard as `tech_signals[]`.
 *
 * Pure function over HTML. No I/O.
 */

export interface TechSignal {
  label: string;
  evidence: string;        // short snippet showing the detection
}

interface Detector { label: string; re: RegExp; }

// Pattern table — order is significance, not specificity. Each detector emits
// one signal max even if multiple matches exist.
const DETECTORS: ReadonlyArray<Detector> = [
  // Storefront platforms — strong B2C/D2C signal, often with multi-currency support.
  { label: "shopify", re: /(cdn\.shopify\.com|myshopify\.com|Shopify\.theme)/ },
  { label: "woocommerce", re: /(wp-content\/plugins\/woocommerce|woocommerce[-_]is[-_]active|woocommerce-page)/i },
  { label: "magento", re: /(\/static\/version\d+\/frontend\/Magento|"Mage\.Cookies"|magento_version)/i },
  { label: "bigcommerce", re: /(cdn\d*\.bigcommerce\.com|bigcommerce[-_]storefront)/i },
  { label: "squarespace-commerce", re: /(static1\.squarespace\.com|squarespace-commerce)/i },
  { label: "wix-stores", re: /(wixstatic\.com.*ecom|wix-stores|wix\.com\/stores)/i },

  // Payment processors — direct evidence of online commerce, often non-GBP capable.
  { label: "stripe", re: /(js\.stripe\.com|stripe-checkout|Stripe\(['"][^'"]+['"])/ },
  { label: "paypal", re: /(www\.paypalobjects\.com|paypal-button|paypal\.checkout)/i },
  { label: "adyen", re: /(checkoutshopper-live\.adyen\.com|adyen-checkout)/i },
  { label: "klarna", re: /(klarna-checkout|js\.klarna\.com|klarna\.com\/uk\/business)/i },
  { label: "worldpay", re: /(secure\.worldpay\.com|worldpay-online)/i },

  // Multi-currency / multi-language signals — strongest FX-exposure indicator.
  { label: "multi-currency-switcher", re: /(data-currency-switcher|currency-switcher|currency-selector|class=["'][^"']*currency-(picker|switcher)|"currencies"\s*:\s*\[[^\]]*"[A-Z]{3}"\s*,\s*"[A-Z]{3}")/i },
  { label: "non-gbp-checkout", re: /\$\s*\d+(\.\d{2})?|\€\s*\d+(\.\d{2})?|EUR\s+\d+(\.\d{2})?|USD\s+\d+(\.\d{2})?/ },
  { label: "language-switcher", re: /(hreflang=["'](?!en-gb|en)["a-z\-]{2,5}["']|wpml-ls|polylang|gtranslate|weglot|<a[^>]+href=["'][^"']*\/(de|fr|es|it|nl|pl)\/[^"']*["'])/i },
  { label: "currency-meta", re: /<meta[^>]+(?:itemprop|property|name)=["'][^"']*(?:price)?currency[^"']*["'][^>]+content=["']([A-Z]{3})["']/i },

  // Marketing/CRM stacks — proxy for "real company with marketing budget".
  { label: "klaviyo", re: /(static\.klaviyo\.com|klaviyo\.com\/api|_klOnsite|class=["'][^"']*klaviyo)/i },
  { label: "mailchimp", re: /(mailchimp\.com|mc\.us\d+\.list-manage\.com|cdn-images\.mailchimp\.com)/i },
  { label: "hubspot", re: /(hs-scripts\.com|js\.hsforms\.net|hsforms\.com\/embed)/i },
  { label: "intercom", re: /(widget\.intercom\.io|intercomcdn\.com)/i },

  // International logistics partners — explicit cross-border evidence.
  { label: "trustpilot-embed", re: /(widget\.trustpilot\.com|trustpilot\.com\/review)/i },
  { label: "google-tag-manager", re: /(googletagmanager\.com\/gtm\.js|gtm\.start)/i },

  // CDN/hosting that hints at scale.
  { label: "cloudflare", re: /(cdnjs\.cloudflare\.com|cf-ray|__cf_email__)/ },
];

const NON_GBP_CURRENCY_SYMBOLS = /€|\$|¥|US\$|EUR|USD|JPY|CHF|CAD|AUD/;

/**
 * Scan an HTML page for tech-stack signals. Returns up to 12 deduped signals
 * with a short evidence snippet for each.
 */
export function detectTechStack(html: string): TechSignal[] {
  if (!html) return [];
  const out: TechSignal[] = [];
  const seen = new Set<string>();
  for (const det of DETECTORS) {
    const m = det.re.exec(html);
    if (!m) continue;
    if (seen.has(det.label)) continue;
    seen.add(det.label);
    // Snip a few characters around the match for evidence display.
    const start = Math.max(0, m.index - 10);
    const end = Math.min(html.length, m.index + (m[0]?.length ?? 0) + 30);
    out.push({ label: det.label, evidence: html.slice(start, end).replace(/\s+/g, " ").trim() });
    if (out.length >= 12) break;
  }

  // Extra: meta-tag-derived currency mismatch (priceCurrency=EUR on a UK site).
  if (out.find((s) => s.label === "currency-meta")) {
    const mm = /<meta[^>]+(?:itemprop|property|name)=["'][^"']*(?:price)?currency[^"']*["'][^>]+content=["']([A-Z]{3})["']/i.exec(html);
    if (mm && mm[1] && mm[1] !== "GBP" && !seen.has("non-gbp-price")) {
      seen.add("non-gbp-price");
      out.push({ label: "non-gbp-price", evidence: `meta priceCurrency = ${mm[1]}` });
    }
  }

  return out;
}

/**
 * Lightweight scorer — how many tech signals point at *international* commerce
 * (not just "has a website"). Used to weight fx_likelihood_score.
 *   0 = no commerce or local-only
 *   ~10 = a Shopify with Klaviyo
 *   30+ = multi-currency switcher + non-GBP checkout + language switcher
 */
export function techStackFxScore(signals: ReadonlyArray<TechSignal>): number {
  const labels = new Set(signals.map((s) => s.label));
  let s = 0;
  if (labels.has("multi-currency-switcher")) s += 14;
  if (labels.has("non-gbp-checkout") || labels.has("non-gbp-price")) s += 10;
  if (labels.has("currency-meta")) s += 4;
  if (labels.has("language-switcher")) s += 8;
  if (labels.has("shopify") || labels.has("woocommerce") || labels.has("magento") || labels.has("bigcommerce")) s += 6;
  if (labels.has("stripe") || labels.has("adyen") || labels.has("worldpay")) s += 3;
  if (labels.has("paypal") || labels.has("klarna")) s += 2;
  return Math.min(40, s);
}

export { NON_GBP_CURRENCY_SYMBOLS };
