import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDb, schema } from "@fx/core/db";
import type { Lead } from "@fx/core";
import { dedupLeads, runDedupStage } from "../src/stages/dedup.js";

function L(p: Partial<Lead> & { id: string }): Lead {
  return {
    event_id: "", company_name: "X Ltd", priority: "QUEUE", score: 0, company_number: null,
    website: null, website_domain: "", linked_event_ids: [], scoring_reasons: [], ...p,
  } as Lead;
}

describe("dedupLeads (pure)", () => {
  it("merges same-CN leads, keeps the top scorer, applies the multi-event boost", () => {
    const leads: Record<string, Lead> = {
      a: L({ id: "a", company_number: "00111111", event_id: "e1", score: 72, priority: "WARM", segment_name: "Wine importers", trigger_headline: "H1" }),
      b: L({ id: "b", company_number: "00111111", event_id: "e2", score: 70, priority: "WARM", segment_name: "Spirits importers", trigger_headline: "H2" }),
      c: L({ id: "c", company_number: "00111111", event_id: "e3", score: 60, priority: "WARM", segment_name: "Wine importers", trigger_headline: "H1" }),
      d: L({ id: "d", company_number: "00222222", event_id: "e1", score: 50, priority: "QUEUE" }),
    };
    const s = dedupLeads(leads);
    expect(s.cnGroupsMerged).toBe(1);
    expect(s.cnLeadsRemoved).toBe(2);
    expect(leads.b).toBeUndefined();
    expect(leads.c).toBeUndefined();
    expect(leads.d).toBeDefined();                               // different CN — untouched
    const a = leads.a!;
    expect(a.multi_event_trigger).toBe(true);
    expect(a.multi_event_count).toBe(3);
    expect(a.score).toBe(72 + Math.min(8, 2 * 4));               // 80
    expect(a.priority).toBe("HOT");                              // 80 → HOT (boost lifts it past the WARM cap)
    expect(a.linked_event_ids).toEqual(expect.arrayContaining(["e1", "e2", "e3"]));
    expect((a as { linked_segments?: string[] }).linked_segments).toEqual(expect.arrayContaining(["Wine importers", "Spirits importers"]));
  });

  it("strips the website + caps at 49 for the loser of a cross-CN domain collision", () => {
    const leads: Record<string, Lead> = {
      good: L({ id: "good", company_number: "00111111", website: "https://shared.co.uk", website_domain: "shared.co.uk", score: 80, priority: "HOT", website_confidence: "high", website_source: "ddg_search" }),
      bad: L({ id: "bad", company_number: "00222222", website: "https://shared.co.uk", website_domain: "shared.co.uk", score: 75, priority: "WARM", website_confidence: "high", website_source: "domain_guess" }),
    };
    const s = dedupLeads(leads);
    expect(s.domainCollisions).toBe(1);
    expect(leads.good!.website).toBe("https://shared.co.uk");    // winner keeps it
    expect(leads.bad!.website).toBeNull();
    expect(leads.bad!.website_source).toBe("collision_stripped");
    expect(leads.bad!.score).toBe(49);
    expect(leads.bad!.priority).toBe("QUEUE");
  });

  it("drops SKIP leads", () => {
    const leads: Record<string, Lead> = {
      keep: L({ id: "keep", priority: "WARM", score: 65 }),
      drop: L({ id: "drop", priority: "SKIP", score: 20 }),
    };
    const s = dedupLeads(leads);
    expect(s.skipRemoved).toBe(1);
    expect(leads.drop).toBeUndefined();
    expect(leads.keep).toBeDefined();
    expect(s.totalAfter).toBe(1);
  });

  it("leaves all-null-CN leads sharing a domain alone (v1 quirk, faithful)", () => {
    const leads: Record<string, Lead> = {
      a: L({ id: "a", company_number: null, website: "https://x.co.uk", website_domain: "x.co.uk", score: 60, priority: "WARM" }),
      b: L({ id: "b", company_number: null, website: "https://x.co.uk", website_domain: "x.co.uk", score: 55, priority: "QUEUE" }),
    };
    dedupLeads(leads);
    expect(leads.a!.website).toBe("https://x.co.uk");
    expect(leads.b!.website).toBe("https://x.co.uk");
  });
});

describe("runDedupStage (end to end on a temp DB)", () => {
  it("persists survivors, deletes the dropped, re-exports JSON, writes a runs row", () => {
    const dir = mkdtempSync(join(tmpdir(), "fxdedup-"));
    const dbPath = join(dir, "fx.db");
    const outPath = join(dir, "leads.out.json");
    const { sqlite, close } = getDb(dbPath);
    const ins = sqlite.prepare(`INSERT INTO leads (id, event_id, company_number, company_name, company_status, website, website_domain,
        website_source, website_confidence, priority, score, exposure_level, exposure_confidence, lead_type, segment_name, is_large_org, data)
      VALUES (@id,@event_id,@company_number,@company_name,@company_status,@website,@website_domain,@website_source,@website_confidence,
        @priority,@score,@exposure_level,@exposure_confidence,@lead_type,@segment_name,@is_large_org,@data)`);
    const put = (l: Lead) => ins.run({
      id: l.id, event_id: l.event_id ?? "", company_number: l.company_number ?? null, company_name: l.company_name ?? "X",
      company_status: null, website: l.website ?? null, website_domain: l.website_domain ?? "",
      website_source: (l.website_source as string | null) ?? null, website_confidence: (l.website_confidence as string | null) ?? null,
      priority: l.priority ?? "QUEUE", score: l.score ?? 0, exposure_level: "", exposure_confidence: "none",
      lead_type: "unknown", segment_name: l.segment_name ?? "", is_large_org: 0, data: JSON.stringify(l),
    });
    put(L({ id: "a", company_number: "00111111", event_id: "e1", score: 72, priority: "WARM" }));
    put(L({ id: "b", company_number: "00111111", event_id: "e2", score: 70, priority: "WARM" }));
    put(L({ id: "c", company_number: "00333333", score: 65, priority: "WARM" }));
    put(L({ id: "d", company_number: "00444444", score: 20, priority: "SKIP" }));
    close();

    const r = runDedupStage({ dbPath, outPath, runsDir: join(dir, "runs") });
    expect(r.totalBefore).toBe(4);
    expect(r.cnLeadsRemoved).toBe(1);
    expect(r.skipRemoved).toBe(1);
    expect(r.totalAfter).toBe(2);                                // a (merged), c ; b removed (dup CN), d removed (SKIP)

    const out = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, Lead>;
    expect(Object.keys(out).sort()).toEqual(["a", "c"]);
    expect(out.a!.multi_event_count).toBe(2);
    expect(out.a!.score).toBe(76);                               // 72 + min(8, (2-1)*4)
    expect(out.a!.priority).toBe("WARM");

    const { db, sqlite: s2, close: c2 } = getDb(dbPath);
    try {
      const rows = db.select().from(schema.leads).all();
      expect(rows.map((x) => x.id).sort()).toEqual(["a", "c"]);
      expect((s2.prepare("SELECT COUNT(*) c FROM runs").get() as { c: number }).c).toBe(1);
    } finally { c2(); }
  });
});
