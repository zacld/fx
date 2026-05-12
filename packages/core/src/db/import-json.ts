/**
 * db/import-json.ts — one-shot importer: data/events.json + data/leads.json → SQLite.
 *
 * Validates every row through the zod schemas (bad rows are skipped + counted, not
 * fatal — the v1 data has plenty of legacy/loose shapes), then replaces the events
 * and leads tables. Proves the v2 data model accepts the real production data.
 *
 *   import { importJson } from "@fx/core/db";   // (after exports wiring)
 *   const stats = importJson({ dbPath: "data/fx.db" });
 *
 * CLI:  tsx src/db/import-json.ts            (run from packages/core)
 *       tsx src/db/import-json.ts --db ../../data/fx.db --events ../../data/events.json --leads ../../data/leads.json
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventSchema, LeadSchema } from "../schema.js";
import { getDb, schema } from "./index.js";

export interface ImportResult {
  eventsOk: number;
  eventsBad: number;
  eventsBadIds: string[];
  leadsOk: number;
  leadsBad: number;
  leadsBadIds: string[];
}

export interface ImportOptions {
  dbPath?: string;
  eventsPath?: string;
  leadsPath?: string;
  /** if true, throw on first invalid row instead of skipping (useful in tests) */
  strict?: boolean;
}

function readJsonRecord(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function importJson(opts: ImportOptions = {}): ImportResult {
  const root = process.cwd();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const eventsPath = opts.eventsPath ?? resolve(root, "data/events.json");
  const leadsPath = opts.leadsPath ?? resolve(root, "data/leads.json");

  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const { db, sqlite, close } = getDb(dbPath);

  const res: ImportResult = { eventsOk: 0, eventsBad: 0, eventsBadIds: [], leadsOk: 0, leadsBad: 0, leadsBadIds: [] };

  try {
    // ── events ──────────────────────────────────────────────────────────────
    if (existsSync(eventsPath)) {
      const raw = readJsonRecord(eventsPath);
      const tx = sqlite.transaction(() => {
        db.delete(schema.events).run();
        for (const [id, ev] of Object.entries(raw)) {
          const obj = ev && typeof ev === "object" ? { ...(ev as object), id: (ev as { id?: string }).id ?? id } : { id };
          const parsed = EventSchema.safeParse(obj);
          if (!parsed.success) {
            if (opts.strict) throw new Error(`bad event ${id}: ${parsed.error.message}`);
            res.eventsBad++; res.eventsBadIds.push(id); continue;
          }
          const e = parsed.data;
          db.insert(schema.events).values({
            id: e.id, headline: e.headline, status: e.status, event_type: e.event_type,
            event_breadth: e.event_breadth || "sector_specific",
            urgency_score: e.urgency_score, commercial_relevance: e.commercial_relevance,
            detected_at: e.detected_at ?? null, data: e,
          }).run();
          res.eventsOk++;
        }
      });
      tx();
    }

    // ── leads ───────────────────────────────────────────────────────────────
    if (existsSync(leadsPath)) {
      const raw = readJsonRecord(leadsPath);
      const tx = sqlite.transaction(() => {
        db.delete(schema.leads).run();
        for (const [id, ld] of Object.entries(raw)) {
          const obj = ld && typeof ld === "object" ? { ...(ld as object), id: (ld as { id?: string }).id ?? id } : { id };
          const parsed = LeadSchema.safeParse(obj);
          if (!parsed.success) {
            if (opts.strict) throw new Error(`bad lead ${id}: ${parsed.error.message}`);
            res.leadsBad++; res.leadsBadIds.push(id); continue;
          }
          const l = parsed.data;
          db.insert(schema.leads).values({
            id: l.id, event_id: l.event_id,
            company_number: l.company_number ?? null, company_name: l.company_name,
            company_status: l.company_status ?? null,
            website: l.website ?? null, website_domain: l.website_domain,
            website_source: (l.website_source as string | null) ?? null,
            website_confidence: (l.website_confidence as string | null) ?? null,
            priority: l.priority, score: l.score,
            exposure_level: l.exposure_level || "", exposure_confidence: l.exposure_confidence,
            lead_type: l.lead_type, segment_name: l.segment_name,
            is_large_org: !!l.is_large_org, rescored_at: l.rescored_at ?? null, data: l,
          }).run();
          res.leadsOk++;
        }
      });
      tx();
    }
  } finally {
    close();
  }
  return res;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): ImportOptions {
  const o: ImportOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--events") o.eventsPath = argv[++i];
    else if (a === "--leads") o.leadsPath = argv[++i];
    else if (a === "--strict") o.strict = true;
  }
  return o;
}

const isMain = (() => {
  try { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const r = importJson(opts);
  console.log(
    `imported: ${r.eventsOk} events (${r.eventsBad} skipped), ${r.leadsOk} leads (${r.leadsBad} skipped)`,
  );
  if (r.eventsBad) console.log(`  bad event ids: ${r.eventsBadIds.slice(0, 10).join(", ")}${r.eventsBadIds.length > 10 ? " …" : ""}`);
  if (r.leadsBad) console.log(`  bad lead ids: ${r.leadsBadIds.slice(0, 10).join(", ")}${r.leadsBadIds.length > 10 ? " …" : ""}`);
}
