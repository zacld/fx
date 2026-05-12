import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDb, schema } from "@fx/core/db";
import { ChClient } from "../src/sources/companies-house.js";
import { runDiscoverStage } from "../src/stages/discover.js";
import type { HtmlFetcher } from "../src/sources/fetch.js";

const PAD = `<!-- ${"x".repeat(5200)} -->`;

const IMPORTER_HTML = `<html><head><title>Acme Wine Importers Ltd</title></head><body>
  <header><a href="tel:020 7946 0123">020 7946 0123</a></header>
  <p>Acme Wine Importers Ltd — we import wine direct from Italy. We work with French suppliers.
     Wholesale only. Trade customers welcome. Minimum order applies. Established 2008.
     Accounts: <a href="mailto:accounts@acmewine.co.uk">accounts@acmewine.co.uk</a></p>
  <nav><a href="/contact-us">Contact</a><a href="/about">About</a></nav>
</body></html>`;

function ddgHtmlFor(targetUrl: string, title: string): string {
  return `${PAD}<html><body><div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(targetUrl)}&rut=x">${title}</a>
    <div class="result__snippet">We import wine direct from Italy.</div>
  </div></body></html>`;
}

const fetchHtml: HtmlFetcher = async (url) => {
  if (url.startsWith("https://html.duckduckgo.com/")) return { html: ddgHtmlFor("https://acmewine.co.uk/", "Acme Wine Importers Ltd"), finalUrl: url };
  if (url.startsWith("https://www.bing.com/")) return { html: "<html></html>", finalUrl: url };           // short → "blocked"
  if (url.startsWith("https://acmewine.co.uk")) return { html: IMPORTER_HTML, finalUrl: "https://acmewine.co.uk/" };
  return null;
};

function seedEvent(dir: string): { dbPath: string; query: string; segmentName: string } {
  const dbPath = join(dir, "fx.db");
  const { sqlite, close } = getDb(dbPath);
  const query = '"wine importer" UK wholesale';
  const segmentName = "European wine and spirits importers";
  const eventData = {
    id: "evt1", headline: "GBP/EUR slides after dovish BoE", status: "ready", event_type: "Currency move",
    event_breadth: "broad_currency", urgency_score: 8, commercial_relevance: 8,
    business_impact_summary: "UK wine importers face higher GBP cost on EUR supplier invoices.",
    target_segments: [{
      segment_name: segmentName, business_model: "UK importer buying from European producers, selling in GBP.",
      exposure_level: "Very High", exposure_type: "Import cost exposure — EUR supplier payments vs GBP revenue",
      likely_currency_pairs: ["GBP/EUR"],
      why_affected: "GBP weakening against EUR directly increases the GBP cost of every EUR supplier invoice, squeezing margin on each shipment of imported wine.",
      why_financially_exposed: "Recurring EUR payments to European producers with GBP-only revenue — a direct currency mismatch on thin margins.",
      website_validation_signals: ["imported from", "direct from the producer", "European vineyards", "sourced from"],
      exposure_thesis_template: "This business appears to import wine from European producers, with revenue in GBP — the recent GBP/EUR move increases the cost of upcoming stock payments.",
      micro_categories: [{ name: "European wine importers", why: "core", search_queries: [query], companies_house_terms: ["wine merchant"] }],
      high_intent_search_queries: [query],
    }],
  };
  sqlite.prepare(`INSERT INTO events (id, headline, status, event_type, event_breadth, urgency_score, commercial_relevance, data)
                  VALUES (?,?,?,?,?,?,?,?)`).run(
    "evt1", eventData.headline, "ready", "Currency move", "broad_currency", 8, 8, JSON.stringify(eventData),
  );
  close();
  return { dbPath, query, segmentName };
}

describe("discover stage (orchestrator, mocked fetch, CH disabled)", () => {
  it("DDG → website validate → lead + lead_evidence; marks event done; records a run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxdiscover-"));
    const { dbPath, query, segmentName } = seedEvent(dir);
    const ch = new ChClient({ apiKey: "", cachePath: join(dir, "ch.json") });

    const r = await runDiscoverStage({
      dbPath, runsDir: join(dir, "runs"), fetchHtml, chClient: ch,
      concurrency: 2, sourcePageMining: false, maxEvents: 5, maxResultsPerQuery: 5,
    });
    expect(r.events).toBe(1);
    expect(r.queriesRun).toBe(1);
    expect(r.ddgOk).toBe(1);
    expect(r.leadsAdded).toBe(1);
    expect(r.candidates).toBeGreaterThanOrEqual(1);

    const { db, sqlite, close } = getDb(dbPath);
    try {
      const leads = db.select().from(schema.leads).all();
      expect(leads.length).toBe(1);
      const l = leads[0]!;
      expect(l.website_domain).toBe("acmewine.co.uk");
      expect(l.website_source).toBe("ddg");
      expect(l.data.discovery_path).toBe("ddg");
      expect(l.data.source_query).toBe(query);
      expect(l.data.source_segment).toBe(segmentName);
      expect(l.data.fx_payment_signals).toEqual(expect.arrayContaining(["we import", "direct from"]));
      expect(l.data.contact_phone).toBe("020 7946 0123");
      expect(l.data.contact_email).toBe("accounts@acmewine.co.uk");
      expect(l.data.contact_page).toBe("https://acmewine.co.uk/contact-us");
      expect(["HOT", "WARM"]).toContain(l.priority);             // scored (provisional)
      expect((l.data.scoring_reasons as string[]).length).toBeGreaterThan(0);

      const ev = sqlite.prepare("SELECT * FROM lead_evidence").all() as Array<{ lead_id: string; source_query: string; website_source: string; discovery_path: string }>;
      expect(ev.length).toBe(1);
      expect(ev[0]!.lead_id).toBe(l.id);
      expect(ev[0]!.source_query).toBe(query);
      expect(ev[0]!.discovery_path).toBe("ddg");

      const evRow = db.select().from(schema.events).all()[0]!;
      expect(evRow.status).toBe("discovered");
      expect((evRow.data as { web_discovery_done?: boolean }).web_discovery_done).toBe(true);

      const runs = sqlite.prepare("SELECT * FROM runs").all() as Array<{ mode: string }>;
      expect(runs.length).toBe(1);
      expect(runs[0]!.mode).toBe("discover");
    } finally { close(); }

    // re-run: the event is now web_discovery_done → 0 events processed
    const r2 = await runDiscoverStage({ dbPath, runsDir: join(dir, "runs"), fetchHtml, chClient: new ChClient({ apiKey: "", cachePath: join(dir, "ch.json") }), sourcePageMining: false });
    expect(r2.events).toBe(0);
    expect(r2.leadsAdded).toBe(0);
  });
});
