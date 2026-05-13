import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDb, schema } from "@fx/core/db";
import type { Lead } from "@fx/core";
import { runEnrichContactsStage } from "../src/stages/enrich-contacts.js";
import type { HtmlFetcher } from "../src/sources/fetch.js";

const HTML_BY_HOST: Record<string, string> = {
  "acmewine.co.uk": `<a href="tel:+44 20 7946 0123">call</a>
                     <a href="mailto:accounts@acmewine.co.uk">accounts</a>
                     <a href="/contact-us">Contact</a>`,
  "bravofoods.co.uk": `<p>Reach us on 0161 555 1234. Email <a href="mailto:info@bravofoods.co.uk">info@bravofoods.co.uk</a></p>
                       <a href="/about">About</a>`,
};

const mockFetch: HtmlFetcher = async (url) => {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
  const html = HTML_BY_HOST[host];
  return html ? { html, finalUrl: url } : null;
};

function seed(dir: string): string {
  const dbPath = join(dir, "fx.db");
  const { sqlite, close } = getDb(dbPath);
  const ins = sqlite.prepare(`INSERT INTO leads (id, event_id, company_number, company_name, company_status, website, website_domain,
      website_source, website_confidence, priority, score, exposure_level, exposure_confidence, lead_type, segment_name, is_large_org, data)
    VALUES (@id,@event_id,@company_number,@company_name,@company_status,@website,@website_domain,@website_source,@website_confidence,
      @priority,@score,@exposure_level,@exposure_confidence,@lead_type,@segment_name,@is_large_org,@data)`);
  const put = (l: Partial<Lead> & { id: string }) => ins.run({
    id: l.id, event_id: l.event_id ?? "", company_number: l.company_number ?? null, company_name: l.company_name ?? "X Ltd",
    company_status: l.company_status ?? "active", website: l.website ?? null, website_domain: l.website_domain ?? "",
    website_source: (l.website_source as string | null) ?? null, website_confidence: (l.website_confidence as string | null) ?? null,
    priority: l.priority ?? "WARM", score: l.score ?? 65, exposure_level: l.exposure_level ?? "", exposure_confidence: "none",
    lead_type: "unknown", segment_name: "", is_large_org: 0, data: JSON.stringify(l),
  });
  put({ id: "A", company_name: "Acme Wine Importers Ltd", company_number: "00111111", website: "https://www.acmewine.co.uk/", website_domain: "acmewine.co.uk", director_name: "Jane Doe", director_role: "Finance Director" });
  put({ id: "B", company_name: "Bravo Foods Ltd", company_number: "00222222", website: "https://bravofoods.co.uk/", website_domain: "bravofoods.co.uk", director_name: "Bob Smith", director_role: "MD" });
  put({ id: "C", company_name: "No Website Co Ltd", company_number: "00333333", website: null, website_domain: "", director_name: "Sue Lee", director_role: "Director" });
  put({ id: "D", company_name: "Unreachable Site Ltd", company_number: "00444444", website: "https://nothere.example/", website_domain: "nothere.example" });
  close();
  return dbPath;
}

describe("enrich-contacts stage", () => {
  it("fetches website HTML (mock), fills contact fields, recomputes best_contact_route, persists + exports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fxenrich-"));
    const dbPath = seed(dir);
    const outPath = join(dir, "leads.out.json");

    const r = await runEnrichContactsStage({
      dbPath, outPath, runsDir: join(dir, "runs"), cachePath: join(dir, "cache.json"),
      fetchHtml: mockFetch, concurrency: 4,
    });
    expect(r.totalLeads).toBe(4);
    expect(r.needEnriching).toBe(3);            // A, B, D have a website + no contacts; C has none
    expect(r.fetched).toBe(3);
    expect(r.ok).toBe(2);                        // A, B
    expect(r.failed).toBe(1);                   // D (mock returns null)
    expect(r.withPhone).toBe(2);
    expect(r.withEmail).toBe(2);
    expect(r.withContactPage).toBe(1);          // only A has a /contact link in the mock HTML

    const out = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, Lead>;
    expect(out.A!.contact_phone).toBe("020 7946 0123");          // libphonenumber-normalised national format
    expect(out.A!.contact_email).toBe("accounts@acmewine.co.uk");
    expect(out.A!.contact_page).toBe("https://www.acmewine.co.uk/contact-us");
    expect(out.A!.best_contact_route).toMatch(/^Email accounts@acmewine\.co\.uk directly/);
    expect(out.B!.contact_phone).toBe("0161 555 1234");
    expect(out.B!.best_contact_route).toMatch(/^Call the switchboard on 0161 555 1234/);
    expect(out.C!.contact_phone ?? null).toBeNull();
    expect(out.C!.best_contact_route).toMatch(/^Look up Sue Lee \(Director\) on LinkedIn/);   // no website → director route
    expect(out.D!.best_contact_route).toMatch(/Look up|Pull the phone/);                       // fetch failed → falls back

    // persisted
    const { db, sqlite, close } = getDb(dbPath);
    try {
      const a = db.select().from(schema.leads).all().find((x) => x.id === "A")!;
      expect(a.data.contact_phone).toBe("020 7946 0123");
      expect((sqlite.prepare("SELECT COUNT(*) c FROM runs").get() as { c: number }).c).toBe(1);
    } finally { close(); }

    // re-run: A & B no longer need enriching (contacts already set); only D is a
    // candidate, and its earlier fetch-failure was cached as null → served from
    // cache, zero new fetches. (The throwing fetcher must never be called.)
    const r2 = await runEnrichContactsStage({
      dbPath, outPath, runsDir: join(dir, "runs"), cachePath: join(dir, "cache.json"),
      fetchHtml: async () => { throw new Error("should not be called — cache should serve"); },
    });
    expect(r2.fetched).toBe(0);
    expect(r2.needEnriching).toBe(1);            // only D still lacks contacts
    expect(r2.cacheHits).toBeGreaterThanOrEqual(1);
    const out2 = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, Lead>;
    expect(out2.A!.contact_phone).toBe("020 7946 0123");   // unchanged
  });
});
