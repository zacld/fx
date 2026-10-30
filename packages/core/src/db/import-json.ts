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
 * CLI:  tsx src/db/import-json.ts            (resolves data/… from the repo root)
 *       tsx src/db/import-json.ts --db data/fx.db --events data/events.json --leads data/leads.json
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EventSchema, LeadSchema, type FxEvent, type Lead } from "../schema.js";
import { repoRoot } from "../paths.js";
import { getDb, schema } from "./index.js";

const int = (v: unknown) => Math.round(Number(v) || 0);   // a column value from a row the schema rejected

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
  const root = repoRoot();
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
            res.eventsBad++; res.eventsBadIds.push(id);
          }
          // An event the schema rejects is still kept, as it was: dropping it here would delete it from the export
          // (and the next RSS pass would pay for a second AI call). The count above reports it.
          const e = (parsed.success ? parsed.data : obj) as FxEvent;
          db.insert(schema.events).values({
            id: e.id, headline: String(e.headline ?? ""), status: String(e.status ?? "ready"),
            event_type: String(e.event_type ?? ""), event_breadth: String(e.event_breadth || "sector_specific"),
            urgency_score: int(e.urgency_score), commercial_relevance: int(e.commercial_relevance),
            detected_at: e.detected_at ?? null, data: e,
          }).run();
          if (parsed.success) res.eventsOk++;
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
            res.leadsBad++; res.leadsBadIds.push(id);
          }
          // A lead the schema rejects is still kept, as it was: the export (and the private store after it) would
          // otherwise lose it and its enrichment for good. Stages read rows with safeParse and fall back the same way.
          const l = (parsed.success ? parsed.data : obj) as Lead;
          db.insert(schema.leads).values({
            id: l.id, event_id: String(l.event_id ?? ""),
            company_number: l.company_number ?? null, company_name: String(l.company_name ?? "Unknown"),
            company_status: l.company_status ?? null,
            website: l.website ?? null, website_domain: String(l.website_domain ?? ""),
            website_source: (l.website_source as string | null) ?? null,
            website_confidence: (l.website_confidence as string | null) ?? null,
            priority: String(l.priority ?? "QUEUE"), score: int(l.score),
            exposure_level: String(l.exposure_level || ""), exposure_confidence: String(l.exposure_confidence ?? "none"),
            lead_type: String(l.lead_type ?? "unknown"), segment_name: String(l.segment_name ?? ""),
            is_large_org: !!l.is_large_org, rescored_at: l.rescored_at ?? null, data: l,
          }).run();
          if (parsed.success) res.leadsOk++;
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
    `imported: ${r.eventsOk} events (+${r.eventsBad} kept as-is, failing the schema), ${r.leadsOk} leads (+${r.leadsBad} kept as-is)`,
  );
  if (r.eventsBad) console.log(`  bad event ids: ${r.eventsBadIds.slice(0, 10).join(", ")}${r.eventsBadIds.length > 10 ? " …" : ""}`);
  if (r.leadsBad) console.log(`  bad lead ids: ${r.leadsBadIds.slice(0, 10).join(", ")}${r.leadsBadIds.length > 10 ? " …" : ""}`);
}
