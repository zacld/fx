import { describe, it, expect } from "vitest";
import {
  shouldSkipUrl, shouldSkipTitle, domainCoherentWithName, domainFromUrl, nameTokens,
} from "../src/sources/blocklists.js";
import { parseDdgResults, parseBingResults } from "../src/sources/search.js";
import { isSourcePage, mineSourcePage } from "../src/sources/source-page-miner.js";
import { validateWebsite } from "../src/sources/website.js";

const PAD = `<!-- ${"x".repeat(5200)} -->`;   // push HTML over the DDG/Bing "soft-block" length check

describe("blocklists", () => {
  it("skips blocked domains and bad paths, keeps real company URLs", () => {
    expect(shouldSkipUrl("https://www.linkedin.com/company/x").skip).toBe(true);
    expect(shouldSkipUrl("https://www.thegrocer.co.uk/news/x").skip).toBe(true);
    expect(shouldSkipUrl("https://acme.co.uk/blog/post").skip).toBe(true);
    expect(shouldSkipUrl("https://acme.co.uk/file.pdf").skip).toBe(true);
    expect(shouldSkipUrl("https://acmewine.co.uk/").skip).toBe(false);
    expect(shouldSkipUrl("not-a-url").skip).toBe(true);
  });
  it("skips directory-listing titles", () => {
    expect(shouldSkipTitle("Top 50 wine importers in the UK").skip).toBe(true);
    expect(shouldSkipTitle("Directory of European food suppliers").skip).toBe(true);
    expect(shouldSkipTitle("Acme Wine Importers Ltd — direct from Italy").skip).toBe(false);
  });
  it("domain ↔ name coherence", () => {
    expect(domainCoherentWithName("resourcechemicals.co.uk", "RESOURCE CHEMICALS LIMITED")).toBe(true);   // shares "resource","chemicals"
    expect(domainCoherentWithName("portland-fuel.com", "PORTLAND FUEL LIMITED")).toBe(true);              // shares "portland","fuel"
    expect(domainCoherentWithName("grokipedia.com", "AMSONS LTD")).toBe(false);                           // no shared token, base > 8 chars
    expect(domainCoherentWithName("randomaggregator.com", "FINE WINES & SPIRITS LIMITED")).toBe(false);   // ditto
    expect(domainCoherentWithName("acme.co.uk", "Acme Trading Ltd")).toBe(true);                          // short brand base
    expect(domainFromUrl("https://www2.Acme-Wine.CO.UK/x")).toBe("acme-wine.co.uk");
    expect([...nameTokens("Fine Wines & Spirits Limited")].sort()).toEqual(["fine", "spirits", "wines"]);
  });
});

describe("search result parsing", () => {
  it("parseDdgResults: keeps company links, drops blocked domains + directory titles", () => {
    const html = PAD + `<html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://acmewine.co.uk/")}&rut=x">Acme Wine Importers Ltd</a>
        <div class="result__snippet">We import wine direct from Italy</div>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.linkedin.com/company/x")}">Acme on LinkedIn</a>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/list")}">Top 100 wine importers in the UK</a>
      </div>
    </body></html>`;
    const { results, stats } = parseDdgResults(html, 10);
    expect(results.map((r) => r.url)).toEqual(["https://acmewine.co.uk/"]);
    expect(results[0]!.title).toBe("Acme Wine Importers Ltd");
    expect(results[0]!.snippet).toContain("import wine");
    expect(stats.raw).toBe(3);
    expect(stats.skippedDomain).toBe(1);
    expect(stats.skippedTitle).toBe(1);
    expect(stats.kept).toBe(1);
  });
  it("parseDdgResults: short page → blocked", () => {
    expect(parseDdgResults("<html></html>").stats.status).toBe("blocked");
  });
  it("parseBingResults: keeps company links from li.b_algo", () => {
    const html = PAD + `<html><body><ol id="b_results">
      <li class="b_algo"><h2><a href="https://bravofoods.co.uk/">Bravo Foods Ltd</a></h2><div class="b_caption"><p>Importer and wholesaler of European foods.</p></div></li>
      <li class="b_algo"><h2><a href="https://www.crunchbase.com/organization/x">Bravo Foods - Crunchbase</a></h2></li>
    </ol></body></html>`;
    const { results } = parseBingResults(html, 10);
    expect(results.map((r) => r.url)).toEqual(["https://bravofoods.co.uk/"]);
  });
});

