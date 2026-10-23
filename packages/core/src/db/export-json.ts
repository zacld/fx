/**
 * db/export-json.ts — dump the SQLite tables back out to the canonical JSON files
 * the dashboard reads: data/events.json + data/leads.json (objects keyed by id,
 * the same shape the v1 Python pipeline produced and `import-json.ts` ingests).
 *
 * This is the last step of a pipeline run: import-json → analyse → discover →
 * enrich-contacts → score → dedup → export-json → commit data/*.json.
 *
 *   import { exportJson } from "@fx/core";
 *   exportJson({ dbPath: "data/fx.db" });
 *
 * CLI:  tsx src/db/export-json.ts            (resolves data/… from the repo root)
 *       tsx src/db/export-json.ts --db data/fx.db --events data/events.json --leads data/leads.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { repoRoot } from "../paths.js";
import { getDb, schema } from "./index.js";

export interface ExportResult { events: number; leads: number; eventsPath: string; leadsPath: string; }

export interface ExportOptions {
  dbPath?: string;
  eventsPath?: string;
  leadsPath?: string;
}

function writeRecord(path: string, rows: Array<{ id: string; data: unknown }>): number {
  mkdirSync(dirname(path), { recursive: true });
  const out: Record<string, unknown> = {};
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) out[row.id] = row.data;
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
  return rows.length;
}

export function exportJson(opts: ExportOptions = {}): ExportResult {
  const root = repoRoot();
  const dbPath = opts.dbPath ?? resolve(root, "data/fx.db");
  const eventsPath = opts.eventsPath ?? resolve(root, "data/events.json");
  const leadsPath = opts.leadsPath ?? resolve(root, "data/leads.json");

  const { db, close } = getDb(dbPath);
  try {
    const events = writeRecord(eventsPath, db.select({ id: schema.events.id, data: schema.events.data }).from(schema.events).all());
    const leads = writeRecord(leadsPath, db.select({ id: schema.leads.id, data: schema.leads.data }).from(schema.leads).all());
    return { events, leads, eventsPath, leadsPath };
  } finally {
    close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): ExportOptions {
  const o: ExportOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") o.dbPath = argv[++i];
    else if (a === "--events") o.eventsPath = argv[++i];
    else if (a === "--leads") o.leadsPath = argv[++i];
  }
  return o;
}

const isMain = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const r = exportJson(parseArgs(process.argv.slice(2)));
  console.log(`exported: ${r.events} events → ${r.eventsPath}, ${r.leads} leads → ${r.leadsPath}`);
}