describe("source-page miner", () => {
  it("isSourcePage detects directory pages by path / text", () => {
    expect(isSourcePage("https://wsta.co.uk/members", "<title>x</title>").isSource).toBe(true);
    expect(isSourcePage("https://x.org/find-a-supplier", "<title>x</title>").isSource).toBe(true);
    expect(isSourcePage("https://acme.co.uk/about", "<title>About Acme</title><body>We import wine.</body>").isSource).toBe(false);
    expect(isSourcePage("https://x.org/page", "<title>Member Directory</title><body>...</body>").isSource).toBe(true);
  });
  it("mineSourcePage extracts company links, dedupes, skips social/internal/news/files, scores confidence", () => {
    const html = `<html><body><ul>
      <li class="member"><a href="https://memberone.co.uk">Member One Ltd</a> — <a href="https://memberone.co.uk">website</a></li>
      <li class="member"><a href="https://membertwo.co.uk/home">Member Two Limited</a></li>
      <li><a href="https://membertwo.co.uk/contact">Member Two contact</a></li>
      <li><a href="/about">About us</a></li>
      <li><a href="https://facebook.com/x">Facebook</a></li>
      <li><a href="https://www.thegrocer.co.uk/news/y">Industry news</a></li>
      <li><a href="https://brochure.example/list.pdf">Download member list (PDF)</a></li>
    </ul></body></html>`;
    const cands = mineSourcePage(html, "https://tradebody.org/members", { query: "wine importer UK", segment: "Wine importers", microCategory: "Italian wine importers", maxLinks: 15 });
    const domains = cands.map((c) => c.candidate_domain).sort();
    expect(domains).toEqual(["membertwo.co.uk", "memberone.co.uk"].sort());   // dedup membertwo; skip facebook/internal/thegrocer/pdf
    const one = cands.find((c) => c.candidate_domain === "memberone.co.uk")!;
    expect(one.candidate_name).toBe("Member One Ltd");
    expect(one.extraction_confidence).toBe("high");                            // in a .member <li> with "website" / name
    expect(one.source_query).toBe("wine importer UK");
    expect(one.source_page_url).toBe("https://tradebody.org/members");
    expect(cands.length).toBeLessThanOrEqual(15);
  });
  it("mineSourcePage respects maxLinks", () => {
    const links = Array.from({ length: 30 }, (_, i) => `<li class="member"><a href="https://co${i}.co.uk">Co ${i} Ltd</a></li>`).join("");
    const cands = mineSourcePage(`<ul>${links}</ul>`, "https://body.org/members", { maxLinks: 5 });
    expect(cands.length).toBe(5);
  });
});

describe("website validation", () => {
  it("classifies a real importer site → high confidence, FX/B2B signals, contacts", () => {
    const html = `<html><head><title>Acme Wine Importers Ltd</title></head><body>
      <header><a href="tel:020 7946 0123">020 7946 0123</a></header>
      <p>Acme Wine Importers Ltd — we import wine direct from Italy. We work with French suppliers.
         Wholesale only. Trade customers welcome. Minimum order applies.</p>
      <p>Accounts: <a href="mailto:accounts@acmewine.co.uk">accounts@acmewine.co.uk</a></p>
      <nav><a href="/contact-us">Contact</a><a href="/about">About</a></nav>
    </body></html>`;
    const v = validateWebsite(html, "https://www.acmewine.co.uk/", nameTokens("Acme Wine Importers Ltd"), ["imported from", "direct from the producer"]);
    expect(v.reject_reason).toBe("");
    expect(v.fx_payment_signals).toEqual(expect.arrayContaining(["we import", "direct from"]));
    expect(v.fx_payment_signals.some((s) => s.includes("french suppliers"))).toBe(true);   // contextual FX
    expect(v.b2b_signals).toEqual(expect.arrayContaining(["wholesale", "trade customers"]));
    expect(v.name_on_page).toBe(true);
    expect(v.website_confidence).toBe("high");
    expect(v.pays_fx).toBe(true);
    expect(v.contact_phone).toBe("020 7946 0123");
    expect(v.contact_email).toBe("accounts@acmewine.co.uk");
    expect(v.contact_page).toBe("https://www.acmewine.co.uk/contact-us");
  });
  it("rejects parked / empty / multi-company-directory pages", () => {
    expect(validateWebsite("", "https://x.co.uk").reject_reason).toBe("no html");
    const parked = `<html><body>This domain is for sale. Buy this domain now via our partner. ${"Contact the registrar for more details about purchasing this premium domain name. ".repeat(2)}</body></html>`;
    expect(validateWebsite(parked, "https://x.co.uk").reject_reason).toBe("parked or placeholder page");
    const manyCos = Array.from({ length: 20 }, (_, i) => `Company ${i} Ltd`).join(", ");
    expect(validateWebsite(`<html><body>${manyCos}</body></html>`, "https://x.co.uk").reject_reason).toMatch(/^appears to be a directory/);
  });
  it("no-evidence page → low/none confidence, not pays_fx", () => {
    const salon = `<html><body>Welcome to our friendly local hair salon in town. Book an appointment online today for a haircut, colour, or styling. Our experienced stylists look after every client. We are open six days a week — call us or use the booking form. Gift vouchers available.</body></html>`;
    const v = validateWebsite(salon, "https://salon.co.uk/", new Set(), []);
    expect(v.website_confidence).toBe("none");
    expect(v.pays_fx).toBe(false);
    expect(v.negative_signals).toEqual(expect.arrayContaining(["hair salon"]));
  });
});
